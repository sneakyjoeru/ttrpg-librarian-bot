'use strict';
/**
 * Unit tests for src/services/igVmClient.js — the Android-VM Instagram fallback.
 * No real network: axios.post is stubbed. Run: node tests/igVmClient.test.js
 */
const assert = require('assert');
const axios = require('axios');

const MAIN = '221722616841371648';
const SUPPORT = '1537860998357328002';
const OTHER = '999999999999999999';

let passed = 0;
async function t(name, fn) {
    try { await fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { console.error(`  FAIL - ${name}`); console.error(e); process.exitCode = 1; }
}

function setEnv(env) {
    for (const k of ['IG_VM_URL', 'IG_VM_TOKEN', 'IG_VM_GUILD_IDS']) delete process.env[k];
    Object.assign(process.env, env);
}
const full = { IG_VM_URL: 'http://172.19.0.1:8911/', IG_VM_TOKEN: 'x'.repeat(32), IG_VM_GUILD_IDS: `${MAIN}, ${SUPPORT}` };

const client = require('../src/services/igVmClient');
const realPost = axios.post;
let calls = [];
function stubPost(impl) { calls = []; axios.post = async (...a) => { calls.push(a); return impl(...a); }; }

(async () => {
    await t('disabled when nothing is configured (e.g. the VPS production bot)', () => {
        setEnv({});
        assert.strictEqual(client.isAllowedGuild(MAIN), false);
    });
    await t('disabled when any of url / token / guild list is missing', () => {
        for (const miss of ['IG_VM_URL', 'IG_VM_TOKEN', 'IG_VM_GUILD_IDS']) {
            const e = { ...full }; delete e[miss]; setEnv(e);
            assert.strictEqual(client.isAllowedGuild(MAIN), false, miss);
        }
    });
    await t('allows exactly the listed sneakyjoe guilds', () => {
        setEnv(full);
        assert.strictEqual(client.isAllowedGuild(MAIN), true);
        assert.strictEqual(client.isAllowedGuild(SUPPORT), true);
        assert.strictEqual(client.isAllowedGuild(Number(0)), false);
    });
    await t('rejects other guilds, DMs and look-alike ids', () => {
        setEnv(full);
        assert.strictEqual(client.isAllowedGuild(OTHER), false);
        assert.strictEqual(client.isAllowedGuild(undefined), false);
        assert.strictEqual(client.isAllowedGuild(null), false);
        assert.strictEqual(client.isAllowedGuild(''), false);
        assert.strictEqual(client.isAllowedGuild(MAIN + '0'), false);
        assert.strictEqual(client.isAllowedGuild(MAIN.slice(1)), false);
    });
    await t('other guild: returns null and makes NO network call', async () => {
        setEnv(full);
        stubPost(() => { throw new Error('must not be called'); });
        const r = await client.downloadViaVm('https://instagram.com/reel/abcde/', OTHER);
        assert.strictEqual(r, null);
        assert.strictEqual(calls.length, 0);
    });
    await t('allowed guild: posts url + guild id with the bearer token and builds a png attachment', async () => {
        setEnv(full);
        stubPost(() => ({ data: Buffer.alloc(5000, 1), headers: { 'x-kind': 'image' } }));
        const r = await client.downloadViaVm('https://instagram.com/reel/abcde/', MAIN, { namePrefix: 'ig' });
        assert.ok(Array.isArray(r) && r.length === 1);
        assert.strictEqual(r[0].name, 'ig_0.png');
        assert.strictEqual(r.vmKind, 'image');
        assert.strictEqual(calls.length, 1);
        const [url, body, opts] = calls[0];
        assert.strictEqual(url, 'http://172.19.0.1:8911/fetch');
        assert.deepStrictEqual(body, { url: 'https://instagram.com/reel/abcde/', guild_id: MAIN });
        assert.strictEqual(opts.headers.Authorization, `Bearer ${'x'.repeat(32)}`);
    });
    await t('video response becomes an mp4 attachment', async () => {
        setEnv(full);
        stubPost(() => ({ data: Buffer.alloc(5000, 2), headers: { 'x-kind': 'video' } }));
        const r = await client.downloadViaVm('https://instagram.com/reel/abcde/', SUPPORT);
        assert.strictEqual(r[0].name, 'instagram_vm_0.mp4');
        assert.strictEqual(r.vmKind, 'video');
    });
    await t('service errors / bogus payloads degrade to null instead of throwing', async () => {
        setEnv(full);
        stubPost(() => { const e = new Error('503'); e.response = { status: 503, data: Buffer.from('{"error":"vm-down"}') }; throw e; });
        assert.strictEqual(await client.downloadViaVm('https://instagram.com/reel/abcde/', MAIN), null);
        stubPost(() => ({ data: Buffer.alloc(10), headers: { 'x-kind': 'image' } }));
        assert.strictEqual(await client.downloadViaVm('https://instagram.com/reel/abcde/', MAIN), null);
        stubPost(() => ({ data: Buffer.alloc(5000), headers: { 'x-kind': 'text' } }));
        assert.strictEqual(await client.downloadViaVm('https://instagram.com/reel/abcde/', MAIN), null);
    });

    await t('photo post: jpg filename from the service becomes a .jpg attachment; unknown extensions fall back to png', async () => {
        setEnv(full);
        stubPost(() => ({ data: Buffer.alloc(5000, 3), headers: { 'x-kind': 'image', 'x-filename': 'DfBLOCYuZCa.jpg' } }));
        let r = await client.downloadViaVm('https://instagram.com/p/DfBLOCYuZCa/', MAIN, { namePrefix: 'ig' });
        assert.strictEqual(r[0].name, 'ig_0.jpg');
        stubPost(() => ({ data: Buffer.alloc(5000, 3), headers: { 'x-kind': 'image', 'x-filename': 'x.exe' } }));
        r = await client.downloadViaVm('https://instagram.com/p/DfBLOCYuZCa/', MAIN, { namePrefix: 'ig' });
        assert.strictEqual(r[0].name, 'ig_0.png');
        stubPost(() => ({ data: Buffer.alloc(5000, 3), headers: { 'x-kind': 'video', 'x-filename': 'a.jpg' } }));
        r = await client.downloadViaVm('https://instagram.com/reel/abcde/', MAIN, { namePrefix: 'ig' });
        assert.strictEqual(r[0].name, 'ig_0.mp4');
    });

    await t('VM-produced posts get the "dirty hack" label, other methods do not', () => {
        assert.strictEqual(client.VM_LABEL, '-# 🛠 processed using a dirty hack');
        assert.ok(client.VM_LABEL.includes('processed using a dirty hack'));
        assert.strictEqual(client.isVmMethod(client.VM_METHOD), true);
        for (const m of [null, undefined, '', 'Fixer (eeinstagram.com)', 'Parallel scrapers (yt-dlp + cobalt + instagram-url-direct)', 'Instagram preview (poster/photo only)']) {
            assert.strictEqual(client.isVmMethod(m), false, String(m));
        }
    });

    axios.post = realPost;
    console.log(`\n${passed} passed`);
})();
