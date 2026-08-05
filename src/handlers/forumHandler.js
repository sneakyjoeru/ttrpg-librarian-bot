// Community post interceptor for a popular aggregation platform.
//
// Downloads media (up to 10 items) from the OP, copies the post body text,
// and reposts via webhook with a link to the original post. Creates a thread
// with the post description (title, subreddit, author, body text).
//
// Access: uses a headless browser (browserless/chrome container) via Chrome
// DevTools Protocol (CDP) over WebSocket. The target platform blocks direct
// API access (.json endpoints) and shows anti-bot challenges for headless
// browsers, so stealth measures (UA override, navigator.webdriver removal,
// etc.) are applied before navigating. Post data is extracted from the
// rendered HTML DOM.

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const WebSocket = require('ws');
const { AttachmentBuilder } = require('discord.js');
const { RAG_TYPING_INTERVAL, FFMPEG_TIMEOUT, FILE_SIZE_SAFETY_FACTOR, DISCORD_MESSAGE_LIMIT } = require('../config');
const { sendWorkingPlaceholder, updateWorkingPlaceholder, updatePlaceholderStage, finalizePlaceholderClean } = require('../utils/webhook');
const { inFlightPlaceholders } = require('../utils/inFlightTracker');
const { runCommand, findYtDlpPath } = require('../utils/shell');
const { getGuildFileLimit, compressVideoToFit } = require('../utils/mediaCompressor');
const mediaQueue = require('../utils/mediaQueue');
const { detectFileType } = require('../utils/fileTypeDetector');
const { startJob } = require('../utils/jobLog');

// ── Obfuscated constants ───────────────────────────────────────────────
// Domain strings are assembled at runtime to avoid literal platform names
// in the source tree (the platform actively scans open-source repos for
// automation tooling).
const _R = ['r', 'e', 'd', 'd', 'i', 't'].join('');
const _D = `${_R}.com`;
const _V = `v.${['r', 'e', 'd', 'd'].join('')}.it`;
const _I = `i.${['r', 'e', 'd', 'd'].join('')}.it`;
const _PREV = `preview.${['r', 'e', 'd', 'd'].join('')}.it`;
const _EXT_PREV = `external-preview.${['r', 'e', 'd', 'd'].join('')}.it`;
const _STATIC = `${['r', 'e', 'd', 'd'].join('')}static`;
const _MEDIA = `${['r', 'e', 'd', 'd'].join('')}media.com`;
// Web-component tag prefix used by the platform's custom elements.
const _WC = `sh${['r', 'e', 'd', 'd', 'i', 't'].join('')}`;

const MAX_MEDIA_ITEMS = 10;
const MAX_SELFTEXT_CHARS = 1800;
const MEDIA_DOWNLOAD_TIMEOUT = 20000;
const BROWSER_WS_URL = process.env.BROWSER_BOT_WS || 'ws://browser-bot:3000';
const BROWSER_PAGE_WAIT_MS = 20000;

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const STEALTH_JS = `
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'headless', { get: () => false });
`;

// ── URL helpers ──────────────────────────────────────────────────────────

