// Twitter/X embed interceptor — ported from robot-joe (minus the tweet scanner
// cron and task persistence, which the librarian bot doesn't have).
//
// When a user posts a twitter.com/x.com status link, the bot:
//   1. fetches tweet metadata via the fxtwitter API (Nitter HTML scrape fallback),
//   2. downloads all media (photos + best-quality videos),
//   3. compresses oversized videos with ffmpeg if they exceed the guild limit,
//   4. reposts the message via webhook with the media attached and the tweet
//      text quoted in a blockquote (Discord's own embed is suppressed).
//
// No translation/transcription pipeline — the librarian bot only reposts media.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { AttachmentBuilder } = require('discord.js');
const { SEARXNG_URL, FFMPEG_TIMEOUT, RAG_TYPING_INTERVAL, FILE_SIZE_SAFETY_FACTOR, DISCORD_FILE_LIMIT_TWITTER, DISCORD_FILE_LIMIT_TWITTER_HARD, PROGRESS_UPDATE_INTERVAL_MS } = require('../config');
const { getGuildFileLimit, compressVideoToFit } = require('../utils/mediaCompressor');
const { sendWorkingPlaceholder, updateWorkingPlaceholder, updatePlaceholderStage } = require('../utils/webhook');
const { inFlightPlaceholders } = require('../utils/inFlightTracker');
const mediaQueue = require('../utils/mediaQueue');
const { startJob } = require('../utils/jobLog');

function getBestVideoUrl(video, limitBytes = DISCORD_FILE_LIMIT_TWITTER) {
    if (!video.url) return null;

    const duration = video.duration || 0;
    if (duration <= 0) return video.url;

    // Estimate size of the default URL
    let defaultBitrate = 0;
    const variants = video.variants || video.formats || [];
    const mp4Variants = variants.filter(v =>
        (v.url && v.bitrate) &&
        (v.content_type === 'video/mp4' || v.container === 'mp4' || v.url.includes('.mp4'))
    );

    const defaultVariant = mp4Variants.find(v => v.url === video.url);
    if (defaultVariant) {
        defaultBitrate = defaultVariant.bitrate;
    } else {
        defaultBitrate = mp4Variants.reduce((max, v) => (v.bitrate > max ? v.bitrate : max), 0);
    }

    // Add 128kbps safety margin for audio track
    const defaultTotalBitrate = defaultBitrate + 128000;
    const estimatedDefaultSize = (defaultTotalBitrate / 8) * duration;
    if (estimatedDefaultSize <= limitBytes) {
        return video.url;
    }

    // Sort variants by bitrate descending (highest quality first)
    const sortedVariants = [...mp4Variants].sort((a, b) => b.bitrate - a.bitrate);
    for (const variant of sortedVariants) {
        const totalBitrate = variant.bitrate + 128000;
        const estimatedSize = (totalBitrate / 8) * duration;
        if (estimatedSize <= limitBytes) {
            console.log(`[Twitter Handler] Selected lower quality video variant (${variant.bitrate} bps, estimated ${Math.round(estimatedSize / 1024 / 1024)}MB with audio) to fit under ${Math.round(limitBytes / 1024 / 1024)}MB limit.`);
            return variant.url;
        }
    }

    if (sortedVariants.length > 0) {
        const lowest = sortedVariants[sortedVariants.length - 1];
        console.log(`[Twitter Handler] All video variants exceed limit. Using lowest quality variant (${lowest.bitrate} bps).`);
        return lowest.url;
    }

    return video.url;
}


