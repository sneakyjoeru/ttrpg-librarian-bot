// guildLanguages.js
//
// Per-guild language configuration: which MAIN language a Discord server
// speaks, which SECONDARY languages are in active use, and which channels are
// language-specific (e.g. an #english channel on a Russian server). Obtained
// automatically with an initial scan of channels + user messages right after
// the bot connects to a guild (and re-scanned when the config is older than
// RESCAN_DAYS). Consumers ask `getChannelLanguage(guildId, channelId)` and get
// the channel's language ('en', 'ru', …) — the channel override when the
// channel is language-specific, otherwise the guild main language.
//
// Detection is heuristic and zero-dependency: Unicode script ranges split
// ru/uk/ja/zh/ko/ar, and Latin-script languages are separated with small
// high-frequency stopword sets + diacritic hints. No LLM calls — the scan is
// cheap enough to run on every guild join.
//
// Storage: ./data/guild-languages.json
//   { "<guildId>": { main, secondary: [..], channels: { "<channelId>": lang },
//                    scannedAt, samples } }

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(process.cwd(), 'data', 'guild-languages.json');
const RESCAN_DAYS = parseInt(process.env.GUILD_LANG_RESCAN_DAYS || '30', 10);
const SCAN_CHANNEL_LIMIT = parseInt(process.env.GUILD_LANG_SCAN_CHANNELS || '20', 10);
const SCAN_MESSAGES_PER_CHANNEL = parseInt(process.env.GUILD_LANG_SCAN_MESSAGES || '60', 10);
const MIN_GUILD_SAMPLES = 10;   // fewer detected messages than this → no config
const MIN_CHANNEL_SAMPLES = 8;  // per-channel override needs at least this many
const CHANNEL_MAJORITY = 0.7;   // ...and this share of them in one language
const SECONDARY_SHARE = 0.15;   // guild-secondary languages need ≥15% of samples

const LANG_NAMES = {
    ru: 'русский', uk: 'украинский', en: 'английский', de: 'немецкий',
    fr: 'французский', es: 'испанский', pt: 'португальский', it: 'итальянский',
    pl: 'польский', tr: 'турецкий', ja: 'японский', zh: 'китайский',
    ko: 'корейский', ar: 'арабский',
};
const LANG_NAMES_EN = {
    ru: 'Russian', uk: 'Ukrainian', en: 'English', de: 'German', fr: 'French',
    es: 'Spanish', pt: 'Portuguese', it: 'Italian', pl: 'Polish', tr: 'Turkish',
    ja: 'Japanese', zh: 'Chinese', ko: 'Korean', ar: 'Arabic',
};

// Channel-name hints: whole-token matches on the channel name (split on
// non-alphanumerics) plus flag emojis / native names matched as substrings.
const NAME_TOKEN_HINTS = {
    en: ['en', 'eng', 'english'],
    ru: ['ru', 'rus', 'russian'],
    de: ['de', 'ger', 'german', 'deutsch'],
    fr: ['fr', 'french', 'francais'],
    es: ['es', 'spanish', 'espanol'],
    pt: ['pt', 'br', 'portuguese', 'portugues'],
    it: ['it', 'italian', 'italiano'],
    pl: ['pl', 'polish', 'polski'],
    tr: ['tr', 'turkish', 'turkce'],
    ja: ['jp', 'ja', 'japanese'],
    zh: ['zh', 'cn', 'chinese'],
    ko: ['kr', 'ko', 'korean'],
    uk: ['ua', 'ukr', 'ukrainian'],
    ar: ['ar', 'arabic'],
};
const NAME_SUBSTRING_HINTS = {
    en: ['🇬🇧', '🇺🇸', 'англий'],
    ru: ['🇷🇺', 'русск'],
    de: ['🇩🇪', 'немецк'],
    fr: ['🇫🇷', 'français', 'французск'],
    es: ['🇪🇸', 'español', 'испанск'],
    pt: ['🇧🇷', '🇵🇹', 'português'],
    it: ['🇮🇹', 'итальянск'],
    pl: ['🇵🇱', 'польск'],
    tr: ['🇹🇷', 'türk', 'турецк'],
    ja: ['🇯🇵', '日本語', 'японск'],
    zh: ['🇨🇳', '中文', 'китайск'],
    ko: ['🇰🇷', '한국어', 'корейск'],
    uk: ['🇺🇦', 'україн', 'украинск'],
    ar: ['🇸🇦', 'عرب', 'арабск'],
};

