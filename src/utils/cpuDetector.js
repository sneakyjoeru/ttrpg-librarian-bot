// Host CPU & iGPU detection.
//
// The bot may be hosted on very different machines (the original NAS, a mini
// PC, a VPS, etc.). For video transcoding we want to take advantage of an
// on-board Intel iGPU when one is available — the Intel N100 and N150
// (Alder Lake-N / Twin Lake) both ship with Intel UHD Graphics that supports
// VAAPI hardware encode/decode, which is dramatically faster than libx264
// for the same quality.
//
// The detection has two parts:
//   1. Read /proc/cpuinfo and look for an "N100" or "N150" model name.
//      We accept any Intel CPU with one of those model strings — the function
//      is named `hasSupportedIgpu` so other "supported" CPUs can be added
//      later without rewriting call sites.
//   2. Check that /dev/dri/renderD128 exists and is readable from this
//      process. Without it the i915 kernel module hasn't exposed the render
//      node to userspace (either the host doesn't have an Intel GPU, the
//      kernel driver isn't loaded, or the container wasn't started with the
//      device mounted).
//
// Detection runs at most once per process and the result is cached. The
// caller treats the result as advisory — if iGPU is reported as available
// and the actual ffmpeg call fails, the compressor still falls back to the
// network transcoder and then to local CPU encoding.

const fs = require('fs');

const IGPU_RENDER_NODE = '/dev/dri/renderD128';

let cachedResult = null;

/**
 * Reads /proc/cpuinfo and returns the first non-empty `model name` field.
 * Works on Linux; on other platforms returns an empty string.
 */
function readCpuModel() {
    try {
        const raw = fs.readFileSync('/proc/cpuinfo', 'utf8');
        const match = raw.match(/model name\s*:\s*([^\n]+)/i);
        if (match) return match[1].trim();
    } catch (err) {
        // /proc/cpuinfo is missing or unreadable — not a Linux host, or
        // we're running in a restricted sandbox. Either way we have no
        // model info to match against.
        return '';
    }
    return '';
}

/**
 * Returns true if the given CPU model string indicates one of the supported
 * Intel SoCs with Quick Sync iGPUs (currently the N100 / N150 family).
 * Matching is case-insensitive and tolerates cosmetic differences in the
 * model string ("Intel(R) N100", "Intel(R) Processor N150", ...).
 */
function modelMatchesSupportedIgpu(model) {
    if (!model) return false;
    const lower = model.toLowerCase();
    // Match N100 / N150 (and not, e.g., "N1000" or "i7-13700").
    // The trailing word boundary or non-digit keeps us safe.
    return /\bn(100|150)\b/.test(lower);
}

/**
 * Returns true if the VAAPI render node is accessible from this process.
 * fs.existsSync is sufficient — we don't need to actually open the device
 * here; the ffmpeg call itself will fail loudly if the node is not usable.
 */
function isRenderNodeAccessible() {
    try {
        return fs.existsSync(IGPU_RENDER_NODE);
    } catch (err) {
        return false;
    }
}

/**
 * Detects whether the bot is running on a host with a usable iGPU for
 * transcoding. The result is memoised.
 *
 * @returns {{ supported: boolean, model: string, renderNode: string, reason: string }}
 */
function hasSupportedIgpu() {
    if (cachedResult) return cachedResult;

    const model = readCpuModel();
    const renderNode = isRenderNodeAccessible();

    if (!model) {
        cachedResult = {
            supported: false,
            model: '',
            renderNode: IGPU_RENDER_NODE,
            reason: 'cpuinfo unavailable — not a Linux host or restricted sandbox'
        };
        return cachedResult;
    }

    if (!modelMatchesSupportedIgpu(model)) {
        cachedResult = {
            supported: false,
            model,
            renderNode: IGPU_RENDER_NODE,
            reason: `CPU model "${model}" is not in the iGPU-supported list`
        };
        return cachedResult;
    }

    if (!renderNode) {
        cachedResult = {
            supported: false,
            model,
            renderNode: IGPU_RENDER_NODE,
            reason: `CPU "${model}" has iGPU but ${IGPU_RENDER_NODE} is not exposed — run container with --device /dev/dri/renderD128 (or -v /dev/dri:/dev/dri)`
        };
        return cachedResult;
    }

    cachedResult = {
        supported: true,
        model,
        renderNode: IGPU_RENDER_NODE,
        reason: `CPU "${model}" exposes ${IGPU_RENDER_NODE}; VAAPI iGPU transcoding enabled`
    };
    return cachedResult;
}

/**
 * Forces a fresh detection (used by tests / for invalidating the cache when
 * the device landscape changes mid-process).
 */
function clearCache() {
    cachedResult = null;
}

module.exports = {
    hasSupportedIgpu,
    clearCache
};