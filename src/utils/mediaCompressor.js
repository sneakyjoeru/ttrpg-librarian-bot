const fs = require('fs');
const path = require('path');
const os = require('os');
const { runCommand, buildSshPrefix, hasRemoteAccess, runCommandWithProgress } = require('./shell');
const { hasSupportedIgpu } = require('./cpuDetector');
const {
    FFMPEG_TIMEOUT,
    DISCORD_FILE_LIMIT_DEFAULT,
    IGPU_RENDER_NODE,
    IGPU_VIDEO_BITRATE_MULTIPLIERS,
    IGPU_MAX_VIDEO_BITRATE,
    IGPU_MIN_VIDEO_BITRATE
} = require('../config');

// Local exec helper that keeps stderr on success — cropdetect writes its
// crop= suggestions to stderr. (shell.runCommand only surfaces stdout.)
const { exec } = require('child_process');
function runCommandWithStderr(cmd, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && error.killed) return reject(new Error(`Command timed out after ${timeoutMs}ms`));
            // ffmpeg -f null exits 0; treat non-zero as failure but still hand
            // back stderr for diagnostics.
            if (error && !stderr) return reject(error);
            resolve({ stdout: stdout || '', stderr: stderr || '' });
        });
    });
}

/**
 * Detects the bounding box of the actual video CONTENT vs a static border of
 * any color, and builds a crop for the transcode. Two ffmpeg passes:
 *
 *  1. MOTION box — consecutive-frame differences (tblend=all_mode=difference)
 *     are black wherever the picture is static and bright where it moves; an
 *     accumulating cropdetect (reset=0) on that stream finds where the image
 *     changes over time.
 *  2. DETAIL box — edgedetect + cropdetect on sampled original frames. Static
 *     text or graphics anywhere produce edges, plain borders (black, white,
 *     any solid color or smooth gradient) do not.
 *
 * The final crop is the UNION of the two boxes: borders around the actual
 * content are removed, but static background text is kept in the final video
 * (the librarian has no OCR, so "has detail" is the text heuristic).
 *
 * Returns {x,y,w,h} (even-rounded) or null when no worthwhile crop exists.
 */

/**
 * Blurred/zoomed-copy background padding via STRONG-edge analysis: only the
 * real content (and sharp overlay text) survives edgedetect(0.3/0.5), a
 * blurred copy does not. Crop applied per axis, only when BOTH margins clear
 * MIN_MARGIN (blur padding is roughly centered). Raw x1/x2/y1/y2 bounds are
 * parsed since the crop= suggestion can go negative on an axis with no
 * strong edges.
 */
async function detectBlurredPaddingCrop(inputPath, duration, videoWidth, videoHeight) {
    if (duration <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
    const MIN_MARGIN = 40;
    const PAD = 16;
    const span = Math.min(2, duration);
    const starts = duration > 8 ? [0.2, 0.5, 0.8].map(p => p * duration) : [0];
    let x1 = null, x2 = null, y1 = null, y2 = null;
    for (const start of starts) {
        try {
            const t = Math.min(span, Math.max(0.5, duration - start));
            const cmd = `ffmpeg -ss ${start.toFixed(3)} -t ${t.toFixed(3)} -i "${inputPath}" ` +
                `-vf "edgedetect=low=0.3:high=0.5,cropdetect=limit=16:round=2:reset=0" -an -f null -`;
            const res = await runCommandWithStderr(cmd, 30000);
            const matches = [...res.stderr.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)];
            if (!matches.length) continue;
            const m = matches[matches.length - 1];
            const [sx1, sx2, sy1, sy2] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), parseInt(m[4])];
            if (sx1 <= sx2) { x1 = x1 === null ? sx1 : Math.min(x1, sx1); x2 = x2 === null ? sx2 : Math.max(x2, sx2); }
            if (sy1 <= sy2) { y1 = y1 === null ? sy1 : Math.min(y1, sy1); y2 = y2 === null ? sy2 : Math.max(y2, sy2); }
        } catch (err) {
            console.warn(`[Media Crop] Sharp-edge window at ${start.toFixed(2)}s failed:`, err.message);
        }
    }
    if (y1 === null && x1 === null) return null;
    // Per-axis: both margins must clear MIN_MARGIN and be roughly symmetric
    // (≤3x) — blur padding is centered; a lopsided margin is usually smooth
    // REAL content near one frame edge.
    let fx = 0, fw = videoWidth, fy = 0, fh = videoHeight;
    if (x1 !== null) {
        const mL = x1, mR = videoWidth - 1 - x2;
        if (mL >= MIN_MARGIN && mR >= MIN_MARGIN && Math.max(mL, mR) / Math.max(1, Math.min(mL, mR)) <= 3) {
            fx = Math.max(0, x1 - PAD);
            fw = Math.min(videoWidth - fx, (x2 + PAD) - fx + 1);
        }
    }
    if (y1 !== null) {
        const mT = y1, mB = videoHeight - 1 - y2;
        if (mT >= MIN_MARGIN && mB >= MIN_MARGIN && Math.max(mT, mB) / Math.max(1, Math.min(mT, mB)) <= 3) {
            fy = Math.max(0, y1 - PAD);
            fh = Math.min(videoHeight - fy, (y2 + PAD) - fy + 1);
        }
    }
    if (fx === 0 && fy === 0 && fw === videoWidth && fh === videoHeight) return null;
    const areaShare = (fw * fh) / (videoWidth * videoHeight);
    if (areaShare > 0.92 || areaShare < 0.25) return null;
    // ASPECT SANITY: the inner video of a blur-pad has a real video shape;
    // out-of-range results are false positives on smooth real content.
    const aspect = fw / fh;
    if (aspect < 0.5 || aspect > 2.0) {
        console.log(`[Media Crop] Sharp-content box aspect ${aspect.toFixed(2)} is not a plausible video shape — skipping blur-pad crop.`);
        return null;
    }
    const box = {
        x: Math.round(fx / 2) * 2,
        y: Math.round(fy / 2) * 2,
        w: Math.max(64, Math.round(fw / 2) * 2),
        h: Math.max(64, Math.round(fh / 2) * 2),
    };
    console.log(`[Media Crop] Blurred-padding crop detected (strong edges): ${box.w}x${box.h} at ${box.x},${box.y} (${(areaShare * 100).toFixed(0)}% of frame).`);
    return box;
}


