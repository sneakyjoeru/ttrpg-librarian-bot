// Facebook embed interceptor — ported from robot-joe (minus the OCR/Whisper
// transcription/translation pipeline, task persistence, and active-jobs
// registry, which the librarian bot doesn't have).
//
// Download strategy (in priority order):
//   1. yt-dlp (works for nearly all public FB content with no auth; pulls the
//      original mp4 from fbcdn.net, NOT a fixer's branded preview video)
//   2. Domain fixer: fdown.net (only — savefrom.net is excluded because its
//      download page serves a savefrom-cdn preview/watermarked video instead
//      of the actual reel content)
//   3. Generic og:video/og:image scrape as last-resort fallback
//
// After download we compress oversized videos with ffmpeg (same as the other
// handlers) and repost the media via webhook. No translation/transcription.

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { AttachmentBuilder } = require('discord.js');
const { RAG_TYPING_INTERVAL, FFMPEG_TIMEOUT, FILE_SIZE_SAFETY_FACTOR, PROGRESS_UPDATE_INTERVAL_MS, RAG_SEARCH_TIMEOUT, RAG_OLLAMA_TIMEOUT_SHORT } = require('../config');
const { sendWorkingPlaceholder, updateWorkingPlaceholder, updatePlaceholderStage, finalizePlaceholderClean } = require('../utils/webhook');
const { inFlightPlaceholders } = require('../utils/inFlightTracker');
const { runCommand, findYtDlpPath } = require('../utils/shell');
const { getGuildFileLimit, compressVideoToFit } = require('../utils/mediaCompressor');
const mediaQueue = require('../utils/mediaQueue');
const { detectFileType } = require('../utils/fileTypeDetector');
const { startJob } = require('../utils/jobLog');

// Map the internal `successfulSource` tag to a human-readable label for the
// result footer ("Источник загрузки: ...").
const FB_SCRAPE_LABELS = {
    'ytdlp': 'yt-dlp',
    'fixer': 'Fixer (fdown.net)',
    'generic': 'Generic og:video/og:image scrape',
    'restricted-fallback': 'Restricted fallback',
};

// Cookie files that yt-dlp may want for FB (rarely required for public content, but kept
// in case the user adds authenticated cookies in the future).
const FB_COOKIE_PATHS = [
    'facebook-cookies.txt',
    'fb-cookies.txt',
    'cookies.txt',
    'instagram-cookies.txt',
    'data/facebook-cookies.txt',
    'data/fb-cookies.txt',
    'data/cookies.txt',
    'data/instagram-cookies.txt'
];

function locateCookies() {
    const roots = [
        process.cwd(),
        __dirname,
        path.join(__dirname, '..', '..'),
        '/usr/src/app',
        '/tmp'
    ];
    for (const root of roots) {
        for (const name of FB_COOKIE_PATHS) {
            const p = path.join(root, name);
            if (fs.existsSync(p)) {
                return p;
            }
        }
    }
    return null;
}

