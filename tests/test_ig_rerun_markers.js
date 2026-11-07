'use strict';
// Re-run markers for Instagram posts (scripts/reprocess-instagram.js, /process):
// the base text drops "Video is unavailable for embedding." and the Android-VM label,
// and the recovered placeholder remembers that the post was an "unavailable" one so a
// re-run that keeps the old cover can say so again. Run: node tests/test_ig_rerun_markers.js
const assert = require('assert');
const { extractPlaceholderBaseContent, buildRecoveredPlaceholder } = require('../src/utils/webhook');

(async () => {
    const url = 'https://instagram.com/reel/DezfOzVyNNN/';
    const unavailable = `look at this\nVideo is unavailable for embedding.\n<${url}>`;
    assert.strictEqual(extractPlaceholderBaseContent(unavailable), `look at this\n<${url}>`);
    assert.strictEqual(extractPlaceholderBaseContent(`<${url}>\n-# 🛠 processed using a dirty hack`), `<${url}>`);

    const p1 = await buildRecoveredPlaceholder({}, { content: unavailable, webhookId: null });
    assert.strictEqual(p1.wasUnavailable, true);
    const p2 = await buildRecoveredPlaceholder({}, { content: `<${url}>`, webhookId: null });
    assert.strictEqual(p2.wasUnavailable, false);
    console.log('PASS — 4/4');
})().catch((e) => { console.error(e); process.exit(1); });
