const fs = require('fs');
const path = require('path');
const {
    TIMEZONE,
    SCHEDULE_MAX_WEEKS,
    SCHEDULE_MAX_OPTIONS,
    SCHEDULE_DEFAULT_SESSION_HOURS,
    SCHEDULE_STATE_PATH
} = require('../config');

// --- WEEKDAY PARSING ---
// Map every common weekday spelling (full + abbreviations) to the JS
// Date.getDay() index (0 = Sunday .. 6 = Saturday). Keys are lower-cased.
const WEEKDAY_MAP = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6
};

const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Matches a time interval: "18:00", "18:00-22:00", "6:30-21:15".
const TIME_RE = /^(\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?$/;

// --- INPUT PARSING ---
// Spec grammar (whitespace-separated, the leading "scheduling" word is the
// slash command name and is NOT part of `input`):
//   <day> [<day> ...] [<time>] <weeks>
//   - <weeks>  : final token, integer 1..SCHEDULE_MAX_WEEKS
//   - <time>   : optional "HH:MM" or "HH:MM-HH:MM" (one token, no spaces)
//   - <day>    : weekday name (full or abbreviation, case-insensitive)
//
// Returns { days:[weekdayIdx,...], start:'HH:MM', end:'HH:MM', allDay:bool,
// weeks:n } or throws Error with a usage message.
function parseSchedulingInput(raw) {
    const input = (raw || '').trim();
    if (!input) throw new Error('Empty scheduling spec. Usage: `days [time] weeks`, e.g. `Wednesday Friday 4` or `Wed Fri 18:00-22:00 4`.');

    const tokens = input.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) {
        throw new Error('Not enough tokens. Need at least one weekday and the number of weeks. e.g. `Wednesday 4` or `Wed Fri 18:00-22:00 4`.');
    }

    // Last token = weeks.
    const weeks = parseInt(tokens[tokens.length - 1], 10);
    if (isNaN(weeks) || String(weeks) !== tokens[tokens.length - 1]) {
        throw new Error(`The last token must be the number of weeks (1..${SCHEDULE_MAX_WEEKS}). Got: \`${tokens[tokens.length - 1]}\`.`);
    }
    if (weeks < 1 || weeks > SCHEDULE_MAX_WEEKS) {
        throw new Error(`Number of weeks must be between 1 and ${SCHEDULE_MAX_WEEKS} (got ${weeks}).`);
    }

    const middle = tokens.slice(0, -1);
    const days = [];
    let time = null;

    for (const tok of middle) {
        const lower = tok.toLowerCase();
        if (TIME_RE.test(tok)) {
            if (time) throw new Error('Only one time token is allowed.');
            time = tok;
            continue;
        }
        if (Object.prototype.hasOwnProperty.call(WEEKDAY_MAP, lower)) {
            const idx = WEEKDAY_MAP[lower];
            if (!days.includes(idx)) days.push(idx);
            continue;
        }
        throw new Error(`Unrecognized token \`${tok}\`. Expected a weekday (e.g. Mon, Wednesday) or a time (HH:MM or HH:MM-HH:MM).`);
    }

    if (days.length === 0) {
        throw new Error('No weekdays given. Pick at least one weekday, e.g. `Wednesday Friday 4`.');
    }

    let start = null, end = null, allDay = true;
    if (time) {
        const m = time.match(TIME_RE);
        const sh = m[1].padStart(2, '0');
        const sm = m[2];
        start = `${sh}:${sm}`;
        let eh = m[3], em = m[4];
        if (eh === undefined) {
            // Single start time → default session length.
            const [h, min] = applyDuration(sh, sm, SCHEDULE_DEFAULT_SESSION_HOURS);
            eh = h; em = min;
        }
        end = `${eh.padStart(2, '0')}:${em}`;
        allDay = false;
    }

    return { days, start, end, allDay, weeks };
}

