const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cron = require('node-cron');
const { AttachmentBuilder } = require('discord.js');
const { SEARXNG_URL, FFMPEG_TIMEOUT, RAG_TYPING_INTERVAL, RAG_OLLAMA_TIMEOUT_SHORT, FILE_SIZE_SAFETY_FACTOR, DISCORD_FILE_LIMIT_TWITTER, DISCORD_FILE_LIMIT_TWITTER_HARD, PROGRESS_UPDATE_INTERVAL_MS, TWEETS_CACHE_PATH } = require('../config');
const { getGuildFileLimit, compressVideoToFit } = require('../utils/mediaCompressor');
const { sendWorkingPlaceholder, updateWorkingPlaceholder, updatePlaceholderStage } = require('../utils/webhook');
const mediaQueue = require('../utils/mediaQueue');
const { addPendingTask, removePendingTask, updatePendingTask } = require('../utils/taskPersistence');
const { startJob } = require('../utils/jobLog');

let scannerStartTime = Date.now();

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


async function handleTwitterMessage(client, message, twitterUrl, remadeContent) {
    const job = startJob(message, 'handleTwitterMessage');
    const taskId = `twitter_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    addPendingTask({
        id: taskId,
        type: 'twitter',
        channelId: message.channel.id,
        originalMessageId: message.id,
        originalUrl: twitterUrl,
        placeholderMessageId: null,
        originalDeleted: false,
        startedAt: Date.now()
    });

    // Instantly create the "working" message and delete the original message
    const placeholder = await sendWorkingPlaceholder(client, message, twitterUrl);
    updatePendingTask(taskId, { placeholderMessageId: placeholder.sentMsg ? placeholder.sentMsg.id : null });

    if (message.guild) {
        await message.delete().catch(delErr => {
            console.error('[Twitter Interceptor] Failed to delete original message:', delErr.message);
        });
        updatePendingTask(taskId, { originalDeleted: true });
    }

    // Start typing indicator
    await message.channel.sendTyping().catch(() => { });
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => { });
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
                        'User-Agent': 'RobotJoeBot/1.0 (Discord Bot)'
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
                                const methodStr = info.stage === 'network' ? 'NAS iGPU' : 'local CPU';
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
            removePendingTask(taskId);
        }
    }).catch(err => {
        job.failure(err.message, { stage: 'media_queue' });
    });
}

function loadSeenTweets() {
    try {
        if (fs.existsSync(TWEETS_CACHE_PATH)) {
            const data = JSON.parse(fs.readFileSync(TWEETS_CACHE_PATH, 'utf8'));
            if (Array.isArray(data)) {
                const maxId = data.reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max), '0');
                return { ids: data, maxId };
            }
            return data;
        }
    } catch (e) {
        console.error('[Twitter Scanner] Failed to load seen tweets:', e.message);
    }
    return { ids: [], maxId: '0' };
}

function saveSeenTweets(seenData) {
    try {
        if (seenData.ids.length > 200) {
            seenData.ids = seenData.ids.slice(-200);
        }
        fs.writeFileSync(TWEETS_CACHE_PATH, JSON.stringify(seenData, null, 2), 'utf8');
    } catch (e) {
        console.error('[Twitter Scanner] Failed to save seen tweets:', e.message);
    }
}

async function postTweetToChannel(clientInstance, tweet, attachments) {
    try {
        // The Discord channel ID where new tweets detected by the scanner are automatically posted.
        const channelId = '1400520169016660150';
        const channel = await clientInstance.channels.fetch(channelId);
        if (!channel) {
            console.error(`[Twitter Scanner] Channel ${channelId} not found`);
            return;
        }

        let tweetText = tweet.text || '';
        const lines = tweetText.split('\n');
        const cleanedLines = lines.filter(line => line.trim() && !line.toLowerCase().includes('t.me'));

        const author = tweet.author || {};
        let quotedTweet = `> **${author.name || 'Patrick Bateman'}** (@${author.screen_name || 'bateman_pa12732'}):\n`;
        for (const line of cleanedLines) {
            quotedTweet += `> ${line}\n`;
        }

        const finalContent = `<${tweet.url || `https://x.com/bateman_pa12732/status/${tweet.id}`}> \n${quotedTweet}`;

        let sent = false;
        if (channel.fetchWebhooks) {
            try {
                const webhooks = await channel.fetchWebhooks();
                let webhook = webhooks.find(wh => wh.owner && wh.owner.id === clientInstance.user.id);
                if (!webhook) {
                    webhook = await channel.createWebhook({
                        name: 'Robot Joe',
                        avatar: clientInstance.user.displayAvatarURL()
                    });
                }
                const options = {
                    content: finalContent,
                    username: author.name || 'Patrick Bateman',
                    avatarURL: author.avatar_url || undefined,
                    files: attachments
                };
                await webhook.send(options);
                sent = true;
            } catch (whErr) {
                console.error('[Twitter Scanner] Failed to send via webhook:', whErr.message);
            }
        }

        if (!sent) {
            await channel.send({
                content: finalContent,
                files: attachments
            });
        }
        console.log(`[Twitter Scanner] Posted tweet to channel ${channelId}`);
    } catch (e) {
        console.error('[Twitter Scanner] Error posting tweet to channel:', e.message);
    }
}

async function getTweetsFromNitterRss(username) {
    try {
        console.log('[Twitter Scanner] Fetching Nitter instances from status.d420.de...');
        const res = await axios.get('https://status.d420.de/api/v1/instances', { timeout: 8000 });
        if (!res.data || !Array.isArray(res.data.hosts)) {
            throw new Error('Invalid response from status.d420.de');
        }

        const rssHosts = res.data.hosts
            .filter(h => h.healthy && h.rss)
            .sort((a, b) => (a.ping_avg || 9999) - (b.ping_avg || 9999));

        console.log(`[Twitter Scanner] Found ${rssHosts.length} healthy RSS-enabled Nitter hosts.`);

        for (const host of rssHosts) {
            const instanceUrl = host.url;
            console.log(`[Twitter Scanner] Trying Nitter instance: ${instanceUrl}`);
            try {
                const rssUrl = `${instanceUrl}/${username}/rss`;
                const rssRes = await axios.get(rssUrl, {
                    timeout: 8000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });

                const data = rssRes.data;
                if (typeof data === 'string' && data.includes('<rss') && !data.includes('not yet whitelist') && !data.includes('not you\'re not a bot')) {
                    console.log(`[Twitter Scanner] Success! Fetched RSS feed from ${instanceUrl}`);
                    
                    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
                    let match;
                    const tweets = [];
                    while ((match = itemRegex.exec(data)) !== null) {
                        const itemContent = match[1];
                        const linkMatch = itemContent.match(/<link>([\s\S]*?)<\/link>/) || itemContent.match(/<guid>([\s\S]*?)<\/guid>/);
                        if (linkMatch) {
                            const link = linkMatch[1].trim();
                            const idMatch = link.match(/\/status\/(\d+)/);
                            if (idMatch) {
                                const tweetId = idMatch[1];
                                const url = `https://x.com/${username}/status/${tweetId}`;
                                tweets.push({ id: tweetId, url });
                            }
                        }
                    }
                    if (tweets.length > 0) {
                        return tweets;
                    }
                } else {
                    console.warn(`[Twitter Scanner] Invalid/blocked response from ${instanceUrl}`);
                }
            } catch (err) {
                console.warn(`[Twitter Scanner] Instance ${instanceUrl} failed: ${err.message}`);
            }
        }
    } catch (e) {
        console.warn('[Twitter Scanner] Error during Nitter RSS fetch:', e.message);
    }
    return null;
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

            console.log(`[Twitter Interceptor] Nitter scrape succeeded via ${instance}`);
            return {
                author: { name: authorName, screen_name: authorHandle },
                text,
                media
            };
        } catch (err) {
            console.warn(`[Twitter Interceptor] Nitter instance ${instance} failed: ${err.message}`);
        }
    }
    return null;
}

