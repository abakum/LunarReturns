// Общий код TG-бота: настройки, клавиатуры, тексты «сегодня»/«список».
import { db, api } from 'sdk';
import { and, eq, or, inArray } from 'sdk/db';
import { indi, fam, chil, edges, settings, focusView } from '../schema.js';
import { mskToday } from './astro.cjs';
import { kinLabel, fynny } from './kinship.cjs';
import { REL_DEFS, religiousDigest } from './religion.cjs';
import { jubileeText, approxOut } from './text.js';
import { findShownRecord } from './text.cjs';
import { chatFlatArtifacts, gedText, gedFictiveDates } from './parse.cjs';
import { familyXref, focusDepth, focusKeys, focusGraphKeys, focusHasPair, focusWithSpouses, focusListKeys, famsByGenerations, eventListText } from './tree.cjs';
// фокус-список (focusListText) — канон tree.cjs (с A3): реэкспорт — точки
// импорта handlers не менялись
// чистые функции родословной росписи -+= — общий канон tgcloud/lib/flat.cjs
// (волна A2): handlers берут flatSearch/flatHitKey/treeReport реэкспортом
// ниже; правки — только в .cjs
import { flatTreeText, subsetBranch, flatSearch, flatHitPerson, flatHitKey, treeReport, rootOf, cutLines, createFlatAnnotationText } from './flat.cjs';
// реэкспорт: точки импорта handlers не менялись с волны A
export { flatTreeText, subsetBranch, flatSearch, flatHitPerson, flatHitKey, treeReport, rootOf } from './flat.cjs';
export { searchHead, cutLines } from './flat.cjs';
export { focusListText } from './tree.cjs';

export { HELP } from './text.cjs';

// сколько живёт «Да/Нет»-вопрос на дроп .ged-файла (час)
export const GED_TTL = 3600000;

const DEFAULT_SETTINGS = { orth: false, islam: false, bud: false, cath: false, jud: false, bell: true, fynny: false };

export async function getSettings(chatId) {
    const row = await db.select().from(settings).where(eq(settings.chatId, chatId)).get();
    const normalized = { chatId, ...row };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) normalized[key] ??= value;
    return normalized;
}

// inline-клавиатура настроек (личка): 🗑 (удалить всё) + колокольчик (список) + религии (🔔/🔕) + ❌
// раскладка как в VK relKeyboard: [🗑, 🔔, orth, islam] / [bud, cath, jud, ❌];
// колокольчик всегда 🔔 (подписки больше нет — список всегда «от сегодня»)
export function relMarkup(chatId, s) {
    const btn = (text, data) => ({ text, callback_data: data });
    const rel = key => btn(REL_DEFS[key].icon + (s[key] ? "🔔" : "🔕"), "rel:" + key);
    return {
        inline_keyboard: [
            [btn("🗑", "del"), btn("🔔", "bell"), btn("🧬", "tree"), btn("-+=", "flat"), rel("orth")],
            [rel("islam"), rel("bud"), rel("cath"), rel("jud")],
            [btn("❌", "close")]
        ]
    };
}

// клавиатура админа группы: 🗑 (удалить всё), колокольчик (список), 🧬 (гедком), ❌
export function ownerMarkup(_bellOn) {
    return {
        inline_keyboard: [[
            { text: "🗑", callback_data: "del" },
            { text: "🔔", callback_data: "bell" },
            { text: "🧬", callback_data: "tree" },
            { text: "-+=", callback_data: "flat" },
            { text: "❌", callback_data: "close" },
        ]]
    };
}

// клавиатура участника группы: колокольчик (список), 🧬 (гедком), ❌
export function bellMarkup(_bellOn) {
    return {
        inline_keyboard: [[
            { text: "🔔", callback_data: "bell" },
            { text: "🧬", callback_data: "tree" },
            { text: "-+=", callback_data: "flat" },
            { text: "❌", callback_data: "close" },
        ]]
    };
}

// ============================== STORE (sdk/db, xref-дерево) ==============================
// Источник истины — дерево чата с идентичностью по xref (как в гедкоме),
// дословный зеркалон store-слоя VK-бота (lunarreturns.js):
//   indi — персоны (birtD NULL — заглушки-половины свадеб без даты),
//   fam  — пары (husb/wife = xref'ы, marr/div с датами и местами),
//   chil — дети в семье (adopted), edges — рёбра родитель→ребёнок «Имя Д»
//   + состояние сообщений-связей (who/pairCand/famXref).
// «Имя Д» и «Имя+Имя Д» — производные виды (personRows/weddingRows):
// свадьба всегда привязана к xref'ам супругов, поисков «по первому имени»
// нет — тёзки не перехватывают чужие свадьбы. Конвертация старой плоской
// базы = повторный импорт (ЗАМЕНА: старое дерево стирается и заливается).

const pkey = r => r.n + " " + r.d;
const keyN = k => k.slice(0, -11);               // имя из ключа
const keyY = k => Number(k.slice(-10, -6));      // год рождения из ключа

const indiRows = chatId => db.select().from(indi).where(eq(indi.chatId, chatId)).all();
const famRowsOf = chatId => db.select().from(fam).where(eq(fam.chatId, chatId)).all();
const chilRows = chatId => db.select().from(chil).where(eq(chil.chatId, chatId)).all();
const edgeRows = chatId => db.select().from(edges).where(eq(edges.chatId, chatId)).all();

// fam/raw-строка по xref
async function getIndi(chatId, xref) {
    if (!xref) return null;
    return (await db.select().from(indi).where(and(eq(indi.chatId, chatId), eq(indi.xref, xref))).get());
}
async function getFam(chatId, xref) {
    if (!xref) return null;
    return (await db.select().from(fam).where(and(eq(fam.chatId, chatId), eq(fam.xref, xref))).get());
}

async function nextIndiXref(chatId, pref) {
    const rows = await indiRows(chatId);
    let max = 0;
    for (const r of rows.filter(r => String(r.xref).startsWith(pref)))
        max = Math.max(max, Number(String(r.xref).slice(pref.length)) || 0);
    return pref + (max + 1);
}
async function nextFamXref(chatId, pref) {
    const rows = await famRowsOf(chatId);
    let max = 0;
    for (const r of rows.filter(r => String(r.xref).startsWith(pref)))
        max = Math.max(max, Number(String(r.xref).slice(pref.length)) || 0);
    return pref + (max + 1);
}

// ---- виды: «Имя Д» и «Имя+Имя Д» — выборка из дерева ----

// строка indi (с birt_d) в виде записи-события {n,d,h,m,srcH,srcM,dd,dh,dm,dsrcH,dsrcM,sex,plac,xref}
// abt/dabt — квалификатор×гранулярность ДР/смерти (abt = Q*3+G, см.
// lib/parse.cjs): юбилеи по abt!=0 не оповещаются
const recOfIndi = r => {
    const o = { n: r.name, d: r.birtD };
    if (r.birtAbt) o.abt = r.birtAbt;
    if (r.deatAbt) o.dabt = r.deatAbt;
    if (r.birtH !== null && r.birtH !== undefined) { o.h = r.birtH; o.m = r.birtM ?? 0; }
    if (r.srcH !== null && r.srcH !== undefined) { o.srcH = r.srcH; o.srcM = r.srcM ?? 0; }
    if (r.sex) o.sex = r.sex;
    if (r.deatD) {
        o.dd = r.deatD;
        if (r.deatH !== null && r.deatH !== undefined) { o.dh = r.deatH; o.dm = r.deatM ?? 0; }
        if (r.dsrcH !== null && r.dsrcH !== undefined) { o.dsrcH = r.dsrcH; o.dsrcM = r.dsrcM ?? 0; }
        if (r.deatPlac) o.dp = r.deatPlac;
    }
    if (r.plac) o.plac = r.plac;
    if (r.note) o.note = r.note;
    o.xref = r.xref;
    return o;
};

// персоны чата (только с датой рождения), порядок вставки
export async function personRows(chatId) {
    const rows = (await indiRows(chatId)).filter(r => r.birtD != null)
        .sort((a, b) => a.id - b.id);
    return rows.map(recOfIndi);
}

// свадьбы чата: fam с marr и хоть одним супругом (имена по xref — точно);
// отсутствующая половина — заглушка «Муж»/«Жена» (персоны в БД нет);
// та же пара+дата у второй семьи (после confirmPair) — один раз
export async function weddingRows(chatId) {
    const fs = (await famRowsOf(chatId)).sort((a, b) => a.id - b.id);
    const nameOf = new Map((await indiRows(chatId)).map(r => [r.xref, r.name]));
    const out = [], seen = new Set();
    for (const f of fs) {
        if (f.marrD === null || f.marrD === undefined) continue;
        const hn = f.husb ? nameOf.get(f.husb) || null : null;
        const wn = f.wife ? nameOf.get(f.wife) || null : null;
        if (!hn && !wn) continue;
        const o = { n: (hn || "Муж") + "+" + (wn || "Жена"), d: f.marrD };
        if (f.marrAbt) o.mabt = f.marrAbt;
        if (seen.has(pkey(o))) continue;
        seen.add(pkey(o));
        if (f.marrPlac) o.plac = f.marrPlac;
        if (f.note) o.note = f.note;
        if (f.divD) { o.dd = f.divD; if (f.divAbt) o.dabt = f.divAbt; if (f.divPlac) o.plac2 = f.divPlac; }
        o.fx = f.xref;
        out.push(o);
    }
    return out;
}

// запись по ключу «Имя Д» или «Имя+Имя Д»
export async function recordOf(chatId, key) {
    return (await personRows(chatId)).find(r => pkey(r) === key)
        || (await weddingRows(chatId)).find(r => pkey(r) === key)
        || null;
}

// ключ из показанного текста (новый стиль + суффикс: юбилей/🔔 печатает
// приближённые даты через approxOut): точный ключ — как хранение; мимо —
// поиск по отображённой форме (имя ≃ и approxOut(newStyleDate) совпал);
// `_` — маркер нового стиля; нормализация только в общем fallback
export async function recordShownOf(chatId, key) {
    const exact = await recordOf(chatId, key);
    if (exact) return exact;
    return findShownRecord([...await personRows(chatId), ...await weddingRows(chatId)], key);
}

// запись по xref (индивидуальный — даже без birt_d — либо fam-пара со свадьбой)
export async function recordByXref(chatId, xref) {
    const i = await getIndi(chatId, xref);
    if (i && i.birtD != null) return recOfIndi(i);
    const f = await getFam(chatId, xref);
    if (f && f.marrD) return (await weddingRows(chatId)).find(w => w.fx === xref) || null;
    return null;
}

// ключи «Имя Д» по xref
// есть ли древо чата как структура (fam с хоть одной половиной или хоть
// один ребёнок в fam): гейт выгрузки 🧬/.ged — численность связей «Имя Д»
// (edges) для бездатных древ всегда ноль, хотя выгрузка по xref работает
export async function hasTree(chatId) {
    const fam = (await famRowsOf(chatId)).some(f => f.husb !== null || f.wife !== null);
    return fam || (await chilRows(chatId)).length > 0;
}
export async function keyOfXref(chatId, xref) {
    const i = await getIndi(chatId, xref);
    return i && i.birtD != null ? i.name + " " + i.birtD : null;
}
export async function xrefOfKey(chatId, key) {
    const r = (await indiRows(chatId)).find(x => x.name === keyN(key) && x.birtD === key.slice(-10));
    return r ? r.xref : null;
}

// fam в виде {xref, adhoc, parents/children — ключи «Имя Д», marr, div}
export async function famView(chatId, fx) {
    const f = await getFam(chatId, fx);
    if (!f) return null;
    return {
        xref: f.xref, adhoc: !!f.adhoc,
        parents: (await Promise.all([...new Set([f.husb, f.wife].filter(Boolean))]
            .map(x => keyOfXref(chatId, x)))).filter(Boolean),
        children: (await Promise.all(
            (await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, fx))).all())
                .sort((a, b) => a.id - b.id)
                .map(r => keyOfXref(chatId, r.indi)))).filter(Boolean),
        marr: f.marrD ? { d: f.marrD, ...(f.marrAbt ? { abt: f.marrAbt } : {}), ...(f.marrPlac ? { plac: f.marrPlac } : {}) } : null,
        div: f.divD ? { d: f.divD, ...(f.divAbt ? { abt: f.divAbt } : {}), ...(f.divPlac ? { plac: f.divPlac } : {}) } : null,
    };
}
export async function famList(chatId) {
    const fs = (await famRowsOf(chatId)).sort((a, b) => a.id - b.id);
    return (await Promise.all(fs.map(r => famView(chatId, r.xref)))).filter(Boolean);
}
export async function linkPairs(chatId) {
    return (await edgeRows(chatId)).sort((a, b) => a.id - b.id).map(l => [l.parent, l.child]);
}

// строка-связь в прежнем виде (+adopted из chil семьи связи)
async function linkRowOf(chatId, r) {
    const cx = r.famXref ? await xrefOfKey(chatId, r.child) : null;
    let adopted = false;
    if (r.famXref && cx) {
        const c = (await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, r.famXref), eq(chil.indi, cx))).get());
        adopted = !!(c && c.adopted);
    }
    return { id: r.id, peerId: chatId, p: r.parent, c: r.child, who: r.who, famXref: r.famXref,
        pairCand: r.pairCand ? JSON.parse(r.pairCand) : null, adopted };
}
export async function linkById(chatId, id) {
    const r = (await db.select().from(edges).where(and(eq(edges.chatId, chatId), eq(edges.id, id))).get());
    return r ? linkRowOf(chatId, r) : null;
}
export async function linksAll(chatId) {
    return Promise.all((await edgeRows(chatId))
        .map(r => linkRowOf(chatId, r)));
}

