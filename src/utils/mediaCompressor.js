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
            for (let i = 0; i < IGPU_VIDEO_BITRATE_MULTIPLIERS.length; i++) {
                const multiplier = IGPU_VIDEO_BITRATE_MULTIPLIERS[i];
                const igpuTsPath = path.join(tempDir, `${prefix}_igpu_${i}.ts`);
                try {
                    const videoBitrate = calculateTargetBitrate(targetSizeBytes, multiplier, duration);
                    if (duration > 0) {
                        console.log(`[FFmpeg Compress] iGPU dynamically calculated target bitrate: ${videoBitrate} for duration ${duration.toFixed(2)}s`);
                    }
                    const scaleFilter = buildVaapiScaleFilter(width, height);

                    const igpuCmd = `ffmpeg -hwaccel vaapi -vaapi_device ${renderNode} -i "${inputPath}" ` +
                        `-vf 'format=nv12,hwupload,${scaleFilter}' -b:v ${videoBitrate} -c:v hevc_vaapi -c:a aac -f mpegts -y "${igpuTsPath}"`;

                    console.log(`[FFmpeg Compress] Local iGPU attempt ${i + 1}/${IGPU_VIDEO_BITRATE_MULTIPLIERS.length} (multiplier: ${multiplier})...`);
                    await runCommandWithProgress(igpuCmd, duration, 'igpu', onProgress, timeout);

                    if (fs.existsSync(igpuTsPath)) {
                        const stats = fs.statSync(igpuTsPath);
                        console.log(`[FFmpeg Compress] Local iGPU attempt ${i + 1} produced ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
                        if (stats.size === 0) {
                            console.warn('[FFmpeg Compress] Local iGPU produced a 0-byte file; marking iGPU unavailable and falling through to network transcoder.');
                            isIgpuAvailable = false;
                            break;
                        }
                        if (stats.size <= targetSizeBytes) {
                            const localMp4Path = path.join(tempDir, `${prefix}_igpu_${i}.mp4`);
                            try {
                                console.log(`[FFmpeg Compress] Remuxing local iGPU TS output to MP4...`);
                                await runCommand(`ffmpeg -i "${igpuTsPath}" -c copy -movflags +faststart -y "${localMp4Path}"`);
                                if (fs.existsSync(localMp4Path)) {
                                    const remuxedStats = fs.statSync(localMp4Path);
                                    console.log(`[FFmpeg Compress] Local iGPU remux completed. Size: ${(remuxedStats.size / 1024 / 1024).toFixed(1)}MB`);
                                    const outputBuffer = fs.readFileSync(localMp4Path);
                                    return { buffer: outputBuffer, ext: 'mp4' };
                                } else {
                                    console.warn('[FFmpeg Compress] Local iGPU remux failed to produce MP4; returning TS.');
                                    const outputBuffer = fs.readFileSync(igpuTsPath);
                                    return { buffer: outputBuffer, ext: 'ts' };
                                }
                            } catch (remuxErr) {
                                console.error('[FFmpeg Compress] Local iGPU remux failed:', remuxErr.message);
                                const outputBuffer = fs.readFileSync(igpuTsPath);
                                return { buffer: outputBuffer, ext: 'ts' };
                            } finally {
                                try { if (fs.existsSync(localMp4Path)) fs.unlinkSync(localMp4Path); } catch (e) {}
                            }
                        } else {
                            console.log(`[FFmpeg Compress] Local iGPU attempt ${i + 1} still too large (${(stats.size / 1024 / 1024).toFixed(1)}MB > ${(targetSizeBytes / 1024 / 1024).toFixed(1)}MB). Trying next multiplier...`);
                        }
                    } else {
                        console.warn('[FFmpeg Compress] Local iGPU produced no output; marking iGPU unavailable and falling through to network transcoder.');
                        isIgpuAvailable = false;
                        break;
                    }
                } catch (igpuErr) {
                    console.error('[FFmpeg Compress] Local iGPU transcoding error:', igpuErr.message);
                    console.warn('[FFmpeg Compress] Marking iGPU as unavailable and falling through to network transcoder.');
                    isIgpuAvailable = false;
                    break;
                } finally {
                    try { if (fs.existsSync(igpuTsPath)) fs.unlinkSync(igpuTsPath); } catch (e) {}
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

                    const scaleFilter = buildVaapiScaleFilter(width, height);

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
