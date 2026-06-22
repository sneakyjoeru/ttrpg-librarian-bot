// Per-user, sliding-window DeepSeek quota tracker.
//
// While a user has quota remaining, RAG queries are routed to DeepSeek first
// (faster, better quality). When the quota is exhausted the bot falls back to
// its local Ollama-first pipeline.
//
// Two tiers are tracked per user, in independent buckets:
//   * "regular" — QUOTA_MAX_REQUESTS requests per QUOTA_WINDOW_HOURS
//   * "admin"   — QUOTA_ADMIN_MAX_REQUESTS requests per QUOTA_ADMIN_WINDOW_HOURS
//
// Admins (DM_ROLE_ID or guild Administrator) consume from the admin bucket;
// everyone else consumes from the regular bucket. Because the buckets are
// independent, a regular request never decrements an admin's quota and
// vice versa.
//
// State is persisted to disk so quota survives bot restarts. Concurrent
// access is handled by an in-process mutex; writes are atomic (write to
// temp file + rename) so a crash mid-write cannot corrupt the store.
//
// On-disk shape (per user):
//   { "regular": [epochMs, ...], "admin": [epochMs, ...] }
//
// Legacy single-array shape (`{ "<userId>": [epochMs, ...] }`) is read and
// migrated to the bucket shape on first load.

const fs = require('fs');
const path = require('path');
const {
    QUOTA_MAX_REQUESTS,
    QUOTA_WINDOW_HOURS,
    QUOTA_ADMIN_MAX_REQUESTS,
    QUOTA_ADMIN_WINDOW_HOURS,
    QUOTA_STATE_PATH
} = require('../config');

const REGULAR_WINDOW_MS = QUOTA_WINDOW_HOURS * 60 * 60 * 1000;
const ADMIN_WINDOW_MS = QUOTA_ADMIN_WINDOW_HOURS * 60 * 60 * 1000;

// In-memory cache, hydrated from disk on first access.
let store = null;

// Serialise load/save to avoid interleaved writes.
let writeChain = Promise.resolve();

/**
 * Picks the bucket + (limit, window) tuple for the given tier.
 * @param {boolean} isAdmin
 */
function tierFor(isAdmin) {
    if (isAdmin) {
        return {
            bucket: 'admin',
            limit: QUOTA_ADMIN_MAX_REQUESTS,
            windowMs: ADMIN_WINDOW_MS,
            windowHours: QUOTA_ADMIN_WINDOW_HOURS
        };
    }
    return {
        bucket: 'regular',
        limit: QUOTA_MAX_REQUESTS,
        windowMs: REGULAR_WINDOW_MS,
        windowHours: QUOTA_WINDOW_HOURS
    };
}

/**
 * Normalises an in-memory user entry into the { regular, admin } bucket
 * shape. Mutates the supplied object in place and also returns it.
 * - null/undefined  -> empty buckets
 * - flat array      -> treated as the regular bucket (legacy migration)
 * - { regular, admin } -> validated; missing keys get []
 */
function normaliseEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return { regular: [], admin: [] };
    }
    // Legacy flat array (v1 quota store): wrap as the regular bucket.
    if (Array.isArray(entry)) {
        return { regular: entry.filter(t => Number.isFinite(t)), admin: [] };
    }
    const regular = Array.isArray(entry.regular) ? entry.regular.filter(t => Number.isFinite(t)) : [];
    const admin = Array.isArray(entry.admin) ? entry.admin.filter(t => Number.isFinite(t)) : [];
    return { regular, admin };
}

