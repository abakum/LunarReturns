// kinship.js — ярлыки родства «кто цитируемому кто»: мать, сын, внучка,
// двоюродный брат, жена внука, муж дочки… Чистая функция без зависимостей;
// дословная копия живёт в lunarreturns.js (ВК) — менять в обоих местах
// (проверка синхронности — dev/sync-check.mjs, раздел kinLabel).
//
// pairs — [[родитель, ребёнок], …]; spousePairs — [[ключ, ключ], …];
// sexOf(key) → 'M' | 'F' | null. Возвращает ярлык или «» (без ярлыка —
// родство не прослеживается по крови/браку либо вне таблицы степеней).

export function kinLabel(pairs, spousePairs, sexOf, from, to) {
    if (from === to) return "";
    const blood = kinBlood(pairs, sexOf, from, to);
    if (blood) return blood;
    // кровь не прослеживается — супруги: «муж/жена + родство партнёра»
    // (жена внука, муж дочки…); у супруга цитируемого партнёр = from →
    // просто «муж»/«жена»; партнёр вне родни — без ярлыка
    for (const [x, y] of spousePairs || []) {
        const partner = x === to ? y : y === to ? x : null;
        if (partner === null) continue; // to — не супруг ни одной из пар
        if ((x === from && y === to) || (y === from && x === to)) {
            const s = sexOf ? sexOf(to) : null;
            return s === "M" ? "муж" : s === "F" ? "жена" : "супруг";
        }
        // родство партнёра — только по крови (без цепочек супругов,
        // иначе «муж жены мужа…» зациклится)
        const l = kinBlood(pairs, sexOf, from, partner);
        if (l) {
            const s = sexOf ? sexOf(to) : null;
            const who = s === "M" ? "муж" : s === "F" ? "жена" : "супруг";
            return who + " " + genLabel(l);
        }
    }
    return "";
}

// кровное родство (без супруговых переходов): ближайший общий предок (a↑b↓),
// a⊕b — прямая линия, a=b=… — боковые степени; вне таблицы — «»
function kinBlood(pairs, sexOf, from, to) {
    const kidsOf = new Map(), parentsOf = new Map();
    for (const [p, c] of pairs) {
        if (!kidsOf.has(p)) kidsOf.set(p, []);
        kidsOf.get(p).push(c);
        if (!parentsOf.has(c)) parentsOf.set(c, []);
        parentsOf.get(c).push(p);
    }
    // обход вширь: Map key → глубина (0 = сам start)
    const walk = adj => {
        return start => {
            const m = new Map([[start, 0]]);
            let frontier = [start];
            for (let d = 1; ; d++) {
                const next = [];
                for (const k of frontier) for (const x of (adj.get(k) || []))
                    if (!m.has(x)) { m.set(x, d); next.push(x); }
                if (!next.length) break;
                frontier = next;
            }
            return m;
        };
    };
    const up = walk(parentsOf);
    // слова женского рода (для согласования прилагательных) кончаются на «а»
    const fem = w => /а$/.test(w);
    // ярлык прямой линии (up: other — предок from; down: потомок); d ≥ 1
    const line = (isUp, d, sex) => {
        const f = sex === "F", u = sex !== "M" && sex !== "F";
        if (d === 1) return isUp ? (u ? "родитель" : f ? "мать" : "отец")
            : (u ? "ребёнок" : f ? "дочь" : "сын");
        if (d === 2) return isUp ? (u ? "прародитель" : f ? "бабушка" : "дедушка")
            : (f ? "внучка" : "внук");
        return "пра".repeat(d - 2) + (isUp ? (f ? "бабушка" : "дед") : (f ? "правнучка" : "правнук"));
    };
    // словесная степень родства: 1 двоюродный, 2 троюродный, 3 четвероюродный
    const degree = w => w === 1 ? "двоюродный" : w === 2 ? "троюродный" : w === 3 ? "четвероюродный" : null;
    // боковые линии: a — вверх до общего предка, b — вниз к other
    const side = (a, b, sex) => {
        if (b === 0) return line(true, a, sex);  // other — прямой предок
        if (a === 0) return line(false, b, sex); // прямой потомок
        const f = sex === "F", u = sex !== "M" && sex !== "F";
        const sib = u ? "сиблинг" : f ? "сестра" : "брат";
        const niece = u ? "племянник" : f ? "племянница" : "племянник";
        if (a === b) { // a=b=1 сиблинги, далее двоюродные/троюродные…
            const w = a - 1;
            return w < 1 ? sib : (degree(w) ? (fem(sib) ? degree(w).replace(/ый$/, "ая") : degree(w)) + " " + sib : "");
        }
        if (a > b && b === 1) { // брат/сестра предка: дядя, двоюродный дед…
            if (a === 2) return u ? "дядя" : f ? "тётя" : "дядя";
            const noun = line(true, a, sex);
            return (fem(noun) ? "двоюродная" : "двоюродный") + " " + noun; // двоюродный прадед…
        }
        if (b > a && a === 1) { // потомки сиблинга: племянник, внучатый…
            if (b === 2) return niece;
            if (b === 3) return (fem(niece) ? "внучатая" : "внучатый") + " " + niece;
            return "";
        }
        if (a === 3 && b === 2) return u ? "двоюродный дядя" : f ? "двоюродная тётя" : "двоюродный дядя";
        if (a === 2 && b === 3) return (fem(niece) ? "двоюродная" : "двоюродный") + " " + niece; // сын двоюродного брата
        return ""; // глубже таблицы — без ярлыка
    };
    const self = up(from);               // предки цитируемого
    const other = up(to);                // предки другого (могут включать from)
    let best = null, idx = 0;
    for (const [k, a] of self) {
        const b = other.get(k);
        if (b === undefined) continue;
        const i = idx++;
        if (!best || a + b < best[0] + best[1] || (a + b === best[0] + best[1] && a < best[0]))
            best = [a, b, i];
    }
    if (best) return side(best[0], best[1], sexOf ? sexOf(to) : null);
    return "";
}

// родительный падеж ярлыка: «сын» → «сына», «двоюродный брат» → «двоюродного
// брата», «прапрабабушка» → «прапрабабушки» (для «жена сына», «муж двоюродного
// брата» и т.п.); незнакомые слова остаются как есть
function genLabel(label) {
    const GEN = {
        мать: "матери", отец: "отца", сын: "сына", дочь: "дочери",
        брат: "брата", сестра: "сестры", родитель: "родителя",
        ребёнок: "ребёнка", сиблинг: "сиблинга", прародитель: "прародителя",
        дедушка: "дедушки", бабушка: "бабушки", дед: "деда",
        внук: "внука", внучка: "внучки", правнук: "правнука", правнучка: "правнучки",
        дочь: "дочки", дядя: "дяди", тётя: "тёти", племянник: "племянника",
        племянница: "племянницы",
    };
    const fold = w => {
        if (GEN[w]) return GEN[w];
        if (/^(двоюродный|троюродный|четвероюродный|внучатый)$/.test(w)) return w.slice(0, -2) + "ого";
        if (/^(двоюродная|троюродная|четвероюродная|внучатая)$/.test(w)) return w.slice(0, -2) + "ой";
        if (/правнучка$/.test(w)) return w.replace(/правнучка$/, "правнучки");
        if (/правнук$/.test(w)) return w.replace(/правнук$/, "правнука");
        if (/бабушка$/.test(w)) return w.replace(/бабушка$/, "бабушки");
        if (/дед$/.test(w)) return w.replace(/дед$/, "деда");
        return w;
    };
    return label.split(" ").map(fold).join(" ");
}
