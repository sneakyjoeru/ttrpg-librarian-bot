const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { instagramGetUrl } = require('instagram-url-direct');
const snapinsta = require('snapinsta');
const { AttachmentBuilder } = require('discord.js');
const { RAG_TYPING_INTERVAL, FFMPEG_TIMEOUT, FILE_SIZE_SAFETY_FACTOR } = require('../config');
const { sendRepostedMessage, sendWorkingPlaceholder, updateWorkingPlaceholder, updatePlaceholderStage, finalizePlaceholderClean } = require('../utils/webhook');
const { runCommand, findYtDlpPath } = require('../utils/shell');
const { getGuildFileLimit, compressVideoToFit } = require('../utils/mediaCompressor');
const mediaQueue = require('../utils/mediaQueue');
const { detectFileType } = require('../utils/fileTypeDetector');

const INSTAGRAM_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// --- Instagram cookie header (Netscape cookies.txt → Cookie header) ---
// Reused for BOTH the post media pipeline (yt-dlp already gets the file path)
// and the profile parser's authenticated GraphQL profile query. Instagram gates
// profile pages behind a login wall for unauthenticated requests, so the cookie
// header is required to fetch profile data (userpic, bio, recent posts).
const INSTAGRAM_COOKIE_PATHS = [
    path.join(process.cwd(), 'instagram-cookies.txt'),
    path.join(process.cwd(), 'cookies.txt'),
    path.join(process.cwd(), 'data', 'instagram-cookies.txt'),
    path.join(process.cwd(), 'data', 'cookies.txt'),
    path.join(__dirname, '../../instagram-cookies.txt'),
    path.join(__dirname, '../../cookies.txt'),
    path.join(__dirname, '../../data/instagram-cookies.txt'),
    path.join(__dirname, '../../data/cookies.txt'),
    '/usr/src/app/instagram-cookies.txt',
    '/usr/src/app/cookies.txt',
    '/usr/src/app/data/instagram-cookies.txt',
    '/usr/src/app/data/cookies.txt',
    '/tmp/instagram-cookies.txt',
    '/tmp/cookies.txt'
];

let cachedCookieHeader = null;
let cachedCookieHeaderTime = 0;
const COOKIE_HEADER_CACHE_TTL = 60000; // 60s

function buildInstagramCookieHeader() {
    const now = Date.now();
    if (cachedCookieHeader && (now - cachedCookieHeaderTime) < COOKIE_HEADER_CACHE_TTL) {
        return cachedCookieHeader;
    }

    let cookieFile = null;
    for (const p of INSTAGRAM_COOKIE_PATHS) {
        if (fs.existsSync(p)) {
            cookieFile = p;
            break;
        }
    }
    if (!cookieFile) {
        return null;
    }

    try {
        const content = fs.readFileSync(cookieFile, 'utf8');
        const pairs = [];
        const seen = new Set();
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const parts = trimmed.split('\t');
            if (parts.length < 7) continue;
            const domain = parts[0] || '';
            const name = parts[5];
            const value = parts[6];
            if (!name || !value) continue;
            if (!domain.includes('instagram.com')) continue;
            if (seen.has(name)) continue;
            seen.add(name);
            pairs.push(`${name}=${value}`);
        }
        const header = pairs.length > 0 ? pairs.join('; ') : null;
        cachedCookieHeader = header;
        cachedCookieHeaderTime = now;
        return header;
    } catch (err) {
        console.error('[Instagram Interceptor] Failed to parse cookies for profile scrape:', err.message);
        return null;
    }
}

function getCsrftokenFromCookieHeader(header) {
    if (!header) return null;
    const m = header.match(/csrftoken=([^;]+)/);
    return m ? m[1] : null;
}

// Fetch a fresh csrftoken from instagram.com (for unauthenticated GraphQL variants).
let cachedFreshCsrf = null;
let cachedFreshCsrfTime = 0;
const FRESH_CSRF_TTL = 300000; // 5 min
async function fetchFreshCsrfToken(browserUa) {
    const now = Date.now();
    if (cachedFreshCsrf && (now - cachedFreshCsrfTime) < FRESH_CSRF_TTL) {
        return cachedFreshCsrf;
    }
    try {
        const resp = await axios.get('https://www.instagram.com/', {
            timeout: 10000,
            maxRedirects: 5,
            headers: {
                'User-Agent': browserUa,
                'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none'
            }
        });
        const setCookies = resp.headers['set-cookie'] || [];
        for (const c of setCookies) {
            const m = c.match(/csrftoken=([^;]+)/);
            if (m) {
                cachedFreshCsrf = m[1];
                cachedFreshCsrfTime = now;
                return cachedFreshCsrf;
            }
        }
    } catch (err) {
        console.log('[Instagram Interceptor] Fresh CSRF fetch failed:', err.message);
    }
    return null;
}

function unescapeInstagramJsonUrl(url) {
    return url
        .replace(/\\\\/g, '\\')
        .replace(/\\u0026/g, '&')
        .replace(/\\u0025/g, '%')
        .replace(/\\\//g, '/')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/\\+/g, '');
}

function pickBestUrlFromVersionsBlock(block, escaped) {
    if (!block) return null;
    const heightRe = escaped ? /\\"height\\"\s*:\s*(\d+)/g : /"height"\s*:\s*(\d+)/g;
    const urlRe = escaped ? /\\"url\\"\s*:\s*\\"([^"]+)\\"/g : /"url"\s*:\s*"([^"]+)"/g;
    const heights = [];
    const urls = [];
    let m;
    while ((m = heightRe.exec(block)) !== null) heights.push(parseInt(m[1], 10) || 0);
    while ((m = urlRe.exec(block)) !== null) urls.push(m[1]);
    if (urls.length === 0) return null;
    if (heights.length === 0) return urls[urls.length - 1];
    let bestIdx = 0;
    for (let i = 1; i < urls.length; i++) {
        if ((heights[i] || 0) > (heights[bestIdx] || 0)) bestIdx = i;
    }
    return urls[bestIdx] || urls[0];
}

function pickBestSrcFromResourcesBlock(block, escaped) {
    if (!block) return null;
    const widthRe = escaped ? /\\"config_width\\"\s*:\s*(\d+)/g : /"config_width"\s*:\s*(\d+)/g;
    const srcRe = escaped ? /\\"src\\"\s*:\s*\\"([^"]+)\\"/g : /"src"\s*:\s*"([^"]+)"/g;
    const widths = [];
    const srcs = [];
    let m;
    while ((m = widthRe.exec(block)) !== null) widths.push(parseInt(m[1], 10) || 0);
    while ((m = srcRe.exec(block)) !== null) srcs.push(m[1]);
    if (srcs.length === 0) return null;
    if (widths.length === 0) return srcs[srcs.length - 1];
    let bestIdx = 0;
    for (let i = 1; i < srcs.length; i++) {
        if ((widths[i] || 0) > (widths[bestIdx] || 0)) bestIdx = i;
    }
    return srcs[bestIdx] || srcs[0];
}

function scanJsonValue(text, start) {
    let i = start;
    while (i < text.length && /\s/.test(text[i])) i++;
    const ch = text[i];
    if (ch === '{' || ch === '[') {
        let depth = 0, inStr = false, esc = false;
        for (; i < text.length; i++) {
            const c = text[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
            } else if (c === '"') {
                inStr = true;
            } else if (c === '{' || c === '[') {
                depth++;
            } else if (c === '}' || c === ']') {
                depth--;
                if (depth === 0) { i++; break; }
            }
        }
        try { return JSON.parse(text.slice(start, i)); } catch { return null; }
    } else if (ch === '"') {
        let j = i + 1, esc = false;
        for (; j < text.length; j++) {
            const c = text[j];
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') { j++; break; }
        }
        try { return JSON.parse(text.slice(i, j)); } catch { return null; }
    } else {
        let j = i;
        while (j < text.length && !/[\s,}\]]/.test(text[j])) j++;
        const slice = text.slice(i, j);
        if (slice === 'true') return true;
        if (slice === 'false') return false;
        if (slice === 'null') return null;
        const n = Number(slice);
        return isNaN(n) ? null : n;
    }
}

function extractJsonValueForKey(text, key) {
    const keyRe = new RegExp(`"${key}"\\s*:\\s*`, 'g');
    let m;
    while ((m = keyRe.exec(text)) !== null) {
        const val = scanJsonValue(text, m.index + m[0].length);
        if (val !== null && val !== undefined) return val;
    }
    return null;
}

function pickBestVideoVersion(versions) {
    if (!Array.isArray(versions) || versions.length === 0) return null;
    const sorted = [...versions].sort((a, b) => (b.height || 0) - (a.height || 0));
    return sorted[0].url || null;
}

function pickBestImageCandidate(candidates) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => (b.width || 0) - (a.width || 0));
    return sorted[0].url || null;
}

function pickBestDisplayResource(resources) {
    if (!Array.isArray(resources) || resources.length === 0) return null;
    let best = null, bestW = -1;
    for (const r of resources) {
        if (!r) continue;
        const w = r.config_width || r.width || 0;
        const url = r.src || r.url;
        if (url && w > bestW) { best = url; bestW = w; }
    }
    return best;
}