export async function setLinkCand(link, cand) {
    await db.update(edges).set({ pairCand: cand ? JSON.stringify(cand) : null })
        .where(and(eq(edges.chatId, link.peerId), eq(edges.id, link.id))).run();
    link.pairCand = cand || null;
}

// ---- мутации ----

// событие своё у каждого чата, ключ — имя+дата: повторный триггер с той же
// датой обновляет (только заданные поля), с другой — отдельное событие
// (Георгий 1910 и Георгий 1963). «Имя+Имя Д» — свадьба: пара-заглушка
// (половины без дат рождения) с marr/div
export async function upsertPerson(chatId, rec) {
    if (rec.n.includes("+")) return upsertWedding(chatId, rec);
    const existing = (await indiRows(chatId))
        .find(r => r.name === rec.n && r.birtD != null && r.birtD === rec.d);
    if (existing) {
        const set = {};
        if (rec.h !== undefined) { set.birtH = rec.h; set.birtM = rec.m ?? 0; }
        if (rec.srcH !== undefined) { set.srcH = rec.srcH; set.srcM = rec.srcM ?? 0; }
        if (rec.dd !== undefined) {
            set.deatD = rec.dd || null;
            if (rec.dh !== undefined) { set.deatH = rec.dh; set.deatM = rec.dm ?? 0; }
            if (rec.dsrcH !== undefined) { set.dsrcH = rec.dsrcH; set.dsrcM = rec.dsrcM ?? 0; }
        } else if (rec.dh !== undefined) { set.deatH = rec.dh; set.deatM = rec.dm ?? 0; }
        if (rec.sex !== undefined) set.sex = rec.sex || null;
        if (rec.plac !== undefined) set.plac = rec.plac || null;
        if (rec.plac2 !== undefined) set.deatPlac = rec.plac2 || null;
        if (rec.note !== undefined) set.note = rec.note || null;
        if (rec.abt !== undefined) set.birtAbt = rec.abt || 0;
        if (rec.dabt !== undefined) set.deatAbt = rec.dabt || 0;
        if (Object.keys(set).length)
            await db.update(indi).set(set)
                .where(and(eq(indi.chatId, chatId), eq(indi.xref, existing.xref))).run();
        return (await personRows(chatId)).find(r => r.xref === existing.xref) || null;
    }
    const xref = await nextIndiXref(chatId, "P");
    await db.insert(indi).values({
        chatId, xref, name: rec.n,
        birtD: rec.d, birtH: rec.h ?? null, birtM: rec.h !== undefined ? (rec.m ?? 0) : null,
        srcH: rec.srcH ?? null, srcM: rec.srcH !== undefined ? (rec.srcM ?? 0) : null,
        deatD: rec.dd ?? null, deatH: rec.dh ?? null, deatM: rec.dh !== undefined ? (rec.dm ?? 0) : null,
        dsrcH: rec.dsrcH ?? null, dsrcM: rec.dsrcH !== undefined ? (rec.dsrcM ?? 0) : null,
        sex: rec.sex ?? null, plac: rec.plac ?? null, deatPlac: rec.plac2 ?? null, note: rec.note ?? null,
        birtAbt: rec.abt ?? 0, deatAbt: rec.dabt ?? 0,
    }).run();
    return (await personRows(chatId)).find(r => r.xref === xref) || null;
}

// заглушка-половина свадьбы: персона без даты (одна на все свадьбы с именем)
async function stubOf(chatId, name) {    const cur = (await indiRows(chatId)).find(r => r.name === name && r.birtD == null);
    if (cur) return cur.xref;
    const xref = await nextIndiXref(chatId, "S");
    await db.insert(indi).values({ chatId, xref, name, birtD: null }).run();
    return xref;
}

export async function weddingByFx(chatId, fx) {
    return (await weddingRows(chatId)).find(w => w.fx === fx) || null;
}

async function upsertWedding(chatId, rec) {
    const [a, b] = rec.n.split("+");
    // повторный триггер «Имя1+Имя2 Д» правит сценар: пара — якорь (без даты),
    // так что дата свадьбы тоже правится; новая пара — новая fam-заглушка
    for (const f of (await famRowsOf(chatId))) {
        const hn = f.husb ? (await getIndi(chatId, f.husb) || {}).name : null;
        const wn = f.wife ? (await getIndi(chatId, f.wife) || {}).name : null;
        if ((hn === a && wn === b) || (hn === b && wn === a)) {
            await db.update(fam).set({
                marrD: rec.d,
                marrAbt: rec.abt ?? 0,
                ...(rec.plac !== undefined ? { marrPlac: rec.plac || null } : {}),
                ...(rec.note !== undefined ? { note: rec.note || null } : {}),
                ...(rec.dd !== undefined ? { divD: rec.dd || null, divAbt: rec.dabt ?? 0 } : {}),
                ...(rec.plac2 !== undefined ? { divPlac: rec.plac2 || null } : {}),
            }).where(and(eq(fam.chatId, chatId), eq(fam.xref, f.xref))).run();
            return weddingByFx(chatId, f.xref);
        }
    }
    const ha = await stubOf(chatId, a), hb = await stubOf(chatId, b);
    const xref = await nextFamXref(chatId, "W");
    await db.insert(fam).values({
        chatId, xref, adhoc: true, husb: ha, wife: hb,
        marrD: rec.d, marrAbt: rec.abt ?? 0, marrPlac: rec.plac ?? null, note: rec.note ?? null,
        divD: rec.dd ?? null, divAbt: rec.dabt ?? 0, divPlac: rec.plac2 ?? null,
    }).run();
    return weddingByFx(chatId, xref);
}

// ============================== РОДОСЛОВНАЯ РОСПИСЬ -+= ==============================
// применить разбор parseTree: персоны (пол по маркеру, note), пары-свадьбы,
// дети; повтор по имя+дата переиспользует персону; родитель должен быть старше
// ребёнка как минимум на 12 лет (иначе связь не пишется, в отчёте ошибка).
// Роспись самодостаточна: корень (герой ветви) — первая персона, не ребёнок
// внутри росписи и не половина пары; его дети привязываются его семьями.
// → { persons, fams, links, errors }
export async function applyTree(chatId, tree) {
    const rep = { persons: 0, fams: 0, links: 0, errors: tree.errors.map(e => ({ ...e })) };
    const sexN = i => (i !== null && i !== undefined && tree.persons[i] ? tree.persons[i].sex : null);
    const nameN = i => (i !== null && i !== undefined && tree.persons[i] ? tree.persons[i].rec.n : "");
    const usedSolo = new Set(), weddingXrefs = [], implicitXrefs = new Map();
    // Every wedding consumes a distinct family; aliases are checked against spouses.
    const famForPair = async (mx, fx, md, alias) => {
        const rows = (await famRowsOf(chatId)).sort((a, b) => a.id - b.id);
        const match = familyXref(rows, mx, fx, alias, md, usedSolo);
        const x = match || await nextFamXref(chatId, "W");
        usedSolo.add(x);
        if (rows.some(f => f.xref === x)) return x;
        await db.insert(fam).values({ chatId, xref: x, adhoc: true, husb: mx || null, wife: fx || null }).run();
        rep.fams++;
        if (mx === null || fx === null) usedSolo.add(x);
        return x;
    };
    const xr = []; // индекс persons → xref
    const seen = new Set(); // реально учтённые записи: повторный «Имя Д»
    // (выкладка среди супругов + у родителей) входит в счёт один раз
    for (let i = 0; i < tree.persons.length; i++) {
        const p = tree.persons[i], rec = p.rec;
        let x;
        if (rec.d === undefined && !rec.n.includes("+")) {
            const named = p.spouseLine ? (await indiRows(chatId)).filter(r => r.name === rec.n) : [];
            x = named.length === 1 ? named[0].xref : await stubOf(chatId, rec.n);
            await db.update(indi).set({ sex: p.sex || null, ...(p.note ? { note: p.note } : {}) })
                .where(and(eq(indi.chatId, chatId), eq(indi.xref, x))).run();
        } else {
            const r = await upsertPerson(chatId, Object.assign({ sex: p.sex, note: p.note }, rec));
            x = r ? r.xref : null;
        }
        xr.push(x);
        if (x != null && !seen.has(x)) { seen.add(x); rep.persons++; }
    }
    for (const ch of tree.children) {
        if (ch.w != null || implicitXrefs.has(ch.o)) continue;
        const parent = tree.persons[ch.m ?? ch.f]?.rec, child = tree.persons[ch.c].rec;
        if (parent?.d && child.d && Number(child.d.slice(0, 4)) - Number(parent.d.slice(0, 4)) < 12) continue;
        implicitXrefs.set(ch.o, await famForPair(ch.m != null ? xr[ch.m] : null, ch.f != null ? xr[ch.f] : null));
    }
    for (const [wi, w] of tree.weddings.entries()) {
        const mx = w.m !== null ? xr[w.m] : null, fx = w.f !== null ? xr[w.f] : null;
        if (!mx && !fx) continue;
        const fxx = await famForPair(mx, fx, w.rec.d, w.xref);
        weddingXrefs[wi] = fxx;
        await db.update(fam).set({
            marrD: w.rec.d ?? null, marrAbt: w.rec.abt ?? 0, marrPlac: w.rec.plac ?? null, note: w.note || null,
            divD: w.rec.dd ?? null, divAbt: w.rec.dabt ?? 0, divPlac: w.rec.plac2 ?? null,
        }).where(and(eq(fam.chatId, chatId), eq(fam.xref, fxx))).run();
    }
    for (const ch of tree.children) {
        const cx = xr[ch.c];
        if (!cx) continue;
        const cd = tree.persons[ch.c].rec.d ?? null;
        const ps = [];
        for (const pi of ["m", "f"]) {
            if (ch[pi] === null || !xr[ch[pi]]) continue;
            const pd = tree.persons[ch[pi]].rec.d ?? null;
            if (pd && cd && Number(cd.slice(0, 4)) - Number(pd.slice(0, 4)) < 12) {
                rep.errors.push({ line: 0, msg: "родитель «" + nameN(ch[pi]) + " " + pd
                    + "» слишком молод для «" + nameN(ch.c) + " " + cd + "»" });
                continue;
            }
            ps.push({ x: xr[ch[pi]], sex: sexN(ch[pi]) });
        }
        if (!ps.length) continue;
        // муж — первым: famForPair хранит пару {husb, wife} по xref'ам
        ps.sort((a, b) => (a.sex === "M" ? -1 : 1) - (b.sex === "M" ? -1 : 1));
        let fxx;
        if (ch.w != null && ps.length === [ch.m, ch.f].filter(p => p != null).length)
            fxx = weddingXrefs[ch.w];
        else if (ps.length === 2) fxx = await famForPair(ps[0].x, ps[1].x);
        else {
            const key = ch.o ?? ps[0].x;
            if (!implicitXrefs.has(key)) implicitXrefs.set(key,
                await famForPair(ps[0].sex === "M" ? ps[0].x : null, ps[0].sex !== "M" ? ps[0].x : null));
            fxx = implicitXrefs.get(key);
        }
        const has = await db.select().from(chil)
            .where(and(eq(chil.chatId, chatId), eq(chil.fam, fxx), eq(chil.indi, cx))).all();
        if (!has.length) {
            await db.insert(chil).values({ chatId, fam: fxx, indi: cx }).run();
            rep.links++;
        }
    }
    // роспись без гедкома тоже восстанавливает интерактивные связи (edges) — иначе
    // /gedcom после импорта росписи .txt не видит связей
    await restoreEdges(chatId);
    return rep;
}

// ---- правка ветви: резать и прививать ----

// обновить поля персоны по xref (правка героя по якорю цитаты); поля, не
// заданные в rec, не перетираются; имя и дата рождения — тоже правимы.
// full=true — полная замена: не заданные поля стираются (кроме пола — он
// меняется только явным rec.sex). Смена имени/даты переименовывает ключ
// в связях (edges), фокус-строках (focus_view) и кандидатах-свадьбах
// (ВК-копия: lunarreturns.js, setPersonByXref)
export async function setPersonByXref(chatId, xref, rec, full = false) {
    const old = await getIndi(chatId, xref);
    const set = {};
    if (rec.n !== undefined) set.name = rec.n;
    if (rec.d !== undefined) set.birtD = rec.d;
    if (full) {
        set.birtH = rec.h ?? null; set.birtM = rec.h !== undefined ? (rec.m ?? 0) : null;
        set.srcH = rec.srcH ?? null; set.srcM = rec.srcH !== undefined ? (rec.srcM ?? 0) : null;
        set.deatD = rec.dd ?? null;
        set.deatH = rec.dh ?? null; set.deatM = rec.dh !== undefined ? (rec.dm ?? 0) : null;
        set.dsrcH = rec.dsrcH ?? null; set.dsrcM = rec.dsrcH !== undefined ? (rec.dsrcM ?? 0) : null;
        set.plac = rec.plac ?? null;
        set.note = rec.note ?? null;
        set.birtAbt = rec.abt ?? 0;
        set.deatAbt = rec.dabt ?? 0;
    } else {
        if (rec.abt !== undefined) set.birtAbt = rec.abt || 0;
        if (rec.dabt !== undefined) set.deatAbt = rec.dabt || 0;
        if (rec.h !== undefined) { set.birtH = rec.h; set.birtM = rec.m ?? 0; }
        if (rec.srcH !== undefined) { set.srcH = rec.srcH; set.srcM = rec.srcM ?? 0; }
        if (rec.dd !== undefined) {
            set.deatD = rec.dd || null;
            if (rec.dh !== undefined) { set.deatH = rec.dh; set.deatM = rec.dm ?? 0; }
            if (rec.dsrcH !== undefined) { set.dsrcH = rec.dsrcH; set.dsrcM = rec.dsrcM ?? 0; }
        } else if (rec.dh !== undefined) { set.deatH = rec.dh; set.deatM = rec.dm ?? 0; }
        if (rec.plac !== undefined) set.plac = rec.plac || null;
        if (rec.note !== undefined) set.note = rec.note || null;
    }
    if (rec.sex !== undefined) set.sex = rec.sex || null;
    if (Object.keys(set).length)
        await db.update(indi).set(set)
            .where(and(eq(indi.chatId, chatId), eq(indi.xref, xref))).run();
    // смена имени/даты — переименовать ключ персоны в связях, фокус-строках
    // и кандидатах-свадьбах (ветка и связи остаются при герое)
    if (old && old.birtD != null && (set.name !== undefined || set.birtD !== undefined)) {
        const oldKey = old.name + " " + old.birtD;
        const newKey = (set.name !== undefined ? set.name : old.name)
            + " " + (set.birtD !== undefined ? set.birtD : old.birtD);
        if (newKey !== oldKey) await rekeyPerson(chatId, oldKey, newKey);
    }
    return (await personRows(chatId)).find(r => r.xref === xref) || null;
}

