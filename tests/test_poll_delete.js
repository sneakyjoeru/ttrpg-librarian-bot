// Test: /delete accepts polls created by the calling user (pollCreatedByUser).
//
// The poll message is authored by the bot, so the generic "tied to user"
// heuristics (reply reference / mention / webhook display name) never matched
// it — /delete answered "No suitable messages to delete were found." even
// though the poll was the user's own. The fix recognises (a) polls tracked in
// memory at creation time and (b) /schedule-poll polls whose persisted state
// carries creatorId (survives restarts).
//
// Run inside the container:
//   docker exec librarian-bot node tests/test_poll_delete.js
// Run locally (no Discord login required — pure function test):
//   node tests/test_poll_delete.js
const fs = require('fs');
const { pollCreatedByUser, parsePollEmbed } = require('../src/handlers/polls');
const { trackMessage, removeTrackedMessage } = require('../src/utils/messageTracker');
const { setSchedule, deleteSchedule, getSchedule } = require('../src/utils/scheduling');
const { SCHEDULE_STATE_PATH } = require('../src/config');

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

// Minimal Discord message shape — only the fields the poll/delete code reads.
const BOT_ID = '900000000000000001';
const CREATOR_ID = '900000000000000002';
const OTHER_ID = '900000000000000003';

function makeMessage(id, { authorId = BOT_ID, title = '📊 Which tavern?', description = '1️⃣ The Rusty Anchor\n\n2️⃣ The Prancing Pony\n\n', reference = null } = {}) {
    return {
        id,
        author: { id: authorId },
        content: '',
        embeds: title === null ? [] : [{ title, description }],
        reference,
        webhookId: null,
        channel: { id: '900000000000000010' }
    };
}

async function main() {
    // 1. Plain non-poll messages are never treated as the user's own poll.
    check('plain user message -> not a poll',
        pollCreatedByUser(makeMessage('m1', { authorId: CREATOR_ID, title: null }), CREATOR_ID, BOT_ID), false);
    check('bot repost without poll embed -> not a poll',
        pollCreatedByUser(makeMessage('m2', { title: null }), CREATOR_ID, BOT_ID), false);

    // 2. Poll embed parsing still gates on the bot author.
    check('📊 poll authored by bot parses',
        !!parsePollEmbed(makeMessage('m3'), BOT_ID), true);
    check('📊 poll authored by a regular user does not parse',
        !!parsePollEmbed(makeMessage('m4', { authorId: CREATOR_ID }), BOT_ID), false);

    // 3. Untracked poll with no schedule state -> not recognised (the old,
    //    broken behaviour is preserved for messages the bot cannot attribute).
    check('untracked poll -> false',
        pollCreatedByUser(makeMessage('m5'), CREATOR_ID, BOT_ID), false);

    // 4. Poll tracked at creation (the /poll-librarian path).
    trackMessage('m6', CREATOR_ID, '900000000000000010');
    check('tracked 📊 poll, creator asks -> true',
        pollCreatedByUser(makeMessage('m6'), CREATOR_ID, BOT_ID), true);
    check('tracked 📊 poll, other user asks -> false',
        pollCreatedByUser(makeMessage('m6'), OTHER_ID, BOT_ID), false);
    removeTrackedMessage('m6');

    // 5. Schedule poll: creatorId lives in schedules.json, so the creator can
    //    still delete it after a restart wiped the in-memory tracking.
    const TEST_SCHED_ID = 'test-poll-delete-schedule-state';
    const existedBefore = fs.existsSync(SCHEDULE_STATE_PATH);
    try {
        setSchedule(TEST_SCHED_ID, {
            channelId: '900000000000000010',
            guildId: '1',
            creatorId: CREATOR_ID,
            roleId: null,
            options: [],
            lastEmittedConfirmed: null,
            consensusField: null,
            createdAt: Date.now()
        });
        check('schedule state recorded',
            (getSchedule(TEST_SCHED_ID) || {}).creatorId, CREATOR_ID);
        const schedMsg = () => makeMessage(TEST_SCHED_ID, { title: '📅 Wed 18:00-22:00 (Week 1)' });
        check('📅 schedule poll, creator asks after restart -> true',
            pollCreatedByUser(schedMsg(), CREATOR_ID, BOT_ID), true);
        check('📅 schedule poll, other user asks -> false',
            pollCreatedByUser(schedMsg(), OTHER_ID, BOT_ID), false);
        check('📅 schedule poll, user-authored lookalike -> false',
            pollCreatedByUser(makeMessage(TEST_SCHED_ID, { authorId: CREATOR_ID, title: '📅 fake' }), CREATOR_ID, BOT_ID), false);
    } finally {
        // Restore the store exactly as found (deleteSchedule is a no-op when the
        // key is absent, so live state is untouched by this round trip).
        deleteSchedule(TEST_SCHED_ID);
        setImmediate(() => {
            // If the test created the data file, do not leave an empty one behind.
            if (!existedBefore && fs.existsSync(SCHEDULE_STATE_PATH) && fs.readFileSync(SCHEDULE_STATE_PATH, 'utf8').trim() === '{}') {
                fs.unlinkSync(SCHEDULE_STATE_PATH);
            }
        });
    }

    // 6. After /delete removes an own poll, the tracking + schedule state are
    //    gone, so a second /delete cannot claim it again.
    trackMessage('m7', CREATOR_ID, '900000000000000010');
    setSchedule('m7', { creatorId: CREATOR_ID, options: [] });
    removeTrackedMessage('m7');
    deleteSchedule('m7');
    check('after delete cleanup -> false',
        pollCreatedByUser(makeMessage('m7'), CREATOR_ID, BOT_ID), false);

    console.log(passed ? '[Test] PASS test_poll_delete' : `[Test] FAIL test_poll_delete (${failures.length} failure(s))`);
    if (!passed) process.exitCode = 1;
}

main().catch((err) => {
    console.error('[Test] ERROR:', err);
    process.exitCode = 1;
});
