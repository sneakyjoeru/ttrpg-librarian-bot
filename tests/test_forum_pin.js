// Test: /pin and /unpin inside a Game Invitations forum thread.
//
// Remade 2026-11-19. The old version pinned one hard-coded real message
// (1533442034525016075) in a real game thread; it broke as soon as that
// thread auto-archived ("DiscordAPIError[50083]: Thread is archived") and it
// mutated a player's thread every run. This version drives the REAL
// src/handlers/interactions.js handler with mock interactions (no Discord
// login, nothing in the server changes) and covers:
//   - OP of the forum thread can pin / unpin (by id and "last message")
//   - an Admin who is not the OP can pin
//   - a non-OP non-admin is refused
//   - a thread outside the forum (and outside campaign channels) is refused
// Optional read-only live check (--live): the configured forum exists and is
// a forum channel.
//
// Run: node tests/test_forum_pin.js [--live]
//   or: docker exec librarian-bot node tests/test_forum_pin.js --live
'use strict';
const assert = require('assert');
const path = require('path');

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || 'test_token';
const { Collection, ChannelType, REST, Routes } = require('discord.js');
const config = require(path.join(__dirname, '..', 'src', 'config'));
const handleInteraction = require(path.join(__dirname, '..', 'src', 'handlers', 'interactions'));

const FORUM_ID = config.GAME_INVITATIONS_FORUM_ID;
const OP_ID = '100000000000000001';
const OTHER_ID = '100000000000000002';

function makeInteraction({ commandName, userId, isAdmin = false, messageId = null, parentId = FORUM_ID, pinnedAlready = false }) {
    const log = { pinned: [], unpinned: [], replies: [] };
    const target = {
        id: '200000000000000001',
        url: 'https://discord.com/channels/g/t/200000000000000001',
        pin: async () => { log.pinned.push(target.id); },
        unpin: async () => { log.unpinned.push(target.id); },
    };
    const channel = {
        id: '300000000000000001',
        parentId,
        isThread: () => true,
        fetchStarterMessage: async () => ({ author: { id: OP_ID } }),
        messages: {
            fetch: async (arg) => {
                if (typeof arg === 'string') return arg === target.id ? target : null;
                return new Collection([[target.id, target]]);
            },
            fetchPinned: async () => new Collection(pinnedAlready ? [[target.id, target]] : []),
        },
    };
    const interaction = {
        isChatInputCommand: () => true,
        guildId: config.SERVER_ID,
        commandName,
        options: { getString: (name) => (name === 'message_id' ? messageId : null) },
        channel,
        user: { id: userId, tag: `user-${userId}` },
        member: {
            roles: { cache: new Collection() },
            permissions: { has: () => isAdmin },
        },
        reply: async (payload) => { log.replies.push(typeof payload === 'string' ? payload : payload.content); },
    };
    return { interaction, log, target };
}

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log(`  \u2713 ${name}`); passed++; }
    catch (e) { console.log(`  \u2717 ${name}: ${e.message}`); failed++; }
}

(async () => {
    console.log('/pin and /unpin in a Game Invitations forum thread (real handler, mock Discord)');

    await test('OP pins a message by id', async () => {
        const { interaction, log, target } = makeInteraction({ commandName: 'pin', userId: OP_ID, messageId: '200000000000000001' });
        await handleInteraction({}, interaction);
        assert.deepStrictEqual(log.pinned, [target.id]);
        assert.ok(/Pinned/.test(log.replies[0]), log.replies[0]);
    });

    await test('OP pins the last message (no id)', async () => {
        const { interaction, log, target } = makeInteraction({ commandName: 'pin', userId: OP_ID });
        await handleInteraction({}, interaction);
        assert.deepStrictEqual(log.pinned, [target.id]);
    });

    await test('OP unpins the last pinned message', async () => {
        const { interaction, log, target } = makeInteraction({ commandName: 'unpin', userId: OP_ID, pinnedAlready: true });
        await handleInteraction({}, interaction);
        assert.deepStrictEqual(log.unpinned, [target.id]);
        assert.ok(/Unpinned/.test(log.replies[0]), log.replies[0]);
    });

    await test('Admin (not OP) can pin', async () => {
        const { interaction, log } = makeInteraction({ commandName: 'pin', userId: OTHER_ID, isAdmin: true });
        await handleInteraction({}, interaction);
        assert.strictEqual(log.pinned.length, 1);
    });

    await test('non-OP non-admin is refused, nothing pinned', async () => {
        const { interaction, log } = makeInteraction({ commandName: 'pin', userId: OTHER_ID });
        await handleInteraction({}, interaction);
        assert.strictEqual(log.pinned.length, 0);
        assert.ok(/Only the thread owner/.test(log.replies[0]), log.replies[0]);
    });

    await test('thread outside the forum / campaign channels is refused', async () => {
        const { interaction, log } = makeInteraction({ commandName: 'pin', userId: OP_ID, parentId: '999999999999999999' });
        await handleInteraction({}, interaction);
        assert.strictEqual(log.pinned.length, 0);
        assert.ok(/can only be used/.test(log.replies[0]), log.replies[0]);
    });

    if (process.argv.includes('--live')) {
        await test('live (read-only): GAME_INVITATIONS_FORUM_ID is a forum channel', async () => {
            const rest = new REST({ version: '10' }).setToken(config.token);
            const ch = await rest.get(Routes.channel(FORUM_ID));
            assert.ok(ch.type === ChannelType.GuildForum || ch.type === ChannelType.GuildMedia, `type=${ch.type}`);
            console.log(`    forum: #${ch.name}`);
        });
    }

    console.log(`\n=== ${passed}/${passed + failed} passed ===`);
    process.exit(failed === 0 ? 0 : 1);
})();
