// Общий код TG-бота: настройки, клавиатуры, тексты «сегодня»/«список».
import { db, api } from 'sdk';
import { and, eq, or } from 'sdk/db';
import { indi, fam, chil, edges, settings } from '../schema.js';
import { mskToday } from './astro.js';
import { kinLabel } from './kinship.js';
import { REL_DEFS, religiousDigest } from './religion.js';
import { jubileeText } from './text.js';

export const HELP = "Отправьте «Имя ГГГГ-ММ-ДД [ЧЧ:ММ] [дата смерти]» — покажу лунно-солнечные юбилеи.\n"
    + "Можно с зоной: «… 12:30 (Пермь)» или «… 12:30 МСК+2», по одной строке на событие.\n"
    + "Ответ триггером на триггер — связь родитель→ребёнок (гедком-древо чата).\n"
    + ".ged-файл чатом — замена древа; /today — события сегодня (МСК), /gedcom — древо\n"
    + "Кнопки под ответом: 👎 удалить, 👀 подробно.";

// сколько живёт «Да/Нет»-вопрос на дроп .ged-файла (час)
export const GED_TTL = 3600000;

const DEFAULT_SETTINGS = { orth: false, islam: false, bud: false, cath: false, jud: false, bell: true };

export async function getSettings(chatId) {
    const row = await db.select().from(settings).where(eq(settings.chatId, chatId)).get();
    return row || { chatId, ...DEFAULT_SETTINGS };
}

// inline-клавиатура настроек (личка): 🗑 (удалить всё) + колокольчик (список) + религии (🔔/🔕) + ❌
// раскладка как в VK relKeyboard: [🗑, bell, orth, islam] / [bud, cath, jud, ❌];
// подпись колокольчика — подписка: 🔔 вкл (список по ММ-ДД) / 🔕 выкл (по ГГГГММДД)
export function relMarkup(chatId, s) {
    const btn = (text, data) => ({ text, callback_data: data });
    const rel = key => btn(REL_DEFS[key].icon + (s[key] ? "🔔" : "🔕"), "rel:" + key);
    return {
        inline_keyboard: [
            [btn("🗑", "del"), btn(s.bell !== false ? "🔔" : "🔕", "bell"), btn("🧬", "tree"), rel("orth")],
            [rel("islam"), rel("bud"), rel("cath"), rel("jud")],
            [btn("❌", "close")]
        ]
    };
}

// клавиатура админа группы: 🗑 (удалить всё), колокольчик (список), 🧬 (гедком), ❌
export function ownerMarkup(bellOn = true) {
    return {
        inline_keyboard: [[
            { text: "🗑", callback_data: "del" },
            { text: bellOn ? "🔔" : "🔕", callback_data: "bell" },
            { text: "🧬", callback_data: "tree" },
            { text: "❌", callback_data: "close" },
        ]]
    };
}