// ключ персоны сменился: перевесить связи (parent/child), фокус-строки и
// кандидаты-свадьбы на новый ключ — иначе ветка «теряет» героя
// (ВК-копия: lunarreturns.js, rekeyPerson; в ВК фокус-таблицы нет)
async function rekeyPerson(chatId, oldKey, newKey) {
    const oldName = keyN(oldKey), newName = keyN(newKey);
    await db.update(edges).set({ parent: newKey })
        .where(and(eq(edges.chatId, chatId), eq(edges.parent, oldKey))).run();
    await db.update(edges).set({ child: newKey })
        .where(and(eq(edges.chatId, chatId), eq(edges.child, oldKey))).run();
    await db.update(focusView).set({ pkey: newKey })
        .where(and(eq(focusView.chatId, chatId), eq(focusView.pkey, oldKey))).run();
    for (const l of (await edgeRows(chatId)).filter(l => l.pairCand)) {
        const cur = JSON.parse(l.pairCand);
        let changed = false;
        for (const c of cur) {
            if (oldName !== newName && c.pair
                && keyN(c.pair).split("+").some(n => n === oldName)) {
                c.pair = keyN(c.pair).split("+").map(n => n === oldName ? newName : n).join("+")
                    + " " + c.pair.slice(-10); // дата свадьбы — своя, не трогается
                changed = true;
            }
            if (c.other === oldKey) { c.other = newKey; changed = true; }
        }
        if (changed)
            await db.update(edges).set({ pairCand: JSON.stringify(cur) })
                .where(and(eq(edges.chatId, chatId), eq(edges.id, l.id))).run();
    }
}

// точечная правка триггера: якорь-цитата — персона; rec заменяет запись
// ПОЛНОСТЬЮ (не заданные поля стираются), пол не трогается, ветвь и связи
// целы (ключи переименовываются). null — якорь не персона (правки нет);
// новый ключ занят — не отказ, а суффикс «~xref» правимой персоны
// (ВК-копия: lunarreturns.js, editTrigger)
export async function editTrigger(chatId, anchorKey, rec) {
    const xref = await xrefOfKey(chatId, anchorKey);
    if (!xref) return null;
    if (rec.n + " " + rec.d !== anchorKey
        && (await indiRows(chatId)).some(r => r.xref !== xref && r.name === rec.n && r.birtD === rec.d))
        rec.n = rec.n.replace(/ ~\S+$/, "") + " ~" + xref;
    return { rec: await setPersonByXref(chatId, xref, rec, true) };
}

// резать ветвь персоны xref молча: все fams, где xref/потомок — половина,
// каскадно вниз; удалаются: потомки (записи indi), семьи ветви, ребра chil,
// связи edges и фокус-строки; вторые половины ветви — тоже, ПОКА они не
// участники семей вне ветви (тогда запись остаётся, связи рвутся, запись живёт)
async function cutBranch(chatId, px, extraNames = []) {
    const famRows = (await famRowsOf(chatId)).sort((a, b) => a.id - b.id);
    const kidsOfFam = new Map();
    for (const r of (await db.select().from(chil).where(eq(chil.chatId, chatId)).all())
        .sort((a, b) => a.id - b.id)) {
        if (!kidsOfFam.has(r.fam)) kidsOfFam.set(r.fam, []);
        kidsOfFam.get(r.fam).push(r.indi);
    }
    // интерактивные связи: «родитель(ключ) → дети(xref)» — цепочка по edges
    const rows0 = await indiRows(chatId);
    const keyOf = new Map(rows0.map(r => [r.xref, r.name + " " + r.birtD]));
    const kidsOfKey = new Map();
    for (const l of await edgeRows(chatId)) {
        const c = (await xrefOfKey(chatId, l.child));
        if (!c) continue;
        if (!kidsOfKey.has(l.parent)) kidsOfKey.set(l.parent, []);
        if (!kidsOfKey.get(l.parent).includes(c)) kidsOfKey.get(l.parent).push(c);
    }
    const inF = new Set();      // fam-xref'ы ветви
    const D = new Set([px]);    // потомки
    let frontier = [px];
    while (frontier.length) {
        const nf = [];
        for (const f of famRows) {
            if (inF.has(f.xref)) continue;
            const halves = [f.husb, f.wife].filter(Boolean);
            if (!halves.some(h => D.has(h))) continue;
            inF.add(f.xref);
            for (const c of kidsOfFam.get(f.xref) || [])
                if (!D.has(c)) { D.add(c); nf.push(c); }
        }
        for (const x of frontier)
            for (const c of kidsOfKey.get(keyOf.get(x)) || [])
                if (!D.has(c)) { D.add(c); nf.push(c); }
        frontier = nf;
    }
    const fams = [...inF];
    // жертвы: потомки + половины ветви (половина остаётся, если есть семья вне ветви)
    const outF = new Set(famRows.filter(f => !inF.has(f.xref)).map(f => f.xref));
    const victims = new Set();
    for (const x of D) if (x !== px) victims.add(x);
    for (const fx of fams) {
        const f = famRows.find(t => t.xref === fx);
        for (const h of [f.husb, f.wife]) {
            if (!h || D.has(h)) continue;
            const outside = famRows.some(t => outF.has(t.xref) && (t.husb === h || t.wife === h));
            if (!outside) victims.add(h);
        }
    }
    const rows = await indiRows(chatId);
    const victimKeys = new Set([...victims]
        .map(x => { const r = rows.find(t => t.xref === x); return r ? r.name + " " + r.birtD : null; })
        .filter(Boolean));
    // свадьбы-заглушки («Имя1+Имя2 Д») пары ветви: половины-заглушки по именам
    // попали в срез — fam-заглушки удаляем, иначе после прививки двойные события
    const names = new Set([...victimKeys].map(k => k.slice(0, -11)));
    const heroRow = rows.find(t => t.xref === px);
    if (heroRow) names.add(heroRow.name);
    // персонажи прививаемой росписи: их свадьбы-заглушки (пары по именам) — тоже
    for (const n of extraNames) names.add(n);
    let stubDel = 0;
    for (const f of famRows) {
        if (inF.has(f.xref) || !f.husb || !f.wife) continue;
        const hn = rows.find(t => t.xref === f.husb && t.birtD == null);
        const wn = rows.find(t => t.xref === f.wife && t.birtD == null);
        if (hn && wn && names.has(hn.name) && names.has(wn.name)) {
            await db.delete(fam).where(and(eq(fam.chatId, chatId), eq(fam.xref, f.xref))).run();
            await db.delete(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, f.xref))).run();
            stubDel++;
        }
    }
    // сами жертвы, их fams/chil, связи по ключам, кандидаты-свадьбы, фокус-строки
    for (const x of victims)
        await db.delete(indi).where(and(eq(indi.chatId, chatId), eq(indi.xref, x))).run();
    for (const fx of fams)
        await db.delete(fam).where(and(eq(fam.chatId, chatId), eq(fam.xref, fx))).run();
    const chConds = [];
    if (fams.length) chConds.push(inArray(chil.fam, fams));
    if (victims.size) chConds.push(inArray(chil.indi, [...victims]));
    if (chConds.length)
        await db.delete(chil).where(and(eq(chil.chatId, chatId), or(...chConds))).run();
    if (victimKeys.size)
        for (const k of victimKeys)
            await db.delete(edges).where(and(eq(edges.chatId, chatId),
                or(eq(edges.parent, k), eq(edges.child, k)))).run();
    for (const l of (await edgeRows(chatId)).filter(l => l.pairCand)) {
        const cur = JSON.parse(l.pairCand);
        // кандидаты-свадьбы с половинами-жертвами отваливаются (как в deleteEventCascade)
        const cand = cur.filter(c2 => !keyN(c2.pair).split("+").some(n => names.has(n)));
        if (cand.length !== cur.length)
            await db.update(edges).set({ pairCand: cand.length ? JSON.stringify(cand) : null })
                .where(and(eq(edges.chatId, chatId), eq(edges.id, l.id))).run();
    }
    for (const r of (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all()))
        if (victimKeys.has(r.pkey)) await db.delete(focusView).where(eq(focusView.id, r.id)).run();
    return { cut: victims.size, fams: fams.length + stubDel };
}

// правка ветви: цитируемый anchorKey — герой росписи tree. Молча: старая ветвь
// срезается (cutBranch), поля героя обновляются по строке героя росписи (имя и
// дата рождения правимы), новая ветвь прививается applyTree'ом. Цитируемый
// не найден — роспись применяется как есть (добавление merge'ем).
// Роспись РАДИУСА (chatFlatText по keys — .ged.txt третьего прицепа 🧬) несёт
// героя ВНУТРИ дерева (первым корнем идёт старший предок) и открывается
// меткой NOT_FOR_GRAFT: радиус не несёт всех потомков героя, прививка
// обновила бы связи лишь частично. Такая роспись отвергается — правки нет,
// ответ-ошибка предлагает родословную роспись -+= тапа «-+=». Мимо якоря метка резке
// мешает, а добавлению нет: merge росписи радиуса в чистый чат работает как прежде
export async function cutAndGraft(chatId, anchorKey, tree) {
    if (tree.noGraft) // метка NOT_FOR_GRAFT первой строкой (роспись радиуса)
        return { persons: 0, fams: 0, links: 0, errors: [], noGraft: true };
    const px = await xrefOfKey(chatId, anchorKey);
    if (!px) return { ...(await applyTree(chatId, tree)), cut: 0, famsCut: 0 };
    const heroIdx = tree.persons.findIndex(p => !p.spouseLine
        && p.rec.n + " " + p.rec.d === anchorKey);
    const root = rootOf(tree);
    if (heroIdx >= 0 && root && tree.persons.indexOf(root) !== heroIdx) {
        const rep = await applyTree(chatId, tree); // герой внутри росписи — merge без резки
        rep.cut = 0; rep.famsCut = 0;
        return rep;
    }
    const cut = await cutBranch(chatId, px,
        tree.persons.map(p => p.rec.n)); // свадьбы-заглушки пар росписи тоже срезаются
    if (!root) { await deleteEventCascade(chatId, anchorKey); }
    else if (root.rec.d !== undefined) // герой без даты — заглушка не замещает запись
        await setPersonByXref(chatId, px, Object.assign({ sex: root.sex, note: root.note }, root.rec));
    const rep = await applyTree(chatId, tree);
    await restoreEdges(chatId);
    return Object.assign(rep, { cut: cut.cut, famsCut: cut.fams });
}

