// Общий код TG-бота: настройки, клавиатуры, тексты «сегодня»/«список».
import { db, api } from 'sdk';
import { and, eq, or } from 'sdk/db';
import { events, settings, links, fams } from '../schema.js';
import { mskToday } from './astro.js';
import { kinLabel } from './kinship.js';
import { REL_DEFS, REL_ORDER, religiousDigest } from './religion.js';
import { jubileeText } from './text.js';

export const HELP = "Отправьте «Имя ГГГГ-ММ-ДД [ЧЧ:ММ] [дата смерти]» — покажу лунно-солнечные юбилеи.\n"
    + "Можно с зоной: «… 12:30 (Пермь)» или «… 12:30 МСК+2», по одной строке на событие.\n"
    + "Ответ триггером на триггер — связь родитель→ребёнок (гедком-древо чата).\n"
    + "/today — события и религиозные праздники сегодня (МСК), /gedcom — древо чата\n"
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

// события чата на сегодня (МСК) + религиозный дайджест; "" — ничего
export async function todayText(chatId) {
    const [, mo, d] = mskToday();
    const mmdd = String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    const rows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
    const parts = [];
    for (const r of rows) {
        if (r.date.slice(5) !== mmdd) continue;
        const rec = { n: r.name, d: r.date };
        if (r.hour !== null && r.hour !== undefined) { rec.h = r.hour; rec.m = r.minute; }
        parts.push(jubileeText(rec, ""));
    }
    const digest = religiousDigest(await getSettings(chatId));
    if (digest) parts.push(digest);
    return parts.join("\n\n");
}

// «Имя ГГГГ-ММ-ДД[ ГГГГ-ММ-ДД смерти][ ЧЧ:ММ]»; "" — событий нет.
// byFullDate=false — по возрастанию ММ-ДД (список 🔔), true — по полной дате
// ГГГГ-ММ-ДД (подтверждение удаления)
export async function upcomingText(chatId, byFullDate = false) {
    const rows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
    const key = r => (byFullDate ? r.date : r.date.slice(5)) + " " + (r.hour !== null && r.hour !== undefined ? String(r.hour).padStart(2, "0") + String(r.minute ?? 0).padStart(2, "0") : "");
    return rows
        .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
        .map(r => r.name + " " + r.date
            + (r.deathDate !== null && r.deathDate !== undefined ? " " + r.deathDate : "")
            + (r.hour !== null && r.hour !== undefined ? " " + String(r.hour).padStart(2, "0") + ":" + String(r.minute).padStart(2, "0") : ""))
        .join("\n");
}

// upsert события; возвращает строку с id (как upsertRecord VK-бота)
export async function upsertEvent(chatId, rec) {
    const vals = {
        chatId, name: rec.n, date: rec.d,
        hour: rec.h ?? null, minute: rec.m ?? null,
        sex: rec.sex ?? null,
        deathDate: rec.dd ?? null,
        plac: rec.plac ?? null,
        plac2: rec.plac2 ?? null,
        srcH: rec.srcH ?? null, srcM: rec.srcM ?? null,
        dsrcH: rec.dsrcH ?? null, dsrcM: rec.dsrcM ?? null,
    };
    const [row] = await db.insert(events).values(vals)
        .onConflictDoUpdate({
            target: [events.chatId, events.name, events.date],
            set: { hour: vals.hour, minute: vals.minute, deathDate: vals.deathDate, plac: vals.plac, plac2: vals.plac2, srcH: vals.srcH, srcM: vals.srcM, dsrcH: vals.dsrcH, dsrcM: vals.dsrcM },
        })
        .returning().run();
    return row;
}