// клавиатура участника группы: колокольчик (список), 🧬 (гедком), ❌
export function bellMarkup(bellOn = true) {
    return {
        inline_keyboard: [[
            { text: bellOn ? "🔔" : "🔕", callback_data: "bell" },
            { text: "🧬", callback_data: "tree" },
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
const recOfIndi = r => {
    const o = { n: r.name, d: r.birtD };
    if (r.birtH !== null && r.birtH !== undefined) { o.h = r.birtH; o.m = r.birtM ?? 0; }
    if (r.srcH !== null && r.srcH !== undefined) { o.srcH = r.srcH; o.srcM = r.srcM ?? 0; }
    if (r.sex) o.sex = r.sex;
    if (r.deatD) {
        o.dd = r.deatD;
        if (r.deatH !== null && r.deatH !== undefined) { o.dh = r.deatH; o.dm = r.deatM ?? 0; }
        if (r.dsrcH !== null && r.dsrcH !== undefined) { o.dsrcH = r.dsrcH; o.dsrcM = r.dsrcM ?? 0; }
    }
    if (r.plac) o.plac = r.plac;
    o.xref = r.xref;
    return o;
};

// персоны чата (только с датой рождения), порядок вставки
export async function personRows(chatId) {
    const rows = (await indiRows(chatId)).filter(r => r.birtD != null)
        .sort((a, b) => a.id - b.id);
    return rows.map(recOfIndi);
}

// свадьбы чата: fam с marr и обоими супругами (имена по xref — точно);
// та же пара+дата у второй семьи (после confirmPair) — один раз
export async function weddingRows(chatId) {
    const fs = (await famRowsOf(chatId)).sort((a, b) => a.id - b.id);
    const nameOf = new Map((await indiRows(chatId)).map(r => [r.xref, r.name]));
    const out = [], seen = new Set();
    for (const f of fs) {
        if (f.marrD === null || f.marrD === undefined) continue;
        const hn = f.husb ? nameOf.get(f.husb) || null : null;
        const wn = f.wife ? nameOf.get(f.wife) || null : null;
        if (!hn || !wn) continue;
        const o = { n: hn + "+" + wn, d: f.marrD };
        if (seen.has(pkey(o))) continue;
        seen.add(pkey(o));
        if (f.marrPlac) o.plac = f.marrPlac;
        if (f.divD) { o.dd = f.divD; if (f.divPlac) o.plac2 = f.divPlac; }
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

// запись по xref (индивидуальный — даже без birt_d — либо fam-пара со свадьбой)
export async function recordByXref(chatId, xref) {
    const i = await getIndi(chatId, xref);
    if (i && i.birtD != null) return recOfIndi(i);
    const f = await getFam(chatId, xref);
    if (f && f.marrD) return (await weddingRows(chatId)).find(w => w.fx === xref) || null;
    return null;
}

// ключи «Имя Д» по xref
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
        marr: f.marrD ? { d: f.marrD, ...(f.marrPlac ? { plac: f.marrPlac } : {}) } : null,
        div: f.divD ? { d: f.divD, ...(f.divPlac ? { plac: f.divPlac } : {}) } : null,
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
        sex: rec.sex ?? null, plac: rec.plac ?? null,
    }).run();
    return (await personRows(chatId)).find(r => r.xref === xref) || null;
}

// заглушка-половина свадьбы: персона без даты (одна на все свадьбы с именем)
async function stubOf(chatId, name) {
    const cur = (await indiRows(chatId)).find(r => r.name === name && r.birtD == null);
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
    for (const f of (await famRowsOf(chatId)).filter(r => r.marrD === rec.d)) {
        const hn = await getIndi(chatId, f.husb), wn = await getIndi(chatId, f.wife);
        const hnn = hn && hn.name, wnn = wn && wn.name;
        if ((hnn === a && wnn === b) || (hnn === b && wnn === a)) {
            const set = {};
            if (rec.plac !== undefined) set.marrPlac = rec.plac || null;
            if (rec.dd !== undefined) set.divD = rec.dd || null;
            if (rec.plac2 !== undefined) set.divPlac = rec.plac2 || null;
            if (Object.keys(set).length)
                await db.update(fam).set(set)
                    .where(and(eq(fam.chatId, chatId), eq(fam.xref, f.xref))).run();
            return weddingByFx(chatId, f.xref);
        }
    }
    const ha = await stubOf(chatId, a), hb = await stubOf(chatId, b);
    const xref = await nextFamXref(chatId, "W");
    await db.insert(fam).values({
        chatId, xref, adhoc: true, husb: ha, wife: hb,
        marrD: rec.d, marrPlac: rec.plac ?? null,
        divD: rec.dd ?? null, divPlac: rec.plac2 ?? null,
    }).run();
    return weddingByFx(chatId, xref);
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
            await db.update(fam).set({ marrD: w.marrD, marrPlac: w.marrPlac, divD: w.divD, divPlac: w.divPlac })
                .where(and(eq(fam.chatId, chatId), eq(fam.xref, f.xref))).run();
            await db.delete(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, w.xref))).run();
            for (const e of (await edgeRows(chatId)).filter(e => e.famXref === w.xref))
                await db.update(edges).set({ famXref: null }).where(eq(edges.id, e.id)).run();
            await db.delete(fam).where(and(eq(fam.chatId, chatId), eq(fam.xref, w.xref))).run();
            for (const x of wps) await dropStubIfOrphan(chatId, x);
        } else {
            // семья с детьми (напр., из гедкома): копируем marr, её не трогаем
            await db.update(fam).set({ marrD: w.marrD, marrPlac: w.marrPlac, divD: w.divD, divPlac: w.divPlac })
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
        for (const fx of fams) await normalizeFam(chatId, fx);
    } else if (name.includes("+")) {
        // свадьба «Имя1+Имя2 Д»: снять marr/div с семей с этой датой и половиной
        const [n1, n2] = name.split("+");
        const nameOf = new Map((await indiRows(chatId)).map(r => [r.xref, r.name]));
        for (const f of (await famRowsOf(chatId)).filter(r => r.marrD === d)) {
            const hn = f.husb ? nameOf.get(f.husb) : null;
            const wn = f.wife ? nameOf.get(f.wife) : null;
            if (hn === n1 || hn === n2 || wn === n1 || wn === n2)
                await db.update(fam).set({ marrD: null, marrPlac: null, divD: null, divPlac: null })
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
        .filter(r => r.d.slice(5) === mmdd);
    const parts = rows.map(r => jubileeText(r, ""));
    const digest = religiousDigest(await getSettings(chatId));
    if (digest) parts.push(digest);
    return parts.join("\n\n");
}

// «Имя ГГГГ-ММ-ДД[ ГГГГ-ММ-ДД смерти][ ЧЧ:ММ]»; "" — событий нет.
// byFullDate=false — по возрастанию ММ-ДД (список 🔔), true — по полной дате
// ГГГГ-ММ-ДД (подтверждение удаления)
export async function upcomingText(chatId, byFullDate = false) {
    const rows = [...await personRows(chatId), ...await weddingRows(chatId)];
    const key = r => (byFullDate ? r.d : r.d.slice(5))
        + " " + (r.h !== undefined ? String(r.h).padStart(2, "0") + String(r.m ?? 0).padStart(2, "0") : "");
    return rows
        .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
        .map(r => r.n + " " + r.d
            + (r.dd !== undefined ? " " + r.dd : "")
            + (r.h !== undefined ? " " + String(r.h).padStart(2, "0") + ":" + String(r.m).padStart(2, "0") : ""))
        .join("\n");
}

// кнопки под ответом бота на триггер: 👎 — удалить событие (как реакция VK),
// 👀 — подробно; callback_data — xref (персоны или fam-пары)
export function eventMarkup(xref) {
    return {
        inline_keyboard: [[
            { text: "👎", callback_data: "del1:" + xref },
            { text: "👀", callback_data: "det:" + xref },
        ]]
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
// (паритет VK: relKeyboard/ownerKeyboard/bellMarkup); подпись колокольчика — подписка
export function startMarkup(chat, isAdmin, chatId, s) {
    const bellOn = s.bell !== false;
    if (chat.type === 'private') return relMarkup(chatId, s);
    return isAdmin ? ownerMarkup(bellOn) : bellMarkup(bellOn);
}

// ============================== фокус-родня (чистая логика) ==============================

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

// входит ли событие-пара «Имя1+Имя2 ДАТА» в фокус: оба имени среди персон множества
function focusHasPair(name, keys) {
    if (!name.includes("+")) return false;
    const names = new Set(keys.map(k => k.slice(0, -11)));
    return name.split("+").every(n => names.has(n));
}

// дополнить множество супругами (для связности фрагмента): spousePairs —
// [[ключ, ключ], …]; супруг добавляется, только если его половина уже в множестве
function focusWithSpouses(keys, spousePairs) {
    const set = new Set(keys);
    for (const [a, b] of spousePairs) {
        if (set.has(a) && !set.has(b)) set.add(b);
        else if (set.has(b) && !set.has(a)) set.add(a);
    }
    return [...set];
}

// супруги персон чата: fam с двумя датированными родителями — пары точные
// (по xref); интерактивные свадьбы-заглушки без персон сюда не попадают —
// привязываются confirmPair'ом (раньше «по первому имени» и тёзки ловили
// чужие свадьбы)
export async function focusSpousePairs(chatId) {
    return (await famList(chatId)).filter(f => f.parents.length === 2).map(f => f.parents);
}

// подпись радиуса: 1 родителей, 2 дедов, 3 прадедов, 4 прапрадедов…
export const focusLabel = radius =>
    radius === 1 ? "родителей" : radius === 2 ? "дедов" : "пра".repeat(radius - 3) + "прадедов";

// глубина родни персоны key (0 = ни родителей, ни потомков) — для скрытия
// цифр радиуса без сведений: max(глубина предков, глубина потомков), т.к.
// радиус теперь режет вниз тем же числом поколений, что и вверх (ромб)
export function focusDepth(pairs, key) {
    const kidsOf = new Map(), parentsOf = new Map();
    for (const [p, c] of pairs) {
        if (!kidsOf.has(p)) kidsOf.set(p, []);
        kidsOf.get(p).push(c);
        if (!parentsOf.has(c)) parentsOf.set(c, []);
        parentsOf.get(c).push(p);
    }
    const depth = adj => {
        let frontier = [key], d = 0;
        const seen = new Set([key]);
        while (frontier.length) {
            const next = [];
            for (const k of frontier) for (const x of (adj.get(k) || []))
                if (!seen.has(x)) { seen.add(x); next.push(x); }
            if (!next.length) break;
            frontier = next;
            d++;
        }
        return d;
    };
    return Math.max(depth(parentsOf), depth(kidsOf));
}

// заголовок фокус-сообщения; dd — дата смерти/развода, если есть;
// радиус — цифрой в квадрате (кейкап) перед ключом
export const focusHead = (key, radius, dd) =>
    String(radius) + "\u20E3 " + key + (dd ? " " + dd : "");

// список событий по множеству фокуса с ярлыками родства: строки
// «Имя Д [Д(смерти)] [ЧЧ:ММ] родство»; items — записи {n, d, h, m, dd};
// params — (items, keys, key, pairs, spousePairs, sexOf, byFullDate);
// сортировка по ММ-ДД или (byFullDate) по полной дате
export function focusListText(items, keys, key, pairs, spousePairs, sexOf, byFullDate = false) {
    const set = new Set(keys);
    const sortKey = r => (byFullDate ? r.d : r.d.slice(5)) + " " + (r.h !== undefined ? String(r.h).padStart(2, "0") + String(r.m ?? 0).padStart(2, "0") : "");
    return items
        .filter(r => set.has(r.n + " " + r.d) || (r.n.includes("+") && focusHasPair(r.n, keys)))
        .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0))
        .map(r => r.n + " " + r.d
            + (r.dd ? " " + r.dd : "")
            + (r.h !== undefined ? " " + String(r.h).padStart(2, "0") + ":" + String(r.m).padStart(2, "0") : "")
            + (() => { const l = kinLabel(pairs, spousePairs, sexOf, key, r.n + " " + r.d); return l ? " " + l : ""; })())
        .join("\n");
}

// клавиатура фокус-сообщения: как /start по роли, но без кнопок религий,
// 🔔/🧬 действуют в радиусе, а в ряд с ❌ добавлены неактивные цифры радиуса
// (активная скрыта; цифра r выводится, если есть предки глубины r — depth
// = focusDepth; grace при старом вызове без depth — все цифры);
// подпись колокольчика — подписка: 🔔 вкл (список по ММ-ДД) / 🔕 выкл (по ГГГГММДД)
export function focusMarkup(chat, chatId, s, radius, depth) {
    const btn = (text, data) => ({ text, callback_data: data });
    const bell = btn(s.bell !== false ? "🔔" : "🔕", "focbell");
    const tree = btn("🧬", "foctree");
    const digits = [1, 2, 3, 4, 5]
        .filter(n => n !== radius && n <= (depth === undefined ? 5 : depth))
        .map(n => btn(String(n) + "\u20E3", "foc" + n));
    const tail = [...digits, btn("❌", "close")];
    return { inline_keyboard: [[btn("🗑", "del"), bell, tree], tail] };
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
// персон; группы с одинаковым набором родителей схлопываются — как прежде).
// keys — необязательный набор персон: фрагмент только по ним (для
// сообщений-связей)
export async function gedcomText(chatId, keys) {
    const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const gdate = d => { const [y, mo, dd] = d.split("-").map(Number); return dd + " " + MON[mo - 1] + " " + y; };
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const persons = (await personRows(chatId)).filter(r => !hasKeys || keys.includes(pkey(r)));
    const idOf = new Map(persons.map((r, i) => [pkey(r), "I" + (i + 1)]));
    const sexOf = new Map(persons.map(r => [pkey(r), r.sex || null]));
    // усыновления: «Имя Д» ребёнка → xref семьи (chil.adopted)
    const adoptedOf = new Map();
    for (const c of (await chilRows(chatId)).filter(x => x.adopted).sort((a, b) => a.id - b.id)) {
        const k = await keyOfXref(chatId, c.indi);
        if (k) adoptedOf.set(k, c.fam);
    }
    // fam-строки в {xref, adhoc, parents — ключи, stubs, children, marr, div}
    const fams = [];
    for (const f of (await famRowsOf(chatId)).sort((a, b) => a.id - b.id)) {
        const pkeys = [], stubs = [], children = [];
        for (const x of [f.husb, f.wife]) {
            if (!x) continue;
            const k = await keyOfXref(chatId, x);
            if (k) pkeys.push(k);
            else {
                const i = await getIndi(chatId, x);
                if (i && !stubs.some(s => s.xref === x)) stubs.push({ xref: x, name: i.name });
            }
        }
        for (const r of (await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, f.xref))).all()).sort((a, b) => a.id - b.id)) {
            const k = await keyOfXref(chatId, r.indi);
            if (k) children.push(k);
        }
        const marr = f.marrD ? { d: f.marrD, ...(f.marrPlac ? { plac: f.marrPlac } : {}) } : null;
        const div = f.divD ? { d: f.divD, ...(f.divPlac ? { plac: f.divPlac } : {}) } : null;
        if (hasKeys) {
            const ps = pkeys.filter(p => keys.includes(p));
            const cs = children.filter(c => keys.includes(c));
            if (!(ps.length && cs.length)) continue;
            pkeys.length = 0; pkeys.push(...ps);
            children.length = 0; children.push(...cs);
        } else if (!pkeys.length && !stubs.length && !children.length) continue;
        const s = pkeys.slice().sort();
        const m = fams.find(x => x.s.length === s.length && x.s.every((p, i) => p === s[i]));
        if (m) {
            m.fx.push(f.xref);
            for (const c of children) if (!m.children.includes(c)) m.children.push(c);
            for (const st of stubs) if (!m.stubs.some(x => x.xref === st.xref)) m.stubs.push(st);
            if (!m.marr) m.marr = marr;
            if (!m.div) m.div = div;
        } else fams.push({ s, fx: [f.xref], pkeys, stubs, children, marr, div });
    }
    // заглушкам — X-номера; FAM — по порядку; HUSB/WIFE по полу (без — HUSB)
    let stubN = 0;
    const stubId = new Map(), stubName = new Map();
    for (const f of fams) for (const st of f.stubs)
        if (!stubId.has(st.xref)) { stubId.set(st.xref, "X" + (++stubN)); stubName.set(st.xref, st.name); }
    const fidOf = new Map(fams.map((f, i) => [f, "F" + (i + 1)]));
    const adoptedHere = (f, k) => f.fx.some(x => adoptedOf.get(k) === x);
    const out = ["0 HEAD", "1 SOUR LunarReturns", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"];
    for (const r of persons) {
        out.push("0 @" + idOf.get(pkey(r)) + "@ INDI");
        out.push("1 NAME " + r.n);
        if (r.sex) out.push("1 SEX " + r.sex);
        out.push("1 BIRT", "2 DATE " + gdate(r.d));
        if (r.srcH !== undefined) out.push("2 TIME " + String(r.srcH).padStart(2, "0") + ":" + String(r.srcM).padStart(2, "0"));
        if (r.dd) {
            out.push("1 DEAT", "2 DATE " + gdate(r.dd));
            if (r.dsrcH !== undefined) out.push("2 TIME " + String(r.dsrcH).padStart(2, "0") + ":" + String(r.dsrcM).padStart(2, "0"));
        }
        for (const f of fams) {
            if (f.children.includes(pkey(r))) {
                out.push("1 FAMC @" + fidOf.get(f) + "@");
                if (adoptedHere(f, pkey(r))) out.push("1 ADOP", "2 FAMC @" + fidOf.get(f) + "@");
            }
            if (f.pkeys.includes(pkey(r))) out.push("1 FAMS @" + fidOf.get(f) + "@");
        }
    }
    for (const [x, n] of stubId) {
        out.push("0 @" + n + "@ INDI");
        out.push("1 NAME " + stubName.get(x));
        for (const f of fams) if (f.stubs.some(s => s.xref === x)) out.push("1 FAMS @" + fidOf.get(f) + "@");
    }
    for (const f of fams) {
        out.push("0 @" + fidOf.get(f) + "@ FAM");
        // по практике 5.5.1: сначала HUSB, затем WIFE; заглушки — без пола
        const all = [
            ...f.pkeys.map(k => ({ ref: idOf.get(k), sex: sexOf.get(k) })),
            ...f.stubs.map(s => ({ ref: stubId.get(s.xref), sex: null })),
        ];
        for (const x of all.filter(x => x.sex !== "F")) out.push("1 HUSB @" + x.ref + "@");
        for (const x of all.filter(x => x.sex === "F")) out.push("1 WIFE @" + x.ref + "@");
        for (const c of f.children) {
            out.push("1 CHIL @" + idOf.get(c) + "@");
            if (adoptedHere(f, c)) out.push("2 PEDI adopted");
        }
        if (f.marr) {
            out.push("1 MARR", "2 DATE " + gdate(f.marr.d));
            if (f.marr.plac) out.push("2 PLAC " + f.marr.plac);
        }
        if (f.div) {
            out.push("1 DIV", "2 DATE " + gdate(f.div.d));
            if (f.div.plac) out.push("2 PLAC " + f.div.plac);
        }
    }
    out.push("0 TRLR");
    return out.join("\n");
}

// ============================== ГЕДКОМ → PDF ==============================
// Чистая логика дословно продублирована в lunarreturns.js (dev/sync-check.mjs)

import { InputFile } from 'sdk';
import { CHART_MAX, chartPdf, chartFont, fileBaseOf } from './chart.js';

// диаграммные данные чата/фрагмента (как у gedcomText: те же INDI, свадьбы
// «Имя+Имя» вне; семьи усекаются до персон фрагмента)
export async function chartFor(chatId, keys, title) {
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const persons = (await personRows(chatId)).filter(r => !hasKeys || keys.includes(pkey(r)));
    const keySet = new Set(persons.map(r => pkey(r)));
    const rows = persons.map(r => ({ name: r.n, birth: r.d, death: r.dd || null, sex: r.sex || null }));
    const parentsOf = new Map();
    for (const f of await famList(chatId)) {
        const ps = f.parents.filter(p => keySet.has(p));
        for (const c of f.children) {
            if (!keySet.has(c)) continue;
            const arr = parentsOf.get(c) || [];
            for (const p of ps) if (!arr.includes(p)) arr.push(p);
            parentsOf.set(c, arr);
        }
    }
    // ключ «Имя год» из «Имя ГГГГ-ММ-ДД»
    const ckey = k => k.slice(0, -11) + " " + keyY(k);
    const links = [...parentsOf].filter(([, ps]) => ps.length)
        .map(([c, ps]) => ({ child: ckey(c), parents: ps.map(ckey) }));
    return { pdf: chartPdf(title, rows, links, chartFont()), persons: Math.min(persons.length, CHART_MAX) };
}

// тап 🧬 / «/gedcom» / «/gedcomN»: <имя>.ged всегда, <имя>.pdf (диаграмма,
// имя из заголовка fileBaseOf); неудача — фолбэк текстовым гедкомом (sendLong)
export async function sendGedPdf(chatId, keys, head) {
    const g = await gedcomText(chatId, keys);
    const base = fileBaseOf(head || "Гедком-древо");
    let pdf = null, persons = 0;
    try {
        const res = await chartFor(chatId, keys, head || "Гедком-древо");
        // chartPdf сам отсекает до 50 младших — файл всегда строится
        persons = res.persons;
        pdf = res.pdf;
    } catch (e) { console.error("chart:", e.message); }
    try {
        const enc = new TextEncoder();
        await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(enc.encode(g), base + ".ged", { type: "text/plain" }),
            caption: head,
        });
        if (pdf) await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(Uint8Array.from(pdf, c => c.charCodeAt(0)), base + ".pdf", { type: "application/pdf" }),
            caption: "🧬 Диаграмма древа: " + persons + " персон",
        });
        console.log("ged artifacts: " + base + ".ged" + (pdf ? " + " + base + ".pdf (" + persons + " персон)" : ""), "chat", chatId);
        return;
    } catch (e) {
        console.error("sendDocument:", e.message);
    }
    await sendLong(chatId, (head ? head + "\n" : "") + g);
}

