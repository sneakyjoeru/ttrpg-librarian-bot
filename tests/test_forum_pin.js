// Test: pin a message inside a Game Invitations forum thread using the same
// logic the /pin slash command uses. Run inside the container:
//   docker exec librarian-bot node /tmp/test_forum_pin.js
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const path = require('path');

// Load config the same way the bot does (from the app working dir).
const config = require('../src/config');

const FORUM_ID = config.GAME_INVITATIONS_FORUM_ID;
const TARGET_MESSAGE_ID = '1533442034525016075';
const SERVER_ID = config.SERVER_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
    console.log(`[Test] Logged in as ${client.user.tag}`);
    let passed = true;
    try {
        const guild = await client.guilds.fetch(SERVER_ID);
        const forum = await guild.channels.fetch(FORUM_ID);
        console.log(`[Test] Forum channel: ${forum.name} (type=${forum.type})`);
        const isForum = forum.type === ChannelType.GuildForum || forum.type === ChannelType.GuildMedia;
        if (!isForum) {
            console.error('[Test] FAIL: channel is not a forum');
            passed = false;
        }

        // Enumerate the forum's threads to find the one containing the target message.
        const activeThreads = await forum.threads.fetchActive();
        const archivedThreads = await forum.threads.fetchArchived();
        const allThreads = [...activeThreads.threads.values(), ...archivedThreads.threads.values()];
        console.log(`[Test] Forum has ${allThreads.length} threads (active+archived)`);

        let foundThread = null;
        let targetMessage = null;
        for (const thread of allThreads) {
            const msg = await thread.messages.fetch(TARGET_MESSAGE_ID).catch(() => null);
            if (msg) {
                foundThread = thread;
                targetMessage = msg;
                break;
            }
        }

        if (!foundThread || !targetMessage) {
            console.error(`[Test] FAIL: could not find message ${TARGET_MESSAGE_ID} in any forum thread`);
            passed = false;
        } else {
            console.log(`[Test] Found message ${TARGET_MESSAGE_ID} in thread "${foundThread.name}" (id=${foundThread.id})`);
            console.log(`[Test] Thread parentId=${foundThread.parentId} (forum=${FORUM_ID}) match=${foundThread.parentId === FORUM_ID}`);
            console.log(`[Test] Message author: ${targetMessage.author.tag}, content preview: ${targetMessage.content.substring(0, 80)}`);

            // Verify the command-guard logic would allow: thread is a forum thread
            const isForumThread = foundThread.isThread() && foundThread.parentId === FORUM_ID;
            console.log(`[Test] isForumThread check = ${isForumThread}`);
            if (!isForumThread) {
                console.error('[Test] FAIL: guard logic would reject this thread');
                passed = false;
            }

            // Actually pin the message (the real test).
            await targetMessage.pin();
            console.log('[Test] Successfully pinned the message.');

            // Verify it shows in pinned list.
            const pinned = await foundThread.messages.fetchPinned();
            const isPinned = pinned.has(TARGET_MESSAGE_ID);
            console.log(`[Test] Message present in pinned list: ${isPinned}`);
            if (!isPinned) passed = false;
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