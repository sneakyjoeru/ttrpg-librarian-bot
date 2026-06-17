// === taskPersistence: persistent task queue for crash recovery ===
//
// The bot uses this module to track in-flight work that may be interrupted by
// a restart (e.g. an Instagram/Facebook download that takes 30+ seconds to
// resolve). On boot, recoverOrphanedPlaceholders() walks the persisted queue
// and re-dispatches the original user message through the matching handler
// so the user-visible result is delivered as if the bot never crashed.
//
// Persisted file: data/pending_tasks.json
// Temp file prefixes: insta_, fb_, ffcomp_, vid_sub_, meta_, sub_

const fs = require('fs');
const path = require('path');
const os = require('os');

const PENDING_TASKS_PATH = path.join(__dirname, '../../data/pending_tasks.json');
const TEMP_FILE_PREFIXES = ['insta_', 'fb_', 'ffcomp_', 'vid_sub_', 'meta_', 'sub_'];

function ensureDataDir() {
    const dataDir = path.dirname(PENDING_TASKS_PATH);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }
}

function loadPendingTasks() {
    try {
        ensureDataDir();
        if (fs.existsSync(PENDING_TASKS_PATH)) {
            const data = JSON.parse(fs.readFileSync(PENDING_TASKS_PATH, 'utf8'));
            if (Array.isArray(data)) return data;
        }
    } catch (e) {
        console.error('[TaskPersistence] Failed to load pending tasks:', e.message);
    }
    return [];
}

function savePendingTasks(tasks) {
    try {
        ensureDataDir();
        fs.writeFileSync(PENDING_TASKS_PATH, JSON.stringify(tasks, null, 2), 'utf8');
    } catch (e) {
        console.error('[TaskPersistence] Failed to save pending tasks:', e.message);
    }
}

function addPendingTask(task) {
    const tasks = loadPendingTasks();
    task.createdAt = Date.now();
    tasks.push(task);
    savePendingTasks(tasks);
    return task;
}

function removePendingTask(taskId) {
    let tasks = loadPendingTasks();
    tasks = tasks.filter(t => t.id !== taskId);
    savePendingTasks(tasks);
}

function updatePendingTask(taskId, updates) {
    const tasks = loadPendingTasks();
    const task = tasks.find(t => t.id === taskId);
    if (task) {
        Object.assign(task, updates);
        savePendingTasks(tasks);
    }
}

function generateTaskId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function cleanOrphanedTempFiles() {
    const tempDir = os.tmpdir();
    let cleaned = 0;
    try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
            const matchesPrefix = TEMP_FILE_PREFIXES.some(prefix => file.startsWith(prefix));
            if (matchesPrefix) {
                const filePath = path.join(tempDir, file);
                try {
                    const stat = fs.statSync(filePath);
                    const ageMs = Date.now() - stat.mtimeMs;
                    if (ageMs > 10 * 60 * 1000) {
                        fs.unlinkSync(filePath);
                        cleaned++;
                    }
                } catch (_) {}
            }
        }
    } catch (e) {
        console.error('[TaskPersistence] Failed to clean temp files:', e.message);
    }
    if (cleaned > 0) {
        console.log(`[TaskPersistence] Cleaned ${cleaned} orphaned temp files.`);
    }
    return cleaned;
}

