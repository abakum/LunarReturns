// flat.cjs — общий канон чистых функций родословной росписи -+= (волна A2, план
// .kilo/plans/20261108-canon-flat-pure-plan.md; волна A3 — поиск/обрезка,
// план .kilo/plans/20261108-canon-pure-a3-plan.md):
//   flatTreeText, subsetBranch — печать родословной росписи -+= / росписи ветви героя;
//   flatSearch, flatHitPerson, flatHitKey — поиск по росписи → фокус;
//   searchHead — заголовок выдачи поиска «Найдено N строк …»;
//   cutLines — обрезка текста целыми строками под бюджет сообщения;
//   datePlusYears — сдвиг даты на годы (фиктивные даты импорта);
//   treeReport, rootOf — отчёт о применении росписи, корень разобранной росписи.
//
// Оба бота исполняют один файл: ВК — reqLib("flat") в lunarreturns.js,
// ТГ — import из bot.js (`import { … } from './flat.cjs'`, по образцу
// tree.cjs; handlers берут имена реэкспортом из bot.js). Тела дословные —
// были дословными копиями в lunarreturns.js и tgcloud/lib/bot.js
// (проверка: node scripts/diff-fn.mjs).
// Экспорт shorthand-объектом — cjs-module-lexer (ESM-шим/reqLib).

const { approxOut } = require('./text.cjs');
const { focusListKeys } = require('./tree.cjs');

// ключ персоны «Имя Д» — дословно как в копиях (lunarreturns.js, bot.js:
// там DB-тиры держат собственный; здесь у flatHitKey своя, дословная)
const pkey = r => r.n + " " + r.d;

// сдвиг даты «ГГГГ-ММ-ДД» на годы (UTC — без съезда на календарные ловушки)
function datePlusYears(d, years) {
    const dt = new Date(d + "T00:00:00Z");
    dt.setUTCFullYear(dt.getUTCFullYear() + years);
    return dt.toISOString().slice(0, 10);
}

function rootOf(tree) {
    for (let i = 0; i < tree.persons.length; i++) {
        if (tree.persons[i].spouseLine) continue;
        if (tree.children.some(ch => ch.c === i)) continue;
        return tree.persons[i];
    }
    return null;
}

// отчёт по применению росписи (applyTree/cutAndGraft): «древо: персон …»,
// маркер росписи радиуса → отказ, дубли и ошибки построчно
function treeReport(rep) {
    if (rep.noGraft) // роспись радиуса в ответ на триггер — правки нет
        return "💥 Для замены ветки используйте плоское дерево полученное нажатием на кнопку -+=";
    let body = "✅ древо: персон " + rep.persons + ", семей " + rep.fams
        + ", детей " + rep.links;
    if (rep.cut !== undefined)
        body = (rep.cut ? "✂️ ветвь срезана: " + rep.cut + " персон, " + rep.famsCut + " семей\n" : "✂️ ветвь обновлена\n")
            + body;
    if (rep.dups && rep.dups.length)
        body += "\n" + rep.dups.map(d => "♻️ дубль: " + d.from + " → " + d.to).join("\n");
    if (rep.errors.length)
        body += "\n" + rep.errors.map(e => "💥 стр " + e.line + ": " + e.msg).join("\n");
    return body;
}

