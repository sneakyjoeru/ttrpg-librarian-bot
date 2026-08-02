// Test: role-mention fallback triggers the RAG handler.
// Verifies the logic in messageCreate.js: a message pinging the bot's ROLE
// (<@&ROLE_ID>) is treated as a bot mention. We mock handleRagQuery so no
// real LLM/network call is made; we only assert the handler was invoked with
// the role mention stripped from the query.
//
// Run inside the container:
//   docker exec librarian-bot node tests/test_role_mention.js
const { Client, GatewayIntentBits } = require('discord.js');
const config = require('../src/config');

// Monkey-patch handleRagQuery to capture the call instead of running the LLM.
let captured = null;
const ragPath = require.resolve('../src/services/rag');
const realRag = require(ragPath);
realRag.handleRagQuery = (client, message, query) => {
    captured = { query, channelId: message.channel?.id, authorId: message.author?.id };
    return Promise.resolve();
};

// Require the handler AFTER patching rag so it picks up the patched export.
const handleMessageCreate = require('../src/handlers/messageCreate');

const SERVER_ID = config.SERVER_ID;
const TEST_CHANNEL_ID = config.GENERAL_CHANNEL_ID; // a channel the bot can see

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', async () => {
    console.log(`[Test] Logged in as ${client.user.tag}`);
    let passed = true;
    try {
        const guild = await client.guilds.fetch(SERVER_ID);
        const botMember = await guild.members.fetch(client.user.id);
        // Find the bot's highest non-default role (the "Librarian-Bot" role).
        const botRole = botMember.roles.cache.find(r => r.name !== '@everyone');
        if (!botRole) {
            console.error('[Test] FAIL: bot has no role besides @everyone');
            passed = false;
        } else {
            console.log(`[Test] Bot role: ${botRole.name} (${botRole.id})`);

            const channel = await guild.channels.fetch(TEST_CHANNEL_ID);

            // Build a synthetic message that pings the bot's ROLE.
            // We can't fabricate a full discord.js Message easily, so we send a
            // real message and rely on the live messageCreate event.
            const mentionContent = `<@&${botRole.id}> provide step by step instruction to enable developer mode`;
            console.log(`[Test] Sending role-mention message to #${channel.name}: "${mentionContent}"`);
            const sent = await channel.send(mentionContent);

            // Wait briefly for the handler to process (it runs on the messageCreate
            // event of THIS client, which is the same connection). Give it up to 8s.
            const deadline = Date.now() + 8000;
            while (!captured && Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 200));
            }

            if (!captured) {
                console.error('[Test] FAIL: handleRagQuery was never called for the role mention');
                passed = false;
            } else {
                console.log(`[Test] handleRagQuery called. Query: "${captured.query}"`);
                const cleanedOk = !new RegExp(`<@&${botRole.id}>`).test(captured.query);
                console.log(`[Test] Role mention stripped from query: ${cleanedOk}`);
                if (!cleanedOk) passed = false;
                const hasContent = /developer mode/i.test(captured.query);
                console.log(`[Test] Query retains the actual question: ${hasContent}`);
                if (!hasContent) passed = false;
            }

            // Cleanup: delete the test message.
            await sent.delete().catch(() => {});
            console.log('[Test] Deleted test message');
        }
    } catch (err) {
        console.error('[Test] ERROR:', err);
        passed = false;
    } finally {
        await client.destroy();
        console.log(passed ? '[Test] RESULT: PASS' : '[Test] RESULT: FAIL');
        process.exit(passed ? 0 : 1);
    }
});

client.login(config.token);