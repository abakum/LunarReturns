// Общий код TG-бота: настройки, клавиатуры, тексты «сегодня»/«список».
import { db, api } from 'sdk';
import { and, eq, or, inArray } from 'sdk/db';
import { indi, fam, chil, edges, settings, focusView } from '../schema.js';
import { mskToday } from './astro.js';
import { kinLabel } from './kinship.js';
import { REL_DEFS, religiousDigest } from './religion.js';
import { jubileeText } from './text.js';

export const HELP = "Отправьте «Имя ГГГГ-ММ-ДД [ЧЧ:ММ] [дата смерти]» — покажу лунно-солнечные юбилеи.\n"
    + "Можно с зоной: «… 12:30 (Пермь)» или «… 12:30 МСК+2», по одной строке на событие.\n"
    + "Пачкой древа в ответе на героя — ЗАМЕНА его ветви (срезана и привита);\n"
    + "кнопка 🔗 под ответом — пачка ВЕТВИ персоны (как «-+=» на фокусе).\n"
    + ".ged-файл чатом — замена древа; /today — события сегодня (МСК), /gedcom — древо,\n"
    + "/bellN (в ответ на триггер) — список родни в радиусе N (как 🔔 фокуса),\n"
    + "/links (в ответ на триггер) — пачка ВЕТВИ героя (как «-+=» на фокусе),\n"
    + "без ответа — пачка древа чата; /Иван — поиск по древу\n"
    + "(/-Пётр — мужчины 0-го уровня, /--Иван — 1-го, /=… — женщины; «/ текст» — подстрока;\n"
    + "/-, /--, /+…, /=… — все мужчины/свадьбы/женщины уровня)\n"
    + "Кнопки под ответом: 👎 удалить, 👀 подробно.\n"
    + "Кнопки чата: 🔔 — список событий (по ММ-ДД), 🧬 — древо (.ged+.pdf+.ged.txt — пачка радиуса: вверх и вниз),\n"
    + "«-+=» — пачка ветви (герой первой строкой, потомки — вся глубина).\n"
    + "Пачкой в ответе на цитату — ЗАМЕНА ветви цитируемого: срезана и привита;\n"
    + "одной строкой без маркера в ответе на триггер — ПРАВКА записи целиком (пол и ветвь не трогаются).\n"
    + "Пачкой просто сообщением — добавление к древу.\n"
    + "Пачка одним сообщением/файлом .ged.txt: «-»/«=»×n Имя … — свой мужчина/женщина\n"
    + "глубины n−1, «+»×n дата или «+» без даты (n−1 — глубина владельца) — свадьба,\n"
    + "вторая половина строкой ниже без маркера; строки дат без «+» — ошибка;\n"
    + "дети — глубина пары+1; персона без даты тоже допустима.";

// сколько живёт «Да/Нет»-вопрос на дроп .ged-файла (час)
export const GED_TTL = 3600000;

const DEFAULT_SETTINGS = { orth: false, islam: false, bud: false, cath: false, jud: false, bell: true };