/**
 * Value-based letterbox detection for mostly-still videos (where the motion
 * box cannot be trusted): per sampled frame, cropdetect finds near-BLACK
 * margins and a negated pass finds near-WHITE margins; the content box is
 * their intersection, aggregated across frames, then expanded over the
 * strong-edge bounds so border text survives.
 */
async function detectValueLetterboxCrop(inputPath, duration, videoWidth, videoHeight) {
    if (duration <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
    const crops = [];
    for (const pfrac of [0.2, 0.5, 0.8]) {
        const time = pfrac * duration;
        try {
            const detect = async (vf) => {
                const res = await runCommandWithStderr(
                    `ffmpeg -ss ${time.toFixed(3)} -i "${inputPath}" -vframes 1 -vf "${vf}" -f null -`, 15000);
                const m = res.stderr.match(/crop=(\d+):(\d+):(\d+):(\d+)/);
                if (!m) return null;
                const b = { w: parseInt(m[1]), h: parseInt(m[2]), x: parseInt(m[3]), y: parseInt(m[4]) };
                return (b.w > 0 && b.h > 0) ? b : null;
            };
            const blackBox = await detect('cropdetect=limit=24:round=2');
            const whiteBox = await detect('negate,cropdetect=limit=24:round=2');
            let frameBox = null;
            if (blackBox && whiteBox) {
                const x = Math.max(blackBox.x, whiteBox.x);
                const y = Math.max(blackBox.y, whiteBox.y);
                const right = Math.min(blackBox.x + blackBox.w, whiteBox.x + whiteBox.w);
                const bottom = Math.min(blackBox.y + blackBox.h, whiteBox.y + whiteBox.h);
                if (right - x > 0 && bottom - y > 0) frameBox = { x, y, w: right - x, h: bottom - y };
            } else {
                frameBox = blackBox || whiteBox;
            }
            crops.push(frameBox || { x: 0, y: 0, w: videoWidth, h: videoHeight });
        } catch (err) {
            crops.push({ x: 0, y: 0, w: videoWidth, h: videoHeight });
        }
    }
    if (!crops.length) return null;
    let x = Math.max(0, Math.min(...crops.map(c => c.x)));
    let y = Math.max(0, Math.min(...crops.map(c => c.y)));
    let right = Math.max(...crops.map(c => c.x + c.w));
    let bottom = Math.max(...crops.map(c => c.y + c.h));
    // Border text protection: expand over strong-edge bounds.
    try {
        const span = Math.min(2, duration);
        const res = await runCommandWithStderr(
            `ffmpeg -ss ${(0.4 * duration).toFixed(3)} -t ${span.toFixed(3)} -i "${inputPath}" ` +
            `-vf "edgedetect=low=0.3:high=0.5,cropdetect=limit=16:round=2:reset=0" -an -f null -`, 30000);
        const ms = [...res.stderr.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)];
        if (ms.length) {
            const m = ms[ms.length - 1];
            const [ex1, ex2, ey1, ey2] = [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), parseInt(m[4])];
            if (ex1 <= ex2) { x = Math.min(x, ex1); right = Math.max(right, ex2 + 1); }
            if (ey1 <= ey2) { y = Math.min(y, ey1); bottom = Math.max(bottom, ey2 + 1); }
        }
    } catch (_) {}
    const w = Math.min(videoWidth - x, right - x);
    const h = Math.min(videoHeight - y, bottom - y);
    if (w <= 0 || h <= 0) return null;
    if (x <= 8 && y <= 8 && w >= videoWidth - 16 && h >= videoHeight - 16) return null;
    const share = (w * h) / (videoWidth * videoHeight);
    if (share > 0.92 || share < 0.25) return null;
    const box = {
        x: Math.round(x / 2) * 2, y: Math.round(y / 2) * 2,
        w: Math.max(64, Math.round(w / 2) * 2), h: Math.max(64, Math.round(h / 2) * 2),
    };
    console.log(`[Media Crop] Value letterbox crop (mostly-still video): ${box.w}x${box.h} at ${box.x},${box.y} (${(share * 100).toFixed(0)}%).`);
    return box;
}

