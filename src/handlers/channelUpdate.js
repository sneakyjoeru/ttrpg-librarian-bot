const { getLibrarianData } = require('../utils/helpers');
const { SERVER_ID, ACTIVE_CATEGORY_ID } = require('../config');

async function handleChannelUpdate(oldChannel, newChannel) {
    // Ignore events from other servers
    if (newChannel.guild?.id !== SERVER_ID) return;

    // Only react if the channel name actually changed
    if (oldChannel.name === newChannel.name) return;

    // Check if the channel is in the active games category
    if (newChannel.parentId === ACTIVE_CATEGORY_ID) {
        try {
            const metaData = await getLibrarianData(newChannel);

            if (metaData && metaData.roleId) {
                const role = newChannel.guild.roles.cache.get(metaData.roleId);

                // Check if the role name needs to be updated (prevent double update when using /update-players)
                if (role && role.name !== newChannel.name) {
                    await role.edit({
                        name: newChannel.name,
                        reason: 'Automatic sync: Channel was manually renamed'
                    });
                    console.log(`Role name synced to match renamed channel: ${newChannel.name}`);
                }
            }
        } catch (err) {
            console.error('Failed to update role on manual channel rename:', err);
        }
    }
}

module.exports = handleChannelUpdate;
