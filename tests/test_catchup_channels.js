// Test: startup catch-up / placeholder-cleanup channel list (2026-11-19).
// Regression: ttrpg.ee got a type-20 "server-hub" channel that discord.js 14
// does not know; guild.channels.fetch() returns a NULL entry for it and every
// startup scan died with "Cannot read properties of null (reading
// 'isTextBased')". fetchScannableChannels() must skip nulls / non-text
// channels and add the active threads.
//
// Offline: the function is extracted from index-librarian.js (requiring the
// file would log the bot in). Run: node tests/test_catchup_channels.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Collection } = require(require.resolve('discord.js', { paths: [path.join(__dirname, '..')] }));

const src = fs.readFileSync(path.join(__dirname, '..', 'index-librarian.js'), 'utf8');
const m = src.match(/async function fetchScannableChannels\(guild\) \{[\s\S]*?\n\}\n/);
assert.ok(m, 'fetchScannableChannels() present in index-librarian.js');
// eslint-disable-next-line no-new-func
const fetchScannableChannels = new Function(`return (${m[0].trim()});`)();

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  \u2713 ${name}`); passed++; }
    catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++; }
}

const text = (id) => ({ id, isTextBased: () => true, messages: {} });
const voiceNoMessages = { id: 'v', isTextBased: () => true }; // voice: text-based flag but no manager here
const category = { id: 'cat', isTextBased: () => false };

(async () => {
    await test('no startup scan calls isTextBased() on a possibly-null channel', () => {
        assert.strictEqual((src.match(/filter\(c => c\.isTextBased\(\)\)/g) || []).length, 0);
        assert.strictEqual((src.match(/await fetchScannableChannels\(guild\)/g) || []).length, 3, 'IG catch-up, forum catch-up, placeholder cleanup');
    });

    await test('null (unknown type-20) entry is skipped, text channels + active threads kept', async () => {
        const guild = {
            channels: {
                fetch: async () => new Collection([['a', text('a')], ['hub', null], ['cat', category], ['v', voiceNoMessages], ['b', text('b')]]),
                fetchActiveThreads: async () => ({ threads: new Collection([['t1', text('t1')], ['a', text('a')]]) }),
            },
        };
        const out = await fetchScannableChannels(guild);
        assert.deepStrictEqual([...out.keys()].sort(), ['a', 'b', 't1']);
    });

    await test('thread fetch failure still returns the channels', async () => {
        const guild = { channels: { fetch: async () => new Collection([['a', text('a')]]), fetchActiveThreads: async () => { throw new Error('403'); } } };
        const out = await fetchScannableChannels(guild);
        assert.deepStrictEqual([...out.keys()], ['a']);
    });

    await test('channel fetch failure returns null (scan skipped, no throw)', async () => {
        const guild = { channels: { fetch: async () => { throw new Error('boom'); }, fetchActiveThreads: async () => ({ threads: new Collection() }) } };
        assert.strictEqual(await fetchScannableChannels(guild), null);
    });

    // --- catch-up window (last heartbeat → rebuild_time → 15 min default) ---
    const w = src.match(/function catchUpWindowStart\(tag\) \{[\s\S]*?\n\}\n/);
    const r = src.match(/function readTimestampFile\(file\) \{[\s\S]*?\n\}\n/);
    const os = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catchup-'));
    const makeWindow = (prevHeartbeat) => new Function('fs', 'PREV_HEARTBEAT_TS',
        `const CATCHUP_DEFAULT_WINDOW_MS = 15 * 60 * 1000, CATCHUP_DELTA_MS = 5 * 60 * 1000, CATCHUP_MAX_LOOKBACK_MS = 6 * 60 * 60 * 1000;
         ${r[0]}\n${w[0]}\nreturn catchUpWindowStart;`)(fs, prevHeartbeat);
    const cwd = process.cwd();
    process.chdir(tmp);
    const near = (a, b) => Math.abs(a - b) < 5000;
    const MIN = 60 * 1000;

    await test('window starts 5 min before the previous heartbeat (crash/restart)', () => {
        const hb = Date.now() - 40 * MIN;
        assert.ok(near(makeWindow(hb)('t'), hb - 5 * MIN));
    });
    await test('heartbeat wins over an older rebuild_time (old bot served during the build)', () => {
        fs.writeFileSync('rebuild_time.txt', new Date(Date.now() - 3 * 60 * MIN).toISOString());
        const hb = Date.now() - 10 * MIN;
        assert.ok(near(makeWindow(hb)('t'), hb - 5 * MIN));
    });
    await test('no heartbeat → rebuild_time is used', () => {
        const rt = Date.now() - 30 * MIN;
        fs.writeFileSync('rebuild_time.txt', new Date(rt).toISOString());
        assert.ok(near(makeWindow(null)('t'), rt - 5 * MIN));
    });
    await test('lookback capped at 6 hours', () => {
        assert.ok(near(makeWindow(Date.now() - 48 * 60 * MIN)('t'), Date.now() - 6 * 60 * MIN));
    });
    await test('no markers → last 15 minutes', () => {
        fs.unlinkSync('rebuild_time.txt');
        assert.ok(near(makeWindow(null)('t'), Date.now() - 15 * MIN));
    });
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });

    console.log(`\n=== ${passed}/${passed + failed} passed ===`);
    process.exit(failed === 0 ? 0 : 1);
})();
