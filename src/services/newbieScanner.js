// newbieScanner.js — OPTIONAL FEATURE: new-member scanner with instaban.
//
// Owner spec (2026-11-19). Two tasks:
//   1. MONITOR: every member who joins AFTER the feature went live is watched
//      for their first NEWBIE_SCANNER_MAX_MESSAGES (15) messages.
//      - A message that links them to Tallinn / Estonia (a place name, a
//        mention of living in / visiting Estonia, or any common Estonian
//        word) QUALIFIES them: monitoring stops, nothing they post afterwards
//        is punished.
//      - After 15 messages without qualifying (and without solicitation) the
//        member is treated as a regular member: monitoring stops, no action.
//   2. BAN: while not yet qualified, a message that advertises the author's
//      art / asks for commissions or money is a ban: keyword pre-filter, then
//      one DeepSeek call confirms (fewer false bans). The member is banned,
//      every tracked message of theirs is deleted, and the ban is reported in
//      #modlog with an @admin ping.
//
// Enable/disable: config.js NEWBIE_SCANNER_ENABLED (env NEWBIE_SCANNER_ENABLED=0
// turns it off) and NEWBIE_SCANNER_GUILD_IDS (ttrpg.ee by default).
//
// State: ./data/newbie-scanner.json
//   { activeSince, users: { "<guildId>:<userId>": { status, joinedAt, count,
//     messages: [[channelId, messageId], ...], updatedAt } } }
//   status: watching | qualified | done | exempt | banned

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { PermissionFlagsBits } = require('discord.js');
const {
    NEWBIE_SCANNER_ENABLED,
    NEWBIE_SCANNER_GUILD_IDS,
    NEWBIE_SCANNER_MAX_MESSAGES,
    NEWBIE_SCANNER_STATE_PATH,
    MODLOG_CHANNEL_ID,
    ADMIN_ROLE_ID,
    DM_ROLE_ID,
    deepseekApiKey,
    DEEPSEEK_API_URL,
    DEEPSEEK_MODEL,
} = require('../config');

const STATE_PATH = path.resolve(process.cwd(), NEWBIE_SCANNER_STATE_PATH);
const BAN_DELETE_SECONDS = 7 * 24 * 60 * 60; // Discord maximum for ban-time purge

// ---------------------------------------------------------------------------
// Text normalisation + matching
// ---------------------------------------------------------------------------

