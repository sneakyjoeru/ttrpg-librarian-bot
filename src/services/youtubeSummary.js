// TL;DW (YouTube video summarization) — ported from discord-joe's tldw
// pipeline in messageCreate.js. Fetches the video's transcript via yt-dlp
// (src/services/ytTranscript.js) and summarizes it with the librarian bot's
// existing DeepSeek-primary / Ollama-fallback LLM pipeline (mirrors rag.js).
const axios = require('axios');
const { PermissionFlagsBits } = require('discord.js');
const { getYoutubeTranscript } = require('./ytTranscript');
const { consumeQuota, formatDuration } = require('../utils/quota');
const {
    OLLAMA_URL,
    OLLAMA_MODEL,
    RAG_OLLAMA_TIMEOUT,
    RAG_TYPING_INTERVAL,
    DM_ROLE_ID,
    ADMIN_ROLE_ID,
    DISCORD_MESSAGE_LIMIT,
    deepseekApiKey,
    DEEPSEEK_API_URL,
    DEEPSEEK_MODEL
} = require('../config');

const YOUTUBE_LINK_REGEX = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i;

// Keywords that, combined with a reply-to-a-message-with-a-link, or a bare
// bot mention with no link of its own, mean "summarize the video" rather than
// a normal RAG question. Mirrors discord-joe's reviewKeywords set.
const TLDW_KEYWORDS = /(?:tl;?dw|tl;?dr|tldw|tldr|пересказ|перескажи|review|обзор|резюме|summary|summarize|содержание|о\s+чём\s+видео|что\s+в\s+видео|what'?s?\s+in\s+(?:the\s+|this\s+)?video|what\s+is\s+this\s+video\s+about|расскажи\s+(?:про\s+)?видео)/i;

const CHUNK_SIZE = 80000; // chars per transcript chunk before we need a map-reduce summary
const THREAD_AUTO_ARCHIVE_MINUTES = 1440;

function extractYoutubeVideoId(text) {
    if (!text) return null;
    const m = text.match(YOUTUBE_LINK_REGEX);
    return m ? m[1] : null;
}

// Resolves the target video id for a mention that may or may not carry its
// own link. Checks (in order): a link in the current message, then — only if
// the user used a TL;DW-style keyword — a link in the message being replied to.
async function resolveYoutubeVideoId(message, query) {
    const directId = extractYoutubeVideoId(message.content);
    if (directId) return directId;

    if (message.reference && message.reference.messageId && TLDW_KEYWORDS.test(query)) {
        try {
            const refMsg = await message.channel.messages.fetch(message.reference.messageId);
            const refId = extractYoutubeVideoId(refMsg.content);
            if (refId) return refId;
        } catch (err) {
            console.warn('[YouTube Summary] Failed to fetch replied-to message:', err.message);
        }
    }

    return null;
}

function splitIntoChunks(text, maxLen) {
    if (text.length <= maxLen) return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxLen) { chunks.push(remaining); break; }
        let splitAt = remaining.lastIndexOf('\n', maxLen);
        if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(' ', maxLen);
        if (splitAt < maxLen * 0.3) splitAt = maxLen;
        chunks.push(remaining.substring(0, splitAt));
        remaining = remaining.substring(splitAt).replace(/^\s+/, '');
    }
    return chunks;
}

function buildSystemMessage(userQuestion) {
    return `You are Librarian, a helpful and knowledgeable TTRPG Discord bot.
You have been given the transcript of a YouTube video. Summarize it accurately based ONLY on the transcript content — do not invent details that are not present.
Keep the summary concise and easy to scan (a short overview plus a few key points is enough). Avoid padding or filler.
${userQuestion ? `The user specifically asked: "${userQuestion}" — answer that using the transcript, in addition to (or instead of) a generic summary if it makes more sense.` : ''}
Answer in English unless the transcript/user question is in another language, in which case answer in that language.`;
}

function getQuotaDecision(message) {
    const isAdmin = !!(
        message.member &&
        (
            (ADMIN_ROLE_ID && message.member.roles?.cache?.has(ADMIN_ROLE_ID)) ||
            (DM_ROLE_ID && message.member.roles?.cache?.has(DM_ROLE_ID)) ||
            message.member.permissions?.has(PermissionFlagsBits.Administrator)
        )
    );
    return consumeQuota(message.author.id, isAdmin);
}

// quotaDecision is resolved ONCE per summarization request (not per chunk) —
// a multi-chunk map-reduce summary must not burn multiple quota slots for
// what the user experiences as a single request.
async function callLLM(systemMessage, userPrompt, quotaDecision) {
    let quotaExhaustedNotice = null;

    if (quotaDecision.allowed && deepseekApiKey) {
        try {
            const deepseekResponse = await axios.post(DEEPSEEK_API_URL, {
                model: DEEPSEEK_MODEL,
                messages: [
                    { role: 'system', content: systemMessage },
                    { role: 'user', content: userPrompt }
                ],
                stream: false,
                temperature: 0.4
            }, {
                timeout: 30000,
                headers: {
                    'Authorization': `Bearer ${deepseekApiKey}`,
                    'Content-Type': 'application/json'
                }
            });
            return { answer: deepseekResponse.data.choices[0].message.content, quotaExhaustedNotice };
        } catch (deepseekErr) {
            console.warn(`[YouTube Summary] DeepSeek call failed, falling back to local Ollama: ${deepseekErr.message}`);
        }
    } else if (!quotaDecision.allowed && quotaDecision.used >= quotaDecision.limit) {
        const inMs = Math.max(0, (quotaDecision.resetAt || 0) - Date.now());
        quotaExhaustedNotice = `*The Librarian mutters that the brighter shelves are dim for now — only the local archives are within reach. (Resets in ${formatDuration(inMs)})*`;
    }

    const ollamaResponse = await axios.post(OLLAMA_URL, {
        model: OLLAMA_MODEL,
        system: systemMessage,
        prompt: userPrompt,
        stream: false,
        options: { temperature: 0.4, num_ctx: 32768 }
    }, { timeout: RAG_OLLAMA_TIMEOUT });
    return { answer: ollamaResponse.data.response, quotaExhaustedNotice };
}

