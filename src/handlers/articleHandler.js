// News-article link interceptor — ported from robot-joe (already free of the
// OCR/Whisper translation pipeline).
//
// When a user posts a link to a news article (e.g. themoscowtimes.com / meduza.io),
// the bot:
//   1. deletes the user's original message (so the channel shows only the bot's card),
//   2. suppresses Discord's link-preview embed,
//   3. downloads the article's main (og:image) image and attaches it, and
//   4. reposts the article's main text as a blockquote inside a thread on the
//      bot's message, with the article URL hidden behind a masked "Статья/Тред"
//      markdown link in the card body.

const axios = require('axios');
const { AttachmentBuilder } = require('discord.js');
const { RAG_TYPING_INTERVAL, FILE_SIZE_SAFETY_FACTOR, DISCORD_MESSAGE_LIMIT } = require('../config');
const { getGuildFileLimit } = require('../utils/mediaCompressor');
const { sendWorkingPlaceholder, updateWorkingPlaceholder, updatePlaceholderStage } = require('../utils/webhook');
const { inFlightPlaceholders } = require('../utils/inFlightTracker');
const mediaQueue = require('../utils/mediaQueue');
const { startJob } = require('../utils/jobLog');

const THREAD_AUTO_ARCHIVE_MINUTES = 1440; // 24h

// Split text into <= maxLen chunks, preferring to break on newlines/spaces.
function splitIntoChunks(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf('\n', maxLen);
        if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(' ', maxLen);
        if (splitAt < maxLen * 0.3) splitAt = maxLen;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).replace(/^\s+/, '');
    }
    return chunks;
}

const FETCH_TIMEOUT = 15000;
const IMAGE_TIMEOUT = 20000;
// Main-message body is intentionally short (title + link only); the full article
// text goes into a thread, so we can afford a larger body budget there.
const MAX_THREAD_BODY_CHARS = 18000;

const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ru,en;q=0.9'
};

// Heuristically extract the main article body text from a news HTML page.
// Returns an array of paragraph strings (already decoded + trimmed).
function extractArticleText(html) {
    const decodeEntities = (s) => s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&laquo;/g, '«')
        .replace(/&raquo;/g, '»')
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&#\d+;/g, '');

    // Strip script/style/nav/aside/header/footer/form blocks so we don't quote menus.
    let body = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<header[\s\S]*?<\/header>/gi, ' ')
        .replace(/<form[\s\S]*?<\/form>/gi, ' ');

    // Prefer paragraphs inside <article> / <main> / role=main. Fall back to all <p>.
    let scope = body;
    const articleMatch = body.match(/<article[\s\S]*?<\/article>/i);
    const mainMatch = body.match(/<main[\s\S]*?<\/main>/i);
    const roleMainMatch = body.match(/<[^>]*role=["']main["'][\s\S]*?<\/[a-zA-Z]+>/i);
    const scopeMatch = articleMatch || roleMainMatch || mainMatch;
    if (scopeMatch) scope = scopeMatch[0];

    const paragraphs = [];
    const pRegex = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRegex.exec(scope)) !== null) {
        let para = m[1]
            .replace(/<[^>]+>/g, ' ')      // drop inner tags (links, <br>, <em>)
            .replace(/\s+/g, ' ')
            .trim();
        para = decodeEntities(para);
        if (para.length < 25) continue;   // skip short crumbs / captions
        // skip obvious non-article noise
        if (/^(поделиться|читать далее|комментарии|реклама|подписаться|фото:|источник:|читайте также)/i.test(para)) continue;
        paragraphs.push(para);
    }

    // If the scoped search found nothing, try all paragraphs in the whole body.
    if (paragraphs.length === 0) {
        while ((m = pRegex.exec(body)) !== null) {
            let para = m[1]
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            para = decodeEntities(para);
            if (para.length < 25) continue;
            paragraphs.push(para);
        }
    }
    return paragraphs;
}

function extractTitle(html) {
    const og = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
    if (og) return og[1].trim();
    const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return t ? t[1].trim() : '';
}