async function tightenUniformPadding(inputPath, duration, W, H) {
    if (duration <= 0 || W <= 0 || H <= 0) return null;
    const BAND = 10;
    const UNIFORM_SPREAD = 42;   // YHIGH-YLOW within a padding band
    const COLOR_TOL = 26;        // band YAVG vs the edge's own colour
    const times = duration > 6 ? [0.25, 0.5, 0.75].map(p => p * duration) : [Math.min(1, duration / 2)];

    // signalstats of a crop region → {avg, low, high} luma, or null.
    const stats = async (crop, t) => {
        try {
            const cmd = `ffmpeg -ss ${t.toFixed(3)} -i "${inputPath}" -vframes 1 -vf "crop=${crop},signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" -f null - 2>&1`;
            const res = await runCommandWithStderr(
                `ffmpeg -ss ${t.toFixed(3)} -i "${inputPath}" -vframes 1 -vf "crop=${crop},signalstats,metadata=print" -f null -`, 12000);
            const out = res.stderr;
            const g = (k) => { const m = out.match(new RegExp('lavfi\\.signalstats\\.' + k + '=([\\d.]+)')); return m ? parseFloat(m[1]) : null; };
            const avg = g('YAVG'), low = g('YLOW'), high = g('YHIGH');
            if (avg === null) return null;
            return { avg, low: low === null ? avg : low, high: high === null ? avg : high };
        } catch (_) { return null; }
    };

    // Trim px from one edge for one timestamp. edge: 'top'|'bottom'|'left'|'right'.
    const trimEdgeAt = async (edge, t) => {
        const vert = edge === 'top' || edge === 'bottom';
        const limit = Math.floor((vert ? H : W) * 0.45); // never trim past 45%
        let edgeColor = null;
        let trimmed = 0;
        for (let off = 0; off + BAND <= limit; off += BAND) {
            let crop;
            if (edge === 'top') crop = `${W}:${BAND}:0:${off}`;
            else if (edge === 'bottom') crop = `${W}:${BAND}:0:${H - BAND - off}`;
            else if (edge === 'left') crop = `${BAND}:${H}:${off}:0`;
            else crop = `${BAND}:${H}:${W - BAND - off}:0`;
            const s = await stats(crop, t);
            if (!s) break;
            if (edgeColor === null) edgeColor = s.avg;
            const uniform = (s.high - s.low) <= UNIFORM_SPREAD;
            const sameColor = Math.abs(s.avg - edgeColor) <= COLOR_TOL;
            if (uniform && sameColor) trimmed = off + BAND;
            else break;
        }
        return trimmed;
    };

    const minTrim = { top: Infinity, bottom: Infinity, left: Infinity, right: Infinity };
    for (const t of times) {
        for (const edge of ['top', 'bottom', 'left', 'right']) {
            const v = await trimEdgeAt(edge, t);
            if (v < minTrim[edge]) minTrim[edge] = v;
        }
    }
    for (const k of Object.keys(minTrim)) if (!isFinite(minTrim[k])) minTrim[k] = 0;

    // Preserve a breathing-room MARGIN on any trimmed edge — never crop flush
    // to the text/content pixels. Only applied where there was padding to trim.
    const MARGIN = 14;
    for (const k of Object.keys(minTrim)) {
        if (minTrim[k] > 0) minTrim[k] = Math.max(0, minTrim[k] - MARGIN);
    }

    const x = Math.round(minTrim.left / 2) * 2;
    const y = Math.round(minTrim.top / 2) * 2;
    const w = Math.round((W - minTrim.left - minTrim.right) / 2) * 2;
    const h = Math.round((H - minTrim.top - minTrim.bottom) / 2) * 2;
    if (x <= 4 && y <= 4 && w >= W - 8 && h >= H - 8) return null; // nothing to trim
    if (w < 64 || h < 64) return null;
    const share = (w * h) / (W * H);
    if (share < 0.20) return null; // implausible — bail
    console.log(`[Media Crop] Uniform-padding trim: ${w}x${h} at ${x},${y} (trims T${minTrim.top}/B${minTrim.bottom}/L${minTrim.left}/R${minTrim.right}).`);
    return { x, y, w, h };
}

/**
 * Public content crop for the transcode path: runs the core detector, then
 * trims any remaining UNIFORM padding (keeping a 14px margin) — the per-edge
 * intersection, so tightening only ever removes padding. Applies ONLY inside
 * compressVideoToFit (gated by media_transcode), never as a standalone pass.
 */
async function detectContentCrop(inputPath, duration, videoWidth, videoHeight) {
    let box = await _detectContentCropCore(inputPath, duration, videoWidth, videoHeight);
    try {
        const pad = await tightenUniformPadding(inputPath, duration, videoWidth, videoHeight);
        if (pad) {
            const base = box || { x: 0, y: 0, w: videoWidth, h: videoHeight };
            const x1 = Math.max(base.x, pad.x), y1 = Math.max(base.y, pad.y);
            const x2 = Math.min(base.x + base.w, pad.x + pad.w), y2 = Math.min(base.y + base.h, pad.y + pad.h);
            if (x2 - x1 >= 64 && y2 - y1 >= 64) {
                const t = { x: Math.round(x1 / 2) * 2, y: Math.round(y1 / 2) * 2,
                    w: Math.round((x2 - x1) / 2) * 2, h: Math.round((y2 - y1) / 2) * 2 };
                const trims = t.x > 0 || t.y > 0 || t.w < videoWidth - 8 || t.h < videoHeight - 8;
                if (trims) { console.log(`[Media Crop] Final box after padding-trim: ${t.w}x${t.h} at ${t.x},${t.y}.`); return t; }
            }
        }
    } catch (e) { console.warn('[Media Crop] Uniform-padding trim failed:', e.message); }
    return box;
}

