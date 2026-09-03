// TikTok embed interceptor — ported from robot-joe's tiktokHandler (minus the
// OCR/Whisper transcription/translation pipeline, task persistence, and
// active-jobs registry, which the librarian bot doesn't have). Handles
// tiktok.com/@user/video|photo/<id>, tiktok.com/t/<code>, and vm./vt. short
// share links.
//
// Download strategy (in priority order):
//   1. tikwm.com public API — watermark-free mp4 AND full photo carousels;
//      resolves short share links server-side
//   2. yt-dlp (reliable for plain videos; photo posts are hit-or-miss)
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
const TT_SCRAPE_LABELS = {
    'tikwm': 'tikwm.com API',
    'ytdlp': 'yt-dlp',
    'generic': 'Generic og:video/og:image scrape',
    'restricted-fallback': 'Restricted fallback',
};

// Cookie files that yt-dlp may want for TikTok (rarely required for public
// content, but kept in case the user adds authenticated cookies later).
const TT_COOKIE_PATHS = [
    'tiktok-cookies.txt',
    'tt-cookies.txt',
    'cookies.txt',
    'data/tiktok-cookies.txt',
    'data/tt-cookies.txt',
    'data/cookies.txt'
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
        for (const name of TT_COOKIE_PATHS) {
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
    const prefix = `tt_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const outputPattern = path.join(tempDir, `${prefix}.%(ext)s`);

    const cookiesPath = locateCookies();
    const cookiesFlag = cookiesPath ? `--cookies "${cookiesPath}"` : '';
    if (!cookiesPath) {
        console.log(`[TikTok Interceptor] No cookies file located; yt-dlp will run unauthenticated (fine for public posts).`);
    } else {
        console.log(`[TikTok Interceptor] Passing cookies to yt-dlp from: ${cookiesPath}`);
    }

    console.log(`[TikTok Interceptor] Attempting yt-dlp download for: ${url}`);
    // No --max-filesize: download any size, compression will be attempted later if needed
    const cmd = `"${ytDlp}" ${cookiesFlag} --no-playlist --merge-output-format mp4 -o "${outputPattern}" "${url}"`;

    try {
        await runCommand(cmd, 45000); // 45s — FB downloads occasionally take longer than IG

        const files = fs.readdirSync(tempDir);
        const matchingFiles = files.filter(f => f.startsWith(prefix));

        if (matchingFiles.length === 0) {
            console.log('[TikTok Interceptor] yt-dlp completed but no files were found.');
            return null;
        }

        const attachments = [];
        for (const file of matchingFiles) {
            const filePath = path.join(tempDir, file);

            const buffer = fs.readFileSync(filePath);
            try { fs.unlinkSync(filePath); } catch (e) {}

            const ext = path.extname(file).substring(1) || 'mp4';
            attachments.push(new AttachmentBuilder(buffer, { name: `tiktok_media_${attachments.length}.${ext}` }));
        }

        return attachments.length > 0 ? attachments : null;
    } catch (err) {
        const stderrStr = err.stderr || '';
        const stdoutStr = err.stdout || '';
        const isUnsupported = err.message.includes('Unsupported URL') || stderrStr.includes('Unsupported URL') || stdoutStr.includes('Unsupported URL');
        if (isUnsupported) {
            console.log('[TikTok Interceptor] yt-dlp: Unsupported URL (likely a private post or login wall).');
        } else {
            console.error('[TikTok Interceptor] yt-dlp download failed:', err.message);
            if (err.stderr) console.error('[TikTok Interceptor] yt-dlp stderr:', err.stderr.trim());
            if (err.stdout) console.log('[TikTok Interceptor] yt-dlp stdout:', err.stdout.trim());
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
            console.error('[TikTok Interceptor] Failed to clean up temp files:', cleanupErr.message);
        }
        return null;
    }
}

// 2. tikwm.com public API. The most reliable TikTok source: returns the
//    watermark-free mp4 for videos and the full image list for photo
//    carousels, and resolves vm./vt./t/ short share links server-side.
async function downloadWithTikwm(tiktokUrl) {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}&hd=1`;
    console.log(`[TikTok Interceptor] Querying tikwm.com API for: ${tiktokUrl}`);
    let data;
    try {
        const response = await axios.get(apiUrl, {
            timeout: RAG_SEARCH_TIMEOUT,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Accept': 'application/json'
            }
        });
        if (!response.data || response.data.code !== 0 || !response.data.data) {
            console.log(`[TikTok Interceptor] tikwm.com API returned no data (code=${response.data && response.data.code}, msg=${response.data && response.data.msg}).`);
            return null;
        }
        data = response.data.data;
    } catch (err) {
        console.log(`[TikTok Interceptor] tikwm.com API request failed: ${err.message}`);
        return null;
    }

    const downloadBinary = async (mediaUrl) => {
        const res = await axios.get(mediaUrl, {
            responseType: 'arraybuffer',
            timeout: RAG_OLLAMA_TIMEOUT_SHORT,
            maxRedirects: 5,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
                'Referer': 'https://www.tikwm.com/'
            }
        });
        return Buffer.from(res.data);
    };

    const attachments = [];
    try {
        if (Array.isArray(data.images) && data.images.length > 0) {
            console.log(`[TikTok Interceptor] tikwm.com resolved a photo carousel with ${data.images.length} image(s).`);
            for (const imgUrl of data.images) {
                try {
                    const buffer = await downloadBinary(imgUrl);
                    const ext = detectFileType(buffer) || 'jpg';
                    attachments.push(new AttachmentBuilder(buffer, { name: `tiktok_media_${attachments.length}.${ext}` }));
                } catch (imgErr) {
                    console.warn(`[TikTok Interceptor] tikwm.com image download failed (${imgErr.message}), continuing with the rest.`);
                }
            }
        } else {
            let videoUrl = data.hdplay || data.play || data.wmplay;
            if (!videoUrl) {
                console.log('[TikTok Interceptor] tikwm.com response contains neither images nor a video URL.');
                return null;
            }
            if (videoUrl.startsWith('/')) videoUrl = `https://www.tikwm.com${videoUrl}`;
            console.log(`[TikTok Interceptor] tikwm.com resolved video URL (${data.hdplay ? 'hd' : data.play ? 'sd' : 'watermarked'}).`);
            const buffer = await downloadBinary(videoUrl);
            const ext = detectFileType(buffer) || 'mp4';
            attachments.push(new AttachmentBuilder(buffer, { name: `tiktok_media_0.${ext}` }));
        }
    } catch (dlErr) {
        console.error(`[TikTok Interceptor] tikwm.com media download failed:`, dlErr.message);
        return attachments.length > 0 ? attachments : null;
    }
    return attachments.length > 0 ? attachments : null;
}

