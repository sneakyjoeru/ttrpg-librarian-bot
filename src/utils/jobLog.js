// Simplified jobLog for the librarian bot.
// robot-joe's jobLog ties into a jobsRegistry + Discord presence tracking; the
// librarian bot has none of that, so this is a minimal logger that keeps the
// same call surface (startJob -> job.success/failure/skip/info) so the ported
// platform handlers compile and log without the presence machinery.

const MAX_CONTENT_PREVIEW = 120;

function safeStr(v) {
    if (v === null || v === undefined) return '';
    return String(v);
}

function truncateContent(content) {
    if (!content) return '';
    const flat = String(content).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (flat.length <= MAX_CONTENT_PREVIEW) return flat;
    return flat.substring(0, MAX_CONTENT_PREVIEW) + '...';
}

function startJob(message, kind) {
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

    const prefix = `kind=${kind} channel=${channelId} author=${authorTag} len=${rawContent.length} attach=${hasAttachments} content="${content}"`;
    const isRecoveryJob = typeof kind === 'string' && kind.startsWith('recover:');
    const startEmoji = isRecoveryJob ? '♻️' : '🟡';
    const okEmoji = isRecoveryJob ? '♻️' : '🟢';

    console.log(`[JOB] ${startEmoji} ${msgId} START  ${prefix}`);

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
            console.log(`[JOB] ${okEmoji} ${msgId} OK     ${prefix} ${fmt(meta)}`);
        },
        failure(reason, meta) {
            const m = Object.assign({ reason: safeStr(reason).substring(0, 200) }, meta || {});
            console.warn(`[JOB] ❌ ${msgId} FAIL   ${prefix} ${fmt(m)}`);
        },
        info(stage) {
            console.log(`[JOB] ℹ️ ${msgId} INFO   ${prefix} ${fmt({ stage: safeStr(stage).substring(0, 100) })}`);
        },
        skip(reason) {
            const dur = Date.now() - t0;
            console.log(`[JOB] 🔰 ${msgId} CHAIN  ${prefix} duration=${dur}ms stage="${safeStr(reason).substring(0, 100)}"`);
        },
        elapsedMs() {
            return Date.now() - t0;
        }
    };
}

module.exports = { startJob, truncateContent };