async function _detectContentCropCore(inputPath, duration, videoWidth, videoHeight) {
    if (duration <= 0 || videoWidth <= 0 || videoHeight <= 0) return null;
    const parseLastCrop = (stderr) => {
        const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
        if (!matches.length) return null;
        const m = matches[matches.length - 1];
        return { w: parseInt(m[1]), h: parseInt(m[2]), x: parseInt(m[3]), y: parseInt(m[4]) };
    };
    const unionBoxes = (boxes) => {
        if (!boxes.length) return null;
        const x = Math.max(0, Math.min(...boxes.map(b => b.x)));
        const y = Math.max(0, Math.min(...boxes.map(b => b.y)));
        const w = Math.min(videoWidth - x, Math.max(...boxes.map(b => b.x + b.w)) - x);
        const h = Math.min(videoHeight - y, Math.max(...boxes.map(b => b.y + b.h)) - y);
        return (w > 0 && h > 0) ? { x, y, w, h } : null;
    };

    // Pass 1: motion box over up to three 4s windows.
    const span = Math.min(4, duration);
    const starts = duration > 14 ? [0.15, 0.5, 0.8].map(p => p * duration) : [0];
    const motionBoxes = [];
    for (const start of starts) {
        try {
            const t = Math.min(span, Math.max(0.5, duration - start));
            const cmd = `ffmpeg -ss ${start.toFixed(3)} -t ${t.toFixed(3)} -i "${inputPath}" ` +
                `-vf "tblend=all_mode=difference,cropdetect=limit=26:round=2:reset=0" -an -f null -`;
            const res = await runCommandWithStderr(cmd, 30000);
            const box = parseLastCrop(res.stderr);
            if (box) motionBoxes.push(box);
        } catch (err) {
            console.warn(`[Media Crop] Motion cropdetect window at ${start.toFixed(1)}s failed:`, err.message);
        }
    }
    const motionBox = unionBoxes(motionBoxes);
    const motionShare = motionBox ? (motionBox.w * motionBox.h) / (videoWidth * videoHeight) : 1;
    if (!motionBox || motionShare > 0.92) {
        // Motion everywhere (or nothing usable): the classic blur-padded copy
        // background moves with the video — try the strong-edge detector.
        console.log('[Media Crop] Motion covers the frame — checking for blurred-copy padding...');
        return await detectBlurredPaddingCrop(inputPath, duration, videoWidth, videoHeight);
    }
    if (motionShare < 0.25) {
        console.log(`[Media Crop] Motion box covers ${(motionShare * 100).toFixed(0)}% of the frame — mostly-still video, using value-based letterbox detection.`);
        return await detectValueLetterboxCrop(inputPath, duration, videoWidth, videoHeight);
    }

    // Pass 2: detail (edges/text) box over 5 sampled frames.
    const detailBoxes = [];
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        try {
            const cmd = `ffmpeg -ss ${(p * duration).toFixed(3)} -i "${inputPath}" -vframes 1 ` +
                `-vf "edgedetect=low=0.08:high=0.15,cropdetect=limit=24:round=2" -f null -`;
            const res = await runCommandWithStderr(cmd, 15000);
            const box = parseLastCrop(res.stderr);
            if (box) detailBoxes.push(box);
        } catch (err) {
            console.warn(`[Media Crop] Edge cropdetect at ${(p * 100).toFixed(0)}% failed:`, err.message);
        }
    }
    const detailBox = unionBoxes(detailBoxes);

    // Content = moving pixels ∪ static detail (text). Plain borders die.
    const finalBox = unionBoxes([motionBox, ...(detailBox ? [detailBox] : [])]);
    if (!finalBox) return null;
    const finalShare = (finalBox.w * finalBox.h) / (videoWidth * videoHeight);
    if (finalShare > 0.92) {
        console.log(`[Media Crop] Content (motion+detail) covers ${(finalShare * 100).toFixed(0)}% of the frame — not worth cropping.`);
        return null;
    }
    const x = Math.round(finalBox.x / 2) * 2;
    const y = Math.round(finalBox.y / 2) * 2;
    const w = Math.max(64, Math.round(finalBox.w / 2) * 2);
    const h = Math.max(64, Math.round(finalBox.h / 2) * 2);
    console.log(`[Media Crop] Auto-crop selected: ${w}x${h} at ${x},${y} ` +
        `(motion ${(motionShare * 100).toFixed(0)}%, final ${(finalShare * 100).toFixed(0)}% of ${videoWidth}x${videoHeight}).`);
    return { x, y, w, h };
}

/**
 * Returns the maximum file upload size in bytes for a Discord guild based on its boost tier.
 * @param {object|null} guild - The Discord guild object, or null for DMs.
 * @returns {number} Maximum file size in bytes.
 */
function getGuildFileLimit(guild) {
    if (!guild) return DISCORD_FILE_LIMIT_DEFAULT;
    switch (guild.premiumTier) {
        case 2: return 50 * 1024 * 1024;  // Tier 2 (7 boosts): 50MB
        case 3: return 100 * 1024 * 1024; // Tier 3 (14 boosts): 100MB
        default: return DISCORD_FILE_LIMIT_DEFAULT; // Tier 0 & 1: 10MB (safe default)
    }
}

/**
 * Computes a target video bitrate string (e.g. "1234k") for the given
 * multiplier of the size budget. Used by every VAAPI encode path so they
 * all converge on roughly the same ladder.
 */
function calculateTargetBitrate(targetSizeBytes, multiplier, duration) {
    if (duration <= 0) return '2M';
    const targetBits = targetSizeBytes * 8 * multiplier;
    const audioBitrate = 96 * 1000;
    const calculatedBitrate = Math.floor(targetBits / duration) - audioBitrate;
    const clampedBitrate = Math.max(IGPU_MIN_VIDEO_BITRATE, Math.min(IGPU_MAX_VIDEO_BITRATE, calculatedBitrate));
    return `${Math.floor(clampedBitrate / 1000)}k`;
}

/**
 * Builds a scale_vaapi filter string that targets 720p (in landscape) while
 * preserving aspect ratio. Same logic as the network path, factored out so
 * both VAAPI encoders share it.
 */
function buildVaapiScaleFilter(width, height) {
    if (width > 0 && height > 0) {
        let targetWidth, targetHeight;
        if (height > width) {
            // Portrait
            targetHeight = Math.min(720, height);
            targetHeight = Math.round(targetHeight / 2) * 2;
            targetWidth = Math.round((width * targetHeight / height) / 2) * 2;
        } else {
            // Landscape/Square
            if (width / height > 1280 / 720) {
                targetWidth = Math.min(1280, width);
                targetWidth = Math.round(targetWidth / 2) * 2;
                targetHeight = Math.round((height * targetWidth / width) / 2) * 2;
            } else {
                targetHeight = Math.min(720, height);
                targetHeight = Math.round(targetHeight / 2) * 2;
                targetWidth = Math.round((width * targetHeight / height) / 2) * 2;
            }
        }
        return `scale_vaapi=w=${targetWidth}:h=${targetHeight}`;
    }
    return 'scale_vaapi=w=-2:h=720';
}

