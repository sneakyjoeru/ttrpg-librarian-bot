const { execSync } = require('child_process');
const path = require('path');

/**
 * Parses channel topic for librarian metadata
 */
async function getLibrarianData(channel) {
    if (channel.topic && channel.topic.includes('[LIBRARIAN_DATA|')) {
        const topicMatch = channel.topic.match(/\[LIBRARIAN_DATA\|DM:(\d+)\|ROLE:(\d+)\]/);
        if (topicMatch) {
            return { dmId: topicMatch[1], roleId: topicMatch[2] };
        }
    }
    return null;
}

/**
 * Updates the campaign channel name (and role name) to reflect the current
 * number of members holding the campaign role. The channel name format is
 * `campaignName-creatorName-playerCount` — only the trailing number changes.
 *
 * Called after role add/remove (✋ reaction, OP-time assignment, mention
 * auto-add) so the count stays in sync with the actual player roster.
 *
 * Discord limits channel renames to 2 per 10 minutes, so this is a best-effort
 * update: if it fails (rate limit) the change is silently skipped.
 *
 * @param {import('discord.js').GuildChannel} channel  The campaign text channel.
 * @param {import('discord.js').Role}        role     The campaign role.
 */
async function syncChannelNameToRoleCount(channel, role) {
    if (!channel || !role || !channel.guild) return;
    try {
        const parts = channel.name.split('-');
        if (parts.length < 2) return; // unexpected format

        const newCount = role.members.size;
        const currentCount = parseInt(parts[parts.length - 1], 10);
        if (isNaN(currentCount) || currentCount === newCount) return; // no change needed

        const newName = [...parts.slice(0, -1), newCount].join('-');

        if (newName === channel.name) return;

        await channel.setName(newName, 'Player count sync').catch(() => { });
        // Keep the role name in sync with the channel name (mirrors /update-players).
        await role.setName(newName).catch(() => { });
    } catch (err) {
        console.warn('syncChannelNameToRoleCount failed:', err.message);
    }
}

/**
 * Estimates token size of prompt string
 */
function estimateTokens(str) {
    let tokens = 0;
    for (let i = 0; i < str.length; i++) {
        const code = str.charCodeAt(i);
        if (code > 127) {
            tokens += 0.8;
        } else {
            tokens += 0.25;
        }
    }
    return Math.ceil(tokens);
}

/**
 * Checks if query is history or analysis related
 */
function isHistoryOrAnalysisQuery(query) {
    const qLower = query.toLowerCase().trim();
    const hasWord = (word) => {
        const pattern = new RegExp(`\\b${word}\\b`, 'i');
        return pattern.test(qLower);
    };

    const keywords = [
        'history', 'analyze', 'analysis', 'summarize', 'summary', 'recap', 'what happened',
        'what was said', 'who said', 'chat log', 'conversation', 'past messages', 'previously',
        'recent', 'recently', 'posted', 'post', 'wrote', 'write', 'said', 'say', 'talked', 'talk'
    ];

    return keywords.some(kw => {
        if (kw.includes(' ')) {
            return qLower.includes(kw);
        }
        return hasWord(kw);
    });
}

/**
 * Dynamically fetches the last `count` git updates (older to newer with
 * dates) or falls back to a default 3-item list. `count` is clamped to
 * [1, 50] to avoid huge pastes and accidental shell-injection from a
 * surprising caller.
 *
 * Output is kept compact so it fits Discord's 2000-char message limit even
 * with 10 entries: commit URLs use the SHORT hash (GitHub redirects short
 * hashes, so links still work) and each subject is truncated to
 * `MAX_SUBJECT_LEN` characters. Returns newline-joined `- date: subject
 * ([short](url))` lines.
 */
const UPDATES_REPO_URL = 'https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit';
const MAX_SUBJECT_LEN = 80;
function getLastUpdates(count = 5) {
    const safeCount = Math.max(1, Math.min(50, parseInt(count, 10) || 5));
    const fallback = [
        '- 2026-06-11: Reorganized code into modular files ([a1b2c3d](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/a1b2c3d))',
        '- 2026-06-11: Updated documentation ([e5f6g7h](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/e5f6g7h))',
        '- 2026-06-11: Displayed updates in system message ([i9j0k1l](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/i9j0k1l))'
    ];
    try {
        const repoPath = path.resolve(__dirname, '..', '..');
        // Tab-separated fields (%x09) so we can parse reliably and rebuild
        // each line in JS with a truncated subject + short-hash URL.
        const stdout = execSync(
            `git log -${safeCount} --reverse --pretty=format:"%as%x09%s%x09%h"`,
            { cwd: repoPath, encoding: 'utf8' }
        );
        const raw = stdout.trim();
        if (!raw) return fallback.slice(0, safeCount).join('\n');
        return raw.split('\n').filter(Boolean).map(line => {
            const [date, subject, hash] = line.split('\t');
            const safeSubject = (subject || '(no subject)').replace(/\|/g, '\\|');
            const trimmed = safeSubject.length > MAX_SUBJECT_LEN
                ? safeSubject.slice(0, MAX_SUBJECT_LEN - 1) + '…'
                : safeSubject;
            return `- ${date}: ${trimmed} ([${hash}](${UPDATES_REPO_URL}/${hash}))`;
        }).join('\n');
    } catch (e) {
        console.warn('Failed to fetch git log:', e.message);
        return fallback.slice(0, safeCount).join('\n');
    }
}

module.exports = {
    getLibrarianData,
    syncChannelNameToRoleCount,
    estimateTokens,
    isHistoryOrAnalysisQuery,
    getLastUpdates
};
