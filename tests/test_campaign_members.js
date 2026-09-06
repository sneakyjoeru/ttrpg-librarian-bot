// Test: /campaign-members user resolution (resolveGuildMember).
// Verifies the resolver accepts user IDs, <@id>/<@!id> mentions, and exact
// (case-insensitive) display-name/username lookups, and correctly reports
// empty / not_found / ambiguous cases. Uses a mock guild member cache — no
// Discord login required.
//
// Run inside the container:
//   docker exec librarian-bot node tests/test_campaign_members.js
// Run locally (pure function test):
//   node tests/test_campaign_members.js
const { resolveGuildMember } = require('../src/utils/helpers');

// --- Mock guild member cache ---
// discord.js's members.cache is a Collection (Map + .filter()/.first()). The
// mock below mirrors the subset of that API resolveGuildMember relies on.
function makeCollection(entries) {
    const map = new Map(entries);
    map.filter = (predicate) => {
        const filtered = [...entries].filter(([id, m]) => predicate(m));
        return makeCollection(filtered);
    };
    map.first = () => (entries.length ? entries[0][1] : undefined);
    return map;
}

function makeMember(id, username, displayName) {
    return {
        id,
        displayName,
        user: { id, username },
        roles: { cache: new Map() }
    };
}

function makeGuild(members) {
    const entries = members.map(m => [m.id, m]);
    const cache = makeCollection(entries);
    return {
        members: {
            cache,
            fetch: async (id) => {
                const m = cache.get(id);
                if (!m) throw new Error('Unknown User');
                return m;
            }
        }
    };
}

const alice = makeMember('111111111111111111', 'alice_w', 'Alice');
const bob = makeMember('222222222222222222', 'bob_pl', 'Bob');
// Same display name as bob — used for the ambiguous case.
const bob2 = makeMember('333333333333333333', 'bob_ru', 'Bob');
const all = [alice, bob, bob2];

let passed = true;
const failures = [];

function check(label, actual, expected) {
    // Compare only the "meaningful" fields — resolved members are mock
    // objects, error descriptors are plain objects.
    const normalize = (v) => {
        if (v && v.user) return { id: v.id, username: v.user.username };
        if (v && v.error) return v;
        return v;
    };
    const a = JSON.stringify(normalize(actual));
    const e = JSON.stringify(normalize(expected));
    if (a !== e) {
        console.error(`[Test] FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`);
        failures.push(label);
        passed = false;
    } else {
        console.log(`[Test] ok: ${label}`);
    }
}

(async () => {
    const guild = makeGuild(all);

    // Raw snowflake ID.
    check('raw ID resolves',
        await resolveGuildMember(guild, '111111111111111111'),
        { id: '111111111111111111', username: 'alice_w' });

    // <@id> mention.
    check('<@id> mention resolves',
        await resolveGuildMember(guild, '<@222222222222222222>'),
        { id: '222222222222222222', username: 'bob_pl' });

    // <@!id> mention (nickname-prefixed form).
    check('<@!id> mention resolves',
        await resolveGuildMember(guild, '<@!333333333333333333>'),
        { id: '333333333333333333', username: 'bob_ru' });

    // Unknown snowflake.
    check('unknown ID → not_found',
        await resolveGuildMember(guild, '999999999999999999'),
        { error: 'not_found' });

    // Exact display name (case-insensitive).
    check('display name resolves case-insensitively',
        await resolveGuildMember(guild, 'alice'),
        { id: '111111111111111111', username: 'alice_w' });

    // Exact username.
    check('username resolves',
        await resolveGuildMember(guild, 'bob_pl'),
        { id: '222222222222222222', username: 'bob_pl' });

    // Leading @ tolerated.
    check('leading @ stripped',
        await resolveGuildMember(guild, '@alice_w'),
        { id: '111111111111111111', username: 'alice_w' });

    // Ambiguous display name.
    const amb = await resolveGuildMember(guild, 'Bob');
    check('ambiguous nickname → error:ambiguous',
        { err: amb.error, count: amb.ambiguous ? amb.ambiguous.length : 0 },
        { err: 'ambiguous', count: 2 });

    // No match at all.
    check('no nickname/username match → not_found',
        await resolveGuildMember(guild, 'Charlie'),
        { error: 'not_found' });

    // Whitespace trimming.
    check('whitespace trimmed',
        await resolveGuildMember(guild, '  alice  '),
        { id: '111111111111111111', username: 'alice_w' });

    // Empty input.
    check('empty input → error:empty',
        await resolveGuildMember(guild, '   '),
        { error: 'empty' });

    // Partial names do NOT match (exact only).
    check('partial name does not match',
        await resolveGuildMember(guild, 'alic'),
        { error: 'not_found' });

    console.log(failures.length === 0
        ? `[Test] RESULT: PASS (${new Date().toISOString()})`
        : `[Test] RESULT: FAIL (${failures.length} failure(s))`);
    process.exit(passed ? 0 : 1);
})();