// восстановление интерактивных связей (edges) после резки-прививки: у fam с
// детьми — по ребру на каждого реального родителя-половину; ребро
// (родитель → ребёнок) уже есть где-либо в чате — не дублируем
// (ВК-копия: lunarreturns.js, restoreEdges)
async function restoreEdges(chatId) {
    const rows = await indiRows(chatId);
    const keyOf = new Map(rows.filter(r => r.birtD != null).map(r => [r.xref, r.name + " " + r.birtD]));
    const edges_ = await edgeRows(chatId);
    for (const f of (await famRowsOf(chatId)).sort((a, b) => a.id - b.id)) {
        const kids = (await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, f.xref))).all())
            .map(r => r.indi).filter(x => keyOf.get(x));
        if (!kids.length) continue;
        for (const h of [f.husb, f.wife].filter(Boolean)) {
            if (!keyOf.get(h)) continue;
            for (const k of kids) {
                if (edges_.some(l => l.parent === keyOf.get(h) && l.child === keyOf.get(k))) continue;
                await db.insert(edges).values({ chatId, parent: keyOf.get(h), child: keyOf.get(k), who: "p", famXref: f.xref }).run();
                edges_.push({ parent: keyOf.get(h), child: keyOf.get(k) });
            }
        }
    }
}
// добавить связь родитель→ребёнок; who — кто из двоих пришёл новым триггером.
// Интерактивная семья — adhoc fam на ребёнка: второй родитель добирается в
// неё же (третий — отдельной fam); ребро уже есть — dup
export async function addLink(chatId, parentKey, childKey, who) {
    const same = (await edgeRows(chatId)).find(l => l.parent === parentKey && l.child === childKey);
    if (same) return { link: await linkRowOf(chatId, same), dup: true };
    const px = await xrefOfKey(chatId, parentKey), cx = await xrefOfKey(chatId, childKey);
    if (!px || !cx) return { link: null, dup: false };
    const Ch = t => [and(eq(chil.chatId, chatId), eq(chil.fam, t.xref), eq(chil.indi, cx))];
    // adhoc-семья ребёнка (первая по порядку, где он в chil)
    let adhocFam = null;
    for (const f of (await famRowsOf(chatId)).sort((a, b) => a.id - b.id)) {
        const found = await db.select().from(chil).where(...Ch(f)).all();
        if (f.adhoc && found.length) { adhocFam = f; break; }
    }
    let fx;
    const newAdhocFam = async () => {
        const x = await nextFamXref(chatId, "L");
        await db.insert(fam).values({ chatId, xref: x, adhoc: true, husb: px, wife: null }).run();
        await db.insert(chil).values({ chatId, fam: x, indi: cx }).run();
        return x;
    };
    if (!adhocFam) fx = await newAdhocFam();
    else if (adhocFam.husb === null) {
        await db.update(fam).set({ husb: px }).where(and(eq(fam.chatId, chatId), eq(fam.xref, adhocFam.xref))).run();
        fx = adhocFam.xref;
    } else if (adhocFam.wife === null) {
        await db.update(fam).set({ wife: px }).where(and(eq(fam.chatId, chatId), eq(fam.xref, adhocFam.xref))).run();
        fx = adhocFam.xref;
    } else fx = await newAdhocFam(); // оба места заняты — ещё один родитель отдельной fam
    if (adhocFam && adhocFam.xref === fx) {
        const has = await db.select().from(chil).where(...Ch({ xref: fx })).all();
        if (!has.length)
            await db.insert(chil).values({ chatId, fam: fx, indi: cx }).run(); // INSERT OR IGNORE
    }
    await db.insert(edges).values({ chatId, parent: parentKey, child: childKey, who, famXref: fx }).run();
    const link = (await edgeRows(chatId)).find(l => l.parent === parentKey && l.child === childKey);
    return { link: await linkRowOf(chatId, link), dup: false };
}

// все родители ребёнка в чате
export async function parentKeys(chatId, childKey) {
    return [...new Set((await edgeRows(chatId)).filter(l => l.child === childKey).map(l => l.parent))];
}

// удалить связь: ребро + chil семьи, когда других связей ребёнка в ней нет;
// опустевшая adhoc-семья без свадьбы уходит (пара с marr живёт — носитель)
export async function deleteLink(chatId, link) {
    await db.delete(edges).where(and(eq(edges.chatId, chatId), eq(edges.id, link.id))).run();
    if (link.famXref) {
        const cx = await xrefOfKey(chatId, link.c);
        const rest = cx ? (await edgeRows(chatId)).filter(l => l.famXref === link.famXref && l.child === link.c) : [];
        if (cx && !rest.length)
            await db.delete(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, link.famXref), eq(chil.indi, cx))).run();
        await normalizeFam(chatId, link.famXref);
    }
}
async function normalizeFam(chatId, fx) {
    const f = await getFam(chatId, fx);
    if (!f) return;
    const parents = [f.husb, f.wife].filter(Boolean).length;
    const kids = (await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, fx))).all()).length;
    const linksN = (await edgeRows(chatId)).filter(l => l.famXref === fx).length;
    if (parents === 0 || (kids === 0 && linksN === 0 && parents < 2 && !f.marrD)) {
        await db.delete(fam).where(and(eq(fam.chatId, chatId), eq(fam.xref, fx))).run();
        await db.delete(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, fx))).run();
    }
}

// кандидаты-свадьбы (интерактивное связывание): fam с marr, где половина
// имени — текущий родитель; когда у ребёнка два родителя — вторая половина
// другой родитель; свадьба позже рождения родителя (родителей); релевантные —
// по близости года свадьбы к году рождения ребёнка; при известном поле
// учитывается порядок в имени («первый — М, второй — Ж», как в confirmPair);
// свадьба уже на семье связи кандидатом не бывает
export async function pairRecords(chatId, link) {
    const cy = keyY(link.c), pn = keyN(link.p), out = [], seen = new Set();
    const persons = await personRows(chatId);
    const byKey = pk => persons.find(x => pkey(x) === pk);
    // половина пары согласуется с известным полом? (первая половина — М)
    const posMatch = (pk, isFirst) => {
        const r = byKey(pk);
        if (!r || !r.sex) return true;
        return r.sex === "M" ? isFirst : !isFirst;
    };
    const others = (await parentKeys(chatId, link.c)).filter(o => o !== link.p);
    for (const w of await weddingRows(chatId)) {
        if (w.fx === link.famXref) continue;
        const halves = w.n.split("+");
        const wy = keyY(pkey(w));
        if (others.length) {
            let hit = false;
            for (const o of others) {
                const a = halves[0] === pn && halves[1] === keyN(o);
                const b = halves[1] === pn && halves[0] === keyN(o);
                if (!a && !b) continue;
                if (!posMatch(link.p, halves[0] === pn) || !posMatch(o, halves[0] === keyN(o))) continue;
                if (wy <= keyY(link.p) || wy <= keyY(o)) continue;
                hit = true;
                if (!seen.has(pkey(w))) { seen.add(pkey(w)); out.push({ pair: pkey(w), other: o, wy, fx: w.fx }); }
            }
            if (!hit) continue;
        } else {
            // родитель пока один: кандидат — вторая половина «Имя+Имя», ключа у неё нет
            const i = halves.indexOf(pn);
            if (i !== 0 && i !== 1) continue;
            if (!posMatch(link.p, i === 0)) continue;
            if (wy <= keyY(link.p)) continue;
            if (seen.has(pkey(w))) continue;
            seen.add(pkey(w));
            out.push({ pair: pkey(w), other: i === 0 ? halves[1] : halves[0], wy, fx: w.fx });
        }
    }
    return out.sort((a, b) => Math.abs(a.wy - cy) - Math.abs(b.wy - cy)).slice(0, 5);
}

// заглушка без семьи и без детей — мусор после привязки свадьбы
async function dropStubIfOrphan(chatId, xref) {
    const i = await getIndi(chatId, xref);
    if (!i || i.birtD == null) return;
    if (await getFam(chatId, xref)) return;
    const famsRefTo = (await famRowsOf(chatId)).filter(x => x.husb === xref || x.wife === xref);
    if (famsRefTo.length) return;
    if ((await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.indi, xref))).all()).length) return;
    await db.delete(indi).where(and(eq(indi.chatId, chatId), eq(indi.xref, xref))).run();
}

// подтвердить свадьбу: marr/div кандидата крепится к семье связи точно
// (по xref, без угадывания имён); пара-заглушка без детей убирается вместе
// с заглушками; пол родителей — по порядку половин (первый — М, второй — Ж)
export async function confirmPair(chatId, link, cand) {
    const f = await getFam(chatId, link.famXref);
    if (!f) return null;
    const w = cand.fx ? await getFam(chatId, cand.fx) : null;
    if (w && w.xref !== f.xref) {
        const fps = new Set([f.husb, f.wife].filter(Boolean));
        const wps = [w.husb, w.wife].filter(Boolean);
        const wKids = (await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, w.xref))).all()).length;
        if (wps.length && wps.every(x => fps.has(x))) {
            // та же пара (другая fam): детей и связи переносим в неё, дубль уходит
            const kids = await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, f.xref))).all();
            for (const r of kids) {
                const has = await db.select().from(chil)
                    .where(and(eq(chil.chatId, chatId), eq(chil.fam, w.xref), eq(chil.indi, r.indi))).get();
                if (!has) await db.insert(chil).values({ chatId, fam: w.xref, indi: r.indi, adopted: r.adopted }).run();
            }
            for (const e of (await edgeRows(chatId)).filter(e => e.famXref === f.xref))
                await db.update(edges).set({ famXref: w.xref }).where(eq(edges.id, e.id)).run();
            await db.delete(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, f.xref))).run();
            await db.delete(fam).where(and(eq(fam.chatId, chatId), eq(fam.xref, f.xref))).run();
            link.famXref = w.xref;
            f.xref = w.xref;
        } else if (wKids === 0) {
            // пара-заглушка (или бездетная пара): marr/div переезжает, fam уходит
            await db.update(fam).set({ marrD: w.marrD, marrAbt: w.marrAbt ?? 0, marrPlac: w.marrPlac, divD: w.divD, divAbt: w.divAbt ?? 0, divPlac: w.divPlac })
                .where(and(eq(fam.chatId, chatId), eq(fam.xref, f.xref))).run();
            await db.delete(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, w.xref))).run();
            for (const e of (await edgeRows(chatId)).filter(e => e.famXref === w.xref))
                await db.update(edges).set({ famXref: null }).where(eq(edges.id, e.id)).run();
            await db.delete(fam).where(and(eq(fam.chatId, chatId), eq(fam.xref, w.xref))).run();
            for (const x of wps) await dropStubIfOrphan(chatId, x);
        } else {
            // семья с детьми (напр., из гедкома): копируем marr, её не трогаем
            await db.update(fam).set({ marrD: w.marrD, marrAbt: w.marrAbt ?? 0, marrPlac: w.marrPlac, divD: w.divD, divAbt: w.divAbt ?? 0, divPlac: w.divPlac })
                .where(and(eq(fam.chatId, chatId), eq(fam.xref, f.xref))).run();
        }
    }
    const [n1, n2] = cand.pair.slice(0, -11).split("+");
    for (const pk of [link.p, ...(await parentKeys(chatId, link.c))]) {
        const x = await xrefOfKey(chatId, pk);
        if (!x) continue;
        if (keyN(pk) === n1) await db.update(indi).set({ sex: "M" }).where(and(eq(indi.chatId, chatId), eq(indi.xref, x))).run();
        else if (keyN(pk) === n2) await db.update(indi).set({ sex: "F" }).where(and(eq(indi.chatId, chatId), eq(indi.xref, x))).run();
    }
    await db.update(edges).set({ pairCand: null }).where(and(eq(edges.chatId, chatId), eq(edges.id, link.id))).run();
    link.pairCand = null;
    return famView(chatId, f.xref);
}

// очистить дерево чата (замена при импорте; настройки остаются)
export async function clearChatTree(chatId) {
    await db.delete(indi).where(eq(indi.chatId, chatId)).run();
    await db.delete(fam).where(eq(fam.chatId, chatId)).run();
    await db.delete(chil).where(eq(chil.chatId, chatId)).run();
    await db.delete(edges).where(eq(edges.chatId, chatId)).run();
}

// удалить событие с каскадом: связи персоны; у пары «Имя+Имя» — свадьба/развод
// с семей; висячие кандидаты-свадьбы у оставшихся связей; пустые семьи чистятся
export async function deleteEventCascade(chatId, key) {
    const name = key.slice(0, -11), d = key.slice(-10);
    const person = (await indiRows(chatId)).find(r => r.name === name && r.birtD === d);
    if (person) {
        const x = person.xref;
        const fams = new Set((await edgeRows(chatId))
            .filter(l => l.parent === key || l.child === key)
            .map(l => l.famXref).filter(Boolean));
        await db.delete(edges).where(and(eq(edges.chatId, chatId),
            or(eq(edges.parent, key), eq(edges.child, key)))).run();
        await db.delete(chil).where(and(eq(chil.chatId, chatId), eq(chil.indi, x))).run();
        await db.update(fam).set({ husb: null }).where(and(eq(fam.chatId, chatId), eq(fam.husb, x))).run();
        await db.update(fam).set({ wife: null }).where(and(eq(fam.chatId, chatId), eq(fam.wife, x))).run();
        // сама запись удаляется: «Событие удалено» — персона целиком (раньше
        // строка оставалась и персон показывали поиск/списки/роспись/гедком)
        await db.delete(indi).where(and(eq(indi.chatId, chatId), eq(indi.xref, x))).run();
        for (const fx of fams) await normalizeFam(chatId, fx);
    } else if (name.includes("+")) {
        // свадьба «Имя1+Имя2 Д»: снять marr/div с семей с этой датой и половиной
        const [n1, n2] = name.split("+");
        const nameOf = new Map((await indiRows(chatId)).map(r => [r.xref, r.name]));
        for (const f of (await famRowsOf(chatId)).filter(r => r.marrD === d)) {
            const hn = f.husb ? nameOf.get(f.husb) : null;
            const wn = f.wife ? nameOf.get(f.wife) : null;
            if (hn === n1 || hn === n2 || wn === n1 || wn === n2)
                await db.update(fam).set({ marrD: null, marrAbt: 0, marrPlac: null, divD: null, divAbt: 0, divPlac: null })
                    .where(and(eq(fam.chatId, chatId), eq(fam.xref, f.xref))).run();
        }
    }
    for (const l of (await edgeRows(chatId)).filter(l => l.pairCand)) {
        const cur = JSON.parse(l.pairCand);
        const cand = cur.filter(c2 => c2.pair !== key && !keyN(c2.pair).split("+").includes(name));
        if (cand.length !== cur.length)
            await db.update(edges).set({ pairCand: cand.length ? JSON.stringify(cand) : null })
                .where(and(eq(edges.chatId, chatId), eq(edges.id, l.id))).run();
    }
}

// пол персоны по xref (кнопки ♂/♀ сообщения-связи)
export async function setIndiSex(chatId, xref, sex) {
    await db.update(indi).set({ sex: sex === 'F' ? 'F' : 'M' })
        .where(and(eq(indi.chatId, chatId), eq(indi.xref, xref))).run();
}