// Adds `hours` to a "HH:MM" pair and returns [HH, MM] zero-padded strings.
function applyDuration(hh, mm, hours) {
    let total = parseInt(hh, 10) * 60 + parseInt(mm, 10) + hours * 60;
    total = ((total % 1440) + 1440) % 1440;
    const h = Math.floor(total / 60);
    const m = total % 60;
    return [String(h).padStart(2, '0'), String(m).padStart(2, '0')];
}

// --- TIMEZONE-AWARE "TODAY" ---
// Returns the current { year, month(1-12), day, weekday(getDay index) } in
// the configured TIMEZONE. Uses Intl.DateTimeFormat with the `en-CA` locale
// (which formats dates as zero-padded YYYY-MM-DD) to read the wall-clock
// calendar fields, then derives the weekday index from those fields via
// Date.UTC — fully locale-independent (no reliance on weekday-name
// formatting which can vary by ICU build).
function getZonedToday(timezone = TIMEZONE) {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric', month: '2-digit', day: '2-digit'
    });
    const parts = {};
    for (const p of fmt.formatToParts(new Date())) parts[p.type] = p.value;
    const year = parseInt(parts.year, 10);
    const month = parseInt(parts.month, 10);
    const day = parseInt(parts.day, 10);
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return { year, month, day, weekday };
}

// --- DATE GENERATION ---
// For each selected weekday, produces the next `weeks` occurrences starting
// from today (inclusive if today matches). Each occurrence is returned with:
//   { date: {year,month,day}, weekday, isoDate:'YYYYMMDD',
//     start:'HH:MM'|null, end:'HH:MM'|null, allDay:bool,
//     label:'Wed 2 Jul 18:00-22:00' }
// Throws if the total option count would exceed SCHEDULE_MAX_OPTIONS.
function generateScheduleOptions(spec) {
    const today = getZonedToday();
    const options = [];
    for (const target of spec.days) {
        // Days until the first occurrence of this weekday (0 = today).
        let delta = (target - today.weekday + 7) % 7;
        for (let w = 0; w < spec.weeks; w++) {
            const occ = addDays(today, delta + w * 7);
            const isoDate = ymd(occ.year, occ.month, occ.day);
            const weekdayLabel = WEEKDAY_LABEL[occ.weekday];
            const dateLabel = `${weekdayLabel} ${occ.day} ${monthShort(occ.month)}`;
            const timeLabel = spec.allDay ? '' : ` ${spec.start}-${spec.end}`;
            options.push({
                weekday: occ.weekday,
                date: { year: occ.year, month: occ.month, day: occ.day },
                isoDate,
                start: spec.start,
                end: spec.end,
                allDay: spec.allDay,
                label: `${dateLabel}${timeLabel}`
            });
        }
    }
    // Stable ordering: chronological by ISO date so the poll reads as a
    // calendar instead of grouped-by-weekday. Equal dates (impossible for
    // distinct weekdays) keep their insertion order.
    options.sort((a, b) => a.isoDate.localeCompare(b.isoDate));
    if (options.length > SCHEDULE_MAX_OPTIONS) {
        throw new Error(`That produces ${options.length} dates, but the maximum is ${SCHEDULE_MAX_OPTIONS} (Discord's reaction limit). Lower the number of weeks or weekdays.`);
    }
    return options;
}

// Adds `n` days to a {year,month,day} calendar tuple (1-based month) and
// returns the same shape plus a `weekday` getDay index. Uses UTC noon to
// avoid DST edges; only the calendar fields matter, not the wall-clock time.
function addDays(base, n) {
    const d = new Date(Date.UTC(base.year, base.month - 1, base.day) + n * 86400000);
    return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        weekday: d.getUTCDay()
    };
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthShort(m) { return MONTH_SHORT[m - 1]; }

