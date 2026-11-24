'use strict';
const reqLib = name => require('../../tgcloud/lib/' + name + '.cjs');
const { famsByGenerations } = reqLib('tree');
const { gedNoteLines, NOT_FOR_GRAFT } = reqLib('parse');
const { localRecord } = reqLib('event-time');
const { flatTreeText, subsetBranch } = reqLib('flat');
const { checkChartLimit, chartDiagnostics, chartRows, chartModel, chartFont, chartPdf } = reqLib('chart');
const { createPdfAnnotationText, pdfPersonMetadata } = reqLib('annotations');
const pkey = r => r.n + ' ' + r.d;
const ckey = k => k;
const personFromRow = r => {
        const o = { n: r.name, d: r.birt_d };
        if (r.birt_abt) o.abt = r.birt_abt;
        if (r.deat_abt) o.dabt = r.deat_abt;
        if (r.birt_h !== null) { o.h = r.birt_h; o.m = r.birt_m ?? 0; }
        if (r.src_h !== null) { o.srcH = r.src_h; o.srcM = r.src_m ?? 0; }
        if (r.sex) o.sex = r.sex;
        if (r.deat_d) {
            o.dd = r.deat_d;
            if (r.deat_h !== null) { o.dh = r.deat_h; o.dm = r.deat_m ?? 0; }
            if (r.dsrc_h !== null) { o.dsrcH = r.dsrc_h; o.dsrcM = r.dsrc_m ?? 0; }
            if (r.deat_plac) o.dp = r.deat_plac;
        }
        if (r.plac) o.plac = r.plac;
        if (r.note) o.note = r.note;
        o.xref = r.xref;
        return o;
    };