export async function getSettings(chatId) {
    const row = await db.select().from(settings).where(eq(settings.chatId, chatId)).get();
    return row || { chatId, ...DEFAULT_SETTINGS };
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
// abt/dabt — гранулярность примерности ДР/смерти (1 год/2 месяц/3 «~»):
// юбилеи по ним не оповещаются
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

// ============================== ПЛОСКОЕ ДРЕВО ==============================
// применить разбор parseTree: персоны (пол по маркеру, note), пары-свадьбы,
// дети; повтор по имя+дата переиспользует персону; родитель должен быть старше
// ребёнка как минимум на 12 лет (иначе связь не пишется, в отчёте ошибка).
// Пачка самодостаточна: корень (герой ветви) — первая персона, не ребёнок
// внутри пачки и не половина пары; его дети привязываются его семьями.
// → { persons, fams, links, errors }
export async function applyTree(chatId, tree) {
    const rep = { persons: 0, fams: 0, links: 0, errors: tree.errors.map(e => ({ ...e })) };
    const sexN = i => (i !== null && i !== undefined && tree.persons[i] ? tree.persons[i].sex : null);
    const nameN = i => (i !== null && i !== undefined && tree.persons[i] ? tree.persons[i].rec.n : "");
    // xref половины пары: связь fam по паре или новая «W»-семья
    const famForPair = async (mx, fx, md) => {
        const rows = (await famRowsOf(chatId)).sort((a, b) => a.id - b.id);
        for (const f of rows)
            if (f.husb && f.wife && ((f.husb === mx && f.wife === fx) || (f.husb === fx && f.wife === mx)))
                return f.xref;
        // односторонняя семья переиспользуется: та же половина, вторая пуста,
        // дата свадьбы совпадает (повторный импорт того же текста не плодит пар)
        if (mx === null || fx === null)
            for (const f of rows)
                if ((f.husb === mx && f.wife === fx && (f.husb !== null || f.wife !== null))
                    && f.marrD === (md ?? null))
                    return f.xref;
        const x = await nextFamXref(chatId, "W");
        await db.insert(fam).values({ chatId, xref: x, adhoc: true, husb: mx || null, wife: fx || null }).run();
        rep.fams++;
        return x;
    };
    const xr = []; // индекс persons → xref
    const seen = new Set(); // реально учтённые записи: повторный «Имя Д»
    // (выкладка среди супругов + у родителей) входит в счёт один раз
    for (let i = 0; i < tree.persons.length; i++) {
        const p = tree.persons[i], rec = p.rec;
        let x;
        if (rec.d === undefined && !rec.n.includes("+")) {
            x = await stubOf(chatId, rec.n); // персона без события — заглушка
            await db.update(indi).set({ sex: p.sex || null, note: p.note || null })
                .where(and(eq(indi.chatId, chatId), eq(indi.xref, x))).run();
        } else {
            const r = await upsertPerson(chatId, Object.assign({ sex: p.sex, note: p.note }, rec));
            x = r ? r.xref : null;
        }
        xr.push(x);
        if (x != null && !seen.has(x)) { seen.add(x); rep.persons++; }
    }
    for (const w of tree.weddings) {
        const mx = w.m !== null ? xr[w.m] : null, fx = w.f !== null ? xr[w.f] : null;
        if (!mx && !fx) continue;
    const fxx = await famForPair(mx, fx, w.rec.d);
        await db.update(fam).set({
            marrD: w.rec.d, marrAbt: w.rec.abt ?? 0, marrPlac: w.rec.plac ?? null, note: w.note || null,
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
        if (ps.length === 2) fxx = await famForPair(ps[0].x, ps[1].x);
        else {
            // один родитель — своя adhoc-семья («L»), пол стороны по маркеру
            const x = await nextFamXref(chatId, "L");
            await db.insert(fam).values({ chatId, xref: x, adhoc: true,
                husb: ps[0].sex === "M" ? ps[0].x : null,
                wife: ps[0].sex !== "M" ? ps[0].x : null }).run();
            fxx = x;
            rep.fams++;
        }
        const has = await db.select().from(chil)
            .where(and(eq(chil.chatId, chatId), eq(chil.fam, fxx), eq(chil.indi, cx))).all();
        if (!has.length) {
            await db.insert(chil).values({ chatId, fam: fxx, indi: cx }).run();
            rep.links++;
        }
    }
    // голая пачка тоже восстанавливает интерактивные связи (edges) — иначе
    // /gedcom после импорта .txt-пачки не видит связей
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
// { error } — новое имя+дата заняты, запись не менялась
// (ВК-копия: lunarreturns.js, editTrigger)
export async function editTrigger(chatId, anchorKey, rec) {
    const xref = await xrefOfKey(chatId, anchorKey);
    if (!xref) return null;
    const newKey = rec.n + " " + rec.d;
    if (newKey !== anchorKey
        && (await indiRows(chatId)).some(r => r.xref !== xref && r.name === rec.n && r.birtD === rec.d))
        return { error: "«" + newKey + "» уже есть — правка отменена" };
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
    // персонажи прививаемой пачки: их свадьбы-заглушки (пары по именам) — тоже
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

// герой пачки: не «+»-половина (spouseLine) и не ребёнок внутри пачки; свои
// свадьбы герою не мешают (его браки — часть ветви). Ветвевая пачка всегда
// начинается с героя — первым корнем он и берётся
export function rootOf(tree) {
    for (let i = 0; i < tree.persons.length; i++) {
        if (tree.persons[i].spouseLine) continue;
        if (tree.children.some(ch => ch.c === i)) continue;
        return tree.persons[i];
    }
    return null;
}

// правка ветви: цитируемый anchorKey — герой пачки tree. Молча: старая ветвь
// срезается (cutBranch), поля героя обновляются по строке героя пачки (имя и
// дата рождения правимы), новая ветвь прививается applyTree'ом. Цитируемый
// не найден — пачка применяется как есть (добавление merge'ем).
// Пачка РОМБА (chatFlatText по keys — .ged.txt третьего прицепа 🧬) несёт
// героя ВНУТРИ дерева (первым корнем идёт старший предок) и открывается
// меткой NOT_FOR_GRAFT: радиус не несёт всех потомков героя, прививка
// обновила бы связи лишь частично. Такая пачка отвергается — правки нет,
// ответ-ошибка предлагает плоское древо тапа «-+=». Мимо якоря метка резке
// мешает, а добавлению нет: merge пачки ромба в чистый чат работает как прежде
export async function cutAndGraft(chatId, anchorKey, tree) {
    if (tree.noGraft) // метка NOT_FOR_GRAFT первой строкой (пачка ромба)
        return { persons: 0, fams: 0, links: 0, errors: [], noGraft: true };
    const px = await xrefOfKey(chatId, anchorKey);
    if (!px) return { ...(await applyTree(chatId, tree)), cut: 0, famsCut: 0 };
    const heroIdx = tree.persons.findIndex(p => !p.spouseLine
        && p.rec.n + " " + p.rec.d === anchorKey);
    const root = rootOf(tree);
    if (heroIdx >= 0 && root && tree.persons.indexOf(root) !== heroIdx) {
        const rep = await applyTree(chatId, tree); // герой внутри пачки — merge без резки
        rep.cut = 0; rep.famsCut = 0;
        return rep;
    }
    const cut = await cutBranch(chatId, px,
        tree.persons.map(p => p.rec.n)); // свадьбы-заглушки пар пачки тоже срезаются
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
        // строка оставалась и персон показывали поиск/списки/пачка/гедком)
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
// byFullDate=false — круговой порядок «от сегодня» (как religiousYear):
// ММ-ДД сегодня первым, события прошлой части года — в конце;
// true — все события по полной дате ГГГГ-ММ-ДД (подтверждение удаления)
export async function upcomingText(chatId, byFullDate = false, mmddNow = "") {
    let rows = [...await personRows(chatId), ...await weddingRows(chatId)];
    if (!byFullDate) rows = rows.filter(r => !r.abt && !r.dabt && !r.mabt); // примерные — мимо оповещений
    const map = rs => rs
        .map(r => r.n + " " + r.d
            + (r.dd !== undefined ? " " + r.dd : "")
            + (r.h !== undefined ? " " + String(r.h).padStart(2, "0") + ":" + String(r.m).padStart(2, "0") : ""))
        .join("\n");
    const key = r => r.d + " " + (r.h !== undefined ? String(r.h).padStart(2, "0") + String(r.m ?? 0).padStart(2, "0") : "");
    if (byFullDate) return map(rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
    // круговой порядок по ММ-ДД от сегодняшнего MM-DD
    const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]; // невисокосный год
    const dayIdx = d => cum[Number(d.slice(5, 7)) - 1] + Number(d.slice(8)) - 1;
    const nowIdx = mmddNow ? cum[Number(mmddNow.slice(0, 2)) - 1] + Number(mmddNow.slice(3)) - 1 : 0;
    const sortKey = r => String((dayIdx(r.d) - nowIdx + 365) % 365).padStart(3, "0") + " " + key(r);
    return map(rows.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)));
}

// сегодняшний MM-DD по МСК — отсечка «от сегодня» для списков колокольчика
export function mmddToday() {
    const [, mo, d] = mskToday();
    return String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

// кнопки под ответом бота на триггер: 👎 — удалить событие (как реакция VK),
// 👀 — подробно, 🔗 — пачка ВЕТВИ персоны (как «-+=» на фокусе, тап —
// handlers/callback_query.js links:); callback_data — xref
export function eventMarkup(xref) {
    return {
        inline_keyboard: [[
            { text: "👎", callback_data: "del1:" + xref },
            { text: "👀", callback_data: "det:" + xref },
            { text: "🔗", callback_data: "links:" + xref },
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
// (паритет VK: relKeyboard/ownerKeyboard/bellMarkup); колокольчик всегда 🔔
export function startMarkup(chat, isAdmin, chatId, s) {
    if (chat.type === 'private') return relMarkup(chatId, s);
    return isAdmin ? ownerMarkup() : bellMarkup();
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

// подпись радиуса в тостах фокус-кнопок (цифры и 🧬): «диапазон» уровня —
// как в колонке чарта у героя (rangeLevel)
export const focusLabel = rangeLevel;

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
// params — (items, keys, key, pairs, spousePairs, sexOf, byFullDate, mmddToday);
// byFullDate=false — «от сегодня»: ММ-ДД ≥ mmddToday, true — все по полной дате
export function focusListText(items, keys, key, pairs, spousePairs, sexOf, byFullDate = false, mmddToday = "") {
    const set = new Set(keys);
    const map = rs => rs
        .map(r => r.n + " " + r.d
            + (r.dd ? " " + r.dd : "")
            + (r.h !== undefined ? " " + String(r.h).padStart(2, "0") + ":" + String(r.m).padStart(2, "0") : "")
            + (() => { const l = kinLabel(pairs, spousePairs, sexOf, key, r.n + " " + r.d); return l ? " " + l : ""; })())
        .join("\n");
    const sortKey = r => r.d + " " + (r.h !== undefined ? String(r.h).padStart(2, "0") + String(r.m ?? 0).padStart(2, "0") : "");
    if (byFullDate) return map(items
        .filter(r => set.has(r.n + " " + r.d) || (r.n.includes("+") && focusHasPair(r.n, keys)))
        .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0)));
    // круговой порядок по ММ-ДД от сегодняшнего MM-DD (как religiousYear)
    const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]; // невисокосный год
    const dayIdx = d => cum[Number(d.slice(5, 7)) - 1] + Number(d.slice(8)) - 1;
    const nowIdx = mmddToday ? cum[Number(mmddToday.slice(0, 2)) - 1] + Number(mmddToday.slice(3)) - 1 : 0;
    const bellKey = r => String((dayIdx(r.d) - nowIdx + 365) % 365).padStart(3, "0") + " " + sortKey(r);
    return map(items
        .filter(r => set.has(r.n + " " + r.d) || (r.n.includes("+") && focusHasPair(r.n, keys)))
        .sort((a, b) => (bellKey(a) < bellKey(b) ? -1 : bellKey(a) > bellKey(b) ? 1 : 0)));
}

// клавиатура фокус-сообщения: как /start по роли, но без кнопок религий,
// 🔔/🧬 действуют в радиусе, а в ряд с ❌ добавлены неактивные цифры радиуса
// (активная скрыта; цифра r выводится, если есть предки глубины r — depth
// = focusDepth; grace при старом вызове без depth — все цифры);
// колокольчик всегда 🔔 (подписки нет — список всегда «от сегодня»)
export function focusMarkup(chat, chatId, s, radius, depth) {
    const btn = (text, data) => ({ text, callback_data: data });
    const bell = btn("🔔", "focbell");
    const tree = btn("🧬", "foctree");
    const flat = btn("-+=", "focflat");
    const digits = [1, 2, 3, 4, 5]
        .filter(n => n !== radius && n <= (depth === undefined ? 5 : depth))
        .map(n => btn(String(n) + "\u20E3", "foc" + n));
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

export async function gedcomText(chatId, keys) {
    const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const gdate = d => { const [y, mo, dd] = d.split("-").map(Number); return dd + " " + MON[mo - 1] + " " + y; };
    // примерная дата: год-only (abt 1) — «ГГГГ», месяц-only (abt 2) — «JUN 1987»,
    // примерный день (abt 3) — «ABT <гедком>»
    const gdateAbt = (d, abt) => abt === 1 ? d.slice(0, 4)
        : abt === 2 ? MON[Number(d.slice(5, 7)) - 1] + " " + d.slice(0, 4)
        : abt === 3 ? "ABT " + gdate(d)
        : gdate(d);
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
    // fam-строки в {xref, adhoc, parents — ключи, stubs — бездатные супруги,
    // kstubs — бездатные дети, children, marr, div}
    const fams = [];
    for (const f of (await famRowsOf(chatId)).sort((a, b) => a.id - b.id)) {
        const pkeys = [], stubs = [], kstubs = [], children = [];
        const stubOfX = async x => {
            const i = await getIndi(chatId, x);
            if (!i || !i.name) return null;
            return { xref: x, name: i.name, sex: i.sex || null, deat: i.deatD || null, dp: i.deatPlac || null,
                dabt: i.deatD ? i.deatAbt || 0 : 0 };
        };
        for (const x of [f.husb, f.wife]) {
            if (!x) continue;
            const k = await keyOfXref(chatId, x);
            if (k) pkeys.push(k);
            else {
                const st = await stubOfX(x);
                if (st && !stubs.some(s => s.xref === x)) stubs.push(st);
            }
        }
        for (const r of (await db.select().from(chil).where(and(eq(chil.chatId, chatId), eq(chil.fam, f.xref))).all()).sort((a, b) => a.id - b.id)) {
            const k = await keyOfXref(chatId, r.indi);
            if (k) children.push(k);
            else {
                const st = await stubOfX(r.indi);
                if (st && !kstubs.some(s => s.xref === r.indi)) kstubs.push(st);
            }
        }
        const marr = f.marrD ? { d: f.marrD, ...(f.marrAbt ? { abt: f.marrAbt } : {}), ...(f.marrPlac ? { plac: f.marrPlac } : {}) } : null;
        const div = f.divD ? { d: f.divD, ...(f.divAbt ? { abt: f.divAbt } : {}), ...(f.divPlac ? { plac: f.divPlac } : {}) } : null;
        const fnote = f.note || null;
        if (hasKeys) {
            // фрагмент: семья остаётся при ХОТЬ ОДНОЙ половине в keys (как
            // в пачке chatFlatText — famBody печатает свадьбы половин из
            // keys): бездетные свадьбы и семьи с детьми за пределами keys
            // тоже идут, иначе пачка .ged.txt и гедком .ged одной пачки
            // расходились бы (round-trip терял свадьбы и ломал глубины).
            // famc за радиусом (в keys лишь ребёнок) — мимо: в пачке таких
            // строк нет, глубины он не меняет
            const ps = pkeys.filter(p => keys.includes(p));
            if (!ps.length) continue;
            const cs = children.filter(c => keys.includes(c));
            pkeys.length = 0; pkeys.push(...ps);
            children.length = 0; children.push(...cs);
            // фрагмент — датированные персоны из keys; заглушки-половины/дети — как есть
        } else if (!pkeys.length && !stubs.length && !kstubs.length && !children.length) continue;
        const s = pkeys.slice().sort();
        const m = fams.find(x => x.s.length === s.length && x.s.every((p, i) => p === s[i]));
        if (m) {
            m.fx.push(f.xref);
            for (const c of children) if (!m.children.includes(c)) m.children.push(c);
            for (const st of stubs) if (!m.stubs.some(x => x.xref === st.xref)) m.stubs.push(st);
            for (const st of kstubs) if (!m.kstubs.some(x => x.xref === st.xref)) m.kstubs.push(st);
            if (!m.marr) m.marr = marr;
            if (!m.div) m.div = div;
            if (!m.fnote) m.fnote = fnote;
        } else fams.push({ s, fx: [f.xref], pkeys, stubs, kstubs, children, marr, div, fnote });
    }
    // поколения: семьи родителей раньше семей детей — каноническая нумерация
    // FAM независимо от порядка вставки (см. famsByGenerations)
    const famsOrd = famsByGenerations(fams,
        f => [...f.pkeys, ...f.stubs.map(s => s.xref)],
        f => [...f.children, ...f.kstubs.map(s => s.xref)]);
    for (let i = 0; i < fams.length; i++) fams[i] = famsOrd[i];
    // заглушкам — X-номера; FAM — по порядку; HUSB/WIFE по полу (без — HUSB)
    let stubN = 0;
    const stubId = new Map(), stubInfo = new Map();
    const addStub = st => {
        if (!stubId.has(st.xref)) { stubId.set(st.xref, "X" + (++stubN)); stubInfo.set(st.xref, st); }
    };
    for (const f of fams) {
        for (const st of f.stubs) addStub(st);
        for (const st of f.kstubs) addStub(st);
    }
    const fidOf = new Map(fams.map((f, i) => [f, "F" + (i + 1)]));
    const adoptedHere = (f, k) => f.fx.some(x => adoptedOf.get(k) === x);
    const out = ["0 HEAD", "1 SOUR LunarReturns", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"];
    for (const r of persons) {
        out.push("0 @" + idOf.get(pkey(r)) + "@ INDI");
        out.push("1 NAME " + r.n);
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
            if (f.children.includes(pkey(r))) {
                out.push("1 FAMC @" + fidOf.get(f) + "@");
                if (adoptedHere(f, pkey(r))) out.push("1 ADOP", "2 FAMC @" + fidOf.get(f) + "@");
            }
            if (f.pkeys.includes(pkey(r))) out.push("1 FAMS @" + fidOf.get(f) + "@");
        }
    }
    // заглушки (бездатные супруги/дети): имя + пол + смерть/место, если известны
    for (const [x, st] of stubInfo) {
        out.push("0 @" + stubId.get(x) + "@ INDI");
        out.push("1 NAME " + st.name);
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
            ...f.pkeys.map(k => ({ ref: idOf.get(k), sex: sexOf.get(k) })),
            ...f.stubs.map(s => ({ ref: stubId.get(s.xref), sex: s.sex || null })),
        ];
        for (const x of all.filter(x => x.sex !== "F")) out.push("1 HUSB @" + x.ref + "@");
        for (const x of all.filter(x => x.sex === "F")) out.push("1 WIFE @" + x.ref + "@");
        for (const c of f.children) {
            out.push("1 CHIL @" + idOf.get(c) + "@");
            if (adoptedHere(f, c)) out.push("2 PEDI adopted");
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

// ============================== ПЛОСКОЕ ДРЕВО: вывод ==============================
// Список чата в формате пачки (ввод/вывод симметричны, как Romanov_family.txt):
// '-'×n — свой мужчина глубины n−1; '='×n — своя женщина; «+»×n (n−1 —
// глубина владельца) — свадьба, вторая половина — строкой ниже без маркера
// (пол выводится); одностороняя семья — «+»×n сама по себе; дети — глубина пары+1; заглушки
// (без события) — именные строки. Показ — тапом на колокольчик (🔔/🔕).
// Примечание — с маркером «^» (см. грамматику пакета в tgcloud/lib/parse.js).
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
        const F = { hKey: null, hName: null, wKey: null, wName: null, children: [], marr: null, div: null, note: f.note || null };
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
        const s = [F.hKey, F.wKey].filter(k => k != null).sort();
        const m = fams.find(x => x.s.length === s.length && x.s.every((k, i) => k === s[i]));
        if (m) {
            for (const c of F.children) if (!m.children.includes(c)) m.children.push(c);
            if (m.hKey == null && F.hKey != null) m.hKey = F.hKey;
            if (m.wKey == null && F.wKey != null) m.wKey = F.wKey;
            if (!m.marr) m.marr = F.marr;
            if (!m.div) m.div = F.div;
            if (!m.note) m.note = F.note;
        } else fams.push({ s, ...F });
    }
    // поколения до построения пачки: семьи родителей раньше семей детей
    // (см. famsByGenerations) — familyOf (первая семья ребёнка), «mine»
    // (порядок браков) и famsDone не зависят от порядка вставки семей
    const famsOrd = famsByGenerations(fams,
        f => [f.hKey, f.wKey].filter(k => k != null), f => f.children);
    for (let i = 0; i < fams.length; i++) fams[i] = famsOrd[i];
    return [persons, fams];
}

// метка пачки РОМБА (chatFlatText по keys — .ged.txt третьего прицепа 🧬):
// герой посередине, радиус не несёт всех потомков героя — для резки-прививки
// такая пачка не годится. parseTree (tgcloud/lib/parse.js) читает метку
// первой непустой строкой в tree.noGraft, cutAndGraft её отвергает;
// строки «#» парсер пачки пропускает как комментарии — состав не меняется
const NOT_FOR_GRAFT = "#not for cut and graft";

export async function chatFlatText(chatId, keys = null) {
    // keys (опционально) — фокус-радиус: пачка только этого подмножества
    // (сродни gedcomText); семьи фильтруются по касанию персон/детей
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const [allPersons, allFams] = await flatRows(chatId);
    const persons = allPersons.filter(p => !hasKeys
        || keys.includes(p.name + " " + (p.d ?? "")));
    if (!hasKeys) return flatTreeText(persons, allFams);
    const kOf = new Map(allPersons.map(p => [p.key, p.name + " " + (p.d ?? "")]));
    // пачка ромба несёт героя посередине (первым корнем — старший предок) —
    // для резки-прививки не годится: первой строкой метка NOT_FOR_GRAFT,
    // parseTree читает её в tree.noGraft, cutAndGraft такую пачку отвергает
    return NOT_FOR_GRAFT + "\n" + flatTreeText(persons, allFams.filter(f =>
        [f.hKey, f.wKey, ...f.children].some(k => k != null
            && keys.includes(kOf.get(k) || ""))));
}

// чистые подмножества пачки «ветвь героя»: fams, где герой/потомок является
// половиной (его браки, рекурсивно до листьев); вторые половины включаются в
// печать, но ветвь НЕ продолжают — другие семьи супруга в ветвь не годятся;
// extraKids — интерактивные связи (edges, «родитель→ребёнок»): потомки
// героя/потомка/половин по связям тоже в ветви
export function subsetBranch(persons, fams, x, extraKids = null) {
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

// пачка ветви персоны key («Имя ГГГГ-ММ-ДД»): поддерево потомков на всю
// глубину (семьи + интерактивные связи), герой — корневой строкой
// «-»×1/«=»×1; ввод/вывод симметричны
export async function branchFlatText(chatId, key) {
    const [allPersons, allFams] = await flatRows(chatId);
    const x = (allPersons.find(p => p.name + " " + (p.d ?? "") === key) || {}).key;
    if (x == null) return "";
    const [picked, fams] = subsetBranch(allPersons, allFams, x, await edgeKids(chatId));
    // герой — первой строкой пачки ветви (корень разбора): переставляем
    // его вперёд массива персон — корни flatTreeText визитуются
    // в порядке массива
    const hi = picked.findIndex(p => p.key === x);
    const persons = hi > 0 ? [picked[hi], ...picked.slice(0, hi), ...picked.slice(hi + 1)] : picked;
    return flatTreeText(persons, fams);
}

// fam в виде полу: hName/wName — имена заглушек ...
// fams of slot; чистая логика — дословно в обеих копиях
export function flatTreeText(persons, fams) {
    const byKey = new Map(persons.map(p => [p.key, p]));
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
    // Место — в скобках за своей датой (рождения/смерти): грамматика пачки
    // трактует время как местное в месте, поэтому с местом выводится
    // исходное время (если было), без места — московское, как прежде
    // примерная дата — гранулярно (approxOut): 1 — «ГГГГ», 2 — «ГГГГ-ММ»,
    // 3 — «~»-хвост за полной датой
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
    // строка персоны: bare — вторая половина «+»-свадьбы (без маркера), иначе
    // маркеры '-'×(d+1)/'='×(d+1); заглушки — только имя
    const lineOf = (r, male, d, bare) => {
        const m = bare ? "" : (male ? "-" : "=").repeat(d + 1);
        out.push(m + r.name
            + (r.nameOnly ? "" : (r.d != null || r.dd != null || r.note ? " " + tail(r) : "")));
        if (typeof r.key === "string") printed.add(r.key);
    };
    // строка свадьбы «+»×(d+1) + даты: вторая дата = развод; место/примечание в хвосте
    // (примечание — с маркером «^», как у персон)
    const wedPlus = f => {
        const bits = [dOut(f.marr.d, f.marr.abt)];
        if (f.div) bits.push(dOut(f.div.d, f.div.abt));
        if (f.marr.plac) bits.push("(" + f.marr.plac + ")");
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
            out.push("+".repeat(d + 1) + (f.marr ? wedPlus(f) : ""));
            // «другая половина» — ребёнок включённого семейства? Печатаем её
            // полную строку (с событием) под свадьбой, но НЕ закрываем её
            // от печати: строку с маркером позже выдаст родительская ветвь,
            // а при импорте одинаковые «Имя Д» схлопнутся в одну персону —
            // иначе связь с родителями потеряется. Половин её родительской
            // семьи в пачке нет (семья вне радиуса/ветви, вошла касанием
            // ребёнка) — закрываем сразу: открытой строке маркерную выдал
            // бы остаточный визит на нуле, пачка несла бы хвостовой дубль
            // и переставала быть идемпотентной
            const kfam = other.key != null ? familyOf.get(other.key) : null;
            const kid = other.key != null && !printed.has(other.key) && kfam
                && [kfam.hKey, kfam.wKey].some(k => k != null && byKey.has(k));
            if (kid) lineOf(other, other.sex !== "F", d, true);
            else if (other.key != null && printed.has(other.key))
                lineOf({ name: other.name, nameOnly: true }, other.sex !== "F", d, true);
            else lineOf(other, other.sex !== "F", d, true);
            if (kid) printed.delete(other.key); // маркерная строка — от родителей
        } else if (f.marr) {
            // семья без второй половины: односторонняя свадьба («+дата»);
            // голый «+» без даты не выводится — при пересборке пачки дети
            // и так привязываются к строке родителя
            out.push("+".repeat(d + 1) + wedPlus(f));
        }
        for (const ck of f.children) {
            const rk = byKey.get(ck);
            if (rk) visit(rk, d + 1);
        }
    };
    const visit = (r, d) => {
        if (printed.has(r.key)) return;
        printed.add(r.key);
        lineOf(r, r.sex !== "F", d, false);
        // бездатные односторонние семьи (дети от неизвестного супруга) —
        // первыми, сразу после строки персоны: при пересборке пачки их дети
        // привязываются к собственной семье персоны, а не к паре ниже
        const hasOther = f => {
            const k = f.hKey === r.key, x = k ? f.wKey : f.hKey;
            return x != null ? byKey.has(x) : (k ? f.wName : f.hName) != null;
        };
        const mine = fams.filter(f => f.hKey === r.key || f.wKey === r.key);
        for (const f of [...mine.filter(f => !hasOther(f) && !f.marr), ...mine.filter(f => hasOther(f) || f.marr)])
            famBody(f, r.key, d);
    };
    // дети не выпадают из семьи: сначала визит корней — персон, чья
    // родительская семья не в пачке или вошла без половин (familyOf,
    // касанием ребёнка, половины за радиусом/ветвью), в порядке массива;
    // famBody родителей выдаёт строки детей с маркерами глубины. Ребёнок,
    // вставленный раньше родителей (номер семьи детей меньше номера семьи
    // родителей), корнем не считается: раньше он печатался на нуле и
    // терял связь с семьёй при обратном импорте пачки. Условие зеркалит
    // kid в famBody: открытая строка — только при половинах в пачке.
    // Остаток — циклы, оторванные узлы — как прежде, на нуле.
    const isRoot = r => {
        const f = familyOf.get(r.key);
        return !f || ![f.hKey, f.wKey].some(k => k != null && byKey.has(k));
    };
    for (const r of persons) if (isRoot(r)) visit(r, 0);
    for (const r of persons) visit(r, 0);
    return out.join("\n");
}

// поиск по пачке «плоское древо» (chatFlatText): "/Иван" — префикс от начала
// строки (ведущие маркеры '-'/'='/'+' строк сняты); "/-Пётр" — только мужчины
// глубины 0, "/--Иван" — глубины 1, "/=…" — женщины (серия маркеров запроса
// должна совпасть с серией строки); "/ текст" — подстрока в строке без
// маркера; "/-", "/==", "/++" — все строки с такой серией маркеров (все
// мужчины/женщины/свадьбы уровня). Регистр не учитывается
export function flatSearch(flat, query) {
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

// ============================== ГЕДКОМ → PDF ==============================
// Чистая логика дословно продублирована в lunarreturns.js (dev/sync-check.mjs)

import { InputFile } from 'sdk';
import { CHART_MAX, chartPdf, chartFont, fileBaseOf, rangeLevel } from './chart.js';

// диаграммные данные чата/фрагмента (как у gedcomText: те же INDI, свадьбы
// «Имя+Имя» вне; семьи усекаются до персон фрагмента). heroKey — pkey героя
// (персона фокуса): ярлыки родства «Связь год» в колонке подписей; без героя
// — просто «Год» (древо чата). Бездатные именованные супруги датированных
// персон — строками с якорем (бар от года ДР супруга, колонка года пустая);
// без датированного супруга — не рисуются
export async function chartFor(chatId, keys, title, heroKey = null, range = null) {
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const persons = (await personRows(chatId)).filter(r => !hasKeys || keys.includes(pkey(r)));
    const keySet = new Set(persons.map(r => pkey(r)));
    const rows = persons.map(r => ({ name: r.n, birth: r.d, death: r.dd || null, sex: r.sex || null, abt: r.abt ?? 0 }));
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
        if (!famStubKey.has(an.fam)) famStubKey.set(an.fam, k);
        rows.push({ name: s.name, k, birth: null, anchor: an.yr, death: s.deatD || null, sex: s.sex || null });
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
    const links = [...parentsOf].filter(([, ps]) => ps.ds.length || ps.sk)
        .map(([c, ps]) => ({ child: ckey(c), parents: [...ps.ds.map(ckey), ...(ps.sk ? [ps.sk] : [])] }));
    // ярлыки родства — как в 🔔-списке (focusListText): linkPairs +
    // супруги fam-семей + пол; подписи в чарте всё равно «Связь год»;
    // диапазон героя rel.range (цифра кейапа заголовка, 4⃣ … → 4) — из sendGedPdf
    const hero = heroKey ? ckey(heroKey) : null;
    const rel = hero ? {
        hero,
        range,
        pairs: (await linkPairs(chatId)).map(([p, c]) => [ckey(p), ckey(c)]),
        spouses: (await focusSpousePairs(chatId)).map(sp => sp.map(ckey)),
        sex: Object.fromEntries(persons.map(r => [ckey(pkey(r)), r.sex || null])),
    } : null;
    // дети супругов вне фрагмента/радиуса: годы их рождения — вертикалью
    // между супругами (дата рождения берётся из всех персон чата;
    // заглушки без даты — пропускаются). Пара: обе датированные — как
    // прежде; датированный + бездатный в чарте — ключ бездатного («Имя
    // якорь»); бездатный не в чарте (вне фрагмента) — вертикали нет
    const bornOf = new Map((await personRows(chatId)).map(r => [pkey(r), r.d]));
    const phantoms = [];
    const marriages = [];           // свадьбы с датой: { fam: [ключ, ключ], year }
    for (const f of await famList(chatId)) {
        const ps = f.parents.filter(p => keySet.has(p));
        const sk = famStubKey.get(f.xref) || null;
        const pair = ps.length === 2 ? ps.map(ckey)
            : ps.length === 1 && sk ? [ckey(ps[0]), sk] : null;
        if (!pair) continue;
        // дата свадьбы — вертикаль между супругами в год свадьбы (без точек)
        if (f.marr && f.marr.d)
            marriages.push({ fam: pair, year: Number(f.marr.d.slice(0, 4)) });
        const yrs = [...new Set(f.children.filter(c => !keySet.has(c) && bornOf.has(c))
            .map(c => Number(bornOf.get(c).slice(0, 4))))].sort((a, b) => a - b);
        if (yrs.length) phantoms.push({ fam: pair, years: yrs });
    }
    return { pdf: chartPdf(title, rows, links, chartFont(), { ...rel, phantoms }, marriages), persons: Math.min(rows.length, CHART_MAX) };
}

// тап 🧬 / «/gedcom» / «/gedcomN»: <имя>.ged всегда, <имя>.pdf (диаграмма,
// имя из заголовка fileBaseOf); heroKey — pkey героя для колонки «Связь год»;
// неудача — фолбэк текстовым гедкомом (sendLong)
// Радиусный вызов (keys — ромб родни: тап 🧬 на фокусе и /gedcomN в ответ
// на триггер): третий файл <имя>.ged.txt — пачка того же ромба
// (chatFlatText по keys): форма «-+=», но не только вниз — и вверх, и вниз,
// в пределах радиуса; всему древу чата пачки нет (его «-+=» и так весь)
export async function sendGedPdf(chatId, keys, head, heroKey = null, replyTo = 0) {
    const g = await gedcomText(chatId, keys);
    // заголовок чарта без цифры уровня (кейкап оставлен только фокусу);
    // цифра → range героя для chartFor
    const head0 = head || "Гедком-древо";
    const chartHead = head0.replace(/^\d\u20E3\s*/, "");
    const rm = /^(\d)\u20E3/.exec(head0);
    const base = fileBaseOf(head0);
    // третий файл (радиусные 🧬 и /gedcomN): пачка ромба — chatFlatText по keys;
    // фолбэк текстом пачку не дублирует — она идёт только файлом
    const pack = Array.isArray(keys) && keys.length ? await chatFlatText(chatId, keys) : "";
    let pdf = null, persons = 0, chartErr = null;
    try {
        const res = await chartFor(chatId, keys, chartHead, heroKey, rm ? Number(rm[1]) : null);
        // chartPdf сам отсекает до CHART_MAX младших — файл всегда строится
        persons = res.persons;
        pdf = res.pdf;
    } catch (e) { chartErr = e.message.replace(/^chart:\s*/, ""); console.error("chart:", e.message); }
    try {
        const enc = new TextEncoder();
        // оба файла — ответом (reply) на сообщение с кнопками/командой
        await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(enc.encode(g), base + ".ged", { type: "text/plain" }),
            caption: head,
            ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        });
        if (pdf) await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(Uint8Array.from(pdf, c => c.charCodeAt(0)), base + ".pdf", { type: "application/pdf" }),
            caption: "🧬 Диаграмма древа: " + persons + " персон",
            ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        });
        // BOM — чтобы Windows-редакторы открывали пачку как UTF-8
        if (pack) await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(enc.encode("\uFEFF" + pack), base + ".ged.txt", { type: "text/plain" }),
            caption: "🧬 Пачка древа (радиус " + (rm ? rm[1] : "1") + "): вверх и вниз",
            ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
        });
        console.log("ged artifacts: " + base + ".ged" + (pdf ? " + " + base + ".pdf (" + persons + " персон)" : "")
            + (pack ? " + " + base + ".ged.txt" : ""), "chat", chatId);
        if (chartErr) await api.sendMessage({ chat_id: chatId, text: "💥 Диаграмма не построена: " + chartErr });
        return;
    } catch (e) {
        console.error("sendDocument:", e.message);
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось выложить файлы — гедком текстом" });
    }
    await sendLong(chatId, (head ? head + "\n" : "") + g, undefined, head0 || "Гедком-древо");
}

export { focusKeys, focusHasPair, focusWithSpouses };

// ============================== ГЕДКОМ: импорт = ЗАМЕНА ==============================

// импорт разобранного гедкома = ЗАМЕНА: дерево чата очищается и заливается
// заново (слияние больше не делаем — смешивание источников ломало базу).
// уникальный ключ «Имя Д»: занят — примерная дата (approx) сдвигается на день
// («ГГГГ-ММ-01»+1 → «1964-01-02»; арифметика Date UTC); точная — «~»-хвост
// к имени («Иван 1954~» → новый ключ «Иван~ 1954»). Сдвинутая примерная дата
// получает abt 3 (флаг примерности полного дня): иначе «Имя 1234» (abt 1,
// хранится «1234-01-01») после сдвига дубля на «1234-01-02» печаталось бы
// по-прежнему «1234» — сдвинутый день терялся бы (в т.ч. в выгрузке гедкома)
// (ВК-копия: lunarreturns.js, uniqueKeyOf)
export async function uniqueKeyOf(chatId, name, birtD, approx) {
    while (true) {
        const same = (await indiRows(chatId)).find(r => r.name === name && r.birtD === birtD);
        if (!same) return { name, birtD };
        if (approx) {
            const dt = new Date(birtD + "T00:00:00Z");
            dt.setUTCDate(dt.getUTCDate() + 1);
            birtD = dt.toISOString().slice(0, 10);
        } else name += "~";
    }
}

// примерная дата текстом: abt 1 — только год, 2 — год+месяц, 3 — «~» за
// полной датой (так же печатаются коллизии ключа в отчёте импорта)
function approxOut(d, abt) {
    return abt === 1 ? d.slice(0, 4) : abt === 2 ? d.slice(0, 7) : d + (abt ? "~" : "");
}

// fam — по одному на каждый FAM файла с точными xref'ами (без слипания
// семей ребёнка); свадьбы живут на fam — точная привязка супругов;
// бездатные импортируются, когда упомянуты в семье (супруг/ребёнок), —
// заглушки-персоны (birtD null), как свадебные половины; безымянные — мимо.
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
        const u = await uniqueKeyOf(chatId, ind.name, ind.birt.date, approx);
        // сдвинутый дубль — флаг примерности 3 (полный день с «~»): в базе
        // хранится тот же флаг, что печатается в отчёте ниже
        const uabt = u.birtD === ind.birt.date ? (ind.birt.abt || 0) : 3;
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
            birtAbt: uabt, // дубль со сдвинутой датой — abt 3 (иначе печать прячет сдвиг)
            deatAbt: (ind.deat && ind.deat.abt) || 0,
        }).run();
        byX.set(ind.__xref, ind.__xref);
        persons++;
    }
    // второй проход: бездатные супруги — ПОЛНАЯ дата супруга, birtAbt 3
    // (фиктивная: в шкале PDF нет года и прожитых лет); коллизия —
    // +1 день (как прочие примерные даты); бездатные дети и безымянные — мимо
    for (const ind of g.indis) {
        if (!ind.name || (ind.birt && ind.birt.date)) continue;
        if (!famRefs.has(ind.__xref)) continue;
        let full = null;
        for (const f of g.fams) {
            if (f.husb !== ind.__xref && f.wife !== ind.__xref) continue;
            const sx = f.husb === ind.__xref ? f.wife : f.husb;
            const sp = sx && g.indis.find(i => i.__xref === sx);
            if (sp && sp.birt && sp.birt.date) { full = resolved.get(sx) || sp.birt.date; break; }
        }
        if (full === null) {
            // бездатный ребёнок/супруг бездатного — заглушка (birtD NULL), как раньше
            await db.insert(indi).values({
                chatId, xref: ind.__xref, name: ind.name, birtD: null,
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
        const u = await uniqueKeyOf(chatId, ind.name, full, true);
        // фиктивная ДР от супруга — всегда birtAbt 3 (как и сдвинутый дубль):
        // в шкале PDF у такой строки нет года и прожитых лет
        const uabt = 3;
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
            birtAbt: uabt, // дубль со сдвинутой датой — abt 3 (иначе печать прячет сдвиг)
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
export async function sendLong(chatId, text, replyMarkup, name) {
    const parts = splitText(text);
    if (parts.length === 1) {
        await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup });
        return;
    }
    // BOM — чтобы Windows-редакторы (Блокнот) открывали как UTF-8, а не ANSI
    const base = fileBaseOf(name || "Ответ") + ".txt";
    try {
        const enc = new TextEncoder();
        await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(enc.encode("\uFEFF" + stripHtml(text)), base, { type: "text/plain" }),
            reply_markup: replyMarkup,
        });
        return;
    } catch (e) {
        console.error("tail document:", e.message);
        await api.sendMessage({
            chat_id: chatId, text: "💥 Не удалось выложить файл " + base });
    }
}

