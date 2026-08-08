// Telegram (t.me) embed interceptor — ported from the librarian's facebookHandler
// pattern (no OCR/Whisper transcription/translation pipeline).
//
// Download strategy (in priority order):
//   1. yt-dlp — supports t.me links, downloads the original video/photo from
//      Telegram's CDN.
//   2. Generic og:video / og:image scrape — fetches the t.me embed page HTML
//      and extracts media URLs from <meta> tags.
//
// After download we compress oversized videos with ffmpeg (same as the other
// handlers) and repost the media via webhook. No translation/transcription.
// Keeps the original post link and the video/image that was embedded.

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

const TG_SCRAPE_LABELS = {
    'ytdlp': 'yt-dlp',
    'generic': 'Generic og:video/og:image scrape',
    'restricted-fallback': 'Restricted fallback',
};

const TG_COOKIE_PATHS = [
    'telegram-cookies.txt',
    'tg-cookies.txt',
    'cookies.txt',
    'data/telegram-cookies.txt',
    'data/tg-cookies.txt',
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
        for (const name of TG_COOKIE_PATHS) {
            const p = path.join(root, name);
            if (fs.existsSync(p)) {
                return p;
            }
        }
    }
    return null;
}

// 1. yt-dlp downloader. Telegram public posts work without auth in most cases.
async function downloadWithYtDlp(url) {
    const ytDlp = findYtDlpPath();
    const tempDir = os.tmpdir();
    const prefix = `tg_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const outputPattern = path.join(tempDir, `${prefix}.%(ext)s`);

    const cookiesPath = locateCookies();
    const cookiesFlag = cookiesPath ? `--cookies "${cookiesPath}"` : '';
    if (!cookiesPath) {
        console.log(`[Telegram Interceptor] No cookies file located; yt-dlp will run unauthenticated (fine for public posts).`);
    } else {
        console.log(`[Telegram Interceptor] Passing cookies to yt-dlp from: ${cookiesPath}`);
    }

    console.log(`[Telegram Interceptor] Attempting yt-dlp download for: ${url}`);
    const cmd = `"${ytDlp}" ${cookiesFlag} --no-playlist --merge-output-format mp4 -o "${outputPattern}" "${url}"`;

    try {
        await runCommand(cmd, 45000);

        const files = fs.readdirSync(tempDir);
        const matchingFiles = files.filter(f => f.startsWith(prefix));

        if (matchingFiles.length === 0) {
            console.log('[Telegram Interceptor] yt-dlp completed but no files were found.');
            return null;
        }

        const attachments = [];
        for (const file of matchingFiles) {
            const filePath = path.join(tempDir, file);

            const buffer = fs.readFileSync(filePath);
            try { fs.unlinkSync(filePath); } catch (e) {}

            const ext = path.extname(file).substring(1) || 'mp4';
            attachments.push(new AttachmentBuilder(buffer, { name: `telegram_media_${attachments.length}.${ext}` }));
        }

        return attachments.length > 0 ? attachments : null;
    } catch (err) {
        const stderrStr = err.stderr || '';
        const stdoutStr = err.stdout || '';
        const isUnsupported = err.message.includes('Unsupported URL') || stderrStr.includes('Unsupported URL') || stdoutStr.includes('Unsupported URL');
        if (isUnsupported) {
            console.log('[Telegram Interceptor] yt-dlp: Unsupported URL (likely a private post or login wall).');
        } else {
            console.error('[Telegram Interceptor] yt-dlp download failed:', err.message);
            if (err.stderr) console.error('[Telegram Interceptor] yt-dlp stderr:', err.stderr.trim());
            if (err.stdout) console.log('[Telegram Interceptor] yt-dlp stdout:', err.stdout.trim());
        }
        try {
            const files = fs.readdirSync(tempDir);
            for (const file of files) {
                if (file.startsWith(prefix)) {
                    fs.unlinkSync(path.join(tempDir, file));
                }
            }
        } catch (cleanupErr) {
            console.error('[Telegram Interceptor] Failed to clean up temp files:', cleanupErr.message);
        }
        return null;
    }
}

// 2. Generic og:video / og:image scrape. Fetches the t.me public preview page
//    and extracts media URLs from <meta> tags.
async function downloadWithGenericScrape(telegramUrl) {
    const candidates = [
        telegramUrl,
        telegramUrl.replace(/^https?:\/\/t\.me/i, 'https://telegram.me'),
        telegramUrl + '/embed'
    ];
    for (const url of candidates) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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
                /<video[^>]+src="([^"]+\.mp4[^"]*)"/i
            ];
            let mediaUrl = null;
            let isVideo = false;
            for (const p of videoPatterns) {
                const m = html.match(p);
                if (m && m[1]) {
                    mediaUrl = m[1].replace(/&amp;/g, '&').replace(/\\\//g, '/');
                    isVideo = /(\.mp4|video)/i.test(mediaUrl);
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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
            const attachments = [new AttachmentBuilder(buffer, { name: `telegram_media_0.${ext}` })];
            if (isRestrictedVideoFallback) attachments.isRestrictedVideoFallback = true;
            return attachments;
        } catch (err) {
            console.log(`[Telegram Interceptor] Generic scrape failed for ${url}: ${err.message}`);
        }
    }
    return null;
}

// Fetch the post text (og:description) from the t.me public preview page so
// we can quote the message body.
async function fetchPostText(telegramUrl) {
    const candidates = [
        telegramUrl,
        telegramUrl + '/embed'
    ];
    for (const url of candidates) {
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5'
                },
                timeout: RAG_SEARCH_TIMEOUT,
                maxRedirects: 5,
                validateStatus: (s) => s >= 200 && s < 400
            });
            const html = response.data;
            if (typeof html !== 'string' || html.length < 200) continue;

            let channelName = '';
            const channelMatch = html.match(/<meta [^>]*property="og:title"[^>]*content="([^"]+)"/i) ||
                                 html.match(/<meta [^>]*content="([^"]+)"[^>]*property="og:title"/i);
            if (channelMatch) channelName = channelMatch[1].trim();

            let description = '';
            const descMatch = html.match(/<meta [^>]*property="og:description"[^>]*content="([^"]+)"/i) ||
                              html.match(/<meta [^>]*content="([^"]+)"[^>]*property="og:description"/i);
            if (descMatch) description = descMatch[1].trim();

            if (channelName || description) {
                return { channelName, description };
            }
        } catch (err) {
            console.log(`[Telegram Interceptor] fetchPostText failed for ${url}: ${err.message}`);
        }
    }
    return { channelName: '', description: '' };
}

// Escape Discord markdown-special characters.
function escapeMarkdown(text) {
    if (!text) return '';
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/\*/g, '\\*')
        .replace(/_/g, '\\_')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/\|/g, '\\|');
}

async function handleTelegramMessage(client, message, telegramUrl, remadeContent, recoveredPlaceholder = null) {
    const job = startJob(message, 'handleTelegramMessage');
    const isRecovery = !!recoveredPlaceholder;
    let placeholder = null;
    let placeholderMessageId = null;
    let typingInterval = null;

    try {
        if (isRecovery) {
            placeholder = recoveredPlaceholder;
            await updatePlaceholderStage(placeholder, `working... <${telegramUrl}>\nstage: recovery restart`);
        } else {
            placeholder = await sendWorkingPlaceholder(client, message, telegramUrl, remadeContent || message.content || telegramUrl);
        }

        placeholderMessageId = placeholder && placeholder.sentMsg ? placeholder.sentMsg.id : null;
        if (placeholderMessageId) inFlightPlaceholders.add(placeholderMessageId);

        // Delete the original user message so the channel doesn't show two copies
        // of the same link. Best-effort: skipped during recovery (synthetic message).
        if (!isRecovery && message.guild) {
            try {
                await message.delete();
            } catch (delErr) {
                console.error('[Telegram Interceptor] Could not delete original message (bot needs Manage Messages permission):', delErr.message);
            }
        }

        const typingChannel = placeholder.sentMsg ? placeholder.sentMsg.channel : message.channel;
        await typingChannel.sendTyping().catch(() => { });
        typingInterval = setInterval(() => {
            typingChannel.sendTyping().catch(() => { });
        }, RAG_TYPING_INTERVAL);

        mediaQueue.enqueue(async () => {
            try {
            const fileLimit = getGuildFileLimit(message.guild);
            console.log(`[Telegram Interceptor] Guild file limit: ${(fileLimit / 1024 / 1024).toFixed(0)}MB`);

            let downloadSuccess = false;
            let attachments = [];
            let successfulSource = null;
            let fallbackAttachments = null;

            // Fetch post text (og:title + og:description) for the quote block.
            await updatePlaceholderStage(placeholder, `working... <${telegramUrl}>\nstage: fetching post metadata`);
            const postMeta = await fetchPostText(telegramUrl).catch(() => ({ channelName: '', description: '' }));

            const runYtDlp = async () => {
                await updatePlaceholderStage(placeholder, `working... <${telegramUrl}>\nstage: yt-dlp direct`);
                const result = await downloadWithYtDlp(telegramUrl);
                if (result && result.length > 0) {
                    if (result.isRestrictedVideoFallback) {
                        if (!fallbackAttachments) fallbackAttachments = result;
                    } else {
                        attachments = result;
                        downloadSuccess = true;
                        successfulSource = 'ytdlp';
                        console.log(`[Telegram Interceptor] yt-dlp downloaded ${attachments.length} media item(s).`);
                    }
                }
            };

            const runGenericScrape = async () => {
                await updatePlaceholderStage(placeholder, `working... <${telegramUrl}>\nstage: generic og:video scrape`);
                const result = await downloadWithGenericScrape(telegramUrl);
                if (result && result.length > 0) {
                    if (result.isRestrictedVideoFallback) {
                        if (!fallbackAttachments) fallbackAttachments = result;
                    } else {
                        attachments = result;
                        downloadSuccess = true;
                        successfulSource = 'generic';
                        console.log(`[Telegram Interceptor] Generic scrape downloaded ${attachments.length} media item(s).`);
                    }
                }
            };

            try {
                console.log(`[Telegram Interceptor] Telegram URL detected: ${telegramUrl}`);
                await runYtDlp();
                if (!downloadSuccess) await runGenericScrape();

                if (!downloadSuccess && fallbackAttachments) {
                    attachments = fallbackAttachments;
                    downloadSuccess = true;
                    successfulSource = 'restricted-fallback';
                    console.log(`[Telegram Interceptor] Using restricted-fallback attachments.`);
                }
            } catch (err) {
                console.error('[Telegram Interceptor] All downloaders failed:', err.message);
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
                    await updatePlaceholderStage(placeholder, `working... <${telegramUrl}>\nstage: compressing media (ffmpeg)`);
                    const compressed = [];
                    for (let i = 0; i < attachments.length; i++) {
                        const att = attachments[i];
                        const buf = att.attachment;
                        const name = att.name || `telegram_media_${i}`;
                        const isVideo = name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov');

                        if (buf && buf.length > effectiveFileLimit && isVideo) {
                            console.log(`[Telegram Interceptor] Attachment ${i} (${name}) is ${(buf.length / 1024 / 1024).toFixed(1)}MB, exceeds ${(effectiveFileLimit / 1024 / 1024).toFixed(1)}MB effective limit. Compressing...`);
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
                                    updatePlaceholderStage(placeholder, `working... <${telegramUrl}>\nstage: compressing media (${methodStr})${percentStr}`).catch(()=>{});
                                }
                            };
                            const result = await compressVideoToFit(buf, ext, effectiveFileLimit, FFMPEG_TIMEOUT, onProgress);
                            if (result) {
                                compressed.push(new AttachmentBuilder(result.buffer, { name: `telegram_media_${i}.${result.ext}` }));
                            } else {
                                console.log(`[Telegram Interceptor] Compression failed for attachment ${i}; dropping oversized file.`);
                            }
                        } else {
                            compressed.push(att);
                        }
                    }
                    attachments = compressed;
                    if (attachments.length === 0) {
                        downloadSuccess = false;
                        console.log('[Telegram Interceptor] All attachments were too large even after compression.');
                    }
                }
            }

            try {
                const urlIndex = remadeContent.indexOf(telegramUrl);
                let beforeUrl = remadeContent.substring(0, urlIndex);
                let afterUrl = remadeContent.substring(urlIndex + telegramUrl.length);

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
                    cleanedRemadeContent = (beforeUrl ? beforeUrl + ' ' : '') + telegramUrl + (afterUrl ? ' ' + afterUrl : '');
                }

                const standardUrl = telegramUrl
                    .replace(/^https?:\/\/telegram\.me/i, 'https://t.me')
                    .replace(/^https?:\/\/(www\.)?t\.me/i, 'https://t.me');
                const displayUrl = standardUrl.replace(/^https?:\/\//i, '');

                // Build the quote block from the post metadata (channel name + text).
                let quoteBlock = '';
                if (postMeta.channelName || postMeta.description) {
                    const channelName = escapeMarkdown(postMeta.channelName || 'Telegram');
                    quoteBlock = `\n> **${channelName}**:\n`;
                    if (postMeta.description) {
                        const lines = postMeta.description.split('\n');
                        for (const line of lines) {
                            if (line.trim()) {
                                quoteBlock += `> ${line}\n`;
                            }
                        }
                    }
                }

                const fallbackContent = cleanedRemadeContent.replace(telegramUrl, `[${displayUrl}](${standardUrl})`) + quoteBlock;

                if (downloadSuccess) {
                    const successText = fallbackContent;
                    const privateSuppressedText = `[ПРИВАТНОЕ ВИДЕО, ДОСТУП ТОЛЬКО ПО ССЫЛКЕ]\n` + fallbackContent;
                    let currentText = attachments.isRestrictedVideoFallback ? privateSuppressedText : successText;

                    // Librarian bot has no OCR/translation pipeline: post the media and
                    // finalize the placeholder immediately (clear the ⏳ indicator).
                    await updateWorkingPlaceholder(placeholder, currentText, attachments, true, effectiveFileLimit, fallbackContent);
                    await finalizePlaceholderClean(placeholder, currentText, true);
                    job.success({ stage: 'telegram_repost', media: attachments.length, source: successfulSource });
                } else {
                    console.log(`[Telegram Interceptor] All downloads failed. Posting markdown hyperlink fallback: [${displayUrl}](${standardUrl})`);
                    await updateWorkingPlaceholder(placeholder, fallbackContent, [], false, 0, fallbackContent);
                    job.success({ stage: 'telegram_link_fallback', reason: 'all_downloads_failed' });
                }
            } catch (sendErr) {
                console.error('[Telegram Interceptor] Failed to send reposted message:', sendErr.message);
                job.failure(sendErr.message, { stage: 'send' });
            }
        } catch (outerErr) {
            console.error('[Telegram Interceptor] Critical error in handler:', outerErr);
            job.failure(outerErr.message, { stage: 'critical' });
        } finally {
            clearInterval(typingInterval);
            if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
        }
    }).catch(err => {
        job.failure(err.message, { stage: 'media_queue' });
        if (placeholder) {
            updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки Telegram]\n<${telegramUrl}>`, [], false, 0, telegramUrl).catch(() => {});
        }
    });
    } catch (outerErr) {
        console.error('[Telegram Interceptor] Critical error before queue:', outerErr);
        job.failure(outerErr.message, { stage: 'pre_queue_critical' });
        if (placeholder) {
            updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки Telegram]\n<${telegramUrl}>`, [], false, 0, telegramUrl).catch(() => {});
        }
    } finally {
        if (typingInterval) clearInterval(typingInterval);
        if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
    }
}

module.exports = {
    handleTelegramMessage
};