async function recoverOrphanedPlaceholders(client) {
    const tasks = loadPendingTasks();
    if (tasks.length === 0) {
        console.log('[TaskPersistence] No pending tasks to recover.');
        return;
    }

    console.log(`[TaskPersistence] Found ${tasks.length} pending tasks from previous session. Re-dispatching interrupted work...`);

    // Try to fetch the main guild using the bot's configured SERVER_ID. Falling back
    // to env var (MAIN_GUILD_ID) keeps the behaviour aligned with robot-joe.
    const { SERVER_ID, MAIN_GUILD_ID } = require('../config');
    const guildId = SERVER_ID || MAIN_GUILD_ID || process.env.MAIN_GUILD_ID;
    const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
    if (!guild) {
        console.warn('[TaskPersistence] Could not fetch guild for recovery.');
        // Keep tasks in the queue so the next restart can try again.
        return;
    }

    let recovered = 0;
    let failed = 0;
    let skipped = 0;

    // Lazy-load the handlers we need to re-dispatch through. Requiring them inside
    // the function keeps this module loadable from contexts that don't have the
    // handlers (e.g. unit tests).
    const { handleMessageCreate } = require('../handlers/messageCreate');
    const { handleInstagramMessage } = require('../handlers/instagramHandler');
    const { handleFacebookMessage } = require('../handlers/facebookHandler');
    const { startJob } = require('./jobLog');

    // Helper: fetch the original user message so we can re-run the handler.
    async function fetchOriginal(task) {
        if (!task.channelId || !task.originalMessageId) return null;
        const channel = await client.channels.fetch(task.channelId).catch(() => null);
        if (!channel) return null;
        const msg = await channel.messages.fetch(task.originalMessageId).catch(() => null);
        return msg || null;
    }

    for (const task of tasks) {
        try {
            // 1) Always remove the "⏳" / "working..." / "stage:" placeholders from the
            //    previous session, since we'll be posting a fresh result. We edit them
            //    to "interrupted" first so the user sees what happened, then delete
            //    after a short delay.
            const placeholderIds = [
                task.placeholderMessageId,
                task.progressMessageId,
                task.statusMessageId
            ].filter(Boolean);

            if (placeholderIds.length > 0 && task.channelId) {
                const channel = await client.channels.fetch(task.channelId).catch(() => null);
                if (channel) {
                    for (const msgId of placeholderIds) {
                        const m = await channel.messages.fetch(msgId).catch(() => null);
                        if (m && m.author.id === client.user.id) {
                            const txt = m.content || '';
                            const isStaleInProgress = txt.includes('⏳') || txt.includes('working...') || txt.includes('stage:') || txt.includes('Запуск') || txt.includes('...');
                            if (isStaleInProgress) {
                                await m.edit('❌ *[Обработка прервана — бот перезагружался. Перезапускаю...]*').catch(() => {});
                                setTimeout(() => { m.delete().catch(() => {}); }, 5000);
                            }
                        }
                    }
                }
            }

            // 2) Re-dispatch the work via the original user message.
            const originalMsg = await fetchOriginal(task);
            if (!originalMsg) {
                console.warn(`[TaskPersistence] Cannot re-dispatch ${task.type} task ${task.id}: original message ${task.originalMessageId} in channel ${task.channelId} is no longer available. Skipping.`);
                removePendingTask(task.id);
                skipped++;
                continue;
            }

            // Mark a job for the recovered work so logs make it easy to track.
            const job = startJob({
                id: originalMsg.id,
                channelId: originalMsg.channel.id,
                author: originalMsg.author,
                content: originalMsg.cleanContent || originalMsg.content || ''
            }, `recover:${task.type}`);

            // Clear this task from the queue *before* re-running, so the new
            // handler can register its own addPendingTask() call without colliding
            // with the old entry.
            removePendingTask(task.id);

            // Fire-and-forget re-dispatch; we don't await to keep recovery fast.
            (async () => {
                try {
                    switch (task.type) {
                        case 'instagram':
                            await handleInstagramMessage(client, originalMsg);
                            job.success({ stage: 'instagram_repost', recovered: true });
                            break;
                        case 'facebook':
                            await handleFacebookMessage(client, originalMsg);
                            job.success({ stage: 'facebook_repost', recovered: true });
                            break;
                        case 'llm_query':
                        case 'ocr_upload':
                        case 'ocr_background':
                        default:
                            await handleMessageCreate(client, originalMsg);
                            job.success({ stage: 'message_dispatch', recovered: true });
                            break;
                    }
                } catch (err) {
                    console.error(`[TaskPersistence] Re-dispatch of ${task.type} task ${task.id} failed:`, err.message);
                    job.failure(err.message, { stage: task.type, recovered: true });
                }
            })();

            recovered++;
        } catch (taskErr) {
            console.error(`[TaskPersistence] Error recovering task ${task.id}:`, taskErr.message);
            failed++;
            // Remove the task so a future restart doesn't keep retrying the same broken one.
            removePendingTask(task.id);
        }
    }

    // Persist whatever's left (e.g. tasks we couldn't re-dispatch because the
    // original message was gone should already have been removed above; this is
    // a safety net so a future restart can retry the leftovers).
    const remaining = loadPendingTasks();
    if (remaining.length === 0) {
        savePendingTasks([]);
    } else {
        console.warn(`[TaskPersistence] ${remaining.length} tasks remain in queue after recovery (will be retried next restart).`);
    }

    console.log(`[TaskPersistence] Recovery complete. Re-dispatched: ${recovered}, failed: ${failed}, skipped: ${skipped}.`);
    return { recovered, failed, skipped };
}

module.exports = {
    addPendingTask,
    removePendingTask,
    updatePendingTask,
    loadPendingTasks,
    savePendingTasks,
    generateTaskId,
    cleanOrphanedTempFiles,
    recoverOrphanedPlaceholders
};
