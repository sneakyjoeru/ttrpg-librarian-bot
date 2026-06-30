const { trackMessage } = require('./messageTracker');
const { chunkAttachmentsBySize } = require('./mediaCompressor');

// === In-progress status helpers (mirrors robot-joe's webhook.js) ===
// The ⏳ indicator is appended to working placeholder messages so the startup
// cleanup scan can find abandoned placeholders (bot killed mid-process) and
// resume them. Without it, a killed bot leaves "working... <url>" stuck forever.
const IN_PROGRESS_STATUS = ' ⏳';
const IN_PROGRESS_REGEX = / ⏳$/;

function addInProgressStatus(content) {
    if (!content) return IN_PROGRESS_STATUS.trim() + ' ';
    const trimmed = content.trimEnd();
    if (IN_PROGRESS_REGEX.test(trimmed)) return content;
    return trimmed + IN_PROGRESS_STATUS;
}

function removeInProgressStatus(content) {
    if (!content) return content;
    return content.replace(IN_PROGRESS_REGEX, '').trimEnd();
}

function extractPlaceholderBaseContent(content) {
    if (!content) return '';
    let text = removeInProgressStatus(content);
    // Strip the `working... <url>` prefix that the bot prepends to placeholders.
    // Matches `working...` optionally followed by a wrapped/unwraped URL + newline.
    text = text.replace(/^working\.\.\.\s*(?:<[^>]*>)?\s*\n?/i, '');
    // Strip stale `[PRIVATE VIDEO, ACCESS ONLY VIA LINK]` markers left by a
    // previous restricted-fallback run (catch-up reuses the old placeholder text
    // as remadeContent, so this marker would otherwise pollute the repost).
    text = text.replace(/\[PRIVATE VIDEO, ACCESS ONLY VIA LINK\]\s*/gi, '');
    // Strip the `stage:` portion (and everything after it).
    text = text.replace(/(?:^|\n)stage:[\s\S]*$/i, '');
    return text.trimEnd();
}

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

    const contentText = addInProgressStatus(`working... ${originalUrl ? `<${originalUrl}>` : ''}`);

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

    // Keep the ⏳ indicator on stage updates so the startup cleanup scan can
    // find abandoned placeholders even after stage updates (the scan looks
    // for ⏳ to identify messages that were interrupted mid-process).
    const contentWithStatus = addInProgressStatus(content || '');

    try {
        if (isWebhook && webhookClient) {
            const editOptions = {
                content: contentWithStatus
            };
            if (suppressEmbeds) editOptions.flags = 4; // SuppressEmbeds
            const threadId = placeholder.originalMessage.channel.isThread() ? placeholder.originalMessage.channel.id : undefined;
            if (threadId) editOptions.threadId = threadId;

            await webhookClient.editMessage(sentMsg.id, editOptions);
        } else {
            const displayName = placeholder.originalMessage.member ? placeholder.originalMessage.member.displayName : placeholder.originalMessage.author.username;
            const prefix = `**${displayName}**: `;
            const cleanContent = contentWithStatus ? `${prefix}${contentWithStatus}` : prefix;

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

    // Strip the ⏳ indicator from the final content — the final message should
    // never show the in-progress indicator.
    const cleanFinalContent = removeInProgressStatus(finalContent || '');

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
            cleanFinalContent,
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
                content: cleanFinalContent || '',
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
                    const cleanContent = cleanFinalContent ? `${prefix}${cleanFinalContent}` : prefix;
                    
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
            const cleanContent = cleanFinalContent ? `${prefix}${cleanFinalContent}` : prefix;

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

// Finalize a placeholder by editing its TEXT ONLY (preserving any attachments
// already on the message) and removing the ⏳ in-progress indicator.
async function finalizePlaceholderClean(placeholder, content, suppressEmbeds = true) {
    const { sentMsg, isWebhook, webhookClient } = placeholder;
    if (!sentMsg) return;
    try {
        const cleanContent = removeInProgressStatus(content || '');
        if (isWebhook && webhookClient) {
            const editOptions = { content: cleanContent || '' };
            if (suppressEmbeds) editOptions.flags = 4;
            const threadId = placeholder.originalMessage.channel && placeholder.originalMessage.channel.isThread() ? placeholder.originalMessage.channel.id : undefined;
            if (threadId) editOptions.threadId = threadId;
            await webhookClient.editMessage(sentMsg.id, editOptions);
        } else {
            const displayName = placeholder.originalMessage.member ? placeholder.originalMessage.member.displayName : (placeholder.originalMessage.author ? placeholder.originalMessage.author.username : 'Unknown');
            const prefix = `**${displayName}**: `;
            const editOptions = { content: cleanContent ? `${prefix}${cleanContent}`.substring(0, 2000) : `${prefix}`.substring(0, 2000) };
            if (suppressEmbeds) editOptions.flags = 4;
            await sentMsg.edit(editOptions);
        }
    } catch (err) {
        console.error('Failed to finalize placeholder clean:', err.message);
    }
}

// Build a placeholder recovery object from an existing bot/webhook message that
// still shows the ⏳ indicator (abandoned placeholder from a killed process).
async function buildRecoveredPlaceholder(client, existingMessage) {
    const baseText = extractPlaceholderBaseContent(existingMessage.content || '');
    const placeholder = {
        sentMsg: existingMessage,
        isWebhook: !!existingMessage.webhookId,
        webhookClient: null,
        originalMessage: existingMessage,
        baseText
    };
    if (placeholder.isWebhook) {
        try {
            const webhookChannel = existingMessage.channel.isThread() ? existingMessage.channel.parent : existingMessage.channel;
            const webhooks = await webhookChannel.fetchWebhooks();
            placeholder.webhookClient = webhooks.find(wh => wh.owner && wh.owner.id === client.user.id) || null;
        } catch (err) {
            console.warn('[Webhook] Could not re-fetch webhook for recovered placeholder:', err.message);
        }
    }
    return placeholder;
}

module.exports = {
    sendRepostedMessage,
    sendWorkingPlaceholder,
    updateWorkingPlaceholder,
    updatePlaceholderStage,
    chunkAttachmentsBySize,
    finalizePlaceholderClean,
    buildRecoveredPlaceholder,
    addInProgressStatus,
    removeInProgressStatus,
    extractPlaceholderBaseContent,
    IN_PROGRESS_STATUS,
    IN_PROGRESS_REGEX
};
