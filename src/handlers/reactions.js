const { getLibrarianData, queueChannelRename } = require('../utils/helpers');
const { SERVER_ID, EMOJI_ROBOT, EMOJI_HAND } = require('../config');
const { handlePollReactionAdd, handlePollReactionRemove } = require('./polls');
const { handleSchedulingVoteChange } = require('./scheduling');

async function handleReactionAdd(reaction, user) {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.guild?.id !== SERVER_ID) return;

    // Poll vote tracking (and game-channel voter restriction).
    await handlePollReactionAdd(reaction, user, reaction.client.user.id).catch(console.error);

    // Scheduling poll → maybe emit the consensus calendar (.ics).
    await handleSchedulingVoteChange(reaction.message, reaction.client.user.id).catch(console.error);

    if (reaction.emoji.name === EMOJI_HAND) {
        const hasRobot = reaction.message.reactions.cache.get(EMOJI_ROBOT);
        if (hasRobot && hasRobot.me) {
            const metaData = await getLibrarianData(reaction.message.channel);
            if (metaData && metaData.roleId) {
                const role = reaction.message.guild.roles.cache.get(metaData.roleId);
                if (role) {
                    const member = await reaction.message.guild.members.fetch(user.id);
                    await member.roles.add(role).catch(console.error);
                    // Update the channel name to reflect the new player count;
                    // queues a deferred retry (with a heads-up in-channel
                    // notice) instead of silently dropping the rename if
                    // Discord's 2-per-10-minutes limit is already spent.
                    await queueChannelRename(reaction.message.channel, role, (delayMs) => {
                        const minutes = Math.ceil(delayMs / 60000);
                        reaction.message.channel.send({
                            content: `⏳ Channel rename limit reached (Discord allows 2 per 10 minutes) — the channel/role name will update to the new player count in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
                        }).catch(() => {});
                    }).catch(() => {});
                }
            }
        }
    }
}

async function handleReactionRemove(reaction, user) {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.guild?.id !== SERVER_ID) return;

    // Poll vote tracking.
    await handlePollReactionRemove(reaction, user, reaction.client.user.id).catch(console.error);

    // Scheduling poll → re-evaluate consensus after a vote is removed too.
    await handleSchedulingVoteChange(reaction.message, reaction.client.user.id).catch(console.error);

    if (reaction.emoji.name === EMOJI_HAND) {
        const hasRobot = reaction.message.reactions.cache.get(EMOJI_ROBOT);
        if (hasRobot && hasRobot.me) {
            const metaData = await getLibrarianData(reaction.message.channel);
            if (metaData && metaData.roleId) {
                const role = reaction.message.guild.roles.cache.get(metaData.roleId);
                if (role) {
                    const member = await reaction.message.guild.members.fetch(user.id);
                    await member.roles.remove(role).catch(console.error);
                    // Update the channel name to reflect the new player count;
                    // see handleReactionAdd for why this queues instead of
                    // silently dropping a rate-limited rename.
                    await queueChannelRename(reaction.message.channel, role, (delayMs) => {
                        const minutes = Math.ceil(delayMs / 60000);
                        reaction.message.channel.send({
                            content: `⏳ Channel rename limit reached (Discord allows 2 per 10 minutes) — the channel/role name will update to the new player count in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
                        }).catch(() => {});
                    }).catch(() => {});
                }
            }
        }
    }
}

module.exports = {
    handleReactionAdd,
    handleReactionRemove
};
