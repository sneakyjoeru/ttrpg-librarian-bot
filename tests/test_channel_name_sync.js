// Test: channel name auto-updates to reflect campaign role member count.
// Creates a temporary campaign channel + role, assigns the role to a test
// member, and verifies syncChannelNameToRoleCount renames the channel + role.
//
// Run inside the container:
//   docker exec librarian-bot node tests/test_channel_name_sync.js
const { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } = require('discord.js');
const config = require('../src/config');
const { syncChannelNameToRoleCount } = require('../src/utils/helpers');

const SERVER_ID = config.SERVER_ID;
const ACTIVE_CATEGORY_ID = config.ACTIVE_CATEGORY_ID;
// Use a regular member below the bot in the role hierarchy.
const TEST_PLAYER_ID = '1176853180785623056'; // moskin_20405

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once('ready', async () => {
    console.log(`[Test] Logged in as ${client.user.tag}`);
    let passed = true;
    let testChannel = null;
    let testRole = null;
    try {
        const guild = await client.guilds.fetch(SERVER_ID);

        // Create a campaign channel with an initial count of 1.
        const baseName = `test-sync-${Date.now()}`;
        const initialName = `${baseName}-dm-1`;
        testChannel = await guild.channels.create({
            name: initialName,
            type: ChannelType.GuildText,
            parent: ACTIVE_CATEGORY_ID,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles] }
            ]
        });
        console.log(`[Test] Created channel "${testChannel.name}" (${testChannel.id})`);

        // Create a role matching the channel name.
        testRole = await guild.roles.create({ name: initialName, reason: 'Test sync' });
        console.log(`[Test] Created role "${testRole.name}" (${testRole.id})`);

        // Assign role to the test player via REST (cache is stale in v14).
        await client.rest.put(`/guilds/${guild.id}/members/${TEST_PLAYER_ID}/roles/${testRole.id}`);
        console.log('[Test] Assigned role to test player via REST');

        // Force-fetch the role to update the member cache.
        await guild.roles.fetch(testRole.id);
        const roleMembers = testRole.members.size;
        console.log(`[Test] Role member count (after fetch): ${roleMembers}`);
        if (roleMembers !== 1) {
            console.error(`[Test] FAIL: expected 1 member, got ${roleMembers}`);
            passed = false;
        }

        // Call syncChannelNameToRoleCount — should rename to ...-1 (no change
        // since it's already 1).
        await syncChannelNameToRoleCount(testChannel, testRole);
        await testChannel.fetch();
        console.log(`[Test] After sync (count=1): channel="${testChannel.name}"`);
        if (testChannel.name !== initialName) {
            console.error(`[Test] FAIL: channel name changed when it shouldn't have (expected ${initialName})`);
            passed = false;
        }

        // Add the bot itself to the role (so count becomes 2).
        await client.rest.put(`/guilds/${guild.id}/members/${client.user.id}/roles/${testRole.id}`);
        await guild.roles.fetch(testRole.id);
        console.log(`[Test] Role member count after adding bot: ${testRole.members.size}`);

        // Call sync — should rename to ...-2.
        await syncChannelNameToRoleCount(testChannel, testRole);
        await testChannel.fetch();
        const expectedName = `${baseName}-dm-2`;
        console.log(`[Test] After sync (count=2): channel="${testChannel.name}", expected="${expectedName}"`);
        if (testChannel.name !== expectedName) {
            console.error(`[Test] FAIL: channel name not updated to ${expectedName}`);
            passed = false;
        }

        // Verify role name also updated.
        await guild.roles.fetch(testRole.id);
        console.log(`[Test] Role name after sync: "${testRole.name}"`);
        if (testRole.name !== expectedName) {
            console.error(`[Test] FAIL: role name not updated to ${expectedName}`);
            passed = false;
        }
    } catch (err) {
        console.error('[Test] ERROR:', err);
        passed = false;
    } finally {
        // Cleanup via REST (cache is stale).
        try {
            if (testRole) {
                try { await client.rest.delete(`/guilds/${SERVER_ID}/members/${TEST_PLAYER_ID}/roles/${testRole.id}`); } catch (_) {}
                try { await client.rest.delete(`/guilds/${SERVER_ID}/members/${client.user.id}/roles/${testRole.id}`); } catch (_) {}
                await testRole.delete('Test cleanup').catch(() => {});
                console.log('[Test] Deleted test role');
            }
        } catch (_) {}
        try {
            if (testChannel) {
                await testChannel.delete('Test cleanup').catch(() => {});
                console.log('[Test] Deleted test channel');
            }
        } catch (_) {}
        await client.destroy();
        console.log(passed ? '[Test] RESULT: PASS' : '[Test] RESULT: FAIL');
        process.exit(passed ? 0 : 1);
    }
});

client.login(config.token);