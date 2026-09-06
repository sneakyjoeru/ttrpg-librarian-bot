// Test: /campaign-rename channel-name transform (buildCampaignChannelName).
// Verifies the helper preserves the trailing creator-name + player-count
// segments when replacing the campaign-name segment, and handles edge cases
// (2-segment names, over-long names, invalid formats).
//
// Run inside the container:
//   docker exec librarian-bot node tests/test_campaign_rename.js
// Run locally (no Discord login required — pure function test):
//   node tests/test_campaign_rename.js
const { buildCampaignChannelName } = require('../src/utils/helpers');

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

// Standard 3-segment name: campaignName-creatorName-playerCount.
check('3-segment rename preserves creator + count',
    buildCampaignChannelName('curse-of-strahd-godyalis-4', 'icewind-dale'),
    'icewind-dale-godyalis-4');

// Spaces in the new campaign name are converted to dashes by the caller, but
// the helper itself must not mangle already-dashed input.
check('multi-word new name',
    buildCampaignChannelName('lost-mine-godyalis-3', 'curse-of-strahd'),
    'curse-of-strahd-godyalis-3');

// 2-segment name: only the trailing segment (the count) is preserved.
check('2-segment name keeps only trailing count',
    buildCampaignChannelName('game-5', 'new-name'),
    'new-name-5');

// Same name → caller is expected to detect no-change; helper still returns
// the rebuilt name.
check('identical campaign name returns same full name',
    buildCampaignChannelName('curse-of-strahd-godyalis-4', 'curse-of-strahd'),
    'curse-of-strahd-godyalis-4');

// Over-long new campaign name is capped at 100 characters.
check('over-long result capped at 100 chars',
    buildCampaignChannelName('game-godyalis-4', 'x'.repeat(120)).length,
    100);

// Invalid formats.
check('single-segment name returns null',
    buildCampaignChannelName('justoneword', 'new-name'),
    null);
check('empty current name returns null',
    buildCampaignChannelName('', 'new-name'),
    null);

console.log(failures.length === 0
    ? `[Test] RESULT: PASS (${new Date().toISOString()})`
    : `[Test] RESULT: FAIL (${failures.length} failure(s))`);
process.exit(passed ? 0 : 1);