const axios = require('axios');
const { estimateTokens, isHistoryOrAnalysisQuery } = require('../utils/helpers');
const {
    helpText,
    SEARXNG_URL,
    OLLAMA_URL,
    OLLAMA_MODEL,
    RAG_SEARCH_LIMIT,
    RAG_HISTORY_LIMIT,
    RAG_SEARCH_TIMEOUT,
    RAG_OLLAMA_TIMEOUT,
    RAG_TYPING_INTERVAL
} = require('../config');

async function handleRagQuery(client, message, query) {
    // Enable typing indicator and start a loop to maintain it (Discord resets it every 10 seconds)
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => { });
    }, RAG_TYPING_INTERVAL);

    try {
        const isNoBs = /no\s+bs/i.test(query);
        let cleanedQuery = query.replace(/no\s+bs/i, '').replace(/\s+/g, ' ').trim();
        if (!cleanedQuery) {
            cleanedQuery = query;
        }

        let searchContext = 'No external internet context available.';

        try {
            const searchResponse = await axios.get(SEARXNG_URL, {
                params: {
                    q: cleanedQuery,
                    format: 'json',
                    engines: 'duckduckgo,google,wikipedia',
                    language: 'en'
                },
                timeout: RAG_SEARCH_TIMEOUT
            });

            if (searchResponse.data && searchResponse.data.results) {
                searchContext = searchResponse.data.results.slice(0, RAG_SEARCH_LIMIT).map(res =>
                    `Title: ${res.title}\nSnippet: ${res.content}`
                ).join('\n\n');
            }
        } catch (searchErr) {
            console.error('SearXNG search failed, proceeding with LLM only:', searchErr.message);
        }

        // --- TARGET USER RESOLUTION ---
        let targetUser = null;
        if (message.guild) {
            try {
                const idMatch = cleanedQuery.match(/(?:<@!?)?(\d{17,20})>?/);
                if (idMatch) {
                    const userId = idMatch[1];
                    targetUser = await message.guild.members.fetch(userId).then(m => m.user).catch(() => null);
                }

                if (!targetUser) {
                    const queryLower = cleanedQuery.toLowerCase();
                    const members = message.guild.members.cache;

                    // First pass: try exact word-boundary matches to avoid false positives
                    for (const member of members.values()) {
                        const username = member.user.username.toLowerCase();
                        const displayName = member.displayName.toLowerCase();
                        const nickname = member.nickname ? member.nickname.toLowerCase() : '';

                        const escapedUsername = username.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                        const escapedDisplayName = displayName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

                        const usernameRegex = new RegExp(`\\b${escapedUsername}\\b`, 'i');
                        const displayNameRegex = new RegExp(`\\b${escapedDisplayName}\\b`, 'i');

                        if (usernameRegex.test(queryLower) || displayNameRegex.test(queryLower) || (nickname && new RegExp(`\\b${nickname.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i').test(queryLower))) {
                            targetUser = member.user;
                            break;
                        }
                    }

                    // Second pass: try matching query words against member names (handling suffixes like .live or _bot)
                    if (!targetUser) {
                        const queryWords = queryLower.split(/[^\w\d]+/).filter(w => w.length >= 3);
                        const stopWords = ['what', 'did', 'post', 'recently', 'posted', 'said', 'wrote', 'about', 'who', 'how', 'the', 'you', 'was', 'were', 'has', 'have', 'say', 'saying', 'logs', 'chat', 'message', 'messages'];

                        for (const member of members.values()) {
                            const username = member.user.username.toLowerCase();
                            const displayName = member.displayName.toLowerCase();
                            const nickname = member.nickname ? member.nickname.toLowerCase() : '';

                            for (const word of queryWords) {
                                if (stopWords.includes(word)) continue;
                                if (username.includes(word) || displayName.includes(word) || (nickname && nickname.includes(word))) {
                                    targetUser = member.user;
                                    break;
                                }
                            }
                            if (targetUser) break;
                        }
                    }
                }
            } catch (err) {
                console.error('Error resolving target user:', err);
            }
        }

        // Replace raw user ID or mention in the query with resolved display name so the LLM understands who is being asked about
        let llmQuery = cleanedQuery;
        if (targetUser) {
            const memberDetails = message.guild?.members.cache.get(targetUser.id);
            const resolvedName = memberDetails ? memberDetails.displayName : targetUser.username;
            // Replace <@ID>, <@!ID>, or bare numeric ID
            llmQuery = llmQuery.replace(/<@!?\d{17,20}>/g, resolvedName);
            llmQuery = llmQuery.replace(/\b\d{17,20}\b/g, resolvedName);
            console.log(`[Librarian Bot] Resolved target user: ${resolvedName} (${targetUser.id}). LLM query: "${llmQuery}"`);
        }

        // --- CHAT HISTORY COLLECTION ---
        let chatHistoryContext = 'No recent chat history available.';
        let targetUserContext = '';
        try {
            let messagesToParse = [];
            const isHistoryOrAnalysis = isHistoryOrAnalysisQuery(cleanedQuery) || targetUser !== null;

            if (isHistoryOrAnalysis) {
                console.log(`[Librarian Bot] History/analysis/user query detected. Pulling up to 100 messages...`);
                const historyChunk = await message.channel.messages.fetch({ limit: 100, before: message.id });
                if (historyChunk && historyChunk.size > 0) {
                    messagesToParse = Array.from(historyChunk.values());
                }
            } else {
                const defaultChunk = await message.channel.messages.fetch({ limit: RAG_HISTORY_LIMIT, before: message.id });
                if (defaultChunk && defaultChunk.size > 0) {
                    messagesToParse = Array.from(defaultChunk.values());
                }
            }

            if (messagesToParse.length > 0) {
                if (targetUser) {
                    const targetUserMessages = messagesToParse.filter(m => m.author.id === targetUser.id);
                    let formattedTargetMessages = '';
                    if (targetUserMessages.length > 0) {
                        formattedTargetMessages = targetUserMessages
                            .map(m => `[${new Date(m.createdTimestamp).toISOString().substring(0, 10)}] ${m.cleanContent || m.content}`)
                            .reverse()
                            .join('\n');
                    }
                    const memberDetails = message.guild.members.cache.get(targetUser.id);
                    const displayName = memberDetails ? memberDetails.displayName : targetUser.username;

                    targetUserContext = `Target User Context:
We resolved that the query is asking about the server member: ${targetUser.username} (ID: ${targetUser.id}, Display Name: ${displayName}).
Recent messages by this user:
${formattedTargetMessages || 'None found in the last 100 messages.'}

`;
                }

                const baseSystemPromptText = `Internet Search Context:
        ${searchContext}

        ${targetUserContext}Recent Channel Chat History (oldest to newest):
        

        User Question: [${message.author.username}]: ${llmQuery}

        Answer:`;

                const baseTokens = estimateTokens(baseSystemPromptText);
                const CONTEXT_LIMIT_TOKENS = 6000;
                const historyTokenBudget = Math.max(500, CONTEXT_LIMIT_TOKENS - baseTokens);
                console.log(`[Librarian Bot] Prompt base: ~${baseTokens} tokens, history budget: ~${historyTokenBudget} tokens, messages available: ${messagesToParse.length}`);

                let acceptedHistoryLines = [];
                let currentHistoryTokens = 0;

                for (const m of messagesToParse) {
                    const displayName = m.member?.displayName || m.author.username;
                    const line = `[${displayName} (@${m.author.username}, ID: ${m.author.id})]: ${m.cleanContent || m.content}`;
                    const lineTokens = estimateTokens(line + '\n');

                    if (currentHistoryTokens + lineTokens > historyTokenBudget) {
                        console.log(`[Librarian Bot] Context limit reached. Stopped adding history after ${acceptedHistoryLines.length} messages.`);
                        break;
                    }

                    acceptedHistoryLines.push(line);
                    currentHistoryTokens += lineTokens;
                }

                // Reverse the accepted lines to restore oldest-to-newest chronological order
                acceptedHistoryLines.reverse();
                chatHistoryContext = acceptedHistoryLines.join('\n');
            }
        } catch (historyErr) {
            console.error('Failed to fetch channel history:', historyErr);
        }

        let systemMessage = '';
        if (isNoBs) {
            systemMessage = `You are Librarian, a helpful and knowledgeable TTRPG Discord bot.
IMPORTANT! Answer with as short as possible but not less than 10 words answer. Be straight to the point, DO NOT roleplay, do not use marazm/dementia, and do not jabber.`;
        } else {
            systemMessage = `You are Librarian, an old, slightly senile librarian NPC living inside a TTRPG Discord server. You MUST stay in character for EVERY response.
Your personality:
- You are elderly, forgetful, and a bit confused — you have marazm/dementia.
- You mutter about dusty tomes, creaky shelves, and misplaced scrolls.
- You refer to D&D rules with old-age confusion (mixing up editions, misremembering page numbers, grumbling about "the youth").
- Despite the confusion, you DO provide the correct answer eventually.
- You speak in a rambling, in-character way — NEVER give a dry, factual, encyclopedia-style answer.
- Keep it fun, entertaining, and flavourful. A few sentences of roleplay colour around the answer is MANDATORY.
- If user uses profanity — don't be shy to mimic it in character.`;
        }
        systemMessage += `\nAdditional rules:
- Your main goal is to keep communication around DnD when users ask questions, unless they specify a different topic (fact checking films, shows, rules is acceptable).
- Don't be too pedantic, but don't lie either — use search context to verify your claims.
- Answer the user's question accurately. Use the provided internet search context if it's relevant.
- If the context doesn't help, rely on your internal knowledge or sprinkle some recent news about Tallinn/TTRPG. Answer in English.
- If a "Target User Context" section is provided below, the user is asking about a specific server member. Use the messages listed in that section to answer the question. Summarize what that person posted or said based on their actual messages. Do NOT say you cannot find them or that they haven't posted.
- Generate ONLY the final answer in character. Do NOT append, repeat, or continue any chat history, dialogue turns, or conversation logs.`;

        const userPrompt = `Internet Search Context:
${searchContext}

${targetUserContext}Recent Channel Chat History (oldest to newest):
${chatHistoryContext}

User Question: [${message.author.username}]: ${llmQuery}

Answer (stay in character!):`;

        let answer;
        try {
            const ollamaResponse = await axios.post(OLLAMA_URL, {
                model: OLLAMA_MODEL,
                system: systemMessage,
                prompt: userPrompt,
                stream: false,
                options: {
                    temperature: 0.85,
                    num_ctx: 32768,
                    stop: ["\n[", "\nUser Question:", "\nRecent Channel Chat History", "\nInternet Search Context:"]
                }
            }, { timeout: RAG_OLLAMA_TIMEOUT });
            answer = ollamaResponse.data.response;
        } catch (ollamaErr) {
            console.warn('Ollama query failed, falling back to help text:', ollamaErr.message);
            answer = `*The Librarian shuffles through dusty shelves, muttering to himself. The arcane archives (AI backend) seem to be currently unreachable.* Let me assist you with the basic features instead!\n\n${helpText}`;
        }

        // Stop the typing indicator before sending the response
        clearInterval(typingInterval);

        if (answer.length > 2000) {
            await message.reply(answer.substring(0, 1996) + '...');
        } else {
            await message.reply(answer);
        }
    } catch (err) {
        // Stop the typing indicator in case of error
        clearInterval(typingInterval);
        console.error('Ollama/RAG pipeline error:', err);
        await message.reply('*The connection to the arcane archives was disrupted. (LLM or Search Error)*');
    }
}

module.exports = {
    handleRagQuery
};
