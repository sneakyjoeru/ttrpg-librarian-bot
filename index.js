const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ChannelType, PermissionFlagsBits, ActivityType } = require('discord.js');
const fs = require('fs');
const axios = require('axios');
const cron = require('node-cron');

// --- CONFIGURATION CONSTANTS ---
// Path to the file containing the Discord Bot Token. (Change if using a different secrets structure)
const SECRETS_PATH = './secrets_discord.php';

// Server-specific IDs. IMPORTANT: Replace these with your own Discord Server/Guild IDs to run the bot on your server!
const SERVER_ID = '1294242036492406837';             // The ID of the Discord Guild/Server the bot operates on
const ACTIVE_CATEGORY_ID = '1294261463808217088';     // Category ID where active campaign text channels are created
const ARCHIVED_CATEGORY_ID = '1294261512780906526';   // Category ID where archived campaign channels are stored
const DM_ROLE_ID = '1294335928759746560';             // Role ID of Dungeon Masters who have administrative access to game campaigns

// Channel & Message IDs for status updates, announcements, and help posts. Replace with your own!
const SYSTEM_CHANNEL_ID = '1294333974897885185';      // Channel where Librarian Bot posts its global interactive help message
const SYSTEM_MESSAGE_ID = '1505941250732458166';      // Message ID of the bot's help post in SYSTEM_CHANNEL_ID (edited automatically on restart)
const GENERAL_CHANNEL_ID = '1294242036492406840';     // General chat channel ID (used for posting monthly free 3D printing schedules)
const RULES_MESSAGE_ID = '1302931730411425852';       // Message ID of server rules, referenced in monthly printing posts
const SNEAKYJOE_USER_ID = '221722372145676288';       // Discord User ID of the 3D printing host (sneakyjoe) tagged in print queues

// Local search and LLM settings. Replace with your own SearXNG and Ollama server URLs!
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://192.168.0.100:9080/search';           // API endpoint of local SearXNG meta-search instance for RAG queries
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://192.168.0.101:11434/api/generate';     // API endpoint of local Ollama server running Llama 3.1
const OLLAMA_MODEL = 'llama3.1';                                  // Local LLM model name run in Ollama

// Locale and schedules
const TIMEZONE = 'Europe/Tallinn';                    // Local timezone used to schedule cron jobs & timestamps
const CRON_SCHEDULE_MONTHLY_MINI = '0 11 1 * *';      // Cron schedule for monthly announcements (1st of every month at 11:00 AM)

const EMOJI_ROBOT = '🤖';                             // Reacted emoji on campaign OP posts
const EMOJI_HAND = '✋';                              // Emoji that players click to self-assign campaign player roles

const EMBED_COLOR = 0x2b2d31;                         // Dark gray hex color used for the bot's embed messages

// Threads & caching
const THREAD_AUTO_ARCHIVE_DURATION_ONE_DAY = 1440;     // Auto-archive threads after 1 day (in minutes)
const THREAD_AUTO_ARCHIVE_DURATION_SEVEN_DAYS = 10080; // Auto-archive threads after 7 days (in minutes)
const DISCORD_START_SNOWFLAKE = '1';                  // Snowflake ID used as a baseline to retrieve the first messages in a channel

// RAG (Retrieval-Augmented Generation) & Ollama parameters
const RAG_SEARCH_LIMIT = 5;                           // Number of search results to include in LLM context
const RAG_HISTORY_LIMIT = 20;                         // Number of recent chat history messages to include in LLM context
const RAG_SEARCH_TIMEOUT = 4000;                      // Timeout for meta-search requests (ms)
const RAG_OLLAMA_TIMEOUT = 120000;                    // Timeout for local Ollama server generation (ms)
const RAG_TYPING_INTERVAL = 120000;                   // Typing status keep-alive interval (ms)

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