async function handleTwitterMessage(client, message, twitterUrl, remadeContent, recoveredPlaceholder = null) {
    const job = startJob(message, 'handleTwitterMessage');
    const isRecovery = !!recoveredPlaceholder;
    let placeholder = null;
    let placeholderMessageId = null;
    let typingInterval = null;

    try {
        // When recovering an abandoned placeholder, reuse the existing message.
        // Otherwise create a new "working" placeholder while preserving the
        // original user message so catch-up always has a stable source context.
        if (isRecovery) {
            placeholder = recoveredPlaceholder;
            await updatePlaceholderStage(placeholder, `working... <${twitterUrl}>\nstage: recovery restart`);
        } else {
            placeholder = await sendWorkingPlaceholder(client, message, twitterUrl, remadeContent || message.content || twitterUrl);
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
        let downloadSuccess = false;
        let attachments = [];
        let quotedTweet = '';

        const fileLimit = getGuildFileLimit(message.guild);
        const effectiveFileLimit = Math.floor(fileLimit * FILE_SIZE_SAFETY_FACTOR);

        try {
            console.log(`[Twitter Interceptor] Twitter URL detected: ${twitterUrl}`);
            await updatePlaceholderStage(placeholder, `working... <${twitterUrl}>\nstage: fetching tweet metadata`);
            const tweetIdMatch = twitterUrl.match(/\/status\/(\d+)/i);
            if (!tweetIdMatch) {
                throw new Error('Could not parse tweet ID from URL');
            }
            const tweetId = tweetIdMatch[1];

            let tweet = null;

            // Primary: fxtwitter API
            try {
                const apiUrl = `https://api.fxtwitter.com/i/status/${tweetId}`;
                const response = await axios.get(apiUrl, {
                    timeout: 10000,
                    headers: {
                        'User-Agent': 'LibrarianBot/1.0 (Discord Bot)'
                    }
                });
                if (response.data && response.data.tweet) {
                    tweet = response.data.tweet;
                    console.log(`[Twitter Interceptor] Got tweet metadata from api.fxtwitter.com`);
                }
            } catch (apiErr) {
                console.warn(`[Twitter Interceptor] api.fxtwitter.com failed: ${apiErr.message}. Falling back to Nitter HTML scrape.`);
            }

            // Fallback: Nitter HTML scrape
            if (!tweet) {
                tweet = await scrapeTweetFromNitter(tweetId);
            }

            if (tweet) {
                const author = tweet.author || {};
                const authorName = author.name || 'Unknown';
                const authorHandle = author.screen_name || 'unknown';

                // Build the quote of the post
                quotedTweet = `\n> **${authorName}** (@${authorHandle}):\n`;
                if (tweet.text) {
                    const lines = tweet.text.split('\n');
                    const cleanedLines = lines.filter(line => line.trim() && !line.toLowerCase().includes('t.me'));
                    for (const line of cleanedLines) {
                        quotedTweet += `> ${line}\n`;
                    }
                }

                // If this tweet quotes another tweet (fxtwitter API exposes it
                // as tweet.quote), append the quoted tweet's author + text as a
                // nested blockquote so the quoted content is included.
                if (tweet.quote) {
                    const qAuthor = tweet.quote.author || {};
                    const qName = qAuthor.name || 'Unknown';
                    const qHandle = qAuthor.screen_name || 'unknown';
                    const qText = tweet.quote.text || '';
                    const qUrl = tweet.quote.url || (tweet.quote.id ? `https://x.com/${qHandle}/status/${tweet.quote.id}` : '');
                    quotedTweet += `>\n> > **${qName}** (@${qHandle}):\n`;
                    if (qText) {
                        const qLines = qText.split('\n').filter(l => l.trim());
                        for (const line of qLines) {
                            quotedTweet += `> > ${line}\n`;
                        }
                    }
                    if (qUrl) {
                        quotedTweet += `> > <${qUrl}>\n`;
                    }
                }

                // Gather media URLs
                const mediaUrls = [];
                if (tweet.media) {
                    if (Array.isArray(tweet.media.videos)) {
                        for (const video of tweet.media.videos) {
                            const bestUrl = getBestVideoUrl(video);
                            if (bestUrl) mediaUrls.push(bestUrl);
                        }
                    }
                    if (Array.isArray(tweet.media.photos)) {
                        for (const photo of tweet.media.photos) {
                            if (photo.url) mediaUrls.push(photo.url);
                        }
                    }
                }

                if (mediaUrls.length > 0) {
                    console.log(`[Twitter Interceptor] Downloading ${mediaUrls.length} media items...`);
                    await updatePlaceholderStage(placeholder, `working... <${twitterUrl}>\nstage: downloading media`);
                    for (let i = 0; i < mediaUrls.length; i++) {
                        const mUrl = mediaUrls[i];
                        const mediaRes = await axios.get(mUrl, {
                            responseType: 'arraybuffer',
                            timeout: 15000,
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                            }
                        });
                        const buffer = Buffer.from(mediaRes.data);
                        if (buffer.length > DISCORD_FILE_LIMIT_TWITTER_HARD) {
                            throw new Error(`File size ${buffer.length} bytes exceeds 150MB limit`);
                        }
                        const contentType = mediaRes.headers['content-type'] || '';
                        let ext = 'jpg';
                        if (contentType.includes('video/mp4')) ext = 'mp4';
                        else if (contentType.includes('image/png')) ext = 'png';
                        else if (contentType.includes('image/gif')) ext = 'gif';
                        else if (contentType.includes('video/')) ext = 'mp4';
                        else if (mUrl.includes('.mp4')) ext = 'mp4';
                        else if (mUrl.includes('.png')) ext = 'png';
                        else if (mUrl.includes('.gif')) ext = 'gif';

                        attachments.push(new AttachmentBuilder(buffer, { name: `twitter_media_${i}.${ext}` }));
                    }
                    downloadSuccess = true;
                } else {
                    downloadSuccess = true;
                }
            } else {
                throw new Error('Invalid API response structure or tweet not found');
            }
        } catch (err) {
            console.error('[Twitter Interceptor] Fetching/Scraping/Download failed:', err.message);
            downloadSuccess = false;
        }

        // --- Post-download: compress oversized videos with ffmpeg ---
        if (downloadSuccess && attachments.length > 0) {
            const needsCompression = attachments.some(att => {
                const buf = att.attachment;
                return buf && buf.length > effectiveFileLimit;
            });

            if (needsCompression) {
                await updatePlaceholderStage(placeholder, `working... <${twitterUrl}>\nstage: compressing media (ffmpeg)`);
                const compressedAttachments = [];
                for (let i = 0; i < attachments.length; i++) {
                    const att = attachments[i];
                    const buf = att.attachment;
                    const name = att.name || `twitter_media_${i}`;
                    const isVideo = name.endsWith('.mp4') || name.endsWith('.webm') || name.endsWith('.mov');

                    if (buf && buf.length > effectiveFileLimit && isVideo) {
                        console.log(`[Twitter Interceptor] Attachment ${i} (${name}) is ${(buf.length / 1024 / 1024).toFixed(1)}MB, exceeds ${(effectiveFileLimit / 1024 / 1024).toFixed(1)}MB effective limit. Compressing...`);
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
                                updatePlaceholderStage(placeholder, `working... <${twitterUrl}>\nstage: compressing media (${methodStr})${percentStr}`).catch(()=>{});
                            }
                        };

                        const result = await compressVideoToFit(buf, ext, effectiveFileLimit, FFMPEG_TIMEOUT, onProgress);
                        if (result) {
                            compressedAttachments.push(new AttachmentBuilder(result.buffer, { name: `twitter_media_${i}.${result.ext}` }));
                        } else {
                            console.log(`[Twitter Interceptor] Compression failed for attachment ${i}. Dropping oversized file.`);
                        }
                    } else {
                        compressedAttachments.push(att);
                    }
                }
                attachments = compressedAttachments;
                if (attachments.length === 0) {
                    downloadSuccess = false;
                    console.log('[Twitter Interceptor] All attachments were too large even after compression.');
                }
            }
        }

        try {
            let suppressedText = remadeContent.replace(twitterUrl, `<${twitterUrl}>`);
            let fxtUrl = twitterUrl;
            if (twitterUrl.includes('twitter.com')) {
                fxtUrl = twitterUrl.replace('twitter.com', 'fxtwitter.com');
            } else if (twitterUrl.includes('x.com')) {
                fxtUrl = twitterUrl.replace('x.com', 'fxtwitter.com');
            }
            const replacedText = remadeContent.replace(twitterUrl, fxtUrl);

            if (downloadSuccess) {
                const finalContent = suppressedText + quotedTweet;
                await updateWorkingPlaceholder(placeholder, finalContent, attachments, true, effectiveFileLimit, replacedText);
                job.success({ stage: 'twitter_repost', media: attachments.length });
            } else {
                await updateWorkingPlaceholder(placeholder, replacedText, [], false, 0, replacedText);
                job.success({ stage: 'twitter_link_fallback', reason: 'download_failed' });
            }
        } catch (sendErr) {
            console.error('[Twitter Interceptor] Failed to send reposted message:', sendErr.message);
            job.failure(sendErr.message, { stage: 'send' });
        } finally {
            clearInterval(typingInterval);
            if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
        }
    }).catch(err => {
        job.failure(err.message, { stage: 'media_queue' });
        if (placeholder) {
            updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки Twitter]\n<${twitterUrl}>`, [], false, 0, twitterUrl).catch(() => {});
        }
    });
    } catch (outerErr) {
        console.error('[Twitter Interceptor] Critical error before queue:', outerErr);
        job.failure(outerErr.message, { stage: 'pre_queue_critical' });
        if (placeholder) {
            updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки Twitter]\n<${twitterUrl}>`, [], false, 0, twitterUrl).catch(() => {});
        }
    } finally {
        if (typingInterval) clearInterval(typingInterval);
        if (placeholderMessageId) inFlightPlaceholders.delete(placeholderMessageId);
    }
}

