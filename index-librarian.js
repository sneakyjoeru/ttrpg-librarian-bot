const { Client, GatewayIntentBits, Partials, REST, Routes, ActivityType, Events } = require('discord.js');
const cron = require('node-cron');
const axios = require('axios');
const {
    token,
    commands,
    SERVER_ID,
    SYSTEM_CHANNEL_ID,
    SYSTEM_MESSAGE_ID,
    GENERAL_CHANNEL_ID,
    RULES_MESSAGE_ID,
    SNEAKYJOE_USER_ID,
    TIMEZONE,
    CRON_SCHEDULE_MONTHLY_MINI,
    THREAD_AUTO_ARCHIVE_DURATION_SEVEN_DAYS,
    OLLAMA_URL,
    OLLAMA_MODEL,
    RAG_OLLAMA_TIMEOUT
} = require('./src/config');
const { getLastUpdates } = require('./src/utils/helpers');
const { cleanOrphanedTempFiles, recoverOrphanedPlaceholders } = require('./src/utils/taskPersistence');
const { IN_PROGRESS_REGEX, removeInProgressStatus } = require('./src/utils/webhook');
const handleInteraction = require('./src/handlers/interactions');
const handleMessageCreate = require('./src/handlers/messageCreate');
const handleChannelUpdate = require('./src/handlers/channelUpdate');
const handleChannelDelete = require('./src/handlers/channelDelete');
const { handleReactionAdd, handleReactionRemove } = require('./src/handlers/reactions');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Message, Partials.Reaction, Partials.User]
});

// Clean up abandoned in-progress messages from the last 2 hours after restart.
// Mirrors robot-joe's behaviour: webhook placeholders that still end with " ⏳"
// get their status stripped, while any "⏳ ..." progress-replies are deleted
// outright (they're transient status messages, never user-visible final output).
async function cleanupAbandonedInProgressMessages(clientInstance) {
    try {
        const guild = await clientInstance.guilds.fetch(SERVER_ID).catch(() => null);
        if (!guild) {
            console.log('[Startup Cleanup] Main guild not found, skipping in-progress cleanup.');
            return;
        }

        const TWO_HOURS_AGO = Date.now() - (2 * 60 * 60 * 1000);
        let totalCleaned = 0;
        let totalFinalized = 0;

        console.log('[Startup Cleanup] Scanning for abandoned in-progress messages from the last 2 hours...');

        const channels = guild.channels.cache.filter(c => c.isTextBased());
        for (const [channelId, channel] of channels) {
            try {
                const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
                if (!messages) continue;

                for (const [msgId, msg] of messages) {
                    if (msg.createdTimestamp < TWO_HOURS_AGO) continue;
                    if (msg.author.id !== clientInstance.user.id) continue;

                    const isWebhookInProgress = IN_PROGRESS_REGEX.test(msg.content);
                    const isProgressReply = msg.content.startsWith('⏳');
                    if (isWebhookInProgress || isProgressReply) {
                        console.log(`[Startup Cleanup] Found abandoned in-progress message ${msgId} in channel ${channelId} (type: ${isWebhookInProgress ? 'webhook-placeholder' : 'progress-reply'})`);

                        if (isWebhookInProgress) {
                            const cleanedContent = removeInProgressStatus(msg.content);
                            if (cleanedContent && cleanedContent.trim().length > 0) {
                                try {
                                    await msg.edit({ content: cleanedContent }).catch(() => {});
                                    totalFinalized++;
                                    console.log(`[Startup Cleanup] Finalized in-progress message ${msgId}`);
                                } catch (editErr) {
                                    try {
                                        await msg.delete().catch(() => {});
                                        totalCleaned++;
                                        console.log(`[Startup Cleanup] Deleted abandoned message ${msgId}`);
                                    } catch (delErr) {
                                        console.warn(`[Startup Cleanup] Failed to clean message ${msgId}:`, delErr.message);
                                    }
                                }
                            } else {
                                try {
                                    await msg.delete().catch(() => {});
                                    totalCleaned++;
                                    console.log(`[Startup Cleanup] Deleted empty abandoned message ${msgId}`);
                                } catch (delErr) {
                                    console.warn(`[Startup Cleanup] Failed to delete message ${msgId}:`, delErr.message);
                                }
                            }
                        } else {
                            try {
                                await msg.delete().catch(() => {});
                                totalCleaned++;
                                console.log(`[Startup Cleanup] Deleted stale progress reply ${msgId}`);
                            } catch (delErr) {
                                console.warn(`[Startup Cleanup] Failed to delete progress reply ${msgId}:`, delErr.message);
                            }
                        }
                    }
                }
            } catch (channelErr) {
                console.warn(`[Startup Cleanup] Error scanning channel ${channelId}:`, channelErr.message);
            }
        }

        console.log(`[Startup Cleanup] Complete. Finalized: ${totalFinalized}, Deleted: ${totalCleaned}`);
    } catch (err) {
        console.error('[Startup Cleanup] Failed to clean abandoned in-progress messages:', err.message);
    }
}

