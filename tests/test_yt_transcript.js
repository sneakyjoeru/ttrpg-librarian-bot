'use strict';
/**
 * Unit tests for src/services/ytTranscript.js — subtitle language selection.
 * No network: builds yt-dlp-shaped metadata fixtures.
 * Run: node tests/test_yt_transcript.js
 *
 * Regression: video O8yWDJDyu70 (2026-11-24) listed `live_chat` as its only
 * manual "subtitle"; the bot tried to download it, got JSON, found no .vtt and
 * answered "Could not fetch subtitles" while ru-orig/en-orig auto captions were
 * available.
 */
const assert = require('assert');
const { chooseSubtitleLanguage } = require('../src/services/ytTranscript');

// Track shapes as yt-dlp reports them.
const vtt = (tlang) => ({ ext: 'vtt', url: `https://example/sub?v=1${tlang ? `&tlang=${tlang}` : ''}` });
const json = () => ({ ext: 'json', url: 'https://example/live_chat' });

let passed = 0;
function t(name, fn) {
    try { fn(); passed++; console.log(`  ok - ${name}`); }
    catch (e) { console.error(`  FAIL - ${name}`); console.error(e); process.exitCode = 1; }
}

console.log('chooseSubtitleLanguage');

t('ignores live_chat and picks the ru-orig auto caption (real O8yWDJDyu70 shape)', () => {
    const metadata = {
        subtitles: { live_chat: [json()] },
        automatic_captions: {
            ab: [vtt('ab')],
            ru: [vtt('ru')],
            'ru-orig': [vtt()],
            'en-orig': [vtt()],
        },
    };
    assert.deepStrictEqual(chooseSubtitleLanguage(metadata), { lang: 'ru-orig', isAuto: true });
});

t('returns no language when only live_chat exists and no auto captions', () => {
    const metadata = { subtitles: { live_chat: [json()] }, automatic_captions: {} };
    assert.deepStrictEqual(chooseSubtitleLanguage(metadata), { lang: null, isAuto: false });
});

t('manual ru wins over live_chat and auto captions', () => {
    const metadata = {
        subtitles: { live_chat: [json()], ru: [vtt()] },
        automatic_captions: { 'ru-orig': [vtt()] },
    };
    assert.deepStrictEqual(chooseSubtitleLanguage(metadata), { lang: 'ru', isAuto: false });
});

t('manual en wins over other manual languages', () => {
    const metadata = {
        subtitles: { de: [vtt()], en: [vtt()], live_chat: [json()] },
        automatic_captions: {},
    };
    assert.deepStrictEqual(chooseSubtitleLanguage(metadata), { lang: 'en', isAuto: false });
});

t('falls back to the first manual caption language, never to live_chat', () => {
    const metadata = {
        subtitles: { live_chat: [json()], de: [vtt()] },
        automatic_captions: {},
    };
    assert.deepStrictEqual(chooseSubtitleLanguage(metadata), { lang: 'de', isAuto: false });
});

t('skips auto captions that only exist as translated tlang URLs', () => {
    const metadata = {
        subtitles: {},
        automatic_captions: { ru: [vtt('ru')], en: [vtt('en')], de: [vtt('de')] },
    };
    assert.deepStrictEqual(chooseSubtitleLanguage(metadata), { lang: null, isAuto: false });
});

t('prefers en-orig over an unrelated original-language auto track', () => {
    const metadata = {
        subtitles: {},
        automatic_captions: { 'ko-orig': [vtt()], 'en-orig': [vtt()] },
    };
    assert.deepStrictEqual(chooseSubtitleLanguage(metadata), { lang: 'en-orig', isAuto: true });
});

t('tolerates missing metadata fields', () => {
    assert.deepStrictEqual(chooseSubtitleLanguage({}), { lang: null, isAuto: false });
    assert.deepStrictEqual(chooseSubtitleLanguage(null), { lang: null, isAuto: false });
});

console.log(`\n${passed} passed`);