export { focusKeys, focusHasPair, focusWithSpouses };

// ============================== ГЕДКОМ: импорт = ЗАМЕНА ==============================

// импорт разобранного гедкома = ЗАМЕНА: дерево чата очищается и заливается
// заново (слияние больше не делаем — смешивание источников ломало базу).
// fam — по одному на каждый FAM файла с точными xref'ами (без слипания
// семей ребёнка); свадьбы живут на fam — точная привязка супругов;
// возвращает краткий отчёт. Повторный импорт лечит любые старые данные
export async function importGedcom(chatId, g) {
    await clearChatTree(chatId);
    const byX = new Map(); // xref файла → xref в базе (совпавшие «Имя Д» — один)
    let persons = 0;
    for (const ind of g.indis) {
        if (!ind.name || !ind.birt || !ind.birt.date) continue;
        let xref = ind.__xref;
        const same = (await indiRows(chatId)).find(r => r.name === ind.name && r.birtD === ind.birt.date);
        if (same) xref = same.xref;
        else await db.insert(indi).values({
            chatId, xref, name: ind.name, birtD: ind.birt.date,
            birtH: null, birtM: null,
            srcH: ind.birt.time ? Number(ind.birt.time.slice(0, 2)) : null,
            srcM: ind.birt.time ? Number(ind.birt.time.slice(3, 5)) : null,
            deatD: ind.deat && ind.deat.date ? ind.deat.date : null, deatH: null, deatM: null,
            dsrcH: ind.deat && ind.deat.time ? Number(ind.deat.time.slice(0, 2)) : null,
            dsrcM: ind.deat && ind.deat.time ? Number(ind.deat.time.slice(3, 5)) : null,
            sex: ind.sex ?? null, plac: null,
        }).run();
        byX.set(ind.__xref, xref);
        persons++;
    }
    let linkCount = 0, weddings = 0;
    for (const f of g.fams) {
        const h = f.husb && byX.get(f.husb), w = f.wife && byX.get(f.wife);
        const hasMarr = f.marr && f.marr.date;
        await db.insert(fam).values({
            chatId, xref: f.__xref, adhoc: false, husb: h ?? null, wife: w ?? null,
            marrD: hasMarr ? f.marr.date : null,
            marrPlac: hasMarr && f.marr.plac ? f.marr.plac : null,
            divD: f.div && f.div.date ? f.div.date : null,
            divPlac: f.div && f.div.plac ? f.div.plac : null,
        }).run(); // тот же FAM zweimal — не бывает в валидном гедкоме
        for (const cx of f.chil) {
            const c = byX.get(cx);
            if (!c) continue;
            try {
                await db.insert(chil).values({ chatId, fam: f.__xref, indi: c, adopted: f.adopted.includes(cx) }).run();
            } catch { /* дубли */ }
            for (const p of [h, w]) {
                if (!p || p === c) continue;
                const pk = await keyOfXref(chatId, p), ck = await keyOfXref(chatId, c);
                if (!pk || !ck) continue;
                const exists = (await edgeRows(chatId)).find(l => l.parent === pk && l.child === ck);
                if (exists) continue;
                await db.insert(edges).values({ chatId, parent: pk, child: ck, who: "c", famXref: f.__xref }).run();
                linkCount++;
            }
        }
        if (h && w && hasMarr) weddings++;
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
    return { persons, links: linkCount, weddings };
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
        await sendLong(chatId, "🧬 Резерв прежнего дерева (текстом):\n" + g);
        return true;
    } catch (e) {
        console.error("backup text:", e.message);
        return false;
    }
}

