const { getLibrarianData } = require('../utils/helpers');
const { SERVER_ID, EMOJI_ROBOT, EMOJI_HAND } = require('../config');

async function handleReactionAdd(reaction, user) {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.guild?.id !== SERVER_ID) return;

    if (reaction.emoji.name === EMOJI_HAND) {
        const hasRobot = reaction.message.reactions.cache.get(EMOJI_ROBOT);
        if (hasRobot && hasRobot.me) {
            const metaData = await getLibrarianData(reaction.message.channel);
            if (metaData && metaData.roleId) {
                const role = reaction.message.guild.roles.cache.get(metaData.roleId);
                if (role) {
                    const member = await reaction.message.guild.members.fetch(user.id);
                    await member.roles.add(role).catch(console.error);
                }
            }
        }
    }
}

async function handleReactionRemove(reaction, user) {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    if (reaction.message.guild?.id !== SERVER_ID) return;

    if (reaction.emoji.name === EMOJI_HAND) {
        const hasRobot = reaction.message.reactions.cache.get(EMOJI_ROBOT);
        if (hasRobot && hasRobot.me) {
            const metaData = await getLibrarianData(reaction.message.channel);
            if (metaData && metaData.roleId) {
                const role = reaction.message.guild.roles.cache.get(metaData.roleId);
                if (role) {
                    const member = await reaction.message.guild.members.fetch(user.id);
                    await member.roles.remove(role).catch(console.error);
                }
            }
        }
    }
}

module.exports = {
    handleReactionAdd,
    handleReactionRemove
};
