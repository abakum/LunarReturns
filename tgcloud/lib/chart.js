// ============================== ГЕДКОМ → SVG ==============================
// Диаграмма «линии жизни»: бары рождения–смерти (без даты смерти — до правого
// края), связи родитель→ребёнок в год рождения ребёнка. Отправляется файлом
// tree.svg при < SVG_MAX персон (вместе с tree.ged). Чистая логика дословно
// продублирована в lunarreturns.js (проверка синхронности — dev/sync-check.mjs,
// раздел chartSvg).

export const SVG_MAX = 50;   // персон, до которых строим tree.svg
const KIND_W = 170;          // колонка подписей слева (минимум)
const TITLE_H = 34;          // поле заголовка
const ROW_H = 16;            // высота строки персоны
const LINE_H = 10;           // высота строки подписи (в многострочных именах)
const PLOT_W = 950;          // ширина поля графика
const BAR_H = 11;            // высота бара жизни
// бар жизни — серый: мужчины темнее, женщины светлее, без пола — средний
const BAR_M = "#5f6b76";
const BAR_F = "#9aa5b0";
const BAR_N = "#7f8c8d";
// связи — цвета спектра
const FAM_COLORS = ["#e6194b", "#f58231", "#bfa100", "#3cb44b", "#1f77b4", "#0082c8", "#911eb4"];

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// rows — [{ name, birth: "ГГГГ-ММ-…", death: "…"/null, sex: "M"/"F"/null }];
// links — [{ child: <ключ «Имя год»>, parents: [ключ, …] }]; никаких дат,
// кроме годов; SVG — статическая картинка
export function chartSvg(title, rows, links) {
    if (!rows.length) throw new Error("chart: персоны пусты");
    const year = d => Number(String(d).slice(0, 4));
    const keyOf = r => r.name + " " + year(r.birth);
    // не более SVG_MAX: берём SVG_MAX МЛАДШИХ (снизу = младшие); связи, где
    // кто-то из персон отсекся, удаляются; список всегда рисуем (без отказа)
    if (rows.length > SVG_MAX) {
        const sorted = [...rows].sort((a, b) => year(a.birth) - year(b.birth)
            || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const keep = new Set(sorted.slice(-SVG_MAX).map(keyOf));
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
    // оценка ширины текста в px (sans-serif 10px): прописные шире строчных,
    // цифры средние, пробелы узкие
    const textW = s => [...s].reduce((a, c) => a
        + (c === " " ? 2.8
            : c >= "0" && c <= "9" ? 5.6
            : c === c.toUpperCase() && c !== c.toLowerCase() ? 6.8
            : 5.2), 0);
    // порядок строк: (год рождения, имя) — ключи «Имя год»
    const people = [...rows].sort((a, b) => year(a.birth) - year(b.birth)
        || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        .map(r => ({ r, key: keyOf(r), yr: year(r.birth), dy: r.death ? year(r.death) : null, row: 0 }));
    people.forEach((p, i) => { p.row = i; });
    const rowOf = new Map(people.map(p => [p.key, p]));
    const allYears = [
        ...people.map(p => p.yr),
        ...people.filter(p => p.dy !== null).map(p => p.dy),
        ...links.map(l => year(byKey.get(l.child).birth)),
    ];
    const xMin = Math.floor(Math.min(...allYears) / 10) * 10;
    const xMax = Math.max(Math.ceil(Math.max(...allYears) / 10) * 10, xMin + 10);

    // колонка подписей: под самую длинную строку «Имя год», все — одной строкой
    const KW = Math.max(KIND_W, Math.ceil(Math.max(...rows.map(r => textW(keyOf(r)))) + 12));
    const maxL = KW - 14;
    const wrapLabel = s => [s];
    const xS = x => KW + (x - xMin) / (xMax - xMin) * PLOT_W;

    // высоты строк: у людей с многострочными подписями строка выше
    let acc = 0;
    for (const p of people) {
        p.lines = wrapLabel(p.key);
        p.h = (p.lines.length - 1) * LINE_H + ROW_H;
        p.y0 = acc;
        acc += p.h;
    }
    const plotTop = TITLE_H + 12;
    const H = plotTop + acc + 30;
    const W = KW + PLOT_W + 16;

    // family-связи: цвет — из спектра без коллизий внутри года рождения её
    // детей (близнецы разных пар не спутать)
    const famOf = new Map();        // fam → номер появления
    const famYears = new Map();     // fam → годы рождения её детей
    const famStr = l => l.parents.map(p => rowOf.get(p)).map(q => q.r.name + " " + q.yr).join(" и ");
    for (const l of links) {
        const fam = famStr(l);
        const y = year(byKey.get(l.child).birth);
        if (!famOf.has(fam)) { famOf.set(fam, famOf.size); famYears.set(fam, new Set()); }
        famYears.get(fam).add(y);
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

    const s = [];
    s.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="sans-serif">`);
    s.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="white"/>`);
    s.push(`<text x="8" y="22" font-size="16" font-weight="bold" fill="#111">${esc(title)}</text>`);
    // сетка-декады и подписи оси X
    for (let x = xMin; x <= xMax; x += 10) {
        s.push(`<line x1="${xS(x).toFixed(1)}" y1="${plotTop}" x2="${xS(x).toFixed(1)}" y2="${H - 26}" stroke="#eee" stroke-width="1"/>`);
        s.push(`<line x1="${xS(x).toFixed(1)}" y1="${H - 26}" x2="${xS(x).toFixed(1)}" y2="${H - 20}" stroke="#888" stroke-width="1"/>`);
        s.push(`<text x="${xS(x).toFixed(1)}" y="${H - 8}" font-size="10" fill="#666" text-anchor="middle">${x}</text>`);
    }
    s.push(`<line x1="${KW}" y1="${H - 26}" x2="${KW + PLOT_W}" y2="${H - 26}" stroke="#888" stroke-width="1"/>`);
    // подписи (1–3 строки) + бары (серые: мужчины темнее, женщины светлее)
    for (const p of people) {
        const cy = plotTop + p.y0 + p.h / 2;
        p.cy = cy;
        for (let j = 0; j < p.lines.length; j++) {
            const ly = cy - (p.lines.length - 1 - j) * LINE_H + 3.5;
            s.push(`<text x="${KW - 8}" y="${ly.toFixed(1)}" font-size="10" fill="#333" text-anchor="end">${esc(p.lines[j])}</text>`);
        }
        const end = p.dy ?? xMax;
        const x1 = xS(p.yr), x2 = xS(end);
        const bar = p.r.sex === "M" ? BAR_M : p.r.sex === "F" ? BAR_F : BAR_N;
        // выноска: тонкая линия от имени к началу бара
        s.push(`<line x1="${KW - 6}" y1="${cy.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="#bbb" stroke-width="1"/>`);
        s.push(`<rect x="${x1.toFixed(1)}" y="${(cy - BAR_H / 2).toFixed(1)}" width="${Math.max(2, x2 - x1).toFixed(1)}" height="${BAR_H}" rx="2" fill="${bar}"/>`);
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
    for (const l of links) {
        const fam = famStr(l);
        const col = famColor(fam);
        const y = year(byKey.get(l.child).birth);
        const lo0 = l.parents.map(p => rowOf.get(p)).sort((a, b) => a.cy - b.cy);
        const ch0 = rowOf.get(l.child);
        const gap = Math.abs(ch0.cy - lo0[lo0.length - 1].cy);
        const side = -(14 * slotOf.get(fam + "\0" + y) + 22 * gap / ROW_H);
        const x = xS(y).toFixed(1);
        const chY = ch0.cy;
        const py = p => p.cy.toFixed(1);
        const ps = lo0;
        // прямая между двумя родителями; к ребёнку — дуга, а если в этот год
        // рождается ребёнок только у одной семьи — просто прямая линия
        if (ps.length === 2 && py(ps[0]) !== py(ps[1]))
            s.push(`<line x1="${x}" y1="${py(ps[0])}" x2="${x}" y2="${py(ps[1])}" stroke="${col}" stroke-width="1.5"/>`);
        const lo = ps[ps.length - 1];
        if (lo.key !== ch0.key) {
            if ((yearCount.get(y) || 0) === 1)
                s.push(`<line x1="${x}" y1="${py(lo)}" x2="${x}" y2="${chY.toFixed(1)}" stroke="${col}" stroke-width="1.5"/>`);
            else
                s.push(`<path d="M ${x} ${py(lo)} Q ${(xS(y) + side).toFixed(1)} ${((lo.cy + chY) / 2).toFixed(1)} ${x} ${chY.toFixed(1)}" fill="none" stroke="${col}" stroke-width="1.5"/>`);
        }
        // точки поверх линий
        for (const p of ps)
            s.push(`<circle cx="${x}" cy="${py(p)}" r="3.5" fill="${col}" stroke="white" stroke-width="1"/>`);
        s.push(`<circle cx="${x}" cy="${chY.toFixed(1)}" r="3.5" fill="${col}" stroke="white" stroke-width="1"/>`);
    }
    s.push("</svg>");
    return s.join("\n");
}
