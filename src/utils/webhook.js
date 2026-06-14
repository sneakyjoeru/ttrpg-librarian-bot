const { trackMessage } = require('./messageTracker');
const { chunkAttachmentsBySize } = require('./mediaCompressor');

async function sendRepostedMessage(client, message, content, attachments, suppressEmbeds = false, fileLimitBytes = 0, fallbackContent = null) {
    const DISCORD_MAX_ATTACHMENTS = 10;
    const allFiles = attachments || [];

    // Split attachments: use size-aware chunking if a file limit is provided, otherwise by count of 10
    let fileChunks;
    if (fileLimitBytes > 0 && allFiles.length > 0) {
        fileChunks = chunkAttachmentsBySize(allFiles, fileLimitBytes);
        // Further split any chunk exceeding 10 items (Discord API limit)
        const refined = [];
        for (const chunk of fileChunks) {
            for (let i = 0; i < chunk.length; i += DISCORD_MAX_ATTACHMENTS) {
                refined.push(chunk.slice(i, i + DISCORD_MAX_ATTACHMENTS));
            }
        }
        fileChunks = refined;
    } else {
        fileChunks = [];
        for (let i = 0; i < allFiles.length; i += DISCORD_MAX_ATTACHMENTS) {
            fileChunks.push(allFiles.slice(i, i + DISCORD_MAX_ATTACHMENTS));
        }
    }
    // Ensure at least one chunk (even if empty) so the text message is sent
    if (fileChunks.length === 0) fileChunks.push([]);

    let reposted = false;
    if (message.guild) {
        try {
            const webhookChannel = message.channel.isThread() ? message.channel.parent : message.channel;
            if (webhookChannel && webhookChannel.fetchWebhooks) {
                const webhooks = await webhookChannel.fetchWebhooks();
                let webhook = webhooks.find(wh => wh.owner && wh.owner.id === client.user.id);
                if (!webhook) {
                    webhook = await webhookChannel.createWebhook({
                        name: 'Librarian Bot',
                        avatar: client.user.displayAvatarURL()
                    });
                }

                const username = message.member ? message.member.displayName : message.author.username;
                const avatarURL = message.author.displayAvatarURL({ forceStatic: true });
                const threadId = message.channel.isThread() ? message.channel.id : undefined;

                for (let i = 0; i < fileChunks.length; i++) {
                    const options = {
                        content: i === 0 ? (content || '') : '',
                        username,
                        avatarURL,
                        files: fileChunks[i],
                        wait: true
                    };
                    if (threadId) options.threadId = threadId;
                    if (suppressEmbeds) options.flags = 4; // SuppressEmbeds
                    const sentWebhookMsg = await webhook.send(options);
                    if (sentWebhookMsg) {
                        trackMessage(sentWebhookMsg.id, message.author.id, message.channel.id);
                    }
                }
                reposted = true;
            }
        } catch (err) {
            console.error('Failed to send webhook repost:', err);
        }
    }

    if (!reposted) {
        try {
            const displayName = message.member ? message.member.displayName : message.author.username;
            const prefix = `**${displayName}**: `;

            for (let i = 0; i < fileChunks.length; i++) {
                const msgContent = i === 0
                    ? (content ? `${prefix}${content}` : prefix)
                    : '';
                const sendOptions = {
                    content: msgContent.substring(0, 2000),
                    files: fileChunks[i]
                };
                if (suppressEmbeds) sendOptions.flags = 4; // SuppressEmbeds
                
                try {
                    const sentMsg = await message.channel.send(sendOptions);
                    if (sentMsg) {
                        trackMessage(sentMsg.id, message.author.id, message.channel.id);
                    }
                } catch (botErr) {
                    if (botErr.code === 40005) {
                        console.log('[Bot Fallback] File too large for bot. Sending text only.');
                        sendOptions.files = [];
                        sendOptions.flags = 0;
                        if (i === 0) {
                            if (fallbackContent) {
                                sendOptions.content = `${prefix}${fallbackContent}`.substring(0, 2000);
                            } else {
                                sendOptions.content = sendOptions.content.replace(/<(https?:\/\/[^>]+)>/g, '$1');
                            }
                            sendOptions.content += '\n\n*(Attachment removed: File too large)*';
                        }
                        const sentMsg = await message.channel.send(sendOptions);
                        if (sentMsg) {
                            trackMessage(sentMsg.id, message.author.id, message.channel.id);
                        }
                    } else {
                        throw botErr;
                    }
                }
            }
        } catch (sendErr) {
            console.error('Fallback send reposted message failed:', sendErr);
        }
    }
}

