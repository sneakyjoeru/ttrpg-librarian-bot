// Campaign roster operations shared by the slash commands that manage the
// players of one campaign channel:
//   /campaign-members add|remove|list
//   /player-add, /player-remove          (mention-only aliases)
//
// A campaign "group" is the Discord role linked to the channel (metadata
// [LIBRARIAN_DATA|DM:<id>|ROLE:<id>] in the topic, or the legacy SETUP|…|ROLE:
// token written by /new-campaign before the OP is posted). Membership in that
// role IS the player roster, and the channel + role name carry the count as
// their trailing `-<playerCount>` segment.
//
// Extracted from interactions.js so /player-add and /player-remove reuse the
// exact same guard, permission and rename behaviour instead of drifting.
const { PermissionFlagsBits } = require('discord.js');
const { ACTIVE_CATEGORY_ID } = require('../config');
const { getLibrarianData, queueChannelRename, resolveGuildMember } = require('../utils/helpers');

// Resolves the campaign role this channel manages, enforcing the guard rules:
//   - the command must run inside an active campaign channel;
//   - only the campaign's DM (or an Admin) may change the roster;
//   - the channel must have a linked campaign role that still exists.
// Returns { role } on success, { error: '<user-facing message>' } otherwise.
async function resolveCampaignRoster(interaction) {
    if (!interaction.channel || interaction.channel.parentId !== ACTIVE_CATEGORY_ID) {
        return { error: 'This command can only be used in an active campaign channel.' };
    }

    const metaData = await getLibrarianData(interaction.channel);

    // LIBRARIAN_DATA channels resolve the role via the metadata; SETUP
    // (pre-OP) channels via the ROLE:<id> token /new-campaign writes when
    // players were listed at creation time.
    let linkedRoleId = null;
    if (metaData) {
        linkedRoleId = metaData.roleId;
    } else {
        const roleMatch = (interaction.channel.topic || '').match(/ROLE:(\d+)/);
        linkedRoleId = roleMatch ? roleMatch[1] : null;
    }

    if (!metaData) {
        const topic = interaction.channel.topic || '';
        if (topic.startsWith('SETUP|')) {
            const setupMatch = topic.match(/DM:(\d+)/);
            const setupDmId = setupMatch ? setupMatch[1] : null;
            if (interaction.user.id !== setupDmId && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
                return { error: 'Only the DM who created this campaign (or an Admin) can manage its members before the OP is posted.' };
            }
        } else if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return { error: 'Metadata missing in channel topic. Only Admins can manage members here.' };
        }
    } else if (metaData.dmId !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return { error: 'Only the DM who created the campaign (or an Admin) can manage its members.' };
    }

    if (!linkedRoleId) {
        return { error: 'No campaign role is linked to this channel yet. Players join via the ✋ reaction on the OP after it is posted.' };
    }
    const role = interaction.guild.roles.cache.get(linkedRoleId);
    if (!role) {
        return { error: 'The linked campaign role no longer exists on this server.' };
    }
    return { role };
}

// Resolves a roster target from a user ID, mention, nickname or username and
// maps resolveGuildMember's error descriptors to the messages the commands
// show. Returns { member } or { error }.
async function resolveMemberForRoster(guild, rawInput) {
    const resolved = await resolveGuildMember(guild, rawInput);
    if (resolved.error) {
        if (resolved.error === 'empty') {
            return { error: 'Please provide a user: a user ID, a mention, or an exact nickname/username.' };
        }
        if (resolved.error === 'ambiguous') {
            return { error: `That nickname matches several members. Please use a user ID or mention instead:\n${resolved.ambiguous.join('\n')}` };
        }
        return { error: `Could not find a member matching \`${rawInput}\`. Use a user ID, a mention, or an exact nickname/username.` };
    }
    return { member: resolved };
}

// Adds ('add') or removes ('remove') a member to/from the campaign role and
// syncs the channel + role name to the new player count. Always replies with
// an ephemeral message.
//
// Reply FIRST, rename after: Discord requires an interaction response within
// 3 seconds, while a channel rename can block for up to ~10 minutes inside
// discord.js's rate limiter (2 renames per 10 minutes). queueChannelRename is
// therefore fire-and-forget with a deferred retry, and onQueued tells the
// caller when the count will update later.
// Returns { ok: true } when membership changed, { ok: false } otherwise.
// `ctx` is an already-resolved result of resolveCampaignRoster — callers that
// need the guard to fire before resolving the target member pass it in;
// omitted, the roster is resolved here.
async function applyPlayerChange(interaction, action, member, ctx = null) {
    if (!ctx) ctx = await resolveCampaignRoster(interaction);
    if (ctx.error) {
        await interaction.reply({ content: ctx.error, ephemeral: true }).catch(() => {});
        return { ok: false };
    }
    const { role } = ctx;
    const label = `${member.displayName} (@${member.user.username})`;

    try {
        if (action === 'add') {
            if (role.members.has(member.id)) {
                await interaction.reply({ content: `${label} is already a player in this campaign.`, ephemeral: true }).catch(() => {});
                return { ok: false };
            }
            await member.roles.add(role);
            await interaction.reply({ content: `✅ Added **${member.displayName}** (@${member.user.username}) to this campaign.`, ephemeral: true });
        } else {
            if (!role.members.has(member.id)) {
                await interaction.reply({ content: `${label} is not a player in this campaign.`, ephemeral: true }).catch(() => {});
                return { ok: false };
            }
            await member.roles.remove(role);
            await interaction.reply({ content: `✅ Removed **${member.displayName}** (@${member.user.username}) from this campaign.`, ephemeral: true });
        }
    } catch (error) {
        console.error(`Campaign roster ${action} error:`, error);
        await interaction.reply({ content: `Failed to ${action} the member. Check bot permissions and role hierarchy.`, ephemeral: true }).catch(() => {});
        return { ok: false };
    }

    // Fire-and-forget count sync (channel name AND role name), with a
    // heads-up follow-up when Discord's rename quota defers it.
    queueChannelRename(interaction.channel, role, (delayMs) => {
        const minutes = Math.ceil(delayMs / 60000);
        interaction.followUp({
            content: `⏳ Channel rename limit reached (Discord allows 2 per 10 minutes) — the channel/role name will update to the new player count in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
            ephemeral: true
        }).catch(() => {});
    }).catch(() => {});
    return { ok: true };
}

module.exports = {
    resolveCampaignRoster,
    resolveMemberForRoster,
    applyPlayerChange
};