client.once(Events.ClientReady, async () => {
    client.user.setPresence({
        activities: [{
            name: 'status',
            type: ActivityType.Custom,
            state: 'Automating ttrpg.ee'
        }],
        status: 'online'
    });
    console.log(`Online as ${client.user.tag}`);

    // --- STARTUP CLEANUP ---
    // 1. Clean up abandoned in-progress messages from the last 2 hours
    // 2. Clean up orphaned temp files left over from a previous session
    // 3. Re-dispatch interrupted Instagram/Facebook tasks so the user
    //    doesn't lose work because of a bot restart
    cleanupAbandonedInProgressMessages(client).catch(err => {
        console.error('[Startup Cleanup] Cleanup task failed:', err.message);
    });
    cleanOrphanedTempFiles();
    recoverOrphanedPlaceholders(client).catch(err => {
        console.error('[Startup Recovery] Recovery task failed:', err.message);
    });

    // --- POST-RESTART MESSAGE UPDATE ---
    const restartToken = process.env.RESTART_TOKEN;
    const restartChannelId = process.env.RESTART_CHANNEL_ID;
    const restartMessageId = process.env.RESTART_MESSAGE_ID;
    if (restartToken) {
        try {
            console.log(`[Restart System] Detected active restart sequence with interaction token. Updating ephemeral message...`);
            const rest = new REST({ version: '10' }).setToken(token);
            const tallinnTime = new Date().toLocaleString('en-GB', {
                timeZone: TIMEZONE,
                dateStyle: 'medium',
                timeStyle: 'long'
            });
            await rest.patch(
                Routes.webhookMessage(client.user.id, restartToken, '@original'),
                { body: { content: `✅ Restart successful! (Completed at: ${tallinnTime})` } }
            );
            console.log('[Restart System] Successfully updated ephemeral restart message.');

            // Delete the message after 20 seconds
            setTimeout(async () => {
                try {
                    await rest.delete(
                        Routes.webhookMessage(client.user.id, restartToken, '@original')
                    );
                    console.log('[Restart System] Cleaned up ephemeral restart message.');
                } catch (delErr) {
                    console.error('[Restart System] Failed to delete ephemeral restart message:', delErr.message);
                }
            }, 20000);
        } catch (err) {
            console.error('[Restart System] Failed to update ephemeral restart message:', err.message);
        }
    } else if (restartChannelId && restartMessageId) {
        try {
            console.log(`[Restart System] Detected active restart sequence. Updating message ${restartMessageId} in channel ${restartChannelId}...`);
            const channel = await client.channels.fetch(restartChannelId);
            if (channel) {
                const msg = await channel.messages.fetch(restartMessageId).catch(() => null);
                if (msg) {
                    const tallinnTime = new Date().toLocaleString('en-GB', {
                        timeZone: TIMEZONE,
                        dateStyle: 'medium',
                        timeStyle: 'long'
                    });
                    await msg.edit({ content: `✅ Restart successful! (Completed at: ${tallinnTime})` });
                    console.log('[Restart System] Successfully updated restart message.');
 
                    // Delete the message after 20 seconds
                    setTimeout(async () => {
                        try {
                            await msg.delete();
                            console.log('[Restart System] Cleaned up restart message.');
                        } catch (delErr) {
                            console.error('[Restart System] Failed to delete restart message:', delErr.message);
                        }
                    }, 20000);
                }
            }
        } catch (err) {
            console.error('[Restart System] Failed to update restart message:', err.message);
        }
    }

    // Fetch all members at startup to populate client.guilds.cache member lists for name matching
    try {
        const guild = client.guilds.cache.get(SERVER_ID);
        if (guild) {
            console.log(`[Startup] Fetching members for guild ${guild.name} (${SERVER_ID}) to populate cache...`);
            const fetchedMembers = await guild.members.fetch();
            console.log(`[Startup] Successfully cached ${fetchedMembers.size} members.`);
        } else {
            console.warn(`[Startup] Guild with ID ${SERVER_ID} not found in client cache.`);
        }
    } catch (fetchErr) {
        console.error('[Startup] Failed to fetch guild members on startup:', fetchErr);
    }

    // --- COMMAND REGISTRATION ---
    try {
        console.log('Started refreshing application (/) commands.');
        const rest = new REST({ version: '10' }).setToken(token);
        await rest.put(
            Routes.applicationGuildCommands(client.user.id, SERVER_ID),
            { body: commands },
        );
        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error('Failed to reload commands:', error);
    }
    // --- END OF REGISTRATION BLOCK ---

    // --- SYSTEM HELP MESSAGE CONFIGURATION ---
    try {
        const systemChannel = await client.channels.fetch(SYSTEM_CHANNEL_ID);
        if (systemChannel) {
            const systemMessage = await systemChannel.messages.fetch(SYSTEM_MESSAGE_ID).catch(() => null);

            const tallinnTime = new Date().toLocaleString('en-GB', {
                timeZone: TIMEZONE,
                dateStyle: 'medium',
                timeStyle: 'long'
            });

            // Retrieve the last 5 updates from git (or fallback)
            const updatesList = getLastUpdates();

            const contentWithTime = `Use \`/librarian-bot\` for showing instructions for bot.\n\n**Last 5 Updates:**\n${updatesList}\n\n*Last updated: ${tallinnTime}*`;

            if (systemMessage) {
                await systemMessage.edit({ content: contentWithTime });
                console.log('System help message successfully updated with timestamp and last 5 updates.');
            } else {
                const newMessage = await systemChannel.send({ content: contentWithTime });
                console.log(`[WARNING] System help message was deleted. Created a new one.`);
                console.log(`[ACTION REQUIRED] Update systemMessageId to '${newMessage.id}' in your index.js to prevent duplication on next restart.`);
            }
        }
    } catch (err) {
        console.error('Failed to handle system help message on restart:', err);
    }

    // --- CRON SCHEDULER FOR 3D PRINTING QUEUE ---
    cron.schedule(CRON_SCHEDULE_MONTHLY_MINI, async () => {
        try {
            const guild = client.guilds.cache.get(SERVER_ID);
            if (!guild) {
                console.log(`[Monthly Mini Cron] Target server ${SERVER_ID} not found in client guilds cache. Skipping monthly mini flow.`);
                return;
            }

            const maxDelayMs = 4 * 60 * 60 * 1000; // 4 hours in ms
            const randomDelay = Math.floor(Math.random() * maxDelayMs);
            console.log(`[Monthly Mini Cron] Scheduling monthly mini post with a random delay of ${(randomDelay / (60 * 1000)).toFixed(1)} minutes (targeting 11:00 AM +- 2 hours).`);

            setTimeout(async () => {
                try {
                    const channel = await client.channels.fetch(GENERAL_CHANNEL_ID);

                    if (!channel) {
                        console.error('General channel not found for monthly mini post.');
                        return;
                    }

                    const currentDate = new Date();
                    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
                    const currentMonth = monthNames[currentDate.getMonth()];
                    const currentYear = currentDate.getFullYear();

                    // Generate a direct link to the pinned rules message
                    const pinnedPostLink = `https://discord.com/channels/${SERVER_ID}/${GENERAL_CHANNEL_ID}/${RULES_MESSAGE_ID}`;

                    const prompts = [
                        `It's the 1st of the month, which means free mini slots are refreshed! 🎲 New to the server? Don't be shy, everyone is welcome! Check the current rules and supported formats here: ${pinnedPostLink}. Drop your model or link in the thread below and <@221722372145676288> will print it for free!`,
                        `A new month brings new free minis! 🐉 If you've just joined us, don't hesitate to jump in. Read the latest guidelines: ${pinnedPostLink}. Post your file or link in the thread below and let <@221722372145676288> work their printing magic!`,
                        `Happy 1st of the month! The free miniature queue is officially open. 🏰 Newcomers, this means you too—grab a slot! Rules are pinned here: ${pinnedPostLink}. Leave your model in the thread, and <@221722372145676288> will print it at no cost.`,
                        `The monthly mini refresh is here! ⚔️ Never requested one before? Now is the perfect time, don't be shy! See the current instructions right here: ${pinnedPostLink}. Drop your files in the thread and <@221722372145676288> will bring them to life.`,
                        `New month, new loot! 💰 Free mini slots are back. We love seeing newcomers participate, so don't hold back! Read how it currently works: ${pinnedPostLink}. Share your mini in the thread and <@221722372145676288> will get it printed.`,
                        `It's that time again! Free 3D prints for the 1st of the month. 🧙‍♂️ If you are new here, step right up and claim your mini! Check the up-to-date rules: ${pinnedPostLink}. Toss your file in the thread and <@221722372145676288> will do the rest.`,
                        `Roll for initiative! The monthly free mini slots have reset. 🎲 New players, don't be shy—this is for you too! Guidelines: ${pinnedPostLink}. Drop your model in the thread, and <@221722372145676288> will handle the print.`,
                        `Welcome to a new month! Free miniature printing is now available. 🛡️ We highly encourage newbies to grab a slot! Read up on the requirements here: ${pinnedPostLink}. Leave your request in the thread below for <@221722372145676288>.`,
                        `The forge is lit! 1st of the month means free minis. 🔥 If you're new to the community, join the fun! Current instructions: ${pinnedPostLink}. Share your model or link in the thread and <@221722372145676288> will print it free of charge.`,
                        `Monthly mini slots are officially refreshed today! 🗺️ Don't be shy if you're new, grab your character in physical form. Rules: ${pinnedPostLink}. Drop the file in the thread and let <@221722372145676288> fire up the printer.`
                    ].map(prompt => prompt.replace('221722372145676288', SNEAKYJOE_USER_ID));

                    let postText = null;
                    let attempts = 0;
                    const maxAttempts = 4;

                    while (attempts < maxAttempts) {
                        attempts++;
                        try {
                            console.log(`[Monthly Mini Cron] Attempting to generate announcement via Ollama (attempt ${attempts}/${maxAttempts})...`);
                            const systemMessage = `You are Librarian, a senile but helpful TTRPG librarian bot living inside a Discord server. 
Today is the 1st of the month, and the monthly free 3D printing queue for miniatures has reset.
Generate a friendly, fun, and flavor-filled community announcement in character.

CRITICAL REQUIREMENTS:
- You must exactly include the rules link: ${pinnedPostLink}
- You must exactly mention the printer host: <@${SNEAKYJOE_USER_ID}>
- The text must be in English.
- Do NOT use markdown code blocks, do NOT write surrounding explanations or metadata, just output the announcement text itself.`;

                            const userPrompt = `Write a short, engaging announcement (2-4 sentences) in your senile librarian character voice, welcoming people (especially newcomers) to claim their free mini printing slot for the month, pointing them to the rules here: ${pinnedPostLink}, and letting them know that <@${SNEAKYJOE_USER_ID}> will print it for free.`;

                            const response = await axios.post(OLLAMA_URL, {
                                model: OLLAMA_MODEL,
                                system: systemMessage,
                                prompt: userPrompt,
                                stream: false,
                                options: {
                                    temperature: 0.85,
                                    num_ctx: 2048,
                                    seed: Math.floor(Math.random() * 1000000)
                                }
                            }, { timeout: RAG_OLLAMA_TIMEOUT });

                            if (response.data && response.data.response) {
                                const generatedText = response.data.response.trim();
                                // Validate requirements:
                                const hasRulesLink = generatedText.includes(pinnedPostLink);
                                const hasHostMention = generatedText.includes(`<@${SNEAKYJOE_USER_ID}>`);

                                if (generatedText.length > 0 && hasRulesLink && hasHostMention) {
                                    console.log(`[Monthly Mini Cron] Successfully generated announcement: "${generatedText}"`);
                                    postText = generatedText;
                                    break;
                                } else {
                                    console.warn(`[Monthly Mini Cron] Validation failed for attempt ${attempts}. rulesLink: ${hasRulesLink}, hostMention: ${hasHostMention}`);
                                }
                            } else {
                                console.warn(`[Monthly Mini Cron] Empty response from Ollama on attempt ${attempts}`);
                            }
                        } catch (err) {
                            console.error(`[Monthly Mini Cron] Ollama generation failed on attempt ${attempts}:`, err.message);
                        }
                    }

                    if (!postText) {
                        console.log(`[Monthly Mini Cron] Ollama generation failed or was invalid after ${maxAttempts} attempts. Falling back to static prompt.`);
                        postText = prompts[Math.floor(Math.random() * prompts.length)];
                    }

                    // 1. Send the message
                    const message = await channel.send(postText);

                    // 2. Create a thread from this message (appending the year)
                    const thread = await message.startThread({
                        name: `Free Minis - ${currentYear}, ${currentMonth}`,
                        autoArchiveDuration: THREAD_AUTO_ARCHIVE_DURATION_SEVEN_DAYS, // Auto-archive after 7 days (Discord maximum)
                    });

                    // 3. Add sneakyjoe to the thread
                    await thread.members.add(SNEAKYJOE_USER_ID);

                    console.log(`Monthly free mini post created successfully for ${currentMonth}.`);
                } catch (error) {
                    console.error('Failed to post monthly mini update inside timeout:', error);
                }
            }, randomDelay);
        } catch (error) {
            console.error('Failed to schedule monthly mini update:', error);
        }
    }, {
        scheduled: true,
        timezone: TIMEZONE // Accounts for your local timezone
    });
});

// --- DISCORD CLIENT EVENT LISTENERS ---
client.on('channelUpdate', (oldChannel, newChannel) => {
    handleChannelUpdate(oldChannel, newChannel).catch(console.error);
});

client.on('interactionCreate', (interaction) => {
    handleInteraction(client, interaction).catch(console.error);
});

client.on('messageCreate', (message) => {
    handleMessageCreate(client, message).catch(console.error);
});

client.on('channelDelete', (channel) => {
    handleChannelDelete(channel).catch(console.error);
});

client.on('messageReactionAdd', (reaction, user) => {
    handleReactionAdd(reaction, user).catch(console.error);
});

client.on('messageReactionRemove', (reaction, user) => {
    handleReactionRemove(reaction, user).catch(console.error);
});

client.login(token);