const FALLBACK_ROASTS = [
    "You swing your weapon, but it slips from your greasy hands and lands directly in your boot.",
    "You attempt to look cool, but trip over a completely flat stone and faceplant in front of the tavern.",
    "Your spell backfires, singeing your eyebrows off and making your voice two octaves higher for the next hour.",
    "You confidently state your plan, only to immediately forget what you were doing and walk into a wall.",
    "You look the monster in the eye to intimidate it, but accidentally sneeze directly on its face. It looks more disgusted than intimidated.",
    "You try to pick the lock, but your lockpick breaks and jams the lock, also your pants rip.",
    "You try to sneak, but your armor squeaks like a terrified mouse, alerting every guard within a mile."
];

let token = '';

if (fs.existsSync(SECRETS_PATH)) {
    const phpCode = fs.readFileSync(SECRETS_PATH, 'utf8');
    const match = phpCode.match(/\$token\s*=\s*['"]([^'"]+)['"]/);
    if (match) {
        token = match[1];
    }
}

if (!token && process.env.DISCORD_TOKEN) {
    token = process.env.DISCORD_TOKEN;
}

if (!token) {
    throw new Error("Bot token could not be found in secrets_discord.php");
}

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

const helpText = `**Librarian Bot Functions:**
\`/librarian-bot\` - Show this help message
\`/new-thread [threadname]\` - Create a public thread
\`/roll [formula] [class] [context]\` - Roll dice (e.g. 1d20+5). Custom critical roll text through LLM
**@LibrarianBot [question]** - Ask a question (add "no bs" for a short, direct answer)

**🔒 DM / Admin Commands:**
\`/new-campaign [campaign_name] [usernames]\` - Create new campaign channel *(DM or Admin)*
\`/new-private-campaign [campaign_name] [usernames]\` - Create private campaign channel *(DM or Admin)*
\`/new-private-thread [usernames]\` - Create a private thread and invite mentioned users *(DM or Admin)*
\`/poll-librarian [question] [options]\` - Create a poll. Options must be comma-separated (max 10).
\`/set-topic [text]\` - Set a new channel topic while preserving bot metadata *(DM or Admin)*
\`/update-players [count]\` - Change the number of players in the channel and role name *(DM or Admin)*
\`!pin [message_id]\` - Pin a message by ID (or the last message if empty) *(DM of this channel or Admin)*
\`!unpin [message_id]\` - Unpin a message by ID (or the last pinned message if empty) *(DM of this channel or Admin)*
\`/archive [confirmation]\` - Archive current campaign channel. Requires typing: \`yes, I want to archive channelname\`
\`/retro-setup\` - Admin tool: Pins first message, generates missing role, and creates bot data in channel topic for old channels.

*Note: New game channels auto-delete chat until DM posts OP (which generates role).*`;

