// Resolve lazily: parse and flat also use these helpers.
const resolveZone = (place, date) => require('./parse.cjs').zoneDiff(place, date);
const { newStyleDate, oldStyleDate } = require('./religion.cjs');

function shiftEvent(d, minutes) {
    // Date arithmetic uses Gregorian days; persisted historical dates are Julian.
    const dt = new Date(new Date(newStyleDate(d) + 'T00:00:00Z').getTime() + minutes * 60000);
    return { d: oldStyleDate(dt.toISOString().slice(0, 10)), h: dt.getUTCHours(), m: dt.getUTCMinutes() };
}

function eventToMsk(event) {
    if (!event?.date) return {};
    if (!event.time) return { d: event.date };
    const [h, m] = event.time.split(':').map(Number);
    const diff = resolveZone(event.plac, event.date);
    return { ...shiftEvent(event.date, h * 60 + m - diff), srcH: h, srcM: m };
}

function localEvent(d, h, m, srcH, srcM, plac) {
    if (!d) return {};
    // Legacy GED imports stored local dates and source hours only.
    if (h == null) return { d, ...(srcH == null ? {} : { h: srcH, m: srcM ?? 0 }) };
    if (!plac) return { d, h, m: m ?? 0 };
    const minutes = h * 60 + (m ?? 0);
    const candidates = new Map();
    for (let day = -2; day <= 2; day++) {
        const date = shiftEvent(d, minutes + day * 1440).d;
        const candidate = shiftEvent(d, minutes + resolveZone(plac, date));
        const check = eventToMsk({ date: candidate.d, time: candidate.h + ':' + candidate.m, plac });
        if (check.d === d && check.h === h && check.m === (m ?? 0)) candidates.set(JSON.stringify(candidate), candidate);
    }
    let matches = [...candidates.values()];
    if (matches.length > 1 && srcH != null) matches = matches.filter(c => c.h === srcH && c.m === (srcM ?? 0));
    if (matches.length !== 1) throw new Error('Cannot restore unambiguous local event time: ' + d + ' (' + plac + ')');
    return matches[0];
}

function localRecord(r) {
    const birth = localEvent(r.d, r.h, r.m, r.srcH, r.srcM, r.plac);
    const death = localEvent(r.dd, r.dh, r.dm, r.dsrcH, r.dsrcM, r.dp);
    return { ...r, d: birth.d, h: r.plac && r.srcH == null ? undefined : birth.h,
        m: r.plac && r.srcH == null ? undefined : birth.m,
        srcH: r.srcH == null ? undefined : birth.h, srcM: r.srcH == null ? undefined : birth.m,
        dd: death.d, dh: r.dp && r.dsrcH == null ? undefined : death.h,
        dm: r.dp && r.dsrcH == null ? undefined : death.m,
        dsrcH: r.dsrcH == null ? undefined : death.h, dsrcM: r.dsrcH == null ? undefined : death.m };
}

function mskGedcom(g) {
    return { ...g, indis: g.indis.map(ind => {
        const convert = e => {
            if (!e) return e;
            const rec = eventToMsk(e);
            return { ...e, ...rec, date: rec.d };
        };
        return { ...ind, birt: convert(ind.birt), deat: convert(ind.deat) };
    }) };
}

module.exports = { eventToMsk, localEvent, localRecord, mskGedcom };
