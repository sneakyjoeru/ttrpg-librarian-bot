'use strict';
/**
 * Android-VM Instagram fallback client (allow-listed guilds ONLY).
 * Ported from heyrobot-discord-bot (commits 8c862ab, d628d74, 2c01ad8). Setup guide: docs/android-vm-instagram.md
 *
 * An Android VM runs the real Instagram app, fronted by a small authenticated HTTP service
 * (tools/android-vm/ig-vm-service.py). This client is the LAST resort the Instagram handler tries
 * when the normal downloaders (yt-dlp, cobalt, scrapers, direct, fixers) produced nothing but the
 * reel's cover ("Video is unavailable for embedding"). For a still image shown as a "video" the VM
 * returns the image only; for real video it returns the mp4; for a photo post the jpg.
 *
 * Access control (defence in depth):
 *   1. Disabled unless IG_VM_URL, IG_VM_TOKEN and IG_VM_GUILD_IDS are ALL set in the environment
 *      (a host without the VM simply has none of them).
 *   2. A guild must be in IG_VM_GUILD_IDS (comma separated) — other servers never trigger a call.
 *   3. The service re-checks the guild id against its own allowlist and requires the bearer token.
 */
const axios = require('axios');
const { AttachmentBuilder } = require('discord.js');

// The service paces app sessions (random 45-120 s spacing) and can queue behind another job, so allow up to ~5.5 min.
const TIMEOUT_MS = parseInt(process.env.IG_VM_TIMEOUT_MS || '330000', 10);

// scrapeMethod value the handler records when the VM produced the media, and the line added to such posts.
const VM_METHOD = 'Android VM (Instagram app)';
const VM_LABEL = '-# 🛠 processed using a dirty hack';
const isVmMethod = (m) => m === VM_METHOD;

function cfg() {
    return {
        url: (process.env.IG_VM_URL || '').replace(/\/+$/, ''),
        token: process.env.IG_VM_TOKEN || '',
        guilds: new Set((process.env.IG_VM_GUILD_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)),
    };
}

/** True only when the VM fallback is configured AND this guild is one of the allowed (sneakyjoe) guilds. */
function isAllowedGuild(guildId) {
    const c = cfg();
    if (!c.url || !c.token || c.guilds.size === 0) return false;
    if (!guildId) return false; // DMs / unknown guild: never
    return c.guilds.has(String(guildId));
}

/**
 * Ask the VM for the media behind an Instagram URL.
 * @returns {Promise<AttachmentBuilder[]|null>} one attachment (png for still images, mp4 for video) or null
 */
async function downloadViaVm(instagramUrl, guildId, opts = {}) {
    if (!isAllowedGuild(guildId)) return null; // hard gate: no network call for any other guild
    const c = cfg();
    const prefix = opts.namePrefix || 'instagram_vm';
    try {
        const res = await axios.post(`${c.url}/fetch`, { url: instagramUrl, guild_id: String(guildId) }, {
            headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
            responseType: 'arraybuffer',
            timeout: TIMEOUT_MS,
            maxContentLength: 100 * 1024 * 1024,
            maxBodyLength: 4096,
            validateStatus: (s) => s === 200,
        });
        const buf = Buffer.from(res.data);
        const kind = String(res.headers['x-kind'] || '');
        if (buf.length < 1024 || (kind !== 'image' && kind !== 'video')) {
            console.warn(`[IG-VM] unexpected response (kind=${kind} bytes=${buf.length}) — ignoring`);
            return null;
        }
        // extension comes from the service's filename (png = still-image video, jpg = photo post, mp4 = video); whitelist only
        const fnExt = (String(res.headers['x-filename'] || '').split('.').pop() || '').toLowerCase();
        const ext = kind === 'video' ? 'mp4' : (fnExt === 'jpg' || fnExt === 'png' ? fnExt : 'png');
        console.log(`[IG-VM] got ${kind} ${buf.length} bytes from the Android VM`);
        const att = new AttachmentBuilder(buf, { name: `${prefix}_0.${ext}` });
        const out = [att];
        out.vmKind = kind;
        return out;
    } catch (err) {
        const status = err.response && err.response.status;
        let detail = err.message;
        try { if (err.response && err.response.data) detail = Buffer.from(err.response.data).toString('utf8').slice(0, 160); } catch { /* ignore */ }
        console.warn(`[IG-VM] fetch failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
        return null;
    }
}

module.exports = { isAllowedGuild, downloadViaVm, VM_METHOD, VM_LABEL, isVmMethod };
