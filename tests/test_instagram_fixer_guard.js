// Regression test — Instagram Reel downloads (2026-09-25).
//
// Bug: InstaFix-style mirrors (uuinstagram.com et al.) answer a blocked/gated
// Reel with a placeholder page that declares
//     <meta property="og:video" content="/videos/<sc>/1">
//     <meta property="og:video:type" content="video/mp4">
//     <meta property="og:video:width" content="0">
// while that URL actually serves the post's JPEG cover (640x1136, ~35 KB).
// The bot trusted the tag, named the file instagram_media_0.mp4 and posted it,
// so Discord showed a "video" that cannot play.
//
// This test drives the real handleInstagramMessage with a stubbed network and
// asserts:
//   1. a mirrored og:video that serves image bytes is never named .mp4 and is
//      reported as "Video is unavailable for embedding.";
//   2. a genuine mp4 still comes through as .mp4 with no fallback notice;
//   3. for Reels the API resolvers (cobalt) are tried before the mirrors.
//
// Run: node tests/test_instagram_fixer_guard.js

const Module = require('module');
const path = require('path');
const assert = require('assert');

const REEL = 'https://instagram.com/reel/DdqlRS4Rrug/';

// --- cropped-rendition fixture (2026-10-12) ---------------------------------
// Bug: a mirror's og:image is the CDN's signed 640x640 crop
// (`stp=c327.0.984.983a_dst-jpg_e35_s640x640_tt6`), so a portrait post was
// posted with the bottom of the frame sliced off. Instagram's own
// /p/<sc>/media/?size=l 302s to the same photo with `stp=dst-jpg_e35_p1080x1080`
// — the full frame. This file asserts the bot re-resolves to that URL instead of
// downloading the crop.
const PHOTO = 'https://instagram.com/p/DeCropTest/';
const CROPPED_RENDITION = 'https://scontent-hel3-1.cdninstagram.com/v/t39.30808-6/cropped_n.jpg?stp=c327.0.984.983a_dst-jpg_e35_s640x640_tt6&_nc_ht=scontent-hel3-1.cdninstagram.com&oh=sig&oe=1';
const FULL_FRAME_RENDITION = 'https://scontent-hel3-1.cdninstagram.com/v/t39.30808-6/full_n.jpg?stp=dst-jpg_e35_p1080x1080_sh2.08_tt6&_nc_ht=scontent-hel3-1.cdninstagram.com&oh=sig&oe=1';
const CROPPED_BYTES = 44124;   // 640x640 square
const FULL_BYTES = 168592;     // 1080x1350 full frame

// --- fixtures ---------------------------------------------------------------
// Smallest buffers that carry each magic signature (detectFileType reads the
// first 12 bytes). The sizes are padded to look like real payloads.
function jpegBuffer(size = 35754) {
    const b = Buffer.alloc(size, 0x20);
    Buffer.from('ffd8ffe00010', 'hex').copy(b, 0); // JFIF APP0
    return b;
}
function mp4Buffer(size = 2048) {
    const b = Buffer.alloc(size, 0x00);
    Buffer.from('00000018667479706d7034', 'hex').copy(b, 0); // ftypmp4
    return b;
}

// --- stub modules -----------------------------------------------------------
const events = [];
const captured = {};

