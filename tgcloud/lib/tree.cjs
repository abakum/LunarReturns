// tree.cjs — общий канон фокус-родни (чистая логика) для ВК и ТГ (план
// .kilo/plans/20261107-shared-modules-plan.md): ВК require-ит из lunarreturns.js, ТГ импортирует
// tgcloud/lib/bot.js → './tree.cjs'; правки — только здесь, копий больше нет.
// С A3 — ещё списки: focusListText (формат+сортировка фокуса) и eventListText
// (формат/фильтр/круговой MM-DD порядок колокольчика); строки выборки БД
// остаются в адаптерах ботов (план .kilo/plans/20261108-canon-pure-a3-plan.md).
const { kinLabel } = require('./kinship.cjs');
const { approxOut } = require('./text.cjs');
const { newStyleDate } = require('./religion.cjs');

function focusDepth(pairs, spousePairs, key) {
    let m = 0;
    for (const d of focusGraphDist(pairs, spousePairs, key, 5).values())
        if (d > m) { m = d; if (m >= 5) return 5; }
    return m;
}

// множество родни персоны key в радиусе radius — «ромб»: узел включён, если
// есть путь от key с ≤ radius шагами «вверх» (к родителям) И ≤ radius шагами
// «вниз» (к детям); пары родитель-ребёнок держатся вместе в пределах окна
// (сиблинги — u1d1, племянники — u1d2 с радиуса 2, троюродные — с 4).
// Супруги доклеиваются отдельно (focusWithSpouses). pairs — [[parent, child]].
// Each blood segment ascends first, then descends, never ascending again.
// Optional spousePairs starts a new segment after an explicit marriage.
function focusKeys(pairs, key, radius, spousePairs = []) {
    const kidsOf = new Map(), parentsOf = new Map();
    const spousesOf = new Map();
    for (const [a, b] of spousePairs) {
        if (!spousesOf.has(a)) spousesOf.set(a, []);
        if (!spousesOf.has(b)) spousesOf.set(b, []);
        spousesOf.get(a).push(b); spousesOf.get(b).push(a);
    }
    for (const [p, c] of pairs) {
        if (!kidsOf.has(p)) kidsOf.set(p, []);
        kidsOf.get(p).push(c);
        if (!parentsOf.has(c)) parentsOf.set(c, []);
        parentsOf.get(c).push(p);
    }
    // обход состояний (узел, вверх, вниз); на узле — недоминируемые вектора
    const best = new Map([[key, [[0, 0, 0]]]]);
    const dominated = (arr, u, d, s) => arr.some(v => v[0] <= u && v[1] <= d && v[2] <= s);
    const queue = [[key, 0, 0, 0]];
    while (queue.length) {
        const [k, u, d, s] = queue.pop();
        const step = (adj, nu, nd, ns = s) => {
            if (nu > radius || nd > radius) return;
            // Цепочный ромб: боковая родня (u,d ≥ 1) — по числу слов цепочки
            // (u+d−1 ≤ radius); 5-й радиус — обычный (слова ≤ 5),
            // «показать всех» снято (PDF был слишком велик и долог)
            if (nu && nd && nu + nd - 1 > radius) return;
            // PDF-only optional marriage traversal. Keep the cheap blood
            // lower bound; labels, not graph distances, decide membership.
            if (ns && nu + nd - (nu && nd ? 1 : 0) + ns > radius) return;
            for (const x of (adj.get(k) || [])) {
                let arr = best.get(x);
                if (!arr) best.set(x, arr = []);
                if (dominated(arr, nu, nd, ns)) continue;
                for (let i = arr.length - 1; i >= 0; i--)
                    if (nu <= arr[i][0] && nd <= arr[i][1] && ns <= arr[i][2]) arr.splice(i, 1);
                arr.push([nu, nd, ns]);
                queue.push([x, nu, nd, ns]);
            }
        };
        if (!d) step(parentsOf, u + 1, d);
        step(kidsOf, u, d + 1);
        // Each marriage starts a new blood segment. Each segment retains
        // u+d-1 (e.g. brother of a spouse of a brother costs 1+1+1).
        step(spousesOf, 0, 0, s + u + d - (u && d ? 1 : 0) + 1);
    }
    return [...best.keys()];
}

