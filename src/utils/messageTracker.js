// In-memory message tracking store
// Capped at 1000 items to prevent memory leaks

const trackedMessages = [];
const MAX_TRACKED_MESSAGES = 1000;

/**
 * Tracks a message sent by the bot or its webhooks as being triggered by a specific user.
 * @param {string} messageId - The ID of the message sent by the bot/webhook.
 * @param {string} userId - The ID of the user who triggered the message.
 * @param {string} channelId - The ID of the channel where the message was sent.
 */
function trackMessage(messageId, userId, channelId) {
    if (!messageId || !userId || !channelId) return;

    // Check if already tracked to avoid duplicates
    const exists = trackedMessages.some(m => m.messageId === messageId);
    if (exists) return;

    trackedMessages.push({
        messageId,
        userId,
        channelId,
        timestamp: Date.now()
    });

    // Enforce limit
    if (trackedMessages.length > MAX_TRACKED_MESSAGES) {
        trackedMessages.shift(); // Remove oldest
    }
}

/**
 * Checks if a message ID is tracked and belongs to the specified user.
 * @param {string} messageId 
 * @param {string} userId 
 * @returns {boolean}
 */
function isTrackedMessage(messageId, userId) {
    if (!messageId || !userId) return false;
    return trackedMessages.some(m => m.messageId === messageId && m.userId === userId);
}

/**
 * Removes a message from tracking (e.g. after it has been deleted).
 * @param {string} messageId 
 */
function removeTrackedMessage(messageId) {
    if (!messageId) return;
    const index = trackedMessages.findIndex(m => m.messageId === messageId);
    if (index !== -1) {
        trackedMessages.splice(index, 1);
    }
}

/**
 * Heuristically determines if a message is tied to the specified user.
 * @param {object} msg - The Discord message object.
 * @param {string} userId - The ID of the requesting user.
 * @param {string} username - The username of the requesting user.
 * @param {string} displayName - The display name of the requesting user.
 * @param {object} client - The Discord client instance.
 * @returns {Promise<boolean>}
 */
async function isMessageTiedToUser(msg, userId, username, displayName, client) {
    // 1. Check if tracked in-memory
    if (isTrackedMessage(msg.id, userId)) {
        return true;
    }

    // 2. Check if sent by the bot itself
    if (msg.author.id === client.user.id) {
        // If it's a reply (threaded/referenced) to a message sent by the user
        if (msg.reference && msg.reference.messageId) {
            try {
                const refMsg = await msg.channel.messages.fetch(msg.reference.messageId);
                if (refMsg && refMsg.author.id === userId) {
                    return true;
                }
            } catch (err) {
                // Referenced message might be deleted, continue to check other options
            }
        }

        // If the bot's message mentions the user
        if (msg.content.includes(`<@${userId}>`) || msg.content.includes(`<@!${userId}>`)) {
            return true;
        }

        // If it is a fallback repost or placeholder starting with the user's name prefix
        const cleanDisplayName = displayName || '';
        const cleanUsername = username || '';
        if ((cleanDisplayName && msg.content.startsWith(`**${cleanDisplayName}**:`)) ||
            (cleanUsername && msg.content.startsWith(`**${cleanUsername}**:`))) {
            return true;
        }
    }

    // 3. Check if sent by a webhook under the user's name
    if (msg.webhookId) {
        if (msg.author.username === displayName || msg.author.username === username) {
            return true;
        }
    }

    return false;
}

module.exports = {
    trackMessage,
    isTrackedMessage,
    removeTrackedMessage,
    isMessageTiedToUser
};