// усыновление: toggle флага adopted у ребёнка (xref) в семье связи
export async function toggleAdopted(chatId, link) {
    const cx = await xrefOfKey(chatId, link.c);
    if (!link.famXref || !cx) return false;
    const row = await db.select().from(chil)
        .where(and(eq(chil.chatId, chatId), eq(chil.fam, link.famXref), eq(chil.indi, cx))).get();
    if (!row) return false;
    const nv = !row.adopted;
    await db.update(chil).set({ adopted: nv })
        .where(and(eq(chil.chatId, chatId), eq(chil.fam, link.famXref), eq(chil.indi, cx))).run();
    return nv;
}

// текст сообщения-связи: строки связи (+ семья/вопрос), без юбилеев события —
// гедком-фрагмент добавляется отдельно (gedcomText с ключами)
export async function linkText(chatId, link) {
    let t = "🔗 Родитель: " + link.p + " → ребёнок: " + link.c + (link.adopted ? " 🤱 (усыновление)" : "");
    if (link.famXref) {
        const f = await famView(chatId, link.famXref);
        if (f) t += "\n🧬 " + f.parents.map(keyN).join("+") + " — родители: " + keyN(link.c)
            + (f.marr ? " (свадьба " + f.marr.d + (f.marr.plac ? ", " + f.marr.plac : "") + ")" : "")
            + (f.div ? " (развод " + f.div.d + ")" : "");
    }
    if (link.pairCand && link.pairCand.length) {
        if (link.pairCand.length === 1)
            t += "\n🧬 Свадьба его родителей: " + link.pairCand[0].pair + "?";
        else
            t += "\n🧬 Свадьба его родителей?\n"
                + link.pairCand.map((k, i) => (i + 1) + ") " + k.pair).join("\n");
    }
    return t;
}

// клавиатура сообщения-связи: ♂/♀ для нового лица, Да/Нет или 1 2… Нет для пары;
// 👎 — удалить связь (ВК: реакция 👎); callback_data короткие: id связи
export async function linkMarkup(chatId, link) {
    const btn = (text, data) => ({ text, callback_data: data });
    const rows = [[btn("👎", "dell:" + link.id)], [btn("🤱", "adop:" + link.id)]];
    const rec = await recordOf(chatId, link[link.who === 'p' ? 'p' : 'c']);
    if (rec && !rec.sex)
        rows.push([btn("♂", "sex:" + link.id + ":M"), btn("♀", "sex:" + link.id + ":F")]);
    if (link.pairCand && link.pairCand.length) {
        const btns = link.pairCand.length === 1
            ? [btn("Да", "pair:" + link.id + ":0")]
            : link.pairCand.map((k, i) => btn(String(i + 1), "pair:" + link.id + ":" + i));
        btns.push(btn("Нет", "pair:" + link.id + ":-1"));
        rows.push(btns);
    }
    return { inline_keyboard: rows };
}

// ============================== ВЫВОД: сегодня/список ==============================

// события чата на сегодня (МСК) + религиозный дайджест; "" — ничего
export async function todayText(chatId) {
    const [, mo, d] = mskToday();
    const mmdd = String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    const rows = [...await personRows(chatId), ...await weddingRows(chatId)]
        .filter(r => r.d.slice(5) === mmdd && !r.abt && !r.mabt);
    const parts = rows.map(r => jubileeText(r, ""));
    const digest = religiousDigest(await getSettings(chatId));
    if (digest) parts.push(digest);
    return parts.join("\n\n");
}

// «Имя ГГГГ-ММ-ДД[ ГГГГ-ММ-ДД смерти][ ЧЧ:ММ]»; "" — событий нет.
// формат, фильтр примерных и порядок (круговой «от сегодня» / по полной
// дате) — канон eventListText из './tree.cjs' (с A3, общий с ВК);
// здесь только выборка БД
export async function upcomingText(chatId, byFullDate = false, mmddNow = "") {
    return eventListText([...await personRows(chatId), ...await weddingRows(chatId)], byFullDate, mmddNow);
}

// сегодняшний MM-DD по МСК — отсечка «от сегодня» для списков колокольчика
export function mmddToday() {
    const [, mo, d] = mskToday();
    return String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

// кнопки под ответом на триггер и под найденной одним попаданием персоной:
// ряд 1 — цифры радиуса (по фактической глубине focusDepth, радиус 1 скрыт)
// и 👎 — удалить событие (как реакция 👎 в VK-боте); ряд 2 — 👀/🌙 тоггл
// детальности, 🔔/🧬/-+= в радиусе 1 (callback_data — xref; фок-кнопки
// работают через строку focus_view, которую вставляет отправитель);
// handlers/callback_query.js det:/mon:; у свадьбы (wed) цифры/🔔/🧬/-+=
// бессмысленны (пара-заглушка) — один ряд [👀|🌙 👎 ❌]
export function jubileeMarkup(xref, depth, detail = false, wed = false) {
    const btn = (text, data) => ({ text, callback_data: data });
    if (wed) return { inline_keyboard: [[
        btn(detail ? "🌙" : "👀", (detail ? "mon:" : "det:") + xref),
        btn("👎", "del1:" + xref), btn("❌", "close"),
    ]] };
    const digits = [2, 3, 4, 5]
        .filter(n => n <= (depth === undefined ? 5 : depth))
        .map(n => btn(String(n), "foc" + n));
    return {
        inline_keyboard: [
            [...digits, btn("👎", "del1:" + xref)],
            [btn(detail ? "🌙" : "👀", (detail ? "mon:" : "det:") + xref),
                btn("🔔", "focbell"), btn("🧬", "foctree"), btn("-+=", "focflat"), btn("❌", "close")],
        ]
    };
}

// админ ли пользователь в чате (в личке — да, роли нет)
export async function chatAdmin(chat, userId) {
    if (!chat || chat.type === 'private') return true;
    if (!userId) return false;
    try {
        const m = await api.getChatMember({ chat_id: chat.id, user_id: userId });
        return !!m && (m.status === 'creator' || m.status === 'administrator');
    } catch (e) {
        console.error('getChatMember:', e.message);
        return false;
    }
}

// клавиатура /start: личка — полная, админ группы — ownerMarkup, участник — bellMarkup
// (паритет VK: relKeyboard/ownerKeyboard/bellMarkup); колокольчик всегда 🔔
export function startMarkup(chat, isAdmin, chatId, s) {
    if (chat.type === 'private') return relMarkup(chatId, s);
    return isAdmin ? ownerMarkup() : bellMarkup();
}

// фокус-родня: чистая логика (focusKeys…focusListKeys, focusDepth,
// famsByGenerations) — общий канон tgcloud/lib/tree.cjs
// супруги персон чата: fam с двумя датированными родителями — пары точные
// (по xref); интерактивные свадьбы-заглушки без персон сюда не попадают —
// привязываются confirmPair'ом (раньше «по первому имени» и тёзки ловили
// чужие свадьбы)
export async function focusSpousePairs(chatId) {
    return (await famList(chatId)).filter(f => f.parents.length === 2).map(f => f.parents);
}

// подпись радиуса в тостах фокус-кнопок (цифры и 🧬): «диапазон» уровня —
// как в колонке чарта у героя (rangeLevel)
export const focusLabel = rangeLevel;

// заголовок фокус-сообщения; dd — дата смерти/развода, если есть;
// радиус — цифрой перед ключом
export const focusHead = (key, radius, dd) =>
    String(radius) + " " + key + (dd ? " " + dd : "");

// список событий по множеству фокуса (focusListText) — канон tgcloud/lib/tree.cjs
// (с A3): формат строки и сортировки общие с ВК; handlers берут его реэкспортом ниже,
// копий больше нет.

// клавиатура фокус-сообщения: как /start по роли, но без кнопок религий,
// 🔔/🧬 действуют в радиусе, а в ряд с ❌ добавлены неактивные цифры радиуса
// (активная скрыта; цифра r выводится, если есть предки глубины r — depth
// = focusDepth; grace при старом вызове без depth — все цифры);
// колокольчик всегда 🔔 (подписки нет — список всегда «от сегодня»);
// с xref — единая раскладка с юбилеем (jubileeMarkup): ряд 1 [цифры 👎],
// ряд 2 [👀|🌙 🔔 🧬 -+= ❌] — новые кнопки не отпадают после тапа по
// 🔔/🧬/-+=/цифре на сообщении-юбилее
export function focusMarkup(chat, chatId, s, radius, depth, xref, detail = false) {
    const btn = (text, data) => ({ text, callback_data: data });
    const bell = btn("🔔", "focbell");
    const tree = btn("🧬", "foctree");
    const flat = btn("-+=", "focflat");
    const digits = [1, 2, 3, 4, 5]
        .filter(n => n !== radius && n <= (depth === undefined ? 5 : depth))
        .map(n => btn(String(n), "foc" + n));
    if (xref) {
        const row1 = [...digits, btn("👎", "del1:" + xref)];
        const row2 = [btn(detail ? "🌙" : "👀", (detail ? "mon:" : "det:") + xref), bell, tree, flat, btn("❌", "close")];
        return { inline_keyboard: [row1, row2] };
    }
    // цифры (радиус — только 🔔/🧬) своим рядом; 🔔 🧬 -+= ❌ — вторым;
    // цифр нет (глубина 1) — один ряд, пустой ряд не выводим
    const base = [bell, tree, flat, btn("❌", "close")];
    return { inline_keyboard: digits.length ? [digits, base] : [base] };
}

// разбить длинный текст на куски < 4000 по границам строк (как splitText VK)
export function splitText(text, MAX = 4000) {
    if (text.length <= MAX) return [text];
    const parts = [];
    let rest = text;
    while (rest.length > MAX) {
        let cut = rest.lastIndexOf("\n", MAX);
        if (cut < MAX / 2) cut = MAX;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, "");
    }
    if (rest) parts.push(rest);
    return parts;
}

// ============================== ГЕДКОМ: экспорт ==============================

// GEDCOM 5.5.1 по чату — выгрузка дерева: INDI из персон (плюс заглушки-
// супруги без даты — без BIRT), FAM из семей (усекаются до выбранных
// персон; одна строка fam БД — ровно одна FAM, без схлопывания по ключам:
// у бездатных половин ключа нет, и семьи разных жён одного мужа сливаться
// не должны). keys — необязательный набор персон: фрагмент только по ним (для
// сообщений-связей)
export async function gedcomText(chatId, keys) {
    const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const gdate = d => { const [y, mo, dd] = d.split("-").map(Number); return dd + " " + MON[mo - 1] + " " + y; };
    // хвост-метка заглушки «Имя ~xref» живёт в БД для уникальности ключей
    // печатей (росписи/древо), но в гедкоме избыточен — xref и так в
    // идентикаторе INDI @…@; в NAME метку снимаем (реимпорт восстановит её
    // из файлового xref — круглый trip остаётся идемпотентным)
    const cleanName = n => n.replace(/ ~\S+$/, "");
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
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const persons = (await personRows(chatId)).filter(r => !hasKeys || keys.includes(pkey(r)));
    const idOf = new Map(persons.map(r => [r.xref, r.xref]));
    const sexOf = new Map(persons.map(r => [r.xref, r.sex || null]));
    // усыновления: xref ребёнка → xref семьи (chil.adopted)
    const adoptedOf = new Map();
    for (const c of (await chilRows(chatId)).filter(x => x.adopted)) adoptedOf.set(c.indi, c.fam);
    // fam-строки в {xref, par — [{x, k}] датированные половины (k — ключ,
    // только для фильтра фрагмента), stubs — бездатные супруги, kstubs —
    // бездатные дети, chd — датированные дети, marr, div}: семьи НЕ схлопываются
    // — каждая строка fam БД даёт ровно одну FAM (у двух жён одного мужа
    // остаются две FAM, а не один FAM с двумя WIFE)
    const fams = [];
    for (const f of (await famRowsOf(chatId)).sort((a, b) => a.id - b.id)) {
        const par = [], chd = [], stubs = [], kstubs = [];
        const stubOfX = async x => {
            const i = await getIndi(chatId, x);
            if (!i || !i.name) return null;
            return { xref: x, name: i.name, sex: i.sex || null, deat: i.deatD || null, dp: i.deatPlac || null,
                dabt: i.deatD ? i.deatAbt || 0 : 0, note: i.note || null };
        };
        for (const x of [f.husb, f.wife]) {
            if (!x) continue;
            const k = await keyOfXref(chatId, x);
            if (k) par.push({ x, k });
            else {
                const st = await stubOfX(x);
                if (st) stubs.push(st);
            }
        }
        for (const r of (await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, f.xref))).all()).sort((a, b) => a.id - b.id)) {
            const k = await keyOfXref(chatId, r.indi);
            if (k) chd.push({ x: r.indi, k });
            else {
                const st = await stubOfX(r.indi);
                if (st) kstubs.push(st);
            }
        }
        const marr = f.marrD ? { d: f.marrD, ...(f.marrAbt ? { abt: f.marrAbt } : {}), ...(f.marrPlac ? { plac: f.marrPlac } : {}) } : null;
        const div = f.divD ? { d: f.divD, ...(f.divAbt ? { abt: f.divAbt } : {}), ...(f.divPlac ? { plac: f.divPlac } : {}) } : null;
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
    // и метки «~xref» в именах заглушек
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
        out.push("0 @" + idOf.get(r.xref) + "@ INDI");
        out.push("1 NAME " + cleanName(r.n));
        if (r.sex) out.push("1 SEX " + r.sex);
        out.push("1 BIRT", "2 DATE " + gdateAbt(r.d, r.abt));
        if (r.srcH !== undefined) out.push("2 TIME " + String(r.srcH).padStart(2, "0") + ":" + String(r.srcM).padStart(2, "0"));
        if (r.plac) out.push("2 PLAC " + r.plac);
        if (r.dd) {
            out.push("1 DEAT", "2 DATE " + gdateAbt(r.dd, r.dabt));
            if (r.dsrcH !== undefined) out.push("2 TIME " + String(r.dsrcH).padStart(2, "0") + ":" + String(r.dsrcM).padStart(2, "0"));
            if (r.dp) out.push("2 PLAC " + r.dp);
        }
        // NOTE с переносами («^») — построчно: 1 NOTE + 2 CONT на строку
        if (r.note) {
            const segs = r.note.split("^");
            for (let i = 0; i < segs.length; i++)
                out.push((i ? "2 CONT " : "1 NOTE ") + segs[i]);
        }
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
        out.push("0 @" + stubId.get(x) + "@ INDI");
        out.push("1 NAME " + cleanName(st.name));
        if (st.note) st.note.split("^").forEach((s, i) => out.push((i ? "2 CONT " : "1 NOTE ") + s));
        if (st.sex) out.push("1 SEX " + st.sex);
        if (st.deat) {
            out.push("1 DEAT", "2 DATE " + gdateAbt(st.deat, st.dabt));
            if (st.dp) out.push("2 PLAC " + st.dp);
        }
        for (const f of fams) {
            if (f.stubs.some(s => s.xref === x)) out.push("1 FAMS @" + fidOf.get(f) + "@");
            if (f.kstubs.some(s => s.xref === x)) out.push("1 FAMC @" + fidOf.get(f) + "@");
        }
    }
    for (const f of fams) {
        out.push("0 @" + fidOf.get(f) + "@ FAM");
        // по практике 5.5.1: сначала HUSB, затем WIFE; пол заглушек — из записи
        const all = [
            ...f.par.map(p => ({ ref: idOf.get(p.x), sex: sexOf.get(p.x) })),
            ...f.stubs.map(s => ({ ref: stubId.get(s.xref), sex: s.sex || null })),
        ];
        for (const x of all.filter(x => x.sex !== "F")) out.push("1 HUSB @" + x.ref + "@");
        for (const x of all.filter(x => x.sex === "F")) out.push("1 WIFE @" + x.ref + "@");
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
        // NOTE с переносами — построчно (как у персон)
        if (f.fnote) {
            const segs = f.fnote.split("^");
            for (let i = 0; i < segs.length; i++)
                out.push((i ? "2 CONT " : "1 NOTE ") + segs[i]);
        }
    }
    out.push("0 TRLR");
    return out.join("\n");
}

