// Test: /player-add and /player-remove (campaignPlayers.js).
//
// Verifies the shared roster core that the mention-only commands use:
//   - the command only works inside an active campaign channel;
//   - only the campaign DM (metadata) or an Admin may change the roster;
//   - SETUP (pre-OP) channels are resolved via the ROLE:<id> topic token;
//   - add/remove mutate the linked campaign role;
//   - the channel name AND role name are re-synced to the new player count;
//   - duplicate/missing membership is reported without a role change.
// Discord objects are mocked — no login required.
//
// Run inside the container:
//   docker exec librarian-bot node tests/test_player_commands.js
// Run locally (pure function test):
//   node tests/test_player_commands.js
const { ACTIVE_CATEGORY_ID } = require('../src/config');
const { resolveCampaignRoster, resolveMemberForRoster, applyPlayerChange } = require('../src/handlers/campaignPlayers');

let passed = true;
const failures = [];

function check(label, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) {
        console.error(`[Test] FAIL: ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
        failures.push(label);
        passed = false;
    } else {
        console.log(`[Test] ok: ${label}`);
    }
}

function checkContains(label, haystack, needle) {
    check(label, !!(haystack && haystack.includes && haystack.includes(needle)), true);
}

const DM_ID = '500000000000000001';
const OTHER_ID = '500000000000000002';
const ADMIN_ID = '500000000000000003';
const ROLE_ID = '600000000000000001';

let channelSeq = 0;

// discord.js's members.cache is a Collection (Map + .filter()/.first()).
// Mirrors the subset resolveGuildMember relies on for nickname lookups.
function makeCollection(entries) {
    const map = new Map(entries);
    map.filter = (predicate) => makeCollection([...entries].filter(([id, m]) => predicate(m)));
    map.first = () => (entries.length ? entries[0][1] : undefined);
    return map;
}

// Mock campaign channel + interaction. `topic` drives metadata resolution;
// `name` carries the trailing player count the rename logic rewrites.
function makeWorld({ topic = '', name = 'curse-of-strahd-alice-2', parentId = ACTIVE_CATEGORY_ID, roleInCache = true } = {}) {
    const channelId = `70000000000000${1000 + (++channelSeq)}`;
    const members = new Map();
    const role = {
        id: ROLE_ID,
        name,
        members,
        setName: async (n) => { role.name = n; }
    };
    role.members = members;
    const channel = {
        id: channelId,
        name,
        parentId,
        topic,
        setName: async (n) => { channel.name = n; }
    };
    const guild = {
        roles: { cache: new Map(roleInCache ? [[ROLE_ID, role]] : []) },
        members: {
            cache: makeCollection([]),
            // Only the known player resolves; anything else is "Unknown User".
            fetch: async (id) => {
                if (id === OTHER_ID) return player;
                throw new Error('Unknown User');
            }
        }
    };
    channel.guild = guild;

    const replies = [];
    const player = {
        id: OTHER_ID,
        displayName: 'Bob',
        user: { id: OTHER_ID, username: 'bob_pl' },
        roles: {
            add: async (r) => { r.members.set(OTHER_ID, player); },
            remove: async (r) => { r.members.delete(OTHER_ID); }
        }
    };
    guild.members.cache.set(OTHER_ID, player);

    function makeInteraction(userId, { admin = false } = {}) {
        return {
            id: 'int' + channelSeq,
            channel,
            guild,
            user: { id: userId },
            member: { permissions: { has: () => admin } },
            replied: false,
            replies,
            async reply(payload) { this.replied = true; replies.push(payload); return payload; },
            async followUp(payload) { replies.push(payload); return payload; },
            editReply: async () => {},
            options: {
                getSubcommand: () => '',
                getString: () => '',
                getUser: () => null
            }
        };
    }

    return { channel, role, guild, player, replies, makeInteraction };
}

const metaTopic = `some prompt [LIBRARIAN_DATA|DM:${DM_ID}|ROLE:${ROLE_ID}]`;
const setupTopic = `SETUP|DM:${DM_ID}|ROLE:${ROLE_ID}`;

async function flushRename() {
    // queueChannelRename is fire-and-forget; let its awaited setName run.
    await new Promise(resolve => setImmediate(resolve));
}

(async () => {
    // --- guard: channel must be an active campaign channel ---
    let w = makeWorld({ topic: metaTopic, parentId: '999999999999999999' });
    let ctx = await resolveCampaignRoster(w.makeInteraction(DM_ID));
    check('outside active category -> error', ctx.error, 'This command can only be used in an active campaign channel.');

    // --- guard: only the DM (or an Admin) may manage the roster ---
    w = makeWorld({ topic: metaTopic });
    ctx = await resolveCampaignRoster(w.makeInteraction(OTHER_ID));
    check('non-DM non-admin -> permission error', ctx.error, 'Only the DM who created the campaign (or an Admin) can manage its members.');

    ctx = await resolveCampaignRoster(w.makeInteraction(ADMIN_ID, { admin: true }));
    check('admin -> allowed', !!ctx.role && ctx.role.id === ROLE_ID, true);

    ctx = await resolveCampaignRoster(w.makeInteraction(DM_ID));
    check('DM via LIBRARIAN_DATA -> role resolved', !!ctx.role && ctx.role.id === ROLE_ID, true);

    // --- SETUP (pre-OP) channel: DM from the topic token ---
    w = makeWorld({ topic: setupTopic });
    ctx = await resolveCampaignRoster(w.makeInteraction(OTHER_ID));
    check('SETUP channel, non-DM -> pre-OP permission error', ctx.error, 'Only the DM who created this campaign (or an Admin) can manage its members before the OP is posted.');
    ctx = await resolveCampaignRoster(w.makeInteraction(DM_ID));
    check('SETUP channel, DM -> role via ROLE: token', !!ctx.role && ctx.role.id === ROLE_ID, true);

    // --- missing/legacy metadata ---
    w = makeWorld({ topic: 'just a prompt' });
    ctx = await resolveCampaignRoster(w.makeInteraction(DM_ID));
    check('no metadata, non-admin -> admin-only message', ctx.error, 'Metadata missing in channel topic. Only Admins can manage members here.');

    w = makeWorld({ topic: 'sorting hat [LIBRARIAN_DATA]' });
    ctx = await resolveCampaignRoster(w.makeInteraction(ADMIN_ID, { admin: true }));
    check('no role token -> not linked message', ctx.error, 'No campaign role is linked to this channel yet. Players join via the ✋ reaction on the OP after it is posted.');

    w = makeWorld({ topic: `SETUP|DM:${DM_ID}` });
    ctx = await resolveCampaignRoster(w.makeInteraction(DM_ID));
    check('SETUP without ROLE token -> not linked message', ctx.error, 'No campaign role is linked to this channel yet. Players join via the ✋ reaction on the OP after it is posted.');

    w = makeWorld({ topic: metaTopic, roleInCache: false });
    ctx = await resolveCampaignRoster(w.makeInteraction(DM_ID));
    check('role deleted -> role-missing message', ctx.error, 'The linked campaign role no longer exists on this server.');

    // --- member resolution errors ---
    w = makeWorld({ topic: metaTopic });
    let res = await resolveMemberForRoster(w.guild, 'not-a-real-name');
    check('unknown member -> message', res.error, 'Could not find a member matching `not-a-real-name`. Use a user ID, a mention, or an exact nickname/username.');

    // --- add: role membership + channel/role name resync ---
    w = makeWorld({ topic: metaTopic, name: 'curse-of-strahd-alice-2' });
    let it = w.makeInteraction(DM_ID);
    res = await resolveMemberForRoster(w.guild, `<@${OTHER_ID}>`);
    check('mention resolves to the member', res.member && res.member.id, OTHER_ID);
    check('role empty before add', w.role.members.size, 0);

    let out = await applyPlayerChange(it, 'add', res.member, await resolveCampaignRoster(it));
    await flushRename();
    check('add reports success', out.ok, true);
    checkContains('add reply names the player', it.replies[0].content, '✅ Added **Bob** (@bob_pl) to this campaign.');
    check('role gained the player', w.role.members.has(OTHER_ID), true);
    check('channel name count resynced', w.channel.name, 'curse-of-strahd-alice-1');
    check('role name resynced with channel', w.role.name, 'curse-of-strahd-alice-1');

    // --- add again: no duplicate role change ---
    it = w.makeInteraction(DM_ID);
    out = await applyPlayerChange(it, 'add', res.member, await resolveCampaignRoster(it));
    check('duplicate add refused', out.ok, false);
    checkContains('duplicate add message', it.replies[it.replies.length - 1].content, 'is already a player in this campaign.');

    // --- remove: role membership cleared + name resync ---
    w = makeWorld({ topic: metaTopic, name: 'curse-of-strahd-alice-2' });
    // Two players in the roster (channel name says 2); Bob leaves.
    w.role.members.set('500000000000000009', { id: '500000000000000009', displayName: 'Cara', user: { username: 'cara' } });
    w.role.members.set(OTHER_ID, w.player);
    it = w.makeInteraction(DM_ID);
    out = await applyPlayerChange(it, 'remove', w.player, await resolveCampaignRoster(it));
    await flushRename();
    check('remove reports success', out.ok, true);
    checkContains('remove reply names the player', it.replies[0].content, '✅ Removed **Bob** (@bob_pl) from this campaign.');
    check('role lost the player', w.role.members.has(OTHER_ID), false);
    check('channel name count resynced after removal', w.channel.name, 'curse-of-strahd-alice-1');

    // --- remove a non-member: reported, no role change ---
    w = makeWorld({ topic: metaTopic, name: 'curse-of-strahd-alice-2' });
    it = w.makeInteraction(DM_ID);
    out = await applyPlayerChange(it, 'remove', w.player, await resolveCampaignRoster(it));
    check('non-member removal refused', out.ok, false);
    checkContains('non-member message', it.replies[0].content, 'is not a player in this campaign.');

    // --- permission guard blocks the change even with a valid member ---
    w = makeWorld({ topic: metaTopic, name: 'curse-of-strahd-alice-2' });
    it = w.makeInteraction(OTHER_ID);
    out = await applyPlayerChange(it, 'add', w.player, await resolveCampaignRoster(it));
    check('non-DM add refused', out.ok, false);
    check('role untouched for non-DM', w.role.members.size, 0);
    checkContains('non-DM message', it.replies[0].content, 'Only the DM who created the campaign');

    console.log(passed ? '[Test] PASS test_player_commands' : `[Test] FAIL test_player_commands (${failures.length} failure(s))`);
    if (!passed) process.exitCode = 1;
})().catch((err) => {
    console.error('[Test] ERROR:', err);
    process.exitCode = 1;
});