// Lower-case, strip diacritics (ä→a, õ→o, ü→u, š→s; Cyrillic й→и, ё→е) so
// "Pärnu" / "Parnu" and "Йыхви" / "Иыхви" match the same keyword.
function normalize(text) {
    return (text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[’`´]/g, "'");
}

function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// stem:  matches the keyword at a word start, any ending ("tallinn" →
//        Tallinnas, Tallinnast, Tallinna...).
// exact: whole word only (short or ambiguous words).
// Spaces in a keyword match any whitespace run.
function buildMatcher(stems, exact) {
    const parts = [];
    for (const k of stems) parts.push(escapeRe(normalize(k)).replace(/\s+/g, '\\s+'));
    for (const k of exact) parts.push(escapeRe(normalize(k)).replace(/\s+/g, '\\s+') + '(?![\\p{L}\\p{N}])');
    return new RegExp('(?<![\\p{L}\\p{N}])(?:' + parts.join('|') + ')', 'iu');
}

// Words whose diacritic-free form is an English/Spanish word ("väga"→"vaga",
// "sõber"→"sober"): matched on the raw lower-cased text, diacritics kept.
function buildRawMatcher(words) {
    return new RegExp('(?<![\\p{L}\\p{N}])(?:' + words.map(w => escapeRe(w.toLowerCase().normalize('NFC'))).join('|') + ')(?![\\p{L}\\p{N}])', 'iu');
}

// --- Estonia / Tallinn connection -------------------------------------------
const ESTONIA_STEMS = [
    // country / people / language (EN, ET, DE/SV, RU)
    'tallin', 'estoni', 'eesti', 'eestla', 'estland', 'таллин', 'эстон',
    // cities and towns
    'tartu', 'parnu', 'kohtla-jarve', 'kohtla jarve', 'viljandi', 'rakvere', 'maardu', 'kuressaare',
    'sillamae', 'johvi', 'haapsalu', 'polva', 'jogeva', 'rapla', 'kardla', 'otepaa', 'paldiski',
    'viimsi', 'laagri', 'kivioli', 'narva-joesuu', 'mustvee', 'kunda',
    // Tallinn districts / landmarks
    'kalamaja', 'kristiine', 'mustamae', 'lasnamae', 'haabersti', 'kesklinn', 'pirita', 'kopli',
    'telliskivi', 'ulemiste', 'rotermann', 'vanalinn', 'kadriorg', 'oismae', 'kakumae', 'paljassaare',
    // counties / regions / islands
    'harjumaa', 'harju maakond', 'ida-viru', 'idaviru', 'laane-viru', 'laanemaa', 'saaremaa', 'hiiumaa',
    'vorumaa', 'valgamaa', 'jarvamaa', 'lahemaa', 'soomaa', 'vormsi', 'kihnu', 'peipsi', 'naissaar',
    // Russian forms
    'тарту', 'пярну', 'кохтла', 'вильянди', 'раквере', 'маарду', 'курессааре', 'силламяэ', 'йыхви',
    'хаапсалу', 'ласнамяэ', 'ласнамае', 'мустамяэ', 'мустамае', 'кадриорг', 'сааремаа', 'хийумаа',
    'ида-виру', 'харьюмаа', 'пирита', 'кристийне', 'нымме',
];
const ESTONIA_EXACT = [
    'tln', 'tll', 'narva', 'narvas', 'narvast', 'narvasse', 'keila', 'paide', 'saue', 'elva', 'voru',
    'valga', 'nomme', 'muhu', 'lasna', 'viro', 'eestis', 'нарва', 'нарве', 'нарву', 'нарвы', 'кейла',
    'выру', 'копли',
];

// --- Common Estonian words for a self-introduction ---------------------------
const ESTONIAN_WORD_STEMS = [
    'tervitus', 'lauamang', 'rollimang', 'seiklus', 'meeldiv', 'tutvu',
    'minu nimi', 'mu nimi', 'mina olen', 'ma olen', 'olen parit', 'ma elan', 'elan tallinn',
    'head aega', 'head paeva', 'head ohtut', 'kuidas laheb', 'kuidas sul', 'tere tulemast',
    'tere hommikust', 'tere ohtust', 'vaga tore', 'eesti keel', 'raagin eesti', 'ma raagin',
    'mulle meeldib', 'nagemiseni', 'kohtumiseni',
];
const ESTONIAN_WORD_EXACT = [
    'tere', 'tervist', 'tsau', 'aitah', 'tanan', 'palun', 'nagemist', 'kuidas', 'meeldib', 'olen',
    'minu', 'mulle', 'sulle', 'jah', 'nimi', 'nimega', 'aastane', 'parit', 'elan', 'mangin',
    'mangida', 'tudeng', 'ulikool', 'hommikust', 'oige', 'lahe', 'mangud', 'mangu',
];
const ESTONIAN_RAW_WORDS = [
    'väga', 'sõber', 'sõbrad', 'äge', 'kõik', 'hästi', 'räägin', 'õhtust', 'päeva', 'töötan',
    'õpin', 'mõnus', 'tänan', 'aitäh', 'nägemist', 'tšau',
];

const ESTONIA_RE = buildMatcher(ESTONIA_STEMS, ESTONIA_EXACT);
const ESTONIAN_WORDS_RE = buildMatcher(ESTONIAN_WORD_STEMS, ESTONIAN_WORD_EXACT);
const ESTONIAN_RAW_RE = buildRawMatcher(ESTONIAN_RAW_WORDS);

/** Returns the matched keyword when the text ties the author to Estonia, else null. */
function findEstoniaConnection(text) {
    if (!text) return null;
    const norm = normalize(text);
    let m = norm.match(ESTONIA_RE);
    if (m) return m[0];
    m = norm.match(ESTONIAN_WORDS_RE);
    if (m) return m[0];
    m = text.toLowerCase().normalize('NFC').match(ESTONIAN_RAW_RE);
    if (m) return m[0];
    return null;
}

// --- Art commission / money solicitation (keyword pre-filter) ---------------
const SOLICITATION_SIGNALS = {
    commission: [
        /(?<![\p{L}])com+is+ion/iu,              // commission(s), comission, commisions...
        /(?<![\p{L}])comms?(?![\p{L}])/iu,
        /коммишн|комишн|комисси|коммисси/iu,
    ],
    selling: [
        /for hire/i, /hire me/i, /open for (?:work|orders|requests|business)/i,
        /slots? (?:are |is )?(?:open|available|left)/i, /price ?list/i, /prices? (?:start|from)/i,
        /starting (?:at|from)\s*[$€£]?\s*\d/i, /[$€£]\s?\d+/, /\d+\s?(?:usd|eur|euro|€|\$)/i,
        /art (?:for sale|shop|store)/i, /selling (?:my )?(?:art|drawings|work|pieces)/i,
        /taking (?:orders|requests)/i, /custom (?:art|portrait|drawing|piece|illustration)/i,
        /promot(?:e|ing) (?:myself|my)/i, /portfolio/i,
    ],
    money: [
        /need(?:s|ing)? (?:some |the )?(?:money|cash|funds|income|work)/i,
        /(?:financial|money) (?:situation|hardship|trouble|problem|struggle|help)/i,
        /pay (?:my|the|for) (?:rent|bills|medical|surgery|food)/i, /donat/i, /paypal/i, /ko-?fi/i,
        /cash ?app/i, /venmo/i, /patreon/i, /gofundme/i, /support (?:me|artists|my|an artist)/i,
        /нужны деньги|донат|помогите деньгами/i,
    ],
};
const ART_WORD_RE = /(?<![\p{L}])(?:art|artist|artwork|draw|drawing|illustrat|paint|sketch|oc|ocs|рису|арт)/iu;

/**
 * Keyword pre-filter. Returns { suspicious, strong, categories[] }.
 * suspicious: send the message to DeepSeek. strong: ≥2 signal categories —
 * informational only (logged); a ban ALWAYS needs DeepSeek's confirmation.
 */
function scoreSolicitation(text) {
    const t = (text || '');
    const categories = [];
    for (const [cat, list] of Object.entries(SOLICITATION_SIGNALS)) {
        if (list.some(re => re.test(t))) categories.push(cat);
    }
    const hasArt = ART_WORD_RE.test(t);
    const suspicious = categories.includes('commission') || categories.includes('money') ||
        (categories.includes('selling') && hasArt);
    const strong = categories.length >= 2 || (categories.includes('commission') && hasArt);
    return { suspicious, strong, categories, hasArt };
}

// ---------------------------------------------------------------------------
// DeepSeek confirmation
// ---------------------------------------------------------------------------

const CLASSIFIER_PROMPT = `You are a moderation classifier for a tabletop-RPG Discord community based in Tallinn, Estonia.
You get a message written by a member who JUST joined. Decide whether it is SOLICITATION: the author advertises their own art or creative services and wants commissions / paid work / clients, or asks people for money, donations or financial support.
NOT solicitation: mentioning art, drawing or cosplay as a hobby; sharing artwork; talking about games; someone wanting to BUY or commission something from others; normal self-introductions.
Reply with JSON only: {"solicitation": true or false, "reason": "<max 15 words>"}`;

async function confirmWithLLM(text) {
    if (!deepseekApiKey) return { ok: false, error: 'no DeepSeek key' };
    try {
        const resp = await axios.post(DEEPSEEK_API_URL, {
            model: DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: CLASSIFIER_PROMPT },
                { role: 'user', content: `Message:\n"""\n${text.slice(0, 4000)}\n"""` },
            ],
            temperature: 0,
            max_tokens: 400,
            stream: false,
            response_format: { type: 'json_object' },
        }, {
            timeout: 30000,
            headers: { Authorization: `Bearer ${deepseekApiKey}`, 'Content-Type': 'application/json' },
        });
        const content = resp.data?.choices?.[0]?.message?.content || '';
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) return { ok: false, error: `unparseable reply: ${content.slice(0, 120)}` };
        const parsed = JSON.parse(m[0]);
        return { ok: true, solicitation: parsed.solicitation === true, reason: String(parsed.reason || '').slice(0, 200) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let _state = null;

function _load() {
    if (_state) return _state;
    try {
        _state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch (_) {
        _state = {};
    }
    if (!_state.users || typeof _state.users !== 'object') _state.users = {};
    return _state;
}

function _save() {
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        const tmp = STATE_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(_state, null, 1));
        fs.renameSync(tmp, STATE_PATH);
    } catch (err) {
        console.warn('[NewbieScanner] Failed to persist state:', err.message);
    }
}

function _key(guildId, userId) { return `${guildId}:${userId}`; }

function isEnabledForGuild(guildId) {
    return !!NEWBIE_SCANNER_ENABLED && NEWBIE_SCANNER_GUILD_IDS.includes(guildId);
}

function _isExemptMember(member) {
    if (!member) return false;
    try {
        if (member.permissions?.has(PermissionFlagsBits.Administrator)) return true;
        if (member.permissions?.has(PermissionFlagsBits.BanMembers)) return true;
        const roles = member.roles?.cache;
        if (roles && ((ADMIN_ROLE_ID && roles.has(ADMIN_ROLE_ID)) || (DM_ROLE_ID && roles.has(DM_ROLE_ID)))) return true;
    } catch (_) { /* partial member */ }
    return false;
}

function _startWatching(guildId, userId, joinedAt) {
    const st = _load();
    const key = _key(guildId, userId);
    if (st.users[key]) return false; // already known (vetted, banned or watching)
    st.users[key] = { status: 'watching', joinedAt: joinedAt || Date.now(), count: 0, messages: [], updatedAt: Date.now() };
    _save();
    return true;
}

/**
 * Startup: record when the scanner went live (only members who join after
 * this moment are ever monitored) and pick up joins missed while offline.
 */
async function initNewbieScanner(client) {
    if (!NEWBIE_SCANNER_ENABLED) {
        console.log('[NewbieScanner] Disabled (NEWBIE_SCANNER_ENABLED=0).');
        return;
    }
    const st = _load();
    if (!st.activeSince) {
        st.activeSince = Date.now();
        _save();
        console.log(`[NewbieScanner] First start — monitoring members who join after ${new Date(st.activeSince).toISOString()}.`);
    }
    for (const guildId of NEWBIE_SCANNER_GUILD_IDS) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;
        let added = 0;
        try {
            const members = await guild.members.fetch();
            for (const member of members.values()) {
                if (member.user.bot) continue;
                if ((member.joinedTimestamp || 0) < st.activeSince) continue;
                if (_startWatching(guildId, member.id, member.joinedTimestamp)) added++;
            }
        } catch (err) {
            console.warn(`[NewbieScanner] Member catch-up failed for guild ${guildId}:`, err.message);
        }
        const watching = Object.entries(st.users).filter(([k, u]) => k.startsWith(guildId + ':') && u.status === 'watching').length;
        console.log(`[NewbieScanner] Active on guild ${guildId} (${guild.name}): watching ${watching} newbie(s)` +
            (added ? `, ${added} picked up from joins while offline` : '') + '.');
    }
}

/** guildMemberAdd hook. */
function handleNewbieJoin(member) {
    if (!member?.guild || member.user?.bot || !isEnabledForGuild(member.guild.id)) return;
    if (_startWatching(member.guild.id, member.id, member.joinedTimestamp || Date.now())) {
        console.log(`[NewbieScanner] Watching new member ${member.user.tag} (${member.id}).`);
    }
}

// ---------------------------------------------------------------------------
// Ban + modlog
// ---------------------------------------------------------------------------

async function _postModlog(client, content, pingAdmins) {
    try {
        const ch = await client.channels.fetch(MODLOG_CHANNEL_ID);
        await ch.send({
            content: (pingAdmins && ADMIN_ROLE_ID ? `<@&${ADMIN_ROLE_ID}> ` : '') + content,
            allowedMentions: { roles: pingAdmins && ADMIN_ROLE_ID ? [ADMIN_ROLE_ID] : [], users: [] },
        });
    } catch (err) {
        console.warn('[NewbieScanner] modlog post failed:', err.message);
    }
}

function _quote(text, max = 700) {
    const t = (text || '').length > max ? text.slice(0, max) + '…' : (text || '*(no text)*');
    return t.split('\n').map(l => '> ' + l).join('\n');
}

async function _banAndPurge(client, message, entry, why) {
    const guild = message.guild;
    const user = message.author;
    let banned = false;
    let banError = null;
    try {
        await guild.members.ban(user.id, { deleteMessageSeconds: BAN_DELETE_SECONDS, reason: `Newbie scanner: ${why}`.slice(0, 500) });
        banned = true;
    } catch (err) {
        banError = err.message;
        console.error(`[NewbieScanner] Ban failed for ${user.tag} (${user.id}):`, err.message);
    }
    // Delete every tracked message explicitly too (covers messages older than
    // Discord's 7-day ban purge and threads).
    let deleted = 0;
    for (const [channelId, messageId] of entry.messages || []) {
        try {
            const ch = await client.channels.fetch(channelId);
            await ch.messages.delete(messageId);
            deleted++;
        } catch (err) {
            if (err.code === 10008) deleted++; // already gone (ban purge got it first)
        }
    }
    const total = (entry.messages || []).length;
    console.log(`[NewbieScanner] ${banned ? 'BANNED' : 'BAN FAILED'} ${user.tag} (${user.id}) — ${why}; messages removed ${deleted}/${total}.`);
    await _postModlog(client,
        `${banned ? '🚫 **Newbie scanner banned**' : '⚠️ **Newbie scanner could NOT ban**'} ${user.tag} (<@${user.id}>, \`${user.id}\`)\n` +
        `Reason: ${why}\n` +
        `Joined <t:${Math.floor((entry.joinedAt || Date.now()) / 1000)}:R>, message ${entry.count}/${NEWBIE_SCANNER_MAX_MESSAGES} in <#${message.channel.id}>. ` +
        `Messages removed: ${deleted}/${total}.` + (banError ? `\nError: ${banError}` : '') + '\n' +
        _quote(message.content), true);
    return banned;
}

// ---------------------------------------------------------------------------
// Message hook
// ---------------------------------------------------------------------------

const _userChains = new Map(); // serialise per user: a fast spammer must not race the counter

/**
 * messageCreate hook. Returns true when the author was banned (the caller
 * must stop processing the message).
 */
function handleNewbieMessage(client, message) {
    if (!message.guild || message.author?.bot || message.webhookId) return Promise.resolve(false);
    if (!isEnabledForGuild(message.guild.id)) return Promise.resolve(false);
    const key = _key(message.guild.id, message.author.id);
    const entry = _load().users[key];
    if (!entry || entry.status !== 'watching') return Promise.resolve(false);

    const prev = _userChains.get(key) || Promise.resolve();
    const next = prev.then(() => _processMessage(client, message, key)).catch(err => {
        console.error('[NewbieScanner] processing error:', err);
        return false;
    });
    _userChains.set(key, next);
    next.finally(() => { if (_userChains.get(key) === next) _userChains.delete(key); });
    return next;
}

async function _processMessage(client, message, key) {
    const st = _load();
    const entry = st.users[key];
    if (!entry || entry.status !== 'watching') return false;
    if (entry.messages.some(([, id]) => id === message.id)) return false; // re-dispatched message

    if (_isExemptMember(message.member)) {
        entry.status = 'exempt';
        entry.messages = [];
        entry.updatedAt = Date.now();
        _save();
        return false;
    }

    entry.count += 1;
    entry.messages.push([message.channel.id, message.id]);
    entry.updatedAt = Date.now();
    const text = message.content || '';
    const tag = `${message.author.tag} (${message.author.id})`;

    // 1. Estonia / Tallinn connection → vetted for good.
    const link = findEstoniaConnection(text);
    if (link) {
        entry.status = 'qualified';
        entry.qualifiedBy = link;
        entry.messages = [];
        _save();
        console.log(`[NewbieScanner] ${tag} qualified on message ${entry.count} (matched "${link}").`);
        return false;
    }

    // 2. Solicitation while unqualified → ban.
    const score = scoreSolicitation(text);
    if (score.suspicious) {
        _save();
        // DeepSeek ALWAYS checks this exact message before any ban (owner rule
        // 2026-11-19): keywords alone never ban. One retry on a transport error;
        // if DeepSeek still fails, admins are pinged in #modlog instead.
        let llm = await confirmWithLLM(text);
        if (!llm.ok) llm = await confirmWithLLM(text);
        let banWhy = null;
        if (llm.ok && llm.solicitation) {
            banWhy = `art-commission / money solicitation before any Tallinn/Estonia link (keywords: ${score.categories.join(', ')}; DeepSeek: ${llm.reason || 'confirmed'})`;
        }
        if (banWhy) {
            entry.status = 'banned';
            entry.bannedAt = Date.now();
            _save();
            await _banAndPurge(client, message, entry, banWhy);
            entry.messages = [];
            _save();
            return true;
        }
        const note = llm.ok ? `DeepSeek says not solicitation: ${llm.reason}` : `DeepSeek unavailable (${llm.error}) — needs a human decision`;
        console.log(`[NewbieScanner] ${tag} flagged but not banned — ${note}.`);
        await _postModlog(client,
            `🔎 Newbie scanner flagged ${message.author.tag} (<@${message.author.id}>) in <#${message.channel.id}> but did **not** ban — ${note} ` +
            `(keywords: ${score.categories.join(', ')}). [Jump](${message.url})\n` + _quote(text), !llm.ok);
    }

    // 3. Message limit reached without qualifying or soliciting → regular member.
    if (entry.count >= NEWBIE_SCANNER_MAX_MESSAGES) {
        entry.status = 'done';
        entry.messages = [];
        console.log(`[NewbieScanner] ${tag} reached ${NEWBIE_SCANNER_MAX_MESSAGES} messages — monitoring stopped, no action.`);
    }
    _save();
    return false;
}

module.exports = {
    initNewbieScanner,
    handleNewbieJoin,
    handleNewbieMessage,
    isEnabledForGuild,
    findEstoniaConnection,
    scoreSolicitation,
    confirmWithLLM,
    normalize,
};
