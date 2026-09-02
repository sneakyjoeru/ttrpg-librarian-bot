// knowledgeSync.js (librarian port — see discord-joe for the original)
//
// Populates streamer-joe's knowledge base (chat profiles + user_chat_history —
// the store the voice bot's chatter topics, persona knowledge and /lookup draw
// on) with Discord messages from the librarian guild.
//
// Gated by the `knowledge_population` Discord feature toggle (streamer-joe
// dashboard → Connections → Discord). OFF by default — nothing is pushed
// unless the operator opts in.
//
// Mechanics: every KNOWLEDGE_SYNC_INTERVAL_MS (default 15 min) the service
// walks the main guild's readable text channels, fetches messages newer than
// the per-channel cursor, and POSTs them in batches to streamer-joe's existing
// bulk-ingestion endpoint (POST /api/profiles/bulk, X-Service-Key authed via
// the shared TLS-aware transport). Cursors persist in
// ./data/knowledge-sync.json so restarts never re-send. On the very first run
// per channel only the last FIRST_RUN_BACKFILL messages are taken — the
// 3-day/extended catch-up semantics do not apply here.

const fs = require('fs');
const path = require('path');
const { SERVER_ID } = require('../config');
const { streamerJoeRequest, isDiscordFeatureEnabled } = require('./streamerJoe');

const STATE_PATH = path.join(process.cwd(), 'data', 'knowledge-sync.json');
const INTERVAL_MS = parseInt(process.env.KNOWLEDGE_SYNC_INTERVAL_MS || '900000', 10); // 15 min
const FIRST_RUN_BACKFILL = parseInt(process.env.KNOWLEDGE_SYNC_FIRST_BACKFILL || '100', 10);
const MAX_PER_CHANNEL_PER_TICK = 300;   // stay well under the 5000/batch API cap
const BATCH_LIMIT = 4500;

let _client = null;
let _timer = null;
let _running = false;
let _state = null; // { channels: { <id>: lastMessageId } }

function _loadState() {
    if (_state) return _state;
    try {
        _state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (_) {
        _state = { channels: {} };
    }
    if (!_state.channels) _state.channels = {};
    return _state;
}

function _saveState() {
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(STATE_PATH, JSON.stringify(_state, null, 1));
    } catch (err) {
        console.warn('[KnowledgeSync] Failed to persist state:', err.message);
    }
}

async function _collectChannel(channel, state) {
    const lastId = state.channels[channel.id];
    const out = [];
    let fetchOpts;
    if (lastId) {
        fetchOpts = { limit: 100, after: lastId };
    } else {
        fetchOpts = { limit: Math.min(FIRST_RUN_BACKFILL, 100) };
    }
    let newest = lastId || null;
    let fetched;
    let rounds = 0;
    do {
        fetched = await channel.messages.fetch(fetchOpts).catch(() => null);
        if (!fetched || fetched.size === 0) break;
        const arr = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const msg of arr) {
            if (!newest || BigInt(msg.id) > BigInt(newest)) newest = msg.id;
            if (msg.author.bot || msg.webhookId) continue;
            const text = (msg.cleanContent || msg.content || '').trim();
            if (!text) continue;
            out.push({
                username: msg.author.username,
                platform: 'discord',
                text: text.slice(0, 4000),
                ts: Math.floor(msg.createdTimestamp / 1000),
            });
        }
        rounds++;
        // Only paginate forward when we had a cursor; the first run takes a
        // single page.
        if (!lastId || out.length >= MAX_PER_CHANNEL_PER_TICK) break;
        fetchOpts = { limit: 100, after: newest };
    } while (fetched.size === 100 && rounds < 5);
    if (newest && newest !== lastId) state.channels[channel.id] = newest;
    return out;
}

async function runKnowledgeSyncOnce() {
    if (_running || !_client || !_client.isReady || !_client.isReady()) return;
    if (!isDiscordFeatureEnabled('knowledge_population')) return;
    _running = true;
    try {
        const guild = await _client.guilds.fetch(SERVER_ID).catch(() => null);
        if (!guild) return;
        const channels = await guild.channels.fetch().catch(() => null);
        if (!channels) return;
        const state = _loadState();
        let batch = [];
        let pushed = 0;
        const flush = async () => {
            if (!batch.length) return;
            const payload = { messages: batch };
            const resp = await streamerJoeRequest('post', '/api/profiles/bulk', payload);
            if (resp.status === 200 && resp.data && resp.data.ok) {
                pushed += resp.data.imported || 0;
            } else {
                throw new Error(`bulk import returned ${resp.status}`);
            }
            batch = [];
        };
        for (const [, ch] of channels) {
            if (!ch || !ch.isTextBased || !ch.isTextBased()) continue;
            if (!ch.permissionsFor(_client.user)?.has(['ViewChannel', 'ReadMessageHistory'])) continue;
            try {
                const msgs = await _collectChannel(ch, state);
                batch.push(...msgs);
                if (batch.length >= BATCH_LIMIT) await flush();
            } catch (err) {
                console.warn(`[KnowledgeSync] Channel ${ch.id} failed:`, err.message);
            }
        }
        await flush();
        _saveState();
        if (pushed > 0) {
            console.log(`[KnowledgeSync] Pushed ${pushed} Discord message(s) into streamer-joe knowledge.`);
        }
    } catch (err) {
        // streamer-joe unreachable or mid-sync failure: cursors for already
        // flushed channels are saved; unflushed ones retry next tick.
        console.warn('[KnowledgeSync] Sync failed (will retry):', err.message);
        _saveState();
    } finally {
        _running = false;
    }
}

/** Start the periodic sync. Safe to call once at startup after client ready. */
function startKnowledgeSync(client) {
    _client = client;
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => { runKnowledgeSyncOnce().catch(() => {}); }, INTERVAL_MS);
    // First run shortly after boot (give the feature-flag poller time to
    // fetch the real toggle state first).
    setTimeout(() => { runKnowledgeSyncOnce().catch(() => {}); }, 60 * 1000);
    console.log(`[KnowledgeSync] Started (every ${Math.round(INTERVAL_MS / 1000)}s, gated by knowledge_population flag).`);
}

module.exports = { startKnowledgeSync, runKnowledgeSyncOnce };