/**
 * Attempts to compress a video buffer using ffmpeg to fit within the target size.
 * Tries progressively more aggressive CRF values until the output fits or all attempts fail.
 * 
 * @param {Buffer} inputBuffer - The raw video file buffer.
 * @param {string} inputExtension - The file extension of the input (e.g., 'mp4').
 * @param {number} targetSizeBytes - The maximum output file size in bytes.
 * @param {number} [timeoutMs] - Timeout for each ffmpeg attempt.
 * @returns {Promise<{buffer: Buffer, ext: string}|null>} The compressed buffer and extension, or null on failure.
 */
async function compressVideoToFit(inputBuffer, inputExtension, targetSizeBytes, timeoutMs, onProgress) {
    // media_transcode dashboard toggle: when off, behave like a failed
    // compression — callers drop the oversized file / fall back to a link,
    // exactly as when ffmpeg can't fit the target size.
    try {
        const { isDiscordFeatureEnabled } = require('../services/streamerJoe');
        if (!isDiscordFeatureEnabled('media_transcode')) {
            console.log('[MediaCompressor] media_transcode disabled via dashboard — skipping compression.');
            return null;
        }
    } catch (_) {}
    const timeout = timeoutMs || FFMPEG_TIMEOUT;
    const prefix = `ffcomp_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const tempDir = os.tmpdir();
    const inputPath = path.join(tempDir, `${prefix}_in.${inputExtension || 'mp4'}`);
    const outputPath = path.join(tempDir, `${prefix}_out.mp4`);

    // CRF values to try: 28 (decent), 33 (acceptable), 38 (low but watchable), 44 (potato but visible)
    const crfValues = [28, 33, 38, 44];

    try {
        fs.writeFileSync(inputPath, inputBuffer);
        const inputSize = inputBuffer.length;
        console.log(`[FFmpeg Compress] Input: ${(inputSize / 1024 / 1024).toFixed(1)}MB, target: ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB`);

        // Get video duration via ffprobe
        let duration = 0;
        try {
            const durationStr = await runCommand(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`);
            duration = parseFloat(durationStr.trim());
            if (isNaN(duration) || duration <= 0) {
                duration = 0;
            } else {
                console.log(`[FFmpeg Compress] Video duration parsed: ${duration.toFixed(2)}s`);
            }
        } catch (ffprobeErr) {
            console.warn('[FFmpeg Compress] Warning: failed to probe video duration with ffprobe:', ffprobeErr.message);
        }

        // Get video dimensions via ffprobe
        let width = 0;
        let height = 0;
        try {
            const dimStr = await runCommand(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "${inputPath}"`);
            const parts = dimStr.trim().split('x');
            if (parts.length === 2) {
                width = parseInt(parts[0], 10);
                height = parseInt(parts[1], 10);
                console.log(`[FFmpeg Compress] Video dimensions parsed: ${width}x${height}`);
            }
        } catch (ffprobeErr) {
            console.warn('[FFmpeg Compress] Warning: failed to probe video dimensions with ffprobe:', ffprobeErr.message);
        }

        // --- Auto-crop analysis: crop static borders (any color) around the
        // moving content; static text in the background is kept (edge-detail
        // union). Applied to every encode path below. Best-effort.
        let cropFilter = '';
        let cropW = width, cropH = height;
        if (width > 0 && height > 0 && duration > 0) {
            try {
                const box = await detectContentCrop(inputPath, duration, width, height);
                if (box && (box.x > 0 || box.y > 0 || box.w < width || box.h < height)) {
                    cropFilter = `crop=${box.w}:${box.h}:${box.x}:${box.y},`;
                    cropW = box.w;
                    cropH = box.h;
                }
            } catch (cropErr) {
                console.warn('[Media Crop] Auto-crop analysis failed:', cropErr.message);
            }
        }

        // 0. Try LOCAL iGPU (Intel N100/N150 Quick Sync) first.
        //    Only attempted when the host CPU is detected as one of the
        //    supported Intel SoCs AND /dev/dri/renderD128 is exposed to the
        //    container. If either check fails we silently skip the stage and
        //    fall through to the network transcoder.
        const igpuInfo = hasSupportedIgpu();
        let isIgpuAvailable = igpuInfo.supported;
        if (isIgpuAvailable) {
            console.log(`[FFmpeg Compress] ${igpuInfo.reason}. Attempting local iGPU VAAPI transcoding first...`);
            const renderNode = igpuInfo.renderNode || IGPU_RENDER_NODE;
            const scaleFilter = buildVaapiScaleFilter(cropW, cropH);

            // Bitrate-capped first attempt: for long clips, compute a target
            // video bitrate from targetSizeBytes/duration and encode once with
            // a hard -maxrate cap so the output is guaranteed to fit — instead of
            // climbing a 4-rung CQP ladder (each rung encodes the full clip and
            // only reveals its size after finishing). h264_vaapi honors -maxrate,
            // so a single pass lands under the limit. If this fails or overshots
            // (rare for very short clips where the min bitrate floor dominates),
            // fall through to the CQP ladder below.
            if (duration > 0) {
                const igpuBcPath = path.join(tempDir, `${prefix}_igpu_bc.mp4`);
                try {
                    // 86% of target bits for video (headroom for container/audio overhead), 96k audio.
                    const videoBits = Math.floor(targetSizeBytes * 8 * 0.86);
                    const audioBitrate = 96 * 1000;
                    const totalBitrate = Math.max(IGPU_MIN_VIDEO_BITRATE, Math.min(IGPU_MAX_VIDEO_BITRATE, Math.floor(videoBits / duration) - audioBitrate));
                    const vBitrate = Math.floor(totalBitrate / 1000);
                    const igpuBcCmd = `ffmpeg -hwaccel vaapi -vaapi_device ${renderNode} -i "${inputPath}" ` +
                        `-vf '${cropFilter}format=nv12,hwupload,${scaleFilter}' -b:v ${vBitrate}k -maxrate ${vBitrate}k -bufsize ${Math.floor(vBitrate * 2)}k -c:v h264_vaapi -c:a aac -b:a 96k -movflags +faststart -y "${igpuBcPath}"`;
                    console.log(`[FFmpeg Compress] Local iGPU bitrate-cap attempt (${vBitrate}k for ${duration.toFixed(1)}s, target ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB)...`);
                    await runCommandWithProgress(igpuBcCmd, duration, 'igpu', onProgress, timeout);
                    if (fs.existsSync(igpuBcPath)) {
                        const stats = fs.statSync(igpuBcPath);
                        console.log(`[FFmpeg Compress] Local iGPU bitrate-cap produced ${(stats.size / 1024 / 1024).toFixed(1)}MB (target ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB)`);
                        if (stats.size > 0 && stats.size <= targetSizeBytes) {
                            const outputBuffer = fs.readFileSync(igpuBcPath);
                            console.log(`[FFmpeg Compress] Success! Compressed via iGPU bitrate-cap (${vBitrate}k) -> ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
                            return { buffer: outputBuffer, ext: 'mp4' };
                        }
                        console.log(`[FFmpeg Compress] Local iGPU bitrate-cap still too large; trying CQP ladder...`);
                    }
                } catch (bcErr) {
                    console.warn(`❌🎦 [FFmpeg Compress] Local iGPU bitrate-cap failed (${bcErr.message}); trying CQP ladder...`);
                } finally {
                    try { if (fs.existsSync(igpuBcPath)) fs.unlinkSync(igpuBcPath); } catch (e) {}
                }
            }

            // CQP quality ladder (higher = smaller). h264_vaapi is used instead of
            // hevc_vaapi: HEVC encode isn't exposed on the Alpine intel-media-driver
            // build for the N150 (fails instantly with code 234), while h264_vaapi
            // is universally supported on Intel iGPUs and Discord plays it natively.
            // Quality is controlled via CQP (-rc_mode CQP -qp N) instead of a target
            // bitrate because hardware encoders overshoot -b:v on short low-bitrate
            // clips and never hit the size target. Output is MP4 directly (no mpegts
            // remux step). Mirrors the proven robot-joe iGPU path.
            const qpValues = [28, 32, 36, 40];
            for (let i = 0; i < qpValues.length; i++) {
                const qp = qpValues[i];
                const igpuMp4Path = path.join(tempDir, `${prefix}_igpu_${i}.mp4`);
                try {
                    const igpuCmd = `ffmpeg -hwaccel vaapi -vaapi_device ${renderNode} -i "${inputPath}" ` +
                        `-vf '${cropFilter}format=nv12,hwupload,${scaleFilter}' -rc_mode CQP -qp ${qp} -c:v h264_vaapi -c:a aac -b:a 96k -movflags +faststart -y "${igpuMp4Path}"`;

                    console.log(`[FFmpeg Compress] Local iGPU attempt ${i + 1}/${qpValues.length} (QP: ${qp}, target ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB)...`);
                    await runCommandWithProgress(igpuCmd, duration, 'igpu', onProgress, timeout);

                    if (fs.existsSync(igpuMp4Path)) {
                        const stats = fs.statSync(igpuMp4Path);
                        console.log(`[FFmpeg Compress] Local iGPU attempt ${i + 1} produced ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
                        if (stats.size === 0) {
                            console.warn('❌🎦 [FFmpeg Compress] Local iGPU produced a 0-byte file; marking iGPU unavailable and falling through to CPU.');
                            isIgpuAvailable = false;
                            break;
                        }
                        if (stats.size <= targetSizeBytes) {
                            const outputBuffer = fs.readFileSync(igpuMp4Path);
                            console.log(`[FFmpeg Compress] Success! Compressed via iGPU (QP ${qp}) -> ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
                            return { buffer: outputBuffer, ext: 'mp4' };
                        } else {
                            console.log(`[FFmpeg Compress] Local iGPU attempt ${i + 1} still too large (${(stats.size / 1024 / 1024).toFixed(1)}MB > ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB). Trying next QP...`);
                        }
                    } else {
                        console.warn('❌🎦 [FFmpeg Compress] Local iGPU produced no output; marking iGPU unavailable and falling through to CPU.');
                        isIgpuAvailable = false;
                        break;
                    }
                } catch (igpuErr) {
                    console.error('❌🎦 [FFmpeg Compress] Local iGPU transcoding error:', igpuErr.message);
                    if (igpuErr && igpuErr.stderr) {
                        const tail = String(igpuErr.stderr).split('\n').filter(Boolean).slice(-6).join(' | ');
                        if (tail) console.error('[FFmpeg Compress] ffmpeg stderr (tail):', tail);
                    }
                    console.warn('❌🎦 [FFmpeg Compress] Marking iGPU as unavailable and falling through to CPU.');
                    isIgpuAvailable = false;
                    break;
                } finally {
                    try { if (fs.existsSync(igpuMp4Path)) fs.unlinkSync(igpuMp4Path); } catch (e) {}
                }
            }
        } else {
            console.log(`[FFmpeg Compress] Local iGPU skipped — ${igpuInfo.reason}.`);
        }

        // A. Try remote network transcoding if remote access is configured.
        let isNasAvailable = hasRemoteAccess();
        if (isNasAvailable) {
            const bitrateMultipliers = IGPU_VIDEO_BITRATE_MULTIPLIERS;
            for (let i = 0; i < bitrateMultipliers.length; i++) {
                const multiplier = bitrateMultipliers[i];
                const networkTsPath = path.join(tempDir, `${prefix}_net_${i}.ts`);
                try {
                    console.log(`[FFmpeg Compress] Attempting remote network transcoding on 192.168.0.100 (attempt ${i + 1}, multiplier: ${multiplier})...`);
                    
                    const videoBitrate = calculateTargetBitrate(targetSizeBytes, multiplier, duration);
                    if (duration > 0) {
                        console.log(`[FFmpeg Compress] Dynamically calculated target bitrate: ${videoBitrate} for duration ${duration.toFixed(2)}s`);
                    }

                    const scaleFilter = buildVaapiScaleFilter(cropW, cropH);

                    const transcoderContainer = process.env.TRANSCODER_CONTAINER || 'transcoder';
                    const sshPrefix = buildSshPrefix();
                    const netCmd = `${sshPrefix} ` +
                        `"sudo docker exec -i ${transcoderContainer} ffmpeg -hwaccel vaapi -vaapi_device /dev/dri/renderD128 -i pipe:0 ` +
                        `-vf '${cropFilter}format=nv12,hwupload,${scaleFilter}' -b:v ${videoBitrate} -c:v hevc_vaapi -c:a aac -f mpegts pipe:1" ` +
                        `< "${inputPath}" > "${networkTsPath}"`;
                    
                    await runCommandWithProgress(netCmd, duration, 'network', onProgress, timeout);
                    
                    if (fs.existsSync(networkTsPath)) {
                        const stats = fs.statSync(networkTsPath);
                        console.log(`[FFmpeg Compress] Remote transcoding completed (attempt ${i + 1}). Output size: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
                        if (stats.size === 0) {
                            console.log(`[FFmpeg Compress] Remote transcoded file (attempt ${i + 1}) has 0 size. Marking NAS as unavailable.`);
                            isNasAvailable = false;
                            break;
                        }
                        if (stats.size <= targetSizeBytes) {
                            const localMp4Path = path.join(tempDir, `${prefix}_net_${i}.mp4`);
                            try {
                                console.log(`[FFmpeg Compress] Remuxing remote TS output to MP4 locally...`);
                                await runCommand(`ffmpeg -i "${networkTsPath}" -c copy -movflags +faststart -y "${localMp4Path}"`);
                                if (fs.existsSync(localMp4Path)) {
                                    const remuxedStats = fs.statSync(localMp4Path);
                                    console.log(`[FFmpeg Compress] Local remuxing completed. Size: ${(remuxedStats.size / 1024 / 1024).toFixed(1)}MB`);
                                    const outputBuffer = fs.readFileSync(localMp4Path);
                                    return { buffer: outputBuffer, ext: 'mp4' };
                                } else {
                                    console.warn('[FFmpeg Compress] Local remuxing failed to produce MP4. Returning original TS.');
                                    const outputBuffer = fs.readFileSync(networkTsPath);
                                    return { buffer: outputBuffer, ext: 'ts' };
                                }
                            } catch (remuxErr) {
                                console.error('[FFmpeg Compress] Local remuxing failed:', remuxErr.message);
                                const outputBuffer = fs.readFileSync(networkTsPath);
                                return { buffer: outputBuffer, ext: 'ts' };
                            } finally {
                                try { if (fs.existsSync(localMp4Path)) fs.unlinkSync(localMp4Path); } catch (e) {}
                            }
                        } else {
                            console.log(`[FFmpeg Compress] Remote transcoded file (attempt ${i + 1}) is still too large (${(stats.size / 1024 / 1024).toFixed(1)}MB > ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB).`);
                        }
                    } else {
                        console.log(`[FFmpeg Compress] Remote transcoding (attempt ${i + 1}) failed to produce output. Marking NAS as unavailable.`);
                        isNasAvailable = false;
                        break;
                    }
                } catch (netErr) {
                    console.error('[FFmpeg Compress] Remote network transcoding error:', netErr.message);
                    console.log('[FFmpeg Compress] Marking NAS as unavailable due to remote transcoding failure.');
                    isNasAvailable = false;
                    break;
                } finally {
                    try { if (fs.existsSync(networkTsPath)) fs.unlinkSync(networkTsPath); } catch (e) {}
                }
            }
        } else {
            console.log('[FFmpeg Compress] SHARE_PASS or SSH key not set. Skipping network transcoding.');
        }

        // B. Fall back to local CPU compression only if NAS is not available.
        //    The CPU scale filter caps the LONGEST dimension to 720 (so a 720x1280
        //    portrait reel downscales to ~406x720, not left at full 720x1280 which
        //    the old `scale='min(720,iw)':-2` did — that left portrait reels at full
        //    resolution and CRF 44 still overshot the size limit). A 2-pass
        //    bitrate-targeted encode (Phase B1) hits the exact target size in one
        //    shot — much faster than climbing a 4-rung CRF ladder. The CRF ladder
        //    (Phase B2) remains as a fallback if 2-pass fails. Mirrors robot-joe.
        if (!isNasAvailable) {
            console.log('[FFmpeg Compress] NAS is not available. Running local CPU compression fallback...');
            const activeWidth = cropW || width;
            const activeHeight = cropH || height;
            let cpuScale;
            if (activeWidth > 0 && activeHeight > 0) {
                if (activeHeight >= activeWidth) {
                    // Portrait: cap height to 720.
                    const th = Math.min(720, activeHeight);
                    const tw = Math.round((activeWidth * th / activeHeight) / 2) * 2;
                    cpuScale = `scale=${tw}:${th}`;
                } else {
                    // Landscape: cap width to 720.
                    const tw = Math.min(720, activeWidth);
                    const th = Math.round((activeHeight * tw / activeWidth) / 2) * 2;
                    cpuScale = `scale=${tw}:${th}`;
                }
            } else {
                cpuScale = `scale='min(720,iw)':'min(720,ih)':force_original_aspect_ratio=decrease`;
            }
            const cpuScaleArg = `-vf "${cropFilter}${cpuScale}"`;

            // B1. Two-pass bitrate-targeted encode (fastest path to hit an exact
            //     target size). 2-pass libx264 analyses the content in pass 1 and
            //     distributes the bitrate in pass 2 to hit the target. Much faster
            //     and more accurate than a 4-rung CRF ladder. Compute the video
            //     bitrate from targetSizeBytes/duration, leaving 14% headroom for
            //     container + audio overhead, 64k audio.
            if (duration > 0) {
                const passLogPrefix = path.join(tempDir, `${prefix}_2pass`);
                try {
                    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                    const videoBits = Math.floor(targetSizeBytes * 8 * 0.86);
                    const audioBits = 64 * 1000;
                    const totalBitrate = Math.max(80000, Math.floor(videoBits / duration) - audioBits);
                    const vBitrate = Math.floor(totalBitrate / 1000);
                    console.log(`[FFmpeg Compress] 2-pass encode: ${vBitrate}k video / 64k audio for ${duration.toFixed(1)}s (target ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB)...`);
                    // Pass 1: analysis (output to null, write stats to pass log).
                    // Combined 2-pass percentage: pass 1 maps to 0-50, pass 2
                    // to 50-100 so the visible percent never drops back to 0
                    // when the second pass starts.
                    const pass1Progress = onProgress
                        ? (info) => onProgress({ ...info, percent: Math.round((info.percent || 0) / 2) })
                        : onProgress;
                    const pass2Progress = onProgress
                        ? (info) => onProgress({ ...info, percent: 50 + Math.round((info.percent || 0) / 2) })
                        : onProgress;
                    const pass1Cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset veryfast -b:v ${vBitrate}k -pass 1 -passlogfile "${passLogPrefix}" ${cpuScaleArg} -an -f mp4 /dev/null`;
                    await runCommandWithProgress(pass1Cmd, duration, 'local', pass1Progress, timeout);
                    // Pass 2: encode using the pass-1 stats.
                    const pass2Cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset veryfast -b:v ${vBitrate}k -pass 2 -passlogfile "${passLogPrefix}" ${cpuScaleArg} -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart "${outputPath}"`;
                    await runCommandWithProgress(pass2Cmd, duration, 'local', pass2Progress, timeout);
                    if (fs.existsSync(outputPath)) {
                        const stats = fs.statSync(outputPath);
                        console.log(`[FFmpeg Compress] 2-pass output: ${(stats.size / 1024 / 1024).toFixed(1)}MB (target ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB)`);
                        if (stats.size > 0 && stats.size <= targetSizeBytes) {
                            const outputBuffer = fs.readFileSync(outputPath);
                            console.log(`[FFmpeg Compress] Success! Compressed to ${(stats.size / 1024 / 1024).toFixed(1)}MB (2-pass ${vBitrate}k)`);
                            return { buffer: outputBuffer, ext: 'mp4' };
                        }
                        console.log(`[FFmpeg Compress] 2-pass still too large; trying CRF ladder...`);
                    }
                } catch (tpErr) {
                    console.error('[FFmpeg Compress] 2-pass encode failed:', tpErr.message);
                } finally {
                    // Clean up 2-pass log files.
                    try {
                        const logFiles = fs.readdirSync(tempDir).filter(f => f.startsWith(`${prefix}_2pass`));
                        for (const f of logFiles) { try { fs.unlinkSync(path.join(tempDir, f)); } catch (_) {} }
                    } catch (_) {}
                }
            }

            // B2. CRF ladder fallback: if 2-pass failed or overshot (rare), try
            //     progressively higher CRF values.
            for (const crf of crfValues) {
                try {
                    if (fs.existsSync(outputPath)) {
                        fs.unlinkSync(outputPath);
                    }

                    const cmd = `ffmpeg -i "${inputPath}" -c:v libx264 -preset ultrafast -crf ${crf} ${cpuScaleArg} -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart -y "${outputPath}"`;
                    console.log(`[FFmpeg Compress] Attempting CRF ${crf} (ultrafast, ${cpuScale}, target ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB)...`);
                    await runCommandWithProgress(cmd, duration, 'local', onProgress, timeout);

                    if (!fs.existsSync(outputPath)) {
                        console.log(`[FFmpeg Compress] CRF ${crf}: No output file produced.`);
                        continue;
                    }

                    const stats = fs.statSync(outputPath);
                    console.log(`[FFmpeg Compress] CRF ${crf}: Output ${(stats.size / 1024 / 1024).toFixed(1)}MB`);

                    if (stats.size <= targetSizeBytes && stats.size > 0) {
                        const outputBuffer = fs.readFileSync(outputPath);
                        console.log(`[FFmpeg Compress] Success! Compressed ${(inputSize / 1024 / 1024).toFixed(1)}MB -> ${(stats.size / 1024 / 1024).toFixed(1)}MB (CRF ${crf})`);
                        return { buffer: outputBuffer, ext: 'mp4' };
                    }

                    console.log(`[FFmpeg Compress] CRF ${crf}: Still too large (${(stats.size / 1024 / 1024).toFixed(1)}MB > ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB). Trying next...`);
                } catch (crfErr) {
                    console.error(`[FFmpeg Compress] CRF ${crf} failed:`, crfErr.message);
                }
            }
        }

        console.log('[FFmpeg Compress] All CRF attempts exhausted. Compression failed.');
        return null;
    } catch (err) {
        console.error('[FFmpeg Compress] Fatal error:', err.message);
        return null;
    } finally {
        try { if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath); } catch (e) {}
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
    }
}

/**
 * Split an array of AttachmentBuilder objects into groups where each group's
 * total byte size is within limitBytes.
 */
function chunkAttachmentsBySize(attachments, limitBytes) {
    if (!attachments || attachments.length === 0) return [[]];
    
    const chunks = [];
    let currentChunk = [];
    let currentSize = 0;

    for (const att of attachments) {
        const attSize = att.attachment ? att.attachment.length : 0;
        
        if (currentChunk.length > 0 && currentSize + attSize > limitBytes) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentSize = 0;
        }
        
        currentChunk.push(att);
        currentSize += attSize;
    }
    
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }
    
    return chunks.length > 0 ? chunks : [[]];
}

module.exports = {
    getGuildFileLimit,
    compressVideoToFit,
    chunkAttachmentsBySize
};