const commands = [
    new SlashCommandBuilder().setName('librarian-bot').setDescription('Show bot functions'),
    new SlashCommandBuilder().setName('new-campaign')
        .setDescription('Create a new campaign channel (DM or Admin)')
        .addStringOption(opt => opt.setName('campaign_name').setDescription('Name of campaign').setRequired(true))
        .addStringOption(opt => opt.setName('usernames').setDescription('Mentions of players').setRequired(true)),
    new SlashCommandBuilder().setName('new-private-campaign')
        .setDescription('Create a new private campaign channel (DM or Admin)')
        .addStringOption(opt => opt.setName('campaign_name').setDescription('Name of campaign').setRequired(true))
        .addStringOption(opt => opt.setName('usernames').setDescription('Mentions of players').setRequired(true)),
    new SlashCommandBuilder().setName('new-thread')
        .setDescription('Create a new thread')
        .addStringOption(opt => opt.setName('threadname').setDescription('Name of thread').setRequired(true)),
    new SlashCommandBuilder().setName('new-private-thread')
        .setDescription('Create a new private thread (DM or Admin)')
        .addStringOption(opt => opt.setName('usernames').setDescription('Mentions of players').setRequired(true)),
    new SlashCommandBuilder().setName('archive')
        .setDescription('Archive current channel by typing \`yes, I want to archive channelname\`')
        .addStringOption(opt => opt.setName('confirmation').setDescription('Type: yes, I want to archive [channelname]').setRequired(true)),
    new SlashCommandBuilder().setName('retro-setup')
        .setDescription('Setup old channels: pins OP, adds reactions, creates metadata in topic (Admin)'),
    new SlashCommandBuilder().setName('set-topic')
        .setDescription('Set a new channel topic while preserving bot metadata (DM or Admin)')
        .addStringOption(opt => opt.setName('text').setDescription('The new topic text. 1024 symbolx maximum.').setRequired(true)),
    new SlashCommandBuilder().setName('update-players')
        .setDescription('Change the number of players in the channel and role name (DM or Admin)')
        .addIntegerOption(opt => opt.setName('count').setDescription('New player count').setRequired(true)),
    new SlashCommandBuilder().setName('poll-librarian')
        .setDescription('Create a custom poll (up to 10 options)')
        .addStringOption(opt => opt.setName('question').setDescription('The question for the poll').setRequired(true))
        .addStringOption(opt => opt.setName('options').setDescription('Comma-separated options (e.g. Yes, No, Maybe)').setRequired(true)),
    new SlashCommandBuilder().setName('roll')
        .setDescription('Roll dice (e.g., 1d20+5, 2d6, d20)')
        .addStringOption(opt => opt.setName('formula').setDescription('Dice formula to roll (e.g., 1d20+5, 2d6, d20)').setRequired(true))
        .addStringOption(opt => opt.setName('class').setDescription('Character class (e.g., Wizard, Rogue) for custom roast context').setRequired(false))
        .addStringOption(opt => opt.setName('context').setDescription('What your character is attempting to do (for custom roast context)').setRequired(false)),
].map(command => command.toJSON());