// чистые подмножества росписи ветви героя: fams, где герой/потомок является
// половиной (его браки, рекурсивно до листьев); вторые половины включаются в
// печать, но ветвь НЕ продолжают — другие семьи супруга в ветвь не годятся;
// extraKids — интерактивные связи (edges, «родитель→ребёнок»): потомки
// героя/потомка/половин по связям тоже в ветви
function subsetBranch(persons, fams, x, extraKids = null) {
    const D = new Set([x]); // потомки (ветвь, расширение)
    const inF = new Set();  // индексы включённых fams
    let frontier = [x];
    const byKey = new Map(persons.map(p => [p.key, p]));
    while (frontier.length) {
        const nf = [];
        for (let i = 0; i < fams.length; i++) {
            if (inF.has(i)) continue;
            const f = fams[i];
            const halves = [f.hKey, f.wKey].filter(k => k != null);
            if (!halves.some(h => D.has(h))) {
                // свадьба-заглушка пары ветви («Имя1+Имя2 Д»): половины —
                // именные заглушки с именами ветви — свадьба тоже ветви
                if (halves.length === 2) {
                    const a = byKey.get(halves[0]), b = byKey.get(halves[1]);
                    const namesD = new Set([...D].map(c => (byKey.get(c) || {}).name));
                    if (a && b && a.nameOnly && b.nameOnly
                        && namesD.has(a.name) && namesD.has(b.name)) inF.add(i);
                }
                continue;
            }
            inF.add(i);
            for (const c of f.children) if (!D.has(c)) { D.add(c); nf.push(c); }
        }
        for (const k of frontier)
            for (const c of (extraKids ? extraKids.get(k) || [] : []))
                if (!D.has(c)) { D.add(c); nf.push(c); }
        frontier = nf;
    }
    const P = new Set(D); // печать: потомки + половины их семей
    for (const i of inF)
        for (const h of [fams[i].hKey, fams[i].wKey]) if (h != null) P.add(h);
    return [persons.filter(p => P.has(p.key)), fams.filter((_, i) => inF.has(i))];
}

