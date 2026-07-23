const { PermissionFlagsBits } = require('discord.js');
const {
    SERVER_ID,
    ACTIVE_CATEGORY_ID,
    DM_ROLE_ID,
    EMBED_COLOR,
    NUMBER_EMOJIS,
    RANDOM_EMOJIS
} = require('../config');
const { getLibrarianData } = require('../utils/helpers');
const {
    parseSchedulingInput,
    generateScheduleOptions,
    buildIcs,
    getSchedule,
    setSchedule,
    updateSchedule
} = require('../utils/scheduling');
const { refreshPoll } = require('./polls');

// In-flight lock: prevents concurrent handleSchedulingVoteChange calls for the
// same poll from racing past the lastEmittedConfirmed check and posting
// duplicate calendar attachments.
const _schedulingInFlight = new Map();

// Month lookup for reconstructing schedule state from embed labels.
const MONTH_LOOKUP = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

// Reconstructs schedule state from a poll embed + channel metadata when the
// persisted state was lost (e.g. schedules.json deleted by SMB watcher
// before the exclude was added, or container restart). Parses the embed
// description blocks to recover emoji + label + isoDate + time window.
function reconstructScheduleFromEmbed(message, embed, roleId) {
    const description = embed.description || '';
    const blocks = description.split('\n\n').filter(Boolean);
    const allEmojis = [...NUMBER_EMOJIS, ...RANDOM_EMOJIS];
    const options = [];
    const now = new Date();
    const currentYear = now.getUTCFullYear();

    for (const block of blocks) {
        const firstLine = block.split('\n')[0];
        for (const emoji of allEmojis) {
            if (firstLine.startsWith(emoji)) {
                const label = firstLine.slice(emoji.length).trim();
                // Label format: "Sat 25 Jul" or "Sat 25 Jul 18:00-22:00"
                const m = label.match(/^(\w{3})\s+(\d+)\s+(\w{3})(?:\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2}))?$/);
                if (!m) break;
                const day = parseInt(m[2], 10);
                const month = MONTH_LOOKUP[m[3]];
                if (!month) break;
                // Determine the year: use current year, or next year if the
                // date has already passed.
                let year = currentYear;
                const candidate = new Date(Date.UTC(year, month - 1, day));
                if (candidate < new Date(Date.UTC(currentYear, now.getUTCMonth(), now.getUTCDate()))) {
                    year = currentYear + 1;
                }
                const isoDate = `${year}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
                const start = m[4] || null;
                const end = m[5] || null;
                options.push({ emoji, isoDate, start, end, allDay: !start, label });
                break;
            }
        }
    }

    if (options.length === 0) return null;

    return {
        channelId: message.channelId || message.channel?.id,
        guildId: message.guildId || message.guild?.id,
        creatorId: null,
        roleId,
        options,
        lastEmittedConfirmed: null,
        consensusField: null,
        createdAt: Date.now(),
        reconstructed: true
    };
}

// Scheduling polls reuse the live-results machinery from polls.js. They are
// identified by an embed title prefixed with `📅 ` (vs `📊 ` for regular
// polls). The full option list (emoji + ISO datetime + time window) is
// persisted to data/schedules.json keyed by the poll message id, so the
// calendar-emission step can run on every vote change without re-parsing the
// embed.

const SCHEDULE_TITLE_PREFIX = '📅 ';

function isScheduleEmbed(embed) {
    return !!(embed && embed.title && embed.title.startsWith(SCHEDULE_TITLE_PREFIX));
}

// Picks the voting emoji set. NUMBER_EMOJIS covers up to 10 options; per the
// feature spec, anything strictly greater than 9 uses the RANDOM_EMOJIS pool
// (and is capped at RANDOM_EMOJIS.length / SCHEDULE_MAX_OPTIONS upstream).
function pickEmojis(optionCount) {
    if (optionCount <= 9) {
        return NUMBER_EMOJIS.slice(0, optionCount);
    }
    if (optionCount > RANDOM_EMOJIS.length) {
        throw new Error(`Too many options (${optionCount}); maximum is ${RANDOM_EMOJIS.length}.`);
    }
    return RANDOM_EMOJIS.slice(0, optionCount);
}

// Human-readable summary of the spec, used as the poll question/title.
// Groups the selected weekdays by their time window so per-day times read
// naturally, e.g. "Wednesday @ 14:00-16:00 & Friday @ 18:00-22:00 — next 4
// weeks", or "Wednesday & Friday @ 18:00-22:00 — ..." when shared, or
// "Wednesday & Friday — ..." when all-day.
function summarizeSpec(spec) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const ALLDAY_KEY = '__allday__';
    const groups = {};          // key → [dayName,...]
    for (const idx of spec.days) {
        const w = spec.dayTimes && spec.dayTimes[idx];
        const key = w ? `${w.start}-${w.end}` : ALLDAY_KEY;
        (groups[key] = groups[key] || []).push(dayNames[idx]);
    }
    // Stable group order: keep the order in which each group first appeared.
    const order = Object.keys(groups);
    const parts = order.map(key => {
        const names = groups[key].join(' & ');
        if (key === ALLDAY_KEY) return names;
        return `${names} @ ${key}`;
    });
    return `Scheduling: ${parts.join(' & ')} — next ${spec.weeks} week${spec.weeks === 1 ? '' : 's'}`;
}

// --- CREATION ---
// Called from interactions.js for /schedule-poll. Builds the date list,
// posts the embed, reacts with the chosen emojis, persists state, and seeds
// the live "No votes yet" display via refreshPoll.
async function createSchedulePoll(interaction) {
    // DM or Admin only — mirrors the campaign-management permission gate.
    const hasPermission = interaction.member.roles.cache.has(DM_ROLE_ID)
        || interaction.member.permissions.has(PermissionFlagsBits.Administrator);
    if (!hasPermission) {
        return interaction.reply({ content: 'Only DMs or Admins can create scheduling polls.', ephemeral: true });
    }

    const raw = interaction.options.getString('input');

    let spec, options;
    try {
        spec = parseSchedulingInput(raw);
        options = generateScheduleOptions(spec);
    } catch (e) {
        return interaction.reply({
            content: `📅 Could not build the scheduling poll:\n> ${e.message}\n\n**Usage:** \`days [time] [days [time] ...] weeks\`\nExamples: \`Wednesday Friday 4\` · \`Weekdays 18:00-22:00 6\` · \`Wed 14:00-16:00 Fri 18:00-22:00 4\`\nDays also accept the group tokens \`weekdays\`/\`wdy\` (Mon–Fri) and \`weekends\`/\`wke\`/\`wkd\` (Sat–Sun).`,
            ephemeral: true
        });
    }

    let emojis;
    try {
        emojis = pickEmojis(options.length);
    } catch (e) {
        return interaction.reply({ content: `📅 ${e.message}`, ephemeral: true });
    }

    const description = options.map((o, i) => `${emojis[i]} ${o.label}\n\n`).join('');

    const pollEmbed = {
        color: EMBED_COLOR,
        title: `${SCHEDULE_TITLE_PREFIX}${summarizeSpec(spec)}`,
        description
    };

    await interaction.reply({ embeds: [pollEmbed], fetchReply: true });
    const pollMessage = await interaction.fetchReply();

    // React with the chosen emojis so members can vote.
    try {
        for (const emoji of emojis) {
            await pollMessage.react(emoji);
        }
    } catch (e) {
        console.error('[Scheduling] Failed to react to scheduling poll:', e.message);
    }

    // Resolve the channel's campaign role (if any) so the calendar trigger
    // knows the voting group. Outside an active campaign channel there is no
    // group, so roleId stays null and no .ics is ever emitted (the poll still
    // works as a plain live-results poll).
    let roleId = null;
    if (interaction.channel && interaction.channel.parentId === ACTIVE_CATEGORY_ID) {
        const metaData = await getLibrarianData(interaction.channel);
        if (metaData && metaData.roleId) roleId = metaData.roleId;
    }

    setSchedule(pollMessage.id, {
        channelId: interaction.channelId,
        guildId: interaction.guildId,
        creatorId: interaction.user.id,
        roleId,
        options: options.map((o, i) => ({ emoji: emojis[i], isoDate: o.isoDate, start: o.start, end: o.end, allDay: o.allDay, label: o.label })),
        lastEmittedConfirmed: null,
        consensusField: null,
        createdAt: Date.now()
    });

    // Seed the live voter display ("No votes yet" per option).
    await refreshPoll(pollMessage, interaction.client.user.id).catch(console.error);

    return interaction.followUp({
        content: `📅 Scheduling poll posted with ${options.length} date${options.length === 1 ? '' : 's'}${roleId ? '. When every campaign-role member has voted for the same date(s) (the DM may abstain), a Google-importable calendar (.ics) is attached to this poll automatically — and updated whenever the confirmed set of dates changes.' : '.'}`,
        ephemeral: true
    }).catch(() => {});
}