client.once('ready', async () => {
    client.user.setPresence({
        activities: [{
            name: 'status',
            type: ActivityType.Custom,
            state: 'Automating ttrpg.ee'
        }],
        status: 'online'
    });
    console.log(`Online as ${client.user.tag}`);

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

    try {
        const systemChannel = await client.channels.fetch(SYSTEM_CHANNEL_ID);
        if (systemChannel) {
            const systemMessage = await systemChannel.messages.fetch(SYSTEM_MESSAGE_ID).catch(() => null);

            const tallinnTime = new Date().toLocaleString('en-GB', {
                timeZone: TIMEZONE,
                dateStyle: 'medium',
                timeStyle: 'long'
            });
            const contentWithTime = `${helpText}\n\n*Last updated: ${tallinnTime}*`;

            if (systemMessage) {
                await systemMessage.edit({ content: contentWithTime });
                console.log('System help message successfully updated with timestamp.');
            } else {
                const newMessage = await systemChannel.send({ content: contentWithTime });
                console.log(`[WARNING] System help message was deleted. Created a new one.`);
                console.log(`[ACTION REQUIRED] Update systemMessageId to '${newMessage.id}' in your index.js to prevent duplication on next restart.`);
            }
        }
    } catch (err) {
        console.error('Failed to handle system help message on restart:', err);
    }
    cron.schedule(CRON_SCHEDULE_MONTHLY_MINI, async () => {
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
                `Monthly mini slots are officially refreshed! 🗺️ Don't be shy if you're new, grab your character in physical form. Rules: ${pinnedPostLink}. Drop the file in the thread and let <@221722372145676288> fire up the printer.`,
                `Happy 1st! The free mini giveaway is active again. ⚔️ Newcomers, don't hesitate to claim yours! Details on what can be printed here: ${pinnedPostLink}. Post in the thread below and <@221722372145676288> will take care of the printing.`,
                `Time to expand your tabletop collection! Free slots are refreshed. 🎒 If you just joined us, don't be shy, claim a print! Read this first: ${pinnedPostLink}. Put your model in the thread and <@221722372145676288> will print it.`,
                `The 1st of the month brings fresh free minis! 🧚‍♀️ We want to see our newer members getting in on this too! Check the pinned rules for the latest updates: ${pinnedPostLink}. Drop your mini in the thread and <@221722372145676288> will handle it.`,
                `Level up! Free miniature slots have reset for the month. 🆙 New to the server? Step up and get yours! Current instructions: ${pinnedPostLink}. Link your file in the thread below and <@221722372145676288> will print it for free.`,
                `New month, fresh prints! The free mini slots are open. 🧪 Newcomers are especially welcome, don't be shy! Read the guide to see what's supported: ${pinnedPostLink}. Drop your model in the thread and <@221722372145676288> will print it for you.`,
                `Need a new monster or hero? 1st of the month free slots are here! 🧟‍♂️ If you're new, jump right in and claim one. Rules: ${pinnedPostLink}. Post your request in the thread and <@221722372145676288> will get to work.`,
                `The monthly free 3D printing slots are officially back! 🖨️ We'd love to see new faces requesting minis! Please read the current parameters: ${pinnedPostLink}. Leave your file in the thread and <@221722372145676288> will print it.`,
                `It's the 1st! Time to claim your monthly free miniature. 🦄 Don't be shy, newcomers—this perk is for everyone! Check the updated rules: ${pinnedPostLink}. Drop your mini in the thread and let <@221722372145676288> print it.`,
                `Free mini slots are refreshed for the month! 🏹 If you've never asked for one before, today is the day! Guidelines: ${pinnedPostLink}. Put your model in the thread below and <@221722372145676288> will provide the print.`,
                `A new month means the 3D printer is ready for your free requests! ⚙️ New members, don't hesitate to join in! Instructions on what to send: ${pinnedPostLink}. Drop your file in the thread, and <@221722372145676288> will print it completely free.`,
                `Happy 1st! The queue for free minis is officially wiped clean. 🧹 We invite all newbies to grab a print! Current rules: ${pinnedPostLink}. Post your model in the thread and <@221722372145676288> will handle the rest.`,
                `It's that time of the month—free miniatures! 🧝‍♂️ If you're a new face around here, don't be shy. Check the pinned post for latest printing details: ${pinnedPostLink}. Leave your link in the thread and <@221722372145676288> will print it for you.`,
                `The monthly refresh is here! Claim your free 3D print. 🎨 Newcomers, we highly encourage you to participate! Read how: ${pinnedPostLink}. Drop your mini in the thread and <@221722372145676288> will make it happen.`,
                `Free minis are back on the menu! 🥩 1st of the month is here. New to the server? Get your first print today! Guidelines: ${pinnedPostLink}. Toss your file in the thread below and <@221722372145676288> will print it.`,
                `Time to spawn some new models! Monthly slots are refreshed. 🪄 Don't be shy if you're a newcomer, claim your mini! Rules here: ${pinnedPostLink}. Link your file in the thread and let <@221722372145676288> do the printing.`,
                `Welcome to the 1st! Our free mini slots are wide open. 🌌 If you just joined, this is the perfect time to get a free figure! Instructions: ${pinnedPostLink}. Drop it in the thread and <@221722372145676288> will print it.`,
                `Another month, another batch of free minis! 🛡️ New players, don't hold back—get your character printed! Read this first to see what's allowed: ${pinnedPostLink}. Post in the thread below and <@221722372145676288> will print it for free.`,
                `The free print slots have been reset for the new month! 📆 We'd love to print something for our newest members. Check the rules: ${pinnedPostLink}. Leave your model in the thread, and <@221722372145676288> will take care of it.`,
                `Happy new month! Time to claim your free miniature. 🎭 Never requested one? Don't be shy, it's easy! Details on accepted formats: ${pinnedPostLink}. Put your link or file in the thread and <@221722372145676288> will print it at zero cost.`,
                `Free mini slots are officially refreshed today! ⚔️ Calling all newcomers—don't hesitate to jump in the queue! Guidelines: ${pinnedPostLink}. Drop your file in the thread and <@221722372145676288> will bring it to the physical world.`,
                `The 1st is here, and so are the free minis! 🐉 If you're new, this is your sign to ask for a print. Current rules are pinned: ${pinnedPostLink}. Link your model in the thread and <@221722372145676288> will handle the production.`,
                `Monthly reset complete! Free mini slots are open. 🔓 New to the community? Step right up and claim yours! Read up: ${pinnedPostLink}. Drop your mini in the thread and let <@221722372145676288> print it for you.`,
                `Time for free tabletop minis! The monthly refresh is active. 🎲 We strongly encourage newbies to get involved. Check the updated instructions: ${pinnedPostLink}. Post your file in the thread and <@221722372145676288> will print it.`,
                `It's the 1st! The 3D printer is hungry for your free requests. 🦖 Don't be shy, new folks, feed the printer! Rules: ${pinnedPostLink}. Leave your file or link in the thread below for <@221722372145676288>.`,
                `New month, new heroes! Free slots are refreshed. 🦸‍♂️ If you haven't used this perk yet, now is the time! Guidelines: ${pinnedPostLink}. Drop your request in the thread and <@221722372145676288> will print it completely free.`,
                `The free miniature queue is officially open for the month! 🏰 Newcomers, grab a slot before they fill up! Details on our current process: ${pinnedPostLink}. Toss your model in the thread and <@221722372145676288> will get it printed.`,
                `Happy 1st! Time to grow your mini collection for free. 🌲 Never asked for one? Don't be shy, we love printing for new members! Rules: ${pinnedPostLink}. Link your file in the thread and <@221722372145676288> will do the rest.`,
                `Free print slots are back for the 1st of the month! 🖨️ We invite all new members to claim a miniature. Read how to prep your file: ${pinnedPostLink}. Drop your mini in the thread and <@221722372145676288> will handle it.`,
                `Monthly mini refresh! ⚔️ If you're a new arrival, don't hesitate to grab a free print for your next game. Instructions: ${pinnedPostLink}. Post your model in the thread below and <@221722372145676288> will print it.`,
                `The forge is open! Free minis for the 1st of the month. 🌋 Newbies, this is your chance to get a physical character! Current guidelines: ${pinnedPostLink}. Leave your file in the thread, and <@221722372145676288> will print it free.`,
                `It's that time! The monthly free miniature slots are refreshed. 🧚‍♂️ Don't be shy if you just joined us, claim a spot! Rules: ${pinnedPostLink}. Drop your model in the thread and let <@221722372145676288> work the magic.`,
                `Welcome to the 1st! Free 3D prints are available now. 🛠️ We highly encourage new members to make a request! Check the pinned post for the latest specs: ${pinnedPostLink}. Put your file in the thread and <@221722372145676288> will print it.`,
                `New month, fresh mini queue! 📆 If you've never snagged a free print, don't hold back today! Details here: ${pinnedPostLink}. Link your mini in the thread and <@221722372145676288> will handle the rest.`,
                `The free mini slots have reset! 🎲 Calling all new members to jump in and get a free figure. Instructions on how to share: ${pinnedPostLink}. Drop your file in the thread below and <@221722372145676288> will print it.`,
                `Happy new month! Claim your free 3D printed miniature today. 🦸‍♀️ If you're new here, don't be shy—everyone gets a turn! Rules: ${pinnedPostLink}. Post your model in the thread and <@221722372145676288> will print it.`,
                `Free miniature printing is officially open for the month! 🐉 We love printing for newcomers, so grab a slot! Guidelines: ${pinnedPostLink}. Leave your model in the thread, and <@221722372145676288> will take care of it.`,
                `It's the 1st! Time to request your free monthly mini. 🗺️ Never requested before? Now is the perfect time! Read the current rules: ${pinnedPostLink}. Drop your mini in the thread and <@221722372145676288> will print it at no cost.`,
                `The monthly free print slots are officially active! 🛡️ If you are a new face, don't hesitate to claim your miniature. Check this for our latest capabilities: ${pinnedPostLink}. Toss your model in the thread and <@221722372145676288> will do the rest.`,
                `Level up your tabletop! Free minis for the 1st of the month. 🆙 New players, step right up and claim yours! Instructions: ${pinnedPostLink}. Link your file in the thread below and <@221722372145676288> will print it for free.`,
                `Monthly slots are refreshed! Time for some new models. 🪄 Don't be shy if you're new, we want to print your heroes! Rules here: ${pinnedPostLink}. Drop your file in the thread and let <@221722372145676288> fire up the printer.`
            ].map(prompt => prompt.replace('221722372145676288', SNEAKYJOE_USER_ID));

            const postText = prompts[Math.floor(Math.random() * prompts.length)];

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
            console.error('Failed to post monthly mini update:', error);
        }
    }, {
        scheduled: true,
        timezone: TIMEZONE // Accounts for your local timezone
    });
});