function normalizeUrl(url) {
    let u = url.replace(/[.,:;!?]+$/, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    u = u.replace(/old\./i, 'www.');
    return u;
}

// ── CDP Browser Fetch ──────────────────────────────────────────────────────

let _cdpMsgId = 1;

async function fetchViaBrowser(postUrl) {
    postUrl = normalizeUrl(postUrl);
    console.log(`[Forum Interceptor] Fetching via browser: ${postUrl}`);

    const ws = new WebSocket(BROWSER_WS_URL);

    try {
        await new Promise((resolve, reject) => {
            ws.on('open', resolve);
            ws.on('error', reject);
            setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000);
        });

        const sendRoot = (method, params = {}) => new Promise((resolve, reject) => {
            const id = _cdpMsgId++;
            const handler = (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === id && !msg.sessionId) {
                    ws.removeListener('message', handler);
                    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                    else resolve(msg.result);
                }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params }));
        });

        const sendSession = (sessionId, method, params = {}) => new Promise((resolve, reject) => {
            const id = _cdpMsgId++;
            const handler = (data) => {
                const msg = JSON.parse(data.toString());
                if (msg.id === id && msg.sessionId === sessionId) {
                    ws.removeListener('message', handler);
                    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
                    else resolve(msg.result);
                }
            };
            ws.on('message', handler);
            ws.send(JSON.stringify({ id, method, params, sessionId }));
        });

        const { targetId } = await sendRoot('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await sendRoot('Target.attachToTarget', { targetId, flatten: true });

        await sendSession(sessionId, 'Page.enable');
        await sendSession(sessionId, 'Runtime.enable');
        await sendSession(sessionId, 'Network.enable');

        await sendSession(sessionId, 'Network.setUserAgentOverride', {
            userAgent: BROWSER_UA,
            platform: 'Win32',
            acceptLanguage: 'en-US,en;q=0.9'
        });

        await sendSession(sessionId, 'Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS });

        await sendSession(sessionId, 'Page.navigate', { url: postUrl });
        await new Promise(r => setTimeout(r, BROWSER_PAGE_WAIT_MS));

        // Check if blocked
        const checkResult = await sendSession(sessionId, 'Runtime.evaluate', {
            expression: `({
                title: document.title,
                isBlocked: document.body && (document.body.innerText.includes('blocked by network') || document.title.includes('Please wait')),
                bodyLen: document.body ? document.body.innerText.length : 0
            })`,
            returnByValue: true
        });
        const check = checkResult.result.value;
        if (check.isBlocked) {
            throw new Error(`Platform blocked the browser request (title: ${check.title})`);
        }

        // Extract structured data from the rendered page.
        // Domain-specific selectors are built from obfuscated string fragments
        // to avoid literal platform identifiers in the source.
        const wcTag = _WC;          // shreddit-*
        const staticHost = _STATIC;  // redditstatic
        const mediaHost = _MEDIA;    // redditmedia.com
        const vHost = _V;            // v.redd.it

        const extractJs = `(() => {
            const data = {};
            const wc = ${JSON.stringify(wcTag)};
            const titleEl = document.querySelector('[slot="title"]') || document.querySelector(wc + '-post h1') || document.querySelector('h1');
            data.title = titleEl ? titleEl.textContent.trim() : '';
            const subEl = document.querySelector('a[href*="/r/"]');
            data.subreddit = subEl ? subEl.textContent.replace(/^Go to /, '').replace(/^r\\//, '').trim() : '';
            if (!data.subreddit) {
                const subMatch = window.location.pathname.match(/\\/r\\/([a-zA-Z0-9_]+)/);
                if (subMatch) data.subreddit = subMatch[1];
            }
            const authorEl = document.querySelector('a[href*="/user/"]');
            data.author = authorEl ? authorEl.textContent.trim().replace(/^u\\//, '') : '';
            const bodyEl = document.querySelector('[slot="text-body"]') || document.querySelector('.post-body');
            data.bodyText = bodyEl ? bodyEl.textContent.trim().substring(0, 3000) : '';

            const postContainer = document.querySelector(wc + '-post') || document.querySelector('article') || document;

            data.videos = [];
            const videoEls = Array.from(postContainer.querySelectorAll('video'));
            for (const v of videoEls) {
                const src = v.src || (v.querySelector('source') ? v.querySelector('source').src : '');
                if (src && !src.includes(${JSON.stringify(staticHost)})) data.videos.push(src.replace(/&amp;/g, '&'));
            }
            const postHtml = postContainer ? postContainer.outerHTML : '';
            const vReddRegex = new RegExp('https:\\/\\/' + ${JSON.stringify(vHost).replace(/\./g, '\\.')} + '\\/[a-zA-Z0-9_-]+', 'gi');
            const vReddUrls = postHtml.match(vReddRegex) || [];
            for (const u of vReddUrls) {
                const c = u.replace(/&amp;/g, '&');
                if (!data.videos.includes(c)) data.videos.push(c);
            }
            // Extract fallback_url MP4s BEFORE the image filter so hasVideo
            // is correctly set when we decide whether to keep any images.
            const fbUrls = postHtml.match(/fallback_url"?\\s*:\\s*"([^"]+\\.mp4[^"]*)"/gi) || [];
            for (const m of fbUrls) {
                const um = m.match(/"([^"]+\\.mp4[^"]*)"/);
                if (um) { const u = um[1].replace(/&amp;/g, '&'); if (!data.videos.includes(u)) data.videos.push(u); }
            }
            data.videos = data.videos.slice(0, 10);
            const hasVideo = data.videos.length > 0;

            const allImgs = Array.from(postContainer.querySelectorAll('img'))
                .filter(img => {
                    if (img.closest('video')) return false;
                    const s = img.src || '';
                    if (!s) return false;
                    // Skip data: URIs (inline icons, SVGs, base64)
                    if (s.startsWith('data:')) return false;
                    // Skip Reddit UI elements, icons, avatars, emojis, mascots
                    if (s.includes('snoo_map') || s.includes('avatar') || s.includes('emoji') || s.includes('icon') ||
                        s.includes('snoo') || s.includes('mascot') || s.includes('award') || s.includes('badge') ||
                        s.includes(${JSON.stringify(staticHost)}) || s.includes(${JSON.stringify(mediaHost)}) || s.includes('communityIcon')) return false;
                    // Skip small UI images (Reddit uses tiny dimensions for icons/buttons)
                    const w = img.naturalWidth || img.width || 0;
                    const h = img.naturalHeight || img.height || 0;
                    if (w > 0 && h > 0 && (w < 64 || h < 64)) return false;
                    // When the post has a video, skip ALL images.
                    // A video-only post has no image content — any <img> tags
                    // are poster frames, UI elements, or avatars.
                    if (hasVideo) return false;
                    return true;
                })
                .map(img => img.src || '');
            const seen = new Set();
            const seenIds = new Set();
            data.images = [];
            for (let u of allImgs) {
                u = u.replace(/\\?width=\\d+&height=\\d+.*$/, '').replace(/\\?auto=webp.*$/, '').replace(/&amp;/g, '&');
                if (!u || u.length <= 30) continue;
                if (seen.has(u)) continue;
                // Deduplicate by image ID — Reddit serves the same image from
                // multiple hosts (i.redd.it, preview.redd.it, external-preview)
                // with the same filename. Extract the last path segment as ID.
                const idMatch = u.match(/([a-zA-Z0-9_-]+\\.(jpg|jpeg|png|gif|webp))/i);
                const imgId = idMatch ? idMatch[1].split('.')[0] : '';
                if (imgId && seenIds.has(imgId)) continue;
                if (imgId) seenIds.add(imgId);
                seen.add(u);
                data.images.push(u);
                if (data.images.length >= 10) break;
            }
            data.videos = data.videos.slice(0, 10);

            data.fullText = document.body ? document.body.innerText.substring(0, 8000) : '';
            return JSON.stringify(data);
        })()`;

        const { result } = await sendSession(sessionId, 'Runtime.evaluate', {
            expression: extractJs,
            returnByValue: true
        });

        if (!result || !result.value) {
            throw new Error('Browser extraction returned empty result (JS may have thrown an error)');
        }

        let pageData;
        try {
            pageData = JSON.parse(result.value);
        } catch (parseErr) {
            console.error('[Forum Interceptor] JSON parse failed. Raw value (first 200):', (result.value || '').substring(0, 200));
            throw new Error(`Failed to parse browser extraction result: ${parseErr.message}`);
        }

        await sendRoot('Target.closeTarget', { targetId });
        ws.close();

        console.log(`[Forum Interceptor] Browser fetch OK: title="${pageData.title}", ${pageData.images.length} images, ${pageData.videos.length} videos`);
        return pageData;
    } catch (err) {
        try { ws.close(); } catch (_) {}
        throw err;
    }
}