async function handleYoutubeSummary(client, message, query, videoId) {
    await message.channel.sendTyping();
    const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
    }, RAG_TYPING_INTERVAL);

    let statusMsg = null;
    try {
        statusMsg = await message.reply('⏳ *Fetching subtitles...*');
    } catch (_) {}

    try {
        let transcript;
        let videoTitle = '';
        try {
            ({ transcript, title: videoTitle } = await getYoutubeTranscript(videoId));
        } catch (transcriptErr) {
            console.error('[YouTube Summary] Transcript fetch failed:', transcriptErr.message);
            clearInterval(typingInterval);
            const failMsg = 'Could not fetch subtitles for this video (none available, or the download failed).';
            if (statusMsg) await statusMsg.edit(failMsg).catch(() => {});
            else await message.reply(failMsg).catch(() => {});
            return;
        }

        if (!transcript || transcript.length < 50) {
            clearInterval(typingInterval);
            const failMsg = 'The subtitles for this video are missing or too short to summarize.';
            if (statusMsg) await statusMsg.edit(failMsg).catch(() => {});
            else await message.reply(failMsg).catch(() => {});
            return;
        }

        if (transcript.length > 500000) transcript = transcript.substring(0, 500000);

        if (statusMsg) await statusMsg.edit('⏳ *Summarizing...*').catch(() => {});

        const userQuestion = query.replace(YOUTUBE_LINK_REGEX, '').trim();
        const systemMessage = buildSystemMessage(userQuestion);
        const quotaDecision = getQuotaDecision(message);

        let answer;
        if (transcript.length > CHUNK_SIZE) {
            const chunks = splitIntoChunks(transcript, CHUNK_SIZE);
            const partialSummaries = [];
            for (let i = 0; i < chunks.length; i++) {
                if (statusMsg) await statusMsg.edit(`⏳ *Analyzing part ${i + 1}/${chunks.length}...*`).catch(() => {});
                const chunkPrompt = `Video transcript (part ${i + 1}/${chunks.length}):\n${chunks[i]}\n\nSummarize this part concisely.`;
                const { answer: partial } = await callLLM(systemMessage, chunkPrompt, quotaDecision);
                partialSummaries.push(partial);
            }
            if (statusMsg) await statusMsg.edit('⏳ *Combining parts...*').catch(() => {});
            const combinePrompt = `Here are summaries of consecutive parts of the same video transcript:\n\n${partialSummaries.map((s, i) => `Part ${i + 1}: ${s}`).join('\n\n')}\n\nCombine these into a single coherent summary of the whole video.${userQuestion ? ` The user specifically asked: "${userQuestion}" — make sure to address that.` : ''}`;
            const { answer: combined, quotaExhaustedNotice } = await callLLM(systemMessage, combinePrompt, quotaDecision);
            answer = quotaExhaustedNotice ? `${quotaExhaustedNotice}\n\n${combined}` : combined;
        } else {
            const userPrompt = `Video transcript:\n${transcript}\n\nProvide the summary.`;
            const { answer: single, quotaExhaustedNotice } = await callLLM(systemMessage, userPrompt, quotaDecision);
            answer = quotaExhaustedNotice ? `${quotaExhaustedNotice}\n\n${single}` : single;
        }

        clearInterval(typingInterval);

        const chunks = splitIntoChunks(answer, DISCORD_MESSAGE_LIMIT - 50);
        if (statusMsg && !message.channel.isThread()) {
            try {
                const displayTitle = videoTitle || `YouTube video ${videoId}`;
                await statusMsg.edit(`📺 **TL;DW:** ${displayTitle} — see thread below.`);
                const thread = await statusMsg.startThread({
                    name: `📺 ${displayTitle}`.substring(0, 100),
                    autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES
                });
                // Discord auto-joins the replied-to user to a thread started on
                // the reply; drop them so they aren't pinged by every chunk.
                await thread.members.remove(message.author.id).catch(() => {});
                for (const chunk of chunks) {
                    await thread.send(chunk);
                }
                return;
            } catch (threadErr) {
                console.warn('[YouTube Summary] Thread post failed, falling back to plain messages:', threadErr.message);
            }
        }

        if (statusMsg) {
            await statusMsg.edit(chunks[0]).catch(() => {});
        } else {
            await message.reply(chunks[0]).catch(() => {});
        }
        for (let i = 1; i < chunks.length; i++) {
            await message.channel.send(chunks[i]).catch(() => {});
        }
    } catch (err) {
        clearInterval(typingInterval);
        console.error('[YouTube Summary] Pipeline error:', err);
        const failMsg = '*Failed to summarize this video.*';
        if (statusMsg) await statusMsg.edit(failMsg).catch(() => {});
        else await message.reply(failMsg).catch(() => {});
    }
}

module.exports = {
    YOUTUBE_LINK_REGEX,
    TLDW_KEYWORDS,
    extractYoutubeVideoId,
    resolveYoutubeVideoId,
    handleYoutubeSummary
};