async function getLibrarianData(channel) {
    if (channel.topic && channel.topic.includes('[LIBRARIAN_DATA|')) {
        const topicMatch = channel.topic.match(/\[LIBRARIAN_DATA\|DM:(\d+)\|ROLE:(\d+)\]/);
        if (topicMatch) {
            return { dmId: topicMatch[1], roleId: topicMatch[2] };
        }
    }
    return null;
}

client.on('channelUpdate', async (oldChannel, newChannel) => {
    // Ignore events from other servers
    if (newChannel.guild?.id !== SERVER_ID) return;

    // Only react if the channel name actually changed
    if (oldChannel.name === newChannel.name) return;

    // Check if the channel is in the active games category
    if (newChannel.parentId === ACTIVE_CATEGORY_ID) {
        try {
            const metaData = await getLibrarianData(newChannel);

            if (metaData && metaData.roleId) {
                const role = newChannel.guild.roles.cache.get(metaData.roleId);

                // Check if the role name needs to be updated (prevent double update when using /update-players)
                if (role && role.name !== newChannel.name) {
                    await role.edit({
                        name: newChannel.name,
                        reason: 'Automatic sync: Channel was manually renamed'
                    });
                    console.log(`Role name synced to match renamed channel: ${newChannel.name}`);
                }
            }
        } catch (err) {
            console.error('Failed to update role on manual channel rename:', err);
        }
    }
});

