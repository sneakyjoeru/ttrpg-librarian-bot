const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');

// --- CONFIGURATION CONSTANTS ---
const SECRETS_PATH = './secrets_discord.php';
const SERVER_ID = '1294242036492406837';             // The ID of the Discord Guild/Server the bot operates on
const ACTIVE_CATEGORY_ID = '1294261463808217088';     // Category ID where active campaign text channels are created
const ARCHIVED_CATEGORY_ID = '1294261512780906526';   // Category ID where archived campaign channels are stored
const DM_ROLE_ID = '1294335928759746560';             // Role ID of Dungeon Masters who have administrative access to game campaigns

const SYSTEM_CHANNEL_ID = '1294333974897885185';      // Channel where Librarian Bot posts its global interactive help message
const SYSTEM_MESSAGE_ID = '1505941250732458166';      // Message ID of the bot's help post in SYSTEM_CHANNEL_ID (edited automatically on restart)
const GENERAL_CHANNEL_ID = '1294242036492406840';     // General chat channel ID (used for posting monthly free 3D printing schedules)
const RULES_MESSAGE_ID = '1302931730411425852';       // Message ID of server rules, referenced in monthly printing posts
const SNEAKYJOE_USER_ID = '221722372145676288';       // Discord User ID of the 3D printing host (sneakyjoe) tagged in print queues

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://192.168.0.100:9080/search';           // API endpoint of local SearXNG meta-search instance for RAG queries
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://192.168.0.101:11434/api/generate';     // API endpoint of local Ollama server running Llama 3.1
const OLLAMA_MODEL = 'qwen3.5:9b';                                  // Local LLM model name run in Ollama

const TIMEZONE = 'Europe/Tallinn';                    // Local timezone used to schedule cron jobs & timestamps
const CRON_SCHEDULE_MONTHLY_MINI = '0 9 1 * *';       // Cron schedule for monthly announcements (1st of every month at 9:00 AM for +-2h randomization)

const EMOJI_ROBOT = '🤖';                             // Reacted emoji on campaign OP posts
const EMOJI_HAND = '✋';                              // Emoji that players click to self-assign campaign player roles

const EMBED_COLOR = 0x2b2d31;                         // Dark gray hex color used for the bot's embed messages

const THREAD_AUTO_ARCHIVE_DURATION_ONE_DAY = 1440;     // Auto-archive threads after 1 day (in minutes)
const THREAD_AUTO_ARCHIVE_DURATION_SEVEN_DAYS = 10080; // Auto-archive threads after 7 days (in minutes)
const DISCORD_START_SNOWFLAKE = '1';                  // Snowflake ID used as a baseline to retrieve the first messages in a channel

const RAG_SEARCH_LIMIT = 5;                           // Number of search results to include in LLM context
const RAG_HISTORY_LIMIT = 100;                        // Number of recent chat history messages to include in LLM context
const RAG_SEARCH_TIMEOUT = 5000;                      // Timeout for meta-search requests (ms)
const RAG_OLLAMA_TIMEOUT = 120000;                    // Timeout for local Ollama server generation (ms)
const RAG_TYPING_INTERVAL = 10000;                     // Typing status keep-alive interval (ms)

// Media compression settings
const FFMPEG_TIMEOUT = 180000; // 180s timeout for ffmpeg compression on ARM
const DISCORD_FILE_LIMIT_DEFAULT = 10 * 1024 * 1024; // 10MB default (no boosts)

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

// --- TOKEN LOADING ---
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

// --- HELP TEXT ---
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

// --- SLASH COMMAND BUILDERS ---
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
    new SlashCommandBuilder()
        .setName('restart')
        .setDescription('Rebuild and restart the bot container (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(command => command.toJSON());

module.exports = {
    token,
    helpText,
    commands,
    SERVER_ID,
    ACTIVE_CATEGORY_ID,
    ARCHIVED_CATEGORY_ID,
    DM_ROLE_ID,
    SYSTEM_CHANNEL_ID,
    SYSTEM_MESSAGE_ID,
    GENERAL_CHANNEL_ID,
    RULES_MESSAGE_ID,
    SNEAKYJOE_USER_ID,
    SEARXNG_URL,
    OLLAMA_URL,
    OLLAMA_MODEL,
    TIMEZONE,
    CRON_SCHEDULE_MONTHLY_MINI,
    EMOJI_ROBOT,
    EMOJI_HAND,
    EMBED_COLOR,
    THREAD_AUTO_ARCHIVE_DURATION_ONE_DAY,
    THREAD_AUTO_ARCHIVE_DURATION_SEVEN_DAYS,
    DISCORD_START_SNOWFLAKE,
    RAG_SEARCH_LIMIT,
    RAG_HISTORY_LIMIT,
    RAG_SEARCH_TIMEOUT,
    RAG_OLLAMA_TIMEOUT,
    RAG_TYPING_INTERVAL,
    NUMBER_EMOJIS,
    FALLBACK_ROASTS,
    FFMPEG_TIMEOUT,
    DISCORD_FILE_LIMIT_DEFAULT
};