function loadFromDisk() {
    if (store !== null) return store;
    try {
        if (fs.existsSync(QUOTA_STATE_PATH)) {
            const raw = fs.readFileSync(QUOTA_STATE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                // Normalise every top-level entry so the in-memory shape is
                // always the { regular, admin } buckets.
                for (const userId of Object.keys(parsed)) {
                    parsed[userId] = normaliseEntry(parsed[userId]);
                }
                store = parsed;
            } else {
                store = {};
            }
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
 * Prunes timestamps older than the given window out of the supplied bucket.
 * Mutates the array in place and returns it.
 */
function pruneBucket(bucket, now, windowMs) {
    if (!Array.isArray(bucket) || bucket.length === 0) return bucket || [];
    const cutoff = now - windowMs;
    let writeIdx = 0;
    for (let readIdx = 0; readIdx < bucket.length; readIdx++) {
        if (bucket[readIdx] >= cutoff) {
            bucket[writeIdx++] = bucket[readIdx];
        }
    }
    bucket.length = writeIdx;
    return bucket;
}

/**
 * Returns the current usage snapshot for the user (regular bucket) WITHOUT
 * consuming a slot. Kept for backward compatibility with any external
 * caller; the new code should prefer the `profile`-aware variant.
 */
function getUsage(userId) {
    return getUsageFor(userId, false);
}

/**
 * Returns the current usage snapshot for the given tier.
 * @param {string} userId
 * @param {boolean} isAdmin
 * @returns {{ profile: 'admin'|'regular', used: number, remaining: number, limit: number, windowHours: number, resetAt: number|null }}
 */
function getUsageFor(userId, isAdmin) {
    loadFromDisk();
    const tier = tierFor(isAdmin);
    const now = Date.now();
    if (!userId) {
        return {
            profile: tier.bucket,
            used: 0,
            remaining: tier.limit,
            limit: tier.limit,
            windowHours: tier.windowHours,
            resetAt: null
        };
    }
    const entry = normaliseEntry(store[userId]);
    store[userId] = entry;
    const bucket = pruneBucket(entry[tier.bucket], now, tier.windowMs);
    const used = bucket.length;
    const resetAt = bucket.length > 0 ? bucket[0] + tier.windowMs : null;
    return {
        profile: tier.bucket,
        used,
        remaining: Math.max(0, tier.limit - used),
        limit: tier.limit,
        windowHours: tier.windowHours,
        resetAt
    };
}

/**
 * Attempts to consume one quota slot for the user.
 *
 * - If the user is under the limit for their tier, a slot is consumed and
 *   the function returns `{ allowed: true, profile, ...usage }` reflecting
 *   the post-consume state.
 * - If the user is at the limit, no slot is consumed and the function
 *   returns `{ allowed: false, ...usage }` so the caller can fall back to
 *   local Ollama.
 *
 * The check-and-consume is performed against the in-memory store; the
 * mutation is persisted asynchronously. If persistence fails the in-memory
 * state still applies for the lifetime of the process.
 *
 * @param {string} userId
 * @param {boolean} [isAdmin=false] Whether the user qualifies for the
 *   admin tier (DM_ROLE_ID or guild Administrator).
 * @returns {{ allowed: boolean, profile: 'admin'|'regular', used: number, remaining: number, limit: number, windowHours: number, resetAt: number|null }}
 */
function consumeQuota(userId, isAdmin = false) {
    loadFromDisk();
    const tier = tierFor(!!isAdmin);

    if (!userId) {
        // Without a user id we cannot track quota — refuse to consume and
        // let the caller fall back to local Ollama (the safer default).
        return {
            allowed: false,
            profile: tier.bucket,
            used: 0,
            remaining: 0,
            limit: tier.limit,
            windowHours: tier.windowHours,
            resetAt: null
        };
    }

    const entry = normaliseEntry(store[userId]);
    store[userId] = entry;
    const now = Date.now();
    const bucket = pruneBucket(entry[tier.bucket], now, tier.windowMs);

    if (bucket.length >= tier.limit) {
        const resetAt = bucket[0] + tier.windowMs;
        return {
            allowed: false,
            profile: tier.bucket,
            used: bucket.length,
            remaining: 0,
            limit: tier.limit,
            windowHours: tier.windowHours,
            resetAt
        };
    }

    bucket.push(now);
    persistToDisk();

    return {
        allowed: true,
        profile: tier.bucket,
        used: bucket.length,
        remaining: Math.max(0, tier.limit - bucket.length),
        limit: tier.limit,
        windowHours: tier.windowHours,
        resetAt: bucket[0] + tier.windowMs
    };
}

/**
 * Formats a millisecond timestamp as a short human-readable relative
 * duration (e.g. "1h 23m" or "12m"). Used by the bot to tell users when
 * their quota will refresh.
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

/**
 * Forces a fresh detection (used by tests / for invalidating the cache
 * when the device landscape changes mid-process).
 */
function clearCache() {
    store = null;
}

module.exports = {
    consumeQuota,
    getUsage,
    getUsageFor,
    formatDuration,
    clearCache
};