// 3. Generic og:video / og:image scrape. Used as a last-resort when tikwm and
//    yt-dlp both fail. We hit tiktok.com directly and follow redirect chains
//    (short vm./vt./t/ share links redirect to the canonical post URL).
async function downloadWithGenericScrape(tiktokUrl) {
    const candidates = [
        tiktokUrl,
        tiktokUrl.replace(/^https?:\/\/(?:www\.)?tiktok\.com/i, 'https://www.tiktok.com')
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
                    'Referer': 'https://www.tiktok.com/'
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
            const attachments = [new AttachmentBuilder(buffer, { name: `tiktok_media_0.${ext}` })];
            if (isRestrictedVideoFallback) attachments.isRestrictedVideoFallback = true;
            return attachments;
        } catch (err) {
            console.log(`[TikTok Interceptor] Generic scrape failed for ${url}: ${err.message}`);
        }
    }
    return null;
}

async function handleTiktokMessage(client, message, tiktokUrl, remadeContent, recoveredPlaceholder = null) {
    const job = startJob(message, 'handleTiktokMessage');
    const isRecovery = !!recoveredPlaceholder;
    let placeholder = null;
    let placeholderMessageId = null;
    let typingInterval = null;

    try {
        if (isRecovery) {
            placeholder = recoveredPlaceholder;
            await updatePlaceholderStage(placeholder, `working... <${tiktokUrl}>\nstage: recovery restart`);
        } else {
            placeholder = await sendWorkingPlaceholder(client, message, tiktokUrl, remadeContent || message.content || tiktokUrl);
        }

        placeholderMessageId = placeholder && placeholder.sentMsg ? placeholder.sentMsg.id : null;
        if (placeholderMessageId) inFlightPlaceholders.add(placeholderMessageId);

        // Delete the original user message so the channel doesn't show two copies
        // of the same link. Best-effort: skipped during recovery (synthetic message).
        if (!isRecovery && message.guild) {
            try {
                await message.delete();
            } catch (delErr) {
                console.error('[TikTok Interceptor] Could not delete original message (bot needs Manage Messages permission):', delErr.message);
            }
        }

        // Start typing indicator on the correct channel
        const typingChannel = placeholder.sentMsg ? placeholder.sentMsg.channel : message.channel;
        await typingChannel.sendTyping().catch(() => { });
        typingInterval = setInterval(() => {
            typingChannel.sendTyping().catch(() => { });
        }, RAG_TYPING_INTERVAL);

        mediaQueue.enqueue(async () => {
            try {
            const fileLimit = getGuildFileLimit(message.guild);
            console.log(`[TikTok Interceptor] Guild file limit: ${(fileLimit / 1024 / 1024).toFixed(0)}MB`);

            let downloadSuccess = false;
            let attachments = [];
            let successfulSource = null; // 'tikwm' | 'ytdlp' | 'generic' | 'restricted-fallback'
            let fallbackAttachments = null;

            const runTikwm = async () => {
                try {
                    await updatePlaceholderStage(placeholder, `working... <${tiktokUrl}>\nstage: tikwm.com API fetch`);
                    const result = await downloadWithTikwm(tiktokUrl);
                    if (result && result.length > 0) {
                        if (result.isRestrictedVideoFallback) {
                            if (!fallbackAttachments) fallbackAttachments = result;
                        } else {
                            attachments = result;
                            downloadSuccess = true;
                            successfulSource = 'tikwm';
                            console.log(`[TikTok Interceptor] tikwm.com resolved ${attachments.length} media item(s).`);
                        }
                    }
                } catch (tikwmErr) {
                    console.error('[TikTok Interceptor] tikwm.com failed:', tikwmErr.message);
                }
            };

            const runYtDlp = async () => {
                await updatePlaceholderStage(placeholder, `working... <${tiktokUrl}>\nstage: yt-dlp direct`);
                const result = await downloadWithYtDlp(tiktokUrl);
                if (result && result.length > 0) {
                    if (result.isRestrictedVideoFallback) {
                        if (!fallbackAttachments) fallbackAttachments = result;
                    } else {
                        attachments = result;
                        downloadSuccess = true;
                        successfulSource = 'ytdlp';
                        console.log(`[TikTok Interceptor] yt-dlp downloaded ${attachments.length} media item(s).`);
                    }
                }
            };

            const runGenericScrape = async () => {
                await updatePlaceholderStage(placeholder, `working... <${tiktokUrl}>\nstage: generic og:video scrape`);
                const result = await downloadWithGenericScrape(tiktokUrl);
                if (result && result.length > 0) {
                    if (result.isRestrictedVideoFallback) {
                        if (!fallbackAttachments) fallbackAttachments = result;
                    } else {
                        attachments = result;
                        downloadSuccess = true;
                        successfulSource = 'generic';
                        console.log(`[TikTok Interceptor] Generic scrape downloaded ${attachments.length} media item(s).`);
                    }
                }
            };

            try {
                console.log(`[TikTok Interceptor] TikTok URL detected: ${tiktokUrl}`);
                // tikwm.com is the most reliable TikTok source (watermark-free
                // mp4, full photo carousels, resolves short share links);
                // yt-dlp covers plain videos when tikwm is down; the generic
                // og: scrape usually only yields the poster image.
                await runTikwm();
                if (!downloadSuccess) await runYtDlp();
                if (!downloadSuccess) await runGenericScrape();

                if (!downloadSuccess && fallbackAttachments) {
                    attachments = fallbackAttachments;
                    downloadSuccess = true;
                    successfulSource = 'restricted-fallback';
                    console.log(`[TikTok Interceptor] Using restricted-fallback attachments.`);
                }
            } catch (err) {
                console.error('[TikTok Interceptor] All downloaders failed:', err.message);
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
                    await updatePlaceholderStage(placeholder, `working... <${tiktokUrl}>\nstage: compressing media (ffmpeg)`);
                    const compressed = [];
                    for (let i = 0; i < attachments.length; i++) {
                        const att = attachments[i];
                        const buf = att.attachment;
                        const name = att.name || `tiktok_media_${i}`;
                        const isVideo = name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov');

                        if (buf && buf.length > effectiveFileLimit && isVideo) {
                            console.log(`[TikTok Interceptor] Attachment ${i} (${name}) is ${(buf.length / 1024 / 1024).toFixed(1)}MB, exceeds ${(effectiveFileLimit / 1024 / 1024).toFixed(1)}MB effective limit. Compressing...`);
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
                                    updatePlaceholderStage(placeholder, `working... <${tiktokUrl}>\nstage: compressing media (${methodStr})${percentStr}`).catch(()=>{});
                                }
                            };
                            const result = await compressVideoToFit(buf, ext, effectiveFileLimit, FFMPEG_TIMEOUT, onProgress);
                            if (result) {
                                compressed.push(new AttachmentBuilder(result.buffer, { name: `tiktok_media_${i}.${result.ext}` }));
                            } else {
                                console.log(`[TikTok Interceptor] Compression failed for attachment ${i}; dropping oversized file.`);
                            }
                        } else {
                            compressed.push(att);
                        }
                    }
                    attachments = compressed;
                    if (attachments.length === 0) {
                        downloadSuccess = false;
                        console.log('[TikTok Interceptor] All attachments were too large even after compression.');
                    }
                }
            }

            try {
                // Media index selection (shared engine ported from discord-joe:
                // +N/N, -N, -l/-л/-п, N-M and comparison ranges, with sentence
                // guards for bare numbers/ranges). See utils/mediaSelectors.js.
                const { applyIndexSelection } = require('../utils/mediaSelectors');
                let cleanedRemadeContent = remadeContent;
                if (downloadSuccess) {
                    const sel = applyIndexSelection(remadeContent, tiktokUrl, attachments);
                    attachments = sel.attachments;
                    cleanedRemadeContent = sel.cleanedRemadeContent;
                }

                // Build the link that will be embedded in the message.
                // - When yt-dlp or generic-scrape delivers the original mp4 successfully,
                //   keep the link as the ORIGINAL Facebook URL — the bot downloaded the
                //   real file, so the user does not need a fixer to view it elsewhere.
                // TikTok has no fixer-domain rewrite: the link always points
                // at the original post (short vm./vt./t/ share links are kept
                // as-is — they redirect to the canonical post).
                const standardUrl = tiktokUrl
                    .replace(/^https?:\/\/(?:m\.)?tiktok\.com/i, 'https://www.tiktok.com');
                const fallbackUrl = standardUrl;
                const displayUrl = standardUrl.replace(/^https?:\/\//i, '');
                const fallbackContent = cleanedRemadeContent.replace(tiktokUrl, `[${displayUrl}](${fallbackUrl})`);

                if (downloadSuccess) {
                    const successText = fallbackContent;
                    const privateSuppressedText = `[ПРИВАТНОЕ ВИДЕО, ДОСТУП ТОЛЬКО ПО ССЫЛКЕ]\n` + fallbackContent;
                    let currentText = attachments.isRestrictedVideoFallback ? privateSuppressedText : successText;

                    // Librarian bot has no OCR/translation pipeline: post the media and
                    // finalize the placeholder immediately (clear the ⏳ indicator).
                    await updateWorkingPlaceholder(placeholder, currentText, attachments, true, effectiveFileLimit, fallbackContent);
                    await finalizePlaceholderClean(placeholder, currentText, true);
                    job.success({ stage: 'tiktok_repost', media: attachments.length, source: successfulSource });
                } else if (placeholder && placeholder.sentMsg && placeholder.sentMsg.attachments && placeholder.sentMsg.attachments.size > 0) {
                    // Download failed but the message ALREADY carries media (e.g.
                    // /process re-run while the source is unavailable). Never
                    // replace existing media with a bare link — keep the post as
                    // is and just clear the working indicator.
                    console.log('[TikTok Interceptor] Downloads failed but the existing message already has media — keeping it untouched.');
                    const keepContent = placeholder.baseText || cleanedRemadeContent || '';
                    await finalizePlaceholderClean(placeholder, keepContent, true).catch(() => {});
                    job.success({ stage: 'tiktok_kept_existing_media', reason: 'all_downloads_failed' });
                } else {
                    console.log(`[TikTok Interceptor] All downloads failed. Posting markdown hyperlink fallback: [${displayUrl}](${fallbackUrl})`);
                    await updateWorkingPlaceholder(placeholder, fallbackContent, [], false, 0, fallbackContent);
                    job.success({ stage: 'tiktok_link_fallback', reason: 'all_downloads_failed' });
                }
            } catch (sendErr) {
                console.error('[TikTok Interceptor] Failed to send reposted message:', sendErr.message);
                job.failure(sendErr.message, { stage: 'send' });
            }
        } catch (outerErr) {
            console.error('[TikTok Interceptor] Critical error in handler:', outerErr);
            job.failure(outerErr.message, { stage: 'critical' });
        } finally {
            clearInterval(typingInterval);
            if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
        }
    }).catch(err => {
        job.failure(err.message, { stage: 'media_queue' });
        if (placeholder) {
            updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки TikTok]\n<${tiktokUrl}>`, [], false, 0, tiktokUrl).catch(() => {});
        }
    });
    } catch (outerErr) {
        console.error('[TikTok Interceptor] Critical error before queue:', outerErr);
        job.failure(outerErr.message, { stage: 'pre_queue_critical' });
        if (placeholder) {
            updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки TikTok]\n<${tiktokUrl}>`, [], false, 0, tiktokUrl).catch(() => {});
        }
    } finally {
        if (typingInterval) clearInterval(typingInterval);
        if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
    }
}

module.exports = {
    handleTiktokMessage
};