function collectMediaItemsFromMediaObject(media) {
    if (!media || typeof media !== 'object') return null;
    let nodes = null;
    if (Array.isArray(media.carousel_media) && media.carousel_media.length) {
        nodes = media.carousel_media;
    } else if (media.edge_sidecar_to_children && Array.isArray(media.edge_sidecar_to_children.edges)) {
        nodes = media.edge_sidecar_to_children.edges.map(e => e && e.node).filter(Boolean);
    }
    if (!nodes) nodes = [media];
    const ordered = [];
    for (const node of nodes) {
        if (!node) continue;
        const videoV = pickBestVideoVersion(node.video_versions) || node.video_url || null;
        const imageV = pickBestImageCandidate(node.image_versions2 && node.image_versions2.candidates)
            || pickBestDisplayResource(node.display_resources)
            || pickBestDisplayResource(node.thumbnail_resources)
            || node.display_url || null;
        if (videoV) {
            ordered.push({ url: unescapeInstagramJsonUrl(videoV), isVideo: true });
        } else if (imageV) {
            ordered.push({ url: unescapeInstagramJsonUrl(imageV), isVideo: false });
        }
    }
    return ordered.length ? ordered : null;
}

function extractMediaFromEmbeddedJson(html) {
    const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = scriptRe.exec(html)) !== null) {
        const raw = m[1];
        if (raw.indexOf('shortcode_media') === -1) continue;
        const text = raw
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#x27;/g, "'")
            .replace(/&#39;/g, "'")
            .replace(/&gt;/g, '>')
            .replace(/&lt;/g, '<');
        const media = extractJsonValueForKey(text, 'xdt_shortcode_media')
            || extractJsonValueForKey(text, 'shortcode_media');
        if (media) {
            const items = collectMediaItemsFromMediaObject(media);
            if (items && items.length) return items;
        }
    }
    return null;
}