client.on('interactionCreate', async interaction => {
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
            color: EMBED_COLOR, // Dark color, looks good in Discord
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
        // Strip spaces and normalize to lowercase. Match standard dice notation: e.g. "1d20+5", "2d6", "d20", "1d20-3"
        // Capture groups: 1 = number of dice (optional), 2 = number of faces (required), 3 = modifier sign (+/-) (optional), 4 = modifier value (optional)
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
        // Prevent abuse or high resource utilization by restricting dice quantity and faces
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

        // --- CRITICAL HIT / FAIL INTERCEPTION ---
        // Critical hits (20) and fails (1) are standard mechanic fumbles/crits for 20-sided chance dice (d20).
        // For other dice types (damage/healing/etc.), rolling a 1 is just the minimum value rather than a critical fumble.
        const isD20 = (faces === 20);
        const hasCritFail = isD20 && rolls.includes(1);
        const hasCritSuccess = isD20 && rolls.includes(20);

        // Build the rolls string, e.g. [15, 3] or [12]
        const rollsStr = rolls.length === 1 ? `[${rolls[0]}]` : `[${rolls.join(', ')}]`;
        const modStr = mod > 0 ? ` ${sign} ${mod}` : '';

        // Determine roll type based on dice faces (d20 is chance/check, rest is damage/other)
        const rollType = (faces === 20) ? 'Chance / Check / Attack' : 'Damage / Other';

        // Standard response info
        let title = `🎲 Dice Roll`;
        let embedColor = EMBED_COLOR;
        let responseContent = `**Roll Result** for ${interaction.user}:\nFormula: \`${formula}\`\nRoll Type: \`${rollType}\`\nRolls: \`${rollsStr}${modStr}\`\nTotal: **${total}**`;

        // If it's a critical success
        if (hasCritSuccess && !hasCritFail) {
            title = `⚔️ CRITICAL HIT! 🎲`;
            embedColor = 0x2ecc71; // Green
            responseContent += `\n\n*The gods of fate smile upon you! An outstanding success!*`;
        }

        // If it's a critical failure (contains 1)
        if (hasCritFail) {
            title = `💀 CRITICAL FAIL! 🎲`;
            embedColor = 0xe74c3c; // Red

            // Acknowledge the interaction first to avoid the 3-second Discord API timeout limit while the local Ollama LLM generates a response
            await interaction.deferReply();

            // Gather campaign/chat context for custom LLM roast
            let chatHistoryContext = 'No recent chat history.';
            try {
                // Fetch the last 10 messages from the channel to give context of the current situation to the LLM
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

            // System prompt instructing Llama 3.1 to act as a snarky DM roasting the player based on details
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
                // Post prompt to local Ollama instance running Llama 3.1
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

        // Send normal or crit success response
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
});

client.on('messageCreate', async (message) => {
    if (message.guild?.id !== SERVER_ID || message.author.bot) return;

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

        // Enable typing indicator and start a loop to maintain it (Discord resets it every 10 seconds)
        await message.channel.sendTyping();
        const typingInterval = setInterval(() => {
            message.channel.sendTyping().catch(() => { });
        }, RAG_TYPING_INTERVAL);

        try {
            let searchContext = 'No external internet context available.';

            try {
                const searchResponse = await axios.get(SEARXNG_URL, {
                    params: {
                        q: query,
                        format: 'json',
                        engines: 'duckduckgo,google,wikipedia',
                        language: 'en'
                    },
                    timeout: RAG_SEARCH_TIMEOUT
                });

                if (searchResponse.data && searchResponse.data.results) {
                    searchContext = searchResponse.data.results.slice(0, RAG_SEARCH_LIMIT).map(res =>
                        `Title: ${res.title}\nSnippet: ${res.content}`
                    ).join('\n\n');
                }
            } catch (searchErr) {
                console.error('SearXNG search failed, proceeding with LLM only:', searchErr.message);
            }

            // --- CHAT HISTORY COLLECTION ---
            let chatHistoryContext = 'No recent chat history available.';
            try {
                const previousMessages = await message.channel.messages.fetch({ limit: RAG_HISTORY_LIMIT, before: message.id });
                if (previousMessages.size > 0) {
                    const historyArray = previousMessages.map(m => `[${m.author.username}]: ${m.cleanContent}`).reverse();
                    chatHistoryContext = historyArray.join('\n');
                }
            } catch (historyErr) {
                console.error('Failed to fetch channel history:', historyErr);
            }

            const systemPrompt = `System Instructions:
            You are Librarian, a helpful and knowledgeable TTRPG Discord bot with a bit of marazm/dementia.
            - IMPORTANT! If user has "no bs" in his message - answer with as short as possible but not less than 10 words answer. Be straight to the point, don't roleplay.
            - Keep marazm and dementia levels very low so you don't annoy players too much (fun but not overwhelming). Keep jabber to acceptable minimum.
            - Your main goal is to keep communication around DnD when users ask questions, unless they specify a different topic (fact checking films, shows, rules is acceptable).
            - Don't be too pedantic, but don't lie either - use search context to verify your claims.
            - Answer the user's question accurately. Use the provided internet search context if it's relevant.
            - If the context doesn't help, rely on your internal knowledge or sprinkle some recent news about Tallinn/TTRPG. Answer in English.
            - If user uses profanity - don't be shy to mimic it.
            

            Internet Search Context:
            ${searchContext}

            Recent Channel Chat History (oldest to newest):
            ${chatHistoryContext}

            User Question: [${message.author.username}]: ${query}

            Answer:`;

            let answer;
            try {
                const ollamaResponse = await axios.post(OLLAMA_URL, {
                    model: OLLAMA_MODEL,
                    prompt: systemPrompt,
                    stream: false,
                    options: {
                        temperature: 0.7
                    }
                }, { timeout: RAG_OLLAMA_TIMEOUT });
                answer = ollamaResponse.data.response;
            } catch (ollamaErr) {
                console.warn('Ollama query failed, falling back to help text:', ollamaErr.message);
                answer = `*The Librarian shuffles through dusty shelves, muttering to himself. The arcane archives (AI backend) seem to be currently unreachable.* Let me assist you with the basic features instead!\n\n${helpText}`;
            }

            // Stop the typing indicator before sending the response
            clearInterval(typingInterval);

            if (answer.length > 2000) {
                await message.reply(answer.substring(0, 1996) + '...');
            } else {
                await message.reply(answer);
            }
        } catch (err) {
            // Stop the typing indicator in case of error
            clearInterval(typingInterval);
            console.error('Ollama/RAG pipeline error:', err);
            await message.reply('*The connection to the arcane archives was disrupted. (LLM or Search Error)*');
        }
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
                    // If ID is provided, find the specific message
                    targetMessage = await message.channel.messages.fetch(messageId).catch(() => null);
                } else {
                    if (isPin) {
                        // For !pin without ID, get the last message before the command
                        const lastMessages = await message.channel.messages.fetch({ before: message.id, limit: 1 });
                        targetMessage = lastMessages.first();
                    } else {
                        // For !unpin without ID, get the most recent pinned message in the channel
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
                    // Protection against unpinning the OP message
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
});

client.on('channelDelete', async (channel) => {
    if (channel.guild?.id !== SERVER_ID) return;

    if (channel.parentId === ACTIVE_CATEGORY_ID || channel.parentId === ARCHIVED_CATEGORY_ID) {
        try {
            let role;
            const metaData = await getLibrarianData(channel);

            if (metaData && metaData.roleId) {
                role = channel.guild.roles.cache.get(metaData.roleId);
            }

            if (!role) {
                role = channel.guild.roles.cache.find(r => r.name === channel.name);
            }

            if (role) {
                await role.delete('Campaign channel was manually deleted');
            }
        } catch (err) {
            console.error('Failed to remove role on channel deletion:', err);
        }
    }
});

client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.guild?.id !== SERVER_ID) return;

    if (reaction.emoji.name === EMOJI_HAND) {
        const hasRobot = reaction.message.reactions.cache.get(EMOJI_ROBOT);
        if (hasRobot && hasRobot.me) {
            const metaData = await getLibrarianData(reaction.message.channel);
            if (metaData && metaData.roleId) {
                const role = reaction.message.guild.roles.cache.get(metaData.roleId);
                if (role) {
                    const member = await reaction.message.guild.members.fetch(user.id);
                    await member.roles.add(role).catch(console.error);
                }
            }
        }
    }
});

client.on('messageReactionRemove', async (reaction, user) => {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.guild?.id !== SERVER_ID) return;

    if (reaction.emoji.name === EMOJI_HAND) {
        const hasRobot = reaction.message.reactions.cache.get(EMOJI_ROBOT);
        if (hasRobot && hasRobot.me) {
            const metaData = await getLibrarianData(reaction.message.channel);
            if (metaData && metaData.roleId) {
                const role = reaction.message.guild.roles.cache.get(metaData.roleId);
                if (role) {
                    const member = await reaction.message.guild.members.fetch(user.id);
                    await member.roles.remove(role).catch(console.error);
                }
            }
        }
    }
});

client.login(token);
