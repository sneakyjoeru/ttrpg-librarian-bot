// Test: newbie scanner (owner spec 2026-11-19) — Estonia-connection keywords,
// solicitation pre-filter, and the full message flow with a fake Discord guild
// (qualify → immune; solicitation → ban + purge + modlog; 15 messages → stop).
//
// Offline (DeepSeek stubbed). Run: node tests/test_newbie_scanner.js
//   or inside the container: docker exec librarian-bot node tests/test_newbie_scanner.js
'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test_token';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test_key'; // so the (stubbed) DeepSeek path always runs
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'newbie-'));
const cwd = process.cwd();
const cfg = require(path.join(__dirname, '..', 'src', 'config'));
process.chdir(tmp); // state file goes to <tmp>/data/newbie-scanner.json
const axios = require(require.resolve('axios', { paths: [path.join(__dirname, '..')] }));
const scanner = require(path.join(__dirname, '..', 'src', 'services', 'newbieScanner'));

const GOOD = `Heya! Happy to be here. I'm Yumi, though Yum works too!
I'm from Tallinn, but prefer chatting in English! I'm fairly new to TTRPGs, started my first D&D campaign about a year ago, but I've been into roleplaying for ages and have approximately 200 OCs at this point, so I'm very excited to have found a TTRPG community here, haha!
My biggest interests are Greek mythology, birds/dinosaurs, art & cosplay, indie/horror games, and generally anything pink and cute!
I'm a bit shy at first, but always happy to chat, so feel free to say hi!... Because I won't, I'm more of a lurker-`;
const BAD = `Hey @everyone I know I might be bothering some people by promoting myself a lot, and I’m really sorry if my posts have been repetitive. I honestly don’t want to annoy anyone, but I’m currently in a situation where I really need commissions, so I’m doing my best to find some work I understand that seeing repeated promotions can be frustrating, but I hope you can understand where I’m coming from. If anyone is interested in commissioning artwork, I’d genuinely love the opportunity to work with you. Feel free to message me with your idea I’d be happy to hear about it thank you to everyone who takes the time to read this and support artists. I really appreciate it.`;

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  \u2713 ${name}`); passed++; }
    catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++; }
}

// --- fake Discord -----------------------------------------------------------
const G = cfg.SERVER_ID;
function makeWorld() {
    const world = { bans: [], deleted: [], modlog: [] };
    const channel = (id) => ({
        id,
        messages: { delete: async (mid) => { world.deleted.push(mid); } },
        send: async (payload) => { world.modlog.push(payload); },
    });
    world.client = { channels: { fetch: async (id) => channel(id) } };
    world.guild = {
        id: G,
        members: { ban: async (uid, opts) => { world.bans.push({ uid, opts }); } },
    };
    let n = 0;
    world.msg = (uid, content) => ({
        id: `m${++n}`, content, url: `https://discord.com/x/${n}`, webhookId: null,
        author: { id: uid, bot: false, tag: `user${uid}` },
        member: { permissions: { has: () => false }, roles: { cache: new Map() } },
        guild: world.guild, channel: { id: 'c1' },
    });
    return world;
}
let llmAnswer = { solicitation: true, reason: 'asks for commissions' };
let llmCalls = 0;
let llmDown = false;
const llmSeen = []; // the user message text DeepSeek was asked about, in order
axios.post = async (url, body) => {
    llmCalls++;
    llmSeen.push(body.messages[1].content);
    if (llmDown) throw new Error('connect ECONNREFUSED');
    return { data: { choices: [{ message: { content: JSON.stringify(llmAnswer) } }] } };
};

