const axios = require('axios');
const { PermissionFlagsBits } = require('discord.js');
const { estimateTokens, isHistoryOrAnalysisQuery } = require('../utils/helpers');
const { consumeQuota, formatDuration } = require('../utils/quota');
const {
    helpText,
    SEARXNG_URL,
    OLLAMA_URL,
    OLLAMA_MODEL,
    RAG_SEARCH_LIMIT,
    RAG_HISTORY_LIMIT,
    RAG_SEARCH_TIMEOUT,
    RAG_OLLAMA_TIMEOUT,
    RAG_TYPING_INTERVAL,
    DM_ROLE_ID,
    ADMIN_ROLE_ID,
    deepseekApiKey,
    DEEPSEEK_API_URL,
    DEEPSEEK_MODEL
} = require('../config');

const LIBRARIAN_QUIRKS = [
    "You are currently searching for your lost spectacles, grumbling that they might be in a soup bowl.",
    "You are complaining about a cold draft coming from the library floorboards.",
    "You are holding a dusty tome about ancient dragons and keep coughing from the dust.",
    "You are convinced the user is your long-lost nephew or assistant named Barnaby.",
    "You are trying to wipe off a sticky blue ink stain from your fingers.",
    "You keep hearing non-existent loud whispering and try to shush the empty corners of the room.",
    "You are convinced it is half-past tea time and mutter about needing a dry biscuit.",
    "You are struggling to open a stubborn scroll container that seems stuck with age.",
    "You keep forgetting what you were saying mid-sentence and muttering 'what was I about...?'",
    "You are complaining about the youth of today using shiny magic items instead of proper ink and parchment."
];

async function checkResponseQuality(userQuery, answer) {
    if (!userQuery) return true;
    const evalPrompt = `You are a strict quality controller.
Evaluate whether the following generated response is an acceptable answer that matches and directly answers the user's query.

User Query: "${userQuery}"
Generated Response: "${answer}"

Check if:
1. The response actually answers the user's question or intent.
2. The response is not hallucinated, completely off-topic, or polluted with garbage/Chinese characters.
3. The response makes sense given the query.

Respond with exactly "YES" if the answer matches and is acceptable.
Respond with exactly "NO" if the answer does not match, does not answer the query, or is unacceptable.

Do not write any other text. Reply with either YES or NO.`;

    try {
        const response = await axios.post(OLLAMA_URL, {
            model: OLLAMA_MODEL,
            prompt: evalPrompt,
            stream: false,
            options: {
                temperature: 0.1,
                num_ctx: 2048
            }
        }, { timeout: 8000 });

        const result = response.data.response.trim().toUpperCase();
        console.log(`[Response Quality Check] Local quality check outcome: ${result}`);

        if (result.includes('YES') && !result.includes('NO')) {
            return true;
        }
        return false;
    } catch (err) {
        console.warn(`[Response Quality Check] Quality check failed/timed out: ${err.message}; treating as PASS to avoid block`);
        return true;
    }
}

