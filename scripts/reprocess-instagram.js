#!/usr/bin/env node
// CLI: find the bot's recent "Video is unavailable for embedding." Instagram posts and
// re-run them IN PLACE (the existing post is edited; no new message, no ping). With the
// Android-VM fallback configured (docs/android-vm-instagram.md) this replaces the cover
// image with the real video / image.
//
// Run inside the bot container (same env + code as the bot):
//
//   docker exec librarian-bot node scripts/reprocess-instagram.js --dry-run
//   docker exec librarian-bot node scripts/reprocess-instagram.js --limit 20 --gap 370
//   docker exec librarian-bot node scripts/reprocess-instagram.js <channelId>/<messageId> ...
//
// Options:
//   --limit N        how many of the newest matching posts to take (default 20)
//   --days N         only look at posts newer than N days (default 60)
//   --per-channel N  scan at most N messages per channel/thread (default 1000)
//   --gap S          wait S seconds after a post that needed the Android VM (default 0).
//                    The VM service caps app sessions at 10/hour, so a big backlog needs
//                    --gap 370. Posts the normal downloaders fix are not paced.
//   --dry-run        list the matches, change nothing
// Exit code: 0 when the pass completes, 1 on a fatal error.

const { Client, GatewayIntentBits, Partials, ChannelType, PermissionFlagsBits } = require('discord.js');
const { token } = require('../src/config');

const UNAVAILABLE_RE = /^Video is unavailable for embedding\./m;
const IG_URL_RE = /https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels|p|tv)\/[A-Za-z0-9_-]+\/?/i;

function parseArgs(argv) {
    const o = { limit: 20, days: 60, perChannel: 1000, gap: 0, dryRun: false, specs: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--limit') o.limit = parseInt(argv[++i], 10);
        else if (a === '--days') o.days = parseFloat(argv[++i]);
        else if (a === '--per-channel') o.perChannel = parseInt(argv[++i], 10);
        else if (a === '--gap') o.gap = parseInt(argv[++i], 10);
        else if (a === '--dry-run') o.dryRun = true;
        else if (a === '-h' || a === '--help') { o.help = true; }
        else o.specs.push(...a.split(',').filter(Boolean));
    }
    return o;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isBotPost(client, m) {
    return m.author && (m.author.id === client.user.id || (!!m.webhookId && (m.applicationId === client.user.id || m.applicationId == null)));
}

async function scanChannel(client, ch, opts, since, out) {
    let before;
    let seen = 0;
    while (seen < opts.perChannel) {
        const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
        if (!batch || batch.size === 0) return;
        for (const m of batch.values()) {
            seen++;
            if (m.createdTimestamp < since) return;
            if (isBotPost(client, m) && UNAVAILABLE_RE.test(m.content || '') && IG_URL_RE.test(m.content || '')) out.push(m);
        }
        before = batch.last().id;
        if (batch.size < 100) return;
    }
}

async function findUnavailablePosts(client, opts) {
    const since = Date.now() - opts.days * 86400000;
    const out = [];
    for (const guild of client.guilds.cache.values()) {
        const me = guild.members.me || await guild.members.fetchMe().catch(() => null);
        const chans = [];
        const all = await guild.channels.fetch().catch(() => null);
        if (all) for (const ch of all.values()) {
            if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) chans.push(ch);
        }
        const active = await guild.channels.fetchActiveThreads().catch(() => null);
        if (active) for (const th of active.threads.values()) chans.push(th);
        for (const ch of chans) {
            const perms = me && ch.permissionsFor(me);
            if (!perms || !perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.ReadMessageHistory)) continue;
            await scanChannel(client, ch, opts, since, out);
        }
        console.log(`[reprocess] scanned ${guild.name} (${guild.id}): ${chans.length} channel(s)/thread(s), ${out.length} match(es) so far`);
    }
    out.sort((a, b) => b.createdTimestamp - a.createdTimestamp);
    return out.slice(0, opts.limit);
}

async function resolveSpec(client, spec) {
    const m = spec.match(/(\d{15,22})\/(\d{15,22})\s*$/);
    if (!m) throw new Error(`bad spec "${spec}" (want <channelId>/<messageId> or a message link)`);
    const ch = await client.channels.fetch(m[1]);
    return ch.messages.fetch(m[2]);
}

