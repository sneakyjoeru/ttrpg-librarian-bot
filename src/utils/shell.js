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
 * Builds the SSH prefix for connecting to sneakyjoe@192.168.0.100.
 * Prioritizes key-based authentication if a key is found, then falls back to sshpass, then raw ssh.
 * @returns {string} The ssh prefix (e.g. `ssh -i "/tmp/bot_ssh_key" -o StrictHostKeyChecking=no sneakyjoe@192.168.0.100`)
 */
function buildSshPrefix() {
    const keyPath = prepareSshKey();
    if (keyPath) {
        return `ssh -i "${keyPath}" -o StrictHostKeyChecking=no sneakyjoe@192.168.0.100`;
    }

    const sharePass = process.env.SHARE_PASS;
    if (sharePass) {
        return `sshpass -p "${sharePass}" ssh -o StrictHostKeyChecking=no sneakyjoe@192.168.0.100`;
    }

    console.warn('[SSH Prefix] Warning: Neither SSH key nor SHARE_PASS found. Using raw SSH connection.');
    return `ssh -o StrictHostKeyChecking=no sneakyjoe@192.168.0.100`;
}

/**
 * Checks if the bot has capability for remote connections (either SSH key or SHARE_PASS password).
 * @returns {boolean} True if remote access is configured.
 */
function hasRemoteAccess() {
    if (process.env.SHARE_PASS) return true;

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
            return true;
        }
    }
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
    buildSshPrefix,
    hasRemoteAccess,
    runCommandWithProgress,
    findYtDlpPath
};