// ============================== РОДОСЛОВНАЯ РОСПИСЬ -+=: вывод ==============================
// Родословная роспись -+= чата (ввод/вывод симметричны, как Romanov_family.txt):
// '-'×n — свой мужчина глубины n−1; '='×n — своя женщина; «+»×n (n−1 —
// глубина владельца) — свадьба, вторая половина — строкой ниже без маркера
// (пол выводится); одностороняя семья — «+»×n сама по себе; дети — глубина пары+1; заглушки
// (без события) — именные строки. Показ — тапом на колокольчик (🔔/🔕).
// Примечание — с маркером «^» (см. грамматику пакета в tgcloud/lib/parse.cjs).
// Чистая логика дословно продублирована в lunarreturns.js (dev/sync-check.mjs).

// fam в виде полу: hKey/wKey — xref реальных персон, hName/wName — имена
// заглушек (супруг без записи), children — xref детей, marr/div/note;
// строки персон/семей чата — общий вход chatFlatText и branchFlatText
async function flatRows(chatId) {
    const rows = (await indiRows(chatId)).sort((a, b) => a.id - b.id);
    const persons = rows.map(r => ({
        key: r.xref, name: r.name, sex: r.sex || null,
        d: r.birtD ?? undefined, dd: r.deatD ?? undefined,
        h: r.birtH ?? undefined, m: r.birtM ?? undefined,
        srcH: r.srcH ?? undefined, srcM: r.srcM ?? undefined,
        plac: r.plac ?? undefined, dp: r.deatPlac ?? undefined,
        note: r.note ?? undefined, nameOnly: r.birtD == null,
        abt: r.birtAbt ?? undefined, dabt: r.deatAbt || undefined,
    }));
    const fams = [];
    for (const f of (await famRowsOf(chatId)).sort((a, b) => a.id - b.id)) {
        const F = { xref: f.xref, hKey: null, hName: null, wKey: null, wName: null, children: [], marr: null, div: null, note: f.note || null };
        for (const x of [f.husb, f.wife]) {
            if (!x) continue;
            const r = await getIndi(chatId, x);
            if (!r) continue;
            // сторона по полу (как в гедкоме: без пола — мужская); занятая — на свободную
            if (r.sex === "F" && F.wKey == null) F.wKey = x;
            else if (F.hKey == null) F.hKey = x;
            else if (F.wKey == null) F.wKey = x;
        }
        for (const r of (await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, f.xref))).all()).sort((a, b) => a.id - b.id)) {
            const i = await getIndi(chatId, r.indi);
            if (i) F.children.push(r.indi);
        }
        F.marr = f.marrD ? { d: f.marrD, ...(f.marrAbt ? { abt: f.marrAbt } : {}), ...(f.marrPlac ? { plac: f.marrPlac } : {}) } : null;
        F.div = f.divD ? { d: f.divD, ...(f.divAbt ? { abt: f.divAbt } : {}), ...(f.divPlac ? { plac: f.divPlac } : {}) } : null;
        fams.push(F);
    }
    // поколения до построения росписи: семьи родителей раньше семей детей
    // (см. famsByGenerations) — familyOf (первая семья ребёнка), «mine»
    // (порядок браков) и famsDone не зависят от порядка вставки семей
    const famsOrd = famsByGenerations(fams,
        f => [f.hKey, f.wKey].filter(k => k != null), f => f.children);
    for (let i = 0; i < fams.length; i++) fams[i] = famsOrd[i];
    return [persons, fams];
}

// метка росписи РАДИУСА (chatFlatText по keys — .ged.txt третьего прицепа 🧬):
// герой посередине, радиус не несёт всех потомков героя — для резки-прививки
// такая роспись не годится. parseTree (tgcloud/lib/parse.cjs) читает метку
// первой непустой строкой в tree.noGraft, cutAndGraft её отвергает;
// строки «#» парсер росписи пропускает как комментарии — состав не меняется
export const NOT_FOR_GRAFT = "#not for cut and graft";

export async function chatFlatText(chatId, keys = null) {
    // keys (опционально) — фокус-радиус: роспись только этого подмножества
    // (сродни gedcomText); семьи фильтруются по касанию персон/детей
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const [allPersons, allFams] = await flatRows(chatId);
    const persons = allPersons.filter(p => !hasKeys
        || keys.includes(p.name + " " + (p.d ?? "")));
    if (!hasKeys) return flatTreeText(persons, allFams, true); // canonical — рецепт порядка
    const kOf = new Map(allPersons.map(p => [p.key, p.name + " " + (p.d ?? "")]));
    // роспись радиуса — тот же канонический рецепт, что и у целого древа:
    // порядок больше не «героевоцентричный» (герой посередине), семьи —
    // по дате свадьбы/старшему супругу. Для резки-прививки не годится всё
    // равно: первой строкой метка NOT_FOR_GRAFT, parseTree читает её в
    // tree.noGraft, cutAndGraft такую роспись отвергает
    return NOT_FOR_GRAFT + "\n" + flatTreeText(persons, allFams.filter(f =>
        [f.hKey, f.wKey, ...f.children].some(k => k != null
            && keys.includes(kOf.get(k) || ""))), true);
}

// чистые подмножества росписи ветви героя: fams, где герой/потомок является
// половиной (его браки, рекурсивно до листьев); вторые половины включаются в
// печать, но ветвь НЕ продолжают — другие семьи супруга в ветвь не годятся;
// extraKids — интерактивные связи (edges, «родитель→ребёнок»): потомки
//

// карта интерактивных связей «родитель(xref) → [дети xref]» по edges
export async function edgeKids(chatId) {
    const rows = (await indiRows(chatId));
    const xOf = new Map(rows.map(r => [r.name + " " + r.birtD, r.xref]));
    const kids = new Map();
    for (const l of await edgeRows(chatId)) {
        const c = xOf.get(l.child);
        if (!c) continue;
        const p = xOf.get(l.parent);
        if (!p) continue;
        if (!kids.has(p)) kids.set(p, []);
        if (!kids.get(p).includes(c)) kids.get(p).push(c);
    }
    return kids;
}

// роспись ветви персоны key («Имя ГГГГ-ММ-ДД»): поддерево потомков на всю
// глубину (семьи + интерактивные связи), герой — корневой строкой
// «-»×1/«=»×1; ввод/вывод симметричны
export async function branchFlatText(chatId, key) {
    const [allPersons, allFams] = await flatRows(chatId);
    const x = (allPersons.find(p => p.name + " " + (p.d ?? "") === key) || {}).key;
    if (x == null) return "";
    const [picked, fams] = subsetBranch(allPersons, allFams, x, await edgeKids(chatId));
    // герой — первой строкой росписи ветви (корень разбора): переставляем
    // его вперёд массива персон — корни flatTreeText визитуются
    // в порядке массива
    const hi = picked.findIndex(p => p.key === x);
    const persons = hi > 0 ? [picked[hi], ...picked.slice(0, hi), ...picked.slice(hi + 1)] : picked;
    return flatTreeText(persons, fams);
}

// fam в виде полу: hName/wName — имена заглушек ...
// fams of slot; чистая логика — дословно в обеих копиях.
// canonical (рецепт порядка, только полная роспись): семьи — по дате свадьбы,
// без даты — по дате рождения старшего супруга; дети в семье — по возрасту;
// браки одной персоны — по тому же ключу; корни-владельцы семей — в порядке
// их семей; плавающие и остаток — по возрасту. Росписи радиуса и ветви героя
//

// поиск по родословной росписи -+= (chatFlatText): "/Иван" — префикс от начала
// строки (ведущие маркеры '-'/'='/'+' строк сняты); "/-Пётр" — только мужчины
// глубины 0, "/--Иван" — глубины 1, "/=…" — женщины (серия маркеров запроса
// должна совпасть с серией строки); "/ текст" — подстрока в строке без
// маркера; "/-", "/==", "/++" — все строки с такой серией маркеров (все
//

// ==================== поиск: единственное попадание → фокус ====================

// строку-попадание поиска «/Имя» в персону {n, d}: маркеры сняты, хвост
// (даты/время, место «(…)», примечание «^…») отрезается — имя до первого
// такого токена; строка свадьбы («+…» или начинающаяся с даты/места)
//

// ключ персоны (из persons = personRows(chatId)) по строке-попаданию —
// для фокус-панели вместо списка; имя разыскивается дословно, дата — через
// approxOut (приблизительнные и урезанные даты совпадают по печати);
// не резолвится (не персона, имя не найдено, дата не совпала, тёзка без
//

// ============================== ГЕДКОМ → PDF ==============================
// Чистая логика дословно продублирована в lunarreturns.js (dev/sync-check.mjs)

import { InputFile } from 'sdk';
import { CHART_MAX, chartPdf, chartRows, chartFont, fileBaseOf, rangeLevel } from './chart.cjs';