function extractMainImage(html, articleUrl) {
    const candidates = [
        html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i),
        html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i),
        html.match(/<meta[^>]*property=["']og:image:secure_url["'][^>]*content=["']([^"']+)["']/i),
        html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i)
    ].filter(Boolean);
    let imageUrl = candidates.length ? candidates[0][1].trim() : null;

    if (!imageUrl) {
        // First sizable <img> inside <article>/<main>
        const scopeMatch = html.match(/<(?:article|main)[\s\S]*?<\/(?:article|main)>/i);
        const scope = scopeMatch ? scopeMatch[0] : html;
        const img = scope.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (img) imageUrl = img[1].trim();
    }
    if (!imageUrl) return null;

    // Resolve relative URLs against the article URL.
    if (imageUrl.startsWith('//')) {
        imageUrl = 'https:' + imageUrl;
    } else if (imageUrl.startsWith('/')) {
        const base = articleUrl.match(/^https?:\/\/[^/]+/i);
        imageUrl = base ? base[0] + imageUrl : 'https://' + imageUrl.replace(/^\/+/, '');
    }
    return imageUrl;
}

// Build the short main-message content: an optional user comment (their own text
// from the original message, with the article URL stripped out) on top of the
// bold article title + a masked markdown link labelled "Статья/Тред" pointing at
// the article URL (embed suppressed).
function buildMainContent(articleUrl, title, userComment) {
    let parts = [];
    if (userComment) parts.push(userComment);
    if (title) parts.push(`**${title}**`);
    parts.push(`[Статья/Тред](${articleUrl})`);
    return parts.join('\n\n').substring(0, 2000);
}

// Extract the user's own commentary from the original message content by
// removing the matched article URL. Returns a trimmed string or '' if the user
// added nothing beyond the link.
function extractUserComment(remadeContent, articleUrl) {
    if (!remadeContent) return '';
    let comment = remadeContent.replace(articleUrl, ' ').replace(/\s+/g, ' ').trim();
    if (comment.length < 2) return '';
    return comment;
}

// Build the full article body text that will be posted inside the thread.
// Each paragraph is wrapped in a blockquote line so the thread reads as a quote.
function buildThreadBody(paragraphs) {
    let body = '';
    for (const p of paragraphs) {
        if (body.length + p.length + 4 > MAX_THREAD_BODY_CHARS) {
            body += `\n> …`;
            break;
        }
        body += `> ${p}\n`;
    }
    return body.trimEnd();
}