// High-frequency function words per Latin-script language. Whole-word matches.
const STOPWORDS = {
    en: ['the', 'and', 'you', 'that', 'have', 'with', 'this', 'what', 'just', 'not', 'was', 'are'],
    de: ['und', 'der', 'die', 'das', 'ich', 'nicht', 'ist', 'mit', 'ein', 'auch', 'aber', 'schon'],
    fr: ['le', 'la', 'les', 'est', 'pas', 'que', 'une', 'des', 'mais', 'avec', 'pour', 'je'],
    es: ['el', 'la', 'los', 'que', 'una', 'por', 'con', 'para', 'pero', 'como', 'esta', 'muy'],
    pt: ['de', 'que', 'não', 'nao', 'uma', 'com', 'para', 'mas', 'como', 'isso', 'você', 'voce'],
    it: ['che', 'per', 'non', 'una', 'sono', 'con', 'come', 'anche', 'del', 'della', 'questo', 'ma'],
    pl: ['nie', 'jest', 'się', 'sie', 'ale', 'jak', 'tak', 'czy', 'jego', 'było', 'bylo', 'tego'],
    tr: ['bir', 'bu', 'için', 'icin', 've', 'ama', 'gibi', 'daha', 'çok', 'cok', 'ben', 'ne'],
};
// Only characters that are (near-)unique to one language — shared diacritics
// like é/ç/ü are deliberately absent and resolved by the stopword scoring.
const DIACRITIC_HINTS = [
    [/[ãõ]/i, 'pt'], [/[ñ¿¡]/i, 'es'], [/[ğıİş]/, 'tr'],
    [/[łżźśćąę]/i, 'pl'], [/[œùîë]/i, 'fr'], [/ß/, 'de'],
];

function _clean(text) {
    return (text || '')
        .replace(/https?:\/\/\S+/gi, ' ')
        .replace(/<a?:\w+:\d+>/g, ' ')  // custom emoji
        .replace(/<[@#][!&]?\d+>/g, ' ') // mentions/channels
        .replace(/```[\s\S]*?```/g, ' ')
        .trim();
}

/**
 * Detect the language of a short chat message. Returns a code from LANG_NAMES
 * or null when the text is too short/ambiguous.
 */
function detectLanguage(text) {
    const t = _clean(text);
    if (t.length < 6) return null;

    let cyr = 0, lat = 0, kana = 0, han = 0, hangul = 0, arab = 0;
    let ukChars = 0, ruChars = 0;
    for (const ch of t) {
        const c = ch.codePointAt(0);
        if (c >= 0x0400 && c <= 0x04FF) {
            cyr++;
            if ('іїєґІЇЄҐ'.includes(ch)) ukChars++;
            if ('ыэъёЫЭЪЁ'.includes(ch)) ruChars++;
        } else if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0xC0 && c <= 0x17F)) {
            lat++;
        } else if ((c >= 0x3040 && c <= 0x30FF)) kana++;
        else if (c >= 0x4E00 && c <= 0x9FFF) han++;
        else if (c >= 0xAC00 && c <= 0xD7AF) hangul++;
        else if (c >= 0x0600 && c <= 0x06FF) arab++;
    }
    const total = cyr + lat + kana + han + hangul + arab;
    if (total < 4) return null;

    if (kana >= 2) return 'ja';
    if (hangul >= 2) return 'ko';
    if (han >= 2 && kana === 0) return 'zh';
    if (arab / total > 0.4) return 'ar';
    if (cyr / total > 0.5) {
        if (ukChars > 0 && ukChars >= ruChars) return 'uk';
        return 'ru';
    }
    if (lat / total <= 0.5) return null;

    // Latin script: diacritic fast path, then stopword scoring.
    for (const [re, lang] of DIACRITIC_HINTS) {
        if (re.test(t)) return lang;
    }
    const words = t.toLowerCase().split(/[^a-zà-ÿçğışłżźśćąę]+/i).filter(Boolean);
    if (words.length === 0) return null;
    const wordSet = words; // keep duplicates — frequency matters
    let best = null, bestScore = 0;
    for (const [lang, stops] of Object.entries(STOPWORDS)) {
        let score = 0;
        for (const w of wordSet) if (stops.includes(w)) score++;
        if (score > bestScore) { bestScore = score; best = lang; }
    }
    if (best && bestScore >= 1) return best;
    // Plain unaccented Latin with no stopword hit: default to English only
    // when the message is long enough to be more than a nickname/emote.
    return words.length >= 4 ? 'en' : null;
}