function extractMediaByShortcodeFromHtml(html, shortcode) {
    if (!shortcode) return null;
    const codeRe = new RegExp('"(?:code|shortcode)"\\s*:\\s*"' + shortcode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"', 'g');
    let m;
    while ((m = codeRe.exec(html)) !== null) {
        let brace = m.index, depth = 0;
        for (let i = m.index; i >= 0; i--) {
            const c = html[i];
            if (c === '}') depth++;
            else if (c === '{') { if (depth === 0) { brace = i; break; } depth--; }
        }
        const obj = scanJsonValue(html, brace);
        if (obj && typeof obj === 'object' &&
            (obj.code === shortcode || obj.shortcode === shortcode) &&
            (obj.image_versions2 || obj.video_versions || obj.carousel_media || obj.edge_sidecar_to_children)) {
            const items = collectMediaItemsFromMediaObject(obj);
            if (items && items.length) return items;
        }
    }
    return null;
}

function extractInstagramMediaFromHtml(html, shortcode) {
    const structured = extractMediaFromEmbeddedJson(html);
    if (structured && structured.length > 0) {
        return structured;
    }

    const byShortcode = extractMediaByShortcodeFromHtml(html, shortcode);
    if (byShortcode && byShortcode.length > 0) {
        return byShortcode;
    }

    const ordered = [];
    const seen = new Set();
    const push = (url, isVideo, index) => {
        if (!url) return;
        if (seen.has(url)) return;
        seen.add(url);
        ordered.push({ url, isVideo, index });
    };

    let m;
    const vvBlockRe = /"video_versions"\s*:\s*(\[(?:[^\[\]])*\])/g;
    while ((m = vvBlockRe.exec(html)) !== null) {
        const best = pickBestUrlFromVersionsBlock(m[1], false);
        if (best) push(unescapeInstagramJsonUrl(best), true, m.index);
    }
    const vvBlockEscRe = /\\"video_versions\\"\s*:\s*(\[(?:[^\[\]])*\])/g;
    while ((m = vvBlockEscRe.exec(html)) !== null) {
        const best = pickBestUrlFromVersionsBlock(m[1], true);
        if (best) push(unescapeInstagramJsonUrl(best), true, m.index);
    }
    const videoJsonRe = /"video_url"\s*:\s*"([^"]+)"/g;
    while ((m = videoJsonRe.exec(html)) !== null) {
        push(unescapeInstagramJsonUrl(m[1]), true, m.index);
    }
    const dispResRe = /"(?:display_resources|thumbnail_resources)"\s*:\s*(\[[^\]]*\])/g;
    while ((m = dispResRe.exec(html)) !== null) {
        const best = pickBestSrcFromResourcesBlock(m[1], false);
        if (best) push(unescapeInstagramJsonUrl(best), false, m.index);
    }
    const displayUrlRe = /"display_url"\s*:\s*"([^"]+)"/g;
    while ((m = displayUrlRe.exec(html)) !== null) {
        push(unescapeInstagramJsonUrl(m[1]), false, m.index);
    }
    const videoJsonEscRe = /\\"video_url\\"\s*:\s*\\"([^"]+)\\"/g;
    while ((m = videoJsonEscRe.exec(html)) !== null) {
        push(unescapeInstagramJsonUrl(m[1]), true, m.index);
    }
    const dispResEscRe = /\\"(?:display_resources|thumbnail_resources)\\"\s*:\s*(\[[^\]]*\])/g;
    while ((m = dispResEscRe.exec(html)) !== null) {
        const best = pickBestSrcFromResourcesBlock(m[1], true);
        if (best) push(unescapeInstagramJsonUrl(best), false, m.index);
    }
    const displayUrlEscRe = /\\"display_url\\"\s*:\s*\\"([^"]+)\\"/g;
    while ((m = displayUrlEscRe.exec(html)) !== null) {
        push(unescapeInstagramJsonUrl(m[1]), false, m.index);
    }
    const metaVideoRe = /<meta[^>]+(?:property|name)=["'](?:og:video(?:\.(?:secure_url|url))?|twitter:player:stream)["'][^>]*content=["']([^"']+)["']/gi;
    while ((m = metaVideoRe.exec(html)) !== null) {
        push(unescapeInstagramJsonUrl(m[1]), true, m.index);
    }
    const metaVideoReRev = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?:\.(?:secure_url|url))?|twitter:player:stream)["']/gi;
    while ((m = metaVideoReRev.exec(html)) !== null) {
        push(unescapeInstagramJsonUrl(m[1]), true, m.index);
    }
    const metaImageRe = /<meta[^>]+(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["']/gi;
    while ((m = metaImageRe.exec(html)) !== null) {
        push(unescapeInstagramJsonUrl(m[1]), false, m.index);
    }
    const metaImageReRev = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/gi;
    while ((m = metaImageReRev.exec(html)) !== null) {
        push(unescapeInstagramJsonUrl(m[1]), false, m.index);
    }

    ordered.sort((a, b) => a.index - b.index);
    return ordered.map(o => ({ url: o.url, isVideo: o.isVideo }));
}

function getShortcodeFromUrl(url) {
    const m = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([^/?#&]+)/i);
    return m ? m[1] : null;
}

// Authenticated GraphQL query for a post/reel. Uses the same endpoint and doc_id
// as the instagram-url-direct library. Tries an UNAUTHENTICATED request with a
// fresh CSRF token FIRST (Instagram now returns an empty xdt_shortcode_media when
// session cookies are attached to /graphql/query), then falls back to the
// authenticated request with the session cookies. Returns an ordered array of
// { url, isVideo } (full carousel) or null. Ported from robot-joe.
async function fetchInstagramGraphQLMedia(shortcode, cookieHeader, browserUa) {
    const sessionCsrftoken = getCsrftokenFromCookieHeader(cookieHeader);
    const freshCsrf = await fetchFreshCsrfToken(browserUa);
    if (!freshCsrf && !sessionCsrftoken) {
        console.log('[Instagram Interceptor] GraphQL scrape skipped: no csrftoken available.');
        return null;
    }
    const variables = JSON.stringify({
        shortcode,
        fetch_tagged_user_count: null,
        hoisted_comment_id: null,
        hoisted_reply_id: null
    });
    const body = `variables=${encodeURIComponent(variables)}&doc_id=9510064595728286`;
    const variants = [];
    if (freshCsrf) {
        variants.push({ csrf: freshCsrf, cookie: null, label: 'fresh-CSRF (unauthenticated)' });
    }
    if (sessionCsrftoken && cookieHeader) {
        variants.push({ csrf: sessionCsrftoken, cookie: cookieHeader, label: 'session-cookie (authenticated)' });
    }
    const MAX_ATTEMPTS = 2;
    for (const variant of variants) {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const headers = {
                    'User-Agent': browserUa,
                    'X-CSRFToken': variant.csrf,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': '*/*',
                    'Referer': `https://www.instagram.com/p/${shortcode}/`,
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin'
                };
                if (variant.cookie) {
                    headers['Cookie'] = variant.cookie;
                    headers['X-IG-App-ID'] = '936619743392459';
                }
                const resp = await axios.post('https://www.instagram.com/graphql/query', body, {
                    timeout: 15000,
                    maxRedirects: 0,
                    headers
                });
                const media = resp.data && resp.data.data && resp.data.data.xdt_shortcode_media;
                if (!media) {
                    console.log(`[Instagram Interceptor] GraphQL scrape (${variant.label}) returned no xdt_shortcode_media (attempt ${attempt}/${MAX_ATTEMPTS}).`);
                    if (attempt < MAX_ATTEMPTS) {
                        await new Promise((r) => setTimeout(r, 800));
                        continue;
                    }
                    break;
                }
                console.log(`[Instagram Interceptor] GraphQL scrape (${variant.label}) resolved media.`);
                const ordered = [];
                let items = null;
                if (Array.isArray(media.carousel_media) && media.carousel_media.length > 0) {
                    items = media.carousel_media;
                } else if (media.edge_sidecar_to_children && Array.isArray(media.edge_sidecar_to_children.edges)) {
                    items = media.edge_sidecar_to_children.edges.map(e => e && e.node).filter(Boolean);
                }
                if (!items) items = [media];
                for (const item of items) {
                    const videoUrl = pickBestVideoVersion(item.video_versions) ||
                        (item.video_url ? unescapeInstagramJsonUrl(item.video_url) : null);
                    const imageUrl = pickBestImageCandidate(item.image_versions2 && item.image_versions2.candidates) ||
                        pickBestDisplayResource(item.display_resources) ||
                        pickBestDisplayResource(item.thumbnail_resources) ||
                        (item.display_url ? unescapeInstagramJsonUrl(item.display_url) : null);
                    const chosen = videoUrl || imageUrl;
                    if (chosen) {
                        ordered.push({ url: unescapeInstagramJsonUrl(chosen), isVideo: !!videoUrl });
                    }
                }
                return ordered.length > 0 ? ordered : null;
            } catch (err) {
                console.error(`[Instagram Interceptor] GraphQL scrape (${variant.label}) failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, err.message);
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise((r) => setTimeout(r, 800));
                    continue;
                }
                break;
            }
        }
    }
    return null;
}

// Direct authenticated scrape of the Instagram post/reel page using session
// cookies. This is the reliable path for image-only / carousel posts that yt-dlp
// and the unauthenticated scrapers fail on. Returns AttachmentBuilder[] or null.
// Ported from robot-joe.
async function downloadWithDirectInstagram(instagramUrl) {
    const cookieHeader = buildInstagramCookieHeader();
    if (!cookieHeader) {
        console.log('[Instagram Interceptor] Direct scrape skipped: no Instagram cookies available.');
        return null;
    }

    const canonicalUrl = instagramUrl.replace(/(www\.)?(?:dd|kk|ee|uu|rx)instagram\.com/i, 'instagram.com');
    console.log(`[Instagram Interceptor] Attempting direct authenticated scrape: ${canonicalUrl}`);

    const isReelOrTv = /\/(?:reels?|tv)\//i.test(canonicalUrl);
    const shortcode = getShortcodeFromUrl(canonicalUrl);

    // 1. Preferred: GraphQL query — returns structured, full-carousel data.
    let ordered = [];
    if (shortcode) {
        const gqlMedia = await fetchInstagramGraphQLMedia(shortcode, cookieHeader, INSTAGRAM_BROWSER_UA);
        if (gqlMedia && gqlMedia.length > 0) {
            ordered = gqlMedia;
            console.log(`[Instagram Interceptor] GraphQL scrape resolved ${ordered.length} media item(s).`);
        }
    }

    // 2. Fallback: scrape the post HTML and parse embedded media.
    if (ordered.length === 0) {
        let html;
        try {
            const response = await axios.get(canonicalUrl, {
                timeout: 15000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': INSTAGRAM_BROWSER_UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Cookie': cookieHeader,
                    'X-IG-App-ID': '936619743392459',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Upgrade-Insecure-Requests': '1'
                }
            });
            html = response.data;
        } catch (err) {
            console.error('[Instagram Interceptor] Direct scrape HTML fetch failed:', err.message);
        }

        if (html && typeof html === 'string') {
            if (html.includes('"showLoginForm"') || html.includes('"loginForm"') ||
                /<title[^>]*>\s*Login/i.test(html) || /accounts\/login/i.test(html)) {
                console.log('[Instagram Interceptor] Direct scrape hit a login wall. Cookies may be invalid for this request.');
            }
            const extracted = extractInstagramMediaFromHtml(html, shortcode);
            if (extracted.length > 0) {
                ordered = extracted;
                console.log(`[Instagram Interceptor] HTML scrape resolved ${ordered.length} media item(s).`);
            }
        }
    }

    if (ordered.length === 0) {
        console.log('[Instagram Interceptor] Direct scrape found no media URLs.');
        return null;
    }

    // For Reels/TV we only want a real video; keep only the first video in
    // document order (the target reel appears before preloaded feed content).
    let finalOrdered;
    if (isReelOrTv) {
        const vids = ordered.filter(o => o.isVideo);
        finalOrdered = vids.length > 0 ? vids.slice(0, 1) : ordered.slice(0, 1);
    } else {
        finalOrdered = ordered;
    }

    console.log(`[Instagram Interceptor] Direct scrape downloading ${finalOrdered.length} item(s) (videos=${finalOrdered.filter(o=>o.isVideo).length}, images=${finalOrdered.filter(o=>!o.isVideo).length}).`);

    const attachments = [];
    for (let i = 0; i < finalOrdered.length; i++) {
        const { url: mUrl, isVideo } = finalOrdered[i];
        const headerVariants = [
            {
                'User-Agent': INSTAGRAM_BROWSER_UA,
                'Accept': isVideo
                    ? 'video/webp,video/ogg,video/*;q=0.9,*/*;q=0.8'
                    : 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': canonicalUrl,
                'Sec-Fetch-Dest': isVideo ? 'video' : 'image',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'cross-site',
                'Range': 'bytes=0-'
            },
            {
                'User-Agent': INSTAGRAM_BROWSER_UA,
                'Accept': isVideo
                    ? 'video/webp,video/ogg,video/*;q=0.9,*/*;q=0.8'
                    : 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': canonicalUrl,
                'Cookie': cookieHeader,
                'Sec-Fetch-Dest': isVideo ? 'video' : 'image',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'cross-site',
                'Range': 'bytes=0-'
            }
        ];

        let response = null;
        let lastErr = null;
        for (const hdrs of headerVariants) {
            try {
                response = await axios.get(mUrl, {
                    responseType: 'arraybuffer',
                    timeout: 20000,
                    maxRedirects: 5,
                    headers: hdrs
                });
                break;
            } catch (dlErr) {
                lastErr = dlErr;
                const status = dlErr.response && dlErr.response.status;
                if (status !== 403 && status !== 401) break;
            }
        }
        if (!response) {
            console.error(`[Instagram Interceptor] Direct scrape failed to download item ${i}:`, lastErr ? lastErr.message : 'unknown error');
            continue;
        }
        try {
            const buffer = Buffer.from(response.data);
            const contentType = response.headers['content-type'] || '';
            let ext = detectFileType(buffer) || (isVideo ? 'mp4' : 'jpg');
            if (contentType.includes('video/mp4')) ext = 'mp4';
            else if (contentType.includes('video/')) ext = 'mp4';
            else if (contentType.includes('image/png')) ext = 'png';
            else if (contentType.includes('image/gif')) ext = 'gif';
            else if (contentType.includes('image/webp')) ext = 'webp';
            else if (contentType.includes('image/')) ext = 'jpg';
            attachments.push(new AttachmentBuilder(buffer, { name: `instagram_media_${i}.${ext}` }));
        } catch (dlErr) {
            console.error(`[Instagram Interceptor] Direct scrape failed to process item ${i}:`, dlErr.message);
        }
    }

    if (attachments.length === 0) {
        return null;
    }

    if (isReelOrTv && !attachments.some(a => (a.name || '').match(/\.(mp4|webm|mov)$/i))) {
        console.log('[Instagram Interceptor] Direct scrape resolved only images for a Reel/TV. Marking as restricted fallback.');
        attachments.isRestrictedVideoFallback = true;
    }

    return attachments;
}

// --- Instagram profile parsing ---
// A profile URL is instagram.com/<username> (optionally with ?igsh=... query),
// with NO /p/, /reel/, /reels/, /tv/, /explore/, /accounts/, /stories/ segment.
// When detected, the bot fetches the profile HTML, extracts the user's display
// name, bio/description, profile picture (og:image), and the last few posts'
// thumbnail URLs (from the embedded timeline JSON), then reposts them as a card
// with the userpic attached and the bio quoted. Returns true if it handled the
// URL (so handleInstagramMessage can early-return), false otherwise.
function isInstagramProfileUrl(url) {
    const clean = url.replace(/[?#].*$/, '');
    // Must be instagram.com/<something> but NOT a known non-profile path.
    if (!/instagram\.com\/[^/?#]+/i.test(clean)) return false;
    if (/instagram\.com\/(?:p|reel|reels|tv|explore|accounts|stories|directory|about|developer|legal|help|press|api|oauth|login|signup|emails|captured|embed\.html|query)\b/i.test(clean)) return false;
    // Strip the leading host; whatever remains is the username (single path segment).
    const afterHost = clean.replace(/^https?:\/\/(?:www\.)?(?:dd|kk|ee|uu|rx)?instagram\.com\//i, '');
    const username = afterHost.split('/')[0];
    return !!username && !username.startsWith('.');
}

// Decode common HTML entities (for og:title / og:description values).
function decodeEntities(s) {
    if (!s) return '';
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

// Clean the og:title value from an Instagram profile page.
// og:title is typically "Display Name (@handle) • Instagram photos and videos".
// Strip the trailing suffix and the parenthesized handle, returning just the
// display name.
function cleanInstagramOgTitle(title) {
    if (!title) return '';
    let cleaned = title;
    cleaned = cleaned.replace(/\s*[•·]\s*Instagram\s+photos\s+and\s+videos\s*$/i, '');
    cleaned = cleaned.replace(/\s*[•·]\s*Instagram.*$/i, '');
    cleaned = cleaned.replace(/\s*\(@[^)]+\)\s*$/, '');
    return cleaned.trim();
}

// Unescape an Instagram JSON-embedded URL (\\u0026 -> &, \/ -> /, etc.).
function unescapeJsonUrl(url) {
    if (!url) return url;
    return url
        .replace(/\\u0026/g, '&')
        .replace(/\\u0025/g, '%')
        .replace(/\\\//g, '/')
        .replace(/\\\\/g, '\\')
        .replace(/&amp;/g, '&');
}

// Extract the last N post thumbnail URLs from the profile HTML's embedded
// timeline JSON. Instagram embeds `edge_owner_to_timeline_media` (web schema) or
// `timeline_media` (private API) with each node's `thumbnail_src` / `display_url`.
// Returns an array of { url, shortcode } (best-quality thumbnail per post).
function extractRecentPostsFromProfileHtml(html, maxPosts = 4) {
    const posts = [];
    const seen = new Set();
    // Web schema: "edge_owner_to_timeline_media":{... "edges":[{"node":{"shortcode":"...","display_url":"..."...}}]}
    // Try to locate the timeline media block and walk its edges.
    const blockRe = /"(?:edge_owner_to_timeline_media|timeline_media|edge_web_feed_timeline)"\s*:\s*\{/g;
    let m;
    while ((m = blockRe.exec(html)) !== null) {
        // Scan forward to capture the node entries. Each node has a shortcode + display_url/thumbnail_src.
        const windowStart = m.index;
        const window = html.slice(windowStart, windowStart + 200000);
        const nodeRe = /"(?:shortcode|code)"\s*:\s*"([^"]+)"[^}]*?"(?:display_url|thumbnail_src)"\s*:\s*"([^"]+)"/g;
        let nm;
        while ((nm = nodeRe.exec(window)) !== null && posts.length < maxPosts) {
            const shortcode = nm[1];
            const url = unescapeJsonUrl(nm[2]);
            if (!shortcode || !url || seen.has(shortcode)) continue;
            seen.add(shortcode);
            posts.push({ url, shortcode });
        }
        if (posts.length > 0) break;
    }
    // Fallback: collect display_url/thumbnail_src values near shortcodes in the
    // whole document (order preserved). This catches the private-API schema where
    // the timeline is a flat array of media objects.
    if (posts.length === 0) {
        const fallbackRe = /"shortcode"\s*:\s*"([^"]+)"[\s\S]{0,800}?"(?:display_url|thumbnail_src)"\s*:\s*"([^"]+)"/g;
        let fm;
        while ((fm = fallbackRe.exec(html)) !== null && posts.length < maxPosts) {
            const shortcode = fm[1];
            const url = unescapeJsonUrl(fm[2]);
            if (!shortcode || !url || seen.has(shortcode)) continue;
            seen.add(shortcode);
            posts.push({ url, shortcode });
        }
    }
    return posts;
}

// Walk a parsed GraphQL timeline media block (edge_owner_to_timeline_media or
// the private-API timeline_media) and return up to maxPosts { shortcode, thumbnailUrl }.
function collectPostsFromTimelineMedia(media, maxPosts) {
    const posts = [];
    if (!media || typeof media !== 'object') return posts;
    let edges = null;
    if (media.edges && Array.isArray(media.edges)) {
        edges = media.edges;
    } else if (Array.isArray(media.nodes)) {
        edges = media.nodes;
    }
    if (!edges) return posts;
    for (const edge of edges) {
        if (posts.length >= maxPosts) break;
        const node = edge && edge.node ? edge.node : edge;
        if (!node) continue;
        const shortcode = node.shortcode || node.code || null;
        const thumb = node.thumbnail_src || (node.display_resources && pickBestDisplayResource(node.display_resources))
            || node.display_url || (node.thumbnail_resources && pickBestDisplayResource(node.thumbnail_resources)) || null;
        if (shortcode && thumb) {
            posts.push({ shortcode, thumbnailUrl: unescapeJsonUrl(thumb) });
        }
    }
    return posts;
}

// Pick the highest-resolution entry from `display_resources` / `thumbnail_resources`
// (web GraphQL schema: array of {src, config_width, config_height}). The largest
// entry is the full-resolution original.
function pickBestDisplayResource(resources) {
    if (!Array.isArray(resources) || resources.length === 0) return null;
    let best = null, bestW = -1;
    for (const r of resources) {
        if (!r) continue;
        const w = r.config_width || r.width || 0;
        const url = r.src || r.url;
        if (url && w > bestW) { best = url; bestW = w; }
    }
    return best;
}

// Authenticated GraphQL profile query. Instagram's web app fetches the profile
// page via /graphql/query with a persisted-query doc_id. This returns the user's
// display name, bio, follower/following/post counts, profile picture URL, and the
// recent timeline posts (with shortcodes + thumbnail URLs) as structured JSON —
// far more reliable than scraping og: tags from a login-walled HTML page.
//
// Uses Instagram's web REST endpoint `/api/v1/users/web_profile_info/` (NOT the
// GraphQL persisted-query endpoint — the ProfilePage doc_id rotates and is
// unreliable). This REST endpoint returns the full profile JSON including
// `edge_owner_to_timeline_media` (recent posts). It requires an `X-IG-App-ID`
// header and a csrftoken. Tries:
//   1. session-cookie authenticated (works for all profiles, requires cookies.txt)
//   2. fresh-CSRF unauthenticated (sometimes works for public profiles)
// Returns { user, posts } or null.
async function fetchInstagramGraphQLProfile(username, cookieHeader, browserUa) {
    const sessionCsrftoken = getCsrftokenFromCookieHeader(cookieHeader);
    const freshCsrf = await fetchFreshCsrfToken(browserUa);
    if (!freshCsrf && !sessionCsrftoken) {
        console.log('[Instagram Interceptor] Profile fetch skipped: no csrftoken available.');
        return null;
    }
    const apiUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    // Try session-cookie authenticated FIRST (the REST endpoint requires cookies
    // for most profiles), then fresh-CSRF unauthenticated as a fallback.
    const variants = [];
    if (sessionCsrftoken && cookieHeader) {
        variants.push({ csrf: sessionCsrftoken, cookie: cookieHeader, label: 'session-cookie (authenticated)' });
    }
    if (freshCsrf) {
        variants.push({ csrf: freshCsrf, cookie: null, label: 'fresh-CSRF (unauthenticated)' });
    }
    const MAX_ATTEMPTS = 2;
    for (const variant of variants) {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const headers = {
                    'User-Agent': browserUa,
                    'X-IG-App-ID': '936619743392459',
                    'X-CSRFToken': variant.csrf,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': '*/*',
                    'Referer': `https://www.instagram.com/${username}/`,
                    'Sec-Fetch-Dest': 'empty',
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin'
                };
                if (variant.cookie) {
                    headers['Cookie'] = variant.cookie;
                }
                const resp = await axios.get(apiUrl, {
                    timeout: 15000,
                    maxRedirects: 0,
                    headers
                });
                const user = resp.data && resp.data.data && resp.data.data.user;
                if (!user) {
                    console.log(`[Instagram Interceptor] Profile REST (${variant.label}) returned no user object (attempt ${attempt}/${MAX_ATTEMPTS}).`);
                    if (attempt < MAX_ATTEMPTS) {
                        await new Promise((r) => setTimeout(r, 3000));
                        continue;
                    }
                    break;
                }
                // Extract the timeline media (recent posts).
                const timelineMedia = user.edge_owner_to_timeline_media
                    || user.timeline_media
                    || (user.edge_web_feed_timeline)
                    || null;
                const posts = collectPostsFromTimelineMedia(timelineMedia, 4);
                // Extract profile fields.
                const fullName = user.full_name || user.name || '';
                const bio = user.biography || user.bio || '';
                const profilePicUrl = user.profile_pic_url_hd || user.profile_pic_url || (user.hd_profile_pic_url_info && user.hd_profile_pic_url_info.uri) || null;
                const followerCount = user.edge_followed_by ? user.edge_followed_by.count : (user.follower_count || null);
                const followingCount = user.edge_follow ? user.edge_follow.count : (user.following_count || null);
                const postCount = timelineMedia ? (timelineMedia.count != null ? timelineMedia.count : null) : (user.media_count || null);
                console.log(`[Instagram Interceptor] Profile REST (${variant.label}) resolved: name="${fullName}", posts=${posts.length}, hasPic=${!!profilePicUrl}`);
                return {
                    user: {
                        fullName: fullName || '',
                        bio: bio || '',
                        profilePicUrl: profilePicUrl || null,
                        followerCount,
                        followingCount,
                        postCount
                    },
                    posts
                };
            } catch (err) {
                const status = err.response && err.response.status;
                console.error(`[Instagram Interceptor] Profile REST (${variant.label}) failed (attempt ${attempt}/${MAX_ATTEMPTS}):`, err.message);
                // On 429 (rate-limited), wait and retry before moving to the next variant.
                if (status === 429 && attempt < MAX_ATTEMPTS) {
                    await new Promise((r) => setTimeout(r, 3000));
                    continue;
                }
                break;
            }
        }
    }
    return null;
}

async function handleInstagramProfile(client, message, profileUrl, remadeContent) {
    console.log(`[Instagram Interceptor] Profile URL detected: ${profileUrl}`);
    const placeholder = await sendWorkingPlaceholder(client, message, profileUrl);
    if (message.guild) {
        await message.delete().catch(() => {});
    }

    await message.channel.sendTyping().catch(() => { });
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => { });
    }, RAG_TYPING_INTERVAL);

    try {
        await updatePlaceholderStage(placeholder, `working... <${profileUrl}>\nstage: fetching profile`);
        // Normalize to canonical instagram.com (strip mirror prefix + query for the fetch).
        const canonicalUrl = profileUrl
            .replace(/(www\.)?(?:dd|kk|ee|uu|rx)instagram\.com/i, 'instagram.com')
            .replace(/[?#].*$/, '');
        const usernameMatch = canonicalUrl.match(/instagram\.com\/([^/?#]+)/i);
        const username = usernameMatch ? usernameMatch[1] : '';
        const profileLink = `https://www.instagram.com/${username}/`;

        // --- Strategy 1: GraphQL profile query (cookie-aware, structured JSON) ---
        const cookieHeader = buildInstagramCookieHeader();
        const gqlResult = await fetchInstagramGraphQLProfile(username, cookieHeader, INSTAGRAM_BROWSER_UA);

        let displayName = '';
        let description = '';
        let profilePicUrl = null;
        let recentPosts = [];

        if (gqlResult) {
            displayName = gqlResult.user.fullName;
            // Only the bio — no follower/following/post counts (the user doesn't
            // want those in the card).
            description = gqlResult.user.bio || '';
            profilePicUrl = gqlResult.user.profilePicUrl;
            recentPosts = gqlResult.posts.map(p => ({ url: p.thumbnailUrl, shortcode: p.shortcode }));
        } else {
            // --- Strategy 2: authenticated HTML profile scrape (fallback) ---
            // Used when the GraphQL doc_id has rotated or the query returns no user.
            // Fetches the profile page HTML WITH session cookies so Instagram doesn't
            // serve a login wall, then extracts og: tags + embedded timeline JSON.
            console.log('[Instagram Interceptor] GraphQL profile failed; falling back to authenticated HTML scrape.');
            const fetchHeaders = {
                'User-Agent': INSTAGRAM_BROWSER_UA,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Upgrade-Insecure-Requests': '1'
            };
            if (cookieHeader) {
                fetchHeaders['Cookie'] = cookieHeader;
                fetchHeaders['X-IG-App-ID'] = '936619743392459';
            }
            let html = null;
            try {
                const response = await axios.get(canonicalUrl, {
                    timeout: 15000,
                    maxRedirects: 5,
                    headers: fetchHeaders
                });
                html = response.data;
            } catch (fetchErr) {
                console.error('[Instagram Interceptor] Profile HTML fetch failed:', fetchErr.message);
            }

            if (html && typeof html === 'string') {
                if (html.includes('"showLoginForm"') || html.includes('"loginForm"') ||
                    /<title[^>]*>\s*Login/i.test(html) || /accounts\/login/i.test(html)) {
                    console.log('[Instagram Interceptor] Profile HTML scrape hit a login wall. Cookies may be invalid or missing.');
                }
                const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
                    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
                const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
                    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
                const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
                    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
                // og:title is typically "Display Name (@handle) • Instagram photos and videos".
                // Strip the trailing suffix and parenthesized handle.
                let rawTitle = ogTitleMatch ? decodeEntities(ogTitleMatch[1]).trim() : '';
                displayName = cleanInstagramOgTitle(rawTitle);
                description = ogDescMatch ? decodeEntities(ogDescMatch[1]).trim() : '';
                // Strip the follower/following/post counts + the "See Instagram
                // photos and videos from Name (@handle)" suffix from og:description
                // so only the bio remains (if any). For profiles with no bio the
                // og:description is just the counts + suffix, which we strip entirely.
                description = description
                    .replace(/^\d+\s*Followers,\s*\d+\s*Following,\s*\d+\s*Posts\s*-\s*See Instagram photos and videos from\s*/i, '')
                    .replace(/\s*-\s*See Instagram photos and videos from\s+.*/i, '')
                    .trim();
                // og:image is the TARGET profile's pic (server-rendered meta tag).
                // The embedded JSON profile_pic_url_hd is the LOGGED-IN viewer's pic
                // (when cookies are attached), NOT the target's — so prefer og:image.
                // The og:image URL contains &amp; entities that must be decoded before
                // downloading (undecoded &amp; → 403).
                if (ogImageMatch) {
                    profilePicUrl = ogImageMatch[1].replace(/&amp;/g, '&').trim();
                } else {
                    const hdPicMatch = html.match(/"profile_pic_url_hd"\s*:\s*"([^"]+)"/);
                    const picMatch = html.match(/"profile_pic_url"\s*:\s*"([^"]+)"/);
                    if (hdPicMatch) {
                        profilePicUrl = unescapeInstagramJsonUrl(hdPicMatch[1]);
                    } else if (picMatch) {
                        profilePicUrl = unescapeInstagramJsonUrl(picMatch[1]);
                    }
                }
                recentPosts = extractRecentPostsFromProfileHtml(html, 4);
            }
        }

        console.log(`[Instagram Interceptor] Profile: name="${displayName}", posts=${recentPosts.length}, hasPic=${!!profilePicUrl}`);

        // If we got nothing useful at all (no name, no pic, no posts), the profile is
        // likely private and cookies are missing/invalid. Post a clean link instead
        // of a broken card — but still tell the user cookies are needed.
        if (!displayName && !profilePicUrl && recentPosts.length === 0) {
            console.log('[Instagram Interceptor] Profile yielded no data (likely private + no cookies). Posting link fallback.');
            const fallbackUrl = profileLink.replace(/^https?:\/\//i, '');
            const fallbackContent = (remadeContent && remadeContent.replace(profileUrl, ' ').replace(/\s+/g, ' ').trim().length >= 2
                ? remadeContent.replace(profileUrl, ' ').replace(/\s+/g, ' ').trim() + '\n\n' : '')
                + `[${fallbackUrl}](${profileLink})`;
            await updateWorkingPlaceholder(placeholder, fallbackContent, [], false, 0, fallbackContent);
            return;
        }

        // Download the profile picture (if available) to attach it.
        let attachments = [];
        if (profilePicUrl) {
            try {
                // Instagram CDN rejects cookie-less requests for some profile
                // pics (403). Try with Referer + Cookie headers first, fall back
                // to a cookie-less request.
                const picHeaderVariants = [
                    { 'User-Agent': INSTAGRAM_BROWSER_UA, 'Referer': canonicalUrl, 'Accept': 'image/*,*/*;q=0.8' },
                    { 'User-Agent': INSTAGRAM_BROWSER_UA, 'Referer': canonicalUrl, 'Accept': 'image/*,*/*;q=0.8', 'Cookie': cookieHeader || '' },
                ];
                let picRes = null;
                let picErr = null;
                for (const hdrs of picHeaderVariants) {
                    try {
                        picRes = await axios.get(profilePicUrl, {
                            responseType: 'arraybuffer',
                            timeout: 15000,
                            headers: hdrs
                        });
                        break;
                    } catch (e) {
                        picErr = e;
                        const status = e.response && e.response.status;
                        if (status !== 403 && status !== 401) break;
                    }
                }
                if (!picRes) throw picErr;
                const buffer = Buffer.from(picRes.data);
                const contentType = picRes.headers['content-type'] || '';
                let ext = detectFileType(buffer) || 'jpg';
                if (contentType.includes('image/png')) ext = 'png';
                else if (contentType.includes('image/webp')) ext = 'webp';
                else if (contentType.includes('image/gif')) ext = 'gif';
                attachments.push(new AttachmentBuilder(buffer, { name: `profile_pic.${ext}` }));
            } catch (picErr) {
                console.error('[Instagram Interceptor] Failed to download profile pic:', picErr.message);
            }
        }

        // Download up to 4 recent post thumbnails and attach them.
        for (let i = 0; i < recentPosts.length && attachments.length < 5; i++) {
            const post = recentPosts[i];
            try {
                const postRes = await axios.get(post.url, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    headers: { 'User-Agent': INSTAGRAM_BROWSER_UA }
                });
                const buffer = Buffer.from(postRes.data);
                const contentType = postRes.headers['content-type'] || '';
                let ext = detectFileType(buffer) || 'jpg';
                if (contentType.includes('image/png')) ext = 'png';
                else if (contentType.includes('image/webp')) ext = 'webp';
                else if (contentType.includes('image/gif')) ext = 'gif';
                attachments.push(new AttachmentBuilder(buffer, { name: `post_${i + 1}.${ext}` }));
            } catch (postErr) {
                console.error(`[Instagram Interceptor] Failed to download post ${i + 1} thumbnail:`, postErr.message);
            }
        }

        // Build the profile card text.
        // The original link is preserved at the TOP (with the user's text if any),
        // followed by the profile name + bio. Follower/following/post counts are
        // NOT included. The profile pic + last 4 post thumbnails are attached as
        // image previews (downloaded above).
        const parts = [];
        let userComment = '';
        if (remadeContent) {
            userComment = remadeContent.replace(profileUrl, ' ').replace(/\s+/g, ' ').trim();
            if (userComment.length < 2) userComment = '';
        }
        // Original link at the top (preserved with user's text).
        const linkLine = userComment ? `${userComment} <${profileLink}>` : `<${profileLink}>`;
        parts.push(linkLine);
        if (displayName) {
            parts.push(`**${displayName}**${username ? ` (@${username})` : ''}`);
        } else if (username) {
            parts.push(`**@${username}**`);
        }
        if (description) {
            const descLines = description.split('\n').filter(l => l.trim());
            for (const line of descLines) {
                parts.push(`> ${line}`);
            }
        }

        const finalContent = parts.join('\n\n').substring(0, 2000);

        if (attachments.length > 0) {
            await updateWorkingPlaceholder(placeholder, finalContent, attachments, true, getGuildFileLimit(message.guild), `<${profileLink}>`);
        } else {
            const fallbackUrl = profileLink.replace(/^https?:\/\//i, '');
            const fallbackContent = (userComment ? userComment + '\n\n' : '') + `[${fallbackUrl}](${profileLink})`;
            await updateWorkingPlaceholder(placeholder, fallbackContent, [], false, 0, fallbackContent);
        }
    } catch (err) {
        console.error('[Instagram Interceptor] Profile handler error:', err.message);
        const canonicalUrl = profileUrl.replace(/(www\.)?(?:dd|kk|ee|uu|rx)instagram\.com/i, 'instagram.com');
        const fallbackUrl = canonicalUrl.replace(/^https?:\/\//i, '');
        await updateWorkingPlaceholder(placeholder, `[${fallbackUrl}](${canonicalUrl})`, [], false, 0, `[${fallbackUrl}](${canonicalUrl})`).catch(() => {});
    } finally {
        clearInterval(typingInterval);
    }
}

// Format a count (e.g. 1234 -> "1,234", 1200000 -> "1,200,000") for the bio line.
function formatCount(n) {
    if (n == null) return '';
    return Number(n).toLocaleString('en-US');
}

async function downloadWithYtDlp(url) {
    const ytDlp = findYtDlpPath();
    const tempDir = os.tmpdir();
    const prefix = `insta_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const outputPattern = path.join(tempDir, `${prefix}.%(ext)s`);

    // Detect if cookies.txt or instagram-cookies.txt exists
    let cookiesFlag = '';
    const pathsToCheck = [
        path.join(process.cwd(), 'instagram-cookies.txt'),
        path.join(process.cwd(), 'cookies.txt'),
        path.join(process.cwd(), 'data', 'instagram-cookies.txt'),
        path.join(process.cwd(), 'data', 'cookies.txt'),
        path.join(__dirname, '../../instagram-cookies.txt'),
        path.join(__dirname, '../../cookies.txt'),
        path.join(__dirname, '../../data/instagram-cookies.txt'),
        path.join(__dirname, '../../data/cookies.txt'),
        '/usr/src/app/instagram-cookies.txt',
        '/usr/src/app/cookies.txt',
        '/usr/src/app/data/instagram-cookies.txt',
        '/usr/src/app/data/cookies.txt',
        '/tmp/instagram-cookies.txt',
        '/tmp/cookies.txt'
    ];

    let found = false;
    for (const p of pathsToCheck) {
        if (fs.existsSync(p)) {
            console.log(`[Instagram Interceptor] Found cookies file: ${p}. Passing to yt-dlp.`);
            cookiesFlag = `--cookies "${p}"`;
            found = true;
            break;
        }
    }

    if (!found) {
        console.log(`[Instagram Interceptor] WARNING: No cookies file found for yt-dlp auth. Checked: \n- ${pathsToCheck.join('\n- ')}`);
    }

    console.log(`[Instagram Interceptor] Attempting yt-dlp download for: ${url}`);
    const cmd = `"${ytDlp}" ${cookiesFlag} --no-playlist --merge-output-format mp4 -o "${outputPattern}" "${url}"`;

    try {
        await runCommand(cmd, 30000); // 30s timeout

        const files = fs.readdirSync(tempDir);
        const matchingFiles = files.filter(f => f.startsWith(prefix));

        if (matchingFiles.length === 0) {
            console.log('[Instagram Interceptor] yt-dlp completed but no files were found.');
            return null;
        }

        const attachments = [];
        for (const file of matchingFiles) {
            const filePath = path.join(tempDir, file);

            const buffer = fs.readFileSync(filePath);
            try { fs.unlinkSync(filePath); } catch (e) {}

            const ext = path.extname(file).substring(1) || 'mp4';
            attachments.push(new AttachmentBuilder(buffer, { name: `instagram_media_${attachments.length}.${ext}` }));
        }

        return attachments.length > 0 ? attachments : null;
    } catch (err) {
        console.error('[Instagram Interceptor] yt-dlp download failed:', err.message);
        if (err.stderr) {
            console.error('[Instagram Interceptor] yt-dlp stderr:', err.stderr.trim());
        }
        if (err.stdout) {
            console.log('[Instagram Interceptor] yt-dlp stdout:', err.stdout.trim());
        }
        // Clean up any partially downloaded files
        try {
            const files = fs.readdirSync(tempDir);
            for (const file of files) {
                if (file.startsWith(prefix)) {
                    fs.unlinkSync(path.join(tempDir, file));
                }
            }
        } catch (cleanupErr) {
            console.error('[Instagram Interceptor] Failed to clean up temp files:', cleanupErr.message);
        }
        return null;
    }
}

function raceToBestSuccess(promises) {
    return new Promise((resolve) => {
        let completedCount = 0;
        let resolved = false;
        let fallbackRes = null;

        if (promises.length === 0) {
            resolve(null);
            return;
        }

        promises.forEach(p => {
            Promise.resolve(p).then(res => {
                completedCount++;
                if (res && res.length > 0 && !resolved) {
                    if (res.isRestrictedVideoFallback) {
                        if (!fallbackRes) {
                            fallbackRes = res;
                        }
                    } else {
                        resolved = true;
                        resolve(res);
                        return;
                    }
                }
                if (completedCount === promises.length && !resolved) {
                    resolved = true;
                    resolve(fallbackRes || null);
                }
            }).catch(err => {
                completedCount++;
                if (completedCount === promises.length && !resolved) {
                    resolved = true;
                    resolve(fallbackRes || null);
                }
            });
        });
    });
}

async function downloadWithScrapers(downloadUrl) {
    let mediaUrls = [];

    // A. Try primary scraper (instagram-url-direct)
    try {
        console.log(`[Instagram Interceptor] Trying primary scraper for: ${downloadUrl}`);
        const scraperPromise = instagramGetUrl(downloadUrl);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Scraper timeout (10s)')), 10000)
        );
        const scrapeRes = await Promise.race([scraperPromise, timeoutPromise]);

        if (scrapeRes) {
            if (scrapeRes.url_list && Array.isArray(scrapeRes.url_list)) {
                mediaUrls = scrapeRes.url_list.map(item => typeof item === 'object' && item.url ? item.url : item);
            } else if (Array.isArray(scrapeRes)) {
                mediaUrls = scrapeRes.map(item => typeof item === 'object' && item.url ? item.url : item);
            } else if (typeof scrapeRes === 'object' && scrapeRes.url) {
                mediaUrls = [scrapeRes.url];
            } else if (typeof scrapeRes === 'string') {
                mediaUrls = [scrapeRes];
            }
        }
    } catch (err) {
        console.error('[Instagram Interceptor] Primary scraper failed:', err.message);
    }

    // B. Try fallback scraper (snapinsta) if primary scraper found nothing
    if (mediaUrls.length === 0) {
        try {
            console.log(`[Instagram Interceptor] Trying snapinsta fallback for: ${downloadUrl}`);
            const snapPromise = snapinsta.getLinks(downloadUrl);
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Snapinsta timeout (10s)')), 10000)
            );
            const scrapeRes = await Promise.race([snapPromise, timeoutPromise]);

            if (scrapeRes) {
                if (Array.isArray(scrapeRes)) {
                    mediaUrls = scrapeRes.map(item => typeof item === 'object' && item.url ? item.url : item);
                } else if (typeof scrapeRes === 'object' && scrapeRes.url) {
                    mediaUrls = [scrapeRes.url];
                } else if (typeof scrapeRes === 'string') {
                    mediaUrls = [scrapeRes];
                }
            }
        } catch (snapErr) {
            console.error('[Instagram Interceptor] Snapinsta fallback failed:', snapErr.message);
        }
    }

    // C. Download media from resolved URLs
    if (mediaUrls.length > 0) {
        console.log(`[Instagram Interceptor] Downloading ${mediaUrls.length} media items via scrapers...`);
        const attachments = [];
        for (let i = 0; i < mediaUrls.length; i++) {
            const mUrl = mediaUrls[i];
            if (!mUrl || typeof mUrl !== 'string') continue;

            try {
                const response = await axios.get(mUrl, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                const buffer = Buffer.from(response.data);
                const contentType = response.headers['content-type'] || '';
                let ext = 'jpg';
                if (contentType.includes('video/mp4')) ext = 'mp4';
                else if (contentType.includes('image/png')) ext = 'png';
                else if (contentType.includes('image/gif')) ext = 'gif';
                else if (contentType.includes('video/')) ext = 'mp4';
                else if (mUrl.includes('.mp4')) ext = 'mp4';

                attachments.push(new AttachmentBuilder(buffer, { name: `instagram_media_${i}.${ext}` }));
            } catch (dlErr) {
                console.error(`[Instagram Interceptor] Failed to download media item ${i}:`, dlErr.message);
            }
        }
        
        if (attachments.length > 0) {
            const isReelOrTv = /\/(?:reel|tv)\//i.test(downloadUrl);
            const hasVideo = attachments.some(att => att.name.endsWith('.mp4'));
            if (isReelOrTv && !hasVideo) {
                console.log(`[Instagram Interceptor] Scrapers resolved only images for a Reel/TV video. Marking as restricted fallback.`);
                attachments.isRestrictedVideoFallback = true;
            }
            return attachments;
        }
    }
    return null;
}

async function downloadWithFixer(instagramUrl, domain) {
    const fixerUrl = instagramUrl.replace(/(www\.)?(?:dd|kk|ee|uu|rx)?instagram\.com/, domain);
    console.log(`[Instagram Interceptor] Attempting prioritized ${domain} fetch: ${fixerUrl}`);
    try {
        const response = await axios.get(fixerUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
            },
            timeout: 5000 // 5s timeout
        });

        if (response.status !== 200) {
            throw new Error(`${domain} returned status ${response.status}`);
        }

        const html = response.data;
        if (html.includes('Post not found') || html.includes('Post not found (404)')) {
            console.log(`[Instagram Interceptor] ${domain} returned "Post not found" page.`);
            return null;
        }

        let mediaUrl = null;
        let isVideo = false;

        const videoMatch = html.match(/<meta [^>]*property="og:video(?::secure_url|:url)?"[^>]*content="([^"]+)"/) ||
                           html.match(/<meta [^>]*content="([^"]+)"[^>]*property="og:video(?::secure_url|:url)?"/) ||
                           html.match(/<meta [^>]*name="twitter:player:stream"[^>]*content="([^"]+)"/) ||
                           html.match(/<source[^>]+src="([^"]+)"[^>]*type="video\//) ||
                           html.match(/<video[^>]+src="([^"]+)"/);
        if (videoMatch) {
            mediaUrl = videoMatch[1];
            isVideo = true;
        } else {
            const imageMatch = html.match(/<meta [^>]*property="og:image"[^>]*content="([^"]+)"/) ||
                               html.match(/<meta [^>]*content="([^"]+)"[^>]*property="og:image"/);
            if (imageMatch) {
                mediaUrl = imageMatch[1];
            }
        }

        const isReelOrTv = /\/(?:reel|tv)\//i.test(instagramUrl);
        let isRestrictedVideoFallback = false;
        if (isReelOrTv && !isVideo && mediaUrl) {
            console.log(`[Instagram Interceptor] ${domain} resolved only an image for a Reel/TV video. Marking as restricted fallback.`);
            isRestrictedVideoFallback = true;
        } else if (isReelOrTv && !isVideo && !mediaUrl) {
            console.log(`[Instagram Interceptor] ${domain} found neither video nor image for this Reel.`);
        }

        if (!mediaUrl) {
            console.log(`[Instagram Interceptor] No og:video or og:image found in ${domain} response.`);
            return null;
        }

        if (mediaUrl.startsWith('/')) {
            mediaUrl = `https://${domain}${mediaUrl}`;
        }

        const cleanMediaUrl = mediaUrl.replace(/&amp;/g, '&');
        console.log(`[Instagram Interceptor] ${domain} resolved media URL: ${cleanMediaUrl}`);

        const mediaRes = await axios.get(cleanMediaUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const buffer = Buffer.from(mediaRes.data);

        const contentType = mediaRes.headers['content-type'] || '';
        let ext = 'jpg';
        if (isVideo) {
            ext = 'mp4';
        } else {
            if (contentType.includes('image/png')) ext = 'png';
            else if (contentType.includes('image/gif')) ext = 'gif';
            else if (contentType.includes('image/jpeg')) ext = 'jpg';
        }

        const attachments = [new AttachmentBuilder(buffer, { name: `instagram_media_0.${ext}` })];
        if (isRestrictedVideoFallback) {
            attachments.isRestrictedVideoFallback = true;
        }
        return attachments;
    } catch (err) {
        console.error(`[Instagram Interceptor] ${domain} downloader failed:`, err.message);
        return null;
    }
}

async function handleInstagramMessage(client, message, instagramUrl, remadeContent) {
    // Profile URLs (instagram.com/<username>) are handled by a dedicated profile
    // parser that returns the userpic, bio, and last 4 posts — NOT the media
    // download pipeline (which expects /p/, /reel/, or /tv/ and would mangle the
    // profile URL into a broken fallback link).
    if (isInstagramProfileUrl(instagramUrl)) {
        return handleInstagramProfile(client, message, instagramUrl, remadeContent);
    }

    // Instantly create the "working" message and delete the original message
    const placeholder = await sendWorkingPlaceholder(client, message, instagramUrl);
    if (message.guild) {
        await message.delete().catch(delErr => {
            console.error('[Instagram Interceptor] Failed to delete original message:', delErr.message);
        });
    }

    // Start typing indicator
    await message.channel.sendTyping().catch(() => { });
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => { });
    }, RAG_TYPING_INTERVAL);

    try {
    mediaQueue.enqueue(async () => {
        try {
            // Determine the file size limit for this guild
            const fileLimit = getGuildFileLimit(message.guild);
            console.log(`[Instagram Interceptor] Guild file limit: ${(fileLimit / 1024 / 1024).toFixed(0)}MB`);

            let downloadSuccess = false;
            let attachments = [];
            let chosenFixerDomain = 'kkinstagram.com';
            let lastRespondingDomain = null;
            let fallbackAttachments = null;

            const isFixer = /(?:dd|kk|ee|uu|rx)instagram\.com/.test(instagramUrl);
            const downloadUrl = isFixer ? instagramUrl.replace(/(www\.)?(dd|kk|ee|uu|rx)instagram\.com/, 'instagram.com') : instagramUrl;
            const isReelOrTv = /\/(?:reel|tv)\//i.test(downloadUrl);

            const runFixers = async () => {
                const domainsToTry = ['eeinstagram.com', 'kkinstagram.com', 'uuinstagram.com'];
                for (const domain of domainsToTry) {
                    try {
                        await updatePlaceholderStage(placeholder, `working... <${instagramUrl}>\nstage: ${domain} fast fetch`);
                        const fixerAttachments = await downloadWithFixer(downloadUrl, domain);
                        if (fixerAttachments && fixerAttachments.length > 0) {
                            lastRespondingDomain = domain;
                            if (fixerAttachments.isRestrictedVideoFallback) {
                                console.log(`[Instagram Interceptor] ${domain} resolved only restricted fallback for Reel/TV.`);
                                if (!fallbackAttachments) {
                                    fallbackAttachments = fixerAttachments;
                                    chosenFixerDomain = domain;
                                }
                            } else {
                                attachments = fixerAttachments;
                                chosenFixerDomain = domain;
                                downloadSuccess = true;
                                console.log(`[Instagram Interceptor] ${domain} successfully resolved and downloaded ${attachments.length} items`);
                                break;
                            }
                        }
                    } catch (fixerErr) {
                        console.error(`[Instagram Interceptor] ${domain} prioritized downloader failed:`, fixerErr.message);
                    }
                }
            };

            const runParallelScrapers = async () => {
                console.log(`[Instagram Interceptor] Trying parallel download options...`);
                await updatePlaceholderStage(placeholder, `working... <${instagramUrl}>\nstage: trying parallel scraper`);
                const timeoutPromise = new Promise((resolve) => {
                    setTimeout(() => {
                        console.log(`[Instagram Interceptor] Parallel scrapers timed out after 35s`);
                        resolve(null);
                    }, 35000);
                });

                const parallelResults = await Promise.race([
                    raceToBestSuccess([
                        downloadWithYtDlp(downloadUrl),
                        downloadWithScrapers(downloadUrl)
                    ]),
                    timeoutPromise
                ]);

                if (parallelResults && parallelResults.length > 0) {
                    if (parallelResults.isRestrictedVideoFallback) {
                        console.log(`[Instagram Interceptor] Parallel scrapers resolved only restricted fallback.`);
                        if (!fallbackAttachments) {
                            fallbackAttachments = parallelResults;
                        }
                    } else {
                        attachments = parallelResults;
                        downloadSuccess = true;
                        console.log(`[Instagram Interceptor] Successfully downloaded ${attachments.length} items using parallel strategy`);
                    }
                }
            };

            const hasCookies = !!buildInstagramCookieHeader();

            try {
                console.log(`[Instagram Interceptor] Instagram URL detected: ${instagramUrl} (downloading from ${downloadUrl})`);

                // 1. For Reels/TV: try fixers FIRST — they return properly-sized MP4s.
                if (isReelOrTv) {
                    await runFixers();
                }

                // 2. If fixers didn't succeed (not a Reel/TV, or fixers failed), try
                //    direct authenticated scrape (best for full slideshows + reels, requires cookies).
                if (!downloadSuccess && hasCookies) {
                    try {
                        await updatePlaceholderStage(placeholder, `working... <${instagramUrl}>\nstage: direct instagram scrape`);
                        const directAttachments = await downloadWithDirectInstagram(downloadUrl);
                        if (directAttachments && directAttachments.length > 0) {
                            if (directAttachments.isRestrictedVideoFallback) {
                                fallbackAttachments = directAttachments;
                                console.log(`[Instagram Interceptor] Direct scrape produced restricted fallback.`);
                            } else {
                                attachments = directAttachments;
                                downloadSuccess = true;
                                console.log(`[Instagram Interceptor] Direct scrape successfully downloaded ${attachments.length} item(s).`);
                            }
                        }
                    } catch (directErr) {
                        console.error('[Instagram Interceptor] Direct scrape failed, falling back:', directErr.message);
                    }
                }

                // 3. If still not successful, try the remaining strategy based on content type
                if (!downloadSuccess) {
                    if (isReelOrTv) {
                        console.log(`[Instagram Interceptor] Fixers failed or returned restricted fallback. Trying parallel scrapers...`);
                        await runParallelScrapers();
                    } else {
                        await runParallelScrapers();
                        if (!downloadSuccess) {
                            console.log(`[Instagram Interceptor] Parallel scrapers failed. Falling back to fixers...`);
                            await runFixers();
                        }
                    }
                }

                // 4. Final fallback: if direct scrape wasn't run because cookies were unavailable, try it as a last resort
                if (!downloadSuccess && !hasCookies) {
                    try {
                        await updatePlaceholderStage(placeholder, `working... <${instagramUrl}>\nstage: direct instagram scrape`);
                        const directAttachments = await downloadWithDirectInstagram(downloadUrl);
                        if (directAttachments && directAttachments.length > 0) {
                            if (directAttachments.isRestrictedVideoFallback) {
                                if (!fallbackAttachments) {
                                    fallbackAttachments = directAttachments;
                                    console.log(`[Instagram Interceptor] Direct scrape produced restricted fallback.`);
                                }
                            } else {
                                attachments = directAttachments;
                                downloadSuccess = true;
                                console.log(`[Instagram Interceptor] Direct scrape successfully downloaded ${attachments.length} item(s).`);
                            }
                        }
                    } catch (directErr) {
                        console.error('[Instagram Interceptor] Final fallback direct scrape failed:', directErr.message);
                    }
                }

                if (!downloadSuccess && fallbackAttachments) {
                    attachments = fallbackAttachments;
                    downloadSuccess = true;
                    console.log(`[Instagram Interceptor] Using restricted fallback attachments.`);
                }
            } catch (err) {
                console.error('[Instagram Interceptor] Scraping/Download failed:', err.message);
                downloadSuccess = false;
            }

            // --- Post-download: compress oversized videos with ffmpeg ---
            const effectiveFileLimit = Math.floor(fileLimit * FILE_SIZE_SAFETY_FACTOR);
            if (downloadSuccess && attachments.length > 0) {
                const needsCompression = attachments.some(att => {
                    const buf = att.attachment;
                    return buf && buf.length > effectiveFileLimit;
                });

                if (needsCompression) {
                    await updatePlaceholderStage(placeholder, `working... <${instagramUrl}>\nstage: compressing media (ffmpeg)`);
                    const compressedAttachments = [];
                    for (let i = 0; i < attachments.length; i++) {
                        const att = attachments[i];
                        const buf = att.attachment;
                        const name = att.name || `instagram_media_${i}`;
                        const isVideo = name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov');

                        if (buf && buf.length > effectiveFileLimit && isVideo) {
                            console.log(`[Instagram Interceptor] Attachment ${i} (${name}) is ${(buf.length / 1024 / 1024).toFixed(1)}MB, exceeds ${(effectiveFileLimit / 1024 / 1024).toFixed(1)}MB effective limit. Compressing...`);
                            const ext = path.extname(name).substring(1) || 'mp4';
                            
                            let lastUpdate = 0;
                            const targetMB = (effectiveFileLimit / 1024 / 1024).toFixed(1);
                            const onProgress = (info) => {
                                const now = Date.now();
                                if (now - lastUpdate >= 3000) {
                                    lastUpdate = now;
                                    let methodStr;
                                    switch (info.stage) {
                                        case 'igpu':    methodStr = 'local iGPU'; break;
                                        case 'network': methodStr = 'NAS iGPU';   break;
                                        case 'local':   methodStr = 'local CPU';  break;
                                        default:        methodStr = info.stage || 'unknown';
                                    }
                                    const percentStr = info.percent !== undefined ? ` - ${info.percent}%` : '';
                                    updatePlaceholderStage(placeholder, `working... <${instagramUrl}>\nstage: compressing media (${methodStr}, target ${targetMB}MB)${percentStr}`).catch(()=>{});
                                }
                            };

                            const result = await compressVideoToFit(buf, ext, effectiveFileLimit, FFMPEG_TIMEOUT, onProgress);
                            if (result) {
                                compressedAttachments.push(new AttachmentBuilder(result.buffer, { name: `instagram_media_${i}.${result.ext}` }));
                            } else {
                                console.log(`[Instagram Interceptor] Compression failed for attachment ${i}. Dropping oversized file.`);
                            }
                        } else {
                            compressedAttachments.push(att);
                        }
                    }
                    attachments = compressedAttachments;
                    if (attachments.length === 0) {
                        downloadSuccess = false;
                        console.log('[Instagram Interceptor] All attachments were too large even after compression.');
                    }
                }
            }

            try {
                // Parse numbers from message content (excluding the Instagram URL)
                const urlIndex = remadeContent.indexOf(instagramUrl);
                let beforeUrl = remadeContent.substring(0, urlIndex);
                let afterUrl = remadeContent.substring(urlIndex + instagramUrl.length);

                const parseMatches = (matches) => {
                    const result = [];
                    for (const m of matches) {
                        const str = m[0];
                        const val = Math.abs(parseInt(str, 10));
                        const isNegative = str.startsWith('-');
                        result.push({ val, isNegative });
                    }
                    return result;
                };

                const beforeNumbers = parseMatches([...beforeUrl.matchAll(/(?:^|(?<=[\s,]))-?\d+\b/g)]);
                const afterNumbers = parseMatches([...afterUrl.matchAll(/(?:^|(?<=[\s,]))-?\d+\b/g)]);
                const numbers = [...beforeNumbers, ...afterNumbers];

                let cleanedRemadeContent = remadeContent;
                if (downloadSuccess && numbers.length > 0) {
                    const positiveIndices = numbers.filter(n => !n.isNegative).map(n => n.val);
                    const negativeNumbers = numbers.filter(n => n.isNegative);

                    if (positiveIndices.length > 0) {
                        attachments = attachments.filter((_, idx) => positiveIndices.includes(idx + 1));
                    }

                    if (negativeNumbers.length === 1) {
                        const count = negativeNumbers[0].val;
                        if (count < attachments.length) {
                            attachments = attachments.slice(0, attachments.length - count);
                        } else {
                            attachments = [];
                        }
                    } else if (negativeNumbers.length > 1) {
                        const excludeIndices = new Set(negativeNumbers.map(n => n.val));
                        attachments = attachments.filter((_, idx) => !excludeIndices.has(idx + 1));
                    }

                    const cleanSection = (text) => {
                        return text
                            .replace(/(?:^|(?<=[\s,]))-?\d+\b/g, '')
                            .replace(/[,\s]+/g, ' ')
                            .trim();
                    };
                    beforeUrl = cleanSection(beforeUrl);
                    afterUrl = cleanSection(afterUrl);
                    cleanedRemadeContent = (beforeUrl ? beforeUrl + ' ' : '') + instagramUrl + (afterUrl ? ' ' + afterUrl : '');
                }

                // Generate standard/original link and modified fallback link
                const standardUrl = instagramUrl.replace(/(www\.)?(?:dd|kk|ee|uu|rx)?instagram\.com/i, 'instagram.com');
                const fallbackDomain = lastRespondingDomain || 'ddinstagram.com';
                const fallbackUrl = instagramUrl.replace(/(www\.)?(?:dd|kk|ee|uu|rx)?instagram\.com/i, fallbackDomain);
                const displayUrl = standardUrl.replace(/^https?:\/\//i, '');
                const fallbackContent = cleanedRemadeContent.replace(instagramUrl, `[${displayUrl}](${fallbackUrl})`);

                if (downloadSuccess) {
                    const successText = cleanedRemadeContent.replace(instagramUrl, `<${standardUrl}>`);
                    if (attachments.isRestrictedVideoFallback) {
                        const privateSuppressedText = cleanedRemadeContent.replace(instagramUrl, `[PRIVATE VIDEO, ACCESS ONLY VIA LINK]\n<${standardUrl}>`);
                        await updateWorkingPlaceholder(placeholder, privateSuppressedText, attachments, true, effectiveFileLimit, fallbackContent);
                    } else {
                        await updateWorkingPlaceholder(placeholder, successText, attachments, true, effectiveFileLimit, fallbackContent);
                    }
                } else {
                    console.log(`[Instagram Interceptor] All downloads failed. Posting markdown hyperlink for Discord embed: [${displayUrl}](${fallbackUrl})`);
                    await updateWorkingPlaceholder(placeholder, fallbackContent, [], false, 0, fallbackContent);
                }
            } catch (sendErr) {
                console.error('[Instagram Interceptor] Failed to send reposted message:', sendErr.message);
            }
        } catch (outerErr) {
            console.error('[Instagram Interceptor] Critical error in handler:', outerErr);
        } finally {
            clearInterval(typingInterval);
        }
    });
    } catch (enqueueErr) {
        console.error('[Instagram Interceptor] mediaQueue.enqueue failed:', enqueueErr.message);
        clearInterval(typingInterval);
    }
}

module.exports = {
    handleInstagramMessage,
    handleInstagramProfile,
    sendRepostedMessage
};
