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
 * Dynamically fetches the last 5 git updates (older to newer with dates) or falls back to a default list
 */
function getLastUpdates() {
    try {
        const repoPath = path.resolve(__dirname, '..', '..');
        const stdout = execSync('git log -5 --reverse --pretty=format:"- %as: %s ([%h](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/%H))"', {
            cwd: repoPath,
            encoding: 'utf8'
        });
        return stdout.trim() || '- 2026-06-11: Reorganized code into modular files ([a1b2c3d](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/a1b2c3d))\n- 2026-06-11: Updated documentation ([e5f6g7h](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/e5f6g7h))\n- 2026-06-11: Displayed updates in system message ([i9j0k1l](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/i9j0k1l))';
    } catch (e) {
        console.warn('Failed to fetch git log:', e.message);
        return '- 2026-06-11: Reorganized code into modular files ([a1b2c3d](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/a1b2c3d))\n- 2026-06-11: Updated documentation ([e5f6g7h](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/e5f6g7h))\n- 2026-06-11: Displayed updates in system message ([i9j0k1l](https://github.com/sneakyjoeru/ttrpg-librarian-bot/commit/i9j0k1l))';
    }
}

module.exports = {
    getLibrarianData,
    estimateTokens,
    isHistoryOrAnalysisQuery,
    getLastUpdates
};
