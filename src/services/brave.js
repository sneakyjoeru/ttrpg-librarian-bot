// Web search — Brave Search API only (2026-11-26 owner order: "abandon
// searxng, use only brave api from now on"). The SearXNG container on the
// N150 was removed with this change.
//
// Returns the shape the old SearXNG HTTP call returned — the caller reads
// `res.data.results[].title/content` unchanged. Never throws.

const axios = require('axios');
const { RAG_SEARCH_LIMIT, RAG_SEARCH_TIMEOUT, braveSearchApiKey } = require('../config');

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';

function braveKey() {
    // Read at call time so a late-loaded .env (and tests) can set it; the
    // app's secrets_discord.php is the primary store.
    return process.env.BRAVE_SEARCH_API_KEY || braveSearchApiKey || '';
}

function _hasCyrillic(text) {
    return /[\u0400-\u04ff]/.test(String(text || ''));
}

async function searchResults(query, opts = {}) {
    const empty = { data: { results: [] } };
    if (!braveKey() || !query) return empty;
    const cyr = _hasCyrillic(query);
    const count = Math.max(1, Math.min(parseInt(opts.limit || RAG_SEARCH_LIMIT, 10) || 6, 20));
    try {
        const res = await axios.get(BRAVE_URL, {
            params: {
                q: query,
                count,
                country: cyr ? 'ru' : 'us',
                search_lang: cyr ? 'ru' : 'en',
                text_decorations: false,
            },
            headers: {
                'X-Subscription-Token': braveKey(),
                Accept: undefined,
                'Content-Type': undefined,
            },
            timeout: RAG_SEARCH_TIMEOUT,
        });
        const raw = ((res.data && res.data.web && res.data.web.results) || res.data.results) || [];
        const results = raw
            .filter(r => r && r.title && r.url)
            .map(r => ({ title: r.title, url: r.url, content: r.description || '' }));
        return { data: { results } };
    } catch (err) {
        console.warn(`[WebSearch] Brave search failed for "${String(query).slice(0, 80)}": ${err.message}`);
        return empty;
    }
}

module.exports = { searchResults };
