// Test: campaign-members handler must use the discord.js v14 Role#members
// Collection correctly. Regression for the 2026-09-07 incident:
//   Campaign-members add error: TypeError: Cannot read properties of
//   undefined (reading 'has')  (interactions.js:618)
//
// Root cause: an intermediate (never-committed) version of the handler used
// `role.members.cache.has(...)` — but in discord.js v14 `Role#members` IS the
// Collection (there is no `.cache`). `role.members.cache` is therefore
// undefined, and `.has` on it throws for every add/remove. A stale-deploy race
// (smb-watcher rewrote the file 86s after container boot) let that broken
// version run in production even though the fix was already in git.
//
// This test scans the committed handler source for the crash pattern so it
// can never ship again. It is a pure static check — no Discord login.
//
// Run inside the container:
//   docker exec librarian-bot node tests/test_handler_members_api.js
// Run locally:
//   node tests/test_handler_members_api.js
const fs = require('fs');
const path = require('path');

const handlerPath = path.join(__dirname, '..', 'src', 'handlers', 'interactions.js');
const src = fs.readFileSync(handlerPath, 'utf8');

let passed = true;
const failures = [];

function check(label, actual, expected) {
    if (actual !== expected) {
        console.error(`[Test] FAIL: ${label}\n  expected: ${expected}\n  actual:   ${actual}`);
        failures.push(label);
        passed = false;
    } else {
        console.log(`[Test] ok: ${label}`);
    }
}

// 1) The crash pattern must be gone: no `role.members.cache` anywhere.
const badCount = (src.match(/role\.members\.cache/g) || []).length;
check('no role.members.cache usage (crash pattern)', badCount, 0);

// 2) The correct API must be present: role.members.has(...) in both branches.
const goodCount = (src.match(/role\.members\.has\(/g) || []).length;
check('role.members.has used in add + remove branches', goodCount >= 2, true);

// 3) Sanity: resolveGuildMember import + rename/sync helpers wired.
check('resolveGuildMember imported', src.includes('resolveGuildMember'), true);
check('queueChannelRename imported', src.includes('queueChannelRename'), true);

// 4) The handler must not gate add/remove behind role.members before the
//    role is fetched (structural check: the "already a player" reply must
//    only appear after the role object is resolved).
const addIdx = src.indexOf('is already a player in this campaign');
const roleFetchIdx = src.indexOf('const role = interaction.guild.roles.cache.get(linkedRoleId);');
check('"already a player" check comes after role fetch', addIdx > roleFetchIdx && roleFetchIdx !== -1, true);

// 5) 2026-09-07 "application did not respond" regression: the interaction
//    reply MUST come before the (rate-limited) channel-rename work in both
//    the add and remove branches. Awaiting the rename before replying let
//    discord.js's rate limiter sleep for up to ~10 min inside the awaited
//    call (2 renames / 10 min quota), blowing Discord's 3-second
//    interaction deadline while the role change had ALREADY succeeded —
//    users saw "did not respond" but the member WAS added.
const addReplyIdx = src.indexOf('✅ Added');
const addSyncIdx = src.indexOf('queueChannelRename', addReplyIdx);
check('add branch: reply fires before the rename work',
    addReplyIdx !== -1 && addSyncIdx > addReplyIdx, true);
const removeReplyIdx = src.indexOf('✅ Removed');
const removeSyncIdx = src.indexOf('queueChannelRename', removeReplyIdx);
check('remove branch: reply fires before the rename work',
    removeReplyIdx !== -1 && removeSyncIdx > removeReplyIdx, true);

// 6) No awaited rename/sync anywhere in the handler — renames are
//    fire-and-forget (with .catch) so they can never block a reply.
const awaitedRenameCount = (src.match(/await\s+(queueChannelRename|syncChannelNameToRoleCount)/g) || []).length;
check('no awaited rename/sync call in the handler', awaitedRenameCount, 0);

console.log(failures.length === 0
    ? `[Test] RESULT: PASS (${new Date().toISOString()})`
    : `[Test] RESULT: FAIL (${failures.length} failure(s))`);
process.exit(passed ? 0 : 1);