// уровневая достижимость «жизненного» радиуса: фазовый BFS —
// кровь (родитель↔ребёнок) 1, брак 1, полнокровные сиблинги 1 (см. ниже);
// полукровная родня сама выходит на 2 (вверх+вниз), сводные — на 3
// (вверх+брак+вниз). Супермножество ярлыков: каждое слово fynny-цепочки
// покрывает ≥1 ребро (сиблинговое слово — ровно ребро полнокровным).
// Возвращает Map ключ → дистанция (узлы дальше radius не включаются)
// В кровном сегменте подъём разрешён только до первого спуска/сиблинга;
// явный брак начинает новый сегмент. Общий ребёнок не заменяет брак.
function focusGraphDist(pairs, spousePairs, key, radius) {
    const parentsOf = new Map(), kidsOf = new Map(), spousesOf = new Map(), siblingsOf = new Map();
    const put = (map, a, b) => { if (!map.has(a)) map.set(a, []); map.get(a).push(b); };
    for (const [p, c] of pairs) {
        put(kidsOf, p, c); put(parentsOf, c, p);
    }
    for (const [a, b] of spousePairs) { put(spousesOf, a, b); put(spousesOf, b, a); }
    // сиблинговое ребро — только полнокровным: дети одной родительской пары
    // (полукровные без ребра идут вверх+вниз = 2, сводные — через брак = 3);
    // клика всех пар детей — дистанция сиблингов всегда 1, независимо от
    // порядка строк связей (SELECT по индексу отдаёт их по алфавиту,
    // ТГ-копия — по id; звезда от kids[0] давала дистанцию 2 «лишним»
    // сиблингам — ВК терял Феодору Алексеевну из радиуса 1 Петра I
    // на Romanov_family.ged)
    const groups = new Map(); // «родитель1|родитель2» → дети
    for (const [c, ps] of parentsOf) {
        if (ps.length === 2) {
            const g = ps.slice().sort().join("|");
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(c);
        }
    }
    for (const kids of groups.values())
        for (let i = 1; i < kids.length; i++)
            for (let j = 0; j < i; j++) {
                put(siblingsOf, kids[j], kids[i]); put(siblingsOf, kids[i], kids[j]);
            }
    const dist = new Map([[key, 0]]);
    // The same person reached during descent cannot veto an ascending state.
    const seen = [new Set([key]), new Set()];
    const queue = [[key, 0, 0]];
    for (let qi = 0; qi < queue.length; qi++) {
        const [k, d, down] = queue[qi];
        if (d >= radius) continue;
        const step = (map, phase) => {
            for (const x of map.get(k) || []) {
                if (seen[phase].has(x)) continue;
                seen[phase].add(x);
                if (!dist.has(x)) dist.set(x, d + 1);
                queue.push([x, d + 1, phase]);
            }
        };
        if (!down) {
            step(parentsOf, 0);
            step(siblingsOf, 1);
        }
        step(kidsOf, 1);
        step(spousesOf, 0);
    }
    return dist;
}

// ключи уровневого радиуса: дистанция ≤ radius (см. focusGraphDist)
function focusGraphKeys(pairs, spousePairs, key, radius) {
    return [...focusGraphDist(pairs, spousePairs, key, radius).keys()];
}

// входит ли событие-пара «Имя1+Имя2 ДАТА» в фокус: оба имени среди персон множества
function focusHasPair(name, keys) {
    if (!name.includes("+")) return false;
    const names = new Set(keys.map(k => k.slice(0, -11)));
    return name.split("+").every(n => names.has(n));
}

// дополнить множество супругами (для связности фрагмента): spousePairs —
// [[ключ, ключ], …] — пары семей с 2 родителями и свадеб «Имя+Имя»;
// супруг добавляется, только если его половина уже в множестве
function focusWithSpouses(keys, spousePairs) {
    const set = new Set(keys);
    for (const [a, b] of spousePairs) {
        if (set.has(a) && !set.has(b)) set.add(b);
        else if (set.has(b) && !set.has(a)) set.add(a);
    }
    return [...set];
}

