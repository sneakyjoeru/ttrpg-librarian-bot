const { AttachmentBuilder } = require('discord.js');
const { instagramGetUrl } = require('instagram-url-direct');
const axios = require('axios');

const INSTAGRAM_TYPING_INTERVAL = 4000;

async function sendRepostedMessage(client, message, content, attachments) {
    const DISCORD_MAX_ATTACHMENTS = 10;
    const allFiles = attachments || [];

    // Split attachments into chunks of 10 (Discord API limit)
    const fileChunks = [];
    for (let i = 0; i < allFiles.length; i += DISCORD_MAX_ATTACHMENTS) {
        fileChunks.push(allFiles.slice(i, i + DISCORD_MAX_ATTACHMENTS));
    }
    if (fileChunks.length === 0) fileChunks.push([]);

    let reposted = false;
    if (message.guild) {
        try {
            const webhookChannel = message.channel.isThread() ? message.channel.parent : message.channel;
            if (webhookChannel && webhookChannel.fetchWebhooks) {
                const webhooks = await webhookChannel.fetchWebhooks();
                let webhook = webhooks.find(wh => wh.owner && wh.owner.id === client.user.id);
                if (!webhook) {
                    webhook = await webhookChannel.createWebhook({
                        name: 'Librarian Bot',
                        avatar: client.user.displayAvatarURL()
                    });
                }

                const username = message.member ? message.member.displayName : message.author.username;
                const avatarURL = message.author.displayAvatarURL({ forceStatic: true });
                const threadId = message.channel.isThread() ? message.channel.id : undefined;

                for (let i = 0; i < fileChunks.length; i++) {
                    const options = {
                        content: i === 0 ? (content || '') : '',
                        username,
                        avatarURL,
                        files: fileChunks[i]
                    };
                    if (threadId) options.threadId = threadId;
                    await webhook.send(options);
                }
                reposted = true;
            }
        } catch (err) {
            console.error('[Instagram] Failed to send webhook repost:', err);
        }
    }

    if (!reposted) {
        try {
            const displayName = message.member ? message.member.displayName : message.author.username;
            const prefix = `**${displayName}**: `;

            for (let i = 0; i < fileChunks.length; i++) {
                const msgContent = i === 0
                    ? (content ? `${prefix}${content}` : prefix)
                    : '';
                await message.channel.send({
                    content: msgContent.substring(0, 2000),
                    files: fileChunks[i]
                });
            }
        } catch (sendErr) {
            console.error('[Instagram] Fallback send failed:', sendErr);
        }
    }
}

async function handleInstagramMessage(client, message, instagramUrl, remadeContent) {
    await message.channel.sendTyping().catch(() => { });
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => { });
    }, INSTAGRAM_TYPING_INTERVAL);

    let downloadSuccess = false;
    const attachments = [];

    const isKK = instagramUrl.includes('kkinstagram.com');
    const downloadUrl = isKK ? instagramUrl.replace(/(www\.)?kkinstagram\.com/, 'instagram.com') : instagramUrl;

    try {
        console.log(`[Instagram] URL detected: ${instagramUrl} (downloading from ${downloadUrl})`);
        const scraperPromise = instagramGetUrl(downloadUrl);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Scraper timeout (10s)')), 10000)
        );
        const scrapeRes = await Promise.race([scraperPromise, timeoutPromise]);

        let mediaUrls = [];
        if (scrapeRes && scrapeRes.url_list && Array.isArray(scrapeRes.url_list)) {
            mediaUrls = scrapeRes.url_list;
        } else if (scrapeRes && Array.isArray(scrapeRes)) {
            mediaUrls = scrapeRes;
        } else if (scrapeRes && typeof scrapeRes === 'object' && scrapeRes.url) {
            mediaUrls = [scrapeRes.url];
        }

        if (mediaUrls.length > 0) {
            console.log(`[Instagram] Downloading ${mediaUrls.length} media items...`);
            for (let i = 0; i < mediaUrls.length; i++) {
                const mUrl = mediaUrls[i];
                const response = await axios.get(mUrl, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                const buffer = Buffer.from(response.data);
                if (buffer.length > 10 * 1024 * 1024) {
                    throw new Error(`File size ${buffer.length} bytes exceeds 10MB limit`);
                }
                const contentType = response.headers['content-type'] || '';
                let ext = 'jpg';
                if (contentType.includes('video/mp4')) ext = 'mp4';
                else if (contentType.includes('image/png')) ext = 'png';
                else if (contentType.includes('image/gif')) ext = 'gif';
                else if (contentType.includes('video/')) ext = 'mp4';
                else if (mUrl.includes('.mp4')) ext = 'mp4';

                attachments.push(new AttachmentBuilder(buffer, { name: `instagram_media_${i}.${ext}` }));
            }
            downloadSuccess = true;
        }
    } catch (err) {
        console.error('[Instagram] Scraping/Download failed:', err.message);
        downloadSuccess = false;
    }

    try {
        let replacedText = remadeContent;
        let suppressedText = remadeContent;

        if (!isKK) {
            const kkUrl = instagramUrl.replace(/(www\.)?instagram\.com/, 'kkinstagram.com');
            replacedText = remadeContent.replace(instagramUrl, kkUrl);
            suppressedText = remadeContent.replace(instagramUrl, `<${kkUrl}>`);
        } else {
            suppressedText = remadeContent.replace(instagramUrl, `<${instagramUrl}>`);
        }

        if (downloadSuccess && attachments.length > 0) {
            await sendRepostedMessage(client, message, suppressedText, attachments);
        } else {
            await sendRepostedMessage(client, message, replacedText, []);
        }

        if (message.guild) {
            await message.delete().catch(delErr => {
                console.error('[Instagram] Failed to delete original message:', delErr.message);
            });
        }
    } catch (sendErr) {
        console.error('[Instagram] Failed to send reposted message:', sendErr.message);
    } finally {
        clearInterval(typingInterval);
    }
}

module.exports = {
    handleInstagramMessage,
    sendRepostedMessage
};
