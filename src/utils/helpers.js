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
 * Dynamically fetches the last 3 git updates or falls back to a default list
 */
function getLastUpdates() {
    try {
        const repoPath = path.resolve(__dirname, '..', '..');
        const stdout = execSync('git log -3 --pretty=format:"- %s (%h)"', {
            cwd: repoPath,
            encoding: 'utf8'
        });
        return stdout.trim() || '- Reorganized code into modular files\n- Updated documentation\n- Displayed updates in system message';
    } catch (e) {
        console.warn('Failed to fetch git log:', e.message);
        return '- Reorganized code into modular files\n- Updated documentation\n- Displayed updates in system message';
    }
}

module.exports = {
    getLibrarianData,
    estimateTokens,
    isHistoryOrAnalysisQuery,
    getLastUpdates
};