// --- VOTE → CALENDAR TRIGGER ---
// Invoked from reactions.js after the generic poll vote-tracking has run.
// If the reacted message is a scheduling poll in a campaign channel with a
// known role, checks which options have been voted for by EVERY eligible
// voter (the campaign role members + the channel's DM — the same set
// isAllowedVoter in polls.js permits to vote, minus generic admins who are
// moderators rather than required campaign participants). Whenever the set
// of such unanimously-confirmed options CHANGES (grows, shrinks, or swaps),
// a fresh Google-importable .ics is generated and posted as a file
// attachment. The previously-emitted confirmed-set signature is stored in
// state.lastEmittedConfirmed so vote churn that leaves the consensus
// unchanged doesn't re-emit the same calendar.
async function handleSchedulingVoteChange(message, clientUserId) {
    if (!message || !message.embeds || message.embeds.length === 0) return;
    if (message.guild?.id !== SERVER_ID) return;
    const embed = message.embeds[0];
    if (!isScheduleEmbed(embed)) return;

    // Prevent concurrent execution for the same poll — avoids a TOCTOU race
    // where two simultaneous reactions both pass the lastEmittedConfirmed
    // check and each posts a calendar attachment.
    if (_schedulingInFlight.has(message.id)) return;
    _schedulingInFlight.set(message.id, true);
    try {
        await _doSchedulingVoteChange(message, clientUserId);
    } finally {
        _schedulingInFlight.delete(message.id);
    }
}

