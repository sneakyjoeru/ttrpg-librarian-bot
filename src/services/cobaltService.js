// === cobalt download tier ===
//
// cobalt (https://github.com/imputnet/cobalt) is a self-hosted media resolver
// with its own per-service extractors. One instance runs as the `cobalt-api`
// container on the bots host (see COBALT_API_URL in src/config.js) and is used
// as an ADDITIONAL attempt in the Instagram / Facebook / TikTok chains.
//
// Design contract (same as every other tier in this codebase):
//   - strictly additive: ANY error, timeout, unsupported link or unhandled
//     status returns null, and the caller moves on to its next tier;
//   - deterministic: one HTTP request + one file download, no LLM, no browser;
//   - never throws.
//
// Flow: POST / {url} → cobalt resolves server-side and answers with one of
//   tunnel / redirect      { url, filename }  → the media file itself
//   picker                 { picker: [{type,url,thumb}] } → multi-item post
//   local-processing       needs client-side remux → NOT handled here (null)
//   error                  { error: { code } }
//
// Verified 2026-09-25 against cobalt 11.7.1: a public Instagram reel came back
// as `redirect` with the real cdninstagram .mp4 and an image post as `tunnel`
// with a .jpg, both anonymously.

const axios = require('axios');
const { AttachmentBuilder } = require('discord.js');
const { COBALT_API_URL, COBALT_API_KEY, COBALT_TIMEOUT_MS } = require('../config');
const { detectFileType } = require('../utils/fileTypeDetector');

// A picker can list a whole carousel; Discord allows 10 files per message.
const MAX_PICKER_ITEMS = 10;

function _requestHeaders() {
    const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
    if (COBALT_API_KEY) headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;
    return headers;
}

// Download one resolved media URL and turn it into an AttachmentBuilder.
async function _fetchMedia(url, { namePrefix, index, expectedExt }) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: COBALT_TIMEOUT_MS,
        maxRedirects: 5,
        headers: { 'Accept': '*/*' }
    });
    const buffer = Buffer.from(res.data);
    if (!buffer || buffer.length < 1024) return null; // error pages / empty files

    const contentType = String(res.headers['content-type'] || '');
    let ext = expectedExt || detectFileType(buffer) || null;
    if (!ext) {
        if (contentType.includes('video/mp4')) ext = 'mp4';
        else if (contentType.includes('video/webm')) ext = 'webm';
        else if (contentType.includes('image/png')) ext = 'png';
        else if (contentType.includes('image/webp')) ext = 'webp';
        else if (contentType.includes('image/gif')) ext = 'gif';
        else if (contentType.includes('image/')) ext = 'jpg';
        else ext = 'mp4';
    }
    return new AttachmentBuilder(buffer, { name: `${namePrefix}_${index}.${ext}` });
}

function _extFromFilename(filename) {
    const m = String(filename || '').match(/\.([a-z0-9]{2,4})(?:\?|$)/i);
    return m ? m[1].toLowerCase() : null;
}

/**
 * Resolve `sourceUrl` through cobalt and return AttachmentBuilder[] (or null).
 *
 * @param {string} sourceUrl canonical post/reel/video URL
 * @param {{namePrefix?: string, expectVideo?: boolean, log?: Function}} [opts]
 *        expectVideo marks an image-only result as a restricted fallback
 *        (the caller posts it with the "private video" notice).
 */
async function downloadWithCobalt(sourceUrl, opts = {}) {
    if (!COBALT_API_URL) return null;
    const namePrefix = opts.namePrefix || 'cobalt_media';
    const log = opts.log || ((m) => console.log(m));

    let data;
    try {
        const res = await axios.post(
            COBALT_API_URL,
            { url: sourceUrl, videoQuality: 'max', filenameStyle: 'basic' },
            { headers: _requestHeaders(), timeout: COBALT_TIMEOUT_MS, maxRedirects: 0, validateStatus: (s) => s >= 200 && s < 500 }
        );
        data = res.data;
    } catch (err) {
        const status = err.response && err.response.status;
        log(`[Cobalt] request failed${status ? ` (HTTP ${status})` : ''}: ${err.message}`);
        return null;
    }

    if (!data || typeof data !== 'object') { log('[Cobalt] empty response'); return null; }
    if (data.status === 'error') {
        const code = data.error && data.error.code;
        log(`[Cobalt] ${code || 'error'} for ${sourceUrl}`);
        return null;
    }
    if (data.status === 'local-processing') {
        // cobalt split the media into streams it expects the CLIENT to remux.
        // Not handled here — fall through so the caller's next tier runs.
        log(`[Cobalt] local-processing (${data.type || 'unknown'}) not supported by this tier`);
        return null;
    }

    const items = [];
    if (data.status === 'tunnel' || data.status === 'redirect') {
        if (data.url) items.push({ url: data.url, ext: _extFromFilename(data.filename) });
    } else if (data.status === 'picker' && Array.isArray(data.picker)) {
        // Videos first, then photos — a carousel keeps cobalt's order otherwise.
        const ordered = [...data.picker].sort((a, b) => (a.type === 'video' ? 0 : 1) - (b.type === 'video' ? 0 : 1));
        for (const item of ordered.slice(0, MAX_PICKER_ITEMS)) {
            if (item && item.url) items.push({ url: item.url, ext: null });
        }
    } else {
        log(`[Cobalt] unhandled status "${data.status}"`);
        return null;
    }
    if (items.length === 0) return null;

    const attachments = [];
    for (const item of items) {
        try {
            const att = await _fetchMedia(item.url, { namePrefix, index: attachments.length, expectedExt: item.ext });
            if (att) attachments.push(att);
        } catch (err) {
            log(`[Cobalt] media download failed: ${err.message}`);
        }
    }
    if (attachments.length === 0) { log('[Cobalt] nothing downloadable'); return null; }

    const hasVideo = attachments.some((a) => /\.(mp4|webm|mov)$/i.test(a.name || ''));
    if (opts.expectVideo && !hasVideo) attachments.isRestrictedVideoFallback = true;
    log(`[Cobalt] returning ${attachments.length} attachment(s)${hasVideo ? '' : ' (image only)'}`);
    return attachments;
}

module.exports = { downloadWithCobalt };
