// tree.cjs — общий канон фокус-родни (чистая логика) для ВК и ТГ (план
// .kilo/plans/20261107-shared-modules-plan.md): ВК require-ит из lunarreturns.js, ТГ импортирует
// tgcloud/lib/bot.js → './tree.cjs'; правки — только здесь, копий больше нет.
const { fynny, kinLabel } = require('./kinship.cjs');

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
// Супруги доклеиваются отдельно (focusWithSpouses). pairs — [[parent, child]]
function focusKeys(pairs, key, radius) {
    const kidsOf = new Map(), parentsOf = new Map();
    for (const [p, c] of pairs) {
        if (!kidsOf.has(p)) kidsOf.set(p, []);
        kidsOf.get(p).push(c);
        if (!parentsOf.has(c)) parentsOf.set(c, []);
        parentsOf.get(c).push(p);
    }
    // обход состояний (узел, вверх, вниз); на узле — недоминируемые вектора
    const best = new Map([[key, [[0, 0]]]]);
    const dominated = (arr, u, d) => arr.some(s => s[0] <= u && s[1] <= d);
    const queue = [[key, 0, 0]];
    while (queue.length) {
        const [k, u, d] = queue.pop();
        const step = (adj, nu, nd) => {
            if (nu > radius || nd > radius) return;
            // fynny-ромб: боковая родня (u,d ≥ 1) — по числу слов цепочки
            // (u+d−1 ≤ radius); 5-й радиус — обычный (слова ≤ 5),
            // «показать всех» снято (PDF был слишком велик и долог)
            if (fynny && nu && nd && nu + nd - 1 > radius) return;
            for (const x of (adj.get(k) || [])) {
                let arr = best.get(x);
                if (!arr) best.set(x, arr = []);
                if (dominated(arr, nu, nd)) continue;
                for (let i = arr.length - 1; i >= 0; i--)
                    if (nu <= arr[i][0] && nd <= arr[i][1]) arr.splice(i, 1);
                arr.push([nu, nd]);
                queue.push([x, nu, nd]);
            }
        };
        step(parentsOf, u + 1, d);
        step(kidsOf, u, d + 1);
    }
    return [...best.keys()];
}

// уровневая достижимость «жизненного» радиуса: BFS по объединённому графу —
// кровь (родитель↔ребёнок) 1, брак 1, полнокровные сиблинги 1 (см. ниже);
// полукровная родня сама выходит на 2 (вверх+вниз), сводные — на 3
// (вверх+брак+вниз). Супермножество ярлыков: каждое слово fynny-цепочки
// покрывает ≥1 ребро (сиблинговое слово — ровно ребро полнокровным).
// Возвращает Map ключ → дистанция (узлы дальше radius не включаются)
function focusGraphDist(pairs, spousePairs, key, radius) {
    const adj = new Map();
    const put = (a, b) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push(b); };
    const parentsOf = new Map();
    for (const [p, c] of pairs) {
        put(p, c); put(c, p);
        if (!parentsOf.has(c)) parentsOf.set(c, []);
        parentsOf.get(c).push(p);
    }
    for (const [a, b] of spousePairs) { put(a, b); put(b, a); }
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
            for (let j = 0; j < i; j++) { put(kids[j], kids[i]); put(kids[i], kids[j]); }
    const dist = new Map([[key, 0]]);
    const queue = [key];
    for (let qi = 0; qi < queue.length; qi++) {
        const d = dist.get(queue[qi]);
        if (d >= radius) continue;
        for (const x of (adj.get(queue[qi]) || []))
            if (!dist.has(x)) { dist.set(x, d + 1); queue.push(x); }
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

// ключи 🔔-списка при fynny: core — уровневый BFS по объединённому графу
// при levels («жизненный» радиус: кровь 1, брак 1, полнокровный сиблинг 1;
// уровни = числам слов ярлыка: «отец жены» и «брат жены» — 2️⃣), либо
// кровный ромб без браков для экспорта 🧬/PDF; далее супруги доклеиваются;
// доклеенный супруг остаётся, только если его ярлык-цепочка влезает в радиус
// (супруг героя «муж/жена» — всегда; «жена брата» — с 2️⃣…);
// 5-й радиус — обычный, как остальные (слова ≤ 5; «показать всех» снято).
// Дословная копия — tgcloud/lib/bot.js.
function focusListKeys(pairs, spousePairs, key, radius, sexOf, levels) {
    const core = new Set(levels
        ? focusGraphKeys(pairs, spousePairs, key, radius)
        : focusKeys(pairs, key, radius));
    const keys = focusWithSpouses(core, spousePairs);
    if (!fynny) return keys;
    // доклеенный супруг остаётся, только если ярлык непуст и влезает:
    // бюджет браковых шагов kinLabel = radius (цепочки длиннее радиуса
    // всё равно отфильтруются); пустой ярлык — исключён (не «1 слово»)
    return keys.filter(s => core.has(s)
        || (l => l && l.split(" ").length <= radius)(kinLabel(pairs, spousePairs, sexOf, key, s, radius)));
}

// GEDCOM 5.5.1 по чату — выгрузка дерева: INDI из персон (плюс заглушки-
// супруги без даты — без BIRT), FAM из семей (усекаются до выбранных
// персон; группы с одинаковым набором родителей схлопываются — как прежде).
// keys — необязательный набор персон: фрагмент только по ним (для
// сообщений-связей)
// семьи в поколениях: семьи родителей раньше семей детей — канонический
// порядок строк семей в пачке (.ged.txt) и нумерации FAM в .ged независимо
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

// ——— общий канон: экспорт (shorthand-идентификаторы под cjs-module-lexer)
module.exports = { focusDepth, focusKeys, focusGraphDist, focusGraphKeys, focusHasPair, focusWithSpouses, focusListKeys, famsByGenerations };