// 1. yt-dlp downloader. FB public content works without auth in most cases.
async function downloadWithYtDlp(url) {
    const ytDlp = findYtDlpPath();
    const tempDir = os.tmpdir();
    const prefix = `fb_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const outputPattern = path.join(tempDir, `${prefix}.%(ext)s`);

    const cookiesPath = locateCookies();
    const cookiesFlag = cookiesPath ? `--cookies "${cookiesPath}"` : '';
    if (!cookiesPath) {
        console.log(`[Facebook Interceptor] No cookies file located; yt-dlp will run unauthenticated (fine for public posts).`);
    } else {
        console.log(`[Facebook Interceptor] Passing cookies to yt-dlp from: ${cookiesPath}`);
    }

    console.log(`[Facebook Interceptor] Attempting yt-dlp download for: ${url}`);
    // No --max-filesize: download any size, compression will be attempted later if needed
    const cmd = `"${ytDlp}" ${cookiesFlag} --no-playlist --merge-output-format mp4 -o "${outputPattern}" "${url}"`;

    try {
        await runCommand(cmd, 45000); // 45s — FB downloads occasionally take longer than IG

        const files = fs.readdirSync(tempDir);
        const matchingFiles = files.filter(f => f.startsWith(prefix));

        if (matchingFiles.length === 0) {
            console.log('[Facebook Interceptor] yt-dlp completed but no files were found.');
            return null;
        }

        const attachments = [];
        for (const file of matchingFiles) {
            const filePath = path.join(tempDir, file);

            const buffer = fs.readFileSync(filePath);
            try { fs.unlinkSync(filePath); } catch (e) {}

            const ext = path.extname(file).substring(1) || 'mp4';
            attachments.push(new AttachmentBuilder(buffer, { name: `facebook_media_${attachments.length}.${ext}` }));
        }

        return attachments.length > 0 ? attachments : null;
    } catch (err) {
        const stderrStr = err.stderr || '';
        const stdoutStr = err.stdout || '';
        const isUnsupported = err.message.includes('Unsupported URL') || stderrStr.includes('Unsupported URL') || stdoutStr.includes('Unsupported URL');
        if (isUnsupported) {
            console.log('[Facebook Interceptor] yt-dlp: Unsupported URL (likely a private post or login wall).');
        } else {
            console.error('[Facebook Interceptor] yt-dlp download failed:', err.message);
            if (err.stderr) console.error('[Facebook Interceptor] yt-dlp stderr:', err.stderr.trim());
            if (err.stdout) console.log('[Facebook Interceptor] yt-dlp stdout:', err.stdout.trim());
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
            console.error('[Facebook Interceptor] Failed to clean up temp files:', cleanupErr.message);
        }
        return null;
    }
}

// 2. Fixer-based downloader. Tries popular FB embed/fixer services that proxy the
//    original media and expose og:video / direct .mp4 links.
async function downloadWithFixer(facebookUrl, fixerDomain) {
    // FB fixers (fdown.net, savefrom.net, snappea.com, etc.) only accept the target
    // URL via the `?url=` query parameter — they do NOT honour the original path
    // (e.g. /reel/<id> or /watch). Always build the canonical query-string form.
    const encoded = encodeURIComponent(facebookUrl);
    const candidates = [
        `https://${fixerDomain}/?url=${encoded}`,
        `https://${fixerDomain}/download?url=${encoded}`,
        `https://${fixerDomain}/get?url=${encoded}`
    ];
    console.log(`[Facebook Interceptor] Trying fixer ${fixerDomain} with ${candidates.length} candidate URL shapes.`);

    const tryFetch = async (candidateUrl) => {
        const response = await axios.get(candidateUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            },
            timeout: RAG_SEARCH_TIMEOUT,
            maxRedirects: 5,
            validateStatus: (s) => s >= 200 && s < 400
        });
        return response;
    };

    let response = null;
    let lastErr = null;
    for (const candidate of candidates) {
        try {
            response = await tryFetch(candidate);
            console.log(`[Facebook Interceptor] ${fixerDomain} candidate ${candidate} succeeded (status ${response.status}).`);
            break;
        } catch (e) {
            lastErr = e;
            console.log(`[Facebook Interceptor] ${fixerDomain} candidate ${candidate} failed: ${e.message}`);
        }
    }
    if (!response) {
        console.log(`[Facebook Interceptor] ${fixerDomain} all candidates failed. Last error: ${lastErr && lastErr.message}`);
        return null;
    }

    const html = response.data;
    if (typeof html !== 'string' || html.length < 200) {
        console.log(`[Facebook Interceptor] ${fixerDomain} returned empty/short body (${typeof html === 'string' ? html.length : typeof html} bytes).`);
        return null;
    }
    if (/not\s*found|404|video not available|removed|private video/i.test(html.slice(0, 4000))) {
        console.log(`[Facebook Interceptor] ${fixerDomain} reports video unavailable.`);
        return null;
    }

    // Look for the actual .mp4 URL. Fixers embed it in a download button or in JSON.
    let mediaUrl = null;
    const patterns = [
        /<a[^>]+href="([^"]+\.mp4[^"]*)"[^>]*download/i,
        /<a[^>]+href="([^"]+\.mp4[^"]*)"/i,
        /<source[^>]+src="([^"]+\.mp4[^"]*)"[^>]*type="video\//i,
        /<video[^>]+src="([^"]+\.mp4[^"]*)"/i,
        /<meta [^>]*property="og:video(?::secure_url|:url)?"[^>]*content="([^"]+)"/i,
        /<meta [^>]*content="([^"]+)"[^>]*property="og:video(?::secure_url|:url)?"/i,
        /"hd_src"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /"sd_src"\s*:\s*"([^"]+\.mp4[^"]*)"/i,
        /"playable_url"\s*:\s*"([^"]+)"/i,
        /"browser_native_hd_url"\s*:\s*"([^"]+)"/i,
        /"browser_native_sd_url"\s*:\s*"([^"]+)"/i
    ];
    for (const pattern of patterns) {
        const m = html.match(pattern);
        if (m && m[1]) {
            mediaUrl = m[1].replace(/&amp;/g, '&');
            break;
        }
    }

    let isRestrictedVideoFallback = false;
    if (!mediaUrl) {
        // Fall back to og:image (this means we only got the thumbnail — useful as a fallback only)
        const imageMatch = html.match(/<meta [^>]*property="og:image"[^>]*content="([^"]+)"/) ||
                           html.match(/<meta [^>]*content="([^"]+)"[^>]*property="og:image"/);
        if (imageMatch) {
            mediaUrl = imageMatch[1].replace(/&amp;/g, '&');
            isRestrictedVideoFallback = true;
            console.log(`[Facebook Interceptor] ${fixerDomain} returned only og:image fallback.`);
        } else {
            console.log(`[Facebook Interceptor] ${fixerDomain} yielded no media URL in HTML.`);
            return null;
        }
    }

    if (mediaUrl.startsWith('/')) {
        mediaUrl = `https://${fixerDomain}${mediaUrl}`;
    }

    console.log(`[Facebook Interceptor] ${fixerDomain} resolved media URL: ${mediaUrl}`);

    // Reject URLs that point to a fixer's own preview/branding CDN. These are
    // typically the same HTML5 <video> element used on the downloader's landing
    // page (often with the fixer's watermark). We only want links that resolve
    // to the actual facebook-hosted source or fbcdn/scontent CDNs.
    const lowerMediaUrl = mediaUrl.toLowerCase();
    const isBrandedProxyCdn = [
        'savefrom',
        'save-from',
        'sf-cdn',
        'snapinsta',
        'preview-',
        '/preview.',
        '/player/',
        '/embed/',
        '/ads/'
    ].some((needle) => lowerMediaUrl.includes(needle));
    if (isBrandedProxyCdn) {
        console.warn(`[Facebook Interceptor] ${fixerDomain} media URL looks like a branded preview, skipping: ${mediaUrl}`);
        return null;
    }

    try {
        const mediaRes = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            timeout: RAG_OLLAMA_TIMEOUT_SHORT,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': `https://${fixerDomain}/`
            }
        });
        const buffer = Buffer.from(mediaRes.data);

        const detectedType = detectFileType(buffer);
        let ext = detectedType || 'mp4';
        const contentType = mediaRes.headers['content-type'] || '';
        if (contentType.includes('video/mp4')) ext = 'mp4';
        else if (contentType.includes('video/webm')) ext = 'webm';
        else if (contentType.includes('image/png')) ext = 'png';
        else if (contentType.includes('image/gif')) ext = 'gif';
        else if (contentType.includes('image/jpeg')) ext = 'jpg';
        else if (contentType.includes('image/webp')) ext = 'webp';

        // If the fixer handed us only an image but the URL looked video-shaped, downgrade
        // to a "restricted fallback" so we still post the thumbnail instead of nothing.
        const isActuallyImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
        if (isActuallyImage && !isRestrictedVideoFallback) {
            console.warn(`[Facebook Interceptor] ${fixerDomain} returned image bytes for what should be a video. Treating as restricted fallback.`);
            isRestrictedVideoFallback = true;
        }

        const attachments = [new AttachmentBuilder(buffer, { name: `facebook_media_0.${ext}` })];
        if (isRestrictedVideoFallback) attachments.isRestrictedVideoFallback = true;
        return attachments;
    } catch (dlErr) {
        console.error(`[Facebook Interceptor] ${fixerDomain} media download failed:`, dlErr.message);
        return null;
    }
}

