const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function runCommand(cmd, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            } else {
                resolve(stdout);
            }
        });
    });
}

// Stream a long-running command, invoking line callbacks for stdout/stderr.
// Used by the /restart rebuild flow to publish live BuildKit progress to chat.
// Mirrors robot-joe's runCommandStream (CR and LF both treated as line breaks
// so Docker's carriage-return progress updates are flushed correctly).
function runCommandStream(cmd, { timeoutMs = 0, onStdout = null, onStderr = null } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, { shell: true });

        let stdout = '';
        let stderr = '';
        let stdoutBuf = '';
        let stderrBuf = '';
        let timeout = null;

        if (timeoutMs && timeoutMs > 0) {
            timeout = setTimeout(() => {
                child.kill('SIGKILL');
                const err = new Error(`Command timed out after ${timeoutMs}ms`);
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            }, timeoutMs);
        }

        const flushLines = (buffer, cb, streamName) => {
            const parts = buffer.split(/\r|\n/);
            const remainder = parts.pop() || '';
            if (cb) {
                for (const part of parts) {
                    try {
                        cb(part, streamName);
                    } catch (_) {}
                }
            }
            return remainder;
        };

        child.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            stdoutBuf += chunk;
            stdoutBuf = flushLines(stdoutBuf, onStdout, 'stdout');
        });

        child.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            stderrBuf += chunk;
            stderrBuf = flushLines(stderrBuf, onStderr, 'stderr');
        });

        child.on('close', (code) => {
            if (timeout) clearTimeout(timeout);
            if (stdoutBuf && onStdout) {
                try { onStdout(stdoutBuf.replace(/\r$/, ''), 'stdout'); } catch (_) {}
            }
            if (stderrBuf && onStderr) {
                try { onStderr(stderrBuf.replace(/\r$/, ''), 'stderr'); } catch (_) {}
            }
            if (code !== 0) {
                const err = new Error(`Command failed with code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            } else {
                resolve({ stdout, stderr });
            }
        });

        child.on('error', (err) => {
            if (timeout) clearTimeout(timeout);
            reject(err);
        });
    });
}

/**
 * Searches for an SSH private key inside the container, copies it to /tmp/bot_ssh_key,
 * and sets correct 0o600 permissions.
 * @returns {string|null} Path to the prepared private key, or null if not found.
 */
function prepareSshKey() {
    const possibleKeys = [
        process.env.SSH_KEY_PATH,
        path.join(__dirname, '../../id_rsa'),
        path.join(__dirname, '../../id_ed25519'),
        path.join(__dirname, '../../id_ed25519_bot'),
        '/root/.ssh/id_rsa',
        '/root/.ssh/id_ed25519',
        '/root/.ssh/id_ed25519_bot'
    ];

    for (const keyPath of possibleKeys) {
        if (keyPath && fs.existsSync(keyPath)) {
            const tempKeyPath = '/tmp/bot_ssh_key';
            try {
                let keyContentStr = fs.readFileSync(keyPath, 'utf8');
                // Normalize CRLF to LF
                keyContentStr = keyContentStr.replace(/\r\n/g, '\n');
                // Trim leading/trailing whitespace, ensuring exactly one trailing newline
                keyContentStr = keyContentStr.trim() + '\n';

                fs.writeFileSync(tempKeyPath, keyContentStr, { mode: 0o600 });
                console.log(`[SSH Key] Successfully prepared and normalized private key from ${keyPath} at ${tempKeyPath}`);
                return tempKeyPath;
            } catch (err) {
                console.error(`[SSH Key] Failed to prepare key from ${keyPath}:`, err.message);
            }
        }
    }
    return null;
}

/**
 * Builds the SSH prefix for connecting to the remote NAS transcoder.
 *
 * DEPRECATED: the bot no longer uses the remote NAS (192.168.0.100) for network
 * transcoding. All media compression now runs locally on the N150 host (iGPU →
 * local CPU). This function is kept as a no-op so mediaCompressor's network stage
 * is always skipped via hasRemoteAccess() === false.
 * @returns {string} Empty string (no remote connection).
 */
function buildSshPrefix() {
    // No-op: all services run locally on the N150 host now.
    return "";
}

/**
 * Checks if the bot has capability for remote connections.
 *
 * DEPRECATED: always returns false — the remote NAS transcoder is no longer used.
 * This forces mediaCompressor to skip the network stage and use the local CPU fallback.
 * @returns {boolean} Always false.
 */
function hasRemoteAccess() {
    // No-op: all services run locally on the N150 host now.
    return false;
}

/**
 * Spawns a command string in a shell and tracks progress of an ffmpeg command via its stderr.
 * @param {string} cmdStr - The command string to run.
 * @param {number} totalDuration - Total video duration in seconds.
 * @param {string} stage - 'network' or 'local'.
 * @param {function} onProgress - Callback function that receives { stage, percent }.
 * @param {number} timeoutMs - Timeout for command execution.
 * @returns {Promise<string>} stdout output.
 */
function runCommandWithProgress(cmdStr, totalDuration, stage, onProgress, timeoutMs = 180000) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmdStr, { shell: true });
        
        let stdout = '';
        let stderr = '';
        
        const timeout = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        child.stderr.on('data', (data) => {
            const str = data.toString();
            stderr += str;
            
            if (onProgress && totalDuration > 0) {
                // Parse time=HH:MM:SS.cs
                const match = str.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
                if (match) {
                    const hours = parseInt(match[1], 10);
                    const minutes = parseInt(match[2], 10);
                    const seconds = parseFloat(`${match[3]}.${match[4]}`);
                    const totalSecs = hours * 3600 + minutes * 60 + seconds;
                    const percent = Math.min(100, Math.round((totalSecs / totalDuration) * 100));
                    onProgress({ stage, percent });
                }
            }
        });
        
        child.on('close', (code) => {
            clearTimeout(timeout);
            if (code !== 0) {
                const err = new Error(`Command failed with code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            } else {
                resolve(stdout);
            }
        });
        
        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

/**
 * Searches for local yt-dlp binary path
 * @returns {string} Path to yt-dlp
 */
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

module.exports = {
    runCommand,
    runCommandStream,
    buildSshPrefix,
    hasRemoteAccess,
    runCommandWithProgress,
    findYtDlpPath
};
