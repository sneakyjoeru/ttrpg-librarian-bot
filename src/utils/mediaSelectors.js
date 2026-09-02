// mediaSelectors.js — shared media index-selection engine, ported from
// discord-joe (instagramHandler's selector block, minus the Instagram-only
// -s/-t OCR flags). One implementation for every platform handler so the
// selector semantics can no longer drift between Instagram/Facebook/Telegram/
// TikTok (they previously had three divergent copies — e.g. a single "-2"
// meant "drop last two" on Instagram but "exclude item 2" on Facebook).
//
// Selector syntax (tokens next to the link in the user's message):
//   +N / N -> keep ONLY the Nth item (bare N only when the text section has
//             no word characters — numbers inside sentences stay text)
//   -N     -> EXCLUDE the Nth item (1-based)
//   -l / -л / -п -> EXCLUDE the last item
//   N-M, <N, <=N, >N, >=N -> keep-set ranges (intersection of all of them;
//             ranges inside sentences are ignored like bare numbers)
//
// NOTE: Cyrillic tokens can't rely on \b — JS word boundaries only consider
// [A-Za-z0-9_], so `-л\b` never matches a standalone "-л". Cyrillic
// alternatives use an explicit negative lookahead instead.

const LAST_REMOVE_ALIASES = new Set(['-l', '-л', '-п']);
const INDEX_TOKEN_RE = /(?:^|(?<=[\s,]))(?:(?:\d+\s*-\s*\d+|[+-]?\d+|[<>]=?\d+|=?[<>]\d+|-l)\b|(?:-л|-п)(?![0-9a-zа-яё_]))/gi;

/**
 * Apply index selectors found around `url` inside `remadeContent` to the
 * attachments array.
 *
 * @param {string} remadeContent - full message text containing the URL
 * @param {string} url - the platform URL (used to split before/after sections)
 * @param {Array} attachments - downloaded attachments (1-based selection)
 * @returns {{attachments: Array, cleanedRemadeContent: string, applied: boolean}}
 */
