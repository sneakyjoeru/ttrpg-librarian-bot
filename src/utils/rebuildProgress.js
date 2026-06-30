// Robust parsing for Docker build progress lines used by /restart status updates.
// Ported from robot-joe (identical). Keep this logic centralized so future
// output-format changes don't silently break percentage reporting in chat.

const ANSI_REGEX = /\u001b\[[0-9;]*[A-Za-z]/g;

function stripAnsi(input) {
    if (!input) return '';
    return String(input).replace(ANSI_REGEX, '');
}

function toPercent(current, total, floor = 0) {
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;
    const raw = Math.floor((current * 100) / total);
    const clamped = Math.max(0, Math.min(100, raw));
    return Math.max(floor, clamped);
}

// Returns null when the line has no usable progress signal.
// On success returns:
//   { percent, current, total, stageLabel }
function parseRebuildProgressLine(line, lastPercent = 0) {
    const clean = stripAnsi(line || '').trim();
    if (!clean) return null;

    // BuildKit + legacy variants (spaces allowed):
    //   "#9 [4/18] ..."
    //   "#9 [builder 4/18] ..."
    //   "#9 [linux/amd64 builder 4/18] ..."
    //   "#9 [ 4 / 18 ] ..."
    //   "(4/18)"
    //   "( 4 / 18 )"
    //   "Step 4/18 : ..."
    let m = clean.match(/\[[^\]]*?(\d+)\s*\/\s*(\d+)[^\]]*?\]/);
    if (!m) {
        m = clean.match(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)/);
    }
    if (!m) {
        m = clean.match(/Step\s+(\d+)\s*\/\s*(\d+)/i);
    }
    if (m) {
        const current = parseInt(m[1], 10);
        const total = parseInt(m[2], 10);
        const percent = toPercent(current, total, lastPercent);
        if (percent !== null) {
            return {
                percent,
                current,
                total,
                stageLabel: `${current}/${total}`
            };
        }
    }

    // Fallback if output includes explicit percentages.
    const pm = clean.match(/(?:progress\s*[:=]\s*)?(\d{1,3})\s*%/i);
    if (pm) {
        const rawPercent = parseInt(pm[1], 10);
        if (Number.isFinite(rawPercent)) {
            return {
                percent: Math.max(lastPercent, Math.max(0, Math.min(100, rawPercent))),
                current: null,
                total: null,
                stageLabel: null
            };
        }
    }

    return null;
}

module.exports = {
    parseRebuildProgressLine,
    stripAnsi
};