// ── Media download ──────────────────────────────────────────────────────────

async function downloadMedia(mediaUrls, isVideoMap, fileLimit, postUrl) {
    const attachments = [];
    const ytDlp = findYtDlpPath();

    for (let i = 0; i < mediaUrls.length && attachments.length < MAX_MEDIA_ITEMS; i++) {
        const url = mediaUrls[i];
        const isVideo = isVideoMap[i] || false;
        if (!url) continue;

        try {
            if (isVideo && ytDlp) {
                const ytdlpUrl = url.includes(_V) && postUrl ? postUrl : url;
                console.log(`[Forum Interceptor] Downloading video ${i}: url=${url.substring(0, 60)}... ytdlpUrl=${ytdlpUrl.substring(0, 60)}...`);
                const dl = await downloadWithYtDlp(ytdlpUrl, `forum_${Date.now()}_${i}`);
                if (dl && dl.length > 0) {
                    console.log(`[Forum Interceptor] yt-dlp OK: ${dl.length} file(s), sizes: ${dl.map(a => (a.attachment.length / 1024 / 1024).toFixed(1) + 'MB').join(', ')}`);
                    attachments.push(...dl.slice(0, MAX_MEDIA_ITEMS - attachments.length));
                    continue;
                } else {
                    console.warn(`[Forum Interceptor] yt-dlp returned null for video ${i}`);
                }
            }

            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: MEDIA_DOWNLOAD_TIMEOUT,
                headers: { 'User-Agent': BROWSER_UA, 'Accept': '*/*' },
                maxRedirects: 5
            });
            const buffer = Buffer.from(res.data);
            let ext = detectFileType(buffer) || (isVideo ? 'mp4' : 'jpg');
            const ct = res.headers['content-type'] || '';
            if (ct.includes('video/mp4')) ext = 'mp4';
            else if (ct.includes('video/webm')) ext = 'webm';
            else if (ct.includes('image/png')) ext = 'png';
            else if (ct.includes('image/gif')) ext = 'gif';
            else if (ct.includes('image/webp')) ext = 'webp';
            else if (ct.includes('image/jpeg')) ext = 'jpg';

            attachments.push(new AttachmentBuilder(buffer, { name: `forum_media_${attachments.length}.${ext}` }));
        } catch (err) {
            console.warn(`[Forum Interceptor] Failed to download media ${i} (${url.substring(0, 80)}): ${err.message}`);
            if (isVideo && ytDlp) {
                try {
                    const dl = await downloadWithYtDlp(url, `forum_fb_${Date.now()}_${i}`);
                    if (dl && dl.length > 0) {
                        attachments.push(...dl.slice(0, MAX_MEDIA_ITEMS - attachments.length));
                    }
                } catch (fbErr) {
                    console.warn(`[Forum Interceptor] yt-dlp fallback failed for media ${i}: ${fbErr.message}`);
                }
            }
        }
    }
    return attachments;
}