// 3. Generic og:video / og:image scrape. Used as a last-resort when fixers and
//    yt-dlp both fail. We hit facebook.com directly and follow redirect chains.
async function downloadWithGenericScrape(facebookUrl) {
    const candidates = [
        facebookUrl,
        facebookUrl.replace(/^https?:\/\/www\./i, 'https://m.'),
        facebookUrl.replace(/^https?:\/\//i, 'https://m.')
    ];
    for (const url of candidates) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.1 Mobile/15E148 Safari/604.1',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                },
                timeout: RAG_SEARCH_TIMEOUT,
                maxRedirects: 5,
                validateStatus: (s) => s >= 200 && s < 400
            });
            const html = response.data;
            if (typeof html !== 'string' || html.length < 200) continue;

            const videoPatterns = [
                /<meta [^>]*property="og:video(?::secure_url|:url)?"[^>]*content="([^"]+)"/i,
                /<meta [^>]*content="([^"]+)"[^>]*property="og:video(?::secure_url|:url)?"/i,
                /<meta [^>]*name="twitter:player:stream"[^>]*content="([^"]+)"/i,
                /<source[^>]+src="([^"]+\.mp4[^"]*)"[^>]*type="video\//i,
                /<video[^>]+src="([^"]+\.mp4[^"]*)"/i,
                /"playable_url_quality_hd"\s*:\s*"([^"]+)"/i,
                /"playable_url"\s*:\s*"([^"]+)"/i,
                /"browser_native_hd_url"\s*:\s*"([^"]+)"/i,
                /"browser_native_sd_url"\s*:\s*"([^"]+)"/i
            ];
            let mediaUrl = null;
            let isVideo = false;
            for (const p of videoPatterns) {
                const m = html.match(p);
                if (m && m[1]) {
                    mediaUrl = m[1].replace(/&amp;/g, '&').replace(/\\\//g, '/');
                    isVideo = /(\.mp4|\/video|\/dash|\/hls)/i.test(mediaUrl);
                    break;
                }
            }
            let isRestrictedVideoFallback = false;
            if (!mediaUrl) {
                const imageMatch = html.match(/<meta [^>]*property="og:image"[^>]*content="([^"]+)"/) ||
                                   html.match(/<meta [^>]*content="([^"]+)"[^>]*property="og:image"/);
                if (imageMatch) {
                    mediaUrl = imageMatch[1].replace(/&amp;/g, '&');
                    isRestrictedVideoFallback = true;
                }
            }
            if (!mediaUrl) continue;

            const mediaRes = await axios.get(mediaUrl, {
                responseType: 'arraybuffer',
                timeout: RAG_OLLAMA_TIMEOUT_SHORT,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.1 Mobile/15E148 Safari/604.1',
                    'Referer': 'https://m.facebook.com/'
                }
            });
            const buffer = Buffer.from(mediaRes.data);
            const detectedType = detectFileType(buffer);
            let ext = detectedType || 'jpg';
            const contentType = mediaRes.headers['content-type'] || '';
            if (isVideo) {
                if (contentType.includes('video/mp4')) ext = 'mp4';
                else if (contentType.includes('video/webm')) ext = 'webm';
                else ext = 'mp4';
                if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
                    isRestrictedVideoFallback = true;
                }
            } else {
                if (contentType.includes('image/png')) ext = 'png';
                else if (contentType.includes('image/gif')) ext = 'gif';
                else if (contentType.includes('image/jpeg')) ext = 'jpg';
                else if (contentType.includes('image/webp')) ext = 'webp';
            }
            const attachments = [new AttachmentBuilder(buffer, { name: `facebook_media_0.${ext}` })];
            if (isRestrictedVideoFallback) attachments.isRestrictedVideoFallback = true;
            return attachments;
        } catch (err) {
            console.log(`[Facebook Interceptor] Generic scrape failed for ${url}: ${err.message}`);
        }
    }
    return null;
}

