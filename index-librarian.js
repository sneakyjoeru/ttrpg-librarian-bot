const { Client, GatewayIntentBits, Partials, REST, Routes, ActivityType, Events } = require('discord.js');
const fs = require('fs');
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
    RAG_OLLAMA_TIMEOUT,
    SYSTEM_UPDATES_LIMIT,
    SYSTEM_UPDATES_THREAD_NAME
} = require('./src/config');
const { getLastUpdates } = require('./src/utils/helpers');
const {
    getSystemUpdatesThreadId,
    setSystemUpdatesIds
} = require('./src/utils/systemState');
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

    // iGPU passthrough check: log at startup whether /dev/dri is present so
    // the user can immediately see if they need to rebuild (Docker restart
    // doesn't re-apply --device flags; only a fresh docker run via
    // rebuild-run.sh does).
    try {
        const driExists = fs.existsSync('/dev/dri');
        const renderNodes = driExists ? fs.readdirSync('/dev/dri').filter(f => /^renderD\d+$/.test(f)) : [];
        if (renderNodes.length > 0) {
            console.log(`[Startup] iGPU passthrough active: /dev/dri/${renderNodes[0]} is available. VAAPI transcoding will be used.`);
        } else {
            console.warn('[Startup] ⚠️ iGPU passthrough NOT active: /dev/dri has no render node. Video transcoding will use CPU (slower). Re-run ./rebuild-run.sh on the host to re-apply --device /dev/dri (Docker restart does NOT re-apply device flags).');
        }
    } catch (e) {
        console.warn(`[Startup] Could not check /dev/dri: ${e.message}`);
    }

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

    // --- SYSTEM HELP MESSAGE + UPDATES THREAD ---
    // On every restart the bot:
    //   1. Creates (or finds) the updates thread on the system message.
    //   2. Posts the last SYSTEM_UPDATES_LIMIT git log entries as ONE message
    //      inside the thread (edited in place on every restart).
    //   3. Edits the system message to carry ONLY a pointer link to the
    //      thread + the "Last updated" timestamp (NO commit history).
    // Thread + updates-message ids are persisted to data/system_state.json.
    try {
        const systemChannel = await client.channels.fetch(SYSTEM_CHANNEL_ID);
        if (!systemChannel) {
            console.warn(`[System Help] Channel ${SYSTEM_CHANNEL_ID} not found. Skipping.`);
        } else {
            const systemMessage = await systemChannel.messages.fetch(SYSTEM_MESSAGE_ID).catch(() => null);
            if (!systemMessage) {
                console.warn(`[System Help] Message ${SYSTEM_MESSAGE_ID} not found in channel. Skipping (the operator should set SYSTEM_MESSAGE_ID after creating a fresh anchor).`);
            } else {
                const tallinnTime = new Date().toLocaleString('en-GB', {
                    timeZone: TIMEZONE,
                    dateStyle: 'medium',
                    timeStyle: 'long'
                });
                const updatesList = getLastUpdates(SYSTEM_UPDATES_LIMIT);
                // Build the updates message body, guaranteeing it fits
                // Discord's 2000-char limit. With short-hash URLs + truncated
                // subjects (see getLastUpdates) 10 entries are ~1.5k chars, so
                // the trimming below normally does nothing — it's a safety net
                // for unusually long subjects or a raised SYSTEM_UPDATES_LIMIT.
                const buildUpdatesContent = (lines) =>
                    `**Last ${lines.length} Updates:**\n${lines.join('\n')}`;
                let updatesLines = updatesList.split('\n').filter(Boolean);
                let updatesContent = buildUpdatesContent(updatesLines);
                while (updatesLines.length > 1 && updatesContent.length > 2000) {
                    // Drop the oldest entry (front of the --reverse list) to
                    // keep the most recent updates under the limit.
                    updatesLines.shift();
                    updatesContent = buildUpdatesContent(updatesLines);
                }
                if (updatesContent.length > 2000) {
                    // A single gigantic line — hard-truncate as a last resort.
                    updatesContent = updatesContent.slice(0, 1997) + '...';
                }

                // ---- Step 1: Get or create the updates thread ----
                // Adoption order (most reliable first):
                //   1. message.thread — discord.js exposes the thread started
                //      on a message directly. Works for both regular text
                //      channels and forum-style channels where the post's
                //      opening message and its thread share the same id.
                //   2. startThread — only when no thread exists yet (fresh
                //      anchor). On subsequent runs message.thread is
                //      populated, so this is skipped and we avoid the
                //      MessageExistingThread throw.
                //   3. Persisted thread id (data/system_state.json).
                //   4. Scan active threads in the channel by name.
                //   5. Scan archived public threads in the channel by name.
                // A thread is validated by isThread() + parent channel; do
                // NOT reject on thread.id === systemMessage.id — that is
                // legitimate in forum-style channels.
                const isOurUpdatesThread = (t) =>
                    t && t.isThread && t.isThread() &&
                    (t.parentId === SYSTEM_CHANNEL_ID || t.parentId === systemChannel.id) &&
                    typeof t.name === 'string' && t.name.includes('Updates Log');
                const unarchiveIfNeeded = async (t, why) => {
                    if (t.archived) {
                        try { await t.setArchived(false, why); }
                        catch (e) { console.warn(`[System Help] Could not unarchive thread ${t.id}: ${e.message}`); }
                    }
                };
                let thread = null;

                if (!thread && systemMessage.thread) {
                    const direct = systemMessage.thread;
                    if (direct.isThread && direct.isThread() &&
                        (direct.parentId === SYSTEM_CHANNEL_ID || direct.parentId === systemChannel.id)) {
                        thread = direct;
                        console.log(`[System Help] Adopted thread ${thread.id} via message.thread.`);
                        await unarchiveIfNeeded(thread, 'Unarchiving updates thread for bot use.');
                    }
                }
                if (!thread) {
                    try {
                        const created = await systemMessage.startThread({
                            name: SYSTEM_UPDATES_THREAD_NAME,
                            autoArchiveDuration: THREAD_AUTO_ARCHIVE_DURATION_SEVEN_DAYS,
                            reason: 'Librarian Bot updates log'
                        });
                        if (created && created.isThread && created.isThread()) {
                            thread = created;
                            console.log(`[System Help] Created new updates thread ${thread.id}.`);
                        }
                    } catch (startErr) {
                        // MessageExistingThread is expected when the thread
                        // already exists; fall through to the other fallbacks.
                        if (!startErr || startErr.code !== 'MessageExistingThread') throw startErr;
                    }
                }
                if (!thread) {
                    const savedThreadId = getSystemUpdatesThreadId();
                    if (savedThreadId) {
                        try {
                            const candidate = await client.channels.fetch(savedThreadId);
                            if (candidate && candidate.isThread && candidate.isThread() &&
                                (candidate.parentId === SYSTEM_CHANNEL_ID || candidate.parentId === systemChannel.id)) {
                                thread = candidate;
                                console.log(`[System Help] Adopted saved thread ${thread.id}.`);
                                await unarchiveIfNeeded(thread, 'Unarchiving updates thread for bot use.');
                            }
                        } catch (fetchErr) {
                            console.warn(`[System Help] Could not fetch saved thread ${savedThreadId}: ${fetchErr.message}`);
                        }
                    }
                }
                if (!thread) {
                    try {
                        const active = await systemChannel.threads.fetchActive();
                        const orphan = active.threads.find(isOurUpdatesThread);
                        if (orphan) {
                            thread = orphan;
                            console.log(`[System Help] Adopted active thread ${thread.id}.`);
                        }
                    } catch (scanErr) {
                        console.warn(`[System Help] Could not scan active threads: ${scanErr.message}`);
                    }
                }
                if (!thread) {
                    try {
                        const archived = await systemChannel.threads.fetchArchived({ type: 'public' });
                        const orphan = archived.threads.find(isOurUpdatesThread);
                        if (orphan) {
                            thread = orphan;
                            console.log(`[System Help] Adopted archived thread ${thread.id}; unarchiving.`);
                            await unarchiveIfNeeded(thread, 'Unarchiving updates thread for bot use.');
                        }
                    } catch (scanErr) {
                        console.warn(`[System Help] Could not scan archived threads: ${scanErr.message}`);
                    }
                }
                if (!thread) {
                    console.warn(`[System Help] No adoptable thread found; updates will not be posted to a thread this run.`);
                }

                // ---- Step 2: Find or post the updates message inside the thread ----
                let updatesMessage = null;
                if (thread) {
                    // If the thread was locked on a previous run, temporarily
                    // unlock it so we can reliably send/edit inside it, then
                    // re-lock at the bottom of this block. Bots with
                    // MANAGE_THREADS usually bypass locks, but unlocking first
                    // avoids edge cases where send()/edit() fail in a locked
                    // thread.
                    try {
                        if (thread.locked) {
                            await thread.edit({ locked: false, reason: 'Temporarily unlocking to refresh updates message.' });
                        }
                    } catch (unlockErr) {
                        console.warn(`[System Help] Could not temporarily unlock thread: ${unlockErr.message}`);
                    }

                    // Search the thread's recent history for any bot-authored
                    // message (recovers when state.json was wiped but the
                    // thread — and its existing updates message — survived).
                    // We must skip:
                    //   * the system message itself (thread OP) — editing it
                    //     throws DiscordAPIError 50021, AND
                    //   * any Discord "system" messages (the auto-generated
                    //     "thread created" notification is authored by the bot
                    //     but is a system message that CANNOT be edited — also
                    //     throws 50021). discord.js exposes this as m.system.
                    //   Only a real DEFAULT-type bot message is a valid target.
                    try {
                        const recent = await thread.messages.fetch({ limit: 20 });
                        const botMessages = recent.filter(m =>
                            m.author.id === client.user.id &&
                            !m.system &&
                            m.id !== systemMessage.id
                        );
                        if (botMessages.size > 0) {
                            // Take the oldest bot message (the live updates one).
                            updatesMessage = botMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp).first();
                            console.log(`[System Help] Found existing bot updates message ${updatesMessage.id} in thread.`);
                        }
                    } catch (scanMsgErr) {
                        console.warn(`[System Help] Could not scan thread messages (${scanMsgErr.message}); will post fresh.`);
                    }

                    if (updatesMessage) {
                        await updatesMessage.edit({ content: updatesContent });
                        console.log(`[System Help] Edited updates message ${updatesMessage.id} in place (${updatesContent.length} chars, ${updatesLines.length} entries).`);
                    } else {
                        updatesMessage = await thread.send({ content: updatesContent });
                        console.log(`[System Help] Posted new updates message ${updatesMessage.id} in thread ${thread.id} (${updatesContent.length} chars, ${updatesLines.length} entries).`);
                    }

                    // Persist the (now-validated) ids so future restarts
                    // can find the existing thread/message quickly.
                    setSystemUpdatesIds({
                        threadId: thread.id,
                        updatesMessageId: updatesMessage.id
                    });

                    // Re-apply the lock so nobody — including admins — can
                    // post in the thread; only the bot can edit its own
                    // message inside the lock. Keep the thread unarchived.
                    try {
                        if (thread.archived) {
                            await thread.setArchived(false, 'Keep the updates log thread active for the next bot restart.');
                        }
                        if (!thread.locked) {
                            await thread.edit({ locked: true, reason: 'Keep the updates log thread bot-only' });
                        }
                    } catch (lockErr) {
                        console.warn(`[System Help] Could not enforce thread lock: ${lockErr.message}`);
                    }
                }

                // ---- Step 3: Edit the system message itself (the thread OP) ----
                // The system message must NOT contain any commit history. It
                // only carries a one-line pointer to the updates thread and
                // the "Last updated" timestamp in TIMEZONE. The actual
                // `**Last N Updates:**` body lives ONLY in the thread's first
                // bot message (see above).
                const threadUrl = thread
                    ? `https://discord.com/channels/${SERVER_ID || systemChannel.guildId}/${thread.id}`
                    : null;
                let systemContent;
                if (threadUrl) {
                    // Use a PLAIN url rather than markdown [text](url):
                    // Discord does not reliably render markdown-link syntax
                    // for internal discord.com/channels/... URLs (it shows
                    // the raw [text](url) text). A plain URL is always
                    // auto-linked as a clickable jump link.
                    systemContent =
                        `Use \`/librarian-bot\` to see instructions for bot privately.\n\n` +
                        `${SYSTEM_UPDATES_THREAD_NAME}: ${threadUrl}\n\n` +
                        `*Last updated: ${tallinnTime}*`;
                } else {
                    // No thread available — just refresh the timestamp and
                    // strip any stale updates block from a previous run.
                    // The legacy block may be either a plain
                    // `**Last N Updates:**` list (no spoilers) or the older
                    // spoiler-wrapped form (`||| ... ||`); strip both up to
                    // the "Last updated" marker.
                    let base = systemMessage.content;
                    base = base.replace(/\n\n\*\*Last\s+\d+\s+Updates:\*\*[\s\S]*?(?=\n\n\*Last updated:|$)/i, '');
                    base = base.replace(/\n\n\*Last updated:.*$/, '');
                    systemContent = base + `\n\n*Last updated: ${tallinnTime}*`;
                }
                await systemMessage.edit({ content: systemContent });
                console.log(`[System Help] System message updated with timestamp${threadUrl ? ' and link to updates thread' : ' (no thread available)'} (no commit history in the body).`);
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