async function reprocessOne(client, msg) {
    const { handleInstagramMessage } = require('../src/services/instagram');
    const { buildRecoveredPlaceholder } = require('../src/utils/webhook');
    const mediaQueue = require('../src/utils/mediaQueue');

    const url = (msg.content.match(IG_URL_RE) || [])[0];
    const placeholder = await buildRecoveredPlaceholder(client, msg);
    // Keep the poster's own text: the base text carries the link as <url>; the handler wants it bare.
    let remade = (placeholder.baseText || '').split(`<${url}>`).join(url);
    if (!remade.includes(url)) remade = remade ? `${remade}\n${url}` : url;

    const synthId = `synth_reprocess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const synthMsg = new Proxy(msg, {
        get(target, prop) {
            if (prop === 'id') return synthId;
            if (prop === 'content' || prop === 'cleanContent') return url;
            if (prop === 'attachments') return { size: 0 };
            if (prop === 'webhookId') return null;
            if (prop === 'delete') return async () => true;
            if (prop === 'edit') return async () => target;
            if (prop === 'react') return async () => true;
            if (prop === 'reply') return async (options) => target.channel.send(options).catch(() => null);
            return target[prop];
        }
    });

    await handleInstagramMessage(client, synthMsg, url, remade, placeholder);
    await mediaQueue.enqueue(async () => {}); // the handler only queues its job; wait for it to finish
    const after = await msg.channel.messages.fetch(msg.id).catch(() => null);
    const names = after ? [...after.attachments.values()].map((a) => a.name).join(',') : '?';
    const still = after ? UNAVAILABLE_RE.test(after.content || '') : null;
    return { url, still, names, vm: !!(after && /processed using a dirty hack/.test(after.content || '')) };
}

(async () => {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('usage: node scripts/reprocess-instagram.js [--limit N] [--days N] [--per-channel N] [--gap S] [--dry-run] [<channelId>/<messageId> ...]');
        process.exit(0);
    }
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
        partials: [Partials.Channel, Partials.Message]
    });
    const ready = new Promise((r) => client.once('clientReady', r));
    await client.login(token);
    await ready;
    console.log(`[reprocess] logged in as ${client.user.tag}`);

    let targets = [];
    if (opts.specs.length) {
        for (const s of opts.specs) targets.push(await resolveSpec(client, s));
    } else {
        targets = await findUnavailablePosts(client, opts);
    }
    console.log(`[reprocess] ${targets.length} target(s)`);
    for (const m of targets) {
        console.log(`  ${new Date(m.createdTimestamp).toISOString()} ${m.guild ? m.guild.id : '-'}/${m.channel.id}/${m.id} ${(m.content.match(IG_URL_RE) || [''])[0]}`);
    }
    if (opts.dryRun || targets.length === 0) { await client.destroy(); process.exit(0); }

    let fixed = 0;
    for (let i = 0; i < targets.length; i++) {
        const m = targets[i];
        let touchedVm = true; // unknown outcome (error) => assume the VM was asked
        try {
            const r = await reprocessOne(client, m);
            if (r.still === false) fixed++;
            // the VM is only asked when the normal downloaders failed: a post they fixed cost no app session
            touchedVm = r.vm || r.still !== false;
            console.log(`[reprocess] ${i + 1}/${targets.length} ${m.channel.id}/${m.id} ${r.url} -> ${r.still ? 'STILL UNAVAILABLE' : 'fixed'}${r.vm ? ' (Android VM)' : ''} files=${r.names}`);
        } catch (e) {
            console.error(`[reprocess] ${i + 1}/${targets.length} ${m.channel.id}/${m.id} failed: ${e.message}`);
        }
        // --gap paces app sessions only (the VM service caps them at 10/hour)
        if (opts.gap > 0 && touchedVm && i < targets.length - 1) await sleep(opts.gap * 1000);
    }
    console.log(`[reprocess] done: ${fixed}/${targets.length} fixed`);
    await client.destroy();
    process.exit(0);
})().catch((e) => { console.error('[reprocess] fatal:', e); process.exit(1); });
