// YouTube transcript fetch via yt-dlp subtitle/caption extraction. Ported
// from heyrobot-discord-bot's src/services/ytTranscript.js so the librarian
// bot's TL;DW feature behaves the same way (no YouTube Data API, no
// third-party transcript scraper — just yt-dlp's own subtitle download).
// Kept in sync with the heyrobot copy, including the 2026-11-24 fix that stops
// `live_chat` (stream chat replay JSON) being picked as a subtitle language.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runCommand } = require('../utils/shell');

function cleanVtt(vttContent) {
    const lines = vttContent.split(/\r?\n/);
    let cleanLines = [];
    let lastLine = '';

    for (let line of lines) {
        line = line.trim();
        if (
            line.startsWith('WEBVTT') ||
            line.startsWith('Kind:') ||
            line.startsWith('Language:') ||
            line.startsWith('Style:') ||
            line.includes('-->') ||
            line === ''
        ) {
            continue;
        }

        let text = line.replace(/<[^>]+>/g, '').trim();
        // Strip YouTube auto-caption artifacts:
        //  - ">> " speaker-turn markers (Discord renders ">" as blockquote)
        //  - "[  ]" / "[ ]" / "[]" / "[__]" / "[♪]" censored-word placeholders
        //    (use Unicode property escapes to catch ANY non-text bracket content)
        text = text.replace(/^>>+\s*/g, '').replace(/>>+\s*/g, ' ');
        text = text.replace(/\[[^\p{L}\p{N}]*?\]/gu, ' [...] ');
        // Strip standalone underscore runs (YouTube uses "__" for inaudible;
        // Discord renders "__text__" as underlined text)
        text = text.replace(/_{2,}/g, ' [...] ');
        text = text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&nbsp;/g, ' ');

        if (!text) continue;

        if (text !== lastLine) {
            cleanLines.push(text);
            lastLine = text;
        }
    }

    return cleanLines.join(' ');
}

// YouTube also lists non-caption entries under `metadata.subtitles`:
// `live_chat` is the stream chat replay, downloaded as JSON. Treating it as a
// subtitle language made streamed videos fail with "no .vtt file found"
// (2026-11-24, video O8yWDJDyu70: live_chat was the only manual entry, while
// ru-orig/en-orig auto captions were available).
const NON_CAPTION_SUB_LANGS = new Set(['live_chat', 'live_chat_replay']);
const CAPTION_EXTS = new Set(['vtt', 'srt', 'ttml', 'json3', 'srv1', 'srv2', 'srv3']);

function isCaptionLanguage(lang, tracks) {
    if (!lang || NON_CAPTION_SUB_LANGS.has(lang)) return false;
    if (!Array.isArray(tracks) || tracks.length === 0) return false;
    return tracks.some(t => t && CAPTION_EXTS.has(t.ext));
}

// Pick a real subtitle track from yt-dlp metadata.
// Manual subs win; then auto captions whose URL has no `tlang=` (translated
// auto tracks are the ones YouTube rate-limits with 429).
function chooseSubtitleLanguage(metadata) {
    const manualSubs = (metadata && metadata.subtitles) || {};
    const autoSubs = (metadata && metadata.automatic_captions) || {};

    const manualLangs = Object.keys(manualSubs).filter(l => isCaptionLanguage(l, manualSubs[l]));
    if (manualLangs.includes('ru')) return { lang: 'ru', isAuto: false };
    if (manualLangs.includes('en')) return { lang: 'en', isAuto: false };
    if (manualLangs.length > 0) return { lang: manualLangs[0], isAuto: false };

    const originalAutoLangs = Object.keys(autoSubs).filter(l => {
        if (!isCaptionLanguage(l, autoSubs[l])) return false;
        return autoSubs[l].every(t => !((t && t.url) || '').includes('tlang='));
    });

    const ruOrig = originalAutoLangs.find(l => l.startsWith('ru'));
    const enOrig = originalAutoLangs.find(l => l.startsWith('en'));
    if (ruOrig) return { lang: ruOrig, isAuto: true };
    if (enOrig) return { lang: enOrig, isAuto: true };
    if (originalAutoLangs.length > 0) return { lang: originalAutoLangs[0], isAuto: true };
    return { lang: null, isAuto: false };
}

function findYtDlpPath() {
    const paths = [
        '/opt/homebrew/bin/yt-dlp',
        '/usr/local/bin/yt-dlp',
        '/usr/bin/yt-dlp'
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }
    return 'yt-dlp'; // fallback
}

async function getYoutubeTranscript(videoId) {
    const tempDir = os.tmpdir();
    const metadataPath = path.join(tempDir, `meta_${videoId}_${Date.now()}.json`);
    const ytDlp = findYtDlpPath();

    console.log(`[YouTube Transcript] Fetching metadata for video ${videoId} using ${ytDlp}...`);
    await runCommand(`"${ytDlp}" --dump-json "https://www.youtube.com/watch?v=${videoId}" > "${metadataPath}"`);

    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    try { fs.unlinkSync(metadataPath); } catch (e) { }

    const { lang: chosenLang, isAuto } = chooseSubtitleLanguage(metadata);
    if (!chosenLang) {
        throw new Error('No safe (non-translated) subtitles found for this video');
    }

    console.log(`[YouTube Transcript] Selected language: ${chosenLang} (Auto-generated: ${isAuto})`);

    const outputPattern = path.join(tempDir, `sub_${videoId}_${Date.now()}`);
    const subsFlag = isAuto ? '--write-auto-sub' : '--write-subs';
    const ytDlpCmd = `"${ytDlp}" ${subsFlag} --sub-langs "${chosenLang}" --skip-download --output "${outputPattern}.%(ext)s" "https://www.youtube.com/watch?v=${videoId}"`;

    await runCommand(ytDlpCmd);

    const files = fs.readdirSync(tempDir);
    const subFile = files.find(f => f.startsWith(path.basename(outputPattern)) && f.endsWith('.vtt'));
    if (!subFile) {
        throw new Error(`Subtitle download failed, no .vtt file found`);
    }

    const subFilePath = path.join(tempDir, subFile);
    const vttContent = fs.readFileSync(subFilePath, 'utf8');
    try { fs.unlinkSync(subFilePath); } catch (e) { }

    return { transcript: cleanVtt(vttContent), title: (metadata.title || '').trim() };
}

module.exports = {
    cleanVtt,
    findYtDlpPath,
    getYoutubeTranscript,
    chooseSubtitleLanguage
};
