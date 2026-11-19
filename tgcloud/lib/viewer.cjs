const { script, licenses } = require('./viewer-bundle.cjs');
const { createFlatAnnotationText } = require('./flat.cjs');
const { approxOut } = require('./text.cjs');

function viewerAnnotations(gedcom, [persons, fams], pairs, spouses) {
    const ids = new Set([...gedcom.matchAll(/^0 @([^\r\n@]+)@ INDI\r?$/gm)].map(m => m[1]));
    const familyIds = new Set([...gedcom.matchAll(/^0 @([^\r\n@]+)@ FAM\r?$/gm)].map(m => m[1]));
    const snapshot = [persons.filter(p => ids.has(p.key)), fams.filter(f => familyIds.has(f.xref)).map(f => ({ ...f,
        hKey: ids.has(f.hKey) ? f.hKey : null, wKey: ids.has(f.wKey) ? f.wKey : null,
        children: f.children.filter(k => ids.has(k)),
    })).filter(f => f.hKey || f.wKey || f.children.length)];
    const text = createFlatAnnotationText(snapshot, pairs, spouses);
    return Object.fromEntries(snapshot[0].map(p => {
        const birth = p.d != null ? approxOut(p.d, p.abt ?? 0) : '';
        const heading = p.name + (birth ? ' ' + birth : '');
        return [p.key, heading + '\n' + text({ xref: p.key }).replace(/\^+$/gm, '').replace(/\^/g, '\n')];
    }));
}

function viewerFileBase(title) {
    const letters = 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя';
    const latin = ['a','b','v','g','d','e','yo','zh','z','i','y','k','l','m','n','o','p','r','s','t','u','f','kh','ts','ch','sh','shch','','y','','e','yu','ya'];
    return String(title).replace(/[а-яё]/gi, c => {
        const s = latin[letters.indexOf(c.toLowerCase())];
        return c === c.toUpperCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    }).replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 120) || 'tree';
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
#touch-tip{display:none;margin:0 12px 8px;padding:6px 8px;gap:8px;align-items:center;background:#fffbdc;border:1px solid #b7aea0;border-radius:8px}#touch-tip button{margin-left:auto;padding:4px 8px}
@media (hover:none) and (pointer:coarse){#touch-tip:not([hidden]){display:flex}#person{font-size:16px}}
#annotation{position:fixed;z-index:2;width:min(560px,calc(100vw - 24px));max-height:min(65vh,600px);overflow:auto;background:#fffdf7;border:1px solid #b7aea0;border-radius:8px;box-shadow:0 8px 30px #0003;padding:12px}#annotation[hidden]{display:none}#annotation pre{font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0 0;user-select:text}#annotation nav{display:flex;justify-content:space-between;gap:12px}
#annotation{background:#fffbdc}
.indi{cursor:pointer}.name-link,.name-link .name{cursor:help}.name-link .name{fill:#175c9c;text-decoration:underline}
</style></head><body><header><div id="person-picker"><input id="person" type="text" role="combobox" aria-label="Центральная персона" aria-autocomplete="list" aria-expanded="false" aria-controls="person-results" placeholder="Найти человека" autocomplete="off" spellcheck="false"><ul id="person-results" role="listbox" aria-label="Персоны" hidden></ul></div><button id="minus" aria-label="Уменьшить">−</button><button id="plus" aria-label="Увеличить">+</button><button id="fit">Вписать</button></header>
<div id="touch-tip" hidden>Коснитесь карточки, чтобы перестроить дерево вокруг человека. Коснитесь имени, чтобы открыть роспись.<button type="button" aria-label="Закрыть подсказку">×</button></div>
<p id="status" role="status"></p><noscript>Для просмотра включите JavaScript и откройте файл в браузере.</noscript>
<svg id="tree" xmlns="http://www.w3.org/2000/svg" aria-label="Песочные часы"><g id="chart"></g></svg>
<section id="annotation" aria-label="Роспись персоны" hidden><strong id="annotation-heading"></strong><pre id="annotation-text"></pre></section>
<script id="component-licenses" type="application/json">${JSON.stringify(licenses).replace(/</g, '\\u003c')}</script>
<script id="tree-data" type="application/json">${data}</script><script>${script}</script></body></html>`;
}

// ZIP STORE: one UTF-8 entry, no compression or platform APIs.
function viewerZip(html, filename) {
    if (!filename || /[\\/\x00-\x1f]/.test(filename) || filename === '.' || filename === '..') throw new Error('Invalid ZIP filename');
    const enc = new TextEncoder(), name = enc.encode(filename), body = enc.encode(html);
    if (name.length > 65535 || body.length > 0xffffffff - name.length * 2 - 98) throw new Error('ZIP too large');
    const bytes = new Uint8Array(98 + name.length * 2 + body.length), view = new DataView(bytes.buffer);
    let crc = 0xffffffff;
    for (const byte of body) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const u16 = (o, n) => view.setUint16(o, n, true), u32 = (o, n) => view.setUint32(o, n, true);
    u32(0, 0x04034b50); u16(4, 20); u16(6, 0x800); u16(12, 33);
    u32(14, crc); u32(18, body.length); u32(22, body.length); u16(26, name.length);
    bytes.set(name, 30); bytes.set(body, 30 + name.length);
    const c = 30 + name.length + body.length;
    u32(c, 0x02014b50); u16(c + 4, 20); u16(c + 6, 20); u16(c + 8, 0x800); u16(c + 14, 33);
    u32(c + 16, crc); u32(c + 20, body.length); u32(c + 24, body.length); u16(c + 28, name.length);
    bytes.set(name, c + 46);
    const e = c + 46 + name.length;
    u32(e, 0x06054b50); u16(e + 8, 1); u16(e + 10, 1); u32(e + 12, 46 + name.length); u32(e + 16, c);
    return bytes;
}

module.exports = { viewerHtml, viewerZip, viewerFileBase, viewerAnnotations };