function createExportData({ people, families, children, pairs, settings }) {
    const byId = new Map(people.map(row => [row.xref, row]));
    const byFamily = new Map();
    for (const row of children) {
        if (!byFamily.has(row.fam)) byFamily.set(row.fam, []);
        byFamily.get(row.fam).push(row);
    }
    const indiOf = x => byId.get(x);
    const childrenOf = x => byFamily.get(x) || [];
    const keyOfXref = x => {
        const r = indiOf(x);
        return r?.birt_d ? r.name + ' ' + r.birt_d : null;
    };
    let persons, views, spouses;
    const personsOf = () => persons ??= people.filter(r => r.birt_d != null).map(personFromRow);
    const familyViews = () => views ??= families.map(familyView);
    const spousesOf = () => spouses ??= familyViews().filter(f => f.parents.length === 2).map(f => f.parents);
    const pairsOf = () => pairs;
    function familyView(f) {
        return {
            xref: f.xref, adhoc: !!f.adhoc,
            parents: [f.husb, f.wife].filter(Boolean).map(x => keyOfXref(x)).filter(Boolean),
            children: childrenOf(f.xref)
                .map(r => keyOfXref(r.indi)).filter(Boolean),
            marr: f.marr_d ? { d: f.marr_d, ...(f.marr_abt ? { abt: f.marr_abt } : {}), ...(f.marr_plac ? { plac: f.marr_plac } : {}) } : null,
            div: f.div_d ? { d: f.div_d, ...(f.div_abt ? { abt: f.div_abt } : {}), ...(f.div_plac ? { plac: f.div_plac } : {}) } : null,
        };
    }

    function gedcomText(keys) {
        const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
        const gdate = d => { const [y, mo, dd] = d.split("-").map(Number); return dd + " " + MON[mo - 1] + " " + y; };
        // хвост-метка заглушки «Имя ~xref» живёт в БД для уникальности ключей
        // печатей (росписи/древо), но в гедкоме избыточен — xref и так в
        // идентикаторе INDI @…@; в NAME метку снимаем (реимпорт восстановит её
        // из файлового xref — круглый trip остаётся идемпотентным)
        const cleanName = n => n.replace(/ ~\S+$/, "");
        const hasKeys = Array.isArray(keys) && keys.length > 0;
        const persons = personsOf().filter(r => !hasKeys || keys.includes(pkey(r))).map(localRecord);
        const idOf = new Map(persons.map(r => [r.xref, r.xref]));
        // усыновления: xref ребёнка → xref семьи (chil.adopted)
        const adoptedOf = new Map();
        for (const c of children.filter(c => c.adopted === 1))
            adoptedOf.set(c.indi, c.fam);
        // примерная дата в гедком: гранулярность — форма даты (год-only «ГГГГ»,
        // месяц-only «JUN 1987», полный день «6 MAY 1234»), квалификатор —
        // префикс на любой гранулярности («ABT MAY 1985», «EST 1985»)
        const ABT_TAG = { 1: "ABT", 2: "CAL", 3: "BEF", 4: "AFT", 5: "EST" };
        const gdateAbt = (d, abt) => {
            const a = abt || 0, q = Math.floor(a / 3), g = a % 3;
            const s = g === 2 ? d.slice(0, 4)
                : g === 1 ? MON[Number(d.slice(5, 7)) - 1] + " " + d.slice(0, 4)
                : gdate(d);
            return (ABT_TAG[q] ? ABT_TAG[q] + " " : "") + s;
        };
        // семьи → {xref, par — [{x, k}] датированные половины (k — ключ, только
        // для фильтра фрагмента), stubs — [{xref,name,deat,dp}] — бездатные
        // супруги, kstubs — те же дети, chd — датированные дети, marr, div}:
        // семья НЕ схлопывается — каждая строка fam БД даёт ровно одну FAM
        // (у двух жён одного мужа остаются две FAM, а не один FAM с двумя WIFE)
        const fams = [];
        for (const f of families) {
            const par = [], chd = [], stubs = [], kstubs = [];
            const stubOf = x => {
                const i = indiOf(x);
                if (!i || !i.name) return null;
                return { xref: x, name: i.name, sex: i.sex || null, deat: i.deat_d || null, dp: i.deat_plac || null,
                    dh: i.deat_h, dm: i.deat_m, dsrcH: i.dsrc_h, dsrcM: i.dsrc_m,
                    dabt: i.deat_d ? i.deat_abt || 0 : 0, note: i.note || null };
            };
            for (const [role, x] of [['HUSB', f.husb], ['WIFE', f.wife]]) {
                if (!x) continue;
                const k = keyOfXref(x);
                if (k) par.push({ x, k, role });
                else {
                    const st = stubOf(x);
                    if (st) stubs.push({ ...st, role });
                }
            }
            for (const r of childrenOf(f.xref)) {
                const k = keyOfXref(r.indi);
                if (k) chd.push({ x: r.indi, k });
                else {
                    const st = stubOf(r.indi);
                    if (st) kstubs.push(st);
                }
            }
            let marr = f.marr_d ? { d: f.marr_d, ...(f.marr_abt ? { abt: f.marr_abt } : {}), ...(f.marr_plac ? { plac: f.marr_plac } : {}) } : null;
            let div = f.div_d ? { d: f.div_d, ...(f.div_abt ? { abt: f.div_abt } : {}), ...(f.div_plac ? { plac: f.div_plac } : {}) } : null;
            const fnote = f.note || null;
            if (hasKeys) {
                // фрагмент: семья остаётся при ХОТЬ ОДНОЙ датированной половине
                // в keys (как в росписи chatFlatText — famBody печатает свадьбы
                // половин из keys): бездетные свадьбы и семьи с детьми за
                // пределами keys тоже идут, иначе роспись .ged.txt и гедком .ged
                // одной росписи расходились бы (round-trip терял свадьбы и ломал
                // глубины). famc за радиусом (в keys лишь ребёнок) — мимо:
                // в росписи таких строк нет, глубины он не меняет
                const ps = par.filter(p => keys.includes(p.k));
                if (!ps.length) continue;
                par.length = 0; par.push(...ps);
                const ks = chd.filter(c => keys.includes(c.k));
                chd.length = 0; chd.push(...ks);
                // фрагмент — датированные персоны из keys; заглушки-половины/дети — как есть
            } else if (!par.length && !stubs.length && !kstubs.length && !chd.length) continue;
            fams.push({ xref: f.xref, par, chd, stubs, kstubs, marr, div, fnote });
        }
        // поколения: семьи родителей раньше семей детей — каноническая нумерация
        // FAM независимо от порядка вставки (см. famsByGenerations)
        const famsOrd = famsByGenerations(fams,
            f => [...f.par.map(p => p.x), ...f.stubs.map(s => s.xref)],
            f => [...f.chd.map(c => c.x), ...f.kstubs.map(s => s.xref)]);
        for (let i = 0; i < fams.length; i++) fams[i] = famsOrd[i];
        // заглушки-INDI и FAM печатаются собственными xref'ами БД (уникальны
        // по построению): round-trip .ged → .ged сохраняет xref'ы, а значит
        // и метки «~xref» в именах заглушек. HUSB/WIFE — исходные слоты семьи.
        const stubId = new Map(), stubInfo = new Map();
        const addStub = st => {
            if (!stubId.has(st.xref)) { stubId.set(st.xref, st.xref); stubInfo.set(st.xref, st); }
        };
        for (const f of fams) {
            for (const st of f.stubs) addStub(st);
            for (const st of f.kstubs) addStub(st);
        }
        const fidOf = new Map(fams.map(f => [f, f.xref]));
        const out = ["0 HEAD", "1 SOUR LunarReturns", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"];
        for (const r of persons) {
            const start = out.length;
            out.push("0 @" + idOf.get(r.xref) + "@ INDI");
            out.push("1 NAME " + cleanName(r.n));
            if (r.sex) out.push("1 SEX " + r.sex);
            out.push("1 BIRT", "2 DATE " + gdateAbt(r.d, r.abt));
            if (r.srcH !== undefined) out.push("3 TIME " + String(r.srcH).padStart(2, "0") + ":" + String(r.srcM).padStart(2, "0"));
            if (r.plac) out.push("2 PLAC " + r.plac);
            if (r.dd) {
                out.push("1 DEAT", "2 DATE " + gdateAbt(r.dd, r.dabt));
                if (r.dsrcH !== undefined) out.push("3 TIME " + String(r.dsrcH).padStart(2, "0") + ":" + String(r.dsrcM).padStart(2, "0"));
                if (r.dp) out.push("2 PLAC " + r.dp);
            }
            out.push(...gedNoteLines(r.note, true, out, start));
            for (const f of fams) {
                if (f.chd.some(c => c.x === r.xref)) {
                    out.push("1 FAMC @" + fidOf.get(f) + "@");
                    if (adoptedOf.get(r.xref) === f.xref) out.push("1 ADOP", "2 FAMC @" + fidOf.get(f) + "@");
                }
                if (f.par.some(p => p.x === r.xref)) out.push("1 FAMS @" + fidOf.get(f) + "@");
            }
        }
        // заглушки (бездатные супруги/дети): имя + пол + смерть/место, если известны
        for (const [x, st] of stubInfo) {
            const start = out.length;
            out.push("0 @" + stubId.get(x) + "@ INDI");
            out.push("1 NAME " + cleanName(st.name));
            if (st.sex) out.push("1 SEX " + st.sex);
            if (st.deat) {
                const r = localRecord({ ...st, dd: st.deat });
                out.push("1 DEAT", "2 DATE " + gdateAbt(r.dd, st.dabt));
                if (r.dsrcH !== undefined) out.push("3 TIME " + String(r.dsrcH).padStart(2, "0") + ":" + String(r.dsrcM).padStart(2, "0"));
                if (st.dp) out.push("2 PLAC " + st.dp);
            }
            out.push(...gedNoteLines(st.note, true, out, start));
            for (const f of fams) {
                if (f.stubs.some(s => s.xref === x)) out.push("1 FAMS @" + fidOf.get(f) + "@");
                if (f.kstubs.some(s => s.xref === x)) out.push("1 FAMC @" + fidOf.get(f) + "@");
            }
        }
        for (const f of fams) {
            const start = out.length;
            out.push("0 @" + fidOf.get(f) + "@ FAM");
            // Family slots are independent of SEX.
            const all = [
                ...f.par.map(p => ({ ref: p.x, role: p.role })),
                ...f.stubs.map(s => ({ ref: stubId.get(s.xref), role: s.role })),
            ];
            for (const role of ['HUSB', 'WIFE']) for (const x of all.filter(x => x.role === role)) out.push("1 " + role + " @" + x.ref + "@");
            for (const c of f.chd) {
                out.push("1 CHIL @" + idOf.get(c.x) + "@");
                if (adoptedOf.get(c.x) === f.xref) out.push("2 PEDI adopted");
            }
            for (const s of f.kstubs) out.push("1 CHIL @" + stubId.get(s.xref) + "@");
            if (f.marr) {
                out.push("1 MARR", "2 DATE " + gdateAbt(f.marr.d, f.marr.abt));
                if (f.marr.plac) out.push("2 PLAC " + f.marr.plac);
            }
            if (f.div) {
                out.push("1 DIV", "2 DATE " + gdateAbt(f.div.d, f.div.abt));
                if (f.div.plac) out.push("2 PLAC " + f.div.plac);
            }
            out.push(...gedNoteLines(f.fnote, false, out, start));
        }
        out.push("0 TRLR");
        return out.join("\n");
    }

    function flatRows() {
        const rows = people.map(r => ({
            key: r.xref, name: r.name, sex: r.sex || null,
            d: r.birt_d ?? undefined, dd: r.deat_d ?? undefined,
            h: r.birt_h ?? undefined, m: r.birt_m ?? undefined,
            srcH: r.src_h ?? undefined, srcM: r.src_m ?? undefined,
            dh: r.deat_h ?? undefined, dm: r.deat_m ?? undefined,
            dsrcH: r.dsrc_h ?? undefined, dsrcM: r.dsrc_m ?? undefined,
            plac: r.plac ?? undefined, dp: r.deat_plac ?? undefined,
            note: r.note ?? undefined, nameOnly: r.birt_d == null,
            abt: r.birt_abt ?? undefined, dabt: r.deat_abt || undefined,
        }));
        const fams = [];
        for (const f of families) {
            const F = { xref: f.xref, hKey: null, hName: null, wKey: null, wName: null, children: [], marr: null, div: null, note: f.note || null };
            for (const [slot, x] of [['hKey', f.husb], ['wKey', f.wife]]) {
                if (!x) continue;
                const r = indiOf(x);
                if (!r) continue;
                F[slot] = x;
            }
            for (const r of childrenOf(f.xref)) {
                if (indiOf(r.indi)) F.children.push(r.indi);
            }
            F.marr = f.marr_d ? { d: f.marr_d, ...(f.marr_abt ? { abt: f.marr_abt } : {}), ...(f.marr_plac ? { plac: f.marr_plac } : {}) } : null;
            F.div = f.div_d ? { d: f.div_d, ...(f.div_abt ? { abt: f.div_abt } : {}), ...(f.div_plac ? { plac: f.div_plac } : {}) } : null;
            fams.push(F);
        }
        // поколения до построения росписи: семьи родителей раньше семей детей
        // (см. famsByGenerations) — familyOf (первая семья ребёнка), «mine»
        // (порядок браков) и famsDone не зависят от порядка вставки семей
        const famsOrd = famsByGenerations(fams,
            f => [f.hKey, f.wKey].filter(k => k != null), f => f.children);
        for (let i = 0; i < fams.length; i++) fams[i] = famsOrd[i];
        return [rows, fams];
    }

    function chatFlatText(keys = null) {
        // keys (опционально) — фокус-радиус: роспись только этого подмножества
        // («Имя ГГГГ-ММ-ДД»); семьи фильтруются по касанию персон карт ключей
        const hasKeys = Array.isArray(keys) && keys.length > 0;
        const [rows, allFams] = flatRows();
        const persons = rows.filter(r => !hasKeys || keys.includes(r.name + " " + (r.d ?? "")));
        if (!hasKeys) return flatTreeText(persons, allFams, true); // canonical — рецепт порядка
        const kOf = new Map(rows.map(r => [r.key, r.name + " " + (r.d ?? "")]));
        // роспись радиуса — тот же канонический рецепт, что и у целого древа:
        // порядок больше не «героевоцентричный» (герой посередине), семьи —
        // по дате свадьбы/старшему супругу. Для резки-прививки не годится всё
        // равно: первой строкой метка NOT_FOR_GRAFT, parseTree читает её в
        // tree.noGraft, cutAndGraft такую роспись отвергает
        return NOT_FOR_GRAFT + "\n" + flatTreeText(persons, allFams.filter(f =>
            [f.hKey, f.wKey, ...f.children].some(k => k != null && keys.includes(kOf.get(k) || ""))), true);
    }

    function prepareChart(keys, title, heroKey, range, diagnose = false, fynnySetting) {
        const snapshot = flatRows();
        const pairs = pairsOf(), spousePairs = spousesOf();
        const xOf = new Map(snapshot[0].filter(p => p.d != null).map(p => [p.name + " " + p.d, p.key]));
        const hasKeys = Array.isArray(keys) && keys.length > 0;
        const recs = personsOf().filter(r => !hasKeys || keys.includes(pkey(r)));
        const keySet = new Set(recs.map(r => pkey(r)));
        let rows = recs.map(r => ({ xref: xOf.get(pkey(r)), name: r.n, birth: r.d, h: r.h, m: r.m, death: r.dd || null, sex: r.sex || null, abt: r.abt ?? 0 }));
        const stubSpouses = [];
        // якоря бездатных: год ДР датированного супруга (первой семьи по порядку)
        const stubs = people.filter(r => r.birt_d == null && r.name);
        const stubOf = new Map(stubs.map(r => [r.xref, r]));
        const anchor = new Map(); // xref бездатного → { yr, spKey, fam }
        for (const f of families) {
            for (const [a, b] of [[f.husb, f.wife], [f.wife, f.husb]]) {
                if (!a || !b || !stubOf.has(a) || anchor.has(a)) continue;
                const sp = indiOf(b);
                if (sp && sp.birt_d)
                    anchor.set(a, { yr: Number(sp.birt_d.slice(0, 4)), spKey: sp.name + " " + sp.birt_d, fam: f.xref });
            }
        }
        // явные ключи бездатных «Имя якорь»: суффиксы « » строит сам chartModel
        // (ключи датированных — «Имя полная дата», с «Имя якорь» не пересекаются);
        // taken — для коллизий одноимённых заглушек на одном якорном году
        const taken = new Set();
        for (const r of recs) taken.add(r.n + " " + r.d);
        const famStubKey = new Map();   // fam.xref → ключ бездатного супруга в чарте
        for (const [x, an] of anchor) {
            if (hasKeys && !keys.includes(an.spKey)) continue;
            const s = stubOf.get(x);
            let k = s.name + " " + an.yr;
            while (taken.has(k)) k += " ";
            taken.add(k);
            stubSpouses.push([an.spKey, k]);
            if (!famStubKey.has(an.fam)) famStubKey.set(an.fam, k);
            rows.push({ xref: x, name: s.name, k, birth: null, anchor: an.yr, death: s.deat_d || null, sex: s.sex || null });
        }
        // родители ребёнка: датированные, вошедшие в чарт + бездатный супруг
        // (свой ключ «Имя якорь»); fill ds/sk, ключ бездатного не под ckey
        const parentsOf = new Map();    // ребёнок (ключ «Имя ГГГГ-…») → { ds, sk }
        for (const f of familyViews()) {
            const ps = f.parents.filter(p => keySet.has(p));
            const sk = famStubKey.get(f.xref) || null;
            for (const c of f.children) {
                if (!keySet.has(c)) continue;
                const arr = parentsOf.get(c) || { ds: [], sk: null };
                for (const p of ps) if (!arr.ds.includes(p)) arr.ds.push(p);
                if (sk && !arr.sk) arr.sk = sk;
                parentsOf.set(c, arr);
            }
        }
        let links = [...parentsOf].filter(([, ps]) => ps.ds.length || ps.sk)
            .map(([c, ps]) => ({ child: ckey(c), parents: [...ps.ds.map(ckey), ...(ps.sk ? [ps.sk] : [])] }));
        // ярлыки родства — как в 🔔-списке (focusListText): linkPairs +
        // супруги fam-семей + пол; подписи в чарте всё равно «Связь год»;
        // диапазон героя rel.range (цифра кейапа заголовка, 4⃣ … → 4) — из sendGedArtifacts
        const hero = heroKey ? ckey(heroKey) : null;
        const rel = hero ? {
            hero,
            range,
            fynny: fynnySetting ?? settings.fynny,
            pairs: pairs.map(([p, c]) => [ckey(p), ckey(c)]),
            spouses: [...spousePairs.map(sp => sp.map(ckey)), ...stubSpouses],
            sex: Object.fromEntries([...personsOf().map(r => [pkey(r), r.sex || null]),
                ...rows.filter(r => r.k).map(r => [r.k, r.sex])]),
        } : null;
        if (diagnose) return chartDiagnostics(rows, links, chartFont());
        rows = chartRows(rows, rel);
        checkChartLimit(rows.length);
        const visible = new Set(rows.map(r => r.k ?? r.name + " " + r.birth));
        for (const k of keySet) if (!visible.has(k)) keySet.delete(k);
        for (const [f, k] of famStubKey) if (!visible.has(k)) famStubKey.delete(f);
        links = links.filter(l => visible.has(l.child)).map(l => ({ ...l,
            parents: l.parents.filter(p => visible.has(p)) })).filter(l => l.parents.length);
        // дети супругов вне фрагмента/радиуса: годы их рождения — вертикалью
        // между супругами (дата рождения берётся из всех персон чата;
        // заглушки без даты — пропускаются). Пара: обе датированные — как
        // прежде; датированный + бездатный в чарте — ключ бездатного («Имя
        // якорь»); бездатный не в чарте (вне фрагмента) — вертикали нет
        const bornOf = new Map(personsOf().map(r => [pkey(r), r.d]));
        const phantoms = [];
        const marriages = [];           // свадьбы с датой: { fam: [ключ, ключ], year };
                                        // один супруг в чарте — fam: [ключ] (зарубка)
        for (const f of familyViews()) {
            const ps = f.parents.filter(p => keySet.has(p));
            const sk = famStubKey.get(f.xref) || null;
            const pair = ps.length === 2 ? ps.map(ckey)
                : ps.length === 1 && sk ? [ckey(ps[0]), sk]
                : ps.length === 1 ? [ckey(ps[0])] : null;
            if (!pair) continue;
            // дата свадьбы — вертикаль между супругами в год свадьбы (без точек);
            // один супруг в чарте — зарубка на его баре (свадьба с выбывшим)
            if (f.marr && f.marr.d)
                marriages.push({ fam: pair, year: Number(f.marr.d.slice(0, 4)) });
            const yrs = [...new Set(f.children.filter(c => !keySet.has(c) && bornOf.has(c))
                .map(c => Number(bornOf.get(c).slice(0, 4))))].sort((a, b) => a - b);
            if (yrs.length) phantoms.push({ fam: pair, years: yrs,
                children: f.children.filter(c => !keySet.has(c) && bornOf.has(c)).map(c => ({
                    year: Number(bornOf.get(c).slice(0, 4)),
                    r: { xref: xOf.get(c), name: snapshot[0].find(p => p.key === xOf.get(c))?.name || c,
                        birth: bornOf.get(c), h: recs.find(p => pkey(p) === c)?.h, m: recs.find(p => pkey(p) === c)?.m,
                        abt: snapshot[0].find(p => p.key === xOf.get(c))?.abt ?? 0 },
                })) });
        }
        const model = chartModel(title, rows, links, { ...rel, phantoms }, marriages);
        return { model, persons: rows.length, renderPdf() {
            const annotationText = createPdfAnnotationText(snapshot, pairs, spousePairs, rel?.fynny ?? fynnySetting ?? settings.fynny);
            const metadata = pdfPersonMetadata(snapshot, heroKey, xOf.get(heroKey), range);
            return chartPdf(title, rows, links, chartFont(), rel, marriages, annotationText, metadata, model);
        } };
    }

    function exportViewer(g, heroKey, heroXref, radius, s, chart, progress) {
        const { viewerEpub, viewerWithChart, epubBase, zipFiles } = reqLib('epub');
        const { viewerAnnotations } = reqLib('viewer');
        const title = epubBase(heroKey, radius || 1);
        const annotations = viewerAnnotations(g, flatRows(), pairsOf(), spousesOf(), s.fynny, chart.model,
            (done, total) => progress?.('annotations', done, total));
        const html = viewerWithChart(g, title, heroXref, annotations, { chart });
        progress?.('markup', 1, 1);
        return format => format === 'html' ? [title + '.zip', zipFiles([[title + '.html', html]])]
            : [title + '.epub', viewerEpub(g, title, heroXref, annotations, { heroKey, radius: radius || 1, html })];
    }
    function branchFlatText(key) {
        const [rows, fams] = flatRows();
        const xrefs = new Map(rows.map(r => [r.name + ' ' + (r.d ?? ''), r.key]));
        const root = xrefs.get(key);
        if (!root) return '';
        const kids = new Map();
        for (const [p, c] of pairs) {
            const px = xrefs.get(p), cx = xrefs.get(c);
            if (!px || !cx) continue;
            if (!kids.has(px)) kids.set(px, []);
            if (!kids.get(px).includes(cx)) kids.get(px).push(cx);
        }
        const [picked, branch] = subsetBranch(rows, fams, root, kids);
        const i = picked.findIndex(p => p.key === root);
        const ordered = i > 0 ? [picked[i], ...picked.slice(0, i), ...picked.slice(i + 1)] : picked;
        return flatTreeText(ordered, branch);
    }

    return { gedcomText, flatRows, chatFlatText, branchFlatText, prepareChart, exportViewer, personsOf, spousesOf, pairsOf };
}

module.exports = { createExportData, personFromRow };
