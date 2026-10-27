// ============================== ГЕДКОМ → PDF ==============================
// Диаграмма «линии жизни»: бары рождения–смерти (без даты смерти — до правого
// края), связи родитель→ребёнок в год рождения ребёнка. Отправляется файлом
// <имя>.pdf вместе с <имя>.ged (имя — из заголовка, fileBaseOf). Чистая логика
// дословно продублирована в lunarreturns.js (проверка синхронности —
// dev/sync-check.mjs, раздел chartPdf).
//
// PDF 1.4 собирается вручную, несжатые стримы (zlib в V8-изоляте нет): весь
// чарт один раз рисуется в Form XObject (координаты чарта, y вниз — флип cm),
// а страницы A4 landscape показывают его горизонтальными полосами (клип
// страницы + сдвиг cm) — «нарисовать один чарт и разрезать на страницы».
// Кириллица — встроенный сабсет DejaVu Sans (tgcloud/lib/font-cyr.js,
// генерируется dev/font-subset.mjs) как CIDFontType2/Identity-H: TTF кладётся
// в PDF как есть (FontFile2), из него парсятся только cmap/hmtx/head/OS2.

import { FONT_B64 } from './font-cyr.js';
import { kinLabel } from './kinship.js';

export const CHART_MAX = 150;

// «диапазон» радиуса: 1 родители-дети, 2 деды-внуки, 3 прадеды-правнуки,
// 4 пра2деды-пра2внуки, 5 пра3деды-пра3внуки (один «пра» на половину:
// 3 = прадеды-правнуки) — в чарте у героя и в тостах фокус-кнопок
export const rangeLevel = L => L === 1 ? "родители-дети" : L === 2 ? "деды-внуки"
    : L === 3 ? "прадеды-правнуки"
    : "пра" + (L - 2) + "деды-пра" + (L - 2) + "внуки";  // персон (PDF многостраничный, режется по высоте)
const KIND_W = 170;          // колонка подписей слева (минимум)
const TITLE_H = 34;          // поле заголовка
const ROW_H = 16;            // высота строки персоны
const PLOT_W = 950;          // ширина поля графика
const BAR_H = 11;            // высота бара жизни
// бар жизни — серый: мужчины темнее, женщины светлее, без пола — средний
const BAR_M = "#5f6b76";
const BAR_F = "#9aa5b0";
const BAR_N = "#7f8c8d";
// связи — цвета спектра
const FAM_COLORS = ["#e6194b", "#f58231", "#bfa100", "#3cb44b", "#1f77b4", "#0082c8", "#911eb4"];
const PAGE_W = 842;          // страница A4 landscape, pt
const PAGE_H = 595;

// base64 → байты (без atob — в V8-изоляте платформы его может не быть)
export function b64ToBytes(s) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const idx = new Map([...A].map((c, i) => [c, i]));
    const out = new Uint8Array(Math.floor(s.length * 3 / 4));
    let o = 0, buf = 0, bits = 0;
    for (const c of s) {
        const i = idx.get(c);
        if (i === undefined) continue;   // «=», переносы, пробелы
        buf = (buf << 6) | i;
        if ((bits += 6) >= 8) out[o++] = (buf >> (bits -= 8)) & 0xff;
    }
    return out.subarray(0, o);
}