async function scrapeTweetFromNitter(tweetId) {
    const NITTER_INSTANCES = [
        'https://nitter.net',
        'https://nitter.cz',
        'https://nitter.privacydev.net',
        'https://nitter.perennialte.ch',
        'https://nitter.poast.org'
    ];

    for (const instance of NITTER_INSTANCES) {
        try {
            const url = `${instance}/i/status/${tweetId}`;
            console.log(`[Twitter Interceptor] Trying Nitter scrape: ${url}`);
            const res = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });

            const html = res.data;
            if (!html || typeof html !== 'string' || html.includes('tweet not found') || html.includes('account suspended')) {
                console.warn(`[Twitter Interceptor] ${instance} returned invalid/not-found page`);
                continue;
            }

            // Extract author from URL redirects or meta tags
            let authorName = 'Unknown';
            let authorHandle = 'unknown';
            const authorMatch = html.match(/<meta[^>]*name="twitter:title"[^>]*content="([^"]*)"/) ||
                                html.match(/<div[^>]*class="tweet-author"[^>]*>\s*<a[^>]*href="\/([^\/]+)\/"/);
            if (authorMatch) {
                const raw = authorMatch[1];
                if (raw.startsWith('@')) {
                    authorHandle = raw.replace('@', '');
                    authorName = authorHandle;
                } else {
                    authorHandle = raw;
                }
            }

            // Extract tweet text
            let text = '';
            const textMatch = html.match(/<div[^>]*class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div class="tweet-stats/);
            if (textMatch) {
                text = textMatch[1]
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<[^>]+>/g, '')
                    .replace(/&quot;/g, '"')
                    .replace(/&amp;/g, '&')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .trim();
            } else {
                const descMatch = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/);
                if (descMatch) text = descMatch[1];
            }

            // Extract media
            const media = { photos: [], videos: [] };

            // Photos
            const photoRegex = /<img[^>]*src="(https:\/\/[^"]+)"[^>]*class="tweet-photo"/g;
            let photoMatch;
            while ((photoMatch = photoRegex.exec(html)) !== null) {
                media.photos.push({ url: photoMatch[1].replace(/&amp;/g, '&') });
            }
            // Fallback: any still-image in attachment
            const attachImgRegex = /<a[^>]*href="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"[^>]*class="attachment"/g;
            while ((photoMatch = attachImgRegex.exec(html)) !== null) {
                media.photos.push({ url: photoMatch[1].replace(/&amp;/g, '&') });
            }

            // Videos
            const videoRegex = /<source[^>]*src="(https:\/\/[^"]+\.mp4[^"]*)"[^>]*type="video\/mp4"/g;
            let videoMatch;
            while ((videoMatch = videoRegex.exec(html)) !== null) {
                media.videos.push({ url: videoMatch[1].replace(/&amp;/g, '&') });
            }
            // Fallback: direct video links in attachments
            const attachVideoRegex = /<a[^>]*href="(https:\/\/[^"]+\.mp4)"[^>]*class="attachment"/g;
            while ((videoMatch = attachVideoRegex.exec(html)) !== null) {
                media.videos.push({ url: videoMatch[1].replace(/&amp;/g, '&') });
            }

            if (!text && media.photos.length === 0 && media.videos.length === 0) {
                console.warn(`[Twitter Interceptor] ${instance} parsed no tweet content`);
                continue;
            }

            // Extract quoted tweet (Nitter renders it in a .quote block with its
            // own .tweet-content and an author link like /<handle>/status/<id>).
            let quote = null;
            const quoteBlockMatch = html.match(/<div[^>]*class="quote[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<div class="tweet-stats/);
            if (quoteBlockMatch) {
                const quoteHtml = quoteBlockMatch[1];
                // Quoted author handle + tweet id from the quote's heading link.
                const qAuthorMatch = quoteHtml.match(/<a[^>]*href="\/([^\/]+)\/status\/(\d+)"/);
                let qHandle = 'unknown';
                let qId = null;
                if (qAuthorMatch) {
                    qHandle = qAuthorMatch[1];
                    qId = qAuthorMatch[2];
                }
                // Quoted tweet text.
                let qText = '';
                const qTextMatch = quoteHtml.match(/<div[^>]*class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
                if (qTextMatch) {
                    qText = qTextMatch[1]
                        .replace(/<br\s*\/?>/gi, '\n')
                        .replace(/<[^>]+>/g, '')
                        .replace(/&quot;/g, '"')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>')
                        .trim();
                }
                if (qText || qId) {
                    quote = {
                        author: { name: qHandle, screen_name: qHandle },
                        text: qText,
                        id: qId,
                        url: qId ? `https://x.com/${qHandle}/status/${qId}` : null
                    };
                }
            }

            console.log(`[Twitter Interceptor] Nitter scrape succeeded via ${instance}`);
            const result = {
                author: { name: authorName, screen_name: authorHandle },
                text,
                media
            };
            if (quote) result.quote = quote;
            return result;
        } catch (err) {
            console.warn(`[Twitter Interceptor] Nitter instance ${instance} failed: ${err.message}`);
        }
    }
    return null;
}

module.exports = {
    handleTwitterMessage
};