const { PermissionFlagsBits, ChannelType } = require('discord.js');
const axios = require('axios');
const { getLibrarianData } = require('../utils/helpers');
const {
    helpText,
    SERVER_ID,
    ACTIVE_CATEGORY_ID,
    ARCHIVED_CATEGORY_ID,
    GAME_INVITATIONS_FORUM_ID,
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
    EMOJI_HAND,
    SNEAKYJOE_USER_ID
} = require('../config');
const { refreshPoll } = require('./polls');
const { createSchedulePoll } = require('./scheduling');
const { isMessageTiedToUser, removeTrackedMessage } = require('../utils/messageTracker');
const { buildRecoveredPlaceholder } = require('../utils/webhook');
const { handleInstagramMessage } = require('../services/instagram');
const { handleTwitterMessage } = require('./twitterHandler');
const { handleFacebookMessage } = require('./facebookHandler');
const { handleArticleMessage } = require('./articleHandler');

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
            description: descriptionText
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

    if (commandName === 'schedule-poll') {
        return createSchedulePoll(interaction).catch(async (e) => {
            console.error('[Scheduling] createSchedulePoll failed:', e);
            try {
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({ content: '📅 Failed to create the scheduling poll.', ephemeral: true });
                } else {
                    await interaction.reply({ content: '📅 Failed to create the scheduling poll.', ephemeral: true });
                }
            } catch (_) {}
        });
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

            // If a list of players was provided, create the campaign role
            // immediately and assign it to those players (if not already
            // assigned). The role ID is stored in the SETUP topic so the
            // OP-time workflow reuses this role instead of creating a
            // duplicate.
            let roleId = null;
            let assignedCount = 0;
            if (userIds.length > 0) {
                try {
                    const role = await interaction.guild.roles.create({
                        name: finalChannelName,
                        reason: 'Automated role for new campaign channel'
                    });
                    roleId = role.id;

                    await channel.permissionOverwrites.edit(role.id, {
                        MentionEveryone: true
                    }).catch(() => { });

                    for (const uid of userIds) {
                        const member = await interaction.guild.members.fetch(uid).catch(() => null);
                        if (member) {
                            if (!member.roles.cache.has(role.id)) {
                                await member.roles.add(role).catch(() => { });
                            }
                            assignedCount++;
                        }
                    }

                    const setupTopic = `SETUP|DM:${interaction.user.id}|USERS:${userIds.join(',')}|ROLE:${roleId}`;
                    await channel.setTopic(setupTopic).catch(() => { });
                } catch (roleErr) {
                    console.error('Failed to create/assign campaign role at creation:', roleErr);
                }
            }

            const msg = roleId
                ? `Channel created: ${channel}. Campaign role created and assigned to ${assignedCount} player(s). Waiting for DM to post OP.`
                : `Channel created: ${channel}. Waiting for DM to post OP to generate roles.`;
            await interaction.reply({ content: msg, ephemeral: true });
        } catch (e) {
            console.error(e);
            await interaction.reply({ content: 'Failed to create channel.', ephemeral: true });
        }
    }

    if (commandName === 'new-thread') {
        const tName = interaction.options.getString('threadname');
        try {
            let channel = interaction.channel;
            if (!channel && interaction.channelId) {
                channel = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
            }
            if (!channel || !channel.threads) {
                return interaction.reply({ content: '⚠️ **Can\'t create a thread here.**\n\nYou\'re currently inside a **thread** (this includes forum posts — every post in a forum channel is itself a thread). Discord does not allow threads inside other threads; they can only be created inside a regular text channel or a forum channel.\n\n**To create a thread:** go to a **text channel** or the **forum channel itself** (not inside a post), then run `/new-thread`.\n\n• In a text channel → creates a public thread in that channel.\n• In a forum channel → creates a new forum post.', ephemeral: true });
            }
            const isForum = channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia;
            const createOpts = {
                name: tName,
                autoArchiveDuration: THREAD_AUTO_ARCHIVE_DURATION_ONE_DAY
            };
            if (isForum) {
                // Forum posts require an initial message and cannot set the thread type.
                createOpts.message = { content: `Thread created by ${interaction.user}` || ' ' };
                // Some forum channels require at least one tag to create a post.
                if (channel.availableTags && channel.availableTags.length > 0) {
                    createOpts.appliedTags = [channel.availableTags[0].id];
                }
            } else {
                createOpts.type = ChannelType.PublicThread;
            }
            const thread = await channel.threads.create(createOpts);
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
            let channel = interaction.channel;
            if (!channel && interaction.channelId) {
                channel = await interaction.client.channels.fetch(interaction.channelId).catch(() => null);
            }
            if (!channel || !channel.threads) {
                return interaction.reply({ content: '⚠️ **Can\'t create a private thread here.**\n\nYou\'re currently inside a **thread** (this includes forum posts — every post in a forum channel is itself a thread). Discord does not allow threads inside other threads; they can only be created inside a regular text channel or a forum channel.\n\n**To create a private thread:** go to a **text channel** or the **forum channel itself** (not inside a post), then run `/new-private-thread`.\n\n• In a text channel → creates a private thread in that channel.\n• In a forum channel → creates a new forum post.', ephemeral: true });
            }
            const isForum = channel.type === ChannelType.GuildForum || channel.type === ChannelType.GuildMedia;
            const createOpts = {
                name: 'Private Thread',
                autoArchiveDuration: THREAD_AUTO_ARCHIVE_DURATION_ONE_DAY
            };
            if (isForum) {
                // Forum posts require an initial message and cannot set the thread type.
                createOpts.message = { content: `Private thread created by ${interaction.user}` || ' ' };
                // Some forum channels require at least one tag to create a post.
                if (channel.availableTags && channel.availableTags.length > 0) {
                    createOpts.appliedTags = [channel.availableTags[0].id];
                }
            } else {
                createOpts.type = ChannelType.PrivateThread;
            }
            const thread = await channel.threads.create(createOpts);
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

    if (commandName === 'pin' || commandName === 'unpin') {
        // Two valid contexts:
        // 1) Active campaign channel (parentId === ACTIVE_CATEGORY_ID), NOT a thread.
        // 2) A thread inside the Game Invitations forum (channel.parentId ===
        //    GAME_INVITATIONS_FORUM_ID) — the thread owner (OP) can pin/unpin.
        const isForumThread = interaction.channel.isThread() && interaction.channel.parentId === GAME_INVITATIONS_FORUM_ID;

        if (!isForumThread) {
            if (interaction.channel.parentId !== ACTIVE_CATEGORY_ID) {
                return interaction.reply({ content: 'This command can only be used in an active campaign channel or a Game Invitations forum thread.', ephemeral: true });
            }
            if (interaction.channel.isThread()) {
                return interaction.reply({ content: 'This command cannot be used in a thread.', ephemeral: true });
            }
        }

        const isPin = commandName === 'pin';
        const messageId = interaction.options.getString('message_id');
        console.log(`[Pin Command] /${commandName} by ${interaction.user.tag} (${interaction.user.id}) in channel ${interaction.channel.id}${messageId ? `, target: ${messageId}` : ', no ID (last)'}`);

        // For Game Invitations forum threads: only the thread owner (OP) or an
        // Admin may pin/unpin. The thread's OP is the author of the starter
        // message (the first message of the thread).
        if (isForumThread) {
            const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator);
            if (!isAdmin) {
                let ownerId = null;
                try {
                    const starter = await interaction.channel.fetchStarterMessage().catch(() => null);
                    if (starter) ownerId = starter.author.id;
                } catch (_) {}
                if (!ownerId || interaction.user.id !== ownerId) {
                    return interaction.reply({ content: 'Only the thread owner (OP) or an Admin can pin/unpin messages in this forum thread.', ephemeral: true });
                }
            }
        } else {
            // Active campaign channel — DM-ownership gate (existing behavior).
            const metaData = await getLibrarianData(interaction.channel);

            if (!metaData) {
                const topic = interaction.channel.topic || '';
                if (topic.startsWith('SETUP|')) {
                    const setupMatch = topic.match(/DM:(\d+)/);
                    const setupDmId = setupMatch ? setupMatch[1] : null;
                    if (interaction.user.id !== setupDmId && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                        return interaction.reply({ content: 'Only the DM who created this campaign (or an Admin) can pin/unpin messages before the OP is posted.', ephemeral: true });
                    }
                } else if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.reply({ content: 'Metadata missing in channel topic. Only Admins can pin/unpin here.', ephemeral: true });
                }
            } else {
                if (metaData.dmId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                    return interaction.reply({ content: 'Only the DM who created the campaign (or an Admin) can pin/unpin messages in this channel.', ephemeral: true });
                }
            }
        }

        try {
            let targetMessage;

            if (messageId) {
                targetMessage = await interaction.channel.messages.fetch(messageId).catch(() => null);
            } else {
                if (isPin) {
                    const lastMessages = await interaction.channel.messages.fetch({ limit: 1 });
                    targetMessage = lastMessages.first();
                } else {
                    const pinnedMessages = await interaction.channel.messages.fetchPinned().catch(() => null);
                    targetMessage = pinnedMessages ? pinnedMessages.first() : null;
                }
            }

            if (!targetMessage) {
                return interaction.reply({ content: `Could not find a message to ${isPin ? 'pin' : 'unpin'}.`, ephemeral: true });
            }

            if (isPin) {
                await targetMessage.pin();
                return interaction.reply({ content: `📌 Pinned [message](<${targetMessage.url}>).`, ephemeral: true });
            } else {
                // In active campaign channels, the OP message (first message in
                // the channel) is protected — only Admins can unpin it.
                // Forum threads have no such protected OP concept.
                if (!isForumThread) {
                    const firstMessages = await interaction.channel.messages.fetch({ after: DISCORD_START_SNOWFLAKE, limit: 1 });
                    const opMessage = firstMessages.first();

                    if (opMessage && targetMessage.id === opMessage.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                        return interaction.reply({ content: 'Only Admins can unpin the OP message.', ephemeral: true });
                    }
                }
                await targetMessage.unpin();
                return interaction.reply({ content: `📌 Unpinned [message](<${targetMessage.url}>).`, ephemeral: true });
            }
        } catch (err) {
            console.error(`/${commandName} error:`, err);
            return interaction.reply({ content: `Failed to ${isPin ? 'pin' : 'unpin'} the message. Check bot permissions.`, ephemeral: true });
        }
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
        exec(`BUILDX_GIT_INFO=false docker build --build-arg CACHEBUST=${Math.floor(Date.now() / 1000)} -t discord-librarian-bot /usr/src/app`, (buildErr, stdout, stderr) => {
            if (buildErr) {
                console.error('[Restart Command] Build failed:', buildErr);
                return interaction.followUp({ content: `❌ Rebuild failed:\n\`\`\`\n${buildErr.message}\n\`\`\``, ephemeral: true });
            }

            console.log('[Restart Command] Build successful. Launching helper container to restart...');

            // Build the docker run flags matching rebuild-run.sh (cookies mount,
            // ssh key mount, iGPU passthrough, ollama network, env vars).
            // The helper container runs on the HOST via the Docker socket, so
            // -v source paths are HOST paths (from HOST_PATH env var).
            const { execSync } = require('child_process');
            let restartFlags = `-e HOST_PATH=\\"${normalizedHostPath}\\" -e SHARE_PASS -e TRANSCODER_CONTAINER -v /var/run/docker.sock:/var/run/docker.sock -v \\"${normalizedHostPath}:/usr/src/app\\" -v /usr/src/app/node_modules`;
            // Cookies mount: check if cookies are available in the container
            // (either at /tmp/cookies.txt from sibling, or /usr/src/app/cookies.txt
            // from local repo). The -v source is a HOST path.
            if (fs.existsSync('/tmp/cookies.txt')) {
                // Cookies are mounted from sibling robot-joe
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
                execSync('test -e /dev/dri/renderD128', {encoding:'utf8'});
                const renderGid = execSync('stat -c %g /dev/dri/renderD128 2>/dev/null || echo 109', {encoding:'utf8'}).trim();
                restartFlags += ` --device /dev/dri/renderD128 --group-add ${renderGid}`;
            } catch (_) {}
            // Ollama network
            try {
                execSync('docker network inspect ollama_default >/dev/null 2>&1');
                restartFlags += ` --network ollama_default`;
            } catch (_) {}

            const restartCmd = `docker run -d --rm -v /var/run/docker.sock:/var/run/docker.sock docker sh -c "sleep 2 && docker rm -f librarian-bot && docker run -d --name librarian-bot --restart unless-stopped ${restartFlags} discord-librarian-bot"`;

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

    // --- /delete slash command ---
    if (commandName === 'delete') {
        const count = interaction.options.getInteger('count');
        if (count === null) {
            // No count: delete the last bot/webhook message tied to the calling user.
            try { interaction.deferReply({ ephemeral: true }).catch(() => { }); } catch (_) {}
            try {
                const fetched = await interaction.channel.messages.fetch({ limit: 50 }).catch(() => null);
                if (fetched && fetched.size > 0) {
                    let deletedTarget = false;
                    for (const msg of fetched.values()) {
                        const isUserMessage = msg.author.id === interaction.user.id;
                        const username = interaction.user.username;
                        const displayName = interaction.member ? interaction.member.displayName : interaction.user.username;
                        const isTied = await isMessageTiedToUser(msg, interaction.user.id, username, displayName, client);
                        if (isUserMessage || isTied) {
                            await msg.delete().catch(() => {});
                            console.log(`[Slash Delete] Deleted message ${msg.id} in channel ${interaction.channel.id} triggered by ${interaction.user.tag} (${interaction.user.id})`);
                            removeTrackedMessage(msg.id);
                            deletedTarget = true;
                            break;
                        }
                    }
                    if (deletedTarget) {
                        await interaction.editReply({ content: '✅ Успешно удалено последнее сообщение.' }).catch(() => { });
                    } else {
                        await interaction.editReply({ content: 'Не найдено подходящих сообщений для удаления.' }).catch(() => { });
                    }
                } else {
                    await interaction.editReply({ content: 'Не найдено сообщений в истории канала.' }).catch(() => { });
                }
            } catch (err) {
                console.error('[Slash Delete] Error during zero-argument deletion:', err.message);
                await interaction.editReply({ content: 'Произошла ошибка при удалении сообщений.' }).catch(() => { });
            }
            return;
        }

        // Count provided: only admin can bulk delete
        if (interaction.user.id !== SNEAKYJOE_USER_ID) {
            await interaction.reply({ content: 'У тебя нет прав для выполнения этой команды с аргументами.', ephemeral: true }).catch(() => { });
            return;
        }

        if (isNaN(count) || count <= 0) {
            await interaction.reply({ content: 'Укажи корректное число сообщений для удаления.', ephemeral: true }).catch(() => { });
            return;
        }

        await interaction.deferReply({ ephemeral: true }).catch(() => { });
        if (interaction.guild) {
            try {
                const fetched = await interaction.channel.messages.fetch({ limit: count }).catch(() => null);
                if (fetched && fetched.size > 0) {
                    await interaction.channel.bulkDelete(fetched, true).then(() => {
                        console.log(`[Slash Delete] Bulk deleted ${fetched.size} messages in channel ${interaction.channel.id} triggered by admin ${interaction.user.tag}`);
                    }).catch(async (err) => {
                        console.warn('[Slash Delete] bulkDelete failed, falling back to manual delete:', err.message);
                        for (const msg of fetched.values()) { await msg.delete().catch(() => { }); }
                    });
                    await interaction.editReply({ content: `Успешно удалено сообщений: ${fetched.size}.` }).catch(() => { });
                } else {
                    await interaction.editReply({ content: 'Не найдено сообщений для удаления.' }).catch(() => { });
                }
            } catch (err) {
                console.error('[Slash Delete] Error during deletion:', err.message);
                await interaction.editReply({ content: 'Произошла ошибка при удалении сообщений.' }).catch(() => { });
            }
        }
        return;
    }

    // --- /edit-last slash command ---
    if (commandName === 'edit-last') {
        try {
            const newText = (interaction.options.getString('text') || '').trim();
            if (!newText) {
                await interaction.reply({ content: 'Укажи новый текст.', ephemeral: true });
                return;
            }
            const isUserAdmin = interaction.user.id === SNEAKYJOE_USER_ID || !!(interaction.member && interaction.member.permissions && interaction.member.permissions.has(PermissionFlagsBits.Administrator));

            let targetMsg = null;
            const channel = interaction.channel;
            if (channel && channel.isThread && channel.isThread()) {
                try { targetMsg = await channel.fetchStarterMessage(); } catch (_) {}
            }
            if (!targetMsg && channel && channel.messages) {
                const fetched = await channel.messages.fetch({ limit: 50 }).catch(() => null);
                if (fetched) {
                    for (const msg of fetched.values()) {
                        if (msg.author.bot || msg.webhookId) {
                            const tied = await isMessageTiedToUser(msg, interaction.user.id, interaction.user.username, interaction.member ? interaction.member.displayName : interaction.user.username, client);
                            if (tied) { targetMsg = msg; break; }
                        }
                    }
                    if (!targetMsg && isUserAdmin) {
                        for (const msg of fetched.values()) {
                            if (msg.author.bot || msg.webhookId) { targetMsg = msg; break; }
                        }
                    }
                }
            }
            if (!targetMsg) {
                await interaction.reply({ content: 'Не найдено подходящего сообщения бота для редактирования.', ephemeral: true });
                return;
            }

            let authorized = isUserAdmin;
            if (!authorized) {
                authorized = await isMessageTiedToUser(targetMsg, interaction.user.id, interaction.user.username, interaction.member ? interaction.member.displayName : interaction.user.username, client);
            }
            if (!authorized) {
                await interaction.reply({ content: 'Ты можешь редактировать только свои собственные посты, заменённые ботом.', ephemeral: true });
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

            await interaction.deferReply({ ephemeral: true }).catch(() => {});

            if (allMatches.length === 0) {
                try {
                    await targetMsg.edit(newText).catch(() => {});
                    await interaction.editReply({ content: '✅ Текст отредактирован.' }).catch(() => {});
                } catch (e) {
                    await interaction.editReply({ content: 'Не удалось отредактировать: ' + e.message }).catch(() => {});
                }
                return;
            }

            let recoveredPlaceholder = null;
            try { recoveredPlaceholder = await buildRecoveredPlaceholder(client, targetMsg); } catch (_) {}
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
            await interaction.editReply({ content: `✅ Редактирование выполнено (${allMatches.map(m => m.kind).join(', ')}).` }).catch(() => {});
        } catch (err) {
            console.error('[Edit-Last Slash] Error:', err.message);
            try { await interaction.editReply({ content: 'Ошибка при редактировании: ' + err.message }).catch(() => {}); } catch (_) {}
        }
        return;
    }

    // --- /process slash command ---
    if (commandName === 'process') {
        try {
            const channel = interaction.channel;
            if (!channel || !channel.isThread()) {
                await interaction.reply({ content: 'Команда `/process` работает только внутри треда обработанного поста.', ephemeral: true });
                return;
            }
            const thread = channel;
            const isUserAdmin = interaction.user.id === SNEAKYJOE_USER_ID || !!(interaction.member && interaction.member.permissions && interaction.member.permissions.has(PermissionFlagsBits.Administrator));

            let starterMsg = null;
            try { starterMsg = await thread.fetchStarterMessage(); } catch (_) {}
            if (!starterMsg) {
                await interaction.reply({ content: 'Не удалось найти исходное сообщение треда для обработки.', ephemeral: true });
                return;
            }

            let authorized = isUserAdmin;
            if (!authorized) {
                try {
                    authorized = await isMessageTiedToUser(starterMsg, interaction.user.id, interaction.user.username, interaction.member ? interaction.member.displayName : interaction.user.username, client);
                } catch (_) {}
                if (!authorized) {
                    try {
                        const threadMsgs = await thread.messages.fetch({ limit: 50 }).catch(() => null);
                        if (threadMsgs) {
                            for (const m of threadMsgs.values()) {
                                if (!m.author.bot) { if (m.author.id === interaction.user.id) authorized = true; break; }
                            }
                        }
                    } catch (_) {}
                }
            }
            if (!authorized) {
                await interaction.reply({ content: 'Эту команду может использовать только автор поста или администратор сервера.', ephemeral: true });
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
                await interaction.reply({ content: 'Не удалось найти исходную ссылку для повторной обработки в этом треде.', ephemeral: true });
                return;
            }

            console.log(`[Process Slash] Re-processing ${foundKind} link for ${interaction.user.tag} (${interaction.user.id}) in thread ${thread.id}: ${foundUrl}`);
            await interaction.deferReply({ ephemeral: true }).catch(() => {});

            let recoveredPlaceholder = null;
            try { recoveredPlaceholder = await buildRecoveredPlaceholder(client, starterMsg); } catch (_) {}
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
            await interaction.editReply({ content: `✅ Повторная обработка выполнена (${foundKind}).` }).catch(() => {});
        } catch (err) {
            console.error('[Process Slash] Error:', err.message);
            try { await interaction.editReply({ content: 'Ошибка при повторной обработке: ' + err.message }).catch(() => {}); } catch (_) {}
        }
        return;
    }
}

module.exports = handleInteraction;
