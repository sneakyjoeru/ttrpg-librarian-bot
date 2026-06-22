// Tiny persistent state store for the system-updates thread.
//
// Persists the (threadId, updatesMessageId) pair across bot restarts so
// the ClientReady handler in index-librarian.js can find the existing
// thread on every restart, edit its first bot message in place, and
// re-apply the lock — without ever posting a new message.
//
// Writes are atomic (temp file + rename), same pattern as
// src/utils/quota.js, so a crash mid-write cannot corrupt the state.

const fs = require('fs');
const path = require('path');
const { SYSTEM_UPDATES_STATE_PATH } = require('../config');

let cachedState = null;
let writeChain = Promise.resolve();

function ensureDir() {
    const dir = path.dirname(SYSTEM_UPDATES_STATE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function loadFromDisk() {
    if (cachedState !== null) return cachedState;
    try {
        if (fs.existsSync(SYSTEM_UPDATES_STATE_PATH)) {
            const raw = fs.readFileSync(SYSTEM_UPDATES_STATE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            cachedState = (parsed && typeof parsed === 'object') ? parsed : {};
        } else {
            cachedState = {};
        }
    } catch (err) {
        console.warn(`[SystemState] Failed to load system state, starting fresh: ${err.message}`);
        cachedState = {};
    }
    return cachedState;
}

function persistToDisk() {
    writeChain = writeChain.then(() => new Promise((resolve) => {
        try {
            ensureDir();
            const tmp = `${SYSTEM_UPDATES_STATE_PATH}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(cachedState, null, 2), 'utf8');
            fs.renameSync(tmp, SYSTEM_UPDATES_STATE_PATH);
        } catch (err) {
            console.error(`[SystemState] Failed to persist system state: ${err.message}`);
        }
        resolve();
    }));
}

/**
 * Returns the saved thread id (or null when not set / the file is fresh).
 */
function getSystemUpdatesThreadId() {
    const s = loadFromDisk();
    return typeof s.systemUpdatesThreadId === 'string' && s.systemUpdatesThreadId
        ? s.systemUpdatesThreadId
        : null;
}

/**
 * Returns the saved updates-message id (or null). The "updates message" is
 * the bot's own first message inside the thread that contains the git log;
 * it's NOT the thread's OP (which is the system message itself).
 */
function getSystemUpdatesMessageId() {
    const s = loadFromDisk();
    return typeof s.systemUpdatesMessageId === 'string' && s.systemUpdatesMessageId
        ? s.systemUpdatesMessageId
        : null;
}

/**
 * Persists the (threadId, updatesMessageId) pair. Either or both may be
 * null to clear that field.
 */
function setSystemUpdatesIds({ threadId = null, updatesMessageId = null } = {}) {
    const s = loadFromDisk();
    s.systemUpdatesThreadId = threadId || null;
    s.systemUpdatesMessageId = updatesMessageId || null;
    persistToDisk();
}

/**
 * Clears the cached state (used by tests and by the index handler when
 * the on-disk state is known to be stale — e.g. the stored thread id
 * references a thread that no longer exists).
 */
function clearCache() {
    cachedState = null;
}

module.exports = {
    getSystemUpdatesThreadId,
    getSystemUpdatesMessageId,
    setSystemUpdatesIds,
    clearCache
};