async function sendWorkingPlaceholder(client, message, originalUrl = '') {
    let reposted = false;
    let sentMsg = null;
    let isWebhook = false;
    let webhookClient = null;

    const contentText = `working... ${originalUrl ? `<${originalUrl}>` : ''}`;

    if (message.guild) {
        try {
            const webhookChannel = message.channel.isThread() ? message.channel.parent : message.channel;
            if (webhookChannel && webhookChannel.fetchWebhooks) {
                const webhooks = await webhookChannel.fetchWebhooks();
                let webhook = webhooks.find(wh => wh.owner && wh.owner.id === client.user.id);
                if (!webhook) {
                    webhook = await webhookChannel.createWebhook({
                        name: 'Librarian Bot',
                        avatar: client.user.displayAvatarURL()
                    });
                }

                const username = message.member ? message.member.displayName : message.author.username;
                const avatarURL = message.author.displayAvatarURL({ forceStatic: true });
                const threadId = message.channel.isThread() ? message.channel.id : undefined;

                const options = {
                    content: contentText,
                    username,
                    avatarURL,
                    wait: true,
                    flags: 4 // SuppressEmbeds
                };
                if (threadId) options.threadId = threadId;

                sentMsg = await webhook.send(options);
                isWebhook = true;
                webhookClient = webhook;
                reposted = true;
            }
        } catch (err) {
            console.error('Failed to send webhook working placeholder:', err);
        }
    }

    if (!reposted) {
        try {
            const displayName = message.member ? message.member.displayName : message.author.username;
            const prefix = `**${displayName}**: `;
            sentMsg = await message.channel.send({
                content: `${prefix}${contentText}`,
                flags: 4 // SuppressEmbeds
            });
            isWebhook = false;
        } catch (sendErr) {
            console.error('Fallback send working placeholder failed:', sendErr);
        }
    }

    if (sentMsg) {
        trackMessage(sentMsg.id, message.author.id, message.channel.id);
    }

    return { sentMsg, isWebhook, webhookClient, originalMessage: message };
}

async function updatePlaceholderStage(placeholder, content, suppressEmbeds = true) {
    const { sentMsg, isWebhook, webhookClient } = placeholder;
    if (!sentMsg) return;

    try {
        if (isWebhook && webhookClient) {
            const editOptions = {
                content: content || ''
            };
            if (suppressEmbeds) editOptions.flags = 4; // SuppressEmbeds
            const threadId = placeholder.originalMessage.channel.isThread() ? placeholder.originalMessage.channel.id : undefined;
            if (threadId) editOptions.threadId = threadId;

            await webhookClient.editMessage(sentMsg.id, editOptions);
        } else {
            const displayName = placeholder.originalMessage.member ? placeholder.originalMessage.member.displayName : placeholder.originalMessage.author.username;
            const prefix = `**${displayName}**: `;
            const cleanContent = content ? `${prefix}${content}` : prefix;

            const editOptions = {
                content: cleanContent.substring(0, 2000)
            };
            if (suppressEmbeds) editOptions.flags = 4;

            await sentMsg.edit(editOptions);
        }
    } catch (err) {
        console.error('Failed to update placeholder stage:', err);
    }
}


