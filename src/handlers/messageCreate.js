const { PermissionFlagsBits } = require('discord.js');
const { getLibrarianData } = require('../utils/helpers');
const { handleInstagramMessage } = require('../services/instagram');
const { handleTwitterMessage } = require('./twitterHandler');
const { handleFacebookMessage } = require('./facebookHandler');
const { handleArticleMessage } = require('./articleHandler');
const { handleRagQuery } = require('../services/rag');
const {
    SERVER_ID,
    ACTIVE_CATEGORY_ID,
    EMOJI_ROBOT,
    EMOJI_HAND,
    DISCORD_START_SNOWFLAKE,
    helpText
} = require('../config');

async function handleMessageCreate(client, message) {
    if (message.guild?.id !== SERVER_ID || message.author.bot) return;

    // --- Twitter/X Link Interceptor ---
    const twitterRegex = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[a-zA-Z0-9_]+\/status\/\d+[^\s]*/i;
    const twitterMatch = message.content.match(twitterRegex);
    if (twitterMatch) {
        let twitterUrl = twitterMatch[0];
        twitterUrl = twitterUrl.replace(/[:;=\-xX]*[\(\)]+$/, '');
        twitterUrl = twitterUrl.replace(/[.,:;!?]+$/, '');
        await handleTwitterMessage(client, message, twitterUrl, message.content);
        return;
    }

    // --- Instagram Link Interceptor ---
    // Matches instagram.com and all mirror domains (dd/kk/ee/uu/rx instagram),
    // with an OPTIONAL protocol scheme so bare "instagram.com/reel/..." links are
    // caught too. Mirrors the robot-joe interceptor.
    const instagramRegex = /(?:https?:\/\/)?(?:www\.)?(?:dd|kk|ee|uu|rx)?instagram\.com\/[^\s]+/i;
    const instaMatch = message.content.match(instagramRegex);
    if (instaMatch) {
        const originalMatch = instaMatch[0];
        let instagramUrl = originalMatch;
        instagramUrl = instagramUrl.replace(/[:;=\-xX]*[\(\)]+$/, '');
        instagramUrl = instagramUrl.replace(/[.,:;!?]+$/, '');

        // Normalize URL by ensuring it has https:// scheme
        if (!/^https?:\/\//i.test(instagramUrl)) {
            instagramUrl = 'https://' + instagramUrl;
        }

        // Replace the raw matched URL with the normalized one in the content so
        // that string replacement inside the handler works correctly.
        const contentNormalized = message.content.replace(originalMatch, instagramUrl);

        await handleInstagramMessage(client, message, instagramUrl, contentNormalized);
        return;
    }

    // --- Facebook Link Interceptor (facebook.com / fb.watch) ---
    const facebookRegex = /(?:https?:\/\/)?(?:www\.|m\.)?(?:facebook\.com|fb\.watch)\/[^\s]+/i;
    const fbMatch = message.content.match(facebookRegex);
    if (fbMatch) {
        const originalMatch = fbMatch[0];
        let facebookUrl = originalMatch;
        facebookUrl = facebookUrl.replace(/[:;=\-xX]*[\(\)]+$/, '');
        facebookUrl = facebookUrl.replace(/[.,:;!?]+$/, '');
        if (!/^https?:\/\//i.test(facebookUrl)) {
            facebookUrl = 'https://' + facebookUrl;
        }
        const contentNormalized = message.content.replace(originalMatch, facebookUrl);
        await handleFacebookMessage(client, message, facebookUrl, contentNormalized);
        return;
    }

    // --- News Article Link Interceptor ---
    // Only links whose host matches one of these known news domains are treated
    // as articles (so generic links still go through the normal RAG path).
    const articleDomains = [
        'themoscowtimes.com',
        'ru.themoscowtimes.com',
        'meduza.io',
        'tjournal.ru',
        'novayagazeta.eu',
        'rbc.ru',
        'lenta.ru',
        'vedomosti.ru',
        'kommersant.ru',
        'interfax.ru',
        'tass.ru'
    ];
    const articleDomainPattern = articleDomains.map(d => d.replace(/\./g, '\\.')).join('|');
    const articleRegex = new RegExp(`(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(${articleDomainPattern})(?:\\/[^\\s#]*)?`, 'i');
    const articleMatch = message.content.match(articleRegex);
    if (articleMatch) {
        let articleUrl = articleMatch[0];
        articleUrl = articleUrl.replace(/[:;=\-xX]*[\(\)]+$/, '');
        articleUrl = articleUrl.replace(/[.,:;!?]+$/, '');
        if (!/^https?:\/\//i.test(articleUrl)) {
            articleUrl = 'https://' + articleUrl;
        }
        await handleArticleMessage(client, message, articleUrl, message.content);
        return;
    }

    if (message.mentions.users.has(client.user.id)) {
        const query = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();

        if (query.length === 0) {
            try {
                return await message.reply(helpText);
            } catch (err) {
                console.error('Failed to send help text:', err);
            }
            return;
        }

        await handleRagQuery(client, message, query);
        return;
    }

    if (message.channel.parentId === ACTIVE_CATEGORY_ID && !message.channel.isThread()) {
        const topic = message.channel.topic || '';
        const content = message.content.trim();

        if (content === '!pin' || content === '!unpin' || content.startsWith('!pin ') || content.startsWith('!unpin ')) {
            const isPin = content.startsWith('!pin');
            const args = content.split(/\s+/);
            const messageId = args[1];

            const metaData = await getLibrarianData(message.channel);

            // Access permission check
            if (!metaData) {
                const currentTopic = message.channel.topic || '';
                if (currentTopic.startsWith('SETUP|')) {
                    const setupMatch = currentTopic.match(/DM:(\d+)/);
                    const setupDmId = setupMatch ? setupMatch[1] : null;
                    if (message.author.id !== setupDmId && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                        await message.delete().catch(() => { });
                        return;
                    }
                } else if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await message.delete().catch(() => { });
                    return;
                }
            } else {
                if (metaData.dmId !== message.author.id && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    await message.delete().catch(() => { });
                    return;
                }
            }

            try {
                let targetMessage;

                if (messageId) {
                    targetMessage = await message.channel.messages.fetch(messageId).catch(() => null);
                } else {
                    if (isPin) {
                        const lastMessages = await message.channel.messages.fetch({ before: message.id, limit: 1 });
                        targetMessage = lastMessages.first();
                    } else {
                        const pinnedMessages = await message.channel.messages.fetchPinned().catch(() => null);
                        targetMessage = pinnedMessages ? pinnedMessages.first() : null;
                    }
                }

                if (!targetMessage) {
                    await message.delete().catch(() => { });
                    return;
                }

                if (isPin) {
                    await targetMessage.pin();
                } else {
                    const firstMessages = await message.channel.messages.fetch({ after: DISCORD_START_SNOWFLAKE, limit: 1 });
                    const opMessage = firstMessages.first();

                    if (opMessage && targetMessage.id === opMessage.id && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
                        await message.delete().catch(() => { });
                        return;
                    }
                    await targetMessage.unpin();
                }
            } catch (err) {
                console.error('Text pin/unpin error:', err);
            }

            await message.delete().catch(() => { });
            return;
        }

        if (topic.startsWith('SETUP|')) {
            const dmMatch = topic.match(/DM:(\d+)/);
            const dmId = dmMatch ? dmMatch[1] : null;
            const hasAdminPerm = message.member.permissions.has(PermissionFlagsBits.Administrator);

            if (message.author.id !== dmId && !hasAdminPerm) {
                await message.delete().catch(() => { });
                return;
            }

            try {
                await message.pin();
                await message.react(EMOJI_ROBOT);
                await message.react(EMOJI_HAND);

                const role = await message.guild.roles.create({
                    name: message.channel.name,
                    reason: 'Automated role for new active campaign channel'
                });

                await message.channel.permissionOverwrites.edit(role.id, {
                    MentionEveryone: true
                });

                const userMatch = topic.match(/USERS:([\d,]*)/);
                if (userMatch && userMatch[1]) {
                    const usersToRole = userMatch[1].split(',');
                    for (const uid of usersToRole) {
                        const member = await message.guild.members.fetch(uid).catch(() => null);
                        if (member) await member.roles.add(role).catch(() => { });
                    }
                }

                const finalDmId = dmId || message.author.id;
                await message.channel.setTopic(`Active Campaign [LIBRARIAN_DATA|DM:${finalDmId}|ROLE:${role.id}]`);
            } catch (err) {
                console.error('Failed to process OP workflow:', err);
            }
        }
    }
}

module.exports = handleMessageCreate;
