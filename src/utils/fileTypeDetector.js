// === fileTypeDetector: detect file type from buffer content using magic bytes ===
//
// Useful when the upstream server (scraper / yt-dlp / CDN) returns a buffer
// whose content-type header lies, is missing, or is too generic. We sniff
// the first 12 bytes and return the canonical extension (mp4, jpg, png, etc.)
// so the bot can name attachments sensibly and route them to the right
// downstream pipeline (image vs. video vs. audio).

const fs = require('fs');

/**
 * Detects the actual file type from buffer content using magic bytes
 * @param {Buffer} buffer - The file buffer to analyze
 * @returns {string|null} - The detected file extension or null if unknown
 */
function detectFileType(buffer) {
    if (!buffer || buffer.length < 12) {
        return null;
    }

    // Read first 12 bytes as hex string
    const header = buffer.slice(0, 12);
    const headerHex = header.toString('hex').toLowerCase();

    // Video file signatures
    if (headerHex.startsWith('00000018667479706d7034') ||
        headerHex.startsWith('00000020667479706d7034') ||
        headerHex.startsWith('667479706d7034')) {
        return 'mp4';
    }

    if (headerHex.startsWith('1a45dfa3')) {
        return 'webm';
    }

    if (headerHex.startsWith('0000001466747970717420') ||
        headerHex.startsWith('00000020667479704d3441') ||
        headerHex.startsWith('66747970717420')) {
        return 'mov';
    }

    // Image file signatures
    if (headerHex.startsWith('ffd8ffe0') || headerHex.startsWith('ffd8ffe1') || headerHex.startsWith('ffd8ffe2')) {
        return 'jpg';
    }

    if (headerHex.startsWith('89504e47')) {
        return 'png';
    }

    if (headerHex.startsWith('47494638')) {
        return 'gif';
    }

    if (headerHex.startsWith('52494646') && buffer.length > 16) {
        // Could be WAV or WebP, check more bytes
        const riffType = buffer.slice(8, 12).toString('ascii');
        if (riffType === 'WEBP') {
            return 'webp';
        }
    }

    // Audio file signatures
    if (headerHex.startsWith('494433')) {
        return 'mp3';
    }

    if (headerHex.startsWith('52494646') && buffer.length > 16) {
        const riffType = buffer.slice(8, 12).toString('ascii');
        if (riffType === 'WAVE') {
            return 'wav';
        }
    }

    return null;
}

/**
 * Validates if a buffer is likely a video file
 * @param {Buffer} buffer - The file buffer to validate
 * @returns {boolean} - True if buffer appears to be a video file
 */
function isVideoFile(buffer) {
    const fileType = detectFileType(buffer);
    return fileType && ['mp4', 'webm', 'mov', 'avi', 'mkv'].includes(fileType);
}

/**
 * Validates if a buffer is likely an image file
 * @param {Buffer} buffer - The file buffer to validate
 * @returns {boolean} - True if buffer appears to be an image file
 */
function isImageFile(buffer) {
    const fileType = detectFileType(buffer);
    return fileType && ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(fileType);
}

/**
 * Validates if a buffer is likely an audio file
 * @param {Buffer} buffer - The file buffer to validate
 * @returns {boolean} - True if buffer appears to be an audio file
 */
function isAudioFile(buffer) {
    const fileType = detectFileType(buffer);
    return fileType && ['mp3', 'wav', 'ogg', 'flac'].includes(fileType);
}

module.exports = {
    detectFileType,
    isVideoFile,
    isImageFile,
    isAudioFile
};
