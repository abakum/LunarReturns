const { script, licenses } = require('./viewer-bundle.cjs');
const { createFlatAnnotationScope, flatTreeText } = require('./flat.cjs');
const { approxOut } = require('./text.cjs');
const { eventMapLink, parseEventNote } = require('./parse.cjs');

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

function viewerAnnotations(gedcom, snapshot, pairs = [], spouses = [], chain = false) {
    const [persons, fams] = snapshot;
    const ids = new Set([...gedcom.matchAll(/^0 @([^\r\n@]+)@ INDI\r?$/gm)].map(m => m[1]));
    const familyIds = new Set([...gedcom.matchAll(/^0 @([^\r\n@]+)@ FAM\r?$/gm)].map(m => m[1]));
    const exported = persons.filter(p => ids.has(p.key));
    const exportedFamilies = fams.filter(f => familyIds.has(f.xref));
    const { keysOf, labelOf } = createFlatAnnotationScope(snapshot, pairs, spouses);
    return Object.fromEntries(exported.map(({ key, d: birthDate }) => {
        const keys = keysOf(key);
        const picked = exported.filter(p => keys.has(p.key));
        const pickedIds = new Set(picked.map(p => p.key));
        const partners = new Set();
        for (const f of exportedFamilies) {
            if (f.hKey === key) partners.add(f.wKey);
            if (f.wKey === key) partners.add(f.hKey);
        }
        const families = exportedFamilies.map(f => {
            const hKey = pickedIds.has(f.hKey) ? f.hKey : null;
            const wKey = pickedIds.has(f.wKey) ? f.wKey : null;
            const children = f.children.filter(k => pickedIds.has(k));
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
        const rows = flatTreeText(picked, families, true, true, key).map(({ prefix, text, person, family, nameLength }) => {
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
        return [key, rows];
    }));
}

function viewerHtml(gedcom, title, heroXref = null, annotations = {}) {
    const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const data = JSON.stringify({ gedcom, heroXref, annotations }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escape(title)}</title><style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;color:#182430;background:#faf9f6;display:flex;flex-direction:column;height:100vh;height:100dvh}header{padding:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}button,input{font:inherit;padding:8px}#status{padding:0 12px 8px;margin:0;color:#900}#status:empty{display:none}#tree{display:block;width:100%;flex:1;min-height:0;background:white;touch-action:none;border-block:1px solid #ddd}noscript{color:#900}
#person-picker{position:relative;flex:1;min-width:0}#person{width:100%;min-width:0}#person-results{position:absolute;z-index:3;top:100%;left:0;width:max-content;min-width:100%;max-width:min(32rem,calc(100vw - 24px));max-height:min(50vh,20rem);overflow:auto;margin:4px 0 0;padding:4px;list-style:none;background:white;border:1px solid #b7aea0;border-radius:8px;box-shadow:0 8px 30px #0003}#person-results li{padding:8px;overflow-wrap:anywhere}#person-results [role=option]{cursor:pointer}#person-results [role=option]:hover,#person-results [aria-selected=true]{background:#e8f2fb}
#touch-tip:not([hidden]){display:flex;margin:0 12px 8px;padding:6px 8px;gap:8px;align-items:center;background:#fffbdc;border:1px solid #b7aea0;border-radius:8px}#touch-tip button{margin-left:auto;padding:4px 8px}
@media (hover:none) and (pointer:coarse){#person{font-size:16px}}
#annotation{position:fixed;z-index:2;width:min(560px,calc(100vw - 24px));max-height:min(65vh,600px);overflow:auto;background:#fffdf7;border:1px solid #b7aea0;border-radius:8px;box-shadow:0 8px 30px #0003;padding:12px}#annotation[hidden]{display:none}#annotation pre{font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;user-select:text}
#annotation{background:#fffbdc}
 .indi{cursor:pointer}.name-button,.name-button .name{cursor:help}.name-button .name{fill:#175c9c;text-decoration:underline}
 #annotation .relative-button{border:0;background:none;padding:0;font:inherit;color:#175c9c;text-align:start;text-decoration:underline;cursor:pointer;max-width:100%;white-space:inherit;overflow-wrap:anywhere}.name-button:focus-visible,.relative-button:focus-visible{outline:2px solid #175c9c;outline-offset:2px}
</style></head><body><header><div id="person-picker"><input id="person" type="text" role="combobox" aria-label="Центральная персона" aria-autocomplete="list" aria-expanded="false" aria-controls="person-results" placeholder="Найти человека" autocomplete="off" spellcheck="false"><ul id="person-results" role="listbox" aria-label="Персоны" hidden></ul></div><button id="minus" aria-label="Уменьшить">−</button><button id="plus" aria-label="Увеличить">+</button><button id="fit">Вписать</button></header>
<div id="touch-tip" hidden><span>Нажмите на карточку, чтобы перестроить <a href="https://pewu.github.io/topola-viewer/" target="_blank" rel="noopener noreferrer">дерево</a> вокруг человека, или на имя, чтобы увидеть его <a href="https://github.com/abakum/LunarReturns/blob/main/-%2B%3D.md" target="_blank" rel="noopener noreferrer">родственные связи</a>.</span><button type="button" aria-label="Закрыть подсказку">×</button></div>
<p id="status" role="status"></p><noscript>Для просмотра включите JavaScript и откройте файл в браузере.</noscript>
<svg id="tree" xmlns="http://www.w3.org/2000/svg" aria-label="Песочные часы"><g id="chart"></g></svg>
<section id="annotation" aria-label="Роспись персоны" hidden><pre id="annotation-text"></pre></section>
<script id="component-licenses" type="application/json">${JSON.stringify(licenses).replace(/</g, '\\u003c')}</script>
<script id="tree-data" type="application/json">${data}</script><script>${script}</script></body></html>`;
}

module.exports = { viewerHtml, viewerAnnotations };