// диаграммные данные чата/фрагмента (как у gedcomText: те же INDI, свадьбы
// «Имя+Имя» вне; семьи усекаются до персон фрагмента). heroKey — pkey героя
// (персона фокуса): ярлыки родства «Связь год» в колонке подписей; без героя
// — просто «Год» (древо чата). Бездатные именованные супруги датированных
// персон — строками с якорем (бар от года ДР супруга, колонка года пустая);
// без датированного супруга — не рисуются
export async function chartFor(chatId, keys, title, heroKey = null, range = null) {
    const snapshot = await flatRows(chatId);
    const pairs = await linkPairs(chatId), spousePairs = await focusSpousePairs(chatId);
    const annotationText = createFlatAnnotationText(snapshot, pairs, spousePairs);
    const xOf = new Map(snapshot[0].filter(p => p.d != null).map(p => [p.name + " " + p.d, p.key]));
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const persons = (await personRows(chatId)).filter(r => !hasKeys || keys.includes(pkey(r)));
    const keySet = new Set(persons.map(r => pkey(r)));
    let rows = persons.map(r => ({ xref: xOf.get(pkey(r)), name: r.n, birth: r.d, death: r.dd || null, sex: r.sex || null, abt: r.abt ?? 0 }));
    const stubSpouses = [];
    // якоря бездатных: год ДР датированного супруга (первой семьи по порядку)
    const stubs = (await indiRows(chatId)).filter(r => r.birtD == null && r.name !== "");
    const stubOf = new Map(stubs.map(r => [r.xref, r]));
    const anchor = new Map(); // xref бездатного → { yr, spKey, fam }
    for (const f of (await famRowsOf(chatId)).sort((a, b) => a.id - b.id)) {
        for (const [a, b] of [[f.husb, f.wife], [f.wife, f.husb]]) {
            if (!a || !b || !stubOf.has(a) || anchor.has(a)) continue;
            const sp = await getIndi(chatId, b);
            if (sp && sp.birtD != null)
                anchor.set(a, { yr: Number(sp.birtD.slice(0, 4)), spKey: sp.name + " " + sp.birtD, fam: f.xref });
        }
    }
    // явные ключи бездатных «Имя якорь»: суффиксы « » строит сам chartModel
    // (ключи датированных — «Имя полная дата», с «Имя якорь» не пересекаются);
    // taken — для коллизий одноимённых заглушек на одном якорном году
    const taken = new Set();
    for (const r of persons) taken.add(r.n + " " + r.d);
    const famStubKey = new Map();   // fam.xref → ключ бездатного супруга в чарте
    for (const [x, an] of anchor) {
        if (hasKeys && !keys.includes(an.spKey)) continue;
        const s = stubOf.get(x);
        let k = s.name + " " + an.yr;
        while (taken.has(k)) k += " ";
        taken.add(k);
        stubSpouses.push([an.spKey, k]);
        if (!famStubKey.has(an.fam)) famStubKey.set(an.fam, k);
        rows.push({ xref: x, name: s.name, k, birth: null, anchor: an.yr, death: s.deatD || null, sex: s.sex || null });
    }
    // родители ребёнка: датированные, вошедшие в чарт + бездатный супруг
    // (свой ключ «Имя якорь»); fill ds/sk, ключ бездатного не под ckey
    const parentsOf = new Map();    // ребёнок (ключ «Имя ГГГГ-…») → { ds, sk }
    for (const f of await famList(chatId)) {
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
    // ключи датированных — pkey как есть («Имя ГГГГ-ММ-ДД»); бездатный
    // супруг под ckey не проходит (свой «Имя якорь»)
    const ckey = k => k;
    let links = [...parentsOf].filter(([, ps]) => ps.ds.length || ps.sk)
        .map(([c, ps]) => ({ child: ckey(c), parents: [...ps.ds.map(ckey), ...(ps.sk ? [ps.sk] : [])] }));
    // ярлыки родства — как в 🔔-списке (focusListText): linkPairs +
    // супруги fam-семей + пол; подписи в чарте всё равно «Связь год»;
    // диапазон героя rel.range (цифра кейапа заголовка, 4⃣ … → 4) — из sendGedPdf
    const hero = heroKey ? ckey(heroKey) : null;
    const rel = hero ? {
        hero,
        range,
        fynny: (await getSettings(chatId)).fynny,
        pairs: pairs.map(([p, c]) => [ckey(p), ckey(c)]),
        spouses: [...spousePairs.map(sp => sp.map(ckey)), ...stubSpouses],
        sex: Object.fromEntries([...(await personRows(chatId)).map(r => [pkey(r), r.sex || null]),
            ...rows.filter(r => r.k).map(r => [r.k, r.sex])]),
    } : null;
    rows = chartRows(rows, rel);
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
    const bornOf = new Map((await personRows(chatId)).map(r => [pkey(r), r.d]));
    const phantoms = [];
    const marriages = [];           // свадьбы с датой: { fam: [ключ, ключ], year };
                                    // один супруг в чарте — fam: [ключ] (зарубка)
    for (const f of await famList(chatId)) {
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
                    birth: bornOf.get(c), abt: snapshot[0].find(p => p.key === xOf.get(c))?.abt ?? 0 },
            })) });
    }
    return { pdf: chartPdf(title, rows, links, chartFont(), { ...rel, phantoms }, marriages, annotationText), persons: Math.min(rows.length, CHART_MAX) };
}

// тап 🧬 / «/gedcom» / «/gedcomN»: <имя>.ged всегда, <имя>.pdf (диаграмма,
// имя из заголовка fileBaseOf); heroKey — pkey героя для колонки «Связь год»;
// неудача выкладки — только сообщение об ошибке, гедком текстом не дублируем
// Радиусный вызов (keys — ромб родни: тап 🧬 на фокусе и /gedcomN в ответ
// на триггер): третий файл <имя>.ged.txt — роспись того же радиуса
// (chatFlatText по keys): форма «-+=», но не только вниз — и вверх, и вниз,
// в пределах радиуса; всему древу чата росписи нет (его «-+=» и так весь).
// markup — клавиатура, которую надо сохранить при правке текста росписью
// (editMessageText без reply_markup в TG клавиатуру снимает)
export async function sendGedPdf(chatId, keys, head, heroKey = null, replyTo = 0, markup = undefined) {
    // заголовок чарта без цифры радиуса;
    // цифра → range героя для chartFor
    const head0 = head || "Гедком-древо";
    const chartHead = head0.replace(/^\d\s+/, "");
    const rm = /^(\d)\s/.exec(head0);
    const base = fileBaseOf(head0);
    // третий файл (радиусные 🧬 и /gedcomN): роспись радиуса — chatFlatText по keys;
    // она идёт только файлом (роспись <4000 — текстом правки сообщения)
    let packFinal = null;
    try {
        const g = await gedcomText(chatId, keys);
        const pack = Array.isArray(keys) && keys.length ? await chatFlatText(chatId, keys) : "";
        const enc = new TextEncoder();
        // BOM — чтобы Windows-редакторы открывали роспись как UTF-8;
        // роспись <4000: правим сообщение с 🔗/🧬-кнопками — текст = роспись
        // (клавиатура сообщения сохраняется), документы отправляем по готовности
        const packFits = !!pack && (heroKey ? head.length + 1 : 0) + pack.length + "\n⏳".length < 4000;
        if (pack && !packFits && heroKey && replyTo) {
            const lines = pack.split("\n").filter((l, i) => !(i === 0 && l.trim().toLowerCase().startsWith(NOT_FOR_GRAFT.toLowerCase())));
            const inner = cutLines(lines.join("\n"), 4000, head.length + 1 + NOT_FOR_GRAFT.length + 1);
            packFinal = head + "\n" + NOT_FOR_GRAFT + "\n" + inner + "\n✂️";
            await api.editMessageText({ chat_id: chatId, message_id: replyTo,
                text: packFinal + "⏳", ...(markup !== undefined ? { reply_markup: markup } : {}) });
        }
        if (packFits && replyTo) {
            packFinal = heroKey ? head + "\n" + pack : pack;
            await api.editMessageText({
                chat_id: chatId, message_id: replyTo, text: packFinal + "\n⏳",
                ...(markup !== undefined ? { reply_markup: markup } : {}),
            });
        }
        const errors = [];
        const sendFile = async (bytes, ext, type) => {
            try {
                await api.sendDocument({ chat_id: chatId,
                    document: new InputFile(bytes, base + ext, { type }),
                    caption: head,
                    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
                });
            } catch (e) {
                console.error("sendDocument:", base + ext, e.message);
                errors.push(base + ext + ": " + e.message);
            }
        };
        await sendFile(enc.encode(g), ".ged", "text/plain");
        if (pack && !packFits) await sendFile(enc.encode("\uFEFF" + pack), ".ged.txt", "text/plain");
        // Готовые текстовые файлы уже доступны; часы остаются до завершения PDF.
        let chartKeys = keys;
        if (heroKey && rm) {
            chartKeys = focusKeys(await linkPairs(chatId), heroKey, Number(rm[1]), await focusSpousePairs(chatId));
        }
        let pdf = null, persons = 0, chartErr = null;
        try {
            const res = await chartFor(chatId, chartKeys, chartHead, heroKey, rm ? Number(rm[1]) : null);
            persons = res.persons;
            pdf = res.pdf;
        } catch (e) { chartErr = e.message.replace(/^chart:\s*/, ""); console.error("chart:", e.message); }
        if (pdf) await sendFile(Uint8Array.from(pdf, c => c.charCodeAt(0)), ".pdf", "application/pdf");
        if (chartErr && !chartErr.includes("персоны пусты")) errors.push("Диаграмма не построена: " + chartErr);
        const errorText = errors.length ? "\n💥 Не удалось выложить файлы:\n" + errors.join("\n") : "";
        if (replyTo) await api.editMessageText({ chat_id: chatId, message_id: replyTo,
            text: (packFinal || (heroKey ? head : "🧬")) + errorText, ...(markup !== undefined ? { reply_markup: markup } : {}) });
        else if (errors.length) await api.sendMessage({ chat_id: chatId, text: errorText.trim() });
        console.log("ged artifacts: " + base + ".ged" + (pdf ? " + " + base + ".pdf (" + persons + " персон)" : "")
            + (pack ? (packFits ? " (пачка текстом в ответе)" : " + " + base + ".ged.txt") : ""), "chat", chatId);
        // бездатное древо — PDF нет по построению («chart: персоны пусты»),
        // это не ошибка, алерта не шлём
        return;
    } catch (e) {
        console.error("sendDocument:", e.message);
        if (replyTo) {
            try {
                await api.editMessageText({ chat_id: chatId, message_id: replyTo,
                    text: (packFinal || head) + "\n💥 Не удалось выложить файлы: " + e.message,
                    ...(markup !== undefined ? { reply_markup: markup } : {}) });
                return;
            } catch (editError) {
                if (/not modified/i.test(editError.description || editError.message || "")) return;
                console.error("ged error edit:", editError.message);
            }
        }
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось выложить файлы: " + e.message });
    }
}

export { focusKeys, focusGraphKeys, focusHasPair, focusWithSpouses, focusListKeys, focusDepth };

// ============================== ГЕДКОМ: импорт = ЗАМЕНА ==============================

// импорт разобранного гедкома = ЗАМЕНА: дерево чата очищается и заливается
// заново (слияние больше не делаем — смешивание источников ломало базу).
// уникальный ключ «Имя Д»: занят — дубли различаются суффиксом «~xref»
// («Иван 1954-05-10 ~I7»): дата не искажается, первая запись остаётся без
// суффикса; xref правимой персоны уникален в чате, коллизий после
// дописывания нет. Для фиктивных дат (yearly) — прежний сдвиг +1 год
// (ВК-копия: lunarreturns.js, uniqueKeyOf)
export async function uniqueKeyOf(chatId, name, birtD, approx, yearly, xref) {
    while (true) {
        const same = (await indiRows(chatId)).find(r => r.name === name && r.birtD === birtD);
        if (!same) return { name, birtD };
        if (yearly) {
            // фиктивные даты (второй проход): не близнецы — разводим по годам
            const dt = new Date(birtD + "T00:00:00Z");
            dt.setUTCFullYear(dt.getUTCFullYear() + 1);
            birtD = dt.toISOString().slice(0, 10);
        } else name = name.replace(/ ~\S+$/, "") + " ~" + gedText(xref);
        // суффикс всегда свободен: xref персоны уникален в чате (в импорте —
        // файловый, дубль xref парсер схлопывает Map'ом; в правке — её же)
    }
}

// та же дата через N лет (29 фев → 1 мар в невисокосный год — само собой)
//