// кнопки под ответом бота на триггер: 👎 — удалить событие (как реакция VK), 👀 — подробно
export function eventMarkup(id) {
    return {
        inline_keyboard: [[
            { text: "👎", callback_data: "del1:" + id },
            { text: "👀", callback_data: "det:" + id },
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

// ---- гедком-база: персоны/связи/семьи, дерево в рамках чата ----
// (перенос логики VK-бота: pkey/addLink/ensureFam/pairRecords/confirmPair/gedcomText)

const pkey = r => r.name + " " + r.date;         // ключ персоны «Имя ГГГГ-ММ-ДД»
const keyN = k => k.slice(0, -11);               // имя из ключа
const keyY = k => Number(k.slice(-10, -6));      // год рождения из ключа

const chatLinks = async chatId => db.select().from(links).where(eq(links.chatId, chatId)).all();
export { chatLinks };
const chatFams = async chatId => db.select().from(fams).where(eq(fams.chatId, chatId)).all();

export async function recordOf(chatId, key) {
    const rows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
    return rows.find(r => r.name + " " + r.date === key) || null;
}

// добавить связь родитель→ребёнок; who — кто из двоих пришёл новым триггером
export async function addLink(chatId, parentKey, childKey, who) {
    const existing = await chatLinks(chatId);
    const same = existing.find(l => l.parent === parentKey && l.child === childKey);
    if (same) return { link: same, dup: true };
    const [row] = await db.insert(links)
        .values({ chatId, parent: parentKey, child: childKey, who })
        .returning().run();
    return { link: row, dup: false };
}

export async function setLinkCand(link, cand) {
    await db.update(links).set({ pairCand: cand ? JSON.stringify(cand) : null })
        .where(eq(links.id, link.id)).run();
    link.pairCand = cand ? JSON.stringify(cand) : null;
}

// все родители ребёнка в чате
export async function parentKeys(chatId, childKey) {
    return [...new Set((await chatLinks(chatId)).filter(l => l.child === childKey).map(l => l.parent))];
}

// семья для свадьбы одного родителя: fam с этим родителем и ребёнком
// (ensureFam добьёт второго родителя, когда появится вторая связь)
async function ensureFamSingle(chatId, childKey) {
    const ps = await parentKeys(chatId, childKey);
    if (ps.length !== 1) return null;
    const existing = await chatFams(chatId);
    let f = existing.find(x => JSON.parse(x.children).includes(childKey));
    if (!f) {
        const [row] = await db.insert(fams)
            .values({ chatId, parents: JSON.stringify(ps), children: JSON.stringify([childKey]) })
            .returning().run();
        f = row;
    }
    const parents = JSON.parse(f.parents), children = JSON.parse(f.children);
    for (const p of ps) if (!parents.includes(p)) parents.push(p);
    if (!children.includes(childKey)) children.push(childKey);
    await db.update(fams).set({ parents: JSON.stringify(parents), children: JSON.stringify(children) })
        .where(eq(fams.id, f.id)).run();
    for (const l of (await chatLinks(chatId)).filter(l => l.child === childKey))
        await db.update(links).set({ famId: f.id }).where(eq(links.id, l.id)).run();
    return { ...f, parents, children };
}

// двое родителей — уже семья: собрать всех родителей ребёнка в один FAM
export async function ensureFam(chatId, childKey) {
    const ps = await parentKeys(chatId, childKey);
    if (ps.length < 2) return null;
    const existing = await chatFams(chatId);
    let f = existing.find(x => JSON.parse(x.children).includes(childKey));
    if (!f) {
        const [row] = await db.insert(fams)
            .values({ chatId, parents: JSON.stringify([]), children: JSON.stringify([childKey]) })
            .returning().run();
        f = row;
    }
    const parents = JSON.parse(f.parents), children = JSON.parse(f.children);
    for (const p of ps) if (!parents.includes(p)) parents.push(p);
    if (!children.includes(childKey)) children.push(childKey);
    await db.update(fams).set({ parents: JSON.stringify(parents), children: JSON.stringify(children) })
        .where(eq(fams.id, f.id)).run();
    for (const l of (await chatLinks(chatId)).filter(l => l.child === childKey))
        await db.update(links).set({ famId: f.id }).where(eq(links.id, l.id)).run();
    return { ...f, parents, children };
}

// почистить семьи после удаления связей: ребёнок остаётся в семье, пока
// есть связь с флагом fam; пустые семьи и висячие флаги снимаются; родители
// без действующей связи тоже убираются
export async function refreshFams(chatId) {
    const famRows = await chatFams(chatId);
    const linksLeft = await chatLinks(chatId);
    for (const f of famRows) {
        const children = JSON.parse(f.children)
            .filter(c => linksLeft.some(l => l.famId === f.id && l.child === c));
        const parents = JSON.parse(f.parents)
            .filter(p => linksLeft.some(l => l.famId === f.id && l.parent === p));
        if (!children.length) await db.delete(fams).where(eq(fams.id, f.id)).run();
        else if (children.length !== JSON.parse(f.children).length
            || parents.length !== JSON.parse(f.parents).length)
            await db.update(fams).set({ children: JSON.stringify(children), parents: JSON.stringify(parents) }).where(eq(fams.id, f.id)).run();
    }
    const famIds = new Set((await chatFams(chatId)).map(f => f.id));
    for (const l of linksLeft)
        if (l.famId !== null && l.famId !== undefined && !famIds.has(l.famId))
            await db.update(links).set({ famId: null }).where(eq(links.id, l.id)).run();
}

// удалить событие с каскадом: связи персоны; у пары «Имя+Имя» — свадьба/развод
// из семьи; висячие кандидаты-свадьбы у оставшихся связей; семьи чистятся
export async function deleteEventCascade(chatId, pk) {
    const name = pk.slice(0, -11), date = pk.slice(-10);
    await db.delete(events).where(and(eq(events.chatId, chatId), eq(events.name, name), eq(events.date, date))).run();
    await db.delete(links).where(and(eq(links.chatId, chatId),
        or(eq(links.parent, pk), eq(links.child, pk)))).run();
    if (name.includes("+")) {
        const [n1, n2] = name.split("+");
        for (const f of await chatFams(chatId)) {
            if (f.marrD !== date) continue;
            const ps = JSON.parse(f.parents);
            // второй родитель может быть ещё не в семье (ensureFamSingle)
            if (ps.some(p => keyN(p) === n1 || keyN(p) === n2))
                await db.update(fams).set({ marrD: null, marrPlac: null, divD: null, divPlac: null }).where(eq(fams.id, f.id)).run();
        }
    }
    for (const l of await chatLinks(chatId)) {
        if (!l.pairCand) continue;
        const cand = JSON.parse(l.pairCand).filter(c =>
            c.pair !== pk && !keyN(c.pair).split("+").includes(name));
        if (cand.length !== JSON.parse(l.pairCand).length)
            await setLinkCand(l, cand.length ? cand : null);
    }
    await refreshFams(chatId);
}

// кандидаты-свадьбы: триггеры «Иван+Мария ГГГГММДД» в базе; когда у ребёнка уже
// два родителя — где одна половина текущий родитель, другая — другой родитель;
// пока родитель один — все свадьбы с его участием (второй без даты рождения);
// свадьба позже рождения обоих (второго не проверяем — даты нет); может быть
// позже рождения ребёнка — это жизнь; релевантные — по близости года свадьбы
// к году рождения ребёнка; при известном поле учитывается порядок в имени
// («первый — М, второй — Ж», как расставляет пол confirmPair)
export async function pairRecords(chatId, link) {
    const cy = keyY(link.child), pn = keyN(link.parent), out = [], seen = new Set();
    const rows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
    const byKey = pk => rows.find(x => x.name + " " + x.date === pk);
    // половина пары согласуется с известным полом? (первая половина — М)
    const posMatch = (pk, isFirst) => {
        const r = byKey(pk);
        if (!r || !r.sex) return true;
        return r.sex === 'M' ? isFirst : !isFirst;
    };
    const others = (await parentKeys(chatId, link.child)).filter(x => x !== link.parent);
    for (const o of others) {
        for (const name of [pn + "+" + keyN(o), keyN(o) + "+" + pn]) {
            for (const r of rows.filter(r => r.name === name)) {
                const halves = r.name.split("+");
                if (!posMatch(link.parent, halves[0] === pn) || !posMatch(o, halves[0] === keyN(o))) continue;
                const pk = r.name + " " + r.date, wy = keyY(pk);
                if (wy <= keyY(link.parent) || wy <= keyY(o)) continue;
                if (seen.has(pk)) continue;
                seen.add(pk);
                out.push({ pair: pk, other: o, wy });
            }
        }
    }
    // родитель пока один: кандидат — вторая половина «Имя+Имя», ключа у неё нет
    if (!others.length) {
        for (const r of rows.filter(r => r.name.includes("+"))) {
            const halves = r.name.split("+");
            const i = halves.indexOf(pn);
            if (i !== 0 && i !== 1) continue;
            if (!posMatch(link.parent, i === 0)) continue;
            const other = i === 0 ? halves[1] : halves[0];
            const pk = r.name + " " + r.date, wy = keyY(pk);
            if (wy <= keyY(link.parent)) continue;
            if (seen.has(pk)) continue;
            seen.add(pk);
            out.push({ pair: pk, other, wy });
        }
    }
    return out.sort((a, b) => Math.abs(a.wy - cy) - Math.abs(b.wy - cy)).slice(0, 5);
}

// подтвердить свадьбу: связывает Ивана и Марию с «Иван+Мария ГГГГММДД»,
// первый в имени — М, второй — Ж; в гедком пишется MARR/DIV DATE/PLAC;
// если у ребёнка пока один родитель — семья создаётся с ним (второй доберётся
// через ensureFam, когда появится вторая связь)
export async function confirmPair(chatId, link, cand) {
    const f = await ensureFam(chatId, link.child) || await ensureFamSingle(chatId, link.child);
    if (!f) return null;
    const [pairName, pairDate] = [cand.pair.slice(0, -11), cand.pair.slice(-10)];
    const rows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
    const pairRec = rows.find(r => r.name === pairName && r.date === pairDate);
    if (!pairRec) return null;
    const upd = { marrD: pairRec.date, marrPlac: pairRec.plac };
    if (pairRec.deathDate) { upd.divD = pairRec.deathDate; upd.divPlac = pairRec.plac2; }
    await db.update(fams).set(upd).where(eq(fams.id, f.id)).run();
    const [n1, n2] = pairRec.name.split("+");
    for (const pk of f.parents) {
        const rec = rows.find(r => r.name + " " + r.date === pk);
        if (!rec) continue;
        if (keyN(pk) === n1) await db.update(events).set({ sex: 'M' }).where(eq(events.id, rec.id)).run();
        else if (keyN(pk) === n2) await db.update(events).set({ sex: 'F' }).where(eq(events.id, rec.id)).run();
    }
    await setLinkCand(link, null);
    return { ...f, ...upd };
}

// текст сообщения-связи: строки связи (+ семья/вопрос), без юбилеев события —
// гедком-фрагмент добавляется отдельно (gedcomText с ключами)
export async function linkText(chatId, link) {
    let t = "🔗 Родитель: " + link.parent + " → ребёнок: " + link.child + (link.adopted ? " 🤱 (усыновление)" : "");
    if (link.famId) {
        const f = (await chatFams(chatId)).find(x => x.id === link.famId);
        if (f) t += "\n🧬 " + JSON.parse(f.parents).map(keyN).join("+") + " — родители: " + keyN(link.child)
            + (f.marrD ? " (свадьба " + f.marrD + (f.marrPlac ? ", " + f.marrPlac : "") + ")" : "")
            + (f.divD ? " (развод " + f.divD + ")" : "");
    }
    const cand = link.pairCand ? JSON.parse(link.pairCand) : null;
    if (cand && cand.length) {
        if (cand.length === 1)
            t += "\n🧬 Свадьба его родителей: " + cand[0].pair + "?";
        else
            t += "\n🧬 Свадьба его родителей?\n" + cand.map((k, i) => (i + 1) + ") " + k.pair).join("\n");
    }
    return t;
}

// клавиатура сообщения-связи: ♂/♀ для нового лица, Да/Нет или 1 2… Нет для
// свадьбы, 👎 — удалить связь
export async function linkMarkup(chatId, link) {
    const btn = (text, data) => ({ text, callback_data: data });
    const rows = [[btn("👎", "dell:" + link.id)], [btn("🤱", "adop:" + link.id)]];
    const rec = await recordOf(chatId, link[link.who === 'p' ? 'parent' : 'child']);
    if (rec && !rec.sex)
        rows.push([btn("♂", "sex:" + link.id + ":M"), btn("♀", "sex:" + link.id + ":F")]);
    const cand = link.pairCand ? JSON.parse(link.pairCand) : null;
    if (cand && cand.length) {
        const btns = cand.length === 1
            ? [btn("Да", "pair:" + link.id + ":0")]
            : cand.map((k, i) => btn(String(i + 1), "pair:" + link.id + ":" + i));
        btns.push(btn("Нет", "pair:" + link.id + ":-1"));
        rows.push(btns);
    }
    return { inline_keyboard: rows };
}

// множество родни персоны key в радиусе radius: предки до radius поколений
// (1=родители, 2=деды…) ∪ все их транзитивные потомки (сам key, сиблинги,
// двоюродные и потомки всех); pairs — массивы [parent, child]
function focusKeys(pairs, key, radius) {
    const kidsOf = new Map(), parentsOf = new Map();
    for (const [p, c] of pairs) {
        if (!kidsOf.has(p)) kidsOf.set(p, []);
        kidsOf.get(p).push(c);
        if (!parentsOf.has(c)) parentsOf.set(c, []);
        parentsOf.get(c).push(p);
    }
    let frontier = [key];
    const seen = new Set([key]);
    for (let gen = 0; gen < radius; gen++) {
        const next = [];
        for (const k of frontier) for (const p of parentsOf.get(k) || []) {
            if (!seen.has(p)) { seen.add(p); next.push(p); }
        }
        frontier = next;
    }
    const out = new Set(seen);
    const stack = [...seen];
    while (stack.length) {
        const k = stack.pop();
        for (const c of kidsOf.get(k) || []) if (!out.has(c)) { out.add(c); stack.push(c); }
    }
    return [...out];
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

// супруги персон чата: пары семей с 2 родителями + свадьбы «Имя+Имя»,
// разрешённые по записям чата (первая персона с таким именем)
export async function focusSpousePairs(chatId) {
    const pairs = (await chatFams(chatId)).filter(f => JSON.parse(f.parents).length === 2)
        .map(f => JSON.parse(f.parents));
    const rows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
    const persons = rows.filter(r => !r.name.includes("+"));
    for (const r of rows) {
        if (!r.name.includes("+")) continue;
        const [a, b] = r.name.split("+");
        const pa = persons.find(x => x.name === a);
        const pb = persons.find(x => x.name === b);
        if (pa && pb) pairs.push([pa.name + " " + pa.date, pb.name + " " + pb.date]);
    }
    return pairs;
}

// подпись радиуса: 1 родителей, 2 дедов, 3 прадедов, 4 прапрадедов…
export const focusLabel = radius =>
    radius === 1 ? "родителей" : radius === 2 ? "дедов" : "пра".repeat(radius - 3) + "прадедов";

// глубина предков персоны key (0 = родителей нет) — для скрытия цифр радиуса
// без сведений (кнопок 2–5 дедов/прадедов, если их нет). В ВК — focusDepth.
export function focusDepth(pairs, key) {
    const parentsOf = new Map();
    for (const [p, c] of pairs) {
        if (!parentsOf.has(c)) parentsOf.set(c, []);
        parentsOf.get(c).push(p);
    }
    let frontier = [key], d = 0;
    const seen = new Set([key]);
    while (frontier.length) {
        const next = [];
        for (const k of frontier) for (const p of (parentsOf.get(k) || []))
            if (!seen.has(p)) { seen.add(p); next.push(p); }
        if (!next.length) break;
        frontier = next;
        d++;
    }
    return d;
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

// GEDCOM 5.5.1 по чату: INDI из записей (кроме свадеб «Иван+Мария»), FAM из
// семей (MARR/DIV), неподтверждённые связи — по семье на каждого родителя.
// keys — необязательный набор персон: фрагмент только по ним (для
// сообщений-связей), семьи усекаются до выбранных персон
export async function gedcomText(chatId, keys) {
    const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const gdate = d => { const [y, mo, dd] = d.split("-").map(Number); return dd + " " + MON[mo - 1] + " " + y; };
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const recs = (await db.select().from(events).where(eq(events.chatId, chatId)).all())
        .filter(r => !r.name.includes("+") && (!hasKeys || keys.includes(r.name + " " + r.date)));
    const idOf = new Map(recs.map((r, i) => [r.name + " " + r.date, "I" + (i + 1)]));
    const lk = (await chatLinks(chatId)).filter(l => idOf.has(l.parent) && idOf.has(l.child));
    const frows = (await chatFams(chatId))
        .filter(f => JSON.parse(f.parents).every(p => idOf.has(p)) && JSON.parse(f.children).every(c => idOf.has(c)));
    const famsOut = [];
    for (const f of frows) {
        const allP = JSON.parse(f.parents), allC = JSON.parse(f.children);
        const ps = hasKeys ? allP.filter(p => keys.includes(p)) : allP;
        const cs = hasKeys ? allC.filter(c => keys.includes(c)) : allC;
        if (!hasKeys || (ps.length && cs.length))
            famsOut.push({
                parents: ps, children: cs,
                marr: f.marrD ? { d: f.marrD, plac: f.marrPlac } : null,
                div: f.divD ? { d: f.divD, plac: f.divPlac } : null,
            });
    }
    for (const l of lk) {
        if (famsOut.some(f => f.parents.includes(l.parent) && f.children.includes(l.child))) continue;
        let f = famsOut.find(f => f.parents.length === 1 && f.parents[0] === l.parent);
        if (!f) { f = { parents: [l.parent], children: [], marr: null, div: null }; famsOut.push(f); }
        if (!f.children.includes(l.child)) f.children.push(l.child);
    }
    // связь хранится по-ребёнку (свой fam у каждого), но в гедкоме FAM одна
    // на набор родителей: группы с одинаковым набором схлопываем
    const merged = [];
    for (const f of famsOut) {
        const ps = [...f.parents].sort();
        const g = merged.find(x => x.ps.length === ps.length && x.ps.every((p, i) => p === ps[i]));
        if (g) {
            for (const c of f.children) if (!g.children.includes(c)) g.children.push(c);
            if (!g.marr) g.marr = f.marr;
            if (!g.div) g.div = f.div;
        } else merged.push({ ps, parents: f.parents, children: [...f.children], marr: f.marr, div: f.div });
    }
    const famOut = merged.map(x => ({ parents: x.parents, children: x.children, marr: x.marr, div: x.div }));
    const fidOf = new Map(famOut.map((f, i) => [f, "F" + (i + 1)]));
    const adopted = new Map((await chatLinks(chatId)).filter(l => l.adopted).map(l => [l.child, true]));
    const out = ["0 HEAD", "1 SOUR LunarReturns", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"];
    for (const r of recs) {
        const pk = r.name + " " + r.date;
        out.push("0 @" + idOf.get(pk) + "@ INDI");
        out.push("1 NAME " + r.name);
        if (r.sex) out.push("1 SEX " + r.sex);
        out.push("1 BIRT", "2 DATE " + gdate(r.date));
        if (r.srcH !== null && r.srcH !== undefined) out.push("2 TIME " + String(r.srcH).padStart(2, "0") + ":" + String(r.srcM).padStart(2, "0"));
        if (r.deathDate) {
            out.push("1 DEAT", "2 DATE " + gdate(r.deathDate));
            if (r.dsrcH !== null && r.dsrcH !== undefined) out.push("2 TIME " + String(r.dsrcH).padStart(2, "0") + ":" + String(r.dsrcM).padStart(2, "0"));
        }
        for (const f of famOut) {
            if (f.children.includes(pk)) {
                out.push("1 FAMC @" + fidOf.get(f) + "@");
                if (adopted.get(pk)) out.push("1 ADOP", "2 FAMC @" + fidOf.get(f) + "@");
            }
            if (f.parents.includes(pk)) out.push("1 FAMS @" + fidOf.get(f) + "@");
        }
    }
    for (const f of famOut) {
        out.push("0 @" + fidOf.get(f) + "@ FAM");
        // по практике 5.5.1: сначала HUSB, затем WIFE
        const ps = f.parents.map(p => ({ p, r: recs.find(x => x.name + " " + x.date === p) }));
        for (const x of ps.filter(x => !(x.r && x.r.sex === 'F')))
            out.push("1 HUSB @" + idOf.get(x.p) + "@");
        for (const x of ps.filter(x => x.r && x.r.sex === 'F'))
            out.push("1 WIFE @" + idOf.get(x.p) + "@");
        for (const c of f.children) {
            out.push("1 CHIL @" + idOf.get(c) + "@");
            if (adopted.get(c)) out.push("2 PEDI adopted");
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

// ============================== ГЕДКОМ → SVG ==============================
// Чистая логика дословно продублирована в lunarreturns.js (dev/sync-check.mjs)

import { InputFile } from 'sdk';
import { SVG_MAX, chartSvg } from './chart.js';

// диаграммные данные чата/фрагмента (как у gedcomText: те же INDI, свадьбы
// «Имя+Имя» вне; семьи усекаются до персон фрагмента)
export async function chartFor(chatId, keys, title) {
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const recs = (await db.select().from(events).where(eq(events.chatId, chatId)).all())
        .filter(r => !r.name.includes("+") && (!hasKeys || keys.includes(r.name + " " + r.date)));
    const keySet = new Set(recs.map(r => r.name + " " + r.date));
    const rows = recs.map(r => ({ name: r.name, birth: r.date, death: r.deathDate || null, sex: r.sex ?? null }));
    const parentsOf = new Map();
    for (const f of await chatFams(chatId)) {
        const ps = JSON.parse(f.parents).filter(p => keySet.has(p));
        for (const c of JSON.parse(f.children)) {
            if (!keySet.has(c)) continue;
            const arr = parentsOf.get(c) || [];
            for (const p of ps) if (!arr.includes(p)) arr.push(p);
            parentsOf.set(c, arr);
        }
    }
    for (const l of await chatLinks(chatId)) {
        if (!keySet.has(l.child) || !keySet.has(l.parent)) continue;
        const arr = parentsOf.get(l.child) || [];
        if (arr.length < 2 && !arr.includes(l.parent)) arr.push(l.parent);
        parentsOf.set(l.child, arr);
    }
    // ключ «Имя год» из «Имя ГГГГ-ММ-ДД»
    const ckey = k => k.slice(0, -11) + " " + keyY(k);
    const links = [...parentsOf].filter(([, ps]) => ps.length)
        .map(([c, ps]) => ({ child: ckey(c), parents: ps.map(ckey) }));
    return { svg: chartSvg(title, rows, links), persons: Math.min(recs.length, SVG_MAX) };
}

// тап 🧬 / «/gedcom» / «/gedcomN»: tree.ged всегда, tree.svg (диаграмма)
// при < SVG_MAX персон; неудача — фолбэк текстовым гедкомом (sendLong)
export async function sendGedSvg(chatId, keys, head) {
    const g = await gedcomText(chatId, keys);
    let svg = null, persons = 0;
    try {
        const res = await chartFor(chatId, keys, head || "Гедком-древо");
        // chartSvg сам отсекает до 50 младших — файл всегда строится
        persons = res.persons;
        svg = res.svg;
    } catch (e) { console.error("chart:", e.message); }
    try {
        const enc = new TextEncoder();
        await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(enc.encode(g), "tree.ged", { type: "text/plain" }),
            caption: head,
        });
        if (svg) await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(enc.encode(svg), "tree.svg", { type: "image/svg+xml" }),
            caption: "🧬 Диаграмма древа: " + persons + " персон",
        });
        console.log("ged artifacts: tree.ged" + (svg ? " + tree.svg (" + persons + " персон)" : ""), "chat", chatId);
        return;
    } catch (e) {
        console.error("sendDocument:", e.message);
    }
    await sendLong(chatId, (head ? head + "\n" : "") + g);
}

export { focusKeys, focusHasPair, focusWithSpouses };

// импорт разобранного гедкома: персоны (кроме свадеб «Имя+Имя»), связи
// родитель→ребёнок, семьи (2 родителя) и свадьбы «Имя+Имя ДАТА» с разводом;
// возвращает краткий отчёт
export async function importGedcom(chatId, g) {
    const byId = new Map(); // xref → ключ «Имя ГГГГ-ММ-ДД»
    let persons = 0;
    for (const ind of g.indis) {
        if (!ind.name || !ind.birt || !ind.birt.date) continue;
        const rec = { n: ind.name, d: ind.birt.date };
        if (ind.sex) rec.sex = ind.sex;
        if (ind.birt.time) {
            const [h, m] = ind.birt.time.split(":").map(Number);
            rec.srcH = h; rec.srcM = m;
        }
        if (ind.deat && ind.deat.date) {
            rec.dd = ind.deat.date;
            if (ind.deat.time) {
                const [h, m] = ind.deat.time.split(":").map(Number);
                rec.dsrcH = h; rec.dsrcM = m;
            }
        }
        await upsertEvent(chatId, rec);
        byId.set(ind.__xref, ind.name + " " + ind.birt.date);
        persons++;
    }
    let linkCount = 0, weddings = 0;
    for (const f of g.fams) {
        const parents = [f.husb, f.wife].filter(Boolean).map(x => byId.get(x)).filter(Boolean);
        const kids = f.chil.map(x => byId.get(x)).filter(Boolean);
        for (const p of parents) for (const cx of f.chil) {
            const c = byId.get(cx);
            if (!c || p === c) continue;
            const { link } = await addLink(chatId, p, c, 'c');
            if (f.adopted.includes(cx)) await db.update(links).set({ adopted: true }).where(eq(links.id, link.id)).run();
            linkCount++;
        }
        for (const c of kids) await ensureFam(chatId, c);
        // свадьба → запись «Имя+Имя ДАТА», развод — хвостом; MARR/DIV в семью
        if (parents.length === 2 && f.marr && f.marr.date) {
            await upsertEvent(chatId, {
                n: keyN(parents[0]) + "+" + keyN(parents[1]), d: f.marr.date,
                plac: f.marr.plac,
                dd: f.div && f.div.date ? f.div.date : undefined,
                plac2: f.div && f.div.plac ? f.div.plac : undefined,
            });
            const famRows = await chatFams(chatId);
            const fam = famRows.find(f2 => parents.every(p => JSON.parse(f2.parents).includes(p))
                && kids.some(c => JSON.parse(f2.children).includes(c)));
            if (fam) {
                const upd = { marrD: f.marr.date, marrPlac: f.marr.plac || null };
                if (f.div && f.div.date) { upd.divD = f.div.date; upd.divPlac = f.div.plac || null; }
                await db.update(fams).set(upd).where(eq(fams.id, fam.id)).run();
            }
            weddings++;
        }
    }
    // ADOP + FAMC у персоны: связь с этой семьёй — усыновление
    for (const ind of g.indis) {
        if (!ind.adopFams || !ind.adopFams.length) continue;
        const c = byId.get(ind.__xref);
        if (!c) continue;
        for (const fx of ind.adopFams) {
            const f = g.fams.find(x => x.__xref === fx);
            if (!f) continue;
            const ps = [f.husb, f.wife].map(x => byId.get(x));
            for (const l of await chatLinks(chatId))
                if (l.child === c && ps.includes(l.parent))
                    await db.update(links).set({ adopted: true }).where(eq(links.id, l.id)).run();
        }
    }
    return { persons, links: linkCount, weddings };
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
