const { PermissionFlagsBits } = require('discord.js');
const { getLibrarianData } = require('../utils/helpers');
const {
    SERVER_ID,
    ACTIVE_CATEGORY_ID,
    NUMBER_EMOJIS,
    EMBED_COLOR
} = require('../config');

// A message is one of our polls if it was authored by the bot and its
// embed title starts with the poll marker and footer carries the creator
// marker. Regular Discord users cannot send embeds, so the embed presence
// alone is a strong signal — the title/footer markers make it exact.
function parsePollEmbed(message, clientUserId) {
    if (!message || !message.embeds || message.embeds.length === 0) return null;
    if (message.author && clientUserId && message.author.id !== clientUserId) return null;
    const embed = message.embeds[0];
    if (!embed.title || !embed.title.startsWith('📊 ')) return null;
    return embed;
}

// Reconstructs the ordered option list from the embed description. Each
// description block is `${emoji} ${optionText}` optionally followed by a
// voters line. We only read the first line of each block so the option text
// stays stable across refreshes (voters line is on line 2).
function extractOptions(embed) {
    const description = embed.description || '';
    const blocks = description.split('\n\n').filter(Boolean);
    const options = [];
    for (const block of blocks) {
        const firstLine = block.split('\n')[0];
        for (let i = 0; i < NUMBER_EMOJIS.length; i++) {
            const emoji = NUMBER_EMOJIS[i];
            if (firstLine.startsWith(emoji)) {
                const text = firstLine.slice(emoji.length).trim();
                options.push({ index: i, emoji, text });
                break;
            }
        }
    }
    return options;
}

// In a game (active campaign) channel, only the channel's DM and members of
// the channel's campaign role group may vote. Admins are always allowed.
// Outside game channels everyone may vote (returns true).
async function isAllowedVoter(message, user) {
    const channel = message.channel;
    if (channel.parentId !== ACTIVE_CATEGORY_ID) return true;
    const metaData = await getLibrarianData(channel);
    if (!metaData) return true;
    const member = await message.guild.members.fetch(user.id).catch(() => null);
    if (!member) return false;
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    if (metaData.dmId && user.id === metaData.dmId) return true;
    if (metaData.roleId && member.roles.cache.has(metaData.roleId)) return true;
    return false;
}

function buildResultsField(sorted) {
    const totalVotes = sorted.reduce((s, c) => s + c.count, 0);
    if (totalVotes === 0) return null;

    const topCount = sorted[0].count;
    const winners = sorted.filter(c => c.count === topCount);
    const secondEntry = sorted.find(c => c.count < topCount);
    const secondCount = secondEntry ? secondEntry.count : null;
    const second = secondCount != null ? sorted.filter(c => c.count === secondCount) : [];

    const plural = (n) => n !== 1 ? 's' : '';
    let value = '======\n\n';

    if (winners.length === 1) {
        value += `🥇 **Winner:** ${winners[0].emoji} ${winners[0].text} (${winners[0].count} vote${plural(winners[0].count)})`;
    } else {
        const wstr = winners.map(w => `${w.emoji} ${w.text}`).join(' / ');
        value += `🥇 **Tied winners (${winners[0].count} vote${plural(winners[0].count)}):** ${wstr}`;
    }

    if (second.length > 0) {
        if (second.length === 1) {
            value += `\n\n🥈 **Second best:** ${second[0].emoji} ${second[0].text} (${second[0].count} vote${plural(second[0].count)})`;
        } else {
            const sstr = second.map(s => `${s.emoji} ${s.text}`).join(' / ');
            value += `\n\n🥈 **Tied second (${second[0].count} vote${plural(second[0].count)}):** ${sstr}`;
        }
    }

    return { name: 'Results', value };
}

// Recounts every option's reactions, rebuilds the embed description with
// visible voter mentions, and (when there are votes) attaches a results
// field naming the winner and the runner-up.
async function refreshPoll(message, clientUserId) {
    const embed = parsePollEmbed(message, clientUserId);
    if (!embed) return;
    const options = extractOptions(embed);
    if (options.length === 0) return;

    // Make sure the full reaction cache is present before reading counts.
    try {
        await message.reactions.fetch();
    } catch (e) {
        console.error('[Poll] Failed to fetch reactions:', e.message);
    }

    const counts = [];
    for (const opt of options) {
        const reaction = message.reactions.cache.get(opt.emoji);
        let voters = [];
        if (reaction) {
            try {
                await reaction.users.fetch();
            } catch (e) {
                console.error('[Poll] Failed to fetch reaction users:', e.message);
            }
            voters = reaction.users.cache
                .filter(u => !u.bot)
                .map(u => `<@${u.id}>`);
        }
        counts.push({ ...opt, count: voters.length, voters });
    }

    let descriptionText = '';
    for (const c of counts) {
        const votersLine = c.voters.length > 0
            ? `*Voters: ${c.voters.join(', ')}*`
            : '*No votes yet*';
        descriptionText += `${c.emoji} ${c.text}\n${votersLine}\n\n`;
    }

    const sorted = [...counts].sort((a, b) => b.count - a.count);
    const resultsField = buildResultsField(sorted);

    const newEmbed = {
        color: EMBED_COLOR,
        title: embed.title,
        description: descriptionText,
        fields: resultsField ? [resultsField] : []
    };

    try {
        await message.edit({ embeds: [newEmbed] });
    } catch (e) {
        console.error('[Poll] Failed to update poll message:', e.message);
    }
}

async function handlePollReactionAdd(reaction, user, clientUserId) {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message;
    if (message.partial) await message.fetch();
    if (message.guild?.id !== SERVER_ID) return;
    if (!parsePollEmbed(message, clientUserId)) return;

    if (!(await isAllowedVoter(message, user))) {
        try {
            await reaction.users.remove(user.id);
        } catch (e) {
            console.error('[Poll] Failed to remove unauthorized reaction:', e.message);
        }
        return;
    }

    await refreshPoll(message, clientUserId);
}

async function handlePollReactionRemove(reaction, user, clientUserId) {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const message = reaction.message;
    if (message.partial) await message.fetch();
    if (message.guild?.id !== SERVER_ID) return;
    if (!parsePollEmbed(message, clientUserId)) return;

    await refreshPoll(message, clientUserId);
}

module.exports = {
    parsePollEmbed,
    extractOptions,
    refreshPoll,
    handlePollReactionAdd,
    handlePollReactionRemove
};