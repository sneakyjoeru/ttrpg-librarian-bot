const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { instagramGetUrl } = require('instagram-url-direct');
const snapinsta = require('snapinsta');
const { AttachmentBuilder } = require('discord.js');
const { RAG_TYPING_INTERVAL, FFMPEG_TIMEOUT, FILE_SIZE_SAFETY_FACTOR, PROGRESS_UPDATE_INTERVAL_MS, RAG_OLLAMA_TIMEOUT_SHORT } = require('../config');
const { sendRepostedMessage, sendWorkingPlaceholder, updateWorkingPlaceholder, updatePlaceholderStage } = require('../utils/webhook');
const { runCommand, findYtDlpPath } = require('../utils/shell');
const { getGuildFileLimit, compressVideoToFit } = require('../utils/mediaCompressor');
const mediaQueue = require('../utils/mediaQueue');
const { trackMessage } = require('../utils/messageTracker');
const { addPendingTask, removePendingTask, updatePendingTask } = require('../utils/taskPersistence');
const { detectFileType } = require('../utils/fileTypeDetector');
const { startJob } = require('../utils/jobLog');

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
                    timeout: RAG_OLLAMA_TIMEOUT_SHORT,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                const buffer = Buffer.from(response.data);

                // Use file type detection to determine the actual file type
                let ext = detectFileType(buffer) || 'jpg';
                const contentType = response.headers['content-type'] || '';

                // Override with content-type if available and more specific
                if (contentType.includes('video/mp4')) ext = 'mp4';
                else if (contentType.includes('image/png')) ext = 'png';
                else if (contentType.includes('image/gif')) ext = 'gif';
                else if (contentType.includes('video/')) ext = 'mp4';
                else if (mUrl.includes('.mp4')) ext = 'mp4';
                else if (mUrl.includes('.mov')) ext = 'mov';
                else if (mUrl.includes('.webm')) ext = 'webm';

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

        // Use file type detection to determine the actual file type
        let ext = detectFileType(buffer) || 'jpg';
        const contentType = mediaRes.headers['content-type'] || '';
        const detectedType = detectFileType(buffer);
        const isActuallyImage = detectedType && ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(detectedType);
        const isActuallyVideo = detectedType && ['mp4', 'webm', 'mov'].includes(detectedType);

        // Override with content-type if available and more specific
        if (isVideo) {
            if (contentType.includes('video/mp4')) ext = 'mp4';
            else if (contentType.includes('video/webm')) ext = 'webm';
            else if (contentType.includes('video/quicktime')) ext = 'mov';
            else ext = 'mp4'; // Default to mp4 for videos
        } else {
            if (contentType.includes('image/png')) ext = 'png';
            else if (contentType.includes('image/gif')) ext = 'gif';
            else if (contentType.includes('image/jpeg')) ext = 'jpg';
            else if (contentType.includes('image/webp')) ext = 'webp';
        }

        // Sanity check: if the fixer claimed this was a video for a Reel/TV, but the bytes are an image,
        // treat it as a restricted fallback instead of a successful video download.
        if (isReelOrTv && isVideo && isActuallyImage) {
            console.warn(`[Instagram Interceptor] ${domain} claimed video for Reel/TV but returned ${detectedType}. Treating as restricted fallback.`);
            isRestrictedVideoFallback = true;
            ext = detectedType || 'jpg';
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
    const job = startJob(message, 'handleInstagramMessage');

    // Instantly create the "working" message and delete the original message
    const placeholder = await sendWorkingPlaceholder(client, message, instagramUrl);

    const taskId = `insta_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    addPendingTask({
        id: taskId,
        type: 'instagram',
        channelId: message.channel.id,
        originalMessageId: message.id,
        originalUrl: instagramUrl,
        placeholderMessageId: placeholder.sentMsg ? placeholder.sentMsg.id : null,
        originalDeleted: false,
        startedAt: Date.now()
    });

    if (message.guild) {
        await message.delete().catch(delErr => {
            console.error('[Instagram Interceptor] Failed to delete original message:', delErr.message);
        });
        updatePendingTask(taskId, { originalDeleted: true });
    }

    // Start typing indicator
    await message.channel.sendTyping().catch(() => { });
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => { });
    }, RAG_TYPING_INTERVAL);

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

            try {
                console.log(`[Instagram Interceptor] Instagram URL detected: ${instagramUrl} (downloading from ${downloadUrl})`);

                if (isReelOrTv) {
                    await runFixers();
                    if (!downloadSuccess) {
                        console.log(`[Instagram Interceptor] Fixers failed or returned restricted fallback. Trying parallel scrapers...`);
                        await runParallelScrapers();
                    }
                } else {
                    await runParallelScrapers();
                    if (!downloadSuccess) {
                        console.log(`[Instagram Interceptor] Parallel scrapers failed. Falling back to fixers...`);
                        await runFixers();
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
            // Use 97% of file limit as effective cap to account for Discord multipart overhead
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
                            const onProgress = (info) => {
                                const now = Date.now();
                                if (now - lastUpdate >= PROGRESS_UPDATE_INTERVAL_MS) {
                                    lastUpdate = now;
                                    const methodStr = info.stage === 'network' ? 'NAS iGPU' : 'local CPU';
                                    const percentStr = info.percent !== undefined ? ` - ${info.percent}%` : '';
                                    updatePlaceholderStage(placeholder, `working... <${instagramUrl}>\nstage: compressing media (${methodStr})${percentStr}`).catch(()=>{});
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
                    job.success({ stage: 'instagram_repost' });
                } else {
                    console.log(`[Instagram Interceptor] All downloads failed. Posting markdown hyperlink for Discord embed: [${displayUrl}](${fallbackUrl})`);
                    await updateWorkingPlaceholder(placeholder, fallbackContent, [], false, 0, fallbackContent);
                    job.success({ stage: 'instagram_link_fallback', reason: 'all_downloads_failed' });
                }
            } catch (sendErr) {
                console.error('[Instagram Interceptor] Failed to send reposted message:', sendErr.message);
                job.failure(sendErr.message, { stage: 'send' });
            }
        } catch (outerErr) {
            console.error('[Instagram Interceptor] Critical error in handler:', outerErr);
            job.failure(outerErr.message, { stage: 'critical' });
        } finally {
            clearInterval(typingInterval);
            removePendingTask(taskId);
        }
    }).catch(err => {
        job.failure(err.message, { stage: 'media_queue' });
    });
}

module.exports = {
    handleInstagramMessage,
    sendRepostedMessage
};