async function updateWorkingPlaceholder(placeholder, finalContent, attachments, suppressEmbeds = false, fileLimitBytes = 0, fallbackContent = null) {
    const { sentMsg, isWebhook, webhookClient } = placeholder;
    if (!sentMsg) return;

    if (!suppressEmbeds) {
        try {
            if (isWebhook && webhookClient) {
                const threadId = placeholder.originalMessage.channel.isThread() ? placeholder.originalMessage.channel.id : undefined;
                await webhookClient.deleteMessage(sentMsg.id, threadId).catch(() => {});
            } else {
                await sentMsg.delete().catch(() => {});
            }
        } catch (delErr) {
            console.error('Failed to delete working placeholder:', delErr);
        }

        await sendRepostedMessage(
            placeholder.originalMessage.client,
            placeholder.originalMessage,
            finalContent,
            attachments,
            false,
            fileLimitBytes,
            fallbackContent
        );
        return;
    }

    const DISCORD_MAX_ATTACHMENTS = 10;
    const allFiles = attachments || [];

    // Split attachments: use size-aware chunking if a file limit is provided
    let fileChunks;
    if (fileLimitBytes > 0 && allFiles.length > 0) {
        fileChunks = chunkAttachmentsBySize(allFiles, fileLimitBytes);
        const refined = [];
        for (const chunk of fileChunks) {
            for (let i = 0; i < chunk.length; i += DISCORD_MAX_ATTACHMENTS) {
                refined.push(chunk.slice(i, i + DISCORD_MAX_ATTACHMENTS));
            }
        }
        fileChunks = refined;
    } else {
        fileChunks = [];
        for (let i = 0; i < allFiles.length; i += DISCORD_MAX_ATTACHMENTS) {
            fileChunks.push(allFiles.slice(i, i + DISCORD_MAX_ATTACHMENTS));
        }
    }
    if (fileChunks.length === 0) fileChunks.push([]);

    try {
        if (isWebhook && webhookClient) {
            const editOptions = {
                content: finalContent || '',
                files: fileChunks[0]
            };
            if (suppressEmbeds) {
                editOptions.flags = 4; // SuppressEmbeds
            } else {
                editOptions.flags = 0; // Clear SuppressEmbeds flag to show embeds
            }
            const threadId = placeholder.originalMessage.channel.isThread() ? placeholder.originalMessage.channel.id : undefined;
            if (threadId) editOptions.threadId = threadId;

            try {
                await webhookClient.editMessage(sentMsg.id, editOptions);

                // Send remaining chunks as new messages
                for (let i = 1; i < fileChunks.length; i++) {
                    const sendOptions = {
                        content: '',
                        username: sentMsg.author.username,
                        avatarURL: sentMsg.author.displayAvatarURL(),
                        files: fileChunks[i]
                    };
                    if (threadId) sendOptions.threadId = threadId;
                    if (suppressEmbeds) sendOptions.flags = 4;
                    await webhookClient.send(sendOptions);
                }
            } catch (err) {
                if (err.code === 40005) {
                    console.log('[Webhook] File too large for webhook. Falling back to bot message.');
                    await webhookClient.deleteMessage(sentMsg.id, threadId).catch(() => {});
                    
                    const displayName = placeholder.originalMessage.member ? placeholder.originalMessage.member.displayName : placeholder.originalMessage.author.username;
                    const prefix = `**${displayName}**: `;
                    const cleanContent = finalContent ? `${prefix}${finalContent}` : prefix;
                    
                    for (let i = 0; i < fileChunks.length; i++) {
                        const sendOptions = {
                            content: i === 0 ? cleanContent.substring(0, 2000) : '',
                            files: fileChunks[i]
                        };
                        if (suppressEmbeds) sendOptions.flags = 4;
                        
                        try {
                            await placeholder.originalMessage.channel.send(sendOptions);
                        } catch (botErr) {
                            if (botErr.code === 40005) {
                                console.log('[Bot Fallback] File also too large for bot. Sending text only.');
                                sendOptions.files = [];
                                sendOptions.flags = 0;
                                if (i === 0) {
                                    if (fallbackContent) {
                                        sendOptions.content = `${prefix}${fallbackContent}`.substring(0, 2000);
                                    } else {
                                        sendOptions.content = sendOptions.content.replace(/<(https?:\/\/[^>]+)>/g, '$1');
                                    }
                                    sendOptions.content += '\n\n*(Attachment removed: File too large)*';
                                }
                                await placeholder.originalMessage.channel.send(sendOptions);
                            } else {
                                throw botErr;
                            }
                        }
                    }
                } else {
                    throw err;
                }
            }
        } else {
            const displayName = placeholder.originalMessage.member ? placeholder.originalMessage.member.displayName : placeholder.originalMessage.author.username;
            const prefix = `**${displayName}**: `;
            const cleanContent = finalContent ? `${prefix}${finalContent}` : prefix;

            const editOptions = {
                content: cleanContent.substring(0, 2000),
                files: fileChunks[0]
            };
            if (suppressEmbeds) {
                editOptions.flags = 4;
            } else {
                editOptions.flags = 0; // Clear SuppressEmbeds flag to show embeds
            }

            try {
                await sentMsg.edit(editOptions);

                // Send remaining chunks as new messages
                for (let i = 1; i < fileChunks.length; i++) {
                    const sendOptions = {
                        content: '',
                        files: fileChunks[i]
                    };
                    if (suppressEmbeds) sendOptions.flags = 4;
                    
                    try {
                        await placeholder.originalMessage.channel.send(sendOptions);
                    } catch (botErr) {
                        if (botErr.code === 40005) {
                            console.log('[Bot] File too large for bot send. Sending text only.');
                            sendOptions.files = [];
                            sendOptions.flags = 0;
                            await placeholder.originalMessage.channel.send(sendOptions);
                        } else {
                            throw botErr;
                        }
                    }
                }
            } catch (err) {
                if (err.code === 40005) {
                    console.log('[Bot] File too large for bot edit. Sending text only.');
                    editOptions.files = [];
                    editOptions.flags = 0;
                    if (editOptions.content) {
                        if (fallbackContent) {
                            editOptions.content = `${prefix}${fallbackContent}`.substring(0, 2000);
                        } else {
                            editOptions.content = editOptions.content.replace(/<(https?:\/\/[^>]+)>/g, '$1');
                        }
                        editOptions.content += '\n\n*(Attachment removed: File too large)*';
                    }
                    await sentMsg.edit(editOptions);
                } else {
                    throw err;
                }
            }
        }
    } catch (err) {
        console.error('Failed to edit/update working placeholder:', err);
    }
}

module.exports = {
    sendRepostedMessage,
    sendWorkingPlaceholder,
    updateWorkingPlaceholder,
    updatePlaceholderStage,
    chunkAttachmentsBySize
};
