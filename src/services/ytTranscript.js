// YouTube transcript fetch via yt-dlp subtitle/caption extraction. Ported
// verbatim from discord-joe's src/services/ytTranscript.js so the librarian
// bot's TL;DW feature behaves the same way (no YouTube Data API, no
// third-party transcript scraper — just yt-dlp's own subtitle download).
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

    let chosenLang = null;
    let isAuto = false;

    const manualSubs = metadata.subtitles || {};
    const autoSubs = metadata.automatic_captions || {};

    // 1. Prioritize manual subtitles
    if (manualSubs.ru) {
        chosenLang = 'ru';
    } else if (manualSubs.en) {
        chosenLang = 'en';
    } else {
        const manualKeys = Object.keys(manualSubs);
        if (manualKeys.length > 0) {
            chosenLang = manualKeys[0];
        }
    }

    // 2. Check original auto-generated subtitles (no tlang parameter in URL to avoid 429)
    if (!chosenLang) {
        let originalAutoLangs = [];
        for (const [lang, tracks] of Object.entries(autoSubs)) {
            if (Array.isArray(tracks) && tracks.length > 0) {
                const url = tracks[0].url || '';
                if (!url.includes('tlang=')) {
                    originalAutoLangs.push(lang);
                }
            }
        }

        const ruOrig = originalAutoLangs.find(l => l.startsWith('ru'));
        const enOrig = originalAutoLangs.find(l => l.startsWith('en'));
        if (ruOrig) {
            chosenLang = ruOrig;
            isAuto = true;
        } else if (enOrig) {
            chosenLang = enOrig;
            isAuto = true;
        } else if (originalAutoLangs.length > 0) {
            chosenLang = originalAutoLangs[0];
            isAuto = true;
        }
    }

    if (!chosenLang) {
        throw new Error('No safe (non-translated) subtitles found for this video');
    }

    console.log(`[YouTube Transcript] Selected language: ${chosenLang} (Auto-generated: ${isAuto})`);

    const outputPattern = path.join(tempDir, `sub_${videoId}_${Date.now()}`);
    const ytDlpCmd = `"${ytDlp}" --write-subs --write-auto-sub --sub-lang "${chosenLang}" --skip-download --output "${outputPattern}.%(ext)s" "https://www.youtube.com/watch?v=${videoId}"`;

    await runCommand(ytDlpCmd);

    const files = fs.readdirSync(tempDir);
    const subFile = files.find(f => f.startsWith(path.basename(outputPattern)) && f.endsWith('.vtt'));
    if (!subFile) {
        throw new Error(`Subtitle download failed, no .vtt file found`);
    }

    const subFilePath = path.join(tempDir, subFile);
    const vttContent = fs.readFileSync(subFilePath, 'utf8');
    try { fs.unlinkSync(subFilePath); } catch (e) { }

    return cleanVtt(vttContent);
}

module.exports = {
    cleanVtt,
    findYtDlpPath,
    getYoutubeTranscript
};