function applyIndexSelection(remadeContent, url, attachments) {
    const urlIndex = remadeContent.indexOf(url);
    if (urlIndex === -1) {
        return { attachments, cleanedRemadeContent: remadeContent, applied: false };
    }
    let beforeUrl = remadeContent.substring(0, urlIndex);
    let afterUrl = remadeContent.substring(urlIndex + url.length);

    let rangeSelectors = []; // { type: 'range'|'lt'|'lte'|'gt'|'gte', a?, b?, n? }
    const parseMatches = (matches, sourceText) => {
        const hasWordChars = /[a-zа-яё]/i.test(sourceText || '');
        const result = [];
        for (const m of matches) {
            const str = m[0].toLowerCase().replace(/\s+/g, '');
            if (LAST_REMOVE_ALIASES.has(str)) {
                result.push({ isLast: true, isNegative: true });
            } else if (/^\d+\s*-\s*\d+$/.test(str)) {
                if (hasWordChars) continue; // "с 2020-2025 годов" is text
                const parts = str.split('-').map(s => parseInt(s, 10));
                rangeSelectors.push({ type: 'range', a: Math.min(parts[0], parts[1]), b: Math.max(parts[0], parts[1]) });
            } else if (/^[<>]=?\d+$/.test(str) || /^=?[<>]\d+$/.test(str)) {
                const lt = str.includes('<');
                const lte = str.includes('<=') || str.includes('=<');
                const gte = str.includes('>=') || str.includes('=>');
                const num = parseInt(str.replace(/[^0-9]/g, ''), 10);
                if (lt) rangeSelectors.push({ type: lte ? 'lte' : 'lt', n: num });
                else rangeSelectors.push({ type: gte ? 'gte' : 'gt', n: num });
            } else {
                const val = Math.abs(parseInt(str, 10));
                const isNegative = str.startsWith('-');
                const isExplicitPositive = str.startsWith('+');
                if (!isNegative && !isExplicitPositive && hasWordChars) continue;
                result.push({ val, isNegative, isLast: false });
            }
        }
        return result;
    };

    const beforeNumbers = parseMatches([...beforeUrl.matchAll(INDEX_TOKEN_RE)], beforeUrl);
    const afterNumbers = parseMatches([...afterUrl.matchAll(INDEX_TOKEN_RE)], afterUrl);
    const numbers = [...beforeNumbers, ...afterNumbers];

    if (numbers.length === 0 && rangeSelectors.length === 0) {
        return { attachments, cleanedRemadeContent: remadeContent, applied: false };
    }

    const total = attachments.length;
    let keepSet = null; // null = no range constraint
    for (const sel of rangeSelectors) {
        let selSet = new Set();
        if (sel.type === 'range') {
            for (let idx = sel.a; idx <= sel.b; idx++) { if (idx >= 1 && idx <= total) selSet.add(idx); }
        } else if (sel.type === 'lt') {
            for (let idx = 1; idx < sel.n; idx++) { if (idx <= total) selSet.add(idx); }
        } else if (sel.type === 'lte') {
            for (let idx = 1; idx <= sel.n; idx++) { if (idx <= total) selSet.add(idx); }
        } else if (sel.type === 'gt') {
            for (let idx = sel.n + 1; idx <= total; idx++) selSet.add(idx);
        } else if (sel.type === 'gte') {
            for (let idx = sel.n; idx <= total; idx++) selSet.add(idx);
        }
        keepSet = keepSet === null ? selSet : new Set([...keepSet].filter(x => selSet.has(x)));
    }

    const positiveIndices = numbers.filter(n => !n.isNegative).map(n => n.val);
    const excludeIndices = new Set();
    for (const n of numbers.filter(x => x.isNegative)) {
        excludeIndices.add(n.isLast ? attachments.length : n.val);
    }

    let out = attachments;
    if (keepSet !== null) out = out.filter((_, idx) => keepSet.has(idx + 1));
    if (positiveIndices.length > 0) out = out.filter((_, idx) => positiveIndices.includes(idx + 1));
    out = out.filter((_, idx) => !excludeIndices.has(idx + 1));
    // Preserve marker properties set on the original array (e.g.
    // isRestrictedVideoFallback) — .filter() returns a fresh array.
    if (attachments.isRestrictedVideoFallback) out.isRestrictedVideoFallback = true;

    // Strip only the tokens that actually acted as selectors — bare numbers
    // and ranges inside sentences must stay in the reposted text.
    const usedTokens = new Set();
    for (const sectionText of [beforeUrl, afterUrl]) {
        const sectionHasWords = /[a-zа-яё]/i.test(sectionText || '');
        for (const m of sectionText.matchAll(INDEX_TOKEN_RE)) {
            const str = m[0].toLowerCase().replace(/\s+/g, '');
            if (LAST_REMOVE_ALIASES.has(str)) {
                usedTokens.add(m[0]);
            } else if (/^\d+\s*-\s*\d+$/.test(str)) {
                if (!sectionHasWords) usedTokens.add(m[0]);
            } else if (/^[+-]/.test(str) || /^[<>]=?/.test(str) || /^=?[<>]/.test(str)) {
                usedTokens.add(m[0]);
            } else if (/^\d+$/.test(str)) {
                if (!sectionHasWords) usedTokens.add(m[0]);
            }
        }
    }
    const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cleanSection = (text) => {
        let cleaned = text;
        for (const token of usedTokens) {
            const tail = /[a-z0-9_]$/i.test(token) ? '\\b' : '(?![0-9a-zа-яё_])';
            cleaned = cleaned.replace(new RegExp('(?:^|(?<=[\\s,]))' + escapeRe(token) + tail, 'gi'), '');
        }
        return cleaned.replace(/[,\s]+/g, ' ').trim();
    };
    beforeUrl = cleanSection(beforeUrl);
    afterUrl = cleanSection(afterUrl);
    const cleanedRemadeContent = (beforeUrl ? beforeUrl + ' ' : '') + url + (afterUrl ? ' ' + afterUrl : '');

    return { attachments: out, cleanedRemadeContent, applied: true };
}

module.exports = { applyIndexSelection, INDEX_TOKEN_RE, LAST_REMOVE_ALIASES };