const axiosStub = {
    get: async (url) => {
        if (/uuinstagram\.com\/reel\//.test(url)) {
            events.push('fixer:uuinstagram');
            return {
                status: 200,
                headers: { 'content-type': 'text/html' },
                data: `<html><head><meta property="og:video" content="/videos/DdqlRS4Rrug/1"/>`
                    + `<meta property="og:video:type" content="video/mp4"/>`
                    + `<meta property="og:video:width" content="0"/>`
                    + `<meta property="og:video:height" content="0"/></head></html>`
            };
        }
        if (/\/videos\/DdqlRS4Rrug\/1/.test(url)) {
            return captured.media;
        }
        // Cropped-rendition case: the mirror hands back a cropped og:image, and
        // Instagram's media endpoint answers with the full-frame signed URL.
        if (/uuinstagram\.com\/p\/DeCropTest/.test(url)) {
            events.push('fixer:uuinstagram');
            return {
                status: 200,
                headers: { 'content-type': 'text/html' },
                data: `<html><head><meta property="og:image" content="${CROPPED_RENDITION.replace(/&/g, '&amp;')}"/>`
                    + `<meta property="og:image:width" content="640"/></head></html>`
            };
        }
        if (/instagram\.com\/p\/DeCropTest\/media\/\?size=l/.test(url)) {
            events.push('fullframe:media-endpoint');
            return { status: 302, headers: { location: FULL_FRAME_RENDITION }, data: '' };
        }
        if (url === CROPPED_RENDITION) {
            events.push('download:cropped');
            return { status: 200, headers: { 'content-type': 'image/jpeg' }, data: jpegBuffer(CROPPED_BYTES) };
        }
        if (url === FULL_FRAME_RENDITION) {
            events.push('download:fullframe');
            return { status: 200, headers: { 'content-type': 'image/jpeg' }, data: jpegBuffer(FULL_BYTES) };
        }
        // ee/kkinstagram, raw instagram.com fetches and anything else: fail.
        throw new Error(`stub: unexpected GET ${url}`);
    },
    post: async () => {
        events.push('cobalt:post');
        throw new Error('stub: cobalt unavailable');
    }
};

const webhookStub = {
    sendRepostedMessage: async () => { },
    sendWorkingPlaceholder: async () => ({ sentMsg: { attachments: { size: 0 } }, baseText: '' }),
    updateWorkingPlaceholder: async (ph, text, attachments, ok, limit, fallback) => {
        captured.text = text;
        captured.attachments = attachments;
        captured.fallbackContent = fallback;
    },
    updatePlaceholderStage: async () => { },
    finalizePlaceholderClean: async () => { }
};

const shellStub = {
    runCommand: async () => { throw new Error('stub: no yt-dlp'); },
    findYtDlpPath: () => null,
    cookiesFlagForYtDlp: () => ''
};

const compressorStub = {
    getGuildFileLimit: () => 50 * 1024 * 1024,
    compressVideoToFit: async () => null
};

let queuedJob = null;
const mediaQueueStub = {
    enqueue: (fn) => { queuedJob = fn(); return queuedJob; }
};

// src/config.js builds its slash-command list at import time, so the discord
// stub needs chainable builders too (any method returns the same object).
function chainable() {
    const p = new Proxy({}, {
        get: (t, k) => (k === 'toJSON' ? () => ({}) : () => p),
        set: () => true
    });
    return p;
}
const ChainableBuilder = new Proxy(function () { }, {
    construct: () => chainable(),
    apply: () => chainable()
});

const discordStub = {
    AttachmentBuilder: class AttachmentBuilder {
        constructor(attachment, opts) {
            this.attachment = attachment;
            this.name = (opts && opts.name) || '';
        }
    },
    SlashCommandBuilder: ChainableBuilder,
    PermissionFlagsBits: new Proxy({}, { get: () => 0n })
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'axios') return axiosStub;
    if (request === 'discord.js') return discordStub;
    if (request === 'snapinsta') return { getLinks: async () => { throw new Error('stub: snapinsta'); } };
    if (/utils[\\/]webhook$/.test(request)) return webhookStub;
    if (/utils[\\/]shell$/.test(request)) return shellStub;
    if (/utils[\\/]mediaCompressor$/.test(request)) return compressorStub;
    if (/utils[\\/]mediaQueue$/.test(request)) return mediaQueueStub;
    return origLoad.apply(this, arguments);
};

process.env.COBALT_API_URL = 'http://127.0.0.1:9000/'; // keep the cobalt tier enabled
const { handleInstagramMessage } = require(path.join(__dirname, '..', 'src', 'services', 'instagram.js'));