async function handleFacebookMessage(client, message, facebookUrl, remadeContent, recoveredPlaceholder = null) {
    const job = startJob(message, 'handleFacebookMessage');
    const isRecovery = !!recoveredPlaceholder;
    let placeholder = null;
    let placeholderMessageId = null;
    let typingInterval = null;

    try {
        if (isRecovery) {
            placeholder = recoveredPlaceholder;
            await updatePlaceholderStage(placeholder, `working... <${facebookUrl}>\nstage: recovery restart`);
        } else {
            placeholder = await sendWorkingPlaceholder(client, message, facebookUrl, remadeContent || message.content || facebookUrl);
        }

        placeholderMessageId = placeholder && placeholder.sentMsg ? placeholder.sentMsg.id : null;
        if (placeholderMessageId) inFlightPlaceholders.add(placeholderMessageId);

        // Start typing indicator on the correct channel
        const typingChannel = placeholder.sentMsg ? placeholder.sentMsg.channel : message.channel;
        await typingChannel.sendTyping().catch(() => { });
        typingInterval = setInterval(() => {
            typingChannel.sendTyping().catch(() => { });
        }, RAG_TYPING_INTERVAL);

        mediaQueue.enqueue(async () => {
            try {
            const fileLimit = getGuildFileLimit(message.guild);
            console.log(`[Facebook Interceptor] Guild file limit: ${(fileLimit / 1024 / 1024).toFixed(0)}MB`);

            let downloadSuccess = false;
            let attachments = [];
            let lastRespondingFixer = null;
            let successfulSource = null; // 'ytdlp' | 'fixer' | 'generic' | 'restricted-fallback'
            let fallbackAttachments = null;

            // Reels and short-form videos are best handled by fixers first; posts with photos
            // benefit from a yt-dlp attempt that surfaces every media item in the post.
            const isReel = /\/(?:reel|reels|share)\/v?\d+/i.test(facebookUrl) || /facebook\.com\/reel\//i.test(facebookUrl);

            const runFixers = async () => {
                // Ordered list of fixer domains known to work for FB public videos.
                // savefrom.net is intentionally excluded: it serves its own branded
                // download/preview page whose <video> element points to savefrom-cdn
                // rather than the original FB source. yt-dlp and fdown both return
                // the real Facebook-hosted mp4.
                const domains = ['fdown.net'];
                for (const domain of domains) {
                    try {
                        await updatePlaceholderStage(placeholder, `working... <${facebookUrl}>\nstage: ${domain} fast fetch`);
                        const result = await downloadWithFixer(facebookUrl, domain);
                        if (result && result.length > 0) {
                            lastRespondingFixer = domain;
                            if (result.isRestrictedVideoFallback) {
                                if (!fallbackAttachments) fallbackAttachments = result;
                            } else {
                                attachments = result;
                                downloadSuccess = true;
                                successfulSource = 'fixer';
                                console.log(`[Facebook Interceptor] ${domain} resolved ${attachments.length} media item(s).`);
                                break;
                            }
                        }
                    } catch (fixerErr) {
                        console.error(`[Facebook Interceptor] ${domain} failed:`, fixerErr.message);
                    }
                }
            };

            const runYtDlp = async () => {
                await updatePlaceholderStage(placeholder, `working... <${facebookUrl}>\nstage: yt-dlp direct`);
                const result = await downloadWithYtDlp(facebookUrl);
                if (result && result.length > 0) {
                    if (result.isRestrictedVideoFallback) {
                        if (!fallbackAttachments) fallbackAttachments = result;
                    } else {
                        attachments = result;
                        downloadSuccess = true;
                        successfulSource = 'ytdlp';
                        console.log(`[Facebook Interceptor] yt-dlp downloaded ${attachments.length} media item(s).`);
                    }
                }
            };

            const runGenericScrape = async () => {
                await updatePlaceholderStage(placeholder, `working... <${facebookUrl}>\nstage: generic og:video scrape`);
                const result = await downloadWithGenericScrape(facebookUrl);
                if (result && result.length > 0) {
                    if (result.isRestrictedVideoFallback) {
                        if (!fallbackAttachments) fallbackAttachments = result;
                    } else {
                        attachments = result;
                        downloadSuccess = true;
                        successfulSource = 'generic';
                        console.log(`[Facebook Interceptor] Generic scrape downloaded ${attachments.length} media item(s).`);
                    }
                }
            };

            try {
                console.log(`[Facebook Interceptor] Facebook URL detected: ${facebookUrl} (isReel=${isReel})`);
                // yt-dlp is the most reliable source for Facebook public content:
                // its FB extractor pulls the original mp4 directly from fbcdn.net, so the
                // user sees the actual reel/post video — not a fixer-branded preview.
                // Fixers (currently only fdown.net) are kept as a fallback for the rare
                // case where yt-dlp fails (e.g. login wall or geo-restriction).
                await runYtDlp();
                if (!downloadSuccess) await runFixers();
                if (!downloadSuccess) await runGenericScrape();

                if (!downloadSuccess && fallbackAttachments) {
                    attachments = fallbackAttachments;
                    downloadSuccess = true;
                    successfulSource = 'restricted-fallback';
                    console.log(`[Facebook Interceptor] Using restricted-fallback attachments.`);
                }
            } catch (err) {
                console.error('[Facebook Interceptor] All downloaders failed:', err.message);
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
                    await updatePlaceholderStage(placeholder, `working... <${facebookUrl}>\nstage: compressing media (ffmpeg)`);
                    const compressed = [];
                    for (let i = 0; i < attachments.length; i++) {
                        const att = attachments[i];
                        const buf = att.attachment;
                        const name = att.name || `facebook_media_${i}`;
                        const isVideo = name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov');

                        if (buf && buf.length > effectiveFileLimit && isVideo) {
                            console.log(`[Facebook Interceptor] Attachment ${i} (${name}) is ${(buf.length / 1024 / 1024).toFixed(1)}MB, exceeds ${(effectiveFileLimit / 1024 / 1024).toFixed(1)}MB effective limit. Compressing...`);
                            const ext = path.extname(name).substring(1) || 'mp4';
                            let lastUpdate = 0;
                            const onProgress = (info) => {
                                const now = Date.now();
                                if (now - lastUpdate >= PROGRESS_UPDATE_INTERVAL_MS) {
                                    lastUpdate = now;
                                    const methodStr = info.stage === 'network'
                                        ? 'NAS iGPU'
                                        : (info.stage === 'local_igpu' ? 'local iGPU' : 'local CPU');
                                    const percentStr = info.percent !== undefined ? ` - ${info.percent}%` : '';
                                    updatePlaceholderStage(placeholder, `working... <${facebookUrl}>\nstage: compressing media (${methodStr})${percentStr}`).catch(()=>{});
                                }
                            };
                            const result = await compressVideoToFit(buf, ext, effectiveFileLimit, FFMPEG_TIMEOUT, onProgress);
                            if (result) {
                                compressed.push(new AttachmentBuilder(result.buffer, { name: `facebook_media_${i}.${result.ext}` }));
                            } else {
                                console.log(`[Facebook Interceptor] Compression failed for attachment ${i}; dropping oversized file.`);
                            }
                        } else {
                            compressed.push(att);
                        }
                    }
                    attachments = compressed;
                    if (attachments.length === 0) {
                        downloadSuccess = false;
                        console.log('[Facebook Interceptor] All attachments were too large even after compression.');
                    }
                }
            }

            try {
                const urlIndex = remadeContent.indexOf(facebookUrl);
                let beforeUrl = remadeContent.substring(0, urlIndex);
                let afterUrl = remadeContent.substring(urlIndex + facebookUrl.length);

                const parseMatches = (matches) => {
                    const result = [];
                    for (const m of matches) {
                        const str = m[0].toLowerCase();
                        if (str === '-l') {
                            result.push({ isLast: true, isNegative: true });
                        } else {
                            const val = Math.abs(parseInt(str, 10));
                            const isNegative = str.startsWith('-');
                            result.push({ val, isNegative, isLast: false });
                        }
                    }
                    return result;
                };

                const beforeNumbers = parseMatches([...beforeUrl.matchAll(/(?:^|(?<=[\s,]))(?:-?\d+|-l)\b/gi)]);
                const afterNumbers = parseMatches([...afterUrl.matchAll(/(?:^|(?<=[\s,]))(?:-?\d+|-l)\b/gi)]);
                const numbers = [...beforeNumbers, ...afterNumbers];

                let cleanedRemadeContent = remadeContent;
                if (downloadSuccess && numbers.length > 0) {
                    const positiveIndices = numbers.filter(n => !n.isNegative).map(n => n.val);
                    const excludeIndices = new Set();
                    const negativeTokens = numbers.filter(n => n.isNegative);
                    for (const n of negativeTokens) {
                        if (n.isLast) {
                            excludeIndices.add(attachments.length);
                        } else {
                            excludeIndices.add(n.val);
                        }
                    }

                    if (positiveIndices.length > 0) {
                        attachments = attachments.filter((_, idx) => positiveIndices.includes(idx + 1));
                    }

                    attachments = attachments.filter((_, idx) => !excludeIndices.has(idx + 1));

                    const cleanSection = (text) => {
                        return text
                            .replace(/(?:^|(?<=[\s,]))(?:-?\d+|-l)\b/gi, '')
                            .replace(/[,\s]+/g, ' ')
                            .trim();
                    };
                    beforeUrl = cleanSection(beforeUrl);
                    afterUrl = cleanSection(afterUrl);
                    cleanedRemadeContent = (beforeUrl ? beforeUrl + ' ' : '') + facebookUrl + (afterUrl ? ' ' + afterUrl : '');
                }

                // Build the link that will be embedded in the message.
                // - When yt-dlp or generic-scrape delivers the original mp4 successfully,
                //   keep the link as the ORIGINAL Facebook URL — the bot downloaded the
                //   real file, so the user does not need a fixer to view it elsewhere.
                // - When a fixer actually responded (i.e. yt-dlp + generic both failed
                //   and we used fdown.net to obtain the file), rewrite the host to that
                //   fixer so the user can re-download from the same source.
                // - When nothing worked, still try fdown.net as a last-ditch viewer hint.
                const standardUrl = facebookUrl
                    .replace(/^https?:\/\/(www\.|m\.)?facebook\.com/i, 'https://www.facebook.com')
                    .replace(/^https?:\/\/fb\.watch/i, 'https://fb.watch');
                let fallbackUrl;
                if (downloadSuccess && successfulSource !== 'fixer') {
                    // yt-dlp / generic / restricted-fallback — point at the original post.
                    fallbackUrl = standardUrl;
                } else {
                    const fallbackDomain = lastRespondingFixer || 'fdown.net';
                    fallbackUrl = facebookUrl
                        .replace(/^https?:\/\/(www\.|m\.)?facebook\.com/i, `https://${fallbackDomain}`)
                        .replace(/^https?:\/\/(www\.|m\.)?fb\.watch/i, `https://${fallbackDomain}/?url=`)
                        .replace(/^https?:\/\/fb\.watch/i, `https://${fallbackDomain}/?url=`);
                }
                const displayUrl = standardUrl.replace(/^https?:\/\//i, '');
                const fallbackContent = cleanedRemadeContent.replace(facebookUrl, `[${displayUrl}](${fallbackUrl})`);

                if (downloadSuccess) {
                    const successText = fallbackContent;
                    const privateSuppressedText = `[ПРИВАТНОЕ ВИДЕО, ДОСТУП ТОЛЬКО ПО ССЫЛКЕ]\n` + fallbackContent;
                    let currentText = attachments.isRestrictedVideoFallback ? privateSuppressedText : successText;

                    // Librarian bot has no OCR/translation pipeline: post the media and
                    // finalize the placeholder immediately (clear the ⏳ indicator).
                    await updateWorkingPlaceholder(placeholder, currentText, attachments, true, effectiveFileLimit, fallbackContent);
                    await finalizePlaceholderClean(placeholder, currentText, true);
                    job.success({ stage: 'facebook_repost', media: attachments.length, source: successfulSource });
                } else {
                    console.log(`[Facebook Interceptor] All downloads failed. Posting markdown hyperlink fallback: [${displayUrl}](${fallbackUrl})`);
                    await updateWorkingPlaceholder(placeholder, fallbackContent, [], false, 0, fallbackContent);
                    job.success({ stage: 'facebook_link_fallback', reason: 'all_downloads_failed' });
                }
            } catch (sendErr) {
                console.error('[Facebook Interceptor] Failed to send reposted message:', sendErr.message);
                job.failure(sendErr.message, { stage: 'send' });
            }
        } catch (outerErr) {
            console.error('[Facebook Interceptor] Critical error in handler:', outerErr);
            job.failure(outerErr.message, { stage: 'critical' });
        } finally {
            clearInterval(typingInterval);
            if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
        }
    }).catch(err => {
        job.failure(err.message, { stage: 'media_queue' });
        if (placeholder) {
            updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки Facebook]\n<${facebookUrl}>`, [], false, 0, facebookUrl).catch(() => {});
        }
    });
    } catch (outerErr) {
        console.error('[Facebook Interceptor] Critical error before queue:', outerErr);
        job.failure(outerErr.message, { stage: 'pre_queue_critical' });
        if (placeholder) {
            updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки Facebook]\n<${facebookUrl}>`, [], false, 0, facebookUrl).catch(() => {});
        }
    } finally {
        if (typingInterval) clearInterval(typingInterval);
        if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
    }
}

module.exports = {
    handleFacebookMessage
};