// замена дерева чата гедкомом; backup=true — сначала выложить прежнее
// дерево файлом (не смогли — замена отменяется, старые данные целы).
// Возвращает {ok, head} для ответа в чат
export async function replaceWithGedcom(chatId, g, backup) {
    if (backup && !(await sendTreeBackup(chatId)))
        return { ok: false, head: "💥 Не удалось выложить резерв — замена отменена, прежнее дерево цело" };
    const r = await importGedcom(chatId, g);
    return {
        ok: true,
        head: "♻️ Заменено: персон " + r.persons + ", связей " + r.links
            + (r.weddings ? ", свадеб " + r.weddings : ""),
    };
}

// sendMessage с разбиением длинного текста (лимит TG 4096);
// текст jubileeText — HTML со спойлерами, поэтому parse_mode всегда HTML
export async function sendLong(chatId, text, replyMarkup) {
    const MAX = 4000;
    if (text.length <= MAX) {
        await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup });
        return;
    }
    const parts = [];
    let rest = text;
    while (rest.length > MAX) {
        let cut = rest.lastIndexOf("\n", MAX);
        if (cut < MAX / 2) cut = MAX;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, "");
    }
    if (rest) parts.push(rest);
    for (let i = 0; i < parts.length; i++) {
        await api.sendMessage({
            chat_id: chatId, text: parts[i], parse_mode: 'HTML',
            reply_markup: i === parts.length - 1 ? replyMarkup : undefined,
        });
    }
}
