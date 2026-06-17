// === jobLog: per-message job boundary logging ===
//
// Use:
//   const job = startJob(message, 'handleMessageCreate');
//   ... do work ...
//   job.success({ backend: 'gemini-2.5-pro', attempts: 2, chars: 842 });
//   job.failure('local-ollama TIMEOUT');
//   job.skip('skipped: bot author');  // for bot's own messages — no real work done
//
// Output (single line each, so they're greppable and one per job):
//   [JOB] 🟡 123456789 START  kind=handleMessageCreate channel=#general author=sneakyjoe len=84 content="hello"
//   [JOB] ✅ 123456789 OK     kind=handleMessageCreate ... duration=12340ms backend=gemini-2.5-flash attempts=2 chars=842
//   [JOB] ❌ 123456789 FAIL   kind=handleMessageCreate ... reason="local-ollama TIMEOUT"
//   [JOB] 🔰 123456789 CHAIN  kind=handleMessageCreate ... duration=1ms stage="skipped: bot author"
//   [JOB] ℹ️  123456789 INFO   kind=handleMessageCreate ... stage="skipped: bot author"

const MAX_CONTENT_PREVIEW = 120;

function safeStr(v) {
    if (v === null || v === undefined) return '';
    return String(v);
}

function truncateContent(content) {
    if (!content) return '';
    // Collapse newlines/tabs to single space for log readability
    const flat = String(content).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (flat.length <= MAX_CONTENT_PREVIEW) return flat;
    return flat.substring(0, MAX_CONTENT_PREVIEW) + '...';
}

function startJob(message, kind) {
    // Normalize input: accept Discord Message OR ChatInputCommandInteraction OR a plain
    // { id, channelId, author/user, content } object. This lets us use the same helper
    // for both messageCreate and slash-command entry points.
    const msgId = safeStr(message && message.id);
    const channelId = safeStr(
        (message && message.channel && message.channel.id) ||
        (message && message.channelId) ||
        ''
    );
    const authorTag = safeStr(
        (message && message.author && (message.author.tag || message.author.username || message.author.id)) ||
        (message && message.user && (message.user.tag || message.user.username || message.user.id)) ||
        ''
    );
    const rawContent = (message && (message.cleanContent || message.content)) || '';
    const content = truncateContent(rawContent);
    const hasAttachments = !!(message && message.attachments && message.attachments.size);
    const t0 = Date.now();

    // Prefix used on every line so the original message id and content preview are visible
    // both at job start and on completion/failure.
    const prefix = `kind=${kind} channel=${channelId} author=${authorTag} len=${rawContent.length} attach=${hasAttachments} content="${content}"`;

    console.log(`[JOB] 🟡 ${msgId} START  ${prefix}`);

    function fmt(meta) {
        const dur = Date.now() - t0;
        const parts = [`duration=${dur}ms`];
        if (meta) {
            for (const k of Object.keys(meta)) {
                const v = meta[k];
                if (v === undefined || v === null) continue;
                if (typeof v === 'string' && v.includes(' ')) {
                    parts.push(`${k}="${v}"`);
                } else {
                    parts.push(`${k}=${v}`);
                }
            }
        }
        return parts.join(' ');
    }

    return {
        success(meta) {
            // Include the original message id and content preview on completion so logs
            // can be cross-referenced with the triggering Discord message.
            console.log(`[JOB] ✅ ${msgId} OK     ${prefix} ${fmt(meta)}`);
        },
        failure(reason, meta) {
            const m = Object.assign({ reason: safeStr(reason).substring(0, 200) }, meta || {});
            console.warn(`[JOB] ❌ ${msgId} FAIL   ${prefix} ${fmt(m)}`);
        },
        info(stage) {
            // Mid-job marker; useful for long-running jobs to show progress without changing state.
            console.log(`[JOB] ℹ️ ${msgId} INFO   ${prefix} ${fmt({ stage: safeStr(stage).substring(0, 100) })}`);
        },
        skip(reason) {
            // Used for bot's own messages: they spawn a handleMessageCreate event but are
            // immediately completed (skipped). Uses 🔰 to distinguish from real user jobs.
            // Shows as a single completed line instead of 🟡 START + ℹ️ INFO.
            const dur = Date.now() - t0;
            console.log(`[JOB] 🔰 ${msgId} CHAIN  ${prefix} duration=${dur}ms stage="${safeStr(reason).substring(0, 100)}"`);
        },
        elapsedMs() {
            return Date.now() - t0;
        }
    };
}

module.exports = {
    startJob,
    truncateContent,
    safeStr
};
