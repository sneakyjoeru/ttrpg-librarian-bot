const { PermissionFlagsBits, ChannelType } = require('discord.js');
const axios = require('axios');
const { getLibrarianData } = require('../utils/helpers');
const {
    helpText,
    SERVER_ID,
    ACTIVE_CATEGORY_ID,
    ARCHIVED_CATEGORY_ID,
    DM_ROLE_ID,
    EMBED_COLOR,
    NUMBER_EMOJIS,
    FALLBACK_ROASTS,
    OLLAMA_URL,
    OLLAMA_MODEL,
    RAG_OLLAMA_TIMEOUT,
    THREAD_AUTO_ARCHIVE_DURATION_SEVEN_DAYS,
    THREAD_AUTO_ARCHIVE_DURATION_ONE_DAY,
    DISCORD_START_SNOWFLAKE,
    EMOJI_ROBOT,
    EMOJI_HAND
} = require('../config');
const { refreshPoll } = require('./polls');

async function handleInteraction(client, interaction) {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.guildId !== SERVER_ID) return;

    const { commandName } = interaction;
    const hasPermission = interaction.member.roles.cache.has(DM_ROLE_ID) || interaction.member.permissions.has(PermissionFlagsBits.Administrator);

    if (commandName === 'librarian-bot') {
        return interaction.reply({ content: helpText, ephemeral: true });
    }

    if (commandName === 'set-topic') {
        if (interaction.channel.parentId !== ACTIVE_CATEGORY_ID) {
            return interaction.reply({ content: 'This command can only be used in an active campaign channel.', ephemeral: true });
        }

        const metaData = await getLibrarianData(interaction.channel);

        if (!metaData) {
            const topic = interaction.channel.topic || '';
            if (topic.startsWith('SETUP|')) {
                const setupMatch = topic.match(/DM:(\d+)/);
                const setupDmId = setupMatch ? setupMatch[1] : null;
                if (interaction.user.id !== setupDmId && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.reply({ content: 'Only the DM who created this campaign (or an Admin) can change the topic before the OP is posted.', ephemeral: true });
                }
            } else if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Metadata missing in channel topic. Only Admins can force update this topic.', ephemeral: true });
            }
        } else {
            if (metaData.dmId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Only the DM who created the campaign (or an Admin) can change the topic of this channel.', ephemeral: true });
            }
        }

        const newText = interaction.options.getString('text');
        let metadataString = '';

        // Find and extract the existing bot data block from the current topic
        if (interaction.channel.topic && interaction.channel.topic.includes('[LIBRARIAN_DATA|')) {
            const topicMatch = interaction.channel.topic.match(/(\[LIBRARIAN_DATA\|DM:\d+\|ROLE:\d+\])/);
            if (topicMatch) {
                metadataString = topicMatch[1];
            }
        }

        // Discord limit for channel description is 1024 characters.
        // Allocate guaranteed space for metadata at the end of the string.
        const maxLimit = 1024;
        const metaSpace = metadataString ? metadataString.length + 1 : 0;
        const availableSpace = maxLimit - metaSpace;

        let trimmedText = newText;
        if (trimmedText.length > availableSpace) {
            trimmedText = trimmedText.substring(0, availableSpace);
        }

        const finalTopic = metadataString ? `${trimmedText} ${metadataString}` : trimmedText;

        try {
            await interaction.channel.setTopic(finalTopic);
            return interaction.reply({ content: 'Channel topic updated successfully while preserving bot data.', ephemeral: true });
        } catch (error) {
            console.error('Set-topic error:', error);
            return interaction.reply({ content: 'Failed to update channel topic. Check bot permissions.', ephemeral: true });
        }
    }

    if (commandName === 'archive') {
        if (interaction.channel.parentId !== ACTIVE_CATEGORY_ID) {
            return interaction.reply({ content: 'This command can only be used in an active campaign channel.', ephemeral: true });
        }

        const confirmation = interaction.options.getString('confirmation');
        const expected = `yes, I want to archive ${interaction.channel.name}`;

        if (confirmation !== expected) {
            return interaction.reply({ content: `Confirmation failed. You must type exactly:\n\`${expected}\``, ephemeral: true });
        }

        const metaData = await getLibrarianData(interaction.channel);

        if (!metaData) {
            const topic = interaction.channel.topic || '';
            if (topic.startsWith('SETUP|')) {
                const setupMatch = topic.match(/DM:(\d+)/);
                const setupDmId = setupMatch ? setupMatch[1] : null;
                if (interaction.user.id !== setupDmId && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.reply({ content: 'Only the DM who created this campaign (or an Admin) can archive it before the OP is posted.', ephemeral: true });
                }
            } else if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Metadata missing in channel topic. Only Admins can force archive this channel.', ephemeral: true });
            }
        } else {
            if (metaData.dmId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Only the DM who created the campaign (or an Admin) can archive this channel.', ephemeral: true });
            }
        }

        try {
            await interaction.channel.setParent(ARCHIVED_CATEGORY_ID, { reason: `Archived by ${interaction.user.tag}` });

            if (metaData && metaData.roleId) {
                const role = interaction.guild.roles.cache.get(metaData.roleId);
                if (role) await role.delete('Campaign archived');
            }
            await interaction.reply({ content: 'Channel successfully archived and role removed.', ephemeral: true });
        } catch (error) {
            console.error('Archive error:', error);
            await interaction.reply({ content: 'Failed to archive. Check bot permissions.', ephemeral: true });
        }
        return;
    }

    if (commandName === 'retro-setup') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'Admin only.', ephemeral: true });
        if (interaction.channel.parentId !== ACTIVE_CATEGORY_ID) return interaction.reply({ content: 'Must be in active category.', ephemeral: true });

        const existingData = await getLibrarianData(interaction.channel);

        if (existingData) {
            try {
                if (existingData.roleId) {
                    await interaction.channel.permissionOverwrites.edit(existingData.roleId, {
                        MentionEveryone: true
                    });
                    return interaction.reply({ content: 'Channel already had metadata. Role permissions updated successfully.', ephemeral: true });
                }
            } catch (err) {
                console.error(err);
                return interaction.reply({ content: 'Channel has metadata, but failed to update role permissions.', ephemeral: true });
            }
        }

        try {
            const firstMessages = await interaction.channel.messages.fetch({ after: DISCORD_START_SNOWFLAKE, limit: 1 });
            const opMessage = firstMessages.first();
            if (!opMessage) return interaction.reply({ content: 'No OP found.', ephemeral: true });

            await opMessage.pin();
            await opMessage.react(EMOJI_ROBOT);
            await opMessage.react(EMOJI_HAND);

            let role = interaction.guild.roles.cache.find(r => r.name === interaction.channel.name);
            if (!role) {
                role = await interaction.guild.roles.create({
                    name: interaction.channel.name,
                    reason: 'Automated role created via retro-setup'
                });
            }

            await interaction.channel.permissionOverwrites.edit(role.id, {
                MentionEveryone: true
            });

            const appendData = `[LIBRARIAN_DATA|DM:${opMessage.author.id}|ROLE:${role.id}]`;
            const currentTopic = interaction.channel.topic || '';
            const newTopic = currentTopic ? `${currentTopic} ${appendData}` : appendData;
            await interaction.channel.setTopic(newTopic);

            await interaction.reply({ content: 'Retroactive setup complete.', ephemeral: true });
        } catch (e) {
            console.error(e);
            await interaction.reply({ content: 'Failed retroactive setup.', ephemeral: true });
        }
        return;
    }

    if (commandName === 'poll-librarian') {
        const question = interaction.options.getString('question');
        const optionsString = interaction.options.getString('options');

        // Split the string by commas, trim spaces, and filter out empty options
        const optionsArray = optionsString.split(',').map(opt => opt.trim()).filter(opt => opt.length > 0);

        if (optionsArray.length < 2 || optionsArray.length > 10) {
            return interaction.reply({ content: 'Please provide between 2 and 10 comma-separated options.', ephemeral: true });
        }

        let descriptionText = '';

        for (let i = 0; i < optionsArray.length; i++) {
            descriptionText += `${NUMBER_EMOJIS[i]} ${optionsArray[i]}\n\n`;
        }

        const pollEmbed = {
            color: EMBED_COLOR,
            title: `📊 ${question}`,
            description: descriptionText,
            footer: {
                text: `Poll created by ${interaction.user.username}`
            }
        };

        // Send Embed and store the message object so the bot can react to it
        await interaction.reply({ embeds: [pollEmbed], fetchReply: true });
        const pollMessage = await interaction.fetchReply();

        // Bot automatically adds reactions for voting
        try {
            for (let i = 0; i < optionsArray.length; i++) {
                await pollMessage.react(NUMBER_EMOJIS[i]);
            }
        } catch (error) {
            console.error('Failed to react to poll:', error);
        }

        // Initialize the live voter/winners display (shows "No votes yet"
        // per option until the first vote lands).
        await refreshPoll(pollMessage, client.user.id).catch(console.error);

        return;
    }

    if (commandName === 'new-campaign' || commandName === 'new-private-campaign') {
        if (!hasPermission) return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });

        const cName = interaction.options.getString('campaign_name');
        const usersInput = interaction.options.getString('usernames');
        const userRegex = /<@!?(\d+)>/g;
        const matches = [...usersInput.matchAll(userRegex)];
        const userIds = matches.map(m => m[1]);
        const playerCount = userIds.length > 0 ? userIds.length : usersInput.split(/\s+/).filter(Boolean).length;
        const creatorName = interaction.user.username;

        let finalChannelName = `${cName}-${creatorName}-${playerCount}`;
        if (finalChannelName.length > 100) finalChannelName = finalChannelName.substring(0, 100);

        const permissionOverwrites = [
            {
                id: interaction.guild.id,
                allow: commandName === 'new-campaign' ? [PermissionFlagsBits.ViewChannel] : [],
                deny: commandName === 'new-private-campaign' ? [PermissionFlagsBits.ViewChannel] : []
            },
            {
                id: interaction.user.id,
                allow: [PermissionFlagsBits.ViewChannel]
            },
            {
                id: client.user.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles]
            }
        ];

        for (const uid of userIds) {
            permissionOverwrites.push({ id: uid, allow: [PermissionFlagsBits.ViewChannel] });
        }

        try {
            const channel = await interaction.guild.channels.create({
                name: finalChannelName,
                type: ChannelType.GuildText,
                parent: ACTIVE_CATEGORY_ID,
                topic: `SETUP|DM:${interaction.user.id}|USERS:${userIds.join(',')}`,
                permissionOverwrites: permissionOverwrites
            });

            await interaction.reply({ content: `Channel created: ${channel}. Waiting for DM to post OP to generate roles.`, ephemeral: true });
        } catch (e) {
            console.error(e);
            await interaction.reply({ content: 'Failed to create channel.', ephemeral: true });
        }
    }

    if (commandName === 'new-thread') {
        const tName = interaction.options.getString('threadname');
        try {
            const thread = await interaction.channel.threads.create({
                name: tName,
                autoArchiveDuration: THREAD_AUTO_ARCHIVE_DURATION_ONE_DAY,
                type: ChannelType.PublicThread
            });
            await interaction.reply({ content: `Thread created: ${thread}`, ephemeral: true });
        } catch (e) {
            console.error(e);
            await interaction.reply({ content: 'Failed to create thread.', ephemeral: true });
        }
    }

    if (commandName === 'new-private-thread') {
        if (!hasPermission) return interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });

        const usersInput = interaction.options.getString('usernames');
        const userRegex = /<@!?(\d+)>/g;
        const matches = [...usersInput.matchAll(userRegex)];

        try {
            const thread = await interaction.channel.threads.create({
                name: 'Private Thread',
                autoArchiveDuration: THREAD_AUTO_ARCHIVE_DURATION_ONE_DAY,
                type: ChannelType.PrivateThread
            });
            for (const m of matches) {
                await thread.members.add(m[1]).catch(() => { });
            }
            await thread.members.add(interaction.user.id);
            await interaction.reply({ content: `Private thread created: ${thread}`, ephemeral: true });
        } catch (e) {
            console.error(e);
            await interaction.reply({ content: 'Failed to create private thread.', ephemeral: true });
        }
    }

    if (commandName === 'update-players') {
        if (interaction.channel.parentId !== ACTIVE_CATEGORY_ID) {
            return interaction.reply({ content: 'This command can only be used in an active campaign channel.', ephemeral: true });
        }

        const metaData = await getLibrarianData(interaction.channel);

        if (!metaData) {
            const topic = interaction.channel.topic || '';
            if (topic.startsWith('SETUP|')) {
                const setupMatch = topic.match(/DM:(\d+)/);
                const setupDmId = setupMatch ? setupMatch[1] : null;
                if (interaction.user.id !== setupDmId && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.reply({ content: 'Only the DM who created this campaign (or an Admin) can update it before the OP is posted.', ephemeral: true });
                }
            } else if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Metadata missing. Only Admins can force update this channel.', ephemeral: true });
            }
        } else {
            if (metaData.dmId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return interaction.reply({ content: 'Only the DM who created the campaign (or an Admin) can change the player count.', ephemeral: true });
            }
        }

        const newCount = interaction.options.getInteger('count');
        const parts = interaction.channel.name.split('-');

        if (parts.length < 2) {
            return interaction.reply({ content: 'Channel name format is invalid for this operation.', ephemeral: true });
        }

        parts.pop(); // Remove the old number
        const newName = [...parts, newCount].join('-');

        try {
            if (metaData && metaData.roleId) {
                const role = interaction.guild.roles.cache.get(metaData.roleId);
                if (role) {
                    await role.edit({ name: newName });
                }
            }

            await interaction.channel.setName(newName);
            return interaction.reply({ content: `Successfully updated player count. New name: ${newName}`, ephemeral: true });
        } catch (error) {
            console.error('Update-players error:', error);
            return interaction.reply({ content: 'Failed to update channel. Note: Discord limits channel renames to 2 times per 10 minutes.', ephemeral: true });
        }
    }

    if (commandName === 'roll') {
        const formula = interaction.options.getString('formula');
        const charClass = interaction.options.getString('class') || 'Unknown';
        const userContext = interaction.options.getString('context') || 'Unknown';

        // --- DICE FORMULA PARSING ---
        const cleanedFormula = formula.replace(/\s+/g, '').toLowerCase();
        const match = cleanedFormula.match(/^(\d*)d(\d+)(?:([+-])(\d+))?$/);

        if (!match) {
            return interaction.reply({
                content: `Invalid dice formula format: \`${formula}\`. Please use standard format like \`1d20+5\`, \`2d6\`, or \`d20\`.`,
                ephemeral: true
            });
        }

        const numDice = match[1] === "" ? 1 : parseInt(match[1], 10);
        const faces = parseInt(match[2], 10);
        const sign = match[3];
        const mod = match[4] ? parseInt(match[4], 10) : 0;

        // --- VALIDATION LIMITS ---
        if (numDice < 1 || numDice > 100) {
            return interaction.reply({ content: 'Number of dice must be between 1 and 100.', ephemeral: true });
        }
        if (faces < 2 || faces > 1000) {
            return interaction.reply({ content: 'Dice faces must be between 2 and 1000.', ephemeral: true });
        }

        // --- SIMULATE ROLLS ---
        const rolls = [];
        let sum = 0;
        for (let i = 0; i < numDice; i++) {
            const roll = Math.floor(Math.random() * faces) + 1;
            rolls.push(roll);
            sum += roll;
        }

        const modifier = sign === '-' ? -mod : mod;
        const total = sum + modifier;

        const isD20 = (faces === 20);
        const hasCritFail = isD20 && rolls.includes(1);
        const hasCritSuccess = isD20 && rolls.includes(20);

        const rollsStr = rolls.length === 1 ? `[${rolls[0]}]` : `[${rolls.join(', ')}]`;
        const modStr = mod > 0 ? ` ${sign} ${mod}` : '';
        const rollType = (faces === 20) ? 'Chance / Check / Attack' : 'Damage / Other';

        let title = `🎲 Dice Roll`;
        let embedColor = EMBED_COLOR;
        let responseContent = `**Roll Result** for ${interaction.user}:\nFormula: \`${formula}\`\nRoll Type: \`${rollType}\`\nRolls: \`${rollsStr}${modStr}\`\nTotal: **${total}**`;

        if (hasCritSuccess && !hasCritFail) {
            title = `⚔️ CRITICAL HIT! 🎲`;
            embedColor = 0x2ecc71; // Green
            responseContent += `\n\n*The gods of fate smile upon you! An outstanding success!*`;
        }

        if (hasCritFail) {
            title = `💀 CRITICAL FAIL! 🎲`;
            embedColor = 0xe74c3c; // Red

            await interaction.deferReply();

            let chatHistoryContext = 'No recent chat history.';
            try {
                const previousMessages = await interaction.channel.messages.fetch({ limit: 10 }).catch(() => null);
                if (previousMessages && previousMessages.size > 0) {
                    const historyArray = previousMessages.map(m => `[${m.author.username}]: ${m.cleanContent}`).reverse();
                    chatHistoryContext = historyArray.join('\n');
                }
            } catch (historyErr) {
                console.error('Failed to fetch channel history for /roll roast:', historyErr);
            }

            const channelName = interaction.channel.name || 'Unknown channel';
            const channelTopic = interaction.channel.topic || 'No topic';

            const systemPrompt = `You are a snarky, witty, and savage TTRPG dungeon master.
                The player rolled a natural 1 (Critical Fail) on their dice roll.
                Your task is to generate a custom, hyper-specific, short, and hilarious insult roasting the character's utter incompetence.

                Player Discord Username: ${interaction.user.username}
                Dice Formula rolled: ${formula}
                Character Class: ${charClass}
                What they were trying to do/context of the roll: ${userContext}
                Channel Name: ${channelName}
                Channel Topic: ${channelTopic}
                Recent channel chat history for context of what they are doing:
                ${chatHistoryContext}

                Guidelines:
                - Make the roast hyper-specific to their class, their action/context, or their recent actions if known.
                - Keep it concise (1 to 2 sentences maximum, under 60 words).
                - Be incredibly roasting, mocking, and sarcastic about their failure, but keep it PG-13/appropriate for a Discord server (no extreme hate speech, just good-natured but brutal D&D roleplay roasting).
                - Do not include any meta-talk or introductory phrasing like "Here is your insult:". Just output the insult directly.`;

            let insult = "";
            try {
                const ollamaResponse = await axios.post(OLLAMA_URL, {
                    model: OLLAMA_MODEL,
                    prompt: systemPrompt,
                    stream: false,
                    options: {
                        temperature: 0.8
                    }
                }, { timeout: RAG_OLLAMA_TIMEOUT });

                if (ollamaResponse.data && ollamaResponse.data.response) {
                    insult = ollamaResponse.data.response.trim();
                }
            } catch (ollamaErr) {
                console.warn('Ollama roast generation failed, using fallback roast:', ollamaErr.message);
                const randomRoast = FALLBACK_ROASTS[Math.floor(Math.random() * FALLBACK_ROASTS.length)];
                insult = `*${randomRoast}* *(AI backend offline, using archived roast)*`;
            }

            responseContent += `\n\n**The Librarian roasts you:**\n> ${insult}`;

            const rollEmbed = {
                color: embedColor,
                title: title,
                description: responseContent,
                footer: {
                    text: `Class: ${charClass} | Context: ${userContext}`
                }
            };

            return await interaction.editReply({ embeds: [rollEmbed] });
        }

        const rollEmbed = {
            color: embedColor,
            title: title,
            description: responseContent
        };
        if (hasCritSuccess || charClass !== 'Unknown' || userContext !== 'Unknown') {
            rollEmbed.footer = {
                text: `Class: ${charClass} | Context: ${userContext}`
            };
        }

        return await interaction.reply({ embeds: [rollEmbed] });
    }

    if (commandName === 'restart') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: 'Only Administrators can trigger a restart.', ephemeral: true });
        }

        await interaction.reply({ content: '🔄 Rebuilding bot image and restarting container... Please wait.', ephemeral: true });
        const interactionToken = interaction.token;

        const hostPath = process.env.HOST_PATH;
        if (!hostPath) {
            console.error('[Restart Command] HOST_PATH environment variable is not defined.');
            return interaction.followUp({ content: '❌ Error: `HOST_PATH` environment variable is not set. Cannot restart.', ephemeral: true });
        }

        const normalizedHostPath = hostPath.replace(/\\/g, '/');
        const { exec } = require('child_process');

        console.log('[Restart Command] Starting docker build...');
        exec('BUILDX_GIT_INFO=false docker build -t discord-librarian-bot /usr/src/app', (buildErr, stdout, stderr) => {
            if (buildErr) {
                console.error('[Restart Command] Build failed:', buildErr);
                return interaction.followUp({ content: `❌ Rebuild failed:\n\`\`\`\n${buildErr.message}\n\`\`\``, ephemeral: true });
            }

            console.log('[Restart Command] Build successful. Launching helper container to restart...');

            // Start a detached helper container to stop, remove, and run the new container
            const restartCmd = `docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock docker sh -c "sleep 2 && docker rm -f librarian-bot && docker run -d --name librarian-bot --restart unless-stopped -e HOST_PATH=\\"${normalizedHostPath}\\" -e RESTART_TOKEN=\\"${interactionToken}\\" -v /var/run/docker.sock:/var/run/docker.sock -v \\"${normalizedHostPath}:/usr/src/app\\" -v /usr/src/app/node_modules discord-librarian-bot"`;

            exec(restartCmd, (restartErr, rStdout, rStderr) => {
                if (restartErr) {
                    console.error('[Restart Command] Failed to start helper container:', restartErr);
                    return interaction.followUp({ content: `❌ Restart failed: failed to start helper container.\n\`\`\`\n${restartErr.message}\n\`\`\``, ephemeral: true });
                }
                console.log('[Restart Command] Helper container started successfully.');
            });
        });
        return;
    }
}

module.exports = handleInteraction;
