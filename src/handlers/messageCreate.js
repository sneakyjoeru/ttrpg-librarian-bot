const { PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const { getLibrarianData } = require('../utils/helpers');
const { handleInstagramMessage } = require('../services/instagram');
const { handleTwitterMessage } = require('./twitterHandler');
const { handleFacebookMessage } = require('./facebookHandler');
const { handleArticleMessage } = require('./articleHandler');
const { handleRagQuery } = require('../services/rag');
const { runCommandStream } = require('../utils/shell');
const { parseRebuildProgressLine } = require('../utils/rebuildProgress');
const { isMessageTiedToUser, removeTrackedMessage } = require('../utils/messageTracker');
const { buildRecoveredPlaceholder } = require('../utils/webhook');
const { inFlightMessages } = require('../utils/inFlightTracker');
const {
    SERVER_ID,
    ACTIVE_CATEGORY_ID,
    EMOJI_ROBOT,
    EMOJI_HAND,
    SNEAKYJOE_USER_ID,
    DISCORD_START_SNOWFLAKE,
    helpText
} = require('../config');

const BULK_DELETE_MAX = 100;

async function handleMessageCreate(client, message) {
    // Mark message as in-flight to prevent catch-up re-dispatch (mirrors
    // discord-joe). If a real Discord message event is already being
    // processed, the startup catch-up scanner must not re-dispatch the same
    // message id — that would run the Instagram/Twitter/Facebook/article
    // parsers a second time on the same link.
    if (inFlightMessages.has(message.id)) {
        return;
    }
    inFlightMessages.add(message.id);
    try {
        return await _handleMessageCreateInner(client, message);
    } finally {
        inFlightMessages.delete(message.id);
    }
}

async function _handleMessageCreateInner(client, message) {
    // Skip messages from bots AND webhook messages (webhook authors have
    // author.bot = null, not true, so we must check webhookId separately).
    // Without the webhookId check, the bot re-intercepts its own webhook
    // reposts (which contain the Instagram URL in <...> format) → infinite loop.
    if (message.guild?.id !== SERVER_ID || message.author.bot || message.webhookId) return;

    // --- /delete text command ---
    const deleteRegex = /^\/delete(?:\s+message)?(?:\s+(\d+))?$/i;
    const deleteMatch = message.content.match(deleteRegex);
    if (deleteMatch) {
        if (deleteMatch[1] === undefined) {
            // No count: delete the last bot/webhook message TIED to the calling
            // user (i.e. a repost the bot made on their behalf).
            try {
                const fetched = await message.channel.messages.fetch({ limit: 50 }).catch(() => null);
                await message.delete().catch(() => { });
                if (fetched && fetched.size > 0) {
                    let deletedTarget = false;
                    for (const msg of fetched.values()) {
                        if (msg.id === message.id) continue;
                        const isUserMessage = msg.author.id === message.author.id;
                        const username = message.author.username;
                        const displayName = message.member ? message.member.displayName : message.author.username;
                        const isTied = await isMessageTiedToUser(msg, message.author.id, username, displayName, client);
                        if (isUserMessage || isTied) {
                            await msg.delete().catch(() => { });
                            console.log(`[Delete Command] Deleted message ${msg.id} in channel ${message.channel.id} triggered by ${message.author.tag} (${message.author.id})`);
                            removeTrackedMessage(msg.id);
                            deletedTarget = true;
                            break;
                        }
                    }
                    if (!deletedTarget) {
                        console.log(`[Delete Command] No recent messages found to delete for user ${message.author.tag} (${message.author.id}) in channel ${message.channel.id}`);
                    }
                }
            } catch (err) {
                console.error('[Delete Command] Error during zero-argument deletion:', err.message);
            }
            return;
        }

        // Count provided: only admin can bulk delete
        if (message.author.id !== SNEAKYJOE_USER_ID) {
            try { await message.reply('У тебя нет прав для выполнения этой команды.'); } catch (_) {}
            return;
        }

        const count = parseInt(deleteMatch[1], 10);
        if (isNaN(count) || count <= 0) {
            try { await message.reply('Укажи корректное число сообщений для удаления.'); } catch (_) {}
            return;
        }

        if (message.guild) {
            try {
                if (count + 1 <= BULK_DELETE_MAX) {
                    await message.channel.bulkDelete(count + 1, true);
                    console.log(`[Delete Command] Bulk deleted ${count + 1} messages in channel ${message.channel.id} triggered by admin ${message.author.tag}`);
                } else {
                    await message.delete().catch(() => {});
                    const fetched = await message.channel.messages.fetch({ limit: count });
                    for (const msg of fetched.values()) { await msg.delete().catch(() => {}); }
                }
            } catch (err) {
                console.warn('[Delete Command] bulkDelete failed, falling back to manual delete:', err.message);
                await message.delete().catch(() => {});
                try {
                    const fetched = await message.channel.messages.fetch({ limit: count });
                    for (const msg of fetched.values()) { await msg.delete().catch(() => {}); }
                } catch (fallbackErr) {
                    console.error('[Delete Command] Manual deletion failed:', fallbackErr.message);
                }
            }
        }
        return;
    }

    // --- /edit-last text command ---
    const editLastRegex = /^\/edit-last\b\s*([\s\S]*)$/i;
    const editLastMatch = message.content.match(editLastRegex);
    if (editLastMatch) {
        const isUserAdmin = message.author.id === SNEAKYJOE_USER_ID || !!(message.member && message.member.permissions.has(PermissionFlagsBits.Administrator));
        const newText = (editLastMatch[1] || '').trim();

        if (!newText) {
            try { await message.reply('Укажи новый текст после `/edit-last`. Например: `/edit-last Мой новый комментарий <url>`'); } catch (_) {}
            return;
        }

        try {
            let targetMsg = null;
            if (message.channel.isThread()) {
                try { targetMsg = await message.channel.fetchStarterMessage(); } catch (_) {}
            }
            if (!targetMsg && message.channel.messages) {
                const fetched = await message.channel.messages.fetch({ limit: 50 }).catch(() => null);
                if (fetched) {
                    for (const msg of fetched.values()) {
                        if (msg.id === message.id) continue;
                        if (msg.author.bot || msg.webhookId) {
                            const tied = await isMessageTiedToUser(msg, message.author.id, message.author.username, message.member ? message.member.displayName : message.author.username, client);
                            if (tied) { targetMsg = msg; break; }
                        }
                    }
                    if (!targetMsg && isUserAdmin) {
                        for (const msg of fetched.values()) {
                            if (msg.id === message.id) continue;
                            if (msg.author.bot || msg.webhookId) { targetMsg = msg; break; }
                        }
                    }
                }
            }

            if (!targetMsg) {
                try { await message.reply('Не найдено подходящего сообщения бота для редактирования в этом канале.'); } catch (_) {}
                return;
            }

            let authorized = isUserAdmin;
            if (!authorized) {
                authorized = await isMessageTiedToUser(targetMsg, message.author.id, message.author.username, message.member ? message.member.displayName : message.author.username, client);
            }
            if (!authorized) {
                try { await message.reply('Ты можешь редактировать только свои собственные посты, заменённые ботом.'); } catch (_) {}
                return;
            }

            const haystack = (targetMsg.content || '') + '\n' + newText;
            const twitterRe = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[a-zA-Z0-9_]+\/status\/\d+[^\s)\]>]*/i;
            const instagramRe = /(?:https?:\/\/)?(?:www\.|m\.)?(?:dd|kk|ee|uu|rx)?instagram\.com\/[^\s)\]>]+/i;
            const facebookRe = /(?:https?:\/\/)?(?:www\.|m\.)?(?:facebook\.com|fb\.watch)\/[^\s)\]>]+/i;
            const articleDomains = ['themoscowtimes.com','ru.themoscowtimes.com','meduza.io','tjournal.ru','novayagazeta.eu','rbc.ru','lenta.ru','vedomosti.ru','kommersant.ru','interfax.ru','tass.ru'];
            const articleDomainPattern = articleDomains.map(d => d.replace(/\./g, '\\.')).join('|');
            const articleRe = new RegExp(`(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(${articleDomainPattern})(?:\\/[^\\s)>#]*)?`, 'i');

            const allMatches = [];
            const twM = haystack.match(twitterRe);
            if (twM) allMatches.push({ url: twM[0].replace(/[.,:;!?]+$/, ''), kind: 'twitter' });
            const igM = haystack.match(instagramRe);
            if (igM) { let u = igM[0].replace(/[:;=\-xX]*[\(\)]+$/, '').replace(/[.,:;!?]+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; u = u.replace(/(www\.|m\.)?(?:dd|kk|ee|uu|rx)instagram\.com/i, 'instagram.com'); allMatches.push({ url: u, kind: 'instagram' }); }
            const fbM = haystack.match(facebookRe);
            if (fbM) { let u = fbM[0].replace(/[:;=\-xX]*[\(\)]+$/, '').replace(/[.,:;!?]+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; allMatches.push({ url: u, kind: 'facebook' }); }
            const artM = haystack.match(articleRe);
            if (artM) { let u = artM[0].replace(/[:;=\-xX]*[\(\)]+$/, '').replace(/[.,:;!?]+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; allMatches.push({ url: u, kind: 'article' }); }

            if (allMatches.length === 0) {
                try {
                    await targetMsg.edit(newText).catch(() => {});
                    await message.delete().catch(() => {});
                } catch (editErr) {
                    try { await message.reply('Не удалось отредактировать сообщение: ' + editErr.message); } catch (_) {}
                }
                return;
            }

            console.log(`[Edit-Last] Re-processing ${allMatches.length} link(s) with new text for ${message.author.tag} (${message.author.id}): ${allMatches.map(m => m.kind + '=' + m.url).join(', ')}`);
            await message.delete().catch(() => {});

            let recoveredPlaceholder = null;
            try { recoveredPlaceholder = await buildRecoveredPlaceholder(client, targetMsg); } catch (e) { console.warn('[Edit-Last] Could not build recovered placeholder:', e.message); }
            const synthId = `synth_editlast_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const synthMsg = new Proxy(targetMsg, {
                get(target, prop) {
                    if (prop === 'id') return synthId;
                    if (prop === 'content' || prop === 'cleanContent') return newText;
                    if (prop === 'attachments') return { size: 0 };
                    if (prop === 'webhookId') return null;
                    if (prop === 'delete') return async () => true;
                    if (prop === 'edit') return async () => target;
                    if (prop === 'react') return async () => true;
                    if (prop === 'reply') return async (options) => target.channel.send(options).catch(() => null);
                    return target[prop];
                }
            });

            for (let i = 0; i < allMatches.length; i++) {
                const { url: matchUrl, kind: matchKind } = allMatches[i];
                const placeholder = i === 0 ? recoveredPlaceholder : null;
                if (matchKind === 'twitter') await handleTwitterMessage(client, synthMsg, matchUrl, newText, placeholder);
                else if (matchKind === 'instagram') await handleInstagramMessage(client, synthMsg, matchUrl, newText, placeholder);
                else if (matchKind === 'facebook') await handleFacebookMessage(client, synthMsg, matchUrl, newText, placeholder);
                else if (matchKind === 'article') await handleArticleMessage(client, synthMsg, matchUrl, newText, placeholder);
            }
        } catch (editLastErr) {
            console.error('[Edit-Last] Error:', editLastErr.message);
            try { await message.reply('Ошибка при редактировании: ' + editLastErr.message); } catch (_) {}
        }
        return;
    }

    // --- /process text command ---
    const processRegex = /^\/process\b/i;
    if (processRegex.test(message.content)) {
        const isUserAdmin = message.author.id === SNEAKYJOE_USER_ID || !!(message.member && message.member.permissions.has(PermissionFlagsBits.Administrator));
        try {
            if (!message.channel.isThread()) {
                try { await message.reply('Команда `/process` работает только внутри треда обработанного поста.'); } catch (_) {}
                return;
            }

            const thread = message.channel;
            let starterMsg = null;
            try { starterMsg = await thread.fetchStarterMessage(); } catch (_) {}
            if (!starterMsg) {
                try { await message.reply('Не удалось найти исходное сообщение треда для обработки.'); } catch (_) {}
                return;
            }

            let authorized = isUserAdmin;
            if (!authorized) {
                try {
                    authorized = await isMessageTiedToUser(starterMsg, message.author.id, message.author.username, message.member ? message.member.displayName : message.author.username, client);
                } catch (_) {}
                if (!authorized) {
                    try {
                        const threadMsgs = await thread.messages.fetch({ limit: 50 }).catch(() => null);
                        if (threadMsgs) {
                            for (const m of threadMsgs.values()) {
                                if (!m.author.bot) { if (m.author.id === message.author.id) authorized = true; break; }
                            }
                        }
                    } catch (_) {}
                }
            }
            if (!authorized) {
                try { await message.reply('Эту команду может использовать только автор поста или администратор сервера.'); } catch (_) {}
                return;
            }

            let haystack = (starterMsg.content || '') + '\n';
            try {
                const threadMsgs = await thread.messages.fetch({ limit: 50 }).catch(() => null);
                if (threadMsgs) for (const m of threadMsgs.values()) haystack += (m.content || '') + '\n';
            } catch (_) {}

            const twitterRe = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[a-zA-Z0-9_]+\/status\/\d+[^\s)\]>]*/i;
            const instagramRe = /(?:https?:\/\/)?(?:www\.|m\.)?(?:dd|kk|ee|uu|rx)?instagram\.com\/[^\s)\]>]+/i;
            const facebookRe = /(?:https?:\/\/)?(?:www\.|m\.)?(?:facebook\.com|fb\.watch)\/[^\s)\]>]+/i;
            const articleDomains = ['themoscowtimes.com','ru.themoscowtimes.com','meduza.io','tjournal.ru','novayagazeta.eu','rbc.ru','lenta.ru','vedomosti.ru','kommersant.ru','interfax.ru','tass.ru'];
            const articleDomainPattern = articleDomains.map(d => d.replace(/\./g, '\\.')).join('|');
            const articleRe = new RegExp(`(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(${articleDomainPattern})(?:\\/[^\\s)>#]*)?`, 'i');

            let foundUrl = null, foundKind = null;
            const twM = haystack.match(twitterRe);
            if (twM) { foundUrl = twM[0].replace(/[.,:;!?]+$/, ''); foundKind = 'twitter'; }
            if (!foundUrl) {
                const igM = haystack.match(instagramRe);
                if (igM) { let u = igM[0].replace(/[:;=\-xX]*[\(\)]+$/, '').replace(/[.,:;!?]+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; u = u.replace(/(www\.|m\.)?(?:dd|kk|ee|uu|rx)instagram\.com/i, 'instagram.com'); foundUrl = u; foundKind = 'instagram'; }
            }
            if (!foundUrl) {
                const fbM = haystack.match(facebookRe);
                if (fbM) { let u = fbM[0].replace(/[:;=\-xX]*[\(\)]+$/, '').replace(/[.,:;!?]+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; foundUrl = u; foundKind = 'facebook'; }
            }
            if (!foundUrl) {
                const artM = haystack.match(articleRe);
                if (artM) { let u = artM[0].replace(/[:;=\-xX]*[\(\)]+$/, '').replace(/[.,:;!?]+$/, ''); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; foundUrl = u; foundKind = 'article'; }
            }

            if (!foundUrl) {
                try { await message.reply('Не удалось найти исходную ссылку для повторной обработки в этом треде.'); } catch (_) {}
                return;
            }

            console.log(`[Process Command] Re-processing ${foundKind} link for ${message.author.tag} (${message.author.id}) in thread ${thread.id}: ${foundUrl}`);
            await message.delete().catch(() => {});
            try { await thread.sendTyping(); } catch (_) {}

            let recoveredPlaceholder = null;
            try { recoveredPlaceholder = await buildRecoveredPlaceholder(client, starterMsg); } catch (e) { console.warn('[Process Command] Could not build recovered placeholder:', e.message); }
            const synthId = `synth_process_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
            const synthMsg = new Proxy(starterMsg, {
                get(target, prop) {
                    if (prop === 'id') return synthId;
                    if (prop === 'content' || prop === 'cleanContent') return foundUrl;
                    if (prop === 'attachments') return { size: 0 };
                    if (prop === 'webhookId') return null;
                    if (prop === 'delete') return async () => true;
                    if (prop === 'edit') return async () => target;
                    if (prop === 'react') return async () => true;
                    if (prop === 'reply') return async (options) => target.channel.send(options).catch(() => null);
                    return target[prop];
                }
            });

            const remadeForProcess = foundUrl;
            if (foundKind === 'twitter') await handleTwitterMessage(client, synthMsg, foundUrl, remadeForProcess, recoveredPlaceholder);
            else if (foundKind === 'instagram') await handleInstagramMessage(client, synthMsg, foundUrl, remadeForProcess, recoveredPlaceholder);
            else if (foundKind === 'facebook') await handleFacebookMessage(client, synthMsg, foundUrl, remadeForProcess, recoveredPlaceholder);
            else if (foundKind === 'article') await handleArticleMessage(client, synthMsg, foundUrl, remadeForProcess, recoveredPlaceholder);
        } catch (processErr) {
            console.error('[Process Command] Error:', processErr.message);
            try { await message.reply('Ошибка при повторной обработке: ' + processErr.message); } catch (_) {}
        }
        return;
    }

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

    // --- /restart text command (admin-only) ---
    // Rebuilds the bot's Docker image and restarts the container with live
    // BuildKit progress published to chat. Mirrors robot-joe's text /restart.
    // The librarian bot runs inside the container with the Docker socket mounted
    // (see rebuild-run.sh), so the rebuild is a local `docker build` + restart —
    // no SSH needed. Admin = sneakyjoe user ID OR guild Administrator permission.
    const restartRegex = /^\/restart$/i;
    if (restartRegex.test(message.content)) {
        const isUserAdmin = message.author.id === SNEAKYJOE_USER_ID
            || !!(message.member && message.member.permissions.has(PermissionFlagsBits.Administrator));
        if (!isUserAdmin) {
            console.warn(`[Restart Command] Unauthorized restart attempt by ${message.author.tag} (${message.author.id}) in channel ${message.channel.id}`);
            try {
                await message.reply('У тебя нет прав для выполнения этой команды.');
            } catch (err) {
                console.error('Failed to send permission error reply:', err.message);
            }
            return;
        }

        console.log(`[Restart Command] Restart triggered by ${message.author.tag} (${message.author.id}) in channel ${message.channel.id}`);

        const hostPath = process.env.HOST_PATH;
        if (!hostPath) {
            console.error('[Restart Command] HOST_PATH environment variable is not defined.');
            try {
                await message.reply('❌ Ошибка: переменная окружения `HOST_PATH` не задана. Перезапуск невозможен.');
            } catch (err) {
                console.error('Failed to send env error reply:', err.message);
            }
            return;
        }

        let restartStatusMsg = null;
        try {
            restartStatusMsg = await message.reply('⏳ Запускаю пересборку контейнера... 0%');
        } catch (err) {
            console.error('Failed to send restart starting message:', err.message);
        }

        // Clear any stale progress file so the chat doesn't "jump to 97%".
        try { fs.writeFileSync('./build_progress.txt', '0'); } catch (_) {}

        let lastRestartPercent = 0;
        let lastRestartEdit = 0;
        let lastLayerStep = '';
        let sawAnyProgress = false;
        // Monotonic max target from the raw build stream. BuildKit emits [n/N]
        // for parallel stages out of order, so we only raise a monotonic max and
        // let the chat poll publish from the (smooth, monotonic) progress file.
        let targetPercent = 0;

        const publishRestartProgress = (percent, stageLabel = '') => {
            if (!Number.isFinite(percent)) return;
            const normalized = Math.max(lastRestartPercent, Math.max(0, Math.min(100, Math.floor(percent))));
            const now = Date.now();
            if (normalized === lastRestartPercent && (now - lastRestartEdit) < 3000) return;
            lastRestartPercent = normalized;
            lastRestartEdit = now;
            sawAnyProgress = true;
            let statusText = `⏳ Пересборка контейнера: ${normalized}%`;
            if (stageLabel) statusText += ` (слой ${stageLabel})`;
            if (restartStatusMsg) {
                restartStatusMsg.edit(statusText).catch(() => {});
            }
        };

        const parseRestartProgress = (line) => {
            if (!line) return;
            const parsed = parseRebuildProgressLine(line, lastRestartPercent);
            if (!parsed) return;
            const current = parsed.current;
            const total = parsed.total;
            let stageLabel = '';
            let percent;
            if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
                stageLabel = parsed.stageLabel || `${current}/${total}`;
                lastLayerStep = stageLabel;
                percent = Math.floor((current * 85) / total);
            } else {
                const lower = String(line).toLowerCase();
                if (!/rebuild|progress|фаз|пересборк/.test(lower)) return;
                percent = Math.floor((Number(parsed.percent) || 0) * 85 / 100);
            }
            if (Number.isFinite(percent) && percent > targetPercent) {
                targetPercent = percent;
            }
        };

        // The build runs locally (Docker socket is mounted into the container).
        // We stream the build output and parse BuildKit [n/N] lines for progress,
        // then launch a detached helper container to swap in the new image.
        const buildCmd = `BUILDX_GIT_INFO=false docker build --build-arg CACHEBUST=${Math.floor(Date.now() / 1000)} -t discord-librarian-bot /usr/src/app`;
        console.log('[Restart Command] Starting local docker build...');

        runCommandStream(buildCmd, {
            timeoutMs: 45 * 60 * 1000,
            onStdout: (line) => { if (line) parseRestartProgress(line); },
            onStderr: (line) => { if (line) parseRestartProgress(line); }
        }).then(async () => {
            console.log('[Restart Command] Build successful. Launching helper container to restart...');
            if (restartStatusMsg) {
                await restartStatusMsg.edit('⏳ Сборка завершена. Перезапуск контейнера...').catch(() => {});
            }
            const normalizedHostPath = hostPath.replace(/\\/g, '/');
            // Build the docker run flags matching rebuild-run.sh (cookies mount,
            // ssh key mount, iGPU passthrough, ollama network, env vars).
            // The helper container runs on the HOST via the Docker socket, so
            // -v source paths are HOST paths (from HOST_PATH env var).
            const { execSync: execSync2 } = require('child_process');
            let restartFlags = `-e HOST_PATH=\\"${normalizedHostPath}\\" -e SHARE_PASS -e TRANSCODER_CONTAINER -v /var/run/docker.sock:/var/run/docker.sock -v \\"${normalizedHostPath}:/usr/src/app\\" -v /usr/src/app/node_modules`;
            // Cookies mount: check if cookies are available in the container.
            if (fs.existsSync('/tmp/cookies.txt')) {
                restartFlags += ` -v \\"${normalizedHostPath}/../robot-joe/cookies.txt:/tmp/cookies.txt\\"`;
            } else if (fs.existsSync('/usr/src/app/cookies.txt')) {
                restartFlags += ` -v \\"${normalizedHostPath}/cookies.txt:/usr/src/app/cookies.txt\\"`;
            } else if (fs.existsSync('/usr/src/app/instagram-cookies.txt')) {
                restartFlags += ` -v \\"${normalizedHostPath}/instagram-cookies.txt:/usr/src/app/instagram-cookies.txt\\"`;
            }
            // SSH key mount
            if (fs.existsSync('/usr/src/app/id_rsa')) {
                restartFlags += ` -v \\"${normalizedHostPath}/id_rsa:/usr/src/app/id_rsa\\"`;
            } else if (fs.existsSync('/usr/src/app/id_ed25519')) {
                restartFlags += ` -v \\"${normalizedHostPath}/id_ed25519:/usr/src/app/id_ed25519\\"`;
            }
            // iGPU passthrough
            try {
                execSync2('test -e /dev/dri/renderD128', {encoding:'utf8'});
                const renderGid = execSync2('stat -c %g /dev/dri/renderD128 2>/dev/null || echo 109', {encoding:'utf8'}).trim();
                restartFlags += ` --device /dev/dri/renderD128 --group-add ${renderGid}`;
            } catch (_) {}
            // Ollama network
            try {
                execSync2('docker network inspect ollama_default >/dev/null 2>&1');
                restartFlags += ` --network ollama_default`;
            } catch (_) {}

            // Detached helper container stops+removes the old bot and starts the
            // new one (the bot can't restart itself — its own container would be
            // killed mid-process). Matches the slash /restart approach.
            const restartCmd = `docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock docker sh -c "sleep 2 && docker rm -f librarian-bot && docker run -d --name librarian-bot --restart unless-stopped ${restartFlags} discord-librarian-bot"`;
            const { exec } = require('child_process');
            exec(restartCmd, (restartErr) => {
                if (restartErr) {
                    console.error('[Restart Command] Failed to start helper container:', restartErr);
                    if (restartStatusMsg) {
                        restartStatusMsg.edit(`❌ Перезапуск не удался: не удалось запустить вспомогательный контейнер.\n\`\`\`\n${restartErr.message}\n\`\`\``).catch(() => {});
                    }
                    return;
                }
                console.log('[Restart Command] Helper container started successfully.');
                if (restartStatusMsg) {
                    restartStatusMsg.edit('✅ Пересборка завершена: 100%').catch(() => {});
                }
            });
        }).catch(async (err) => {
            console.error('[Restart Command] Rebuild command failed:', err.message);
            if (restartStatusMsg) {
                await restartStatusMsg.edit(`❌ Пересборка завершилась с ошибкой на ${lastRestartPercent}%`).catch(() => {});
            }
        });
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

    // --- Role-mention fallback ---
    // Some users ping the bot's ROLE (<@&ROLE_ID>) instead of the bot account
    // (<@USER_ID>). message.mentions.users does not include role mentions, so
    // the handler above is skipped. As a fallback, if the message contains one
    // or more role mentions AND the bot member itself holds that role, treat it
    // as a direct bot mention: strip the role mention(s) and run the RAG query.
    if (message.mentions.roles.size > 0 && message.guild) {
        const botMember = message.guild.members.resolve(client.user.id);
        if (botMember && botMember.roles.cache.size > 1 /* has a role beyond @everyone */) {
            const botRoleIds = botMember.roles.cache.keys();
            const matchedRoleIds = [...message.mentions.roles.keys()].filter(rid => botRoleIds.some(bid => bid === rid));
            if (matchedRoleIds.length > 0) {
                let query = message.content;
                for (const rid of matchedRoleIds) {
                    query = query.replace(new RegExp(`<@&${rid}>`, 'g'), '');
                }
                // Also strip any leftover user mentions of the bot (in case both
                // were used) so the query is clean.
                query = query.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();

                if (query.length === 0) {
                    try {
                        return await message.reply(helpText);
                    } catch (err) {
                        console.error('Failed to send help text (role mention):', err);
                    }
                    return;
                }

                console.log(`[Mention] Role-mention fallback triggered by ${message.author.tag} (${message.author.id}) in ${message.channel.id}; matched role(s): ${matchedRoleIds.join(', ')}`);
                await handleRagQuery(client, message, query);
                return;
            }
        }
    }

    if (message.channel.parentId === ACTIVE_CATEGORY_ID && !message.channel.isThread()) {
        const topic = message.channel.topic || '';
        const content = message.content.trim();

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

                // Reuse an existing campaign role if one was created at
                // channel-creation time (SETUP|...|ROLE:<id>). Otherwise create
                // a fresh role.
                const roleMatch = topic.match(/ROLE:(\d+)/);
                let role = roleMatch ? message.guild.roles.cache.get(roleMatch[1]) : null;
                if (!role) {
                    role = await message.guild.roles.create({
                        name: message.channel.name,
                        reason: 'Automated role for new active campaign channel'
                    });
                }

                await message.channel.permissionOverwrites.edit(role.id, {
                    MentionEveryone: true
                });

                const userMatch = topic.match(/USERS:([\d,]*)/);
                if (userMatch && userMatch[1]) {
                    const usersToRole = userMatch[1].split(',');
                    for (const uid of usersToRole) {
                        const member = await message.guild.members.fetch(uid).catch(() => null);
                        if (member && !member.roles.cache.has(role.id)) {
                            await member.roles.add(role).catch(() => { });
                        }
                    }
                }

                const finalDmId = dmId || message.author.id;
                await message.channel.setTopic(`Active Campaign [LIBRARIAN_DATA|DM:${finalDmId}|ROLE:${role.id}]`);

                // --- Auto-add mentioned users as channel players ---
                // Scan the first 10 messages of the channel for user mentions
                // (the OP + follow-up replies). Any mentioned user who is not
                // already in the campaign role gets added to it so they receive
                // the role's @mentions for scheduling/announcements.
                try {
                    const earlyMessages = await message.channel.messages.fetch({ after: DISCORD_START_SNOWFLAKE, limit: 10 });
                    const mentionedIds = new Set();
                    for (const m of earlyMessages.values()) {
                        for (const u of m.mentions.users.values()) {
                            if (u.id !== client.user.id && !u.bot) {
                                mentionedIds.add(u.id);
                            }
                        }
                    }
                    let addedFromMentions = 0;
                    for (const uid of mentionedIds) {
                        const member = await message.guild.members.fetch(uid).catch(() => null);
                        if (member && !member.roles.cache.has(role.id)) {
                            await member.roles.add(role).catch(() => { });
                            addedFromMentions++;
                        }
                    }
                    if (addedFromMentions > 0) {
                        console.log(`[OP Workflow] Auto-added ${addedFromMentions} mentioned user(s) to campaign role ${role.name} (${role.id}) from first 10 messages in ${message.channel.name}.`);
                    }
                } catch (mentionErr) {
                    console.warn('[OP Workflow] Failed to scan early messages for mentions:', mentionErr.message);
                }
            } catch (err) {
                console.error('Failed to process OP workflow:', err);
            }
        }
    }
}

module.exports = handleMessageCreate;