// «/links» и тап 🔗: пачка ВЕТВИ героя (key) — как «-+=» на фокусе, или
// пачка всего древа чата (key=null). Короткая — текстом, длинная (>4000) —
// файлом «.ged.txt» (как tailDoc). false — пачки нет (древо/ветвь пусты).
// Листинг сообщений-связей больше не восстанавливается.
export async function sendFlatPack(chatId, key, head = "", replyTo = 0) {
    const pack = key === null ? await chatFlatText(chatId) : await branchFlatText(chatId, key);
    if (!pack) return false;
    const reply = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
    if (pack.length <= 4000) {
        await api.sendMessage({ chat_id: chatId, text: (head ? head + "\n" : "") + pack, ...reply });
        return true;
    }
    const base = fileBaseOf(head || "Древо чата") + ".ged.txt";
    try {
        // BOM — чтобы Windows-редакторы открывали как UTF-8
        await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(new TextEncoder().encode("\uFEFF" + pack), base, { type: "text/plain" }),
            ...(head ? { caption: head } : {}),
            ...reply,
        });
    } catch (e) {
        console.error("tail document:", e.message);
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось выложить файл " + base, ...reply });
    }
    return true;
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

// сводка применения пачки (✅-строка + ошибки построчно) — общий формат ответа
export function treeReport(rep) {
    if (rep.noGraft) // пачка ромба в ответ на триггер — правки нет
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
