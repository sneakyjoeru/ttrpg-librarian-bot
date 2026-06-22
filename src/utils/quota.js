// Per-user, sliding-window DeepSeek quota tracker.
//
// While a user has quota remaining, RAG queries are routed to DeepSeek first
// (faster, better quality). When the quota is exhausted the bot falls back to
// its local Ollama-first pipeline.
//
// State is persisted to disk so quota survives bot restarts. Concurrent access
// is handled by an in-process mutex; writes are atomic (write to temp file +
// rename) so a crash mid-write cannot corrupt the store.

const fs = require('fs');
const path = require('path');
const {
    QUOTA_MAX_REQUESTS,
    QUOTA_WINDOW_HOURS,
    QUOTA_STATE_PATH
} = require('../config');

const WINDOW_MS = QUOTA_WINDOW_HOURS * 60 * 60 * 1000;

// In-memory cache, hydrated from disk on first access.
let store = null;

// Serialise load/save to avoid interleaved writes.
let writeChain = Promise.resolve();

function loadFromDisk() {
    if (store !== null) return store;
    try {
        if (fs.existsSync(QUOTA_STATE_PATH)) {
            const raw = fs.readFileSync(QUOTA_STATE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            store = (parsed && typeof parsed === 'object') ? parsed : {};
        } else {
            store = {};
        }
    } catch (err) {
        console.warn(`[Quota] Failed to load quota state, starting fresh: ${err.message}`);
        store = {};
    }
    return store;
}

function persistToDisk() {
    // Queue the write so concurrent calls don't clobber each other.
    writeChain = writeChain.then(() => new Promise((resolve) => {
        try {
            const dir = path.dirname(QUOTA_STATE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmp = `${QUOTA_STATE_PATH}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
            fs.renameSync(tmp, QUOTA_STATE_PATH);
        } catch (err) {
            console.error(`[Quota] Failed to persist quota state: ${err.message}`);
        }
        resolve();
    }));
}

/**
 * Prunes timestamps older than the sliding window for the given user.
 * Mutates the in-memory entry in-place.
 */
function prune(userId, now) {
    const entries = store[userId];
    if (!Array.isArray(entries) || entries.length === 0) return entries || [];
    const cutoff = now - WINDOW_MS;
    let writeIdx = 0;
    for (let readIdx = 0; readIdx < entries.length; readIdx++) {
        if (entries[readIdx] >= cutoff) {
            entries[writeIdx++] = entries[readIdx];
        }
    }
    entries.length = writeIdx;
    return entries;
}

/**
 * Returns the current usage snapshot for the user WITHOUT consuming a slot.
 * @returns {{ used: number, remaining: number, limit: number, windowHours: number, resetAt: number | null }}
 */
function getUsage(userId) {
    loadFromDisk();
    const now = Date.now();
    const entries = prune(userId || '', now);
    const used = entries.length;
    const remaining = Math.max(0, QUOTA_MAX_REQUESTS - used);
    const resetAt = entries.length > 0
        ? entries[0] + WINDOW_MS
        : null;
    return {
        used,
        remaining,
        limit: QUOTA_MAX_REQUESTS,
        windowHours: QUOTA_WINDOW_HOURS,
        resetAt
    };
}

/**
 * Attempts to consume one quota slot for the user.
 *
 * - If the user is under the limit, a slot is consumed and the function resolves
 *   to `{ allowed: true, ...usage }` reflecting the post-consume state.
 * - If the user is at the limit, no slot is consumed and the function resolves
 *   to `{ allowed: false, ...usage }` so the caller can fall back to Ollama.
 *
 * The check-and-consume is performed against the in-memory store and the
 * mutation is persisted asynchronously; if persistence fails the in-memory
 * state still applies for the lifetime of the process.
 *
 * @param {string} userId
 * @returns {{ allowed: boolean, used: number, remaining: number, limit: number, windowHours: number, resetAt: number | null }}
 */
function consumeQuota(userId) {
    loadFromDisk();
    if (!userId) {
        // Without a user id we cannot track quota — refuse to consume and let
        // the caller fall back to local Ollama (the safer default).
        return {
            allowed: false,
            used: 0,
            remaining: 0,
            limit: QUOTA_MAX_REQUESTS,
            windowHours: QUOTA_WINDOW_HOURS,
            resetAt: null
        };
    }

    const now = Date.now();
    const entries = prune(userId, now);

    if (entries.length >= QUOTA_MAX_REQUESTS) {
        const resetAt = entries[0] + WINDOW_MS;
        return {
            allowed: false,
            used: entries.length,
            remaining: 0,
            limit: QUOTA_MAX_REQUESTS,
            windowHours: QUOTA_WINDOW_HOURS,
            resetAt
        };
    }

    entries.push(now);
    store[userId] = entries;
    persistToDisk();

    return {
        allowed: true,
        used: entries.length,
        remaining: Math.max(0, QUOTA_MAX_REQUESTS - entries.length),
        limit: QUOTA_MAX_REQUESTS,
        windowHours: QUOTA_WINDOW_HOURS,
        resetAt: entries[0] + WINDOW_MS
    };
}

/**
 * Formats a millisecond timestamp as a short human-readable relative duration
 * (e.g. "1h 23m" or "12m"). Used by the bot to tell users when their quota
 * will refresh.
 */
function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '0m';
    const totalMinutes = Math.ceil(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    return `${minutes}m`;
}

module.exports = {
    consumeQuota,
    getUsage,
    formatDuration
};