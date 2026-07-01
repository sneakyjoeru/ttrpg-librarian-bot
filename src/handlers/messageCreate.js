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
const {
    SERVER_ID,
    ACTIVE_CATEGORY_ID,
    EMOJI_ROBOT,
    EMOJI_HAND,
    DISCORD_START_SNOWFLAKE,
    SNEAKYJOE_USER_ID,
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