// минимальный парсер TTF (head/hhea/maxp/hmtx/cmap/OS2): метрики для эмбеддера
// PDF (FontBBox/Ascent/…) и ширины глифов для раскладки текста; glyf не нужен —
// TTF уходит в PDF как есть
export function parseTtf(b) {
    const u16 = o => (b[o] << 8) | b[o + 1];
    const i16 = o => { const v = u16(o); return v >= 0x8000 ? v - 0x10000 : v; };
    const u32 = o => b[o] * 0x1000000 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
    const tag = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    const tabs = {};
    for (let i = 0; i < u16(4); i++) tabs[tag(12 + 16 * i)] = u32(12 + 16 * i + 8);
    if (!tabs.head || !tabs.hhea || !tabs.maxp || !tabs.hmtx || !tabs.cmap)
        throw new Error("ttf: нет обязательных таблиц");
    const upem = u16(tabs.head + 18) || 1000;
    const numGlyphs = u16(tabs.maxp + 4);
    const numH = u16(tabs.hhea + 34);
    const adv = new Array(numGlyphs).fill(0);       // ширины глифов, font units
    // hmtx: numH длинных записей (advance+lsb, 4 байта), дальше «хвост» lsb —
    // advance последних глифов равен advance последней длинной записи
    for (let g = 0; g < numGlyphs; g++) {
        const i = numH ? Math.min(g, numH - 1) : 0;
        adv[g] = numH ? u16(tabs.hmtx + 4 * i) : 0;
    }
    // cmap (3,1)/(0,x), формат 4 (Unicode BMP) → [[код, gid], …] по возрастанию
    let cmap = null;
    for (let i = 0; i < u16(tabs.cmap + 2); i++) {
        const so = tabs.cmap + 4 + 8 * i;
        if (!(u16(so) === 3 && u16(so + 2) === 1) && u16(so) !== 0) continue;
        const b4 = tabs.cmap + u32(so + 4);
        if (u16(b4) !== 4) continue;
        cmap = [];
        const seg = u16(b4 + 6) / 2;
        const eo = b4 + 14, st = eo + seg * 2 + 2, dl = st + seg * 2, ro = dl + seg * 2;
        for (let j = 0; j < seg; j++) {
            const end = u16(eo + 2 * j), start = u16(st + 2 * j);
            const d = i16(dl + 2 * j), r = u16(ro + 2 * j);
            for (let c = start || 1; c <= end; c++) {
                let g = 0;
                if (r === 0) g = (c + d) & 0xffff;
                else {
                    const gi = u16(ro + 2 * j + r + 2 * (c - start));
                    g = gi ? (gi + d) & 0xffff : 0;
                }
                if (g) cmap.push([c, g]);
            }
        }
        break;
    }
    if (!cmap) throw new Error("ttf: нет Unicode-подтаблицы cmap (формат 4)");
    const k = 1000 / upem;
    let asc = 0, desc = 0, cap = 0;
    if (tabs["OS/2"]) {
        asc = i16(tabs["OS/2"] + 68);    // sTypoAscender
        desc = i16(tabs["OS/2"] + 72);   // sTypoDescender
        cap = i16(tabs["OS/2"] + 88);    // sCapHeight (OS/2 v2+)
    }
    const bbox = [i16(tabs.head + 36), i16(tabs.head + 38), i16(tabs.head + 40), i16(tabs.head + 42)];
    return {
        upem, numGlyphs, adv, cmap,
        bbox: bbox.map(v => Math.round(v * k)),
        asc: Math.round((asc || bbox[3]) * k),
        desc: Math.round((desc || bbox[1]) * k),
        cap: Math.round((cap || asc || bbox[3]) * k),
    };
}