async function scanUserTweets(clientInstance) {
    try {
        // Scan user tweets for the target Twitter handle 'bateman_pa12732'.
        let tweets = await getTweetsFromNitterRss('bateman_pa12732');
        let sourceUsed = 'Nitter RSS';

        if (!tweets) {
            console.log('[Twitter Scanner] Nitter RSS failed. Falling back to SearXNG...');
            // Fallback query to discover recent tweets via SearXNG search proxy.
            const query = 'site:x.com/bateman_pa12732/status/';
            const res = await axios.get(SEARXNG_URL, {
                params: {
                    q: query,
                    format: 'json'
                },
                timeout: 10000
            });

            if (!res.data || !Array.isArray(res.data.results)) {
                console.warn('[Twitter Scanner] No results or invalid response from SearXNG');
                return;
            }

            tweets = [];
            for (const result of res.data.results) {
                const url = result.url || '';
                const match = url.match(/\/status\/(\d+)/i);
                if (match) {
                    tweets.push({ id: match[1], url });
                }
            }
            sourceUsed = 'SearXNG';
        }

        if (tweets.length === 0) {
            console.log(`[Twitter Scanner] No tweets found from ${sourceUsed}`);
            return;
        }

        const seenData = loadSeenTweets();
        const isFirstRun = seenData.ids.length === 0 && seenData.maxId === '0';

        const newTweets = [];
        const allFoundIds = [];

        for (const tweet of tweets) {
            const tweetId = tweet.id;
            allFoundIds.push(tweetId);
            if (BigInt(tweetId) > BigInt(seenData.maxId) && !seenData.ids.includes(tweetId)) {
                newTweets.push(tweet);
            }
        }

        if (isFirstRun) {
            const maxId = allFoundIds.reduce((max, id) => (BigInt(id) > BigInt(max) ? id : max), '0');
            console.log(`[Twitter Scanner] First run. Caching ${allFoundIds.length} existing tweets without posting.`);
            saveSeenTweets({ ids: allFoundIds, maxId });
            return;
        }

        if (newTweets.length > 0) {
            newTweets.sort((a, b) => {
                if (a.id.length !== b.id.length) {
                    return a.id.length - b.id.length;
                }
                return a.id.localeCompare(b.id);
            });

            console.log(`[Twitter Scanner] Found ${newTweets.length} new tweets. Processing...`);

            for (const newTweet of newTweets) {
                const tweetId = newTweet.id;
                try {
                    let tweet = null;

                    try {
                        const apiUrl = `https://api.fxtwitter.com/i/status/${tweetId}`;
                        const response = await axios.get(apiUrl, {
                            timeout: RAG_OLLAMA_TIMEOUT_SHORT,
                            headers: {
                                'User-Agent': 'RobotJoeBot/1.0 (Discord Bot)'
                            }
                        });
                        if (response.data && response.data.tweet) {
                            tweet = response.data.tweet;
                        }
                    } catch (apiErr) {
                        console.warn(`[Twitter Scanner] api.fxtwitter.com failed for ${tweetId}: ${apiErr.message}. Falling back to Nitter HTML scrape.`);
                    }

                    if (!tweet) {
                        tweet = await scrapeTweetFromNitter(tweetId);
                    }

                    if (!tweet) {
                        console.warn(`[Twitter Scanner] Could not fetch tweet ${tweetId} from any source`);
                        continue;
                    }

                    const createdTimestampMs = tweet.created_timestamp ? tweet.created_timestamp * 1000 : (tweet.created_at ? Date.parse(tweet.created_at) : 0);
                    if (tweet) {
                        if (createdTimestampMs && createdTimestampMs < scannerStartTime) {
                            console.log(`[Twitter Scanner] Skipping tweet ${tweetId} because it was posted before bot startup (${new Date(createdTimestampMs).toISOString()} < ${new Date(scannerStartTime).toISOString()})`);
                            const currentSeen = loadSeenTweets();
                            currentSeen.ids.push(tweetId);
                            if (BigInt(tweetId) > BigInt(currentSeen.maxId)) {
                                currentSeen.maxId = tweetId;
                            }
                            saveSeenTweets(currentSeen);
                            continue;
                        }

                        if (tweet.replying_to) {
                            console.log(`[Twitter Scanner] Skipping reply tweet ${tweetId} (replying to @${tweet.replying_to})`);
                            const currentSeen = loadSeenTweets();
                            currentSeen.ids.push(tweetId);
                            if (BigInt(tweetId) > BigInt(currentSeen.maxId)) {
                                currentSeen.maxId = tweetId;
                            }
                            saveSeenTweets(currentSeen);
                            continue;
                        }

                        const mediaUrls = [];
                        if (tweet.media) {
                            if (Array.isArray(tweet.media.all)) {
                                for (const m of tweet.media.all) {
                                    if (m.type === 'video' || m.variants || m.formats) {
                                        const bestUrl = getBestVideoUrl(m);
                                        if (bestUrl) mediaUrls.push(bestUrl);
                                    } else {
                                        if (m.url) mediaUrls.push(m.url);
                                    }
                                }
                            } else {
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
                        }

                        const attachments = [];
                        for (let i = 0; i < mediaUrls.length; i++) {
                            try {
                                const mUrl = mediaUrls[i];
                                const mediaRes = await axios.get(mUrl, {
                                    responseType: 'arraybuffer',
                                    timeout: RAG_OLLAMA_TIMEOUT_SHORT,
                                    headers: {
                                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                                    }
                                });
                                const buffer = Buffer.from(mediaRes.data);
                                if (buffer.length <= DISCORD_FILE_LIMIT_TWITTER) {
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
                            } catch (downloadErr) {
                                console.error(`[Twitter Scanner] Failed to download media item ${mediaUrls[i]}:`, downloadErr.message);
                            }
                        }

                        await postTweetToChannel(clientInstance, tweet, attachments);

                        const currentSeen = loadSeenTweets();
                        currentSeen.ids.push(tweetId);
                        if (BigInt(tweetId) > BigInt(currentSeen.maxId)) {
                            currentSeen.maxId = tweetId;
                        }
                        saveSeenTweets(currentSeen);
                    } else {
                        console.error(`[Twitter Scanner] Invalid API structure for tweet ${tweetId}`);
                    }
                } catch (err) {
                    console.error(`[Twitter Scanner] Failed to process new tweet ${tweetId}:`, err.message);
                }
            }
        }
    } catch (e) {
        console.error('[Twitter Scanner] Error scanning user tweets:', e.message);
    }
}

function startTwitterScanner(clientInstance) {
    console.log('[Twitter Scanner] Starting Twitter scanner for bateman_pa12732...');

    // Run scanner immediately on startup
    scanUserTweets(clientInstance).catch(err => {
        console.error('[Twitter Scanner] Initial scan failed:', err.message);
    });

    // Schedule to run every 10 minutes
    cron.schedule('*/10 * * * *', () => {
        console.log('[Twitter Scanner] Triggering periodic scan...');
        scanUserTweets(clientInstance).catch(err => {
            console.error('[Twitter Scanner] Periodic scan failed:', err.message);
        });
    });
}

module.exports = {
    handleTwitterMessage,
    startTwitterScanner
};