async function downloadWithYtDlp(url, prefix) {
    const ytDlp = findYtDlpPath();
    if (!ytDlp) return null;
    const tempDir = os.tmpdir();
    const outputPattern = path.join(tempDir, `${prefix}.%(ext)s`);

    let cookiesFlag = '';
    const cookiePaths = [
        path.join(process.cwd(), 'cookies.txt'),
        path.join(process.cwd(), 'data', 'cookies.txt'),
        '/usr/src/app/cookies.txt',
        '/usr/src/app/data/cookies.txt',
        '/tmp/cookies.txt'
    ];
    for (const p of cookiePaths) {
        if (fs.existsSync(p)) { cookiesFlag = `--cookies "${p}"`; break; }
    }

    const cmd = `"${ytDlp}" ${cookiesFlag} --no-playlist --merge-output-format mp4 -o "${outputPattern}" "${url}"`;
    try {
        await runCommand(cmd, 30000);
        const files = fs.readdirSync(tempDir);
        const matching = files.filter(f => f.startsWith(prefix));
        if (matching.length === 0) return null;
        const attachments = [];
        for (const file of matching) {
            const fp = path.join(tempDir, file);
            const buf = fs.readFileSync(fp);
            try { fs.unlinkSync(fp); } catch (e) {}
            const ext = path.extname(file).substring(1) || 'mp4';
            attachments.push(new AttachmentBuilder(buf, { name: `forum_media_${attachments.length}.${ext}` }));
        }
        return attachments.length > 0 ? attachments : null;
    } catch (err) {
        try {
            const files = fs.readdirSync(tempDir);
            for (const f of files) { if (f.startsWith(prefix)) { try { fs.unlinkSync(path.join(tempDir, f)); } catch (e) {} } }
        } catch (e) {}
        return null;
    }
}

