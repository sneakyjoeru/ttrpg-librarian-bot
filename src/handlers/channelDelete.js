const { getLibrarianData } = require('../utils/helpers');
const { SERVER_ID, ACTIVE_CATEGORY_ID, ARCHIVED_CATEGORY_ID } = require('../config');

async function handleChannelDelete(channel) {
    if (channel.guild?.id !== SERVER_ID) return;

    if (channel.parentId === ACTIVE_CATEGORY_ID || channel.parentId === ARCHIVED_CATEGORY_ID) {
        try {
            let role;
            const metaData = await getLibrarianData(channel);

            if (metaData && metaData.roleId) {
                role = channel.guild.roles.cache.get(metaData.roleId);
            }

            if (!role) {
                role = channel.guild.roles.cache.find(r => r.name === channel.name);
            }

            if (role) {
                await role.delete('Campaign channel was manually deleted');
            }
        } catch (err) {
            console.error('Failed to remove role on channel deletion:', err);
        }
    }
}

module.exports = handleChannelDelete;