// fam в виде полу: hName/wName — имена заглушки ...
// fams of slot; чистая логика — дословно в обеих копиях.
// canonical (рецепт порядка, только полная роспись): семьи — по дате свадьбы,
// без даты — по дате рождения старшего супруга; дети в семье — по возрасту;
// браки одной персоны — по тому же ключу; корни-владельцы семей — в порядке
// их семей; плавающие и остаток — по возрасту. Росписи радиуса и ветви героя
// (герой первой строкой) — как прежде
function flatTreeText(persons, fams, canonical = false) {
    const byKey = new Map(persons.map(p => [p.key, p]));
    const pairOf = f => f.hKey != null && f.wKey != null ? JSON.stringify([f.hKey, f.wKey].sort()) : null;
    const counts = new Map();
    for (const f of fams) if (pairOf(f)) counts.set(pairOf(f), (counts.get(pairOf(f)) || 0) + 1);
    const familyOf = new Map(); // ребёнок (xref) → его семья (первая по порядку)
    for (const f of fams) for (const c of f.children) if (!familyOf.has(c)) familyOf.set(c, f);
    const depth = new Map();
    const depthOf = k => {
        if (depth.has(k)) return depth.get(k);
        depth.set(k, 0); // циклы — консервативный ноль
        const f = familyOf.get(k);
        let d = 0;
        if (f) for (const p of [f.hKey, f.wKey])
            if (p != null && p !== k && byKey.has(p)) d = Math.max(d, depthOf(p) + 1);
        depth.set(k, d);
        return d;
    };
    const pad = v => String(v).padStart(2, "0");
    // note выводится с маркером «^»: при обратном разборе всё после первого
    // «^» — примечание дословно (дата в его начале — не дата смерти).
    // Место — в скобках за своей датой (рождения/смерти): грамматика росписи
    // трактует время как местное в месте, поэтому с местом выводится
    // исходное время (если было), без места — московское, как прежде
    // примерная дата — гранулярно с суффиксом квалификатора (approxOut):
    // «1234», «1234-05», «1234-05-06~»/«1234-05?»/«1234=»…
    const dOut = approxOut;
    const tail = r => [
        r.d !== undefined ? dOut(r.d, r.abt) : undefined,
        r.plac
            ? (r.srcH !== undefined && r.srcH !== null ? pad(r.srcH) + ":" + pad(r.srcM ?? 0) : null)
            : (r.h !== undefined && r.h !== null ? pad(r.h) + ":" + pad(r.m ?? 0) : null),
        r.plac ? "(" + r.plac + ")" : null,
        r.dd !== undefined ? dOut(r.dd, r.dabt) : undefined, r.dp ? "(" + r.dp + ")" : null,
        r.note ? "^" + r.note : null,
    ].filter(Boolean).join(" ");
    const out = [], printed = new Set(), famsDone = new Set();
    // канонические ключи (canonical — рецепт): семья — дата свадьбы, без
    // неё — дата рождения старшего супруга (раньше старше); без дат — в
    // конец, стабильно. Порядок перестаёт зависеть от порядка вставки:
    // экспорт сходится с импортом и дифы пустеют
    const birthOf = k => { const r = byKey.get(k); return r && r.d ? r.d : null; };
    const famKey = f => {
        if (f.marr) return f.marr.d;
        const ds = [f.hKey, f.wKey].filter(k => k != null).map(birthOf).filter(Boolean).sort();
        return ds.length ? ds[0] : null;
    };
    const byDate = (a, b) => a === null && b === null ? 0
        : a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0;
    const famCmp = (a, b) => byDate(famKey(a), famKey(b));
    const personCmp = (a, b) => byDate(a.d ?? null, b.d ?? null);
    const minFamKey = r => {
        const ks = fams.filter(f => f.hKey === r.key || f.wKey === r.key)
            .map(famKey).filter(k => k !== null).sort();
        return ks.length ? ks[0] : (r.d ?? null);
    };
    const halfOf = r => fams.some(f => f.hKey === r.key || f.wKey === r.key);
    // строка персоны: bare — вторая половина «+»-свадьбы (без маркера), иначе
    // маркеры '-'×(d+1)/'='×(d+1); заглушки — только имя
    const lineOf = (r, male, d, bare) => {
        const m = bare ? "" : (male ? "-" : "=").repeat(d + 1);
        out.push(m + r.name
            + (r.nameOnly ? (r.note ? " ^" + r.note : "")
                : (r.d != null || r.dd != null || r.note ? " " + tail(r) : "")));
        if (typeof r.key === "string") printed.add(r.key);
    };
    // Места сразу за своими датами; начальный пробел оставляет свадьбу неизвестной.
    // (примечание — с маркером «^», как у персон)
    const wedPlus = f => {
        const bits = [f.marr ? dOut(f.marr.d, f.marr.abt) : ""];
        if (f.marr?.plac) bits.push("(" + f.marr.plac + ")");
        if (f.div) bits.push(dOut(f.div.d, f.div.abt));
        if (f.div?.plac) bits.push("(" + f.div.plac + ")");
        if (f.xref && counts.get(pairOf(f)) > 1) bits.push("~" + String(f.xref).replace(/#/g, "№"));
        if (f.note) bits.push("^" + f.note);
        return bits.join(" ");
    };
    // тело семьи на глубине d: свадьба «+»×(d+1) и вторая половина (строка
    // ниже, без маркера пола; уже напечатанная — именной заглушкой); дети
    // на глубине d+1
    const famBody = (f, ownerKey, d) => {
        if (famsDone.has(f)) return;
        famsDone.add(f);
        const maleOwner = f.hKey === ownerKey;
        const other = maleOwner
            ? (f.wKey != null ? byKey.get(f.wKey) : f.wName != null ? { name: f.wName, nameOnly: true } : null)
            : (f.hKey != null ? byKey.get(f.hKey) : f.hName != null ? { name: f.hName, nameOnly: true } : null);
        if (other) {
            out.push("+".repeat(d + 1) + wedPlus(f));
            // «другая половина» — ребёнок включённого семейства? Печатаем её
            // полную строку (с событием) под свадьбой, но НЕ закрываем её
            // от печати: строку с маркером позже выдаст родительская ветвь,
            // а при импорте одинаковые «Имя Д» схлопнутся в одну персону —
            // иначе связь с родителями потеряется. Половин её родительской
            // семьи в росписи нет (семья вне радиуса/ветви, вошла касанием
            // ребёнка) — закрываем сразу: открытой строке маркерную выдал
            // бы остаточный визит на нуле, роспись несла бы хвостовой дубль
            // и переставала быть идемпотентной
            const kfam = other.key != null ? familyOf.get(other.key) : null;
            const kid = other.key != null && !printed.has(other.key) && kfam
                && [kfam.hKey, kfam.wKey].some(k => k != null && byKey.has(k));
            if (kid) lineOf(other, other.sex !== "F", d, true);
            else if (other.key != null && printed.has(other.key))
                lineOf({ name: other.name, nameOnly: true }, other.sex !== "F", d, true);
            else lineOf(other, other.sex !== "F", d, true);
            if (kid) printed.delete(other.key); // маркерная строка — от родителей
        } else if (f.marr || f.div || f.note) {
            // семья без второй половины: односторонняя свадьба («+дата»)
            out.push("+".repeat(d + 1) + wedPlus(f));
        } else {
            // Граница односторонней семьи нужна и при наличии детей.
            out.push("+".repeat(d + 1));
        }
        // дети по возрасту (canonical): старшие раньше, без даты — в конце
        const kids = f.children.map(ck => byKey.get(ck)).filter(Boolean);
        if (canonical) kids.sort(personCmp);
        for (const rk of kids) visit(rk, d + 1);
    };
    const visit = (r, d) => {
        if (printed.has(r.key)) return;
        printed.add(r.key);
        lineOf(r, r.sex !== "F", d, false);
        // бездатные односторонние семьи (дети от неизвестного супруга) —
        // первыми, сразу после строки персоны: при пересборке росписи их дети
        // привязываются к собственной семье персоны, а не к паре ниже
        const hasOther = f => {
            const k = f.hKey === r.key, x = k ? f.wKey : f.hKey;
            return x != null ? byKey.has(x) : (k ? f.wName : f.hName) != null;
        };
        const mine = fams.filter(f => f.hKey === r.key || f.wKey === r.key);
        const solo = mine.filter(f => !hasOther(f) && !f.marr);
        const wed = mine.filter(f => hasOther(f) || f.marr);
        if (canonical) wed.sort(famCmp); // браки — по дате свадьбы/старшему супругу
        for (const f of [...solo, ...wed])
            famBody(f, r.key, d);
    };
    // дети не выпадают из семьи: сначала визит корней — персон, чья
    // родительская семья не в росписи или вошла без половин (familyOf,
    // касанием ребёнка, половины за радиусом/ветвью); в canonical —
    // по рецепту (семья/возраст, см. выше), иначе в порядке массива;
    // famBody родителей выдаёт строки детей с маркерами глубины. Ребёнок,
    // вставленный раньше родителей (номер семьи детей меньше номера семьи
    // родителей), корнем не считается: раньше он печатался на нуле и
    // терял связь с семьёй при обратном импорте росписи. Условие зеркалит
    // kid в famBody: открытая строка — только при половинах в росписи.
    // Остаток — циклы, оторванные узлы — как прежде, на нуле.
    const isRoot = r => {
        const f = familyOf.get(r.key);
        return !f || ![f.hKey, f.wKey].some(k => k != null && byKey.has(k));
    };
    if (canonical) {
        // рецепт: корни-владельцы семей — в порядке их семей (дата
        // свадьбы, без неё — старший супруг); плавающие (без своих
        // семей) — после семей, по возрасту; остаток (циклы, оторванные
        // узлы) — тоже по возрасту
        const roots = persons.filter(r => isRoot(r));
        for (const r of roots.filter(halfOf).sort((a, b) => byDate(minFamKey(a), minFamKey(b))
            || byDate(a.d ?? null, b.d ?? null) // ничья — старший супруг первым (как в PDF)
            || (a.name < b.name ? -1 : 1)))
            visit(r, 0);
        for (const r of roots.filter(r => !halfOf(r)).sort(personCmp)) visit(r, 0);
        const rest = persons.filter(r => !printed.has(r.key));
        rest.sort(personCmp);
        for (const r of rest) visit(r, 0);
    } else {
        for (const r of persons) if (isRoot(r)) visit(r, 0);
        for (const r of persons) visit(r, 0);
    }
    return out.join("\n");
}

// поиск по родословной росписи -+= (chatFlatText): "/Иван" — префикс от начала
// строки (ведущие маркеры '-'/'='/'+' строк сняты); "/-Пётр" — только мужчины
// глубины 0, "/--Иван" — глубины 1, "/=…" — женщины (серия маркеров запроса
// должна совпасть с серией строки); "/ текст" — подстрока в строке без
// маркера; "/-", "/==", "/++" — все строки с такой серией маркеров (все
// мужчины/женщины/свадьбы уровня). Регистр не учитывается
function flatSearch(flat, query) {
    const q = String(query).replace(/^\//, "");
    const sub = q.startsWith(" ");
    const mark = (q.match(/^([-+=])\1*/) || [""])[0];
    const needle = (sub ? q.slice(1) : q.slice(mark.length)).trim().toLowerCase();
    if (!needle && !mark) return [];
    const hits = String(flat).split(/\r?\n/).filter(line => {
        const lmark = (line.match(/^([-+=])\1*/) || [""])[0];
        const body = line.slice(lmark.length).toLowerCase();
        if (mark) return lmark === mark && (!needle || body.startsWith(needle));
        return sub ? body.includes(needle) : body.startsWith(needle);
    });
    if (sub || mark) return hits;
    // Префиксный поиск: одна персона теперь рисуется дважды — под свадьбой
    // (без маркера) и строкой с маркером у родителей. Показываем только
    // строку с маркером; bare-строку — лишь если с маркером не нашлось
    return hits.filter(line => {
        const lm = (line.match(/^([-+=])\1*/) || [""])[0];
        if (lm) return true;
        const body = line.toLowerCase();
        return !hits.some(h => {
            const m2 = (h.match(/^([-+=])\1*/) || [""])[0];
            return m2 && h.slice(m2.length).toLowerCase() === body;
        });
    });
}

// Full-chat snapshot; chart keys (especially anchored stubs) are not identities.
// Textual edge endpoints are usable only when they resolve unambiguously.
function createFlatAnnotationText([persons, fams], linkPairs, focusSpousePairs) {
    const byXref = new Map(persons.map(p => [p.key, p]));
    const xOf = new Map();
    for (const p of persons) {
        if (p.d == null) continue;
        const k = p.name + " " + p.d;
        xOf.set(k, xOf.has(k) ? null : p.key);
    }
    const pairs = [], spouses = [], seenPairs = new Set(), seenSpouses = new Set();
    const put = (out, seen, a, b, undirected = false) => {
        if (a == null || b == null || !byXref.has(a) || !byXref.has(b)) return;
        const k = JSON.stringify(undirected ? [a, b].sort() : [a, b]);
        if (!seen.has(k)) { seen.add(k); out.push([a, b]); }
    };
    for (const f of fams) {
        put(spouses, seenSpouses, f.hKey, f.wKey, true);
        for (const c of f.children)
            for (const p of [f.hKey, f.wKey]) put(pairs, seenPairs, p, c);
    }
    for (const [p, c] of linkPairs) put(pairs, seenPairs, xOf.get(p), xOf.get(c));
    for (const [a, b] of focusSpousePairs) put(spouses, seenSpouses, xOf.get(a), xOf.get(b), true);
    return function annotationText(row) {
        if (!byXref.has(row.xref)) return "";
        const keys = new Set(focusListKeys(pairs, spouses, row.xref, 1,
            k => byXref.get(k)?.sex ?? null, false));
        return flatTreeText(persons.filter(p => keys.has(p.key)), fams.filter(f =>
            [f.hKey, f.wKey, ...f.children].some(k => k != null && keys.has(k))), true);
    };
}

// строку-попадание поиска «/Имя» в персону {n, d}: маркеры сняты, хвост
// (даты/время, место «(…)», примечание «^…») отрезается — имя до первого
// такого токена; строка свадьбы («+…» или начинающаяся с даты/места)
// и пустые — null. Чистая логика — дословно в обеих копиях (dev/sync-check.mjs)
function flatHitPerson(line) {
    const l = String(line).trim();
    if (!l) return null;
    const m = (l.match(/^([-+=])\1*/) || [""])[0];
    if (m[0] && m[0].includes("+")) return null;        // строка свадьбы
    const toks = l.slice(m.length).trim().split(/\s+/);
    let i = 0;
    while (i < toks.length && !/^[\d(^]/.test(toks[i])) i++;
    if (i === 0) return null;                           // тело с даты/места
    return { n: toks.slice(0, i).join(" "),
        d: i < toks.length && /^\d/.test(toks[i]) ? toks[i] : null };
}

// ключ персоны (persons = personRows копий — {n, d, abt, …}) по
// строке-попаданию —
// для фокус-панели вместо списка; имя разыскивается дословно, дата — через
// approxOut (приблизительнные и урезанные даты совпадают по печати);
// не резолвится (не персона, имя не найдено, дата не совпала, тёзка без
// даты в строке) — null. Чистая логика — дословно в обеих копиях
function flatHitKey(line, persons) {
    const hit = flatHitPerson(line);
    if (!hit) return null;
    const same = persons.filter(r => r.n === hit.n);
    if (!same.length) return null;
    if (hit.d === null) return same.length === 1 ? pkey(same[0]) : null;
    const byD = same.find(r => approxOut(r.d, r.abt) === hit.d);
    return byD ? pkey(byD) : null;
}

// заголовок выдачи поиска: «Найдено N строк …» — по запросу и числу
// найденных строк. «/Ива» — «начинающихся с Ива», «/ Ива» — «с подстрокой
// Ива», серия маркеров («/-», «/--», «/=», «/++») — «с маркером «…»».
// Дословно из копий (lunarreturns.js, handlers/message.js; ethalon — ВК)
function searchHead(q, count) {
    const sub = /^\/\s/.test(q);
    const mark = (q.slice(1).match(/^([-+=])\1*/) || [""])[0];
    const needle = (sub ? q.slice(1) : q.slice(1 + mark.length)).trim();
    return "Найдено " + count + " строк "
        + (needle ? (sub ? "с подстрокой " : "начинающихся с ") + needle
                  : "с маркером «" + mark + "»");
}

// обрезка целыми строками: строки text накапливаются, пока
// reserved + накопленное + соединитель + длина строки не превышает budget.
// joinReserve (по умолчанию) — консервативный запас ВК: «+1» под соединитель
// строк считается и перед первой строкой накопления (переливы поиска/росписи,
// списки событий без заголовка). joinReserve=false — бюджет «заголовок +
// хвост» (reserved уже несёт соединитель заголовка; межстрочных «+1» в
// бюджете нет — как в ВК у хвоста после заголовка). Сборка держателя/финала
// и суффиксы (✂️, ⏳) — снаружи, у вызывающих мест (бюджеты дословно ВК):
//   переливы росписи: reserved = head.length + 1 + NOT_FOR_GRAFT.length + 1
//   перелив поиска: reserved = NOT_FOR_GRAFT.length + 1
//   список событий: reserved = 0;  хвост после заголовка: head.length + 1, false
function cutLines(text, budget, reserved = 0, joinReserve = true) {
    let acc = "";
    for (const l of String(text).split("\n")) {
        if (reserved + acc.length + (joinReserve ? 1 : 0) + l.length > budget) break;
        acc += (acc ? "\n" : "") + l;
    }
    return acc;
}

module.exports = { flatTreeText, subsetBranch, flatSearch, flatHitPerson, flatHitKey, searchHead, cutLines, datePlusYears, treeReport, rootOf, createFlatAnnotationText };