async function handleRagQuery(client, message, query) {
    const seed = Math.floor(Math.random() * 1000000);
    const randomQuirk = LIBRARIAN_QUIRKS[seed % LIBRARIAN_QUIRKS.length];
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
- If user uses profanity — don't be shy to mimic it in character.
- Current senile quirk to guide your response mood/action: ${randomQuirk}`;
        }
        systemMessage += `\nAdditional rules:
- Your main goal is to keep communication around DnD when users ask questions, unless they specify a different topic (fact checking films, shows, rules is acceptable).
- Don't be too pedantic, but don't lie either — use search context to verify your claims.
- Answer the user's question accurately. Use the provided internet search context if it's relevant.
- If the context doesn't help, rely on your internal knowledge or sprinkle some recent news about Tallinn/TTRPG. Answer in English.
- If a "Target User Context" section is provided below, the user is asking about a specific server member. Use the messages listed in that section to answer the question. Summarize what that person posted or said based on their actual messages. Do NOT say you cannot find them or that they haven't posted.
- Generate ONLY the final answer in character. Do NOT append, repeat, or continue any chat history, dialogue turns, or conversation logs.
- Seed value: ${seed}. Use this seed to make your roleplay unique, and do NOT repeat the exact same greetings, endings, or comments as those in the chat history.`;

        const userPrompt = `Internet Search Context:
${searchContext}

${targetUserContext}Recent Channel Chat History (oldest to newest):
${chatHistoryContext}

User Question: [${message.author.username}]: ${llmQuery}

Answer (stay in character!):`;

        let answer;
        let deepseekSuccess = false;
        let quotaExhaustedNotice = null;

        // --- QUOTA GATE ---
        // While the requesting user has DeepSeek quota remaining we route to
        // DeepSeek first (cloud, faster, higher quality). When their quota is
        // exhausted we use the legacy local-Ollama pipeline with its own
        // quality check + DeepSeek fallback.
        //
        // Two tiers, tracked in independent per-user buckets inside
        // src/utils/quota.js:
        //   regular -> 10 requests / 5 hours  (QUOTA_MAX_REQUESTS / QUOTA_WINDOW_HOURS)
        //   admin   -> 30 requests / 3 hours  (QUOTA_ADMIN_MAX_REQUESTS / QUOTA_ADMIN_WINDOW_HOURS)
        // An "admin" (for quota purposes) is a guild member who has any of:
        //   - the server ADMIN_ROLE_ID role, OR
        //   - the DM_ROLE_ID role (DMs get the same quota bump because they
        //     drive campaigns and frequently query the bot), OR
        //   - the Administrator permission.
        // This is a superset of the slash-command permission check
        // (interactions.js) — that one only allows DM_ROLE_ID / Administrator
        // for the campaign-management commands. The quota check is more
        // generous because it only affects the per-user DeepSeek rate limit
        // and not what the user can do in the server.
        // In DMs (no message.member) the user is treated as regular.
        const isAdmin = !!(
            message.member &&
            (
                (ADMIN_ROLE_ID && message.member.roles?.cache?.has(ADMIN_ROLE_ID)) ||
                (DM_ROLE_ID && message.member.roles?.cache?.has(DM_ROLE_ID)) ||
                message.member.permissions?.has(PermissionFlagsBits.Administrator)
            )
        );
        const quotaDecision = consumeQuota(message.author.id, isAdmin);
        const useDeepSeekFirst = quotaDecision.allowed;
        const profile = quotaDecision.profile || 'regular';

        if (!quotaDecision.allowed && quotaDecision.used >= quotaDecision.limit) {
            const inMs = Math.max(0, (quotaDecision.resetAt || 0) - Date.now());
            console.log(`[Librarian Bot] Quota exhausted for user ${message.author.id} (${profile} ${quotaDecision.used}/${quotaDecision.limit}); falling back to local Ollama pipeline. Resets in ${formatDuration(inMs)}.`);
            quotaExhaustedNotice = `*The Librarian adjusts his spectacles and mutters that the brighter shelves are dim for now — only the local archives are within reach. (Resets in ${formatDuration(inMs)})*`;
        } else {
            console.log(`[Librarian Bot] Quota OK for user ${message.author.id} (${profile} ${quotaDecision.used}/${quotaDecision.limit} used); routing to DeepSeek first.`);
        }

        if (useDeepSeekFirst) {
            // --- DEEPSEEK-FIRST PATH ---
            // Only attempted when the user still has quota. On success we use
            // the DeepSeek answer directly; on failure we fall back to the
            // existing Ollama pipeline (which itself can fall back to DeepSeek).
            if (deepseekApiKey) {
                try {
                    console.log(`[Librarian Bot] Calling DeepSeek API (quota path, model: ${DEEPSEEK_MODEL})...`);
                    const deepseekResponse = await axios.post(DEEPSEEK_API_URL, {
                        model: DEEPSEEK_MODEL,
                        messages: [
                            { role: 'system', content: systemMessage },
                            { role: 'user', content: userPrompt }
                        ],
                        stream: false,
                        temperature: 0.85
                    }, {
                        timeout: 30000,
                        headers: {
                            'Authorization': `Bearer ${deepseekApiKey}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    answer = deepseekResponse.data.choices[0].message.content;
                    deepseekSuccess = true;
                    console.log(`[Librarian Bot] DeepSeek response retrieved successfully (quota path).`);
                } catch (deepseekErr) {
                    console.warn(`[Librarian Bot] DeepSeek call failed on quota path, falling back to local Ollama: ${deepseekErr.message}`);
                }
            } else {
                console.warn(`[Librarian Bot] No DeepSeek API key configured; skipping quota path.`);
            }
        }

        if (!deepseekSuccess) {
            // --- LOCAL OLLAMA PATH (existing behavior) ---
            // Either quota is exhausted (preferred path) or the DeepSeek quota
            // call failed (fallback). Behavior is identical to the original
            // pipeline: try Ollama, quality-check, fall back to DeepSeek on
            // failure.
            let localOllamaSuccess = false;
            try {
                console.log(`[Librarian Bot] Attempting local Ollama query...`);
                const ollamaResponse = await axios.post(OLLAMA_URL, {
                    model: OLLAMA_MODEL,
                    system: systemMessage,
                    prompt: userPrompt,
                    stream: false,
                    options: {
                        temperature: 0.85,
                        num_ctx: 32768,
                        seed: seed,
                        stop: ["\n[", "\nUser Question:", "\nRecent Channel Chat History", "\nInternet Search Context:"]
                    }
                }, { timeout: RAG_OLLAMA_TIMEOUT });
                answer = ollamaResponse.data.response;

                // Check quality of Ollama response
                console.log(`[Librarian Bot] Verifying local Ollama response quality...`);
                const qualityOk = await checkResponseQuality(cleanedQuery, answer);
                if (qualityOk) {
                    localOllamaSuccess = true;
                } else {
                    console.warn(`[Librarian Bot] Local Ollama response failed quality check. Falling back to DeepSeek.`);
                }
            } catch (ollamaErr) {
                console.warn('Ollama query failed/timed out, falling back to DeepSeek:', ollamaErr.message);
            }

            if (!localOllamaSuccess) {
                if (deepseekApiKey) {
                    try {
                        console.log(`[Librarian Bot] Calling DeepSeek API fallback (model: ${DEEPSEEK_MODEL})...`);
                        const deepseekResponse = await axios.post(DEEPSEEK_API_URL, {
                            model: DEEPSEEK_MODEL,
                            messages: [
                                { role: 'system', content: systemMessage },
                                { role: 'user', content: userPrompt }
                            ],
                            stream: false,
                            temperature: 0.85
                        }, {
                            timeout: 30000,
                            headers: {
                                'Authorization': `Bearer ${deepseekApiKey}`,
                                'Content-Type': 'application/json'
                            }
                        });
                        answer = deepseekResponse.data.choices[0].message.content;
                        console.log(`[Librarian Bot] DeepSeek response retrieved successfully.`);
                    } catch (deepseekErr) {
                        console.error('DeepSeek fallback failed:', deepseekErr.message);
                        answer = `*The Librarian shuffles through dusty shelves, muttering to himself. The arcane archives (AI backend) seem to be currently unreachable.* Let me assist you with the basic features instead!\n\n${helpText}`;
                    }
                } else {
                    console.warn('No DeepSeek API key configured, falling back to help text.');
                    answer = `*The Librarian shuffles through dusty shelves, muttering to himself. The arcane archives (AI backend) seem to be currently unreachable.* Let me assist you with the basic features instead!\n\n${helpText}`;
                }
            }
        }

        // Stop the typing indicator before sending the response
        clearInterval(typingInterval);

        // Prepend the quota-exhausted notice (if any) so the user knows they
        // are on the local pipeline. DeepSeek-success path stays silent.
        if (quotaExhaustedNotice) {
            answer = `${quotaExhaustedNotice}\n\n${answer}`;
        }

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
