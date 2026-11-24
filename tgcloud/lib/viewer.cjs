const { script, licenses } = require('./viewer-bundle.cjs');
const { createAnnotationRows } = require('./annotations.cjs');
const { parseGedcom } = require('./parse.cjs');
const { approxOut } = require('./text.cjs');

function viewerAnnotations(gedcom, snapshot, pairs = [], spouses = [], chain = false, model = null, progress) {
    const ids = new Set([...gedcom.matchAll(/^0 @([^\r\n@]+)@ INDI\r?$/gm)].map(m => m[1]));
    const destinations = new Set(ids);
    for (const { r, bar } of model?.annotationRegions ?? []) {
        if (!r.xref) continue;
        ids.add(r.xref);
        if (bar) destinations.add(r.xref);
    }
    const rowsOf = createAnnotationRows(snapshot, pairs, spouses, chain);
    const people = snapshot[0].filter(p => ids.has(p.key));
    return Object.fromEntries(people.map(({ key }, i) => {
        const rows = rowsOf(key).map(({ xref, ...row }) => destinations.has(xref) ? { ...row, xref } : row);
        if ((i + 1) % 16 === 0 || i + 1 === people.length) progress?.(i + 1, people.length);
        return [key, rows];
    }));
}

function viewerHtml(gedcom, title, heroXref = null, annotations = {}, { svg, notice } = {}) {
    const escape = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const births = Object.fromEntries((parseGedcom(gedcom)?.indis ?? [])
        .filter(p => p.birt?.date).map(p => [p.__xref, approxOut(p.birt.date, p.birt.abt)]));
    const data = JSON.stringify({ gedcom, heroXref, annotations, births }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const scrollbar = (id, orientation, controls, label) => `<div id="${id}" class="viewer-scroll" role="scrollbar" aria-label="${label}" aria-orientation="${orientation}" aria-controls="${controls}" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" tabindex="0" hidden="hidden"><div class="scroll-thumb"></div></div>`;
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escape(title)}</title><style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui,sans-serif;color:#182430;background:#faf9f6;display:flex;flex-direction:column;height:100vh;height:100dvh}header{padding:12px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}button,input{font:inherit;padding:8px}#status{padding:0 12px 8px;margin:0;color:#900}#status:empty{display:none}#tree{display:block;width:100%;flex:1;min-height:0;background:white;touch-action:none;border-block:1px solid #ddd}noscript{color:#900}
  #fit{font-size:20px;line-height:1rem}
  #life-mode:not([hidden]){display:flex;flex:1;min-height:0}#life-view{min-width:0}
  #tree-scroll-slot{height:16px}#life-scroll-slot:not([hidden]){display:flex;width:16px}
  .viewer-scroll:not([hidden]){position:relative;width:100%;height:100%;background:#e8e4db;touch-action:none;user-select:none}
  .scroll-thumb{position:absolute;background:#64758a;border:2px solid #e8e4db;border-radius:10px;cursor:grab;touch-action:none}
  .viewer-scroll:focus-visible{outline:2px solid #175c9c;outline-offset:-2px}
  #tree-scroll .scroll-thumb{height:100%}#life-scroll .scroll-thumb{width:100%}
  @media (pointer:coarse){#tree-scroll-slot{height:28px}#life-scroll-slot:not([hidden]){width:28px}}
 [hidden],#tree[hidden]{display:none}#life-view{flex:1;min-height:0;overflow:auto;background:white}#life-view.interactive{overflow:hidden;overflow:clip;touch-action:none;user-select:none}#life-chart{display:block;max-width:none;font-family:sans-serif;transform-origin:0 0}#life-targets[visibility="visible"] rect{cursor:pointer}#life-targets rect:focus-visible{stroke:#175c9c;stroke-width:2}#chart-notice{margin:0;padding:0 12px 8px}
#person-picker{position:relative;flex:1;min-width:0}#person{width:100%;min-width:0}#person-results{position:absolute;z-index:3;top:100%;left:0;width:max-content;min-width:100%;max-width:min(32rem,calc(100vw - 24px));max-height:min(50vh,20rem);overflow:auto;margin:4px 0 0;padding:4px;list-style:none;background:white;border:1px solid #b7aea0;border-radius:8px;box-shadow:0 8px 30px #0003}#person-results li{padding:8px;overflow-wrap:anywhere}#person-results [role=option]{cursor:pointer}#person-results [role=option]:hover,#person-results [aria-selected=true]{background:#e8f2fb}
 #touch-tip:not([hidden]){display:flex;margin:0 12px 8px;padding:6px 8px;gap:8px;align-items:center;background:#fffbdc;border:1px solid #b7aea0;border-radius:8px}#touch-tip button{margin-left:auto;padding:4px 8px}
 @media (hover:none) and (pointer:coarse){#person{font-size:16px}}
 #annotation{position:fixed;z-index:2;width:min(560px,calc(100vw - 24px));max-height:min(65vh,600px);overflow:auto;background:#fffdf7;border:1px solid #b7aea0;border-radius:8px;box-shadow:0 8px 30px #0003;padding:12px}#annotation[hidden]{display:none}#annotation pre{font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;user-select:text}
 #annotation{background:#fffbdc}
 #life-targets[visibility="visible"] rect:not([data-bar]):not([data-row]){cursor:help}
  .indi{cursor:pointer}.name-button,.name-button .name{cursor:help}.name-button .name{fill:#175c9c;text-decoration:underline}
  #annotation .relative-button{border:0;background:none;padding:0;font:inherit;color:#175c9c;text-align:start;text-decoration:underline;cursor:pointer;max-width:100%;white-space:inherit;overflow-wrap:anywhere}.name-button:focus-visible,.relative-button:focus-visible{outline:2px solid #175c9c;outline-offset:2px}
 </style></head><body><header hidden="hidden"><div id="person-picker"><input id="person" type="text" role="combobox" aria-label="Центральная персона" aria-autocomplete="list" aria-expanded="false" aria-controls="person-results" placeholder="Найти человека" autocomplete="off" spellcheck="false"><ul id="person-results" role="listbox" aria-label="Персоны" hidden="hidden"></ul></div><button id="minus" aria-label="Уменьшить" title="Уменьшить">➖</button><button id="plus" aria-label="Увеличить" title="Увеличить">➕</button><button id="fit" aria-label="Вместить" title="Вместить">⤢</button>${svg ? '<button id="switch-view" aria-label="График" title="График">📊</button>' : ''}</header>
   <div id="tree-scroll-slot" hidden="hidden">${scrollbar('tree-scroll', 'horizontal', 'tree', 'Прокрутка дерева')}</div>
   <div id="touch-tip" hidden="hidden"><span>Нажмите на карточку, чтобы перестроить <a href="https://pewu.github.io/topola-viewer/" target="_blank" rel="noopener noreferrer">дерево</a> вокруг человека, или на имя, чтобы увидеть его <a href="https://github.com/abakum/LunarReturns/blob/main/-%2B%3D.md" target="_blank" rel="noopener noreferrer">родственные связи</a>.</span><button type="button" aria-label="Закрыть подсказку">×</button></div>
 <p id="status" role="status"></p><noscript>Для просмотра включите JavaScript и откройте файл в браузере.</noscript>
 ${notice ? `<p id="chart-notice">${escape(notice)}</p>` : ''}
 <svg id="tree" xmlns="http://www.w3.org/2000/svg" aria-label="Песочные часы" hidden="hidden"><g id="chart"></g></svg>
  ${svg ? `<div id="life-mode"><div id="life-view">${svg}</div><div id="life-scroll-slot" hidden="hidden">${scrollbar('life-scroll', 'vertical', 'life-view', 'Прокрутка графика')}</div></div>` : ''}
 <section id="annotation" aria-label="Роспись персоны" hidden="hidden"><pre id="annotation-text"></pre></section>
 <script id="component-licenses" type="application/json">${JSON.stringify(licenses).replace(/</g, '\\u003c')}</script>
 <script id="tree-data" type="application/json">${data}</script><script>${script}</script></body></html>`;
}

module.exports = { viewerHtml, viewerAnnotations };