// Ключи списка: граф даёт кандидатов, окончательный радиус всегда измеряется
// цепочкой реальных шагов, независимо от режима отображения fynny.
// core — уровневый BFS по объединённому графу
// при levels («жизненный» радиус: кровь 1, брак 1, полнокровный сиблинг 1;
// уровни = числам слов ярлыка: «отец жены» и «брат жены» — 2️⃣), либо
// кровный ромб для экспорта 🧬/PDF (оба режима обходят только кровь);
// далее супруги доклеиваются без продолжения в другие браки;
// каждый кандидат остаётся, только если его ярлык-цепочка влезает в радиус
// (супруг героя «муж/жена» — всегда; «жена брата» — с 2️⃣…);
// 5-й радиус — обычный, как остальные (слова ≤ 5; «показать всех» снято).
// Дословная копия — tgcloud/lib/bot.js.
function focusListKeys(pairs, spousePairs, key, radius, sexOf, levels) {
    const core = new Set(levels
        ? focusGraphKeys(pairs, [], key, radius)
        : focusKeys(pairs, key, radius));
    const keys = [...new Set([
        ...core,
        ...spousePairs.flatMap(([a, b]) => [
            ...(core.has(a) ? [b] : []), ...(core.has(b) ? [a] : []),
        ]),
    ])];
    // Все кандидаты, кроме героя: цепочка непуста и влезает в радиус.
    // бюджет браковых шагов kinLabel = radius (цепочки длиннее радиуса
    // всё равно отфильтруются); пустой ярлык — исключён (не «1 слово»)
    return keys.filter(s => s === key
        || (l => l && l.trim().split(/\s+/).length <= radius)(kinLabel(pairs, spousePairs, sexOf, key, s, radius, true)));
}

// список событий по множеству фокуса с ярлыками родства (kinLabel):
// «Имя Д [Д(смерти)] [ЧЧ:ММ] родство»; items — записи {n, d, h, m, dd};
// params — (items, keys, key, pairs, spousePairs, sexOf, byFullDate, mmddToday, depth);
// byFullDate=false — круговой порядок «от сегодня» (как religiousYear),
// true — все по полной дате ГГГГ-ММ-ДД (подтверждение удаления);
// depth — бюджет браковых шагов kinLabel (= радиус списка, дефолт 2)
function sortEvents(rows, byFullDate, mmddToday) {
    const fullKey = r => newStyleDate(r.d) + " " + (r.h !== undefined ? String(r.h).padStart(2, "0") + String(r.m ?? 0).padStart(2, "0") : "");
    const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const dayIdx = d => cum[Number(d.slice(5, 7)) - 1] + Number(d.slice(8)) - 1;
    const nowIdx = mmddToday ? cum[Number(mmddToday.slice(0, 2)) - 1] + Number(mmddToday.slice(3)) - 1 : 0;
    const key = byFullDate ? fullKey : r => String((dayIdx(newStyleDate(r.d)) - nowIdx + 365) % 365).padStart(3, "0") + " " + fullKey(r);
    return rows.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}

function focusListText(items, keys, key, pairs, spousePairs, sexOf, byFullDate = false, mmddToday = "", depth = 2, chain) {
    const set = new Set(keys);
    const map = rs => rs
        .map(r => r.n + " " + approxOut(newStyleDate(r.d), r.abt || r.mabt || 0)
            + (r.dd ? " " + approxOut(newStyleDate(r.dd), r.dabt || 0) : "")
            + (r.h !== undefined ? " " + String(r.h).padStart(2, "0") + ":" + String(r.m).padStart(2, "0") : "")
            + (() => { const l = kinLabel(pairs, spousePairs, sexOf, key, r.n + " " + r.d, depth, chain); return l ? " " + l : ""; })())
        .join("\n");
    return map(sortEvents(items.filter(r => set.has(r.n + " " + r.d)
        || (r.n.includes("+") && focusHasPair(r.n, keys))), byFullDate, mmddToday));
}