// Derive a short thread name from the article title (falls back to a generic label).
function buildThreadName(title) {
    if (title) {
        const short = title.replace(/[*_#`~>|]/g, ' ').replace(/\s+/g, ' ').trim();
        if (short) return `📰 ${short}`.substring(0, 100);
    }
    return '📰 Статья';
}

async function handleArticleMessage(client, message, articleUrl, remadeContent, recoveredPlaceholder = null) {
    const job = startJob(message, 'handleArticleMessage');
    const isRecovery = !!recoveredPlaceholder;

    let placeholder = null;
    if (isRecovery) {
        placeholder = recoveredPlaceholder;
        await updatePlaceholderStage(placeholder, `working... <${articleUrl}>\nstage: re-process`);
    } else {
        placeholder = await sendWorkingPlaceholder(client, message, articleUrl, remadeContent || articleUrl);
    }
    if (placeholder && placeholder.sentMsg) inFlightPlaceholders.add(placeholder.sentMsg.id);

    // The original user message is preserved during processing (like robot-joe).
    // The bot's reposted article card appears below the original link.

    const typingChannel = placeholder.sentMsg ? placeholder.sentMsg.channel : message.channel;
    await typingChannel.sendTyping().catch(() => { });
    const typingInterval = setInterval(() => {
        typingChannel.sendTyping().catch(() => { });
    }, RAG_TYPING_INTERVAL);

    mediaQueue.enqueue(async () => {
        try {
            const fileLimit = getGuildFileLimit(message.guild);
            const effectiveFileLimit = Math.floor(fileLimit * FILE_SIZE_SAFETY_FACTOR);

            await updatePlaceholderStage(placeholder, `working... <${articleUrl}>\nstage: fetching article`);

            let html = '';
            try {
                const res = await axios.get(articleUrl, {
                    headers: BROWSER_HEADERS,
                    timeout: FETCH_TIMEOUT,
                    responseType: 'text',
                    maxRedirects: 5
                });
                if (res.status !== 200) throw new Error(`article returned status ${res.status}`);
                html = typeof res.data === 'string' ? res.data : String(res.data);
            } catch (fetchErr) {
                console.error('[Article Interceptor] Failed to fetch article:', fetchErr.message);
                await updateWorkingPlaceholder(placeholder, `<${articleUrl}>`, [], true, 0, `<${articleUrl}>`);
                job.failure(fetchErr.message, { stage: 'fetch' });
                return;
            }

            const title = extractTitle(html);
            const imageUrl = extractMainImage(html, articleUrl);
            const paragraphs = extractArticleText(html);
            const userComment = extractUserComment(remadeContent, articleUrl);

            // Download the lead image (if any) and attach it.
            let attachments = [];
            if (imageUrl) {
                try {
                    await updatePlaceholderStage(placeholder, `working... <${articleUrl}>\nstage: downloading image`);
                    const imgRes = await axios.get(imageUrl, {
                        responseType: 'arraybuffer',
                        timeout: IMAGE_TIMEOUT,
                        headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'] }
                    });
                    const buffer = Buffer.from(imgRes.data);
                    const contentType = imgRes.headers['content-type'] || '';
                    let ext = 'jpg';
                    if (contentType.includes('image/png')) ext = 'png';
                    else if (contentType.includes('image/webp')) ext = 'webp';
                    else if (contentType.includes('image/gif')) ext = 'gif';
                    else if (imageUrl.match(/\.(png|webp|gif|jpe?g)$/i)) {
                        ext = imageUrl.match(/\.(png|webp|gif|jpe?g)$/i)[1].toLowerCase().replace('jpeg', 'jpg');
                    }

                    if (buffer.length <= effectiveFileLimit) {
                        attachments.push(new AttachmentBuilder(buffer, { name: `article_image.${ext}` }));
                    } else {
                        console.log(`[Article Interceptor] Lead image (${(buffer.length / 1024 / 1024).toFixed(1)}MB) exceeds limit; attaching anyway without compression.`);
                        attachments.push(new AttachmentBuilder(buffer, { name: `article_image.${ext}` }));
                    }
                } catch (imgErr) {
                    console.error('[Article Interceptor] Failed to download lead image:', imgErr.message);
                }
            }

            const finalContent = buildMainContent(articleUrl, title, userComment);

            // SuppressEmbeds=true so Discord does not generate a second link-preview card
            // alongside our attached image. The full article body goes into a thread.
            await updateWorkingPlaceholder(placeholder, finalContent, attachments, true, effectiveFileLimit, `<${articleUrl}>`);

            // Post the article body text inside a thread created on the placeholder message
            if (paragraphs.length > 0 && placeholder.sentMsg) {
                try {
                    const threadBody = buildThreadBody(paragraphs);
                    const threadName = buildThreadName(title);
                    const channel = placeholder.sentMsg.channel;
                    const targetMsg = await channel.messages.fetch(placeholder.sentMsg.id).catch(() => null);
                    if (targetMsg) {
                        const thread = await targetMsg.startThread({
                            name: threadName,
                            autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES
                        });
                        const chunks = splitIntoChunks(threadBody, DISCORD_MESSAGE_LIMIT - 10);
                        for (const chunk of chunks) {
                            await thread.send({ content: chunk });
                        }
                        console.log(`[Article Interceptor] Posted article body in thread ${thread.id} (${chunks.length} msg(s), ${threadBody.length} chars)`);
                    }
                } catch (threadErr) {
                    console.error('[Article Interceptor] Failed to post article body in thread:', threadErr.message);
                }
            }
            job.success({ stage: 'article', paragraphs: paragraphs.length, hasImage: attachments.length > 0 });
        } catch (err) {
            console.error('[Article Interceptor] Critical error in handler:', err);
            try {
                await updateWorkingPlaceholder(placeholder, `⚠️ [Ошибка обработки статьи]\n<${articleUrl}>`, [], false, 0, `<${articleUrl}>`);
            } catch (_) {}
            job.failure(err.message, { stage: 'critical' });
        } finally {
            clearInterval(typingInterval);
            if (placeholder && placeholder.sentMsg) inFlightPlaceholders.delete(placeholder.sentMsg.id);
        }
    });
}

module.exports = {
    handleArticleMessage,
    // Exposed for the dispatcher to decide whether a URL is a news article we should intercept.
    extractArticleText,
    extractTitle,
    extractMainImage
};