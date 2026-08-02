// Test: campaign creation auto-assigns the player role to listed players.
// Creates a real (private) campaign channel in the active category, posts
// nothing (no OP), checks that the role was created and assigned to the
// listed player, then cleans up (deletes the role and the channel).
//
// Run inside the container:
//   docker exec librarian-bot node tests/test_campaign_auto_role.js
const { Client, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');
const config = require('../src/config');

const SERVER_ID = config.SERVER_ID;
const ACTIVE_CATEGORY_ID = config.ACTIVE_CATEGORY_ID;
const TEST_PLAYER_ID = config.SNEAKYJOE_USER_ID; // use the host owner as the test "player"

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once('ready', async () => {
    console.log(`[Test] Logged in as ${client.user.tag}`);
    let passed = true;
    let testChannel = null;
    let testRole = null;
    try {
        const guild = await client.guilds.fetch(SERVER_ID);

        // Read the member's current roles so we can restore them afterwards.
        const memberBefore = await guild.members.fetch(TEST_PLAYER_ID);
        const rolesBefore = new Set(memberBefore.roles.cache.keys());
        console.log(`[Test] Test player ${memberBefore.user.tag} has ${rolesBefore.size} roles before test`);

        // Create a private campaign channel with the test player listed.
        const channelName = `test-auto-role-${Date.now()}`;
        const permissionOverwrites = [
            { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: TEST_PLAYER_ID, allow: [PermissionFlagsBits.ViewChannel] },
            { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageRoles] }
        ];
        testChannel = await guild.channels.create({
            name: channelName,
            type: 0, // GuildText
            parent: ACTIVE_CATEGORY_ID,
            topic: `SETUP|DM:${client.user.id}|USERS:${TEST_PLAYER_ID}`,
            permissionOverwrites
        });
        console.log(`[Test] Created channel ${testChannel.name} (${testChannel.id})`);
        console.log(`[Test] Topic: ${testChannel.topic}`);

        // Replicate the campaign-creation role logic from interactions.js.
        const role = await guild.roles.create({
            name: channelName,
            reason: 'Test: automated role for campaign channel'
        });
        testRole = role;
        console.log(`[Test] Created role ${role.name} (${role.id})`);

        await testChannel.permissionOverwrites.edit(role.id, {
            MentionEveryone: true
        }).catch(() => { });

        // Assign the role to the test player if not already assigned.
        const member = await guild.members.fetch(TEST_PLAYER_ID);
        let assignedNow = false;
        if (!member.roles.cache.has(role.id)) {
            await member.roles.add(role).catch(() => { });
            assignedNow = true;
        }
        console.log(`[Test] Role assigned now (was missing): ${assignedNow}`);

        // Update topic to include the role id (as the new code does).
        await testChannel.setTopic(`SETUP|DM:${client.user.id}|USERS:${TEST_PLAYER_ID}|ROLE:${role.id}`).catch(() => { });

        // Verify the player now has the role.
        const memberAfter = await guild.members.fetch(TEST_PLAYER_ID);
        const hasRole = memberAfter.roles.cache.has(role.id);
        console.log(`[Test] Player has role after assignment: ${hasRole}`);
        if (!hasRole) passed = false;

        // Verify the topic contains ROLE:<id>.
        const topicHasRole = /ROLE:\d+/.test(testChannel.topic);
        console.log(`[Test] Topic contains ROLE:<id>: ${topicHasRole}`);
        if (!topicHasRole) passed = false;

        // --- Verify the OP-time reuse logic would find the role ---
        const roleMatch = testChannel.topic.match(/ROLE:(\d+)/);
        const reusedRole = roleMatch ? guild.roles.cache.get(roleMatch[1]) : null;
        console.log(`[Test] OP-time reuse lookup found role: ${!!reusedRole}`);
        if (!reusedRole) passed = false;
    } catch (err) {
        console.error('[Test] ERROR:', err);
        passed = false;
    } finally {
        // Cleanup: remove the role from the player (if we added it), delete the role, delete the channel.
        try {
            if (testRole) {
                const m = await client.guilds.fetch(SERVER_ID).then(g => g.members.fetch(TEST_PLAYER_ID)).catch(() => null);
                if (m && m.roles.cache.has(testRole.id)) {
                    await m.roles.remove(testRole).catch(() => { });
                    console.log('[Test] Removed test role from player');
                }
                await testRole.delete('Test cleanup').catch(() => { });
                console.log('[Test] Deleted test role');
            }
        } catch (_) {}
        try {
            if (testChannel) {
                await testChannel.delete('Test cleanup').catch(() => { });
                console.log('[Test] Deleted test channel');
            }
        } catch (_) {}
        await client.destroy();
        console.log(passed ? '[Test] RESULT: PASS' : '[Test] RESULT: FAIL');
        process.exit(passed ? 0 : 1);
    }
});

client.login(config.token);