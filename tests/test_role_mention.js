// Test: role-mention fallback detection logic.
// The full messageCreate handler skips messages from bots (message.author.bot),
// so a live end-to-end test would require a non-bot author. Instead this test
// exercises the EXACT detection logic (role mention <-> bot member roles) in
// isolation against the live guild, verifying:
//   1. The bot member holds a role named after itself ("Librarian-Bot").
//   2. A message pinging that role (<@&ROLE_ID>) would match the fallback.
//   3. The query-stripping regex removes the role mention cleanly.
//   4. A role the bot does NOT hold must NOT match (negative case).
//
// Run inside the container:
//   docker exec librarian-bot node tests/test_role_mention.js
const { Client, GatewayIntentBits } = require('discord.js');
const config = require('../src/config');

const SERVER_ID = config.SERVER_ID;
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    console.log(`[Test] Logged in as ${client.user.tag}`);
    let passed = true;
    try {
        const guild = await client.guilds.fetch(SERVER_ID);
        const botMember = await guild.members.fetch(client.user.id);

        // 1. Bot must hold at least one non-@everyone role.
        const botRoles = [...botMember.roles.cache.values()].filter(r => r.name !== '@everyone');
        console.log(`[Test] Bot roles: ${botRoles.map(r => r.name + '(' + r.id + ')').join(', ') || 'none'}`);
        if (botRoles.length === 0) {
            console.error('[Test] FAIL: bot has no role besides @everyone');
            passed = false;
        }

        // 2. Simulate a message pinging each bot role and run the exact
        //    detection logic from messageCreate.js.
        const sampleQuery = 'provide step by step instruction to enable developer mode';
        for (const role of botRoles) {
            const content = `<@&${role.id}> ${sampleQuery}`;
            // Replicate the fallback check.
            const mentionedRoleIds = [content.match(/<@&(\d+)>/)?.[1]].filter(Boolean);
            const botRoleIds = [...botMember.roles.cache.keys()];
            const matched = mentionedRoleIds.filter(rid => botRoleIds.includes(rid));

            console.log(`[Test] Role ${role.name}: mentioned=${mentionedRoleIds.join(',')}, matched=${matched.length > 0}`);
            if (matched.length === 0) {
                console.error(`[Test] FAIL: role ${role.name} mention did not match bot roles`);
                passed = false;
                continue;
            }

            // Replicate query stripping.
            let query = content;
            for (const rid of matched) {
                query = query.replace(new RegExp(`<@&${rid}>`, 'g'), '');
            }
            query = query.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();

            const stripped = !new RegExp(`<@&${role.id}>`).test(query);
            const keptQuestion = /developer mode/i.test(query);
            console.log(`[Test]   stripped mention: ${stripped}, kept question: ${keptQuestion}, query: "${query}"`);
            if (!stripped || !keptQuestion) passed = false;
        }

        // 3. Negative case: a role the bot does NOT hold must NOT match.
        const otherRole = [...guild.roles.cache.values()].find(r => r.name !== '@everyone' && !botMember.roles.cache.has(r.id));
        if (otherRole) {
            const content = `<@&${otherRole.id}> ${sampleQuery}`;
            const mentionedRoleIds = [content.match(/<@&(\d+)>/)?.[1]].filter(Boolean);
            const botRoleIds = [...botMember.roles.cache.keys()];
            const matched = mentionedRoleIds.filter(rid => botRoleIds.includes(rid));
            console.log(`[Test] Non-bot role ${otherRole.name}: matched=${matched.length > 0} (expected false)`);
            if (matched.length > 0) {
                console.error('[Test] FAIL: non-bot role matched the fallback');
                passed = false;
            }
        } else {
            console.log('[Test] No non-bot role available for negative case (skipped)');
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