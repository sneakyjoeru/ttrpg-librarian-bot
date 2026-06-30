const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const { instagramGetUrl } = require('instagram-url-direct');
const snapinsta = require('snapinsta');
const { AttachmentBuilder } = require('discord.js');
const { RAG_TYPING_INTERVAL, FFMPEG_TIMEOUT } = require('../config');
const { sendRepostedMessage, sendWorkingPlaceholder, updateWorkingPlaceholder, updatePlaceholderStage, finalizePlaceholderClean } = require('../utils/webhook');
const { runCommand, findYtDlpPath } = require('../utils/shell');
const { getGuildFileLimit, compressVideoToFit } = require('../utils/mediaCompressor');
const mediaQueue = require('../utils/mediaQueue');
const { detectFileType } = require('../utils/fileTypeDetector');

const INSTAGRAM_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
        .replace(/&#\d+;/g, '');
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

        let html;
        try {
            const response = await axios.get(canonicalUrl, {
                timeout: 15000,
                maxRedirects: 5,
                headers: {
                    'User-Agent': INSTAGRAM_BROWSER_UA,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Upgrade-Insecure-Requests': '1'
                }
            });
            html = response.data;
        } catch (fetchErr) {
            console.error('[Instagram Interceptor] Profile fetch failed:', fetchErr.message);
            const fallbackUrl = canonicalUrl.replace(/^https?:\/\//i, '');
            await updateWorkingPlaceholder(placeholder, `[${fallbackUrl}](${canonicalUrl})`, [], false, 0, `[${fallbackUrl}](${canonicalUrl})`);
            return;
        }

        if (!html || typeof html !== 'string') {
            const fallbackUrl = canonicalUrl.replace(/^https?:\/\//i, '');
            await updateWorkingPlaceholder(placeholder, `[${fallbackUrl}](${canonicalUrl})`, [], false, 0, `[${fallbackUrl}](${canonicalUrl})`);
            return;
        }

        // Detect a login wall — Instagram returns the login page for some profiles.
        if (html.includes('"showLoginForm"') || html.includes('"loginForm"') ||
            /<title[^>]*>\s*Login/i.test(html) || /accounts\/login/i.test(html)) {
            console.log('[Instagram Interceptor] Profile fetch hit a login wall.');
        }

        // Extract profile metadata from og: meta tags.
        const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
        const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i);
        const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
            || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);

        const displayName = ogTitleMatch ? decodeEntities(ogTitleMatch[1]).trim() : '';
        const description = ogDescMatch ? decodeEntities(ogDescMatch[1]).trim() : '';
        const profilePicUrl = ogImageMatch ? ogImageMatch[1].trim() : null;

        // Extract the username from the URL for the profile link.
        const usernameMatch = canonicalUrl.match(/instagram\.com\/([^/?#]+)/i);
        const username = usernameMatch ? usernameMatch[1] : '';

        // Extract last 4 posts' thumbnails.
        const recentPosts = extractRecentPostsFromProfileHtml(html, 4);
        console.log(`[Instagram Interceptor] Profile: name="${displayName}", posts=${recentPosts.length}, hasPic=${!!profilePicUrl}`);

        // Download the profile picture (if available) to attach it.
        let attachments = [];
        if (profilePicUrl) {
            try {
                const picRes = await axios.get(profilePicUrl, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    headers: { 'User-Agent': INSTAGRAM_BROWSER_UA }
                });
                const buffer = Buffer.from(picRes.data);
                const contentType = picRes.headers['content-type'] || '';
                let ext = 'jpg';
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
                let ext = 'jpg';
                if (contentType.includes('image/png')) ext = 'png';
                else if (contentType.includes('image/webp')) ext = 'webp';
                else if (contentType.includes('image/gif')) ext = 'gif';
                attachments.push(new AttachmentBuilder(buffer, { name: `post_${i + 1}.${ext}` }));
            } catch (postErr) {
                console.error(`[Instagram Interceptor] Failed to download post ${i + 1} thumbnail:`, postErr.message);
            }
        }

        // Build the profile card text.
        const profileLink = `https://www.instagram.com/${username}/`;
        const parts = [];
        // Strip the user's original URL from their commentary so the card shows
        // their comment (if any) above the profile block.
        let userComment = '';
        if (remadeContent) {
            userComment = remadeContent.replace(profileUrl, ' ').replace(/\s+/g, ' ').trim();
            if (userComment.length < 2) userComment = '';
        }
        if (userComment) parts.push(userComment);
        if (displayName) {
            parts.push(`**${displayName}**${username ? ` (@${username})` : ''}`);
        } else if (username) {
            parts.push(`**@${username}**`);
        }
        if (description) {
            // og:description is usually "<N> Followers, <M> Following, <K> Posts - See Instagram photos and videos from <name> (@handle)"
            // Quote it as the bio line.
            const descLines = description.split('\n').filter(l => l.trim());
            for (const line of descLines) {
                parts.push(`> ${line}`);
            }
        }
        // Append links to the last 4 posts (so users can open them even if the thumbnail download failed).
        if (recentPosts.length > 0) {
            const postLinks = recentPosts.map(p => `https://www.instagram.com/p/${p.shortcode}/`);
            parts.push(`Recent posts:\n${postLinks.map(l => `<${l}>`).join('\n')}`);
        }
        parts.push(`[Profile](${profileLink})`);

        const finalContent = parts.join('\n\n').substring(0, 2000);

        if (attachments.length > 0) {
            await updateWorkingPlaceholder(placeholder, finalContent, attachments, true, getGuildFileLimit(message.guild), `<${profileLink}>`);
        } else {
            // No attachments — at least show the profile link with embeds enabled so
            // Discord renders og:image/og:description as a preview card.
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
            const effectiveFileLimit = Math.floor(fileLimit * 0.97);
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
