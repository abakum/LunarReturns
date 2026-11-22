const { createFlatAnnotationScope, flatTreeText } = require('./flat.cjs');
const { approxOut } = require('./text.cjs');
const { eventMapLink, parseEventNote } = require('./parse.cjs');
const { rangeLevel } = require('./chart.cjs');

function annotationRow(text, note, events, birthDate, fieldStart = 0) {
    const tail = (note || '').split('^').map(part => ({ part, event: parseEventNote(part) }));
    const links = [], shown = new Map();
    // Core event places are formatted in order at the end of the header, not in the name.
    let before = text.length;
    for (const { tag, place, date, abt } of [...events].reverse()) {
        if (!place) continue;
        const label = '(' + place + ')';
        const start = text.lastIndexOf(label, before - label.length);
        if (start < fieldStart) continue;
        before = start;
        const displayedDate = date && approxOut(date, abt);
        const sameDate = event => !event.date || (!event.date.period && approxOut(event.date.iso, event.date.abt) === displayedDate);
        const exact = tail.find(({ event }) => event?.tag === tag && event.map && event.place === place && sameDate(event));
        const link = eventMapLink(place, date ?? birthDate, exact?.event.map);
        shown.set(tag, { place, sameDate, href: link?.href });
        if (link) links.unshift({ start, end: start + label.length, href: link.href });
    }
    const deathDate = events.find(event => event.tag === 'DEAT')?.date;
    for (const { part, event } of tail) {
        if (!part) {
            if (note) text += '\n';
            continue;
        }
        let visible = event?.map ? part.slice(0, event.noteStart + event.note.length).trimEnd() : part;
        const fallbackDate = event?.tag === 'BURI' ? deathDate ?? birthDate : birthDate;
        const link = eventMapLink(event?.place, event?.date?.iso ?? fallbackDate, event?.map);
        const main = shown.get(event?.tag === 'BURI' ? 'DEAT' : event?.tag);
        if (main && event.place === main.place && !event.note && main.sameDate(event) && link?.href === main.href) continue;
        let start = event?.placeStart - 1;
        if (link && !event.place) {
            // Empty parentheses in the stored grammar delimit a note, not a place.
            start = event.placeStart > 0 ? start : Math.min(event.noteStart, visible.length + 1);
            visible = event.placeStart > 0 ? visible.slice(0, start) + link.label + visible.slice(start + 2)
                : start >= visible.length ? visible + ' ' + link.label : visible.slice(0, start) + link.label + ' ' + visible.slice(start);
        }
        if (link) links.push({ start: text.length + 1 + start, end: text.length + 1 + start + link.label.length, href: link.href });
        text += '\n' + visible;
    }
    return links.length ? { text: text.trimEnd(), links } : { text: text.trimEnd() };
}

function createAnnotationRows(snapshot, pairs, spouses, chain) {
    const [persons, fams] = snapshot;
    const byKey = new Map(persons.map(p => [p.key, p]));
    const { keysOf, labelOf } = createFlatAnnotationScope(snapshot, pairs, spouses);
    return key => {
        if (!byKey.has(key)) return [];
        const birthDate = byKey.get(key).d;
        const keys = keysOf(key);
        const picked = persons.filter(p => keys.has(p.key));
        const partners = new Set();
        for (const f of fams) {
            if (f.hKey === key) partners.add(f.wKey);
            if (f.wKey === key) partners.add(f.hKey);
        }
        const families = fams.map(f => {
            const hKey = keys.has(f.hKey) ? f.hKey : null;
            const wKey = keys.has(f.wKey) ? f.wKey : null;
            const children = f.children.filter(k => keys.has(k));
            if (!hKey && !wKey && !children.length) return null;
            const heroFamily = hKey === key || wKey === key;
            // A partner's other family adds nothing when only that partner is in R1.
            if (!heroFamily && !children.length && Boolean(hKey) !== Boolean(wKey) && partners.has(hKey || wKey)) return null;
            const eventNote = heroFamily && f.note?.split('^').filter(part => {
                const tag = parseEventNote(part)?.tag;
                return tag === 'MARR' || tag === 'DIV';
            }).join('^');
            return { ...f, hKey, wKey, children, hName: null, wName: null, note: null, eventNote,
                marr: f.marr && { ...f.marr, plac: heroFamily ? f.marr.plac : null },
                div: f.div && { ...f.div, plac: heroFamily ? f.div.plac : null } };
        }).filter(Boolean);
        return flatTreeText(picked, families, true, true, key).map(({ prefix, text, person, family, nameLength }) => {
            if (!person) return annotationRow(prefix + text, family?.eventNote, [
                { tag: 'MARR', place: family?.marr?.plac, date: family?.marr?.d, abt: family?.marr?.abt },
                { tag: 'DIV', place: family?.div?.plac, date: family?.div?.d, abt: family?.div?.abt },
            ], birthDate);
            if (person.key === key) {
                const header = person.note && text.endsWith(' ^' + person.note) ? text.slice(0, -person.note.length - 2) : text;
                return { ...annotationRow(prefix + header, header !== text ? person.note : '', [
                    { tag: 'BIRT', place: person.plac, date: person.d, abt: person.abt },
                    { tag: 'DEAT', place: person.dp, date: person.dd, abt: person.dabt },
                ], birthDate, prefix.length + nameLength), hero: true };
            }
            return { prefix, text: person.name + (person.d != null ? ' ' + approxOut(person.d, person.abt) : ''),
                xref: person.key, kinship: labelOf(key, person.key, chain) };
        });
    };
}

function createPdfAnnotationText(snapshot, pairs, spouses, chain) {
    const rowsOf = createAnnotationRows(snapshot, pairs, spouses, chain);
    return ({ xref }) => rowsOf(xref).map(({ prefix = '', text, kinship, links = [] }) => {
        // Work backwards so the offsets still refer to the original text.
        for (const { end, href } of [...links].reverse()) {
            if (href.startsWith('https://ya.ru/maps/?pt='))
                text = text.slice(0, end) + ' ' + href + text.slice(end);
        }
        return prefix + text + (kinship ? ' · ' + kinship : '');
    }).join('\n');
}

function pdfPersonMetadata([persons, fams], heroKey, xref, radius) {
    if (!heroKey) return {};
    const parents = new Set(xref ? fams.filter(f => f.children.includes(xref)).flatMap(f => [f.hKey, f.wKey]) : []);
    parents.delete(xref);
    const names = new Map(persons.map(p => [p.key, p.name]));
    const date = heroKey.match(/ (\d{4})-(\d{2})-(\d{2})$/);
    return { title: date ? heroKey.slice(0, date.index) : heroKey, creationDate: date?.slice(1).join(''),
        author: [...parents].map(key => names.get(key)).filter(Boolean).join('; '),
        subject: radius != null ? `Радиус родства ${radius}: ${rangeLevel(radius)}.` : '' };
}

module.exports = { createAnnotationRows, createPdfAnnotationText, pdfPersonMetadata };