// список колокольчика «Имя ГГГГ-ММ-ДД[ ГГГГ-ММ-ДД смерти][ ЧЧ:ММ]»;
// "" — событий нет; rows — готовые записи персон и свадеб (выборка БД —
// в адаптерах ботов). byFullDate=false — круговой порядок «от сегодня»
// (как religiousYear): ММ-ДД сегодня первым, события прошлой части года —
// в конце; примерные даты (abt/dabt/mabt) — мимо оповещений;
// true — все события по полной дате ГГГГ-ММ-ДД (подтверждение удаления),
// примерные остаются. Текущая дата — явно (mmddNow «ММ-ДД»), без
// чтения времени внутри
function eventListText(rows, byFullDate = false, mmddNow = "") {
    const map = rs => rs
        .map(r => r.n + " " + approxOut(newStyleDate(r.d), r.abt || r.mabt || 0)
            + (r.dd !== undefined ? " " + approxOut(newStyleDate(r.dd), r.dabt || 0) : "")
            + (r.h !== undefined ? " " + String(r.h).padStart(2, "0") + ":" + String(r.m).padStart(2, "0") : ""))
        .join("\n");
    if (!byFullDate) rows = rows.filter(r => !r.abt && !r.dabt && !r.mabt); // примерные — мимо оповещений
    return map(sortEvents(rows, byFullDate, mmddNow));
}

// GEDCOM 5.5.1 по чату — выгрузка дерева: INDI из персон (плюс заглушки-
// супруги без даты — без BIRT), FAM из семей (усекаются до выбранных
// персон; каждая запись семьи сохраняется отдельно).
// keys — необязательный набор персон: фрагмент только по ним (для
// сообщений-связей)
// семьи в поколениях: семьи родителей раньше семей детей — канонический
// порядок строк семей в росписи (.ged.txt) и нумерации FAM в .ged независимо
// от порядка вставки: номер семьи детей бывает меньше номера семьи родителей
// (upload/GK.ged), и тогда визит-порядок корней в flatTreeText работает лишь
// как страховка. Связь: семья g, где половина f — ребёнок, идёт перед f;
// сторонние семьи и циклы — в прежнем порядке (стабильно).
function famsByGenerations(fams, halvesOf, kidsOf) {
    const parentFams = f => {
        const hs = halvesOf(f), out = [];
        for (const g of fams)
            if (g !== f && !out.includes(g) && kidsOf(g).some(c => hs.includes(c))) out.push(g);
        return out;
    };
    const done = new Set(), out = [];
    while (out.length < fams.length) {
        let step = false;
        for (const f of fams)
            if (!done.has(f) && parentFams(f).every(g => done.has(g))) {
                done.add(f); out.push(f); step = true;
            }
        if (!step) break;
    }
    for (const f of fams) if (!done.has(f)) out.push(f);
    return out;
}

// Resolve textual family aliases without ever claiming a different couple's row.
// Collisions use deterministic database xrefs, so the same input can be reapplied.
function familyXref(rows, mx, fx, alias, date, used) {
    const same = f => (f.husb ?? null) === mx && (f.wife ?? null) === fx;
    const safe = x => String(x).replace(/#/g, "№");
    if (alias) {
        const direct = rows.find(f => f.xref === alias) || rows.find(f => safe(f.xref) === alias);
        if (direct && same(direct) && !used.has(direct.xref)) return direct.xref;
        if (!direct) return alias;
        for (let n = 2; ; n++) {
            const x = alias + "_" + n, f = rows.find(f => safe(f.xref) === x);
            if (!f || (same(f) && (f.marrD ?? null) === (date ?? null) && !used.has(f.xref))) return f ? f.xref : x;
        }
    }
    const f = rows.find(f => same(f) && (f.marrD ?? null) === (date ?? null) && !used.has(f.xref));
    return f ? f.xref : null;
}

// ——— общий канон: экспорт (shorthand-идентификаторы под cjs-module-lexer)
module.exports = { familyXref, focusDepth, focusKeys, focusGraphDist, focusGraphKeys, focusHasPair, focusWithSpouses, focusListKeys, focusListText, eventListText, famsByGenerations };
