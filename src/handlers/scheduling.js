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
            content: `📅 Could not build the scheduling poll:\n> ${e.message}\n\n**Usage:** \`days [time] [days [time] ...] weeks\`\nExamples: \`Wednesday Friday 4\` · \`Wed Fri 18:00-22:00 6\` · \`Wed 14:00-16:00 Fri 18:00-22:00 4\``,
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
        createdAt: Date.now()
    });

    // Seed the live voter display ("No votes yet" per option).
    await refreshPoll(pollMessage, interaction.client.user.id).catch(console.error);

    return interaction.followUp({
        content: `📅 Scheduling poll posted with ${options.length} date${options.length === 1 ? '' : 's'}${roleId ? '. When every eligible voter (campaign role + DM) has voted for the same date(s), a Google-importable calendar (.ics) is posted automatically — and re-posted whenever the confirmed set of dates changes.' : '.'}`,
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

    const state = getSchedule(message.id);
    if (!state) return;
    if (!state.roleId) return; // no campaign group → never auto-emit

    const role = message.guild.roles.cache.get(state.roleId);
    if (!role) return;

    // Consensus group = campaign role members + the channel's DM. Mirrors
    // the eligible-voter set from isAllowedVoter (polls.js), excluding
    // generic admins (server moderators, not required for campaign consensus).
    const memberIds = new Set(
        role.members.filter(m => !m.user.bot).map(m => m.id)
    );
    const metaData = await getLibrarianData(message.channel).catch(() => null);
    if (metaData && metaData.dmId) memberIds.add(metaData.dmId);
    if (memberIds.size === 0) return;

    // Make sure the full reaction cache + each option's user cache are loaded.
    try {
        await message.reactions.fetch();
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
        // Unanimous = every consensus-group member voted for this option.
        let allVoted = true;
        for (const id of memberIds) {
            if (!voters.has(id)) { allVoted = false; break; }
        }
        if (allVoted) confirmed.push(opt);
    }

    if (confirmed.length === 0) return;

    // Signature of the confirmed set — changes whenever the unanimously-
    // confirmed dates change (grow, shrink, or swap). We emit a fresh .ics
    // only when this signature differs from the last one posted.
    const signature = confirmed
        .map(o => `${o.isoDate}|${o.start || ''}|${o.end || ''}|${o.allDay ? '1' : '0'}`)
        .sort()
        .join('::');
    if (state.lastEmittedConfirmed === signature) return;

    // Build the .ics with the unanimous options (chronological).
    confirmed.sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    const channelName = message.channel?.name || 'TTRPG Session';
    const summary = `TTRPG Session — ${channelName}`;
    const description = `Auto-generated by Librarian Bot from poll ${message.id}. Confirmed by all ${memberIds.size} eligible voter${memberIds.size === 1 ? '' : 's'} (campaign role + DM).`;
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

    try {
        await message.channel.send({
            content: `📅 **Consensus reached!** All ${memberIds.size} eligible voter${memberIds.size === 1 ? '' : 's'} (campaign role + DM) voted for ${confirmed.length === 1 ? 'this date' : 'these dates'}:\n${confirmed.map(o => `• ${o.label}`).join('\n')}\nHere is a Google-importable calendar (.ics) — open Google Calendar → Settings → Import & export → select this file.`,
            files: [{ attachment: buf, name: attachmentName }]
        });
        updateSchedule(message.id, { lastEmittedConfirmed: signature });
        console.log(`[Scheduling] Emitted ${attachmentName} for poll ${message.id} (${confirmed.length} unanimous option(s), signature ${signature}).`);
    } catch (e) {
        console.error('[Scheduling] Failed to post calendar file:', e.message);
    }
}

module.exports = {
    createSchedulePoll,
    handleSchedulingVoteChange,
    isScheduleEmbed
};