(async () => {
    console.log('keyword matching');
    await test('good example qualifies (Tallinn)', () => assert.ok(scanner.findEstoniaConnection(GOOD)));
    await test('bad example has no Estonia link', () => assert.strictEqual(scanner.findEstoniaConnection(BAD), null));
    await test('bad example is suspicious + strong', () => {
        const s = scanner.scoreSolicitation(BAD);
        assert.ok(s.suspicious && s.strong, JSON.stringify(s));
    });
    await test('good example is not suspicious ("art & cosplay" alone)', () => assert.ok(!scanner.scoreSolicitation(GOOD).suspicious));
    for (const t of ['I live in Tallinnas now', 'moving to Estonia next month', 'visited Pärnu last summer', 'from Parnu',
        'Tere! Minu nimi on Kati', 'aitäh', 'я из Таллина', 'живу в Эстонии', 'in Lasnamäe', 'Tartus õpin', 'near Kalamaja', 'tln vibes']) {
        await test(`qualifies: "${t}"`, () => assert.ok(scanner.findEstoniaConnection(t)));
    }
    for (const t of ['I love tapas and sakura', 'I am sober today', 'the narwhal is cool', 'hello everyone, I play D&D 5e',
        'my OCs are cute', 'I do art for fun']) {
        await test(`does not qualify: "${t}"`, () => assert.strictEqual(scanner.findEstoniaConnection(t), null));
    }
    for (const t of ['commissions open! DM me', 'I really need money for rent, my ko-fi is in bio', 'comissions are open']) {
        await test(`suspicious: "${t}"`, () => assert.ok(scanner.scoreSolicitation(t).suspicious));
    }
    for (const t of ['anyone up for a one-shot friday?', 'I draw maps for my own campaign']) {
        await test(`not suspicious: "${t}"`, () => assert.ok(!scanner.scoreSolicitation(t).suspicious));
    }

    console.log('message flow');
    const w = makeWorld();
    await test('non-newbie (no join record) is ignored', async () => {
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('old', BAD)), false);
        assert.strictEqual(w.bans.length, 0);
    });

    scanner.handleNewbieJoin({ guild: { id: G }, id: 'spam', user: { bot: false, tag: 'spam' }, joinedTimestamp: Date.now() });
    await test('newbie spammer: 2 chat messages then commission spam → DeepSeek checks THAT message, then ban', async () => {
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('spam', 'hi all')), false);
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('spam', 'I like dragons')), false);
        assert.strictEqual(llmCalls, 0, 'plain chat never reaches DeepSeek');
        const origBan = w.guild.members.ban;
        let llmCallsAtBan = -1;
        w.guild.members.ban = async (uid, opts) => { llmCallsAtBan = llmCalls; return origBan(uid, opts); };
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('spam', BAD)), true);
        w.guild.members.ban = origBan;
        assert.strictEqual(llmCallsAtBan, 1, 'DeepSeek was called before the ban');
        assert.ok(llmSeen[0].includes('[1] hi all') && llmSeen[0].includes('[2] I like dragons'), 'DeepSeek saw every earlier message');
        assert.ok(llmSeen[0].includes('[3] (LAST MESSAGE, under review) ' + BAD), 'DeepSeek judged the last (banned) message');
        assert.strictEqual(w.bans.length, 1);
        assert.strictEqual(w.bans[0].uid, 'spam');
        assert.strictEqual(w.bans[0].opts.deleteMessageSeconds, 604800);
        assert.strictEqual(w.deleted.length, 3);
        assert.ok(w.modlog[0].content.startsWith(`<@&${cfg.ADMIN_ROLE_ID}>`));
        assert.deepStrictEqual(w.modlog[0].allowedMentions.roles, [cfg.ADMIN_ROLE_ID]);
    });

    scanner.handleNewbieJoin({ guild: { id: G }, id: 'yumi', user: { bot: false, tag: 'yumi' }, joinedTimestamp: Date.now() });
    await test('good newbie qualifies, later commission post is NOT punished', async () => {
        const before = llmCalls;
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('yumi', GOOD)), false);
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('yumi', BAD)), false);
        assert.strictEqual(w.bans.length, 1);
        assert.strictEqual(llmCalls, before, 'no LLM call after qualification');
    });

    scanner.handleNewbieJoin({ guild: { id: G }, id: 'quiet', user: { bot: false, tag: 'quiet' }, joinedTimestamp: Date.now() });
    await test('15 plain messages → monitoring stops; message 16 spam is not punished', async () => {
        for (let i = 0; i < 15; i++) await scanner.handleNewbieMessage(w.client, w.msg('quiet', `message number ${i} about dice`));
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('quiet', BAD)), false);
        assert.strictEqual(w.bans.length, 1);
    });

    scanner.handleNewbieJoin({ guild: { id: G }, id: 'maybe', user: { bot: false, tag: 'maybe' }, joinedTimestamp: Date.now() });
    await test('keyword hit but DeepSeek says no → not banned, modlog note without ping', async () => {
        llmAnswer = { solicitation: false, reason: 'wants to buy art' };
        const n = w.modlog.length;
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('maybe', 'anyone here who does commissions? I want to buy a portrait of my PC')), false);
        assert.strictEqual(w.bans.length, 1);
        assert.strictEqual(w.modlog.length, n + 1);
        assert.deepStrictEqual(w.modlog[n].allowedMentions.roles, []);
    });

    scanner.handleNewbieJoin({ guild: { id: G }, id: 'taltech', user: { bot: false, tag: 'taltech' }, joinedTimestamp: Date.now() });
    await test('keywords miss the Estonia link but DeepSeek finds it in an earlier message → qualified, no ban', async () => {
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('taltech', 'my partner grew up near Lake Peipus')), false);
        llmAnswer = { estonia_connection: true, estonia_evidence: 'study at TalTech', solicitation: true, reason: 'commissions' };
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('taltech', BAD)), false);
        assert.ok(llmSeen[llmSeen.length - 1].includes('[1] my partner grew up near Lake Peipus'));
        assert.strictEqual(w.bans.length, 1);
        llmAnswer = { solicitation: true, reason: 'asks for commissions' };
    });

    scanner.handleNewbieJoin({ guild: { id: G }, id: 'outage', user: { bot: false, tag: 'outage' }, joinedTimestamp: Date.now() });
    await test('DeepSeek down (after 1 retry) → strong keywords still do NOT ban; admins pinged', async () => {
        llmDown = true;
        const calls = llmCalls, n = w.modlog.length;
        assert.ok(scanner.scoreSolicitation(BAD).strong);
        assert.strictEqual(await scanner.handleNewbieMessage(w.client, w.msg('outage', BAD)), false);
        llmDown = false;
        assert.strictEqual(llmCalls, calls + 2, 'one call + one retry');
        assert.strictEqual(w.bans.length, 1);
        assert.deepStrictEqual(w.modlog[n].allowedMentions.roles, [cfg.ADMIN_ROLE_ID]);
    });

    await test('state persisted to data/newbie-scanner.json', () => {
        const st = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'newbie-scanner.json'), 'utf8'));
        assert.strictEqual(st.users[`${G}:spam`].status, 'banned');
        assert.strictEqual(st.users[`${G}:yumi`].status, 'qualified');
        assert.strictEqual(st.users[`${G}:quiet`].status, 'done');
        assert.strictEqual(st.users[`${G}:maybe`].status, 'watching');
        assert.strictEqual(st.users[`${G}:maybe`].texts.length, 1, 'texts kept while watching');
        assert.strictEqual(st.users[`${G}:taltech`].status, 'qualified');
        assert.deepStrictEqual(st.users[`${G}:spam`].texts, [], 'texts cleared after ban');
    });

    await test('TL;DW prompt is English-only', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'youtubeSummary.js'), 'utf8');
        assert.ok(src.includes('Always write the summary in English'));
        assert.ok(!src.includes('in which case answer in that language'));
    });

    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n=== ${passed}/${passed + failed} passed ===`);
    process.exit(failed === 0 ? 0 : 1);
})();
