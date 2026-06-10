const { Client, GatewayIntentBits, Partials, REST, Routes, ActivityType } = require('discord.js');
const cron = require('node-cron');
const {
    token,
    helpText,
    commands,
    SERVER_ID,
    SYSTEM_CHANNEL_ID,
    SYSTEM_MESSAGE_ID,
    GENERAL_CHANNEL_ID,
    RULES_MESSAGE_ID,
    SNEAKYJOE_USER_ID,
    TIMEZONE,
    CRON_SCHEDULE_MONTHLY_MINI,
    THREAD_AUTO_ARCHIVE_DURATION_SEVEN_DAYS
} = require('./src/config');
const { getLastUpdates } = require('./src/utils/helpers');
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

            // Retrieve the last 3 updates from git (or fallback)
            const updatesList = getLastUpdates();

            const contentWithTime = `${helpText}\n\n**Last 3 Updates:**\n${updatesList}\n\n*Last updated: ${tallinnTime}*`;

            if (systemMessage) {
                await systemMessage.edit({ content: contentWithTime });
                console.log('System help message successfully updated with timestamp and last 3 updates.');
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
                `Monthly mini slots are officially refreshed today! 🗺️ Don't be shy if you're new, grab your character in physical form. Rules: ${pinnedPostLink}. Drop the file in the thread and let <@221722372145676288> fire up the printer.`,
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