// rows — [{ name, birth: "ГГГГ-ММ-…", death: "…"/null, sex: "M"/"F"/null }];
// links — [{ child: <ключ «Имя год»>, parents: [ключ, …] }]. rel — данные
// родства к герою (не задан — колонка «Год» без ярлыков):
//   { hero: <ключ «Имя год»>, pairs: [[родитель, ребёнок], …] } — в колонке
//   «уровень год»: поколенческий диапазон уровня по крови к герою
//   (1 родители-дети, 2 деды-внуки, 3 прадеды-правнуки, 4 пра2деды-пра2внуки,
//   5 пра3деды-пра3внуки); у героя и вне крови — просто «Год»
// rel.phantoms — дети супругов вне чарта (не попали в радиус): рисовать
//   линию между супругами в годы их рождения — [{ fam: [супруг, супруг],
//   years: [год…] }]
// Вычисляет всю геометрию (без рендера) → модель с примитивами draws
// (rect/rrect/line/qarc/dot/text) в порядке отрисовки — единая основа для
// PDF-эммитера
export function chartModel(title, rows, links, rel = null) {
    if (!rows.length) throw new Error("chart: персоны пусты");
    const year = d => Number(String(d).slice(0, 4));
    const TODAY_Y = new Date().getFullYear(); // «сегодня» — гранулярность оси (годы)
    const keyOf = r => r.name + " " + year(r.birth);
    // не более CHART_MAX: берём CHART_MAX МЛАДШИХ (снизу = младшие); связи,
    // где кто-то из персон отсекся, удаляются; список всегда рисуем (без отказа)
    if (rows.length > CHART_MAX) {
        const sorted = [...rows].sort((a, b) => year(a.birth) - year(b.birth)
            || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const keep = new Set(sorted.slice(-CHART_MAX).map(keyOf));
        rows = rows.filter(r => keep.has(keyOf(r)));
        links = links.filter(l => keep.has(l.child) && l.parents.every(p => keep.has(p)));
    }
    const seen = new Set();
    for (const r of rows) {
        if (seen.has(keyOf(r))) throw new Error("chart: ключ неуникален " + keyOf(r));
        if (r.death && year(r.death) < year(r.birth)) throw new Error("chart: смерть раньше рождения " + keyOf(r));
        seen.add(keyOf(r));
    }
    const byKey = new Map(rows.map(r => [keyOf(r), r]));
    for (const l of links) {
        if (!byKey.has(l.child)) throw new Error("chart: имя не найдено " + l.child);
        if (!l.parents.length || l.parents.length > 2) throw new Error("chart: родителей не 1–2 " + l.child);
        for (const p of l.parents) {
            if (!byKey.has(p)) throw new Error("chart: имя не найдено " + p);
            if (year(byKey.get(p).birth) > year(byKey.get(l.child).birth))
                throw new Error("chart: родитель не старше ребёнка " + p);
        }
    }
    // оценка ширины текста в px (DejaVu Sans 10px, см. фактические ширины
    // сабсета): прописные ~7.7, строчные ~6.3, цифры ~6.4, пробел ~3.2 —
    // для ширины колонки подписей
    const textW = s => [...s].reduce((a, c) => a
        + (c === " " ? 3.2
            : c >= "0" && c <= "9" ? 6.4
            : c === c.toUpperCase() && c !== c.toLowerCase() ? 7.7
            : 6.3), 0);
    // порядок строк: (год рождения, имя) — ключи «Имя год»
    const people = [...rows].sort((a, b) => year(a.birth) - year(b.birth)
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(r => ({ r, key: keyOf(r), yr: year(r.birth), dy: r.death ? year(r.death) : null, row: 0 }));
    // у героя в колонке — «диапазон» радиуса (уровень из кейкапа заголовка,
    // rel.range — rangeLevel(L)); у остальных строк — прежние индивидуальные
    // ярлыки родства (как в 🔔-списке); у героя и вне родни (без героя/
    // диапазона) — подпись «Год»
    const kin = rel && rel.hero
        ? new Map(people.map(p =>
            [p.key, kinLabel(rel.pairs || [], rel.spouses || [], k2 => (rel.sex || {})[k2] ?? null, rel.hero, p.key)]))
        : null;
    if (kin && rel.range) kin.set(rel.hero, rangeLevel(rel.range));
    people.forEach((p, i) => {
        p.row = i;
        p.label = (() => { const l = kin ? kin.get(p.key) : ""; return (l ? l + " " : "") + p.yr; })();
    });
    const rowOf = new Map(people.map(p => [p.key, p]));
    const allYears = [
        ...people.map(p => p.yr),
        ...people.filter(p => p.dy !== null).map(p => p.dy),
        // без даты смерти бар ограничен 80 годами или сегодня — ось X должна
        // их покрыть
        ...people.filter(p => p.dy === null).map(p => Math.min(p.yr + 80, TODAY_Y)),
        ...links.map(l => year(byKey.get(l.child).birth)),
    ];
    // колонка подписей «Связь год»: под самую длинную строку, все — одной строкой
    const KW = Math.max(KIND_W, Math.ceil(Math.max(...people.map(p => textW(p.label))) + 12));
    const xS = x => KW + (x - xMin) / (xMax - xMin) * PLOT_W;
    let acc = 0;
    for (const p of people) { p.h = ROW_H; p.y0 = acc; acc += p.h; }
    const plotTop = TITLE_H + 12;
    const H = plotTop + acc + 30;
    const W = KW + PLOT_W + 16;

    // family-связи: цвет — из спектра без коллизий внутри года рождения её
    // детей (близнецы разных пар не спутать); ключ семьи — каноничный
    // (отсортированная пара ключей), чтобы ссылки одного семейства с разным
    // порядком родителей не плодили разные цвета
    const famOf = new Map();        // fam → номер появления
    const famYears = new Map();     // fam → годы рождения её детей
    const famStr = l => [...l.parents].sort().join(" и ");
    for (const l of links) {
        const fam = famStr(l);
        const y = year(byKey.get(l.child).birth);
        if (!famOf.has(fam)) { famOf.set(fam, famOf.size); famYears.set(fam, new Set()); }
        famYears.get(fam).add(y);
    }
    // фантомные рождения (rel.phantoms): те же fam-структуры + записи для
    // рисования; годы обоим детям вне чарта — в диапазон оси X; у семьи без
    // ссылок в чарте цвет берётся от её порядкового номера
    const phantom = [];             // { fam, year, a, b } — a/b ключи супругов
    if (rel && Array.isArray(rel.phantoms))
        for (const ph of rel.phantoms) {
            const ks = Array.isArray(ph.fam) && ph.fam.length === 2 ? ph.fam : null;
            if (!ks || !rowOf.has(ks[0]) || !rowOf.has(ks[1])) continue;
            const fam = [...ks].sort().join(" и ");
            if (!famOf.has(fam)) { famOf.set(fam, famOf.size); famYears.set(fam, new Set()); }
            for (const yr of ph.years || [])
                if (Number.isFinite(yr)) {
                    famYears.get(fam).add(yr);
                    phantom.push({ fam, year: yr, a: ks[0], b: ks[1] });
                    allYears.push(yr);
                }
        }
    const famColorIdx = new Map();
    const busy = new Map();         // год → занятые индексы FAM_COLORS
    for (const [fam] of famOf) {
        const yrs = [...famYears.get(fam)];
        let c = famOf.get(fam) % FAM_COLORS.length, tries = 0;
        while (tries++ < FAM_COLORS.length
            && yrs.some(y => (busy.get(y) || new Set()).has(c)))
            c = (c + 1) % FAM_COLORS.length;
        famColorIdx.set(fam, c);
        for (const y of yrs) {
            const s = busy.get(y) || new Set();
            s.add(c);
            busy.set(y, s);
        }
    }
    const famColor = fam => FAM_COLORS[famColorIdx.get(fam)];

    // минимальный год (после фантомных рождений — ось X должна их покрыть):
    // между колонкой подписей и баром каждой персоны должно помещаться её имя
    // (имя выровнено перед баром) — xMin уходит в прошлое, пока хватает места
    // у самой стеснённой персоны; итерация до сходимости (span растёт вместе
    // с xMin назад)
    const xMinRaw = Math.floor(Math.min(...allYears) / 10) * 10;
    const xMax = Math.max(Math.ceil(Math.max(...allYears) / 10) * 10, xMinRaw + 10);
    let xMin = xMinRaw;
    for (let it = 0; it < 8; it++) {
        const span = xMax - xMin;
        let cand = xMinRaw;
        for (const p of people)
            cand = Math.min(cand, p.yr - Math.ceil((textW(p.r.name) + 8) * span / PLOT_W));
        if (cand >= xMin) break;
        xMin = cand;
    }

    const draws = [];
    // фон и заголовок
    draws.push({ k: "rect", x: 0, y: 0, w: W, h: H, fill: "#ffffff" });
    draws.push({ k: "text", x: 8, y: 22, s: title, size: 16, fill: "#111111", bold: true });
    // сетка-декады и подписи оси X (от первой декады — ниже некруглого xMin — xMin может
    // уйти в прошлое на некруглое число лет ради места под имена)
    for (let x = Math.ceil(xMin / 10) * 10; x <= xMax; x += 10) {
        draws.push({ k: "line", x1: xS(x), y1: plotTop, x2: xS(x), y2: H - 26, stroke: "#eeeeee", w: 1 });
        draws.push({ k: "line", x1: xS(x), y1: H - 26, x2: xS(x), y2: H - 20, stroke: "#888888", w: 1 });
        draws.push({ k: "text", x: xS(x), y: H - 8, s: String(x), size: 10, fill: "#666666", anchor: "mid" });
    }
    draws.push({ k: "line", x1: KW, y1: H - 26, x2: KW + PLOT_W, y2: H - 26, stroke: "#888888", w: 1 });
    // подписи «Связь год» слева; имя — слева от бара (перед его началом),
    // выноска — до имени, её хвост (тонкая линия) тянется к началу бара
    for (const p of people) {
        const cy = plotTop + p.y0 + p.h / 2;
        p.cy = cy;
        draws.push({ k: "text", x: KW - 8, y: cy + 3.5, s: p.label, size: 10, fill: "#333333", anchor: "end" });
        // без даты смерти — до 80 лет от рождения, но не дальше сегодня
        // (прожитая жизнь); с известной датой смерти за баром пишем N —
        // сколько лет прожито; без даты смерти — ничего
        const end = p.dy ?? Math.max(p.yr, Math.min(p.yr + 80, TODAY_Y));
        const x1 = xS(p.yr), x2 = xS(end);
        const bar = p.r.sex === "M" ? BAR_M : p.r.sex === "F" ? BAR_F : BAR_N;
        // выноска («отступ»): тонкая линия от колонки подписей до имени;
        // места от колонки до бара не хватает (поздний год рождения) — линии нет
        const nw = textW(p.r.name);
        const lnEnd = x1 - nw - 10;
        if (lnEnd > KW - 6)
            draws.push({ k: "line", x1: KW - 6, y1: cy, x2: lnEnd, y2: cy, stroke: "#bbbbbb", w: 1 });
        draws.push({ k: "text", x: x1 - 6, y: cy + 3.5, s: p.r.name, size: 10, fill: "#111111", anchor: "end" });
        draws.push({ k: "rrect", x: x1, y: cy - BAR_H / 2, w: Math.max(2, x2 - x1), h: BAR_H, r: 2, fill: bar });
        if (p.dy !== null) // известная смерть — N прожитых лет за баром
            draws.push({ k: "text", x: x2 + 4, y: cy + 3.5, s: String(p.dy - p.yr), size: 10, fill: bar });
    }
    // дуги родитель→ребёнок (в год рождения ребёнка), точки на строках;
    // по родителю — одна точка даже при близнецах; цвет — цвет связи (семьи);
    // радиус пропорционален вертикальному расстоянию родитель→ребёнок —
    // короткие дуги прижаты к вертикали, длинные шире (пересечений меньше);
    // плюс сдвиг 14px на каждую семью в этом же году — столбцы не совпадают
    const slotOf = new Map();       // «fam\0год» → сдвиг (номер семьи на год)
    const yearCount = new Map();    // год → сколько семей уже заняли столбец
    const famSeen = new Set();
    for (const l of links) {
        const y = year(byKey.get(l.child).birth);
        const kk = famStr(l) + "\0" + y;
        if (!famSeen.has(kk)) {
            famSeen.add(kk);
            slotOf.set(kk, yearCount.get(y) || 0);
            yearCount.set(y, (yearCount.get(y) || 0) + 1);
        }
    }
    // фантомные рождения занимают свои столбцы (близнецы-год: включённый и
    // вырезанный ребёнок — на разных вертикалях); год, у этой семьи уже
    // занятый включённым ребёнком, не дублируем — дуга уже нарисована
    for (const ph of phantom) {
        const kk = ph.fam + "\0" + ph.year;
        if (famSeen.has(kk)) continue;
        famSeen.add(kk);
        slotOf.set(kk, yearCount.get(ph.year) || 0);
        yearCount.set(ph.year, (yearCount.get(ph.year) || 0) + 1);
    }
    for (const l of links) {
        const fam = famStr(l);
        const col = famColor(fam);
        const y = year(byKey.get(l.child).birth);
        const ps = l.parents.map(p => rowOf.get(p)).sort((a, b) => a.cy - b.cy);
        const ch0 = rowOf.get(l.child);
        const gap = Math.abs(ch0.cy - ps[ps.length - 1].cy);
        const side = -(14 * slotOf.get(fam + "\0" + y) + 14 * gap / ROW_H);
        const x = xS(y);
        const chY = ch0.cy;
        // прямая между двумя родителями; к ребёнку — дуга, а если в этот год
        // рождается ребёнок только у одной семьи — просто прямая линия
        if (ps.length === 2 && ps[0].cy !== ps[1].cy)
            draws.push({ k: "line", x1: x, y1: ps[0].cy, x2: x, y2: ps[1].cy, stroke: col, w: 1.5 });
        const lo = ps[ps.length - 1];
        if (lo.key !== ch0.key) {
            if ((yearCount.get(y) || 0) === 1)
                draws.push({ k: "line", x1: x, y1: lo.cy, x2: x, y2: chY, stroke: col, w: 1.5 });
            else
                draws.push({ k: "qarc", x0: x, y0: lo.cy, qx: xS(y) + side, qy: (lo.cy + chY) / 2, x1: x, y1: chY, stroke: col, w: 1.5 });
        }
        // точки поверх линий
        for (const p of ps)
            draws.push({ k: "dot", x, y: p.cy, r: 3.5, fill: col });
        draws.push({ k: "dot", x, y: chY, r: 3.5, fill: col });
    }
    // фантомные рождения: вертикаль между супругами в год рождения ребёнка
    // (ребёнка в чарте нет), точки на строках супругов — как у связей;
    // вниз линия переходит нижнюю точку на 8px — не спутать с прямой
    // родитель→ребёнок (у неё точка на одной строке родителей)
    for (const ph of phantom) {
        const col = famColor(ph.fam);
        const kk = ph.fam + "\0" + ph.year;
        const x = xS(ph.year) - 14 * slotOf.get(kk);
        const p1 = rowOf.get(ph.a), p2 = rowOf.get(ph.b);
        const yTop = Math.min(p1.cy, p2.cy), yBot = Math.max(p1.cy, p2.cy) + 8;
        if (p1.cy !== p2.cy)
            draws.push({ k: "line", x1: x, y1: yTop, x2: x, y2: yBot, stroke: col, w: 1.5 });
        draws.push({ k: "dot", x, y: p1.cy, r: 3.5, fill: col });
        draws.push({ k: "dot", x, y: p2.cy, r: 3.5, fill: col });
    }
    return { title, W, H, KW, draws };
}

// имя файла (без расширения) из заголовка: убрать эмодзи/не-BMP и символы,
// недопустимые в файловых системах и API мессенджеров (/ \ : * ? " < > | #,
// VS16, ZWJ), схлопнуть пробелы, обрезать концевые точку/пробел; не длиннее
// 64 кодточек; пусто → «tree»
export function fileBaseOf(head) {
    const s = String(head)
        .replace(/[\u{10000}-\u{10FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
        .replace(/[\/\\:*?"<>|#]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[ .]+|[ .]+$/g, "");
    const cps = [...s];
    if (cps.length > 64) return cps.slice(0, 64).join("");
    return s || "tree";
}

// диаграмма → PDF (строка latin1, байт на символ): страницы A4 landscape
// режут единое полотно чарта на горизонтальные полосы (Form XObject + клип)
export function chartPdf(title, rows, links, fontBytes, rel = null) {
    const f = parseTtf(fontBytes);
    const m = chartModel(title, rows, links, rel);
    const n = v => String(Math.round(v * 1000) / 1000);
    const col = hex => [1, 3, 5].map(i => n(parseInt(hex.slice(i, i + 2), 16) / 255)).join(" ");
    const cmap = new Map(f.cmap);
    const glyphs = s => {
        let hexStr = "", units = 0;
        for (const ch of String(s)) {
            const g = cmap.get(ch.codePointAt(0));
            if (!g) continue;    // нет глифа (эмодзи и пр.) — пропустить
            hexStr += g.toString(16).padStart(4, "0");
            units += f.adv[g] || 0;
        }
        return { hexStr, w: units / f.upem };   // w — в em, ×size → px
    };
    // операторы чарта (координаты y вниз; флип — cm XObject'а, для текста
    // двойной флип в Tm оставляет его прямым)
    const ops = [];
    for (const d of m.draws) {
        if (d.k === "rect") {
            ops.push(col(d.fill) + " rg",
                n(d.x) + " " + n(d.y) + " " + n(d.w) + " " + n(d.h) + " re f");
        } else if (d.k === "rrect") {   // бар со скруглёнными углами
            const r = Math.min(d.r, d.w / 2, d.h / 2), k = 0.55228 * r;
            const R = n(d.x + d.w), L = n(d.x), T = n(d.y), B = n(d.y + d.h);
            ops.push(col(d.fill) + " rg",
                n(d.x + r) + " " + T + " m " + n(d.x + d.w - r) + " " + T + " l "
                + n(d.x + d.w - r + k) + " " + T + " " + R + " " + n(d.y + r - k) + " " + R + " " + n(d.y + r) + " c "
                + R + " " + n(d.y + d.h - r) + " l "
                + R + " " + n(d.y + d.h - r + k) + " " + n(d.x + d.w - r + k) + " " + B + " " + n(d.x + d.w - r) + " " + B + " c "
                + n(d.x + r) + " " + B + " l "
                + n(d.x + r - k) + " " + B + " " + L + " " + n(d.y + d.h - r + k) + " " + L + " " + n(d.y + d.h - r) + " c "
                + L + " " + n(d.y + r) + " l "
                + L + " " + n(d.y + r - k) + " " + n(d.x + r - k) + " " + T + " " + n(d.x + r) + " " + T + " c h f");
        } else if (d.k === "line") {
            ops.push(n(d.w) + " w " + col(d.stroke) + " RG "
                + n(d.x1) + " " + n(d.y1) + " m " + n(d.x2) + " " + n(d.y2) + " l S");
        } else if (d.k === "qarc") {
            // квадратичная (SVG Q) → кубическая: обе контрольные = P + ⅔(Q−P0)
            const c1x = d.x0 + 2 / 3 * (d.qx - d.x0), c1y = d.y0 + 2 / 3 * (d.qy - d.y0);
            const c2x = d.x1 + 2 / 3 * (d.qx - d.x0), c2y = d.y1 + 2 / 3 * (d.qy - d.y0);
            ops.push(n(d.w) + " w " + col(d.stroke) + " RG "
                + n(d.x0) + " " + n(d.y0) + " m "
                + n(c1x) + " " + n(c1y) + " " + n(c2x) + " " + n(c2y) + " " + n(d.x1) + " " + n(d.y1) + " c S");
        } else if (d.k === "dot") {     // точка: заливка цветом семьи + белая обводка
            const k = 0.55228 * d.r;
            ops.push(col(d.fill) + " rg 1 1 1 RG 1 w "
                + n(d.x + d.r) + " " + n(d.y) + " m "
                + n(d.x + d.r) + " " + n(d.y + k) + " " + n(d.x + k) + " " + n(d.y + d.r) + " " + n(d.x) + " " + n(d.y + d.r) + " c "
                + n(d.x - k) + " " + n(d.y + d.r) + " " + n(d.x - d.r) + " " + n(d.y + k) + " " + n(d.x - d.r) + " " + n(d.y) + " c "
                + n(d.x - d.r) + " " + n(d.y - k) + " " + n(d.x - k) + " " + n(d.y - d.r) + " " + n(d.x) + " " + n(d.y - d.r) + " c "
                + n(d.x + k) + " " + n(d.y - d.r) + " " + n(d.x + d.r) + " " + n(d.y - k) + " " + n(d.x + d.r) + " " + n(d.y) + " c h B");
        } else if (d.k === "text") {
            const g = glyphs(d.s);
            if (!g.hexStr) continue;
            const x = d.anchor === "end" ? d.x - g.w * d.size
                : d.anchor === "mid" ? d.x - g.w * d.size / 2 : d.x;
            const c = col(d.fill);
            ops.push("BT /F1 " + n(d.size) + " Tf " + c + " rg "
                + (d.bold ? c + " RG 0.3 w 2 Tr" : "0 w 0 Tr") + " "
                + "1 0 0 -1 " + n(x) + " " + n(d.y) + " Tm "
                + "<" + g.hexStr + "> Tj ET");
        }
    }
    const chart = "q\n1 0 0 -1 0 " + n(m.H) + " cm\n" + ops.join("\n") + "\nQ";

    // страницы: полотно масштабируется на ширину A4 landscape, режется по
    // высоте на полосы не выше страницы; границы полос — строго по границам
    // строк персон (зона заголовка/ось X не режутся) — персон не делится
    // пополам между страницами; при одной странице — весь чарт
    const s = PAGE_W / m.W;
    const avail = PAGE_H / s;
    const plotTop = TITLE_H + 12;
    const cuts = [];
    for (let t = 0; m.H - t > avail + 1e-9;) {
        let c = plotTop + ROW_H * Math.floor((Math.min(t + avail, m.H - 30) - plotTop) / ROW_H);
        if (c <= t) c = t + ROW_H;
        cuts.push(c);
        t = c;
    }
    const bands = [0, ...cuts, m.H];
    const pages = bands.length - 1;

    const parts = [];
    let len = 0;
    const off = [];
    const push = t => { parts.push(t); len += t.length; };
    const obj = (num, body) => { off[num] = len; push(num + " 0 obj\n" + body + "\nendobj\n"); };
    const stream = (num, dict, body) =>
        obj(num, "<< " + dict + " /Length " + body.length + " >>\nstream\n" + body + "\nendstream");
    push("%PDF-1.4\n%\u00E2\u00E3\u00CF\u00D3\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    const kids = [];
    for (let i = 0; i < pages; i++) kids.push(3 + 2 * i + " 0 R");
    obj(2, "<< /Type /Pages /Kids [" + kids.join(" ") + "] /Count " + pages + " >>");
    const chartObj = 3 + 2 * pages;      // Form XObject чарта
    const f0 = chartObj + 1;             // Type0 (Identity-H)
    const f1 = chartObj + 2;             // CIDFontType2
    const f2 = chartObj + 3;             // FontDescriptor
    const f3 = chartObj + 4;             // FontFile2 (TTF как есть)
    const f4 = chartObj + 5;             // ToUnicode — поиск/копирование текста
    for (let i = 0; i < pages; i++) {
        const band = bands[i + 1] - bands[i];        // высота полосы, единицы чарта
        obj(3 + 2 * i, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + PAGE_W + " " + PAGE_H + "]"
            + " /Resources << /XObject << /C " + chartObj + " 0 R >> >> /Contents " + (4 + 2 * i) + " 0 R >>");
        stream(4 + 2 * i, "",
            "q\n0 " + n(PAGE_H - s * band) + " " + PAGE_W + " " + n(s * band) + " re W n\n"
            + n(s) + " 0 0 " + n(s) + " 0 " + n(PAGE_H - s * (m.H - bands[i])) + " cm\n/C Do\nQ");
    }
    stream(chartObj, "/Type /XObject /Subtype /Form /BBox [0 0 " + n(m.W) + " " + n(m.H) + "]"
        + " /Resources << /Font << /F1 " + f0 + " 0 R >> >>", chart);
    const wArr = [];
    for (let g = 1; g < f.numGlyphs; g++) {
        const w = Math.round(f.adv[g] * 1000 / f.upem);
        if (w) wArr.push(g + " [" + w + "]");
    }
    obj(f0, "<< /Type /Font /Subtype /Type0 /BaseFont /LRChart /Encoding /Identity-H"
        + " /DescendantFonts [" + f1 + " 0 R] /ToUnicode " + f4 + " 0 R >>");
    obj(f1, "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LRChart"
        + " /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>"
        + " /FontDescriptor " + f2 + " 0 R /DW 1000 /W [" + wArr.join(" ") + "] /CIDToGIDMap /Identity >>");
    obj(f2, "<< /Type /FontDescriptor /FontName /LRChart /Flags 4"
        + " /FontBBox [" + f.bbox.join(" ") + "] /ItalicAngle 0"
        + " /Ascent " + f.asc + " /Descent " + f.desc + " /CapHeight " + f.cap + " /StemV 80"
        + " /FontFile2 " + f3 + " 0 R >>");
    let bin = "";
    for (let i = 0; i < fontBytes.length; i += 8192)
        bin += String.fromCharCode.apply(null, fontBytes.subarray(i, i + 8192));
    stream(f3, "/Length1 " + fontBytes.length, bin);
    // ToUnicode: bfchar gid → Unicode (код из cmap), блоки по 100 записей
    const tu = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def", "/CMapType 2 def",
        "1 begincodespacerange", "<0000> <ffff>", "endcodespacerange"];
    for (let i = 0; i < f.cmap.length; i += 100) {
        tu.push(Math.min(100, f.cmap.length - i) + " beginbfchar");
        for (let j = i; j < Math.min(i + 100, f.cmap.length); j++)
            tu.push("<" + f.cmap[j][1].toString(16).padStart(4, "0") + "> <"
                + f.cmap[j][0].toString(16).padStart(4, "0") + ">");
        tu.push("endbfchar");
    }
    tu.push("endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end");
    stream(f4, "", tu.join("\n"));
    const xref = len;
    push("xref\n0 " + (f4 + 1) + "\n0000000000 65535 f \n");
    for (let i = 1; i <= f4; i++)
        push(String(off[i]).padStart(10, "0") + " 00000 n \n");
    push("trailer\n<< /Size " + (f4 + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF");
    return parts.join("");
}

// байты шрифта (кэш): ТГ берёт FONT_B64 импортом tgcloud/lib/font-cyr.js —
// единственный источник; ВК-копия читает тот же файл с диска (это осознанная
// платформенная разница, остальной код блока идентичен)
let FONT_CACHE = null;
export function chartFont() {
    return FONT_CACHE ??= b64ToBytes(FONT_B64);
}
