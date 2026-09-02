// streamerJoe.js — streamer-joe dashboard integration for the librarian bot.
//
// Two pieces, ported from discord-joe (siblingBots.js transport +
// discordFeatures.js poller):
//
// 1. A TLS-aware HTTP transport: streamer-joe serves a self-signed cert on
//    :8777 while STREAMER_JOE_API_URL may still say http:// — plain http gets
//    "socket hang up". We try the https:// upgrade first and remember the
//    first base that answers. Authenticated with X-Service-Key (SHARE_PASS).
//
// 2. The Discord feature-flag poller: GET /api/internal/discord-configs every
//    5 min; the first config with a non-empty `features` object wins (the
//    operator's dashboard toggles steer the bot). Best-effort — when
//    streamer-joe is unreachable the DEFAULT_FEATURES below apply, which keep
//    every currently active librarian feature ON.

const https = require('https');
const axios = require('axios');

const STREAMER_JOE_API_URL = process.env.STREAMER_JOE_API_URL || '';
const DEFAULT_POLL_MS = parseInt(process.env.DISCORD_FEATURE_FLAGS_POLL_MS || '300000', 10); // 5 min

const DEFAULT_FEATURES = {
    llm_chat: true,        // RAG mention replies
    media_parsing: true,   // Twitter/IG/FB/TikTok/Telegram/forum interceptors
    media_transcode: true, // ffmpeg compression of oversized media
    news_parsing: true,    // news-article interceptor
    // NOTE: knowledge_population is deliberately absent — Discord→knowledge
    // export is a discord-joe-only feature; the librarian never pushes its
    // guild's messages to streamer-joe.
};

const _BASE_CANDIDATES = [];
{
    const raw = STREAMER_JOE_API_URL.replace(/\/+$/, '');
    if (raw) {
        const httpsUrl = raw.replace(/^http:\/\//, 'https://');
        _BASE_CANDIDATES.push(httpsUrl);
        if (httpsUrl !== raw) _BASE_CANDIDATES.push(raw);
    }
}
let _workingBase = null;
const _client = axios.create({
    timeout: 10000,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
});

async function streamerJoeRequest(method, apiPath, body) {
    if (!_BASE_CANDIDATES.length) throw new Error('STREAMER_JOE_API_URL not configured');
    const bases = _workingBase ? [_workingBase] : _BASE_CANDIDATES;
    let lastErr = null;
    for (const base of bases) {
        try {
            const resp = await _client.request({
                method,
                url: base + apiPath,
                data: body,
                headers: { 'X-Service-Key': process.env.SHARE_PASS },
            });
            _workingBase = base;
            return resp;
        } catch (err) {
            lastErr = err;
        }
    }
    _workingBase = null;
    throw lastErr;
}

let cachedFeatures = { ...DEFAULT_FEATURES };
let lastFetchAt = 0;
let pollTimer = null;
let pollInProgress = false;

async function fetchDiscordFeatures() {
    if (pollInProgress) return;
    pollInProgress = true;
    try {
        if (!STREAMER_JOE_API_URL || !process.env.SHARE_PASS) return; // keep defaults
        const resp = await streamerJoeRequest('get', '/api/internal/discord-configs');
        if (resp.status !== 200 || !Array.isArray(resp.data)) return;
        for (const cfg of resp.data) {
            const feats = cfg && cfg.features;
            if (feats && typeof feats === 'object' && Object.keys(feats).length) {
                cachedFeatures = { ...DEFAULT_FEATURES, ...feats };
                break; // first config wins (single-tenant operator toggles)
            }
        }
        lastFetchAt = Date.now();
    } catch (err) {
        if (lastFetchAt === 0) {
            console.warn('[StreamerJoe] Could not reach streamer-joe (using default flags):', err.message);
        }
    } finally {
        pollInProgress = false;
    }
}

async function startDiscordFeaturesPoller(pollMs = DEFAULT_POLL_MS) {
    if (pollTimer) clearInterval(pollTimer);
    await fetchDiscordFeatures();
    pollTimer = setInterval(fetchDiscordFeatures, pollMs);
    console.log(`[StreamerJoe] Feature poller started (every ${Math.round(pollMs / 1000)}s) — ` +
        Object.entries(cachedFeatures).filter(([, v]) => typeof v === 'boolean')
            .map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(', '));
}

function isDiscordFeatureEnabled(flag) {
    return !!cachedFeatures[flag];
}

module.exports = {
    streamerJoeRequest,
    startDiscordFeaturesPoller,
    fetchDiscordFeatures,
    isDiscordFeatureEnabled,
    DEFAULT_FEATURES,
};
