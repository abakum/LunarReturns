const { script, licenses } = require('./viewer-bundle.cjs');
const { createFlatAnnotationScope, flatTreeText } = require('./flat.cjs');
const { approxOut } = require('./text.cjs');

function viewerAnnotations(gedcom, snapshot, pairs = [], spouses = [], chain = false) {
    const [persons, fams] = snapshot;
    const ids = new Set([...gedcom.matchAll(/^0 @([^\r\n@]+)@ INDI\r?$/gm)].map(m => m[1]));
    const familyIds = new Set([...gedcom.matchAll(/^0 @([^\r\n@]+)@ FAM\r?$/gm)].map(m => m[1]));
    const exported = persons.filter(p => ids.has(p.key));
    const exportedFamilies = fams.filter(f => familyIds.has(f.xref));
    const { keysOf, labelOf } = createFlatAnnotationScope(snapshot, pairs, spouses);
    return Object.fromEntries(exported.map(({ key }) => {
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
            return { ...f, hKey, wKey, children, hName: null, wName: null, note: null,
                marr: f.marr && { ...f.marr, plac: heroFamily ? f.marr.plac : null },
                div: f.div && { ...f.div, plac: heroFamily ? f.div.plac : null } };
        }).filter(Boolean);
        const rows = flatTreeText(picked, families, true, true, key).map(({ prefix, text, person }) => {
            if (!person) return { text: prefix + text };
            if (person.key === key) return { text: prefix + text.replace(/\s*\^/g, '\n').trimEnd(), hero: true };
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
.indi{cursor:pointer}.name-link,.name-link .name{cursor:help}.name-link .name{fill:#175c9c;text-decoration:underline}
</style></head><body><header><div id="person-picker"><input id="person" type="text" role="combobox" aria-label="Центральная персона" aria-autocomplete="list" aria-expanded="false" aria-controls="person-results" placeholder="Найти человека" autocomplete="off" spellcheck="false"><ul id="person-results" role="listbox" aria-label="Персоны" hidden></ul></div><button id="minus" aria-label="Уменьшить">−</button><button id="plus" aria-label="Увеличить">+</button><button id="fit">Вписать</button></header>
<div id="touch-tip" hidden><span>Нажмите на карточку, чтобы перестроить <a href="https://pewu.github.io/topola-viewer/" target="_blank" rel="noopener noreferrer">дерево</a> вокруг человека, или на имя, чтобы увидеть его <a href="https://github.com/abakum/LunarReturns/blob/main/-%2B%3D.md" target="_blank" rel="noopener noreferrer">родственные связи</a>.</span><button type="button" aria-label="Закрыть подсказку">×</button></div>
<p id="status" role="status"></p><noscript>Для просмотра включите JavaScript и откройте файл в браузере.</noscript>
<svg id="tree" xmlns="http://www.w3.org/2000/svg" aria-label="Песочные часы"><g id="chart"></g></svg>
<section id="annotation" aria-label="Роспись персоны" hidden><pre id="annotation-text"></pre></section>
<script id="component-licenses" type="application/json">${JSON.stringify(licenses).replace(/</g, '\\u003c')}</script>
<script id="tree-data" type="application/json">${data}</script><script>${script}</script></body></html>`;
}

module.exports = { viewerHtml, viewerAnnotations };
