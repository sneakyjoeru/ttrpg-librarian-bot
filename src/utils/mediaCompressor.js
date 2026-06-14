const fs = require('fs');
const path = require('path');
const os = require('os');
const { runCommand, buildSshPrefix, hasRemoteAccess, runCommandWithProgress } = require('./shell');
const { FFMPEG_TIMEOUT, DISCORD_FILE_LIMIT_DEFAULT } = require('../config');

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
        default: return DISCORD_FILE_LIMIT_DEFAULT; // Tier 0 & 1: 10MB
    }
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

        // A. Try remote network transcoding if remote access is configured.
        let isNasAvailable = hasRemoteAccess();
        if (isNasAvailable) {
            const bitrateMultipliers = [0.80, 0.65, 0.50, 0.35];
            for (let i = 0; i < bitrateMultipliers.length; i++) {
                const multiplier = bitrateMultipliers[i];
                const networkTsPath = path.join(tempDir, `${prefix}_net_${i}.ts`);
                try {
                    console.log(`[FFmpeg Compress] Attempting remote network transcoding on 192.168.0.100 (attempt ${i + 1}, multiplier: ${multiplier})...`);
                    
                    let videoBitrate = '2M';
                    if (duration > 0) {
                        const targetBits = targetSizeBytes * 8 * multiplier;
                        const audioBitrate = 96 * 1000;
                        const calculatedBitrate = Math.floor(targetBits / duration) - audioBitrate;
                        const clampedBitrate = Math.max(150000, Math.min(4000000, calculatedBitrate));
                        videoBitrate = `${Math.floor(clampedBitrate / 1000)}k`;
                        console.log(`[FFmpeg Compress] Dynamically calculated target bitrate: ${videoBitrate} for duration ${duration.toFixed(2)}s`);
                    }

                    let scaleFilter = 'scale_vaapi=w=1280:h=720';
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
                        scaleFilter = `scale_vaapi=w=${targetWidth}:h=${targetHeight}`;
                    } else {
                        scaleFilter = 'scale_vaapi=w=-2:h=720';
                    }

                    const transcoderContainer = process.env.TRANSCODER_CONTAINER || 'transcoder';
                    const sshPrefix = buildSshPrefix();
                    const netCmd = `${sshPrefix} ` +
                        `"sudo docker exec -i ${transcoderContainer} ffmpeg -hwaccel vaapi -vaapi_device /dev/dri/renderD128 -i pipe:0 ` +
                        `-vf 'format=nv12,hwupload,${scaleFilter}' -b:v ${videoBitrate} -c:v hevc_vaapi -c:a aac -f mpegts pipe:1" ` +
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

        // B. Fall back to local CPU compression only if NAS is not available
        if (!isNasAvailable) {
            console.log('[FFmpeg Compress] NAS is not available. Running local CPU compression fallback...');
            for (const crf of crfValues) {
                try {
                    if (fs.existsSync(outputPath)) {
                        fs.unlinkSync(outputPath);
                    }

                    const scaleFilter = '-vf "scale=\'min(720,iw)\':-2"';
                    const cmd = `ffmpeg -i "${inputPath}" -c:v libx264 -preset ultrafast -crf ${crf} ${scaleFilter} -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart -y "${outputPath}"`;
                    console.log(`[FFmpeg Compress] Attempting CRF ${crf} (ultrafast)...`);
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