async function _doSchedulingVoteChange(message, clientUserId) {
    let state = getSchedule(message.id);

    // If the persisted state was lost (schedules.json deleted by the SMB
    // watcher or never written), reconstruct it from the poll embed +
    // channel metadata so the calendar can still be attached.
    if (!state) {
        const embed = message.embeds[0];
        if (!embed) return;
        // Resolve the channel's campaign role from metadata.
        let roleId = null;
        if (message.channel && message.channel.parentId === ACTIVE_CATEGORY_ID) {
            const metaData = await getLibrarianData(message.channel).catch(() => null);
            if (metaData && metaData.roleId) roleId = metaData.roleId;
        }
        if (!roleId) return;
        state = reconstructScheduleFromEmbed(message, embed, roleId);
        if (!state) return;
        setSchedule(message.id, state);
        console.log(`[Scheduling] Reconstructed state for poll ${message.id} from embed (${state.options.length} options, roleId ${roleId}).`);
    }

    if (!state.roleId) return; // no campaign group → never auto-emit

    let role = message.guild.roles.cache.get(state.roleId);
    if (!role) return;

    // Consensus group = campaign role members (REQUIRED voters) + the
    // channel's DM (OPTIONAL voter). Mirrors the eligible-voter set from
    // isAllowedVoter (polls.js), excluding generic admins (server
    // moderators, not required for campaign participants). The DM's non-vote
    // does NOT block consensus — if every role member voted for a date,
    // it counts as unanimous even when the DM abstained. A DM who does
    // vote is still counted toward the eligible total in the announcement.
    let requiredIds = new Set(
        role.members.filter(m => !m.user.bot).map(m => m.id)
    );
    // If the role member cache is empty, fetch all guild members to
    // populate it (discord.js doesn't always cache all members at startup).
    if (requiredIds.size === 0) {
        try {
            await message.guild.members.fetch();
            role = message.guild.roles.cache.get(state.roleId);
            if (!role) return;
            requiredIds = new Set(
                role.members.filter(m => !m.user.bot).map(m => m.id)
            );
        } catch (e) {
            console.error('[Scheduling] Failed to fetch guild members:', e.message);
        }
    }
    if (requiredIds.size === 0) return;
    const metaData = await getLibrarianData(message.channel).catch(() => null);
    const dmId = (metaData && metaData.dmId) ? metaData.dmId : null;

    // Make sure the full reaction cache + each option's user cache are loaded.
    // discord.js' ReactionManager has no fetch() method in v14.26.x, so
    // re-fetch the whole message to refresh message.reactions.cache in place.
    try {
        await message.fetch();
    } catch (e) {
        console.error('[Scheduling] fetch reactions failed:', e.message);
        return;
    }

    const confirmed = [];
    for (const opt of state.options) {
        const reaction = message.reactions.cache.get(opt.emoji);
        if (!reaction) continue;
        try {
            await reaction.users.fetch();
        } catch (e) {
            console.error('[Scheduling] fetch reaction users failed:', e.message);
            continue;
        }
        const voters = new Set(reaction.users.cache.filter(u => !u.bot).map(u => u.id));
        // Unanimous = every REQUIRED (campaign-role) member voted for this
        // option. The DM is optional: their non-vote doesn't block consensus.
        let allVoted = true;
        for (const id of requiredIds) {
            if (!voters.has(id)) { allVoted = false; break; }
        }
        if (allVoted) confirmed.push(opt);
    }

    if (confirmed.length === 0) {
        // Consensus lost — if we previously had a consensus, remove the
        // calendar attachment and consensus field from the poll message.
        if (state.lastEmittedConfirmed) {
            updateSchedule(message.id, { lastEmittedConfirmed: null, consensusField: null });
            try {
                await message.edit({ attachments: [] }).catch(() => {});
                await refreshPoll(message, clientUserId).catch(() => {});
                console.log(`[Scheduling] Consensus lost for poll ${message.id}; cleared calendar attachment.`);
            } catch (e) {
                console.error('[Scheduling] Failed to clear consensus from poll:', e.message);
            }
        }
        return;
    }

    // Signature of the confirmed set — changes whenever the unanimously-
    // confirmed dates change (grow, shrink, or swap). We emit a fresh .ics
    // only when this signature differs from the last one posted.
    const signature = confirmed
        .map(o => `${o.isoDate}|${o.start || ''}|${o.end || ''}|${o.allDay ? '1' : '0'}`)
        .sort()
        .join('::');
    if (state.lastEmittedConfirmed === signature) return;

    // Optimistically update lastEmittedConfirmed BEFORE the async edit so a
    // concurrent call sees the new signature and skips. Roll back on failure.
    const previousSig = state.lastEmittedConfirmed || null;
    updateSchedule(message.id, { lastEmittedConfirmed: signature });

    // Build the .ics with the unanimous options (chronological).
    confirmed.sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    const channelName = message.channel?.name || 'TTRPG Session';
    const summary = `TTRPG Session — ${channelName}`;
    const description = `Auto-generated by Librarian Bot from poll ${message.id}. Confirmed by all ${requiredIds.size} campaign-role member${requiredIds.size === 1 ? '' : 's'}${dmId ? ' + DM' : ''}.`;
    const ics = buildIcs({
        options: confirmed.map(o => ({
            isoDate: o.isoDate,
            start: o.start,
            end: o.end,
            allDay: o.allDay
        })),
        summary,
        description,
        uidPrefix: message.id
    });

    const buf = Buffer.from(ics, 'utf8');
    const dateStamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const attachmentName = `schedule-${message.id}-${dateStamp}.ics`;

    // Build a consensus field for the embed so the poll message itself
    // shows the confirmed dates. Stored in schedule state so refreshPoll
    // re-includes it when rebuilding the embed on subsequent votes.
    const dmNote = dmId && !confirmed.every(o => {
        const reaction = message.reactions.cache.get(o.emoji);
        if (!reaction) return false;
        const voters = new Set(reaction.users.cache.filter(u => !u.bot).map(u => u.id));
        return voters.has(dmId);
    }) ? ' (DM abstained)' : '';
    const consensusField = {
        name: '📅 Consensus Reached',
        value: `All ${requiredIds.size} campaign-role member${requiredIds.size === 1 ? '' : 's'}${dmId ? ' + DM' : ''} voted for ${confirmed.length === 1 ? 'this date' : 'these dates'}${dmNote}:\n${confirmed.map(o => `• ${o.label}`).join('\n')}\n*Calendar (.ics) attached — import to Google Calendar → Settings → Import & export.*`
    };
    updateSchedule(message.id, { consensusField });

    try {
        // Attach the .ics to the POLL MESSAGE itself (not a new message).
        // attachments: [] clears any previously-attached .ics so the new one
        // replaces it when the consensus changes.
        await message.edit({
            files: [{ attachment: buf, name: attachmentName }],
            attachments: []
        });
        // Rebuild the embed so it includes the consensus field.
        await refreshPoll(message, clientUserId).catch(() => {});
        console.log(`[Scheduling] Attached ${attachmentName} to poll ${message.id} (${confirmed.length} unanimous option(s), signature ${signature}).`);
    } catch (e) {
        // Roll back the optimistic update so the next vote retries.
        updateSchedule(message.id, { lastEmittedConfirmed: previousSig, consensusField: null });
        console.error('[Scheduling] Failed to attach calendar to poll:', e.message);
    }
}

module.exports = {
    createSchedulePoll,
    handleSchedulingVoteChange,
    isScheduleEmbed
};