function ymd(y, m, d) {
    return `${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
}

function hmToICS(hm) {
    if (!hm) return null;
    const [h, m] = hm.split(':');
    return `${h.padStart(2, '0')}${m.padStart(2, '0')}00`;
}

// Parses a YYYYMMDD string and returns { year, month(1-12), day }.
function parseIsoDate(iso) {
    return {
        year: parseInt(iso.slice(0, 4), 10),
        month: parseInt(iso.slice(4, 6), 10),
        day: parseInt(iso.slice(6, 8), 10)
    };
}

// --- .ICS GENERATION ---
// Builds an RFC 5545 calendar string with one VEVENT per confirmed option.
// Times are emitted as FLOATING local wall-clock values (no TZID, no Z) so a
// single-timezone group (the bot's TIMEZONE) sees the right clock time on
// import; all-day sessions use VALUE=DATE. Google Calendar imports both.
function buildIcs({ options, summary, description, uidPrefix }) {
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const lines = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//ttrpg-librarian-bot//Scheduling//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH'
    ];
    let idx = 0;
    for (const opt of options) {
        idx++;
        const uid = `${uidPrefix}-${idx}@librarian-bot`;
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:${uid}`);
        lines.push(`DTSTAMP:${now}`);
        lines.push(`SUMMARY:${escapeIcs(summary || 'TTRPG Session')}`);
        if (description) lines.push(`DESCRIPTION:${escapeIcs(description)}`);
        if (opt.allDay) {
            const baseDate = parseIsoDate(opt.isoDate);
            const dEnd = addDays(baseDate, 1);
            lines.push(`DTSTART;VALUE=DATE:${opt.isoDate}`);
            lines.push(`DTEND;VALUE=DATE:${ymd(dEnd.year, dEnd.month, dEnd.day)}`);
        } else {
            const ds = `${opt.isoDate}T${hmToICS(opt.start)}`;
            const de = `${opt.isoDate}T${hmToICS(opt.end)}`;
            lines.push(`DTSTART:${ds}`);
            lines.push(`DTEND:${de}`);
        }
        lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
}

function escapeIcs(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// --- PERSISTED STATE ---
// data/schedules.json : { "<messageId>": {
//   channelId, guildId, creatorId, roleId (nullable),
//   options: [{ emoji, isoDate, start, end, allDay, label }],
//   icsSent: bool, createdAt: ms
// } }
// Atomic temp-file + rename, with an in-process write Promise chain so
// concurrent writes (rapid reaction bursts) never clobber each other.

let _store = null;
let _writeChain = Promise.resolve();

function _load() {
    if (_store !== null) return _store;
    try {
        if (fs.existsSync(SCHEDULE_STATE_PATH)) {
            _store = JSON.parse(fs.readFileSync(SCHEDULE_STATE_PATH, 'utf8'));
        } else {
            _store = {};
        }
    } catch (e) {
        console.warn('[Scheduling] Failed to read schedules.json, starting fresh:', e.message);
        _store = {};
    }
    if (!_store || typeof _store !== 'object' || Array.isArray(_store)) _store = {};
    return _store;
}

function getSchedule(messageId) {
    return _load()[messageId] || null;
}

function setSchedule(messageId, data) {
    const store = _load();
    store[messageId] = data;
    _persist();
}

function updateSchedule(messageId, patch) {
    const store = _load();
    if (!store[messageId]) return null;
    store[messageId] = { ...store[messageId], ...patch };
    _persist();
    return store[messageId];
}

function deleteSchedule(messageId) {
    const store = _load();
    if (store[messageId]) {
        delete store[messageId];
        _persist();
    }
}

function _persist() {
    const payload = JSON.stringify(_store, null, 2);
    _writeChain = _writeChain.then(() => {
        return new Promise((resolve) => {
            const dir = path.dirname(SCHEDULE_STATE_PATH);
            const tmp = `${SCHEDULE_STATE_PATH}.tmp`;
            try {
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(tmp, payload);
                fs.renameSync(tmp, SCHEDULE_STATE_PATH);
            } catch (e) {
                console.error('[Scheduling] Failed to persist schedules.json:', e.message);
            }
            resolve();
        });
    });
}

module.exports = {
    parseSchedulingInput,
    generateScheduleOptions,
    buildIcs,
    getSchedule,
    setSchedule,
    updateSchedule,
    deleteSchedule,
    WEEKDAY_MAP
};