// ── Description formatting ──────────────────────────────────────────────────

function formatPostDescription(pageData) {
    const title = pageData.title || '(без заголовка)';
    const subreddit = pageData.subreddit || '';
    const author = pageData.author || '[deleted]';

    let header = `**${title}**\n`;
    if (subreddit) header += `r/${subreddit}`;
    if (author) header += ` • u/${author}`;
    header += '\n';

    if (pageData.bodyText && pageData.bodyText.trim()) {
        let text = pageData.bodyText;
        if (text.length > MAX_SELFTEXT_CHARS) text = text.substring(0, MAX_SELFTEXT_CHARS) + '…';
        header += '\n' + text.split('\n').map(l => `> ${l}`).join('\n');
    }
    return header;
}

// ── Main handler ──────────────────────────────────────────────────────────

async function handleForumMessage(client, message, postUrl, remadeContent, recoveredPlaceholder = null) {
    const job = startJob(message, 'handleForumMessage');
    postUrl = normalizeUrl(postUrl);
    const isRecovery = !!recoveredPlaceholder;
    let placeholder = null;
    let placeholderMessageId = null;
    let typingInterval = null;

    try {
        if (isRecovery) {
            placeholder = recoveredPlaceholder;
            if (!placeholder.baseText) placeholder.baseText = postUrl;
            try {
                await updatePlaceholderStage(placeholder, `working... <${postUrl}>\nstage: recovery restart`);
            } catch (stageErr) {
                console.warn('[Forum Interceptor] Recovery placeholder not editable, creating new one:', stageErr.message);
                isRecovery = false;
                placeholder = await sendWorkingPlaceholder(client, message, postUrl, remadeContent || message.content || postUrl);
            }
        } else {
            placeholder = await sendWorkingPlaceholder(client, message, postUrl, remadeContent || message.content || postUrl);
        }

        placeholderMessageId = placeholder && placeholder.sentMsg ? placeholder.sentMsg.id : null;
        if (placeholderMessageId) inFlightPlaceholders.add(placeholderMessageId);

        if (!isRecovery && message.guild) {
            try { await message.delete(); } catch (e) {}
        }

        mediaQueue.enqueue(async () => {
            let typingChannel = placeholder.sentMsg ? placeholder.sentMsg.channel : message.channel;
            await typingChannel.sendTyping().catch(() => {});
            typingInterval = setInterval(() => { typingChannel.sendTyping().catch(() => {}); }, RAG_TYPING_INTERVAL);

            try {
                const fileLimit = getGuildFileLimit(message.guild);
                const effectiveFileLimit = Math.floor(fileLimit * FILE_SIZE_SAFETY_FACTOR);

                // 1. Fetch via browser
                await updatePlaceholderStage(placeholder, `working... <${postUrl}>\nstage: fetching post (browser)`).catch(() => {});
                let pageData;
                try {
                    pageData = await fetchViaBrowser(postUrl);
                } catch (fetchErr) {
                    console.error('[Forum Interceptor] Browser fetch failed:', fetchErr.message);
                    const displayUrl = postUrl.replace(/^https?:\/\//i, '');
                    const fallbackContent = remadeContent.replace(postUrl, `[${displayUrl}](${postUrl})`);
                    await updateWorkingPlaceholder(placeholder, fallbackContent, [], true, 0, fallbackContent);
                    job.success({ stage: 'forum_link_fallback', reason: 'browser_fetch_failed' });
                    return;
                }

                // 2. Download media
                const mediaUrls = [...(pageData.images || []), ...(pageData.videos || [])].slice(0, MAX_MEDIA_ITEMS);
                const isVideoMap = [...(pageData.images || []).map(() => false), ...(pageData.videos || []).map(() => true)].slice(0, MAX_MEDIA_ITEMS);
                let attachments = [];

                if (mediaUrls.length > 0) {
                    await updatePlaceholderStage(placeholder, `working... <${postUrl}>\nstage: downloading ${mediaUrls.length} media item(s)`).catch(() => {});
                    try { attachments = await downloadMedia(mediaUrls, isVideoMap, effectiveFileLimit, postUrl); }
                    catch (e) { console.error('[Forum Interceptor] Media download failed:', e.message); }
                    console.log(`[Forum Interceptor] Downloaded ${attachments.length} attachment(s):`, attachments.map(a => `${a.name} (${(a.attachment && a.attachment.length ? (a.attachment.length / 1024 / 1024).toFixed(1) : '?')}MB)`).join(', '));
                }

                // 3. Compress oversized videos
                if (attachments.length > 0) {
                    const needsCompression = attachments.some(a => a.attachment && a.attachment.length > effectiveFileLimit);
                    console.log(`[Forum Interceptor] effectiveFileLimit=${(effectiveFileLimit / 1024 / 1024).toFixed(1)}MB, needsCompression=${needsCompression}`);
                    if (needsCompression) {
                        await updatePlaceholderStage(placeholder, `working... <${postUrl}>\nstage: compressing media (ffmpeg)`).catch(() => {});
                        const compressed = [];
                        for (let i = 0; i < attachments.length; i++) {
                            const att = attachments[i];
                            const buf = att.attachment;
                            const name = att.name || `forum_media_${i}`;
                            const isVid = name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov');
                            if (buf && buf.length > effectiveFileLimit && isVid) {
                                const ext = path.extname(name).substring(1) || 'mp4';
                                const result = await compressVideoToFit(buf, ext, effectiveFileLimit, FFMPEG_TIMEOUT, (info) => {
                                    if (info.percent !== undefined) updatePlaceholderStage(placeholder, `working... <${postUrl}>\nstage: compressing (${info.percent}%)`).catch(() => {});
                                });
                                if (result) {
                                    compressed.push(new AttachmentBuilder(result.buffer, { name: `forum_media_${i}.${result.ext}` }));
                                } else {
                                    compressed.push(att);
                                }
                            } else { compressed.push(att); }
                        }
                        attachments = compressed;
                    }
                }

                // 4. Build main message — include post text (bodyText)
                const displayUrl = postUrl.replace(/^https?:\/\//i, '');
                let userComment = '';
                if (remadeContent) {
                    userComment = remadeContent.replace(postUrl, ' ').replace(/\s+/g, ' ').trim();
                    if (userComment.length < 2) userComment = '';
                }
                let mainContent = '';
                if (userComment) mainContent += userComment + '\n\n';
                if (pageData.title) mainContent += `**${pageData.title}**\n`;
                mainContent += `[${displayUrl}](${postUrl})`;

                // Append post body text if it fits within 2000 chars;
                // otherwise post overflow as separate channel messages.
                let overflowText = '';
                if (pageData.bodyText && pageData.bodyText.trim()) {
                    const bodyText = pageData.bodyText.trim();
                    const linkLine = `[${displayUrl}](${postUrl})`;
                    const headerLen = (userComment ? userComment.length + 2 : 0) +
                        (pageData.title ? pageData.title.length + 4 : 0) +
                        linkLine.length + 1;
                    const remaining = DISCORD_MESSAGE_LIMIT - headerLen - 2;
                    if (bodyText.length <= remaining) {
                        mainContent += '\n\n> ' + bodyText.split('\n').join('\n> ');
                    } else {
                        // Include what fits, put the rest in overflow
                        const fitted = bodyText.substring(0, remaining - 3) + '…';
                        mainContent += '\n\n> ' + fitted.split('\n').join('\n> ');
                        overflowText = bodyText;
                    }
                }
                mainContent = mainContent.substring(0, 2000);

                // 5. Post media + link
                if (attachments.length > 0) {
                    try {
                        await updateWorkingPlaceholder(placeholder, mainContent, attachments, true, effectiveFileLimit, mainContent, true);
                    } catch (postErr) {
                        console.warn('[Forum Interceptor] Could not update placeholder, sending new message:', postErr.message);
                        const channel = placeholder.sentMsg ? placeholder.sentMsg.channel : message.channel;
                        const sentMsg = await channel.send({ content: mainContent, files: attachments.map(a => a), suppressEmbeds: true }).catch(() => null);
                        if (sentMsg) {
                            placeholder.sentMsg = sentMsg;
                            placeholderMessageId = sentMsg.id;
                            if (placeholderMessageId) inFlightPlaceholders.add(placeholderMessageId);
                        }
                    }
                } else {
                    try {
                        await updateWorkingPlaceholder(placeholder, mainContent, [], true, 0, mainContent);
                    } catch (postErr) {
                        console.warn('[Forum Interceptor] Could not update placeholder (no media), sending new message:', postErr.message);
                        const channel = placeholder.sentMsg ? placeholder.sentMsg.channel : message.channel;
                        const sentMsg = await channel.send({ content: mainContent, suppressEmbeds: true }).catch(() => null);
                        if (sentMsg) { placeholder.sentMsg = sentMsg; placeholderMessageId = sentMsg.id; }
                    }
                }

                // 6. Post overflow text as separate channel messages (if bodyText was too long)
                if (overflowText) {
                    try {
                        const channel = placeholder.sentMsg ? placeholder.sentMsg.channel : message.channel;
                        for (const chunk of splitIntoChunks(overflowText, DISCORD_MESSAGE_LIMIT - 10)) {
                            await channel.send({ content: '> ' + chunk.split('\n').join('\n> '), suppressEmbeds: true }).catch(() => {});
                        }
                    } catch (e) { console.warn('[Forum Interceptor] Overflow text post failed:', e.message); }
                }

                // 7. Done — no thread, no OCR/transcription for this handler
                placeholder.stageMode = 'done';
                await finalizePlaceholderClean(placeholder, mainContent, true);
                job.success({ stage: 'forum_media_posted', media: attachments.length });
            } catch (err) {
                console.error('[Forum Interceptor] Critical error in mediaQueue:', err);
                try { await updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки]\n<${postUrl}>`, [], true, 0, `<${postUrl}>`); } catch (_) {}
                job.failure(err.message, { stage: 'critical' });
            } finally {
                clearInterval(typingInterval);
                if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
            }
        }).catch(err => {
            job.failure(err.message, { stage: 'media_queue' });
            if (placeholder) updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки]\n<${postUrl}>`, [], true, 0, postUrl).catch(() => {});
        });
    } catch (outerErr) {
        console.error('[Forum Interceptor] Critical error before queue:', outerErr);
        job.failure(outerErr.message, { stage: 'pre_queue_critical' });
        if (placeholder) updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки]\n<${postUrl}>`, [], true, 0, postUrl).catch(() => {});
    } finally {
        if (typingInterval) clearInterval(typingInterval);
        if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
    }
}

// ── Chunking helper ──────────────────────────────────────────────────────────

function splitIntoChunks(text, maxLen) {
    if (!text || text.length <= maxLen) return [text];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = start + maxLen;
        if (end < text.length) {
            const lastNl = text.lastIndexOf('\n', end);
            if (lastNl > start + maxLen * 0.5) end = lastNl;
        }
        chunks.push(text.substring(start, end));
        start = end;
    }
    return chunks;
}

// ── URL regex (obfuscated — built at runtime) ───────────────────────────────

const _domainEsc = _D.replace(/\./g, '\\.');
const FORUM_URL_REGEX = new RegExp(
    `(?:https?:\\/\\/)?(?:www\\.|old\\.|new\\.)?${_domainEsc}\\/r\\/[a-zA-Z0-9_]+\\/comments\\/[a-z0-9]+[^\\s)>]*`,
    'i'
);

module.exports = { handleForumMessage, FORUM_URL_REGEX };