// ---------------------------------------------------------------------------

let _store = null;

function _load() {
    if (_store) return _store;
    try {
        _store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    } catch (_) {
        _store = {};
    }
    return _store;
}

function _save() {
    try {
        fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify(_store, null, 1));
    } catch (err) {
        console.warn('[GuildLanguages] Failed to persist store:', err.message);
    }
}

function _channelNameHint(name) {
    const lower = (name || '').toLowerCase();
    for (const [lang, subs] of Object.entries(NAME_SUBSTRING_HINTS)) {
        if (subs.some(s => lower.includes(s))) return lang;
    }
    const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
    for (const [lang, hints] of Object.entries(NAME_TOKEN_HINTS)) {
        if (tokens.some(tok => hints.includes(tok))) return lang;
    }
    return null;
}

/**
 * Scan a guild's channels + recent user messages and derive the language
 * config. Skipped when a fresh config exists (younger than RESCAN_DAYS)
 * unless `force` is set.
 */
async function ensureGuildScanned(client, guild, force = false) {
    const store = _load();
    const existing = store[guild.id];
    if (!force && existing && Date.now() - (existing.scannedAt || 0) < RESCAN_DAYS * 24 * 60 * 60 * 1000) {
        return existing;
    }
    console.log(`[GuildLanguages] Scanning guild ${guild.id} (${guild.name || '?'}) for language config...`);
    let channels = null;
    try {
        channels = await guild.channels.fetch();
    } catch (err) {
        console.warn(`[GuildLanguages] Could not fetch channels for guild ${guild.id}:`, err.message);
        return existing || null;
    }
    const textChannels = [...channels.values()]
        .filter(c => c && c.isTextBased && c.isTextBased() &&
            c.permissionsFor(client.user)?.has(['ViewChannel', 'ReadMessageHistory']))
        // Most recently active first (lastMessageId is a snowflake — bigger = newer).
        .sort((a, b) => (BigInt(b.lastMessageId || 0) > BigInt(a.lastMessageId || 0) ? 1 : -1))
        .slice(0, SCAN_CHANNEL_LIMIT);

    const guildTally = {};
    const channelStats = {}; // channelId -> { tally, samples, name }
    for (const ch of textChannels) {
        const tally = {};
        let samples = 0;
        try {
            const batch = await ch.messages.fetch({ limit: Math.min(SCAN_MESSAGES_PER_CHANNEL, 100) });
            for (const msg of batch.values()) {
                if (msg.author.bot || msg.webhookId) continue;
                const lang = detectLanguage(msg.content);
                if (!lang) continue;
                tally[lang] = (tally[lang] || 0) + 1;
                guildTally[lang] = (guildTally[lang] || 0) + 1;
                samples++;
            }
        } catch (_) { /* channel unreadable — skip */ }
        channelStats[ch.id] = { tally, samples, name: ch.name || '' };
    }

    const totalSamples = Object.values(guildTally).reduce((a, b) => a + b, 0);
    const ranked = Object.entries(guildTally).sort((a, b) => b[1] - a[1]);
    const main = totalSamples >= MIN_GUILD_SAMPLES && ranked.length ? ranked[0][0] : null;
    const secondary = main
        ? ranked.slice(1).filter(([, n]) => n / totalSamples >= SECONDARY_SHARE).map(([l]) => l).slice(0, 3)
        : [];

    // Per-channel overrides: explicit name hint wins; otherwise a strong
    // majority in a language different from the guild main.
    const channelLangs = {};
    for (const [chId, st] of Object.entries(channelStats)) {
        const hinted = _channelNameHint(st.name);
        if (hinted) {
            channelLangs[chId] = hinted;
            continue;
        }
        if (!main || st.samples < MIN_CHANNEL_SAMPLES) continue;
        const top = Object.entries(st.tally).sort((a, b) => b[1] - a[1])[0];
        if (top && top[0] !== main && top[1] / st.samples >= CHANNEL_MAJORITY) {
            channelLangs[chId] = top[0];
        }
    }
    // Name hints can also fire on channels the scan didn't sample — check all.
    for (const ch of channels.values()) {
        if (!ch || !ch.isTextBased || !ch.isTextBased() || channelLangs[ch.id]) continue;
        const hinted = _channelNameHint(ch.name || '');
        if (hinted && hinted !== main) channelLangs[ch.id] = hinted;
    }

    store[guild.id] = {
        main,
        secondary,
        channels: channelLangs,
        scannedAt: Date.now(),
        samples: totalSamples,
    };
    _save();
    console.log(`[GuildLanguages] Guild ${guild.id}: main=${main || '?'} secondary=[${secondary.join(',')}] ` +
        `channel overrides=${Object.keys(channelLangs).length} (from ${totalSamples} sampled messages)`);
    return store[guild.id];
}

/** Scan every guild the client is in (startup task). Serial, best-effort. */
async function scanAllGuilds(client) {
    for (const [, guild] of client.guilds.cache) {
        try {
            await ensureGuildScanned(client, guild);
        } catch (err) {
            console.warn(`[GuildLanguages] Scan failed for guild ${guild.id}:`, err.message);
        }
    }
}

/** The guild's stored config, or null. */
function getGuildLanguageConfig(guildId) {
    const store = _load();
    return store[guildId] || null;
}

/**
 * Language for a specific channel: the channel override when the channel is
 * language-specific, otherwise the guild's main language, otherwise null.
 */
function getChannelLanguage(guildId, channelId) {
    const cfg = getGuildLanguageConfig(guildId);
    if (!cfg) return null;
    return (cfg.channels && cfg.channels[channelId]) || cfg.main || null;
}

/**
 * Prompt block instructing the LLM to answer in the channel's language.
 * Returns '' for Russian (the prompts already enforce Russian) and for
 * channels with no known language.
 */
function languageOverrideBlock(guildId, channelId) {
    const lang = getChannelLanguage(guildId, channelId);
    if (!lang || lang === 'ru') return '';
    const nameRu = LANG_NAMES[lang] || lang;
    const nameEn = LANG_NAMES_EN[lang] || lang;
    return `\n\nПЕРЕОПРЕДЕЛЕНИЕ ЯЗЫКА ОТВЕТА (высший приоритет, отменяет все требования писать по-русски выше): ` +
        `этот канал Discord ведётся на языке «${nameRu}» (${nameEn}). ` +
        `Отвечай ИСКЛЮЧИТЕЛЬНО на этом языке. Reply ONLY in ${nameEn}.`;
}

module.exports = {
    detectLanguage,
    ensureGuildScanned,
    scanAllGuilds,
    getGuildLanguageConfig,
    getChannelLanguage,
    languageOverrideBlock,
    LANG_NAMES_EN,
};