// fam — по одному на каждый FAM файла с точными xref'ами (без слипания
// семей ребёнка); свадьбы живут на fam — точная привязка супругов;
// бездатные импортируются, когда упомянуты в семье — с фиктивной датой
// (супруг: дата половины; ребёнок: каскад сиблинг/свадьба/родитель, birtAbt 15 — EST-день),
// без варианта — заглушки-персоны (birtD null); безымянные — мимо.
// Возвращает краткий отчёт. Повторный импорт лечит любые старые данные
export async function importGedcom(chatId, g) {
    await clearChatTree(chatId);
    const byX = new Map(); // xref файла → xref в базе (совпавшие «Имя Д» — один)
    const famRefs = new Set(); // xref'ы, упомянутые в семьях (супруги/дети)
    for (const f of g.fams) {
        if (f.husb) famRefs.add(f.husb);
        if (f.wife) famRefs.add(f.wife);
        for (const cx of f.chil) famRefs.add(cx);
    }
    let persons = 0;
    const dups = []; // разруленные коллизии ключа «Имя Д»
    const resolved = new Map(); // xref → итоговая дата дубля (наследование ДР супругой)
    for (const ind of g.indis) {
        if (!ind.name || !(ind.birt && ind.birt.date)) continue;
        const approx = !!ind.birt.abt;
        const u = await uniqueKeyOf(chatId, ind.name, ind.birt.date, approx, false, ind.__xref);
        // дубль не сдвигается — abt исходный (дата сохранена, суффикс «~xref»)
        const uabt = ind.birt.abt || 0;
        resolved.set(ind.__xref, u.birtD);
        if (u.name !== ind.name || u.birtD !== ind.birt.date)
            dups.push({ from: ind.name + " " + approxOut(ind.birt.date, ind.birt.abt),
                to: u.name + " " + approxOut(u.birtD, uabt) });
        await db.insert(indi).values({
            chatId, xref: ind.__xref, name: u.name, birtD: u.birtD,
            birtH: null, birtM: null,
            srcH: ind.birt.time ? Number(ind.birt.time.slice(0, 2)) : null,
            srcM: ind.birt.time ? Number(ind.birt.time.slice(3, 5)) : null,
            deatD: ind.deat && ind.deat.date ? ind.deat.date : null, deatH: null, deatM: null,
            dsrcH: ind.deat && ind.deat.time ? Number(ind.deat.time.slice(0, 2)) : null,
            dsrcM: ind.deat && ind.deat.time ? Number(ind.deat.time.slice(3, 5)) : null,
            sex: ind.sex ?? null,
            plac: ind.birt && ind.birt.plac ? ind.birt.plac : null,
            deatPlac: ind.deat && ind.deat.plac ? ind.deat.plac : null,
            note: ind.note ?? null,
            birtAbt: uabt, // дубль — суффикс «~xref», дата и abt исходные
            deatAbt: (ind.deat && ind.deat.abt) || 0,
        }).run();
        byX.set(ind.__xref, ind.__xref);
        persons++;
    }
    // единый каскад фиктивных дат до фиксированной точки — канон
    // gedFictiveDates (parse.cjs): карта xref → фиктивная полная дата|null,
    // датированные в файле — послеколлизионные (resolved), бездатные
    // поимённые в famRefs — вычисленные; правила якорей (сиблинг/свадьба/
    // полусиблы/родитель, супруги) — в каноне. Вставки, коллизии фиктивных
    // дат (uniqueKeyOf yearly) и счётчики — ниже, платформенные
    const fullOf = gedFictiveDates(g, famRefs, resolved);
    // второй проход: бездатные супруги и дети — фиктивная полная дата,
    // birtAbt 15 (EST-день: в шкале PDF нет года и прожитых лет, печать —
    // «1234-05-06~»); полная точность сохраняет round-trip .ged.txt
    // (экспорт «EST 6 MAY 1234»); коллизия фиктивных
    // дат — +1 год (не близнецы); безымянные — мимо
    for (const ind of g.indis) {
        if (!ind.name || (ind.birt && ind.birt.date)) continue;
        if (!famRefs.has(ind.__xref)) continue;
        const full = fullOf.get(ind.__xref) || null;
        if (full === null) {
            // имя заглушки — всегда «Имя ~xref»: уникальный ключ «Имя ~xref»
            // + null у всех заглушек, тёзки различимы, метка единообразна
            // в гедкоме и росписях. Метка снимается, если уже есть (round-trip:
            // повторный .ged-импорт не должен удваивать суффикс); xref —
            // стабильная идентичность round-trip'а
            const base = ind.name.replace(/ ~\S+$/, "");
            const sname = base + " ~" + gedText(ind.__xref);
            await db.insert(indi).values({
                chatId, xref: ind.__xref, name: sname, birtD: null,
                birtH: null, birtM: null, srcH: null, srcM: null,
                deatD: ind.deat && ind.deat.date ? ind.deat.date : null, deatH: null, deatM: null,
                dsrcH: null, dsrcM: null,
                sex: ind.sex ?? null,
                plac: ind.birt && ind.birt.plac ? ind.birt.plac : null,
                deatPlac: ind.deat && ind.deat.plac ? ind.deat.plac : null,
                note: ind.note ?? null,
                birtAbt: 0,
                deatAbt: (ind.deat && ind.deat.abt) || 0,
            }).run();
            byX.set(ind.__xref, ind.__xref);
            persons++;
            continue;
        }
        const u = await uniqueKeyOf(chatId, ind.name, full, true, true, ind.__xref);
        // фиктивная ДР от супруга — всегда birtAbt 15 (EST-день, как и
        // сдвинутый дубль): в шкале PDF у такой строки нет года и прожитых
        // лет; полная точность — для round-trip .ged.txt
        const uabt = 15;
        if (u.name !== ind.name || u.birtD !== full)
            dups.push({ from: ind.name, to: u.name + " " + approxOut(u.birtD, uabt) });
        await db.insert(indi).values({
            chatId, xref: ind.__xref, name: u.name, birtD: u.birtD,
            birtH: null, birtM: null, srcH: null, srcM: null,
            deatD: ind.deat && ind.deat.date ? ind.deat.date : null, deatH: null, deatM: null,
            dsrcH: null, dsrcM: null,
            sex: ind.sex ?? null,
            plac: ind.birt && ind.birt.plac ? ind.birt.plac : null,
            deatPlac: ind.deat && ind.deat.plac ? ind.deat.plac : null,
            note: ind.note ?? null,
            birtAbt: uabt, // дубль со сдвинутой датой — abt 15 (EST-день; сдвиг виден в
                // печати, дублей дополнительно различает суффикс «~xref»)
            deatAbt: (ind.deat && ind.deat.abt) || 0,
        }).run();
        byX.set(ind.__xref, ind.__xref);
        persons++;
    }
    let famCount = 0, childCount = 0;
    for (const f of g.fams) {
        const h = f.husb && byX.get(f.husb), w = f.wife && byX.get(f.wife);
        const hasMarr = f.marr && f.marr.date;
        await db.insert(fam).values({
            chatId, xref: f.__xref, adhoc: false, husb: h ?? null, wife: w ?? null,
            marrD: hasMarr ? f.marr.date : null,
            marrAbt: hasMarr && f.marr.abt || 0,
            marrPlac: hasMarr && f.marr.plac ? f.marr.plac : null,
            note: f.note ?? null,
            divD: f.div && f.div.date ? f.div.date : null,
            divAbt: (f.div && f.div.abt) || 0,
            divPlac: f.div && f.div.plac ? f.div.plac : null,
        }).run(); // тот же FAM zweimal — не бывает в валидном гедкоме
        famCount++;
        for (const cx of f.chil) {
            const c = byX.get(cx);
            if (!c) continue;
            try {
                await db.insert(chil).values({ chatId, fam: f.__xref, indi: c, adopted: f.adopted.includes(cx) }).run();
                childCount++;
            } catch { /* дубли */ }
            for (const p of [h, w]) {
                if (!p || p === c) continue;
                const pk = await keyOfXref(chatId, p), ck = await keyOfXref(chatId, c);
                if (!pk || !ck) continue;
                const exists = (await edgeRows(chatId)).find(l => l.parent === pk && l.child === ck);
                if (exists) continue;
                await db.insert(edges).values({ chatId, parent: pk, child: ck, who: "c", famXref: f.__xref }).run();
            }
        }
    }
    // ADOP + FAMC у персоны: усыновление в указанной семье (PEDI мог не быть)
    for (const ind of g.indis) {
        if (!ind.adopFams || !ind.adopFams.length) continue;
        const c = byX.get(ind.__xref);
        if (!c) continue;
        for (const fx of ind.adopFams) {
            if (!(await getFam(chatId, fx))) continue;
            await db.update(chil).set({ adopted: true })
                .where(and(eq(chil.chatId, chatId), eq(chil.fam, fx), eq(chil.indi, c))).run();
        }
    }
    return { persons, fams: famCount, links: childCount, errors: [], dups };
}

// резерв прежнего дерева чата файлом <имя>-old.ged (фолбэк — текстом);
// true — выложен (или чат пуст), false — не смогли (замена отменяется)
export async function sendTreeBackup(chatId) {
    if (!(await personRows(chatId)).length) return true;
    const g = await gedcomText(chatId);
    const base = fileBaseOf("Гедком-древо чата");
    try {
        const enc = new TextEncoder();
        await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(enc.encode(g), base + "-old.ged", { type: "text/plain" }),
            caption: "🧬 Резерв прежнего дерева",
        });
        return true;
    } catch (e) {
        console.error("backup upload:", e.message);
    }
    try {
        await sendLong(chatId, "🧬 Резерв прежнего дерева (текстом):\n" + g, undefined, "Резерв");
        return true;
    } catch (e) {
        console.error("backup text:", e.message);
        return false;
    }
}

// замена дерева чата гедкомом; backup=true — сначала выложить прежнее
// дерево файлом (не смогли — замена отменяется, старые данные целы).
// Возвращает {ok, head} для ответа в чат; древо всегда очищается и заливается
export async function replaceWithGedcom(chatId, g, backup) {
    if (backup && !(await sendTreeBackup(chatId)))
        return { ok: false, head: "💥 Не удалось выложить резерв — замена отменена, прежнее дерево цело" };
    const r = await importGedcom(chatId, g);
    return { ok: true, head: treeReport(r) };
}

// sendMessage с разбиением длинного текста (лимит TG 4096);
// текст jubileeText — HTML со спойлерами, поэтому parse_mode всегда HTML.
// Если не влезает — ВЕСЬ текст одним .txt-файлом (имя name), разметка снята
// (stripHtml), переносы сохранены; не выложился — сообщение об ошибке (без кусков)
export async function sendLong(chatId, text, replyMarkup, name, replyTo = 0) {
    const reply = replyTo
        ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
    const parts = splitText(text);
    if (parts.length === 1) {
        // возвращаем Message: отправщику нужен message_id (например, чтобы
        // вставить строку focus_view под кнопки)
        return api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup, ...reply });
    }
    // BOM — чтобы Windows-редакторы (Блокнот) открывали как UTF-8, а не ANSI
    const base = fileBaseOf(name || "Ответ") + ".txt";
    try {
        const enc = new TextEncoder();
        return await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(enc.encode("\uFEFF" + stripHtml(text)), base, { type: "text/plain" }),
            reply_markup: replyMarkup, ...reply,
        });
    } catch (e) {
        console.error("tail document:", e.message);
        return api.sendMessage({
            chat_id: chatId, text: "💥 Не удалось выложить файл " + base });
    }
}

// «/links» и тап 🔗: роспись ВЕТВИ героя (key) — как «-+=» на фокусе, или
// роспись всего древа чата (key=null). Ветвь: короткая — текстом, длинная
// (>4000) — файлом «.ged.txt» (как tailDoc). Роспись радиуса — ВСЕГДА файлом:
// ⏳ (origin.edit — правка сообщения с кнопками, клавиатура на ней же),
// файл ответом на него, потом ⏳ заменён невидимым символом (\u2063);
// провал — «💥». origin={edit:{message_id,markup}} — для тапа кнопки.
// false — росписи нет (древо/ветвь пусты). Листинг сообщений-связей
// больше не восстанавливается.
// sendFlatPack key=null: метки-держатели «-+=⏳» / «🧬⏳», по готовности
// файлов остаётся видимая метка («-+=», «🧬») — цитата на /links живёт
export async function sendFlatPack(chatId, key, head = "", replyTo = 0, origin = null) {
    const reply = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
    const prefix = head ? head + "\n" : "";
    const markup = origin?.edit?.markup;
    const holdId = origin?.edit?.message_id || (await api.sendMessage({ chat_id: chatId,
        text: prefix + "-+=⏳", ...reply })).message_id;
    const edit = text => api.editMessageText({ chat_id: chatId, message_id: holdId, text,
        ...(markup !== undefined ? { reply_markup: markup } : {}) });
    if (origin?.edit) await edit(prefix + "-+=⏳");
    try {
    const pack = key === null ? await chatFlatText(chatId) : await branchFlatText(chatId, key);
    if (!pack) { await edit(prefix + (key === null ? "связей пока нет" : "ветвь пуста")); return true; }
    if (key === null) {
        const artifacts = chatFlatArtifacts(pack);
        const base = artifacts.txt.name;
        // метка «не для прививки» первой строкой (как в tailDoc): роспись радиуса
        // в ответе на триггер правок не делает (parseTree → noGraft)
        try {
            // метка-держатель «-+=⏳»: правка сообщения с кнопками (клавиатура
            // остаётся) либо новое сообщение ответом на /links; файл ответом
            // на него; по готовности — «-+=» (видимая цитата на /links живёт)
            // BOM — чтобы Windows-редакторы открывали как UTF-8
            await api.sendDocument({
                chat_id: chatId,
                document: new InputFile(new TextEncoder().encode(artifacts.txt.content), base,
                    { type: artifacts.txt.type }),
                reply_parameters: { message_id: holdId, allow_sending_without_reply: true },
            });
            // рядом «Древо чата.ged.csv» — роспись таблицей с табами (Excel);
            // провал — .ged.txt остаётся, CSV молча не выкладывается
            try {
                const csv = artifacts.csv();
                await api.sendDocument({
                    chat_id: chatId,
                    document: new InputFile(
                        new TextEncoder().encode(csv.content), csv.name, { type: csv.type }),
                    reply_parameters: { message_id: holdId, allow_sending_without_reply: true },
                });
            } catch (e2) {
                console.error("flat pack csv:", e2.message);
                await edit("-+=\n💥 Не удалось выложить CSV: " + e2.message);
                return true;
            }
            await api.editMessageText({ chat_id: chatId, message_id: holdId, text: "-+=",
                ...(origin?.edit ? { reply_markup: origin.edit.markup } : {}) });
        } catch (e) {
            console.error("flat pack doc:", e.message);
            await edit("-+=\n💥 Не удалось выложить файл " + base);
        }
        return true;
    }
    // метка «не для прививки»: у росписи радиуса (древо чата) она уже есть —
    // первой строкой росписи; влезающая ветвь — как ответ на «-+=», БЕЗ метки
    // (прививка ей дозволена); в переливе метка есть всегда (текст усечён).
    // Порядок строк: голова/герой, метка, роспись (правило — коммент у
    // NOT_FOR_GRAFT выше)
    const marked = pack.trimStart().toLowerCase().startsWith(NOT_FOR_GRAFT.toLowerCase());
    const mark = marked ? "" : NOT_FOR_GRAFT + "\n";
    if (prefix.length + pack.length <= 4000) {
        await edit(prefix + pack);
        return true;
    }
    const base = fileBaseOf(head || "Древо чата") + ".ged.txt";
    try {
        // не влезает: голова + метка + ✂️⏳ первым сообщением (порядок строк —
        // герой/голова, метка; полное — в файле; у ромба метка и так первая
        // строка росписи в файле), файл — ответом на него же, потом ⏳ снят
        // (✂️ остаётся)
        const inner = cutLines(pack, 3900, prefix.length + mark.length);
        const finalText = prefix + mark + inner + "\n✂️";
        await edit(finalText + "⏳");
        // BOM — чтобы Windows-редакторы открывали как UTF-8
        const content = "\uFEFF" + pack;
        await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(new TextEncoder().encode(content), base, { type: "text/plain" }),
            reply_parameters: { message_id: holdId, allow_sending_without_reply: true },
        });
        await edit(finalText);
    } catch (e) {
        console.error("tail document:", e.message);
        await edit(prefix + "💥 Не удалось выложить файл " + base);
    }
    return true;
    } catch (e) {
        console.error("flat pack:", e);
        await edit(prefix + "💥 Не удалось подготовить роспись: " + e.message);
        return true;
    }
}

// снять разметку HTML/ТГ для .txt-файла (теги — прочь, сущности — в символы,
// переносы строк сохраняются)
export function stripHtml(t) {
    return t.replace(/<[^>]+>/g, "")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/ +/g, " ")
        .split("\n").map(l => l.replace(/^ +| +$/g, "")).join("\n").trim();
}

//