function fakeMessage(url) {
    return {
        id: '1',
        guild: { id: 'g' },
        cleanContent: url,
        content: url,
        author: { tag: 'test#0001', id: '2' },
        channel: { sendTyping: async () => { } },
        delete: async () => { }
    };
}

async function runCase(label, media, expectExt, expectPrivateNotice) {
    events.length = 0;
    captured.media = media;
    captured.attachments = null;
    captured.text = null;
    queuedJob = null;

    await handleInstagramMessage({}, fakeMessage(REEL), REEL, REEL);
    if (queuedJob) await queuedJob;

    const atts = captured.attachments || [];
    const names = atts.map(a => a.name);
    const text = captured.text || '';
    console.log(`\n── ${label}`);
    console.log(`   attachments: ${JSON.stringify(names)}`);
    console.log(`   notice:      ${text.includes('Video is unavailable for embedding') ? 'Video is unavailable for embedding.' : '(none)'}`);
    console.log(`   call order:  ${events.join(' → ') || '(none)'}`);

    assert.ok(atts.length > 0, `${label}: expected an attachment`);
    assert.strictEqual(names[0], `instagram_media_0.${expectExt}`,
        `${label}: expected instagram_media_0.${expectExt}, got ${names[0]}`);
    assert.strictEqual(text.includes('Video is unavailable for embedding'), expectPrivateNotice,
        `${label}: unavailable-video notice mismatch`);
    return events.slice();
}

(async () => {
    // 1. Mirror claims a video, serves a JPEG cover.
    await runCase('mirror og:video → JPEG bytes', { status: 200, headers: { 'content-type': 'image/jpeg' }, data: jpegBuffer() }, 'jpg', true);

    // 2. Same mirror, genuine mp4.
    const order = await runCase('mirror og:video → real mp4', { status: 200, headers: { 'content-type': 'video/mp4' }, data: mp4Buffer() }, 'mp4', false);

    // 3. Tier order for Reels: cobalt before the InstaFix mirror.
    const cobaltAt = order.indexOf('cobalt:post');
    const fixerAt = order.indexOf('fixer:uuinstagram');
    assert.ok(cobaltAt !== -1, 'cobalt tier was never tried for a Reel');
    assert.ok(fixerAt !== -1, 'fixer mirror was never tried for a Reel');
    assert.ok(cobaltAt < fixerAt, `Reel tier order wrong: ${order.join(' → ')}`);

    // 4. Cropped mirror rendition is replaced by the full-frame media endpoint.
    events.length = 0;
    captured.media = null;
    captured.attachments = null;
    captured.text = null;
    queuedJob = null;
    await handleInstagramMessage({}, fakeMessage(PHOTO), PHOTO, PHOTO);
    if (queuedJob) await queuedJob;

    const cropAtts = captured.attachments || [];
    const cropNames = cropAtts.map(a => a.name);
    const cropBytes = cropAtts.length ? cropAtts[0].attachment.length : 0;
    console.log(`\n── mirror og:image → cropped 640x640 rendition`);
    console.log(`   attachments: ${JSON.stringify(cropNames)} (${cropBytes} bytes)`);
    console.log(`   call order:  ${events.join(' → ') || '(none)'}`);
    assert.ok(cropAtts.length > 0, 'cropped-rendition case: expected an attachment');
    assert.strictEqual(cropNames[0], 'instagram_media_0.jpg', `cropped-rendition case: expected instagram_media_0.jpg, got ${cropNames[0]}`);
    assert.ok(events.includes('fullframe:media-endpoint'), 'cropped-rendition case: the full-frame media endpoint was never queried');
    assert.ok(events.includes('download:fullframe'), 'cropped-rendition case: the full-frame rendition was never downloaded');
    assert.ok(!events.includes('download:cropped'), 'cropped-rendition case: the cropped rendition was posted');
    assert.strictEqual(cropBytes, FULL_BYTES, `cropped-rendition case: expected the ${FULL_BYTES}-byte full frame, got ${cropBytes} bytes`);

    console.log('\nPASS — 4/4');
})().catch(e => { console.error('\nFAIL —', e.message); process.exit(1); });
