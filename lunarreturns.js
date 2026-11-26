#!/usr/bin/env node
// lunarreturns.js — VK-бот лунно-солнечных юбилеев (порт логики из
// LunarReturns/index.html). Один файл + общий модуль ярлыков родства
// tgcloud/lib/kinship.cjs (остальные общие модули — по плану
// shared-modules), ноль внешних зависимостей,
// Node >= 22.5 (node:sqlite; проверено на 24.15). Хранилище — SQLite
// lunarreturns.db: xref-дерево чата (indi/fam/chil), «Имя Д» и
// «Имя+Имя Д» — производные виды (см. STORE).
//
// Запуск:  VK_TOKEN=... node lunarreturns.js
// Проверка без токена:  node lunarreturns.js test "Дедушка Костя 1963-09-27 12:30 (Пермь)"
"use strict";

// Общий загрузчик канон-модулей tgcloud/lib/<мод>.cjs (план:
// .kilo/plans/20261107-shared-modules-plan.md). Пути: репо-клон и
// /var/lib/lunarreturns (один layout) — рядом с файлом; TMP-копии
// (dev/sync-check.mjs, dev/vk-repl.mjs) — от cwd корня репо.
const reqLib = name => {
    for (const base of [__dirname, process.cwd()]) {
        try { return require(base + "/tgcloud/lib/" + name + ".cjs"); } catch (e) {}
    }
    throw new Error("tgcloud/lib/" + name + ".cjs не найден: ожидался в " +
        __dirname + "/tgcloud/lib или " + process.cwd() + "/tgcloud/lib");
};

const reqVk = name => require(require.resolve('./vk/' + name + '.js', { paths: [__dirname, process.cwd()] }));

// ============================== KINSHIP (общий модуль) ==============================
// Канон ярлыков родства — tgcloud/lib/kinship.cjs: его же импортирует ТГ-копия
// через ESM-шим tgcloud/lib/kinship.js; правки — только в .cjs, дословных
// копий больше нет.
const { kinLabel } = reqLib("kinship");

// ============================== ФОКУС-РОДНЯ (общий модуль) ==============================
// Канон — tgcloud/lib/tree.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
const {
    familyXref, focusDepth, focusKeys, focusGraphKeys, focusHasPair, focusWithSpouses, focusListKeys,
    focusListText, eventListText, normalizeFocusRadius } = reqLib("tree");


// ============================== ГЕДКОМ → PDF (общий модуль) ==============================
// Канон — tgcloud/lib/chart.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
const {
    b64ToBytes, parseTtf, chartModel, fileBaseOf, chartPdf, rangeLevel } = reqLib("chart");


// ============================== ПАРСИНГ (общий модуль) ==============================
// Канон — tgcloud/lib/parse.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
const {
    parseTrigger, decodeGedcom, parseGedcom, gedText, gedStats, gedFictiveDates, parseTreeLine, NOT_FOR_GRAFT, withGraftMark, parseTree, packToCsv, chatFlatArtifacts, trimImport } = reqLib("parse");
const { mskGedcom } = reqLib("event-time");


// ============================== РЕЛИГИОЗНЫЕ ДНИ (общий модуль) ==============================
// Канон — tgcloud/lib/religion.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
const {
    newStyleDate, oldStyleDate, REL_DEFS, REL_ORDER, religiousDigest, religiousYear } = reqLib("religion");


// ============================== ASTRO (общий модуль) ==============================
// Канон — tgcloud/lib/astro.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
let replDate, replHour;
const { TZ_MS, la, ageSuffix } = reqLib("astro");

// ============================== TEXT (общий модуль) ==============================
// Канон примерных дат — tgcloud/lib/text.cjs (approxOut): его же импортирует
// ТГ-копия через ESM-шим; юбилейные тексты (jubileeText) платформенные —
// остаются в копиях (ТГ: tg-spoiler/htmlEsc, ВК: plain).
const { REPLY_TARGET_ERROR, HELP, helpText, approxOut, eventDate, findShownRecord, resolveReplyRecord } = reqLib("text");
const { normalizeSettings, settingPatch } = reqLib("settings");
const { graftError } = reqLib("flat");

// ============================== РОДОСЛОВНАЯ РОСПИСЬ -+= — ЧИСТЫЕ ФУНКЦИИ (общий модуль) =====
// Канон — tgcloud/lib/flat.cjs (план .kilo/plans/20261108-canon-flat-pure-plan.md): его же импортирует
// ТГ-копия напрямую из bot.js (`import … from './flat.cjs'`, как tree.cjs); правки — только в .cjs.
const {
    flatTreeText, subsetBranch, flatSearch, flatHitPerson, flatHitKey,
    treeReport, birthOrderReport, rootOf, cutLines, createFlatAnnotationScope } = reqLib("flat");


// ============================== ВЫВОД ==============================

function jubileeText(rec, note, detail = false) {
    const hasTime = rec.h !== undefined && rec.m !== undefined;
    // дата — по новому стилю с суффиксом (приблизительные — через approxOut);
    // хранение и экспорт остаются старым стилем (см. newStyleDate). Даты, где
    // стили различаются (≤ 1918-02-13), печатаются с разделителями `_`:
    // скопипащенная шапка-триггер разбирается как новый стиль (см.
    // parseDateGroups) и находит ту же запись, а не плодит дубль
    const sd = newStyleDate(rec.d), sdd = rec.dd ? newStyleDate(rec.dd) : rec.dd;
    const [y, mo, d] = sd.split("-").map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, rec.h !== undefined ? rec.h : 12, rec.m !== undefined ? rec.m : 0, 0));
    const head = rec.n + " " + eventDate(rec.d, rec.abt || rec.mabt || 0) + (hasTime ? " " + String(rec.h).padStart(2, "0") + ":" + String(rec.m).padStart(2, "0") : "")
        + (sdd ? " " + eventDate(rec.dd, rec.dabt || 0) : "")
        + ageSuffix(rec.n, sd, sdd)
        + (note ? "\n" + note : "");
    return head + "\n" + la(t, detail).join("\n");
}

// ============================== STORE (SQLite, xref-дерево) ==============================
// Источник истины — дерево чата с идентичностью по xref (как в гедкоме):
//   indi — персоны (birt_d NULL — заглушки-половины свадеб без даты),
//   fam  — пары (husb/wife = xref'ы, marr/div с датами и местами),
//   chil — дети в семье (adopted), links — рёбра родитель→ребёнок
//   «Имя Д» + состояние сообщений-связей (who/cmid/pairCand),
//   sent — планировщик (последний год рассылки), settings/meta.
// «Имя Д» и «Имя+Имя Д» — производные виды (personRows/weddingRows):
// свадьба всегда привязана к xref'ам супругов, поисков «по первому имени»
// нет — тёзки не перехватывают чужие свадьбы. Один файл lunarreturns.db
// (LR_DB; «:memory:» — тесты): записи синхронные.

const fs = require("fs");
const path = require("path");
const { createStore } = reqVk("lib/sqlite");

// Для изолированных прогонов можно переопределить путь через LR_DB.
const TEST_MODE = process.argv[2] === "test";
const DB_FILE = process.env.LR_DB || (TEST_MODE ? ":memory:" : path.join(__dirname, "lunarreturns.db"));
const { sq, qa, q1, qr, close: closeStore } = createStore(DB_FILE);

const pkey = r => r.n + " " + r.d;
const keyN = k => k.slice(0, -11); // имя из ключа
const keyY = k => Number(k.slice(-10, -6)); // год рождения из ключа

function nextIndiXref(peerId, pref) {
    let max = 0;
    for (const r of qa("SELECT xref FROM indi WHERE chat=? AND xref LIKE ?", peerId, pref + "%"))
        max = Math.max(max, Number(String(r.xref).slice(pref.length)) || 0);
    return pref + (max + 1);
}
function nextFamXref(peerId, pref) {
    let max = 0;
    for (const r of qa("SELECT xref FROM fam WHERE chat=? AND xref LIKE ?", peerId, pref + "%"))
        max = Math.max(max, Number(String(r.xref).slice(pref.length)) || 0);
    return pref + (max + 1);
}

function recordOf(peerId, key) {
    return personRows(peerId).find(r => pkey(r) === key)
        || weddingRows(peerId).find(r => pkey(r) === key) || null;
}

// ключ из показанного текста (новый стиль + суффикс: юбилей/🔔 печатает
// приближённые даты через approxOut): точный ключ — как хранение; мимо —
// поиск по отображённой форме (имя ≃ и approxOut(newStyleDate) совпал)
// `_` сохраняется до fallback, чтобы не совпасть с точной датой другой записи
function recordShownOf(peerId, key) {
    const exact = recordOf(peerId, key);
    if (exact) return exact;
    return findShownRecord([...personRows(peerId), ...weddingRows(peerId)], key);
}

// ---- виды: «Имя Д» и «Имя+Имя Д» — выборка из дерева ----

// персоны чата (только с датой рождения), порядок вставки
function personRows(peerId) {
    return qa(`SELECT xref,name,birt_d,birt_h,birt_m,src_h,src_m,deat_d,deat_h,deat_m,dsrc_h,dsrc_m,sex,plac,deat_plac,note,birt_abt,deat_abt
        FROM indi WHERE chat=? AND birt_d IS NOT NULL ORDER BY rowid`, peerId).map(personFromRow);
}

// свадьбы чата: fam с marr и хоть одним супругом (имена по xref — точно);
// отсутствующая половина — заглушка «Муж»/«Жена» (персоны в базе нет);
// та же пара+дата у второй семьи (после confirmPair) — один раз
function weddingRows(peerId) {
    const out = [], seen = new Set();
    for (const r of qa(`SELECT f.xref AS fx, f.marr_d AS d, f.marr_abt AS mabt, f.marr_plac AS plac, f.div_d AS dd, f.div_abt AS dabt, f.div_plac AS plac2, f.note AS note,
        (SELECT name FROM indi WHERE chat=f.chat AND xref=f.husb) AS hn,
        (SELECT name FROM indi WHERE chat=f.chat AND xref=f.wife) AS wn
        FROM fam f WHERE f.chat=? AND f.marr_d IS NOT NULL ORDER BY f.rowid`, peerId)) {
        if (!r.hn && !r.wn) continue;
        const o = { n: (r.hn || "Муж") + "+" + (r.wn || "Жена"), d: r.d };
        if (r.mabt) o.mabt = r.mabt;
        if (seen.has(pkey(o))) continue;
        seen.add(pkey(o));
        if (r.plac) o.plac = r.plac;
        if (r.note) o.note = r.note;
        if (r.dd) { o.dd = r.dd; if (r.plac2) o.plac2 = r.plac2; }
        o.fx = r.fx;
        out.push(o);
    }
    return out;
}

// запись по ключу «Имя Д» или «Имя+Имя Д» (правка сообщений по cmid)
function recordAnyOf(peerId, key) {
    return recordOf(peerId, key);
}

function indiOf(peerId, xref) {
    return q1("SELECT * FROM indi WHERE chat=? AND xref=?", peerId, xref) || null;
}
function xrefOfKey(peerId, key) {
    const r = q1("SELECT xref FROM indi WHERE chat=? AND name=? AND birt_d IS NOT NULL AND birt_d=? LIMIT 1",
        peerId, keyN(key), key.slice(-10));
    return r ? r.xref : null;
}
function keyOfXref(peerId, xref) {
    const r = indiOf(peerId, xref);
    return r && r.birt_d ? r.name + " " + r.birt_d : null;
}

function famRaw(peerId, fx) {
    return fx ? (q1("SELECT * FROM fam WHERE chat=? AND xref=?", peerId, fx) || null) : null;
}
function famNames(peerId, fx) {
    const f = famRaw(peerId, fx);
    if (!f) return { hn: null, wn: null };
    return {
        hn: f.husb ? (indiOf(peerId, f.husb) || {}).name || null : null,
        wn: f.wife ? (indiOf(peerId, f.wife) || {}).name || null : null,
    };
}
// fam в виде {xref, adhoc, parents/children — ключи «Имя Д», marr, div}
function famView(peerId, fx) {
    const f = famRaw(peerId, fx);
    if (!f) return null;
    return {
        xref: f.xref, adhoc: !!f.adhoc,
        parents: [f.husb, f.wife].filter(Boolean).map(x => keyOfXref(peerId, x)).filter(Boolean),
        children: qa("SELECT indi FROM chil WHERE chat=? AND fam=? ORDER BY rowid", peerId, f.xref)
            .map(r => keyOfXref(peerId, r.indi)).filter(Boolean),
        marr: f.marr_d ? { d: f.marr_d, ...(f.marr_abt ? { abt: f.marr_abt } : {}), ...(f.marr_plac ? { plac: f.marr_plac } : {}) } : null,
        div: f.div_d ? { d: f.div_d, ...(f.div_abt ? { abt: f.div_abt } : {}), ...(f.div_plac ? { plac: f.div_plac } : {}) } : null,
    };
}
function famList(peerId) {
    return qa("SELECT xref FROM fam WHERE chat=? ORDER BY rowid", peerId)
        .map(r => famView(peerId, r.xref)).filter(Boolean);
}
function linkPairs(peerId) {
    // ORDER BY id — тот же порядок, что в ТГ-копии (edgeRows по id): SELECT
    // без сортировки идёт по индексу UNIQUE(chat,p,c) — по алфавиту, и
    // порядок-зависимая логика (клика сиблингов, ярлыки) расходилась с ТГ
    return qa("SELECT p,c FROM links WHERE chat=? ORDER BY id", peerId).map(l => [l.p, l.c]);
}
// есть ли древо чата как структура (fam с хоть одной половиной или хоть
// один ребёнок в fam): гейт выгрузки 🧬/.ged — численность связей «Имя Д»
// (links) для бездатных древ всегда ноль, хотя выгрузка по xref работает
// (ТГ-копия: tgcloud/lib/bot.js, hasTree)
function hasTree(peerId) {
    return qa("SELECT 1 FROM fam WHERE chat=? AND (husb IS NOT NULL OR wife IS NOT NULL) LIMIT 1", peerId).length > 0
        || qa("SELECT 1 FROM chil WHERE chat=? LIMIT 1", peerId).length > 0;
}
// строка-связь в прежнем виде (+adopted из chil семьи связи)
function linkRowOf(r) {
    const cx = r.fam ? xrefOfKey(r.chat, r.c) : null;
    const adopted = r.fam && cx
        ? !!(q1("SELECT adopted FROM chil WHERE chat=? AND fam=? AND indi=?", r.chat, r.fam, cx) || {}).adopted
        : false;
    return { id: r.id, peerId: r.chat, p: r.p, c: r.c, who: r.who, fam: r.fam, cmid: r.cmid,
        pairCand: r.pairCand ? JSON.parse(r.pairCand) : null, adopted };
}
function setLinkCand(link, cand) {
    qr("UPDATE links SET pairCand=? WHERE chat=? AND id=?", cand ? JSON.stringify(cand) : null, link.peerId, link.id);
    link.pairCand = cand || null;
}

// ---- мутации ----

// событие своё у каждого пира, ключ — имя+дата: повторный триггер с той же
// датой обновляет (только заданные поля), с другой — отдельное событие
// (Георгий 1910 и Георгий 1963). «Имя+Имя Д» — свадьба: пара-заглушка
// (половины без дат рождения) с marr/div
function upsertPerson(peerId, rec) {
    if (rec.n.includes("+")) return upsertWedding(peerId, rec);
    const cur = q1("SELECT xref FROM indi WHERE chat=? AND name=? AND birt_d IS NOT NULL AND birt_d=? LIMIT 1",
        peerId, rec.n, rec.d);
    if (cur) {
        const s = [], v = [];
        const put = (col, val) => { s.push(col + "=?"); v.push(val); };
        if (rec.h !== undefined) { put("birt_h", rec.h); put("birt_m", rec.m ?? 0); }
        if (rec.srcH !== undefined) { put("src_h", rec.srcH); put("src_m", rec.srcM ?? 0); }
        if (rec.dd !== undefined) {
            put("deat_d", rec.dd || null);
            if (rec.dh !== undefined) { put("deat_h", rec.dh); put("deat_m", rec.dm ?? 0); }
            if (rec.dsrcH !== undefined) { put("dsrc_h", rec.dsrcH); put("dsrc_m", rec.dsrcM ?? 0); }
        } else if (rec.dh !== undefined) { put("deat_h", rec.dh); put("deat_m", rec.dm ?? 0); }
        if (rec.sex !== undefined) put("sex", rec.sex || null);
        if (rec.plac !== undefined) put("plac", rec.plac || null);
        if (rec.plac2 !== undefined) put("deat_plac", rec.plac2 || null);
        if (rec.note !== undefined) put("note", rec.note || null);
        if (rec.abt !== undefined) put("birt_abt", rec.abt || 0);
        if (rec.dabt !== undefined) put("deat_abt", rec.dabt || 0);
        if (s.length) qr("UPDATE indi SET " + s.join(",") + " WHERE chat=? AND xref=?", ...v, peerId, cur.xref);
        return personRows(peerId).find(r => r.xref === cur.xref) || null;
    }
    const xref = nextIndiXref(peerId, "P");
    qr(`INSERT INTO indi(chat,xref,name,birt_d,birt_h,birt_m,src_h,src_m,deat_d,deat_h,deat_m,dsrc_h,dsrc_m,sex,plac,deat_plac,note,birt_abt,deat_abt)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        peerId, xref, rec.n, rec.d,
        rec.h ?? null, rec.h !== undefined ? (rec.m ?? 0) : null,
        rec.srcH ?? null, rec.srcH !== undefined ? (rec.srcM ?? 0) : null,
        rec.dd ?? null, rec.dh ?? null, rec.dh !== undefined ? (rec.dm ?? 0) : null,
        rec.dsrcH ?? null, rec.dsrcH !== undefined ? (rec.dsrcM ?? 0) : null,
        rec.sex ?? null, rec.plac ?? null, rec.plac2 ?? null, rec.note ?? null,
        rec.abt ?? 0, rec.dabt ?? 0);
    return personRows(peerId).find(r => r.xref === xref) || null;
}

// заглушка-половина свадьбы: персона без даты (одна на все свадьбы с именем)
function stubOf(peerId, name) {
    const cur = q1("SELECT xref FROM indi WHERE chat=? AND name=? AND birt_d IS NULL LIMIT 1", peerId, name);
    if (cur) return cur.xref;
    const xref = nextIndiXref(peerId, "S");
    qr("INSERT INTO indi(chat,xref,name) VALUES(?,?,?)", peerId, xref, name);
    return xref;
}
function weddingByFx(peerId, fx) {
    return weddingRows(peerId).find(w => w.fx === fx) || null;
}
function upsertWedding(peerId, rec) {
    const [a, b] = rec.n.split("+");
    // повторный триггер «Имя1+Имя2 Д» правит наскоро: пара — якорь (без даты),
    // так что дата свадьбы тоже правится; новая пара — новая fam-заглушка
    for (const r of qa("SELECT xref,husb,wife FROM fam WHERE chat=? ORDER BY rowid", peerId)) {
        const hn = (r.husb ? indiOf(peerId, r.husb) : null) || {};
        const wn = (r.wife ? indiOf(peerId, r.wife) : null) || {};
        if ((hn.name === a && wn.name === b) || (hn.name === b && wn.name === a)) {
            const s = ["marr_d=?"], v = [rec.d];
            s.push("marr_abt=?"); v.push(rec.abt ?? 0);
            if (rec.plac !== undefined) { s.push("marr_plac=?"); v.push(rec.plac || null); }
            if (rec.note !== undefined) { s.push("note=?"); v.push(rec.note || null); }
            if (rec.dd !== undefined) { s.push("div_d=?"); v.push(rec.dd || null); s.push("div_abt=?"); v.push(rec.dabt ?? 0); }
            if (rec.plac2 !== undefined) { s.push("div_plac=?"); v.push(rec.plac2 || null); }
            qr("UPDATE fam SET " + s.join(",") + " WHERE chat=? AND xref=?", ...v, peerId, r.xref);
            return weddingByFx(peerId, r.xref);
        }
    }
    const ha = stubOf(peerId, a), hb = stubOf(peerId, b);
    const fx = nextFamXref(peerId, "W");
    qr(`INSERT INTO fam(chat,xref,adhoc,husb,wife,marr_d,marr_abt,marr_plac,note,div_d,div_abt,div_plac) VALUES(?,?,1,?,?,?,?,?,?,?,?,?)`,
        peerId, fx, ha, hb, rec.d, rec.abt ?? 0, rec.plac ?? null, rec.note ?? null, rec.dd ?? null, rec.dabt ?? 0, rec.plac2 ?? null);
    return weddingByFx(peerId, fx);
}

// ============================== РОДОСЛОВНАЯ РОСПИСЬ -+= ==============================
// применить разбор parseTree: персоны (пол по маркеру, note), пары-свадьбы,
// дети; повтор по имя+дата переиспользует персону; родитель должен быть старше
// ребёнка как минимум на 12 лет (иначе связь не пишется, в отчёте ошибка).
// Роспись самодостаточна: корень (герой ветви) — первая персона, не ребёнок
// внутри росписи и не половина пары; его дети привязываются его семьями.
// → { persons, fams, links, errors } (ТГ-копия — tgcloud/lib/bot.js: applyTree)
function applyTree(peerId, tree) {
    const rep = { persons: 0, fams: 0, links: 0, errors: tree.errors.map(e => ({ ...e })) };
    const sexN = i => (i !== null && i !== undefined && tree.persons[i] ? tree.persons[i].sex : null);
    const nameN = i => (i !== null && i !== undefined && tree.persons[i] ? tree.persons[i].rec.n : "");
    const usedSolo = new Set(), weddingXrefs = [], implicitXrefs = new Map();
    // Every wedding consumes a distinct family; aliases are checked against spouses.
    const famForPair = (mx, fx, md, alias) => {
        const rows = qa("SELECT xref,husb,wife,marr_d FROM fam WHERE chat=? ORDER BY rowid", peerId)
            .map(f => ({ ...f, marrD: f.marr_d }));
        const match = familyXref(rows, mx, fx, alias, md, usedSolo);
        const x = match || nextFamXref(peerId, "W");
        usedSolo.add(x);
        if (rows.some(f => f.xref === x)) return x;
        qr("INSERT INTO fam(chat,xref,adhoc,husb,wife) VALUES(?,?,1,?,?)", peerId, x, mx || null, fx || null);
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
            const named = p.spouseLine ? qa("SELECT xref FROM indi WHERE chat=? AND name=?", peerId, rec.n) : [];
            x = named.length === 1 ? named[0].xref : stubOf(peerId, rec.n);
            qr("UPDATE indi SET sex=?, note=COALESCE(?, note) WHERE chat=? AND xref=?",
                p.sex || null, p.note || null, peerId, x);
            if (rec.dd) qr('UPDATE indi SET deat_d=?,deat_h=?,deat_m=?,dsrc_h=?,dsrc_m=?,deat_plac=?,deat_abt=? WHERE chat=? AND xref=?',
                rec.dd, rec.dh ?? null, rec.dm ?? null, rec.dsrcH ?? null, rec.dsrcM ?? null, rec.plac2 ?? null, rec.dabt ?? 0, peerId, x);
        } else {
            const r = upsertPerson(peerId, Object.assign({ sex: p.sex, note: p.note }, rec));
            x = r ? r.xref : null;
        }
        xr.push(x);
        if (x != null && !seen.has(x)) { seen.add(x); rep.persons++; }
    }
    for (const ch of tree.children) {
        if (ch.w != null || implicitXrefs.has(ch.o)) continue;
        const parent = tree.persons[ch.m ?? ch.f]?.rec, child = tree.persons[ch.c].rec;
        if (parent?.d && child.d && Number(child.d.slice(0, 4)) - Number(parent.d.slice(0, 4)) < 12) continue;
        implicitXrefs.set(ch.o, famForPair(ch.m != null ? xr[ch.m] : null, ch.f != null ? xr[ch.f] : null));
    }
    for (const [wi, w] of tree.weddings.entries()) {
        const mx = w.m !== null ? xr[w.m] : null, fx = w.f !== null ? xr[w.f] : null;
        if (!mx && !fx) continue;
        const fxx = famForPair(mx, fx, w.rec.d, w.xref);
        weddingXrefs[wi] = fxx;
        qr("UPDATE fam SET marr_d=?, marr_abt=?, marr_plac=?, note=?, div_d=?, div_abt=?, div_plac=? WHERE chat=? AND xref=?",
            w.rec.d ?? null, w.rec.abt ?? 0, w.rec.plac ?? null, w.note || null,
            w.rec.dd ?? null, w.rec.dabt ?? 0, w.rec.plac2 ?? null, peerId, fxx);
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
        else if (ps.length === 2) fxx = famForPair(ps[0].x, ps[1].x);
        else {
            const key = ch.o ?? ps[0].x;
            if (!implicitXrefs.has(key)) implicitXrefs.set(key,
                famForPair(ps[0].sex === "M" ? ps[0].x : null, ps[0].sex !== "M" ? ps[0].x : null));
            fxx = implicitXrefs.get(key);
        }
        const has = q1("SELECT 1 AS x FROM chil WHERE chat=? AND fam=? AND indi=?", peerId, fxx, cx);
        if (!has) {
            qr("INSERT INTO chil(chat,fam,indi) VALUES(?,?,?)", peerId, fxx, cx);
            rep.links++;
        }
    }
    // роспись без гедкома тоже восстанавливает интерактивные связи (edges) — иначе
    // /gedcom после импорта .ged.txt не видит связей
    restoreEdges(peerId);
    rep.chartWarnings = importChartWarnings(peerId);
    return rep;
}

// ---- правка ветви: резать и прививать (ТГ-копия — tgcloud/lib/bot.js) ----

// обновить поля персоны по xref (правка героя по якорю цитаты); поля, не
// заданные в rec, не перетираются; имя и дата рождения — тоже правимы.
// full=true — полная замена: не заданные поля стираются (кроме пола — он
// меняется только явным rec.sex). Смена имени/даты переименовывает ключ
// в связях (links) и кандидатах-свадьбах
// (ТГ-копия: tgcloud/lib/bot.js, setPersonByXref)
function setPersonByXref(peerId, xref, rec, full = false) {
    const old = indiOf(peerId, xref);
    const s = [], v = [];
    const put = (col, val) => { s.push(col + "=?"); v.push(val); };
    if (rec.n !== undefined) put("name", rec.n);
    if (rec.d !== undefined) put("birt_d", rec.d);
    if (full) {
        put("birt_h", rec.h ?? null); put("birt_m", rec.h !== undefined ? (rec.m ?? 0) : null);
        put("src_h", rec.srcH ?? null); put("src_m", rec.srcH !== undefined ? (rec.srcM ?? 0) : null);
        put("deat_d", rec.dd ?? null);
        put("deat_h", rec.dh ?? null); put("deat_m", rec.dh !== undefined ? (rec.dm ?? 0) : null);
        put("dsrc_h", rec.dsrcH ?? null); put("dsrc_m", rec.dsrcH !== undefined ? (rec.dsrcM ?? 0) : null);
        put("plac", rec.plac ?? null);
        put("note", rec.note ?? null);
        put("birt_abt", rec.abt ?? 0);
        put("deat_abt", rec.dabt ?? 0);
    } else {
        if (rec.abt !== undefined) put("birt_abt", rec.abt || 0);
        if (rec.dabt !== undefined) put("deat_abt", rec.dabt || 0);
        if (rec.h !== undefined) { put("birt_h", rec.h); put("birt_m", rec.m ?? 0); }
        if (rec.srcH !== undefined) { put("src_h", rec.srcH); put("src_m", rec.srcM ?? 0); }
        if (rec.dd !== undefined) {
            put("deat_d", rec.dd || null);
            if (rec.dh !== undefined) { put("deat_h", rec.dh); put("deat_m", rec.dm ?? 0); }
            if (rec.dsrcH !== undefined) { put("dsrc_h", rec.dsrcH); put("dsrc_m", rec.dsrcM ?? 0); }
        } else if (rec.dh !== undefined) { put("deat_h", rec.dh); put("deat_m", rec.dm ?? 0); }
        if (rec.plac !== undefined) put("plac", rec.plac || null);
        if (rec.note !== undefined) put("note", rec.note || null);
    }
    if (rec.sex !== undefined) put("sex", rec.sex || null);
    if (s.length) qr("UPDATE indi SET " + s.join(",") + " WHERE chat=? AND xref=?", ...v, peerId, xref);
    // смена имени/даты — переименовать ключ персоны в связях и кандидатах-
    // свадьбах (ветка и связи остаются при герое); фокус-таблицы в ВК нет
    if (old && old.birt_d != null && (rec.n !== undefined || rec.d !== undefined)) {
        const oldKey = old.name + " " + old.birt_d;
        const newKey = (rec.n !== undefined ? rec.n : old.name)
            + " " + (rec.d !== undefined ? rec.d : old.birt_d);
        if (newKey !== oldKey) rekeyPerson(peerId, oldKey, newKey);
    }
    return personRows(peerId).find(r => r.xref === xref) || null;
}

// ключ персоны сменился: перевесить связи (p/c) и кандидаты-свадьбы на новый
// ключ — иначе ветка «теряет» героя (ТГ-копия: tgcloud/lib/bot.js, rekeyPerson)
function rekeyPerson(peerId, oldKey, newKey) {
    const oldName = keyN(oldKey), newName = keyN(newKey);
    qr("UPDATE links SET p=? WHERE chat=? AND p=?", newKey, peerId, oldKey);
    qr("UPDATE links SET c=? WHERE chat=? AND c=?", newKey, peerId, oldKey);
    for (const l of qa("SELECT id, pairCand FROM links WHERE chat=? AND pairCand IS NOT NULL", peerId)) {
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
            qr("UPDATE links SET pairCand=? WHERE chat=? AND id=?", JSON.stringify(cur), peerId, l.id);
    }
}

// точечная правка триггера: якорь-цитата — персона; rec заменяет запись
// ПОЛНОСТЬЮ (не заданные поля стираются), пол не трогается, ветвь и связи
// целы (ключи переименовываются). null — якорь не персона (правки нет);
// новый ключ занят — не отказ, а суффикс «~xref» правимой персоны
// (ТГ-копия: tgcloud/lib/bot.js, editTrigger)
function editTrigger(peerId, anchorKey, rec) {
    const xref = xrefOfKey(peerId, anchorKey);
    if (!xref) return null;
    if (rec.n + " " + rec.d !== anchorKey
        && q1("SELECT xref FROM indi WHERE chat=? AND name=? AND birt_d IS NOT NULL AND birt_d=? AND xref<>? LIMIT 1",
            peerId, rec.n, rec.d, xref))
        rec.n = rec.n.replace(/ ~\S+$/, "") + " ~" + xref;
    return { rec: setPersonByXref(peerId, xref, rec, true) };
}

// резать ветвь персоны xref молча: все fams, где xref/потомок — половина,
// каскадно вниз; удалаются: потомки (записи indi), семьи ветви, ребра chil,
// связи links, висячие кандидаты; вторые половины ветви — тоже, ПОКА они не
// участники семей вне ветви (тогда запись остаётся, связи рвутся, запись живёт)
function cutBranch(peerId, px, extraNames = []) {
    const famRows = qa("SELECT xref,husb,wife FROM fam WHERE chat=? ORDER BY rowid", peerId);
    const kidsOfFam = new Map();
    for (const r of qa("SELECT fam,indi FROM chil WHERE chat=? ORDER BY rowid", peerId)) {
        if (!kidsOfFam.has(r.fam)) kidsOfFam.set(r.fam, []);
        kidsOfFam.get(r.fam).push(r.indi);
    }
    // интерактивные связи: «родитель(ключ) → дети(xref)» — цепочка по links
    const rows0 = qa("SELECT * FROM indi WHERE chat=?", peerId);
    const keyOf = new Map(rows0.map(r => [r.xref, r.name + " " + r.birt_d]));
    const kidsOfKey = edgeKids(peerId);
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
    // Половина остаётся, если вне ветви она супруг или ребёнок семьи.
    const victims = new Set();
    for (const x of D) if (x !== px) victims.add(x);
    for (const fx of fams) {
        const f = famRows.find(t => t.xref === fx);
        for (const h of [f.husb, f.wife]) {
            if (!h || D.has(h)) continue;
            const outside = famRows.some(t => !inF.has(t.xref)
                && (t.husb === h || t.wife === h || (kidsOfFam.get(t.xref) || []).includes(h)));
            if (!outside) victims.add(h);
        }
    }
    const victimKeys = new Set([...victims]
        .map(x => { const r = indiOf(peerId, x); return r && r.birt_d ? r.name + " " + r.birt_d : null; })
        .filter(Boolean));
    // свадьбы-заглушки («Имя1+Имя2 Д») пары ветви: половины-заглушки по именам
    // попали в срез — fam-заглушки удаляем, иначе после прививки двойные события
    const names = new Set([...victimKeys].map(k => k.slice(0, -11)));
    const heroRow = indiOf(peerId, px);
    if (heroRow) names.add(heroRow.name);
    // персонажи прививаемой росписи: их свадьбы-заглушки (пары по именам) — тоже
    for (const n of extraNames) names.add(n);
    let stubDel = 0;
    for (const f of famRows) {
        if (inF.has(f.xref) || !f.husb || !f.wife) continue;
        const hn = indiOf(peerId, f.husb);
        const wn = indiOf(peerId, f.wife);
        if (hn && wn && !hn.birt_d && !wn.birt_d && names.has(hn.name) && names.has(wn.name)) {
            qr("DELETE FROM fam WHERE chat=? AND xref=?", peerId, f.xref);
            qr("DELETE FROM chil WHERE chat=? AND fam=?", peerId, f.xref);
            stubDel++;
        }
    }
    for (const x of victims) {
        invalidateDatelessPanels(peerId, x);
        qr("DELETE FROM indi WHERE chat=? AND xref=?", peerId, x);
    }
    for (const fx of fams) qr("DELETE FROM fam WHERE chat=? AND xref=?", peerId, fx);
    const chParts = [], chArgs = [];
    if (victims.size) { chParts.push("indi IN (" + [...victims].map(() => "?").join(",") + ")"); chArgs.push(...victims); }
    if (fams.length) { chParts.push("fam IN (" + fams.map(() => "?").join(",") + ")"); chArgs.push(...fams); }
    if (chParts.length)
        qr("DELETE FROM chil WHERE chat=? AND (" + chParts.join(" OR ") + ")", peerId, ...chArgs);
    if (victimKeys.size) {
        const ph = [...victimKeys].map(() => "?").join(",");
        qr("DELETE FROM links WHERE chat=? AND (p IN (" + ph + ") OR c IN (" + ph + "))",
            peerId, ...victimKeys, ...victimKeys);
    }
    for (const l of qa("SELECT id, pairCand FROM links WHERE chat=? AND pairCand IS NOT NULL", peerId)) {
        const cur = JSON.parse(l.pairCand);
        const cand = cur.filter(c => !keyN(c.pair).split("+").some(n => names.has(n)));
        if (cand.length !== cur.length)
            qr("UPDATE links SET pairCand=? WHERE chat=? AND id=?", cand.length ? JSON.stringify(cand) : null, peerId, l.id);
    }
    return { cut: victims.size, fams: fams.length + stubDel };
}



// правка ветви: цитируемый anchorKey — герой росписи tree. Молча: старая ветвь
// срезается (cutBranch), поля героя обновляются по строке героя росписи (имя и
// дата рождения правимы), новая ветвь прививается applyTree'ом. Цитируемый
// не найден или структура небезопасна — отказ до любых записей.
// Роспись РАДИУСА (chatFlatText по keys — .ged.txt третьего прицепа 🧬) несёт
// героя ВНУТРИ дерева (первым корнем идёт старший предок) и открывается
// меткой NOT_FOR_GRAFT: радиус не несёт всех потомков героя, прививка
// обновила бы связи лишь частично. Такая роспись отвергается — правки нет,
// ответ-ошибка предлагает родословную роспись -+= тапа «-+=». Мимо якоря метка резке
// мешает, а добавлению нет: merge росписи радиуса в чистый чат работает как прежде
function cutAndGraft(peerId, anchorKey, tree, trim = false) {
    const error = graftError(tree, anchorKey, personRows(peerId));
    if (error || !xrefOfKey(peerId, anchorKey))
        return { persons: 0, fams: 0, links: 0, errors: [], graftError: error || REPLY_TARGET_ERROR };
    const px = xrefOfKey(peerId, anchorKey);
    const root = rootOf(tree);
    if (trim) {
        trimImport(tree);
        const trimmedError = graftError(tree, anchorKey, personRows(peerId).filter(r => r.xref !== px));
        if (trimmedError) return { persons: 0, fams: 0, links: 0, errors: [], graftError: trimmedError };
    }
    const cut = cutBranch(peerId, px, tree.persons.map(p => p.rec.n)); // свадьбы-заглушки пар росписи тоже срезаются
    if (trim && root) qr("UPDATE indi SET deat_plac=NULL WHERE chat=? AND xref=?", peerId, px);
    setPersonByXref(peerId, px, Object.assign({ sex: root.sex, note: root.note }, root.rec), trim);
    const rep = applyTree(peerId, tree);
    restoreEdges(peerId);
    rep.cut = cut.cut; rep.famsCut = cut.fams;
    return rep;
}

// восстановление интерактивных связей (links) после резки-прививки: у fam с
// детьми — по ребру на каждого реального родителя-половину; ребро
// (родитель → ребёнок) уже есть где-либо в чате — не дублируем
// (ТГ-копия: tgcloud/lib/bot.js, restoreEdges)
function restoreEdges(peerId) {
    const keyOf = new Map(qa("SELECT xref,name,birt_d FROM indi WHERE chat=?", peerId)
        .filter(r => r.birt_d != null).map(r => [r.xref, r.name + " " + r.birt_d]));
    const edgesAll = qa("SELECT p,c FROM links WHERE chat=?", peerId).map(l => ({ p: l.p, c: l.c }));
    if (process.env.LR_DEBUG) console.error('restoreEdges peer', peerId, 'snapshot:', JSON.stringify(edgesAll));
    for (const f of qa("SELECT * FROM fam WHERE chat=? ORDER BY rowid", peerId)) {
        const kids = qa("SELECT indi FROM chil WHERE chat=? AND fam=?", peerId, f.xref)
            .map(r => r.indi).filter(x => keyOf.get(x));
        if (!kids.length) continue;
        for (const h of [f.husb, f.wife].filter(Boolean)) {
            if (!keyOf.get(h)) continue;
            for (const k of kids) {
                if (edgesAll.some(e => e.p === keyOf.get(h) && e.c === keyOf.get(k))) continue;
                qr("INSERT INTO links(chat,p,c,who,fam,cmid) VALUES(?,?,?,?,?,0)",
                    peerId, keyOf.get(h), keyOf.get(k), "p", f.xref);
                edgesAll.push({ p: keyOf.get(h), c: keyOf.get(k) });
            }
        }
    }
}



// уникальный ключ «Имя Д»: занят — дубли различаются суффиксом «~xref»
// («Иван 1954-05-10 ~I7»): дата не искажается, первая запись остаётся без
// суффикса; xref правимой персоны уникален в чате, коллизий после
// дописывания нет. Для фиктивных дат (yearly) — прежний сдвиг +1 год
// (ТГ-копия: tgcloud/lib/bot.js, uniqueKeyOf)
function uniqueKeyOf(peerId, name, birtD, approx, yearly, xref) {
    while (true) {
        const same = q1("SELECT xref FROM indi WHERE chat=? AND name=? AND birt_d=?", peerId, name, birtD);
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

// добавить связь родитель→ребёнок; who — кто из двоих пришёл новым триггером.
// Интерактивная семья — adhoc fam на ребёнка: второй родитель добирается в
// неё же (третий — отдельной fam); ребро уже есть — dup
function addLink(peerId, parentKey, childKey, who) {
    const same = q1("SELECT * FROM links WHERE chat=? AND p=? AND c=?", peerId, parentKey, childKey);
    if (same) return { link: linkRowOf(same), dup: true };
    const px = xrefOfKey(peerId, parentKey), cx = xrefOfKey(peerId, childKey);
    if (!px || !cx) return { link: null, dup: false };
    const newAdhocFam = () => {
        const fx = nextFamXref(peerId, "L");
        qr("INSERT INTO fam(chat,xref,adhoc,husb,wife) VALUES(?,?,1,?,NULL)", peerId, fx, px);
        qr("INSERT OR IGNORE INTO chil(chat,fam,indi) VALUES(?,?,?)", peerId, fx, cx);
        return fx;
    };
    const f = q1(`SELECT * FROM fam WHERE chat=? AND adhoc=1 AND xref IN
        (SELECT fam FROM chil WHERE chat=? AND indi=?) ORDER BY rowid LIMIT 1`, peerId, peerId, cx);
    let fx;
    if (!f) fx = newAdhocFam();
    else if (f.husb === null) { qr("UPDATE fam SET husb=? WHERE chat=? AND xref=?", px, peerId, f.xref); fx = f.xref; }
    else if (f.wife === null) { qr("UPDATE fam SET wife=? WHERE chat=? AND xref=?", px, peerId, f.xref); fx = f.xref; }
    else fx = newAdhocFam(); // оба места заняты — ещё один родитель отдельной fam
    if (f) qr("INSERT OR IGNORE INTO chil(chat,fam,indi) VALUES(?,?,?)", peerId, fx, cx);
    qr("INSERT INTO links(chat,p,c,who,fam,cmid) VALUES(?,?,?,?,?,0)", peerId, parentKey, childKey, who, fx);
    return { link: linkRowOf(q1("SELECT * FROM links WHERE chat=? AND p=? AND c=?", peerId, parentKey, childKey)), dup: false };
}

// все родители ребёнка в чате
function parentKeys(peerId, childKey) {
    return [...new Set(qa("SELECT p FROM links WHERE chat=? AND c=?", peerId, childKey).map(l => l.p))];
}

function normalizeFam(peerId, fx) {
    const f = famRaw(peerId, fx);
    if (!f) return;
    const parents = [f.husb, f.wife].filter(Boolean).length;
    const kids = q1("SELECT COUNT(*) AS n FROM chil WHERE chat=? AND fam=?", peerId, fx).n;
    const linksN = q1("SELECT COUNT(*) AS n FROM links WHERE chat=? AND fam=?", peerId, fx).n;
    if (parents === 0 || (kids === 0 && linksN === 0 && parents < 2 && !f.marr_d)) {
        qr("DELETE FROM fam WHERE chat=? AND xref=?", peerId, fx);
        qr("DELETE FROM chil WHERE chat=? AND fam=?", peerId, fx);
    }
}
// кандидаты-свадьбы (интерактивное связывание): fam с marr, где половина
// имени — текущий родитель; когда у ребёнка два родителя — вторая половина
// другой родитель; свадьба позже рождения родителя (родителей); релевантные —
// по близости года свадьбы к году рождения ребёнка; при известном поле
// учитывается порядок в имени («первый — М, второй — Ж», как в confirmPair);
// свадьба уже на семье связи кандидатом не бывает
function pairRecords(peerId, link) {
    const cy = keyY(link.c), pn = keyN(link.p), out = [], seen = new Set();
    const persons = personRows(peerId);
    const byKey = pk => persons.find(x => pkey(x) === pk);
    // половина пары согласуется с известным полом? (первая половина — М)
    const posMatch = (pk, isFirst) => {
        const r = byKey(pk);
        if (!r || !r.sex) return true;
        return r.sex === "M" ? isFirst : !isFirst;
    };
    const others = parentKeys(peerId, link.c).filter(o => o !== link.p);
    for (const w of weddingRows(peerId)) {
        if (w.fx === link.fam) continue;
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

// подтвердить свадьбу: marr/div кандидата крепится к семье связи точно
// (по xref, без угадывания имён); пара-заглушка без детей убирается вместе
// с заглушками; пол родителей — по порядку половин (первый — М, второй — Ж)
function confirmPair(peerId, link, cand) {
    const f = famRaw(peerId, link.fam);
    if (!f) return null;
    const w = famRaw(peerId, cand.fx);
    if (w && w.xref !== f.xref) {
        const fps = new Set([f.husb, f.wife].filter(Boolean));
        const wps = [w.husb, w.wife].filter(Boolean);
        const wKids = q1("SELECT COUNT(*) AS n FROM chil WHERE chat=? AND fam=?", peerId, w.xref).n;
        if (wps.length && wps.every(x => fps.has(x))) {
            // та же пара (другая fam): детей и связи переносим в неё, дубль уходит
            for (const r of qa("SELECT indi, adopted FROM chil WHERE chat=? AND fam=?", peerId, f.xref)) {
                qr("INSERT OR IGNORE INTO chil(chat,fam,indi,adopted) VALUES(?,?,?,?)",
                    peerId, w.xref, r.indi, r.adopted);
            }
            qr("UPDATE links SET fam=? WHERE chat=? AND fam=?", w.xref, peerId, f.xref);
            qr("DELETE FROM chil WHERE chat=? AND fam=?", peerId, f.xref);
            qr("DELETE FROM fam WHERE chat=? AND xref=?", peerId, f.xref);
            link.fam = w.xref;
            f.xref = w.xref;
        } else if (wKids === 0) {
            // пара-заглушка (или бездетная пара): marr/div переезжает, fam уходит
            qr("UPDATE fam SET marr_d=?, marr_abt=?, marr_plac=?, div_d=?, div_abt=?, div_plac=? WHERE chat=? AND xref=?",
                w.marr_d, w.marr_abt ?? 0, w.marr_plac, w.div_d, w.div_abt ?? 0, w.div_plac, peerId, f.xref);
            qr("DELETE FROM chil WHERE chat=? AND fam=?", peerId, w.xref);
            qr("UPDATE links SET fam=NULL WHERE chat=? AND fam=?", peerId, w.xref);
            qr("DELETE FROM fam WHERE chat=? AND xref=?", peerId, w.xref);
            for (const x of wps) dropStubIfOrphan(peerId, x);
        } else {
            // семья с детьми (напр., из гедкома): копируем marr, её не трогаем
            qr("UPDATE fam SET marr_d=?, marr_abt=?, marr_plac=?, div_d=?, div_abt=?, div_plac=? WHERE chat=? AND xref=?",
                w.marr_d, w.marr_abt ?? 0, w.marr_plac, w.div_d, w.div_abt ?? 0, w.div_plac, peerId, f.xref);
        }
    }
    const [n1, n2] = cand.pair.slice(0, -11).split("+");
    for (const pk of [link.p, ...parentKeys(peerId, link.c)]) {
        const x = xrefOfKey(peerId, pk);
        if (!x) continue;
        if (keyN(pk) === n1) qr("UPDATE indi SET sex='M' WHERE chat=? AND xref=?", peerId, x);
        else if (keyN(pk) === n2) qr("UPDATE indi SET sex='F' WHERE chat=? AND xref=?", peerId, x);
    }
    qr("UPDATE links SET pairCand=NULL WHERE chat=? AND id=?", peerId, link.id);
    link.pairCand = null;
    return famView(peerId, f.xref);
}

// заглушка без семьи и без детей — мусор после привязки свадьбы
function dropStubIfOrphan(peerId, xref) {
    const i = indiOf(peerId, xref);
    if (!i || i.birt_d !== null) return;
    if (q1("SELECT xref FROM fam WHERE chat=? AND (husb=? OR wife=?) LIMIT 1", peerId, xref, xref)) return;
    if (q1("SELECT fam FROM chil WHERE chat=? AND indi=? LIMIT 1", peerId, xref)) return;
    invalidateDatelessPanels(peerId, xref);
    qr("DELETE FROM indi WHERE chat=? AND xref=?", peerId, xref);
}

// очистить дерево чата (замена при импорте; настройки/sent остаются)
function clearChatTree(peerId) {
    invalidateDatelessPanels(peerId);
    qr("DELETE FROM indi WHERE chat=?", peerId);
    qr("DELETE FROM fam WHERE chat=?", peerId);
    qr("DELETE FROM chil WHERE chat=?", peerId);
    qr("DELETE FROM links WHERE chat=?", peerId);
}

function deleteDatelessPerson(peerId, cmid, panel) {
    if (datelessPanel(peerId, cmid, panel.id) !== panel) return false;
    const x = panel.xref;
    sq().exec('BEGIN');
    try {
        const fams = qa(`SELECT xref FROM fam WHERE chat=? AND (husb=? OR wife=?)
            UNION SELECT fam FROM chil WHERE chat=? AND indi=?`, peerId, x, x, peerId, x);
        qr('DELETE FROM chil WHERE chat=? AND indi=?', peerId, x);
        qr('UPDATE fam SET husb=NULL WHERE chat=? AND husb=?', peerId, x);
        qr('UPDATE fam SET wife=NULL WHERE chat=? AND wife=?', peerId, x);
        qr('DELETE FROM indi WHERE chat=? AND xref=? AND birt_d IS NULL', peerId, x);
        for (const { xref } of fams) {
            normalizeFam(peerId, xref);
            if (!famRaw(peerId, xref)) qr('UPDATE links SET fam=NULL WHERE chat=? AND fam=?', peerId, xref);
        }
        sq().exec('COMMIT');
    } catch (e) {
        sq().exec('ROLLBACK');
        throw e;
    }
    invalidateDatelessPanels(peerId, x);
    return true;
}

// удалить событие с каскадом: связи персоны; у пары «Имя+Имя» — свадьба/развод
// с семей; висячие кандидаты-свадьбы у оставшихся связей; пустые семьи чистятся
function deleteEventCascade(peerId, key) {
    const name = key.slice(0, -11), d = key.slice(-10);
    const person = q1("SELECT xref FROM indi WHERE chat=? AND name=? AND birt_d=?", peerId, name, d);
    if (person) {
        const x = person.xref;
        const fams = new Set(qa("SELECT fam AS f FROM links WHERE chat=? AND (p=? OR c=?)", peerId, key, key)
            .map(r => r.f).filter(Boolean));
        qr("DELETE FROM links WHERE chat=? AND (p=? OR c=?)", peerId, key, key);
        qr("DELETE FROM chil WHERE chat=? AND indi=?", peerId, x);
        qr("UPDATE fam SET husb=NULL WHERE chat=? AND husb=?", peerId, x);
        qr("UPDATE fam SET wife=NULL WHERE chat=? AND wife=?", peerId, x);
        // сама запись удаляется: «Событие удалено» — персона целиком (раньше
        // строка оставалась и персон показывали поиск/списки/роспись/гедком)
        invalidateDatelessPanels(peerId, x);
        qr("DELETE FROM indi WHERE chat=? AND xref=?", peerId, x);
        for (const fx of fams) normalizeFam(peerId, fx);
    } else if (name.includes("+")) {
        // свадьба «Имя1+Имя2 Д»: снять marr/div с семей с этой датой и половиной
        const [n1, n2] = name.split("+");
        for (const f of qa("SELECT xref FROM fam WHERE chat=? AND marr_d=?", peerId, d)) {
            const nm = famNames(peerId, f.xref);
            if (nm.hn === n1 || nm.hn === n2 || nm.wn === n1 || nm.wn === n2)
                qr("UPDATE fam SET marr_d=NULL, marr_abt=0, marr_plac=NULL, div_d=NULL, div_abt=0, div_plac=NULL WHERE chat=? AND xref=?",
                    peerId, f.xref);
        }
    }
    for (const l of qa("SELECT id, pairCand FROM links WHERE chat=? AND pairCand IS NOT NULL", peerId)) {
        const cur = JSON.parse(l.pairCand);
        const cand = cur.filter(c => c.pair !== key && !keyN(c.pair).split("+").includes(name));
        if (cand.length !== cur.length)
            qr("UPDATE links SET pairCand=? WHERE chat=? AND id=?", cand.length ? JSON.stringify(cand) : null, peerId, l.id);
    }
}

// импорт разобранного гедкома = ЗАМЕНА: дерево чата очищается и заливается
// заново (слияние больше не делаем — смешивание источников ломало базу).
// fam — по одному на каждый FAM файла с точными xref'ами (без слипания
// семей ребёнка); свадьбы живут на fam — точная привязка супругов;
// именованные дети без ДР получают оценку с учётом порядка CHIL (EST-день);
// бездатные супруги вне CHIL могут остаться заглушками (birt_d NULL).
// Возвращает краткий отчёт. Повторный импорт лечит любые старые данные
function importGedcom(peerId, g) {
    g = mskGedcom(g);
    clearChatTree(peerId);
    const byId = new Map(); // xref файла → xref в базе (совпавшие «Имя Д» — один)
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
        const u = uniqueKeyOf(peerId, ind.name, ind.birt.date, approx, false, ind.__xref);
        // дубль не сдвигается — abt исходный (дата сохранена, суффикс «~xref»)
        const uabt = ind.birt.abt || 0;
        resolved.set(ind.__xref, u.birtD);
        if (u.name !== ind.name || u.birtD !== ind.birt.date)
            dups.push({ from: ind.name + " " + approxOut(ind.birt.date, ind.birt.abt),
                to: u.name + " " + approxOut(u.birtD, uabt) });
        qr(`INSERT INTO indi(chat,xref,name,birt_d,birt_h,birt_m,src_h,src_m,deat_d,deat_h,deat_m,dsrc_h,dsrc_m,sex,plac,deat_plac,note,birt_abt,deat_abt)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            peerId, ind.__xref, u.name, u.birtD,
            ind.birt.h ?? null, ind.birt.m ?? null,
            ind.birt.time ? Number(ind.birt.time.slice(0, 2)) : null,
            ind.birt.time ? Number(ind.birt.time.slice(3, 5)) : null,
            ind.deat && ind.deat.date ? ind.deat.date : null,
            ind.deat?.h ?? null, ind.deat?.m ?? null,
            ind.deat && ind.deat.time ? Number(ind.deat.time.slice(0, 2)) : null,
            ind.deat && ind.deat.time ? Number(ind.deat.time.slice(3, 5)) : null,
            ind.sex ?? null,
            ind.birt && ind.birt.plac ? ind.birt.plac : null,
            ind.deat && ind.deat.plac ? ind.deat.plac : null,
            ind.note ?? null,
            uabt, // дубль — суффикс «~xref», дата и abt исходные
            (ind.deat && ind.deat.abt) || 0);
        byId.set(ind.__xref, ind.__xref);
        persons++;
    }
    const { fullOf, birthOrderErrors, childrenByFamily } = gedFictiveDates(g, famRefs, resolved);
    const dateProtectedRefs = new Set(g.fams.flatMap(f => [...f.chil, ...(f.chil.length ? [f.husb, f.wife] : [])]));
    // второй проход: бездатные супруги и дети — фиктивная полная дата,
    // birt_abt 15 (EST-день: в шкале PDF нет года и прожитых лет, печать —
    // «1234-05-06~»); полная точность сохраняет round-trip .ged.txt
    // (экспорт «EST 6 MAY 1234»); коллизия фиктивных
    // дат детей — суффикс имени без изменения выбранной даты; безымянные — мимо
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
            qr(`INSERT INTO indi(chat,xref,name,birt_d,birt_h,birt_m,src_h,src_m,deat_d,deat_h,deat_m,dsrc_h,dsrc_m,sex,plac,deat_plac,note,birt_abt,deat_abt)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                peerId, ind.__xref, sname, null,
                null, null, null, null,
                ind.deat && ind.deat.date ? ind.deat.date : null,
                ind.deat?.h ?? null, ind.deat?.m ?? null,
                ind.deat && ind.deat.time ? Number(ind.deat.time.slice(0, 2)) : null,
                ind.deat && ind.deat.time ? Number(ind.deat.time.slice(3, 5)) : null,
                ind.sex ?? null,
                ind.birt && ind.birt.plac ? ind.birt.plac : null,
                ind.deat && ind.deat.plac ? ind.deat.plac : null,
                ind.note ?? null,
                0,
                (ind.deat && ind.deat.abt) || 0);
            byId.set(ind.__xref, ind.__xref);
            persons++;
            continue;
        }
        const u = uniqueKeyOf(peerId, ind.name, full, true, !dateProtectedRefs.has(ind.__xref), ind.__xref);
        // фиктивная ДР от супруга — всегда birt_abt 15 (EST-день, как и
        // сдвинутый дубль): в шкале PDF у такой строки нет года и прожитых
        // лет; полная точность — для round-trip .ged.txt
        const uabt = 15;
        if (u.name !== ind.name || u.birtD !== full)
            dups.push({ from: ind.name, to: u.name + " " + approxOut(u.birtD, uabt) });
        qr(`INSERT INTO indi(chat,xref,name,birt_d,birt_h,birt_m,src_h,src_m,deat_d,deat_h,deat_m,dsrc_h,dsrc_m,sex,plac,deat_plac,note,birt_abt,deat_abt)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            peerId, ind.__xref, u.name, u.birtD,
            null, null, null, null,
            ind.deat && ind.deat.date ? ind.deat.date : null,
            ind.deat?.h ?? null, ind.deat?.m ?? null,
            ind.deat && ind.deat.time ? Number(ind.deat.time.slice(0, 2)) : null,
            ind.deat && ind.deat.time ? Number(ind.deat.time.slice(3, 5)) : null,
            ind.sex ?? null,
            ind.birt && ind.birt.plac ? ind.birt.plac : null,
            ind.deat && ind.deat.plac ? ind.deat.plac : null,
            ind.note ?? null,
            uabt, // EST-день; коллизия у ребёнка меняет имя, не дату
            (ind.deat && ind.deat.abt) || 0);
        byId.set(ind.__xref, ind.__xref);
        persons++;
    }
    let famCount = 0, childCount = 0;
    for (const f of g.fams) {
        const h = f.husb && byId.get(f.husb), w = f.wife && byId.get(f.wife);
        const hasMarr = f.marr && f.marr.date;
        const insF = qr(`INSERT OR IGNORE INTO fam(chat,xref,adhoc,husb,wife,marr_d,marr_abt,marr_plac,note,div_d,div_abt,div_plac) VALUES(?,?,0,?,?,?,?,?,?,?,?,?)`,
            peerId, f.__xref, h ?? null, w ?? null,
            hasMarr ? f.marr.date : null, (hasMarr && f.marr.abt) || 0, hasMarr && f.marr.plac ? f.marr.plac : null,
            f.note ?? null,
            f.div && f.div.date ? f.div.date : null, (f.div && f.div.abt) || 0, f.div && f.div.plac ? f.div.plac : null);
        if (insF.changes) famCount++;
        for (const cx of childrenByFamily.get(f)) {
            const c = byId.get(cx);
            if (!c) continue;
            const insC = qr("INSERT OR IGNORE INTO chil(chat,fam,indi,adopted) VALUES(?,?,?,?)",
                peerId, f.__xref, c, f.adopted.includes(cx) ? 1 : 0);
            if (insC.changes) childCount++;
            for (const p of [h, w]) {
                if (!p || p === c) continue;
                const pk = keyOfXref(peerId, p), ck = keyOfXref(peerId, c);
                if (!pk || !ck) continue;
                qr("INSERT OR IGNORE INTO links(chat,p,c,who,fam,cmid) VALUES(?,?,?,?,?,0)",
                    peerId, pk, ck, "c", f.__xref);
            }
        }
    }
    // ADOP + FAMC у персоны: усыновление в указанной семье (PEDI мог не быть)
    for (const ind of g.indis) {
        if (!ind.adopFams || !ind.adopFams.length) continue;
        const c = byId.get(ind.__xref);
        if (!c) continue;
        for (const fx of ind.adopFams)
            if (famRaw(peerId, fx))
                qr("UPDATE chil SET adopted=1 WHERE chat=? AND fam=? AND indi=?", peerId, fx, c);
    }
    return { persons, fams: famCount, links: childCount, errors: [], dups, birthOrderErrors,
        chartWarnings: importChartWarnings(peerId) };
}

const { createExportData, personFromRow } = reqVk('lib/export-data');

function exportSnapshot(peerId) {
    return {
        people: qa('SELECT * FROM indi WHERE chat=? ORDER BY rowid', peerId),
        families: qa('SELECT * FROM fam WHERE chat=? ORDER BY rowid', peerId),
        children: qa('SELECT * FROM chil WHERE chat=? ORDER BY rowid', peerId),
        pairs: linkPairs(peerId), settings: getSettings(peerId),
    };
}

const exportData = peerId => createExportData(exportSnapshot(peerId));

function gedcomText(peerId, keys) {
    return exportData(peerId).gedcomText(keys);
}

// ============================== РОДОСЛОВНАЯ РОСПИСЬ -+=: вывод ==============================
// Родословная роспись -+= чата (ввод/вывод симметричны): '-'×n — свой мужчина
// глубины n−1; '='×n — своя женщина; «+»×n (n−1 — глубина владельца) —
// свадьба, вторая половина — строкой ниже без маркера (пол выводится);
// одностороняя семья — «+»×n сама по себе; дети — глубина пары+1; заглушки —
// именные строки. Примечание — с маркером «^» (см. пакетный ввод выше).
// Показ — тапом на 🔔/🔕 колокольчика.
// Чистая логика дословно продублирована в tgcloud/lib/bot.js (dev/sync-check.mjs).
// строки персон/семей чата — общий вход chatFlatText и branchFlatText
// (ТГ-копия: tgcloud/lib/bot.js, flatRows)
function flatRows(peerId) {
    return exportData(peerId).flatRows();
}

function chatFlatText(peerId, keys = null) {
    return exportData(peerId).chatFlatText(keys);
}



// карта интерактивных связей «родитель(xref) → [дети xref]» по links
function edgeKids(peerId) {
    const rows = qa("SELECT * FROM indi WHERE chat=?", peerId);
    const xOf = new Map(rows.map(r => [r.name + " " + r.birt_d, r.xref]));
    const kids = new Map();
    for (const l of qa("SELECT p,c FROM links WHERE chat=?", peerId)) {
        const p = xOf.get(l.p), c = xOf.get(l.c);
        if (!p || !c) continue;
        if (!kids.has(p)) kids.set(p, []);
        if (!kids.get(p).includes(c)) kids.get(p).push(c);
    }
    return kids;
}

// роспись ветви персоны key («Имя ГГГГ-ММ-ДД»): поддерево потомков на всю
// глубину (семьи + интерактивные связи), герой — корневой строкой
// «-»×1/«=»×1; ввод/вывод симметричны
function branchFlatText(peerId, key) {
    const [rows, allFams] = flatRows(peerId);
    const x = (rows.find(r => r.name + " " + (r.d ?? "") === key) || {}).key;
    if (x == null) return "";
    const [picked, fams] = subsetBranch(rows, allFams, x, edgeKids(peerId));
    // герой — первой строкой росписи ветви (корень разбора): переставляем
    // его вперёд массива персон — корни flatTreeText визитуются
    // в порядке массива
    const hi = picked.findIndex(p => p.key === x);
    const persons = hi > 0 ? [picked[hi], ...picked.slice(0, hi), ...picked.slice(hi + 1)] : picked;
    return flatTreeText(persons, fams);
}





// ==================== поиск: единственное попадание → фокус ====================





function importChartWarnings(peerId) {
    try { return chartFor(peerId, null, "", null, null, true); }
    catch (e) { return [String(e.message || e).replace(/^chart:\s*/, "")]; }
}

function chartFor(peerId, keys, title, heroKey = null, range = null, diagnose = false) {
    const chart = prepareChart(peerId, keys, title, heroKey, range, diagnose);
    return diagnose ? chart : { pdf: chart.renderPdf(), persons: chart.persons };
}

function prepareChart(peerId, keys, title, heroKey, range, diagnose = false, fynnySetting) {
    return exportData(peerId).prepareChart(keys, title, heroKey, range, diagnose, fynnySetting);
}

async function sendGedcom(peerId, keys, head, msgId, convMsgId, focus) {
    return sendExportFile(peerId, head, msgId, convMsgId, 'gedcom', { keys, ...focus },
        content => [fileBaseOf(head) + '.ged', content], () => 'Не удалось выгрузить GEDCOM.');
}

async function sendPdf(peerId, head, heroKey, radius, msgId, convMsgId) {
    return sendExportFile(peerId, head, msgId, convMsgId, 'pdf', { head, heroKey, radius },
        pdf => [fileBaseOf(head) + '.pdf', pdf], e => e.message.startsWith('PDF: лимит ') ? e.message
            : e.message.includes('персоны пусты') ? 'Нет персон с датами для диаграммы.' : 'Не удалось выгрузить PDF.');
}

function exportViewer(peerId, g, heroKey, heroXref, radius, s, chart) {
    return exportData(peerId).exportViewer(g, heroKey, heroXref, radius, s, chart);
}

function exportChart(peerId, keys, head, heroKey, radius, s) {
    const { epubChart } = reqLib('epub');
    return epubChart(() => prepareChart(peerId,
        heroKey ? focusKeys(linkPairs(peerId), heroKey, radius, focusSpousePairs(peerId)) : keys,
        head.replace(/^\d\s+/, ''), heroKey, radius, false, s.fynny));
}

async function sendViewer(format, peerId, keys, head, heroKey, heroXref, msgId, convMsgId) {
    const label = format.toUpperCase();
    const radius = parseInt(head, 10) || 1;
    return sendExportFile(peerId, head, msgId, convMsgId, format, { head, keys, heroKey, radius, heroXref, scoped: !!heroKey && !keys },
        file => file, e => e.message.startsWith(label + ': лимит ') ? e.message : 'Не удалось выгрузить ' + label + '.');
}

async function sendExportFile(peerId, head, msgId, convMsgId, op, input, toFile, errorText) {
    return withWorkerIndicator(peerId, async (signal, progress, finish) => {
        let text = head, attachment;
        try {
            const file = await runExportStep(peerId, op, input, undefined, signal, progress);
            signal?.throwIfAborted();
            attachment = await vkUploadDoc(peerId, ...toFile(file));
        } catch (e) {
            signal?.throwIfAborted();
            console.error(op + ':', e.message);
            text = errorText(e);
        }
        signal?.throwIfAborted();
        if (finish && await finish(text, attachment)) return;
        signal?.throwIfAborted();
        await messagesSend(peerId, text, msgId, convMsgId, undefined, attachment);
    }, { msgId, convMsgId });
}

// Повтор загрузки использует новый upload_url; docs.save повторяется при сетевом сбое.
async function vkUploadDoc(peerId, title, content) {
    let j = null, lastErr = null;
    // таймаут по размеру: 10 с + ~1 с на КБ, кап 60 с (7 КБ → 17 с; upload
    // ~7 КБ наблюдался за 5 с, так что запас ~3×; большой PDF получает больше)
    const timeoutMs = Math.min(60000, 10000 + Math.ceil(content.length / 1024) * 1000);
    for (let attempt = 1; attempt <= 3 && !j; attempt++) {
        if (attempt > 1) await sleep(1500 * (attempt - 1));
        try {
            const up = await vkApi("docs.getMessagesUploadServer",
                groupId ? { peer_id: peerId, group_id: groupId, type: "doc" } : { peer_id: peerId, type: "doc" });
            const fd = new FormData();
            fd.append("file", new Blob([content]), title);
            const res = await fetch(up.upload_url, { method: "POST", body: fd, signal: AbortSignal.timeout(timeoutMs) });
            const text = await res.text();
            try {
                j = JSON.parse(text);
                // ответ с error («not saved» и т.п.) — тоже повод ретраить,
                // а не сразу бросать
                if (j.error) {
                    lastErr = new Error("docs upload: " + JSON.stringify(j).slice(0, 120));
                    j = null;
                    console.error("ged upload attempt", attempt, title + ":", lastErr.message);
                }
            } catch {
                lastErr = new Error("docs upload: HTTP " + res.status + " " + text.slice(0, 120).replace(/\s+/g, " "));
                console.error("ged upload attempt", attempt, title + ":", lastErr.message);
            }
        } catch (e) {
            lastErr = e; // сеть/таймаут — повторить
            console.error("ged upload attempt", attempt, title + ":", e.message);
        }
    }
    if (!j) throw lastErr || new Error("docs upload: пустой ответ");
    if (!j.file) throw new Error("docs upload: " + JSON.stringify(j).slice(0, 200));
    let saved;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            saved = await vkApi("docs.save", { file: j.file, title });
            break;
        } catch (e) {
            if (attempt === 3 || !(/fetch failed/i.test(e.message) || ["TimeoutError", "AbortError"].includes(e.name))) throw e;
            console.error("ged save attempt", attempt, title + ":", e.message, "— повторяю");
            await sleep(1500 * attempt);
        }
    }
    const d = saved.doc || (saved[0] || {}).doc;
    if (!d) throw new Error("docs.save: нет документа");
    return "doc" + d.owner_id + "_" + d.id;
}

const activeDnaExports = new Map();
const workerUpdates = new (require('node:async_hooks').AsyncLocalStorage)();
const workerIndicators = new Map();
let indicatorSerial = 0;
const { createExportPool } = reqVk('lib/export-pool');
let exportPool, workerTestOptions;

function closeExportPool() {
    exportPool?.close();
    exportPool = undefined;
}

async function computeExport(peerId, op, input = {}, payload, indicator) {
    return withWorkerIndicator(peerId, (signal, progress) => runExportStep(peerId, op, input, payload, signal, progress), indicator);
}

async function runExportStep(peerId, op, input, payload, signal, progress) {
    const lease = await openExport(peerId, undefined, { ...input, manualCancel: !!signal }, { peer: peerId }, signal, progress);
    try {
        if (input.scoped) await lease.step('focus_keys');
        return await lease.step(op, payload);
    } finally { lease.release(); }
}

async function parseImport(peerId, op, text) {
    if (text.length < 8192) return op === 'parse_flat' ? parseTree(text) : parseGedcom(text);
    return withWorkerIndicator(peerId, async (signal, progress) => {
        exportPool ??= createExportPool(LOG_VK_TIMINGS ? vkTiming : undefined, workerTestOptions);
        const lease = await exportPool.open({ manualCancel: !!signal }, { peer: peerId }, signal, text.length * 2, progress);
        try { return await lease.step(op, text); }
        finally { lease.release(); }
    });
}

const isWorkerCancelled = error => error?.name === 'AbortError' && error.message === 'VK command cancelled';

async function withWorkerIndicator(peerId, run, indicator) {
    const ctx = workerUpdates.getStore();
    if (!ctx || ctx.peerId !== peerId) return run();
    const control = new AbortController();
    const original = indicator?.cmid;
    if (original) {
        const key = `${peerId}:${original}`;
        cancelDnaExport(peerId, original);
        activeDnaExports.set(key, control);
        let last = -Infinity, dots = 0;
        const edit = () => vkApi('messages.edit', { peer_id: peerId, conversation_message_id: original,
            message: indicator.text + '.'.repeat(dots), keyboard: indicator.keyboard })
            .catch(e => console.error('worker progress:', e.message));
        try {
            await (control.progressTail = edit());
            return await run(control.signal, () => {
                if (control.signal.aborted || dots >= 8 || performance.now() - last < 2000) return;
                last = performance.now();
                dots++;
                control.progressTail = control.progressTail.then(() => {
                    if (!control.signal.aborted) return edit();
                });
            });
        } finally {
            await control.progressTail;
            if (activeDnaExports.get(key) === control) activeDnaExports.delete(key);
            if (control.signal.aborted) throw new DOMException('VK command cancelled', 'AbortError');
        }
    }
    const id = `${process.pid}-${Date.now()}-${++indicatorSerial}`;
    const keyboard = JSON.stringify({ inline: true, buttons: [[{
        action: { type: 'callback', label: '❌', payload: JSON.stringify({ c: 'work:cancel', id }) }, color: 'secondary',
    }]] });
    const job = { peerId, control, tail: Promise.resolve() };
    workerIndicators.set(id, job);
    let messageId, dots = 0, last = -Infinity, finalized = false;
    const finish = async (message, attachment) => {
        await job.tail;
        control.signal.throwIfAborted();
        if (!messageId) return false;
        const edit = vkApi('messages.edit', { peer_id: peerId, message_id: messageId, message,
            attachment, keyboard: JSON.stringify({ inline: true, buttons: [] }) });
        job.tail = edit.catch(() => {});
        try {
            await edit;
            finalized = true;
            return true;
        } catch (e) {
            console.error('worker result edit:', e.message);
            return false;
        }
    };
    try {
        messageId = await messagesSend(peerId, '⏳', indicator?.msgId, indicator?.convMsgId, keyboard);
        const result = await run(control.signal, () => {
            if (control.signal.aborted || dots >= 8 || performance.now() - last < 2000) return;
            last = performance.now();
            const message = '⏳' + '.'.repeat(++dots);
            job.tail = job.tail.then(() => {
                if (!control.signal.aborted) return vkApi('messages.edit', { peer_id: peerId, message_id: messageId, message, keyboard });
            }).catch(e => console.error('worker progress:', e.message));
        }, finish);
        return result;
    } catch (e) {
        control.signal.throwIfAborted();
        throw e;
    } finally {
        workerIndicators.delete(id);
        await job.tail;
        if (messageId && !finalized && !control.signal.aborted) await vkApi('messages.delete', {
            peer_id: peerId, message_ids: messageId, delete_for_all: 1,
        }).catch(e => console.error('worker indicator:', e.message));
        control.signal.throwIfAborted();
    }
}

async function cancelWorkerIndicator(o, id) {
    const job = workerIndicators.get(id);
    const active = job?.peerId === o.peer_id;
    if (active) job.control.abort(new DOMException('VK command cancelled', 'AbortError'));
    await answerEvent(o.event_id || o.id, o.user_id, o.peer_id, active ? 'работа отменена' : 'работа уже завершена');
    if (active) {
        await job.tail;
        await deleteByCmid(o.peer_id, o.conversation_message_id);
    }
}

function cancelDnaExport(peerId, cmid) {
    const key = peerId + ':' + cmid;
    const job = activeDnaExports.get(key);
    activeDnaExports.delete(key);
    job?.abort?.();
    return job;
}

function openExport(peerId, settings, input, trace, signal, onProgress) {
    exportPool ??= createExportPool(LOG_VK_TIMINGS ? vkTiming : undefined, workerTestOptions);
    const started = performance.now();
    const snapshot = exportSnapshot(peerId);
    if (settings) snapshot.settings = settings;
    // Include variable-width text (especially notes), as well as a row overhead.
    let size = 0;
    for (const rows of [snapshot.people, snapshot.families, snapshot.children, snapshot.pairs]) {
        for (const row of rows) {
            size += 256;
            for (const value of Object.values(row)) if (typeof value === 'string') size += value.length * 2;
        }
    }
    if (LOG_VK_TIMINGS) vkTiming('worker_snapshot', { ...trace, bytes: size, ms: elapsedMs(started) });
    return exportPool.open({ ...input, snapshot }, trace, signal, size, onProgress);
}

async function exportFocused(o, head, heroKey, radius, kb, dateless) {
    return exportDna(o, head, heroKey, radius, kb, dateless);
}

async function exportWhole(o, kb) {
    await exportDna(o, 'Древо чата', null, null, kb);
}

async function exportDna(o, head, heroKey, radius, kb, dateless) {
    const peerId = o.peer_id;
    const focused = !!(heroKey || dateless);
    const s = getSettings(peerId);
    const id = peerId + ':' + o.conversation_message_id;
    cancelDnaExport(peerId, o.conversation_message_id);
    const control = new AbortController();
    activeDnaExports.set(id, control);
    let lastDot = -Infinity, dots = 0;
    const isCurrent = () => activeDnaExports.get(id) === control && (!dateless || dateless.current());
    const editProgress = (text, attachment = '') => {
        const previous = control.progressTail;
        return control.progressTail = Promise.resolve(previous).then(() => {
            if (isCurrent()) return vkApi('messages.edit', { peer_id: peerId, conversation_message_id: o.conversation_message_id,
                message: text, attachment, keyboard: kb ?? undefined });
        }).catch(e => console.error('DNA progress:', e.message));
    };
    let showProgress = () => editProgress(head + '\n⏳' + '.'.repeat(dots));
    const onProgress = progress => {
        if (LOG_VK_TIMINGS) vkTiming('export_progress', { peer: peerId, cmid: o.conversation_message_id,
            event_id: o.event_id || o.id, ...progress });
        const now = performance.now();
        if (!isCurrent() || dots >= 8 || now - lastDot < 2000) return;
        lastDot = now;
        dots++;
        void showProgress();
    };
    let lease;
    try {
        const trace = { peer: peerId, cmid: o.conversation_message_id, event_id: o.event_id || o.id };
        const started = performance.now();
        await showProgress();
        if (!isCurrent()) {
            if (activeDnaExports.get(id) === control) activeDnaExports.delete(id);
            return;
        }
        lease = await openExport(peerId, s, { head: dateless?.title ?? head, heroKey, radius, fullPack: !focused, manualCancel: true,
            ...(dateless && { keys: dateless.keys, heroXref: dateless.heroXref }) }, trace, control.signal, onProgress);
        const pack = await lease.step(heroKey ? 'focus' : 'flat');
        if (control.signal.aborted) { lease.release(); return; }
        if (!focused) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, pack.trim() ? 'роспись древа чата' : 'древо пусто');
            if (!pack.trim()) {
                await editProgress(head + '\n(древо пусто)');
                lease.release();
                if (isCurrent()) activeDnaExports.delete(id);
                return;
            }
        }
        if (!isCurrent()) {
            lease.release();
            if (activeDnaExports.get(id) === control) activeDnaExports.delete(id);
            return;
        }
        if (dateless && !pack.trim()) throw new Error('Пустая роспись радиуса');
        if (LOG_VK_TIMINGS && heroKey) vkTiming('focus_prepare', { ...trace, status: 'ok', ms: elapsedMs(started) });
        await sendGedArtifacts(o, undefined, head, heroKey, pack, s, kb, { lease, control, dateless,
            progress: (text, attachments) => {
                showProgress = () => editProgress(text + '.'.repeat(dots), attachments());
                return showProgress();
            } });
    } catch (e) {
        lease?.release();
        if (activeDnaExports.get(id) === control) activeDnaExports.delete(id);
        if (!control.signal.aborted) throw e;
    }
}

async function sendGedArtifacts(o, keys, head, heroKey, pack, s, kb, offload) {
    const peerId = o.peer_id;
    const base = fileBaseOf(offload?.dateless?.title ?? head);
    const radius = heroKey ? parseInt(head, 10) || 1 : null;
    const max = 4000;
    const suffix = '\n✂️⏳' + (offload ? '........' : '');
    const maxHead = max - suffix.length - NOT_FOR_GRAFT.length - 1;
    const prefix = !heroKey && !offload?.dateless ? '' : (head.length <= maxHead ? head : head.slice(0, maxHead - 1) + '…') + '\n';
    const body = offload?.dateless && pack.startsWith(NOT_FOR_GRAFT + '\n') ? pack.slice(NOT_FOR_GRAFT.length + 1) : pack;
    const overflow = prefix.length + body.length + '\n⏳'.length + (offload ? 8 : 0) > max;
    const preview = overflow ? (prefix + cutLines(body, max, prefix.length + suffix.length, false)).trimEnd() : prefix + body;
    const finalText = overflow ? (preview ? preview + '\n' : '') + '✂️' : preview;
    const holdText = finalText + (overflow ? '⏳' : '\n⏳');
    const formats = ['epub', 'html'].filter(format => s[format]);
    const busy = overflow || s.gedcom || s.pdf || formats.length;
    const atts = [], errors = [];
    const timing = LOG_VK_TIMINGS && { peer: peerId, cmid: o.conversation_message_id, event_id: o.event_id || o.id };
    const exportId = peerId + ':' + o.conversation_message_id;
    const token = offload?.control ?? Symbol();
    if (!offload) cancelDnaExport(peerId, o.conversation_message_id);
    activeDnaExports.set(exportId, token);
    const isCurrent = () => activeDnaExports.get(exportId) === token && (!offload?.dateless || offload.dateless.current());
    // An empty list removes attachments from previous taps.
    const edit = (message, keyboard = kb) => vkApi('messages.edit', {
        peer_id: peerId, conversation_message_id: o.conversation_message_id,
        message, attachment: atts.join(','), keyboard: keyboard ?? undefined,
    });
    const notice = text => messagesSend(peerId, text, 0, o.conversation_message_id).catch(e => console.error('DNA notice:', e.message));
    const publish = async (label, make) => {
        if (!isCurrent()) return;
        let tier = 'prepare', started = timing && performance.now();
        try {
            const file = await make();
            if (timing) vkTiming('export_stage', { ...timing, format: label, phase: tier,
                status: file ? 'ok' : 'skipped', ms: elapsedMs(started) });
            if (!file || !isCurrent()) return;
            tier = 'upload';
            if (timing) started = performance.now();
            const attachment = await vkUploadDoc(peerId, ...file);
            if (!isCurrent()) return;
            atts.push(attachment);
            if (timing) vkTiming('export_stage', { ...timing, format: label, phase: tier, status: 'ok', ms: elapsedMs(started) });
        } catch (e) {
            if (!isCurrent()) return;
            if (timing) vkTiming('export_stage', { ...timing, format: label, phase: tier, status: 'error', ms: elapsedMs(started) });
            console.error('DNA ' + label + ':', e.message);
            errors.push(e.message.startsWith(label + ': лимит ') ? e.message : label);
            return;
        }
        if (isCurrent()) await editHold();
    };
    const run = async () => {
        const started = timing && performance.now();
        if (timing) vkTiming('export_start', timing);
        let ged, chart, viewer;
        const getGed = () => ged ??= gedcomText(peerId, keys);
        const getChart = () => chart ??= exportChart(peerId, keys, head, heroKey, radius, s);
        let status = 'ok';
        try {
            if (overflow) await publish('роспись', () => [base + '.ged.txt', '\uFEFF' + pack]);
            if (s.gedcom) await publish('GEDCOM', async () => [base + '.ged', offload ? await offload.lease.step('gedcom') : getGed()]);
            if (s.pdf) await publish('PDF', async () => {
                try {
                    if (offload) return [base + '.pdf', await offload.lease.step('pdf')];
                    const chart = await getChart();
                    if (chart.error) throw chart.error;
                    return [base + '.pdf', Buffer.from(chart.renderPdf(), 'latin1')];
                } catch (e) {
                    const reason = e.message.replace(/^chart:\s*/, '');
                    if (reason !== 'персоны пусты') status = 'partial';
                    if (isCurrent() && reason !== 'персоны пусты') await notice('💥 Диаграмма не построена: ' + reason);
                    return null;
                }
            });
            for (const format of formats) await publish(format.toUpperCase(), async () => {
                if (offload) return offload.lease.step(format);
                const g = getGed();
                reqLib('epub').checkEpubLimit(g, format.toUpperCase());
                if (!viewer) {
                    const hero = heroKey ? personRows(peerId).find(r => pkey(r) === heroKey) : null;
                    const heroXref = hero && g.split('\n').includes('0 @' + hero.xref + '@ INDI') ? hero.xref : null;
                    viewer = exportViewer(peerId, g, heroKey, heroXref, radius, s, await getChart());
                }
                return viewer(format);
            });
        } catch (e) {
            status = 'error';
            throw e;
        } finally {
            offload?.lease.release();
            try {
                if (isCurrent()) await finish();
                else if (status !== 'error') status = 'superseded';
            } catch (e) {
                status = 'error';
                throw e;
            } finally {
                if (timing) vkTiming('export_done', { ...timing, status: status === 'ok' && errors.length ? 'partial' : status,
                    ms: elapsedMs(started) });
            }
        }
    };
    const finish = async () => {
        try {
            if (offload) await offload.control.progressTail;
            if (!isCurrent()) return;
            const errorText = errors.length ? '💥 Не удалось выложить файлы:\n' + errors.join('\n') : '';
            const inlineErrors = errorText && finalText.length + 1 + errorText.length <= max;
            const text = inlineErrors ? finalText + '\n' + errorText : finalText;
            // VK callback edits have historically needed a separate attachment edit.
            if (atts.length) await edit(undefined).catch(e => console.error('DNA attachments:', e.message));
            if (!isCurrent()) return;
            try { await edit(text); }
            catch (e) {
                console.error('DNA final edit:', e.message);
                if (!isCurrent()) return;
                try { await edit(text, null); }
                catch {
                    if (!isCurrent()) return;
                    await vkApi('messages.edit', { peer_id: peerId, conversation_message_id: o.conversation_message_id,
                        message: text }).catch(e => console.error('DNA text edit:', e.message));
                    if (isCurrent()) await messagesSend(peerId, text, 0, o.conversation_message_id, offload?.dateless ? null : kb, atts.join(','));
                }
            }
            if (isCurrent() && errorText && !inlineErrors) await notice(errorText);
        } finally {
            if (activeDnaExports.get(exportId) === token) activeDnaExports.delete(exportId);
        }
    };
    const editHold = () => offload?.progress ? offload.progress(holdText, () => atts.join(','))
        : edit(holdText).catch(e => console.error('DNA loading:', e.message));
    if (!busy) return run();
    await editHold();
    void run().catch(e => console.error('DNA export:', e.message));
}

// ============================== НАСТРОЙКИ ==============================
// Оповещения о религиозных днях per peer: { orth, islam, bud, cath, jud }.

function getSettings(peerId) {
    return normalizeSettings(q1("SELECT config FROM settings WHERE chat=?", peerId)?.config);
}

function setChatSetting(peerId, key, value) {
    const { initial, expression, params } = settingPatch(key, value);
    const row = q1(`INSERT INTO settings(chat,config) VALUES(?,?)
        ON CONFLICT(chat) DO UPDATE SET config=${expression} RETURNING config`, peerId, initial, ...params);
    return normalizeSettings(row.config)[key];
}

// клавиатура: по 4 кнопки в ряд, последняя — ❌ (закрыть, красная);
// состояние — 🔔 (вкл) / 🔕 (выкл);
// подпись колокольчика — подписка: 🔔 вкл (список по ММ-ДД) / 🔕 выкл (по ГГГГММДД)
function relKeyboard(peerId) {
    const s = getSettings(peerId);
    const mk = (label, payload, color) => ({
        action: { type: "callback", label, payload: JSON.stringify(payload) },
        color
    });
    const btn = key => mk(REL_DEFS[key].icon + (s[key] ? "🔔" : "🔕"), { rel: key }, "secondary");
    return JSON.stringify({
        inline: true,
        buttons: [
            [mk("🗑", { c: "del" }, "secondary"), mk("🔔", { c: "bell" }, "secondary"), mk("🧬", { c: "tree" }, "secondary"), mk("-+=", { c: "flat" }, "secondary"), mk("❌", { c: "close" }, "secondary")],
            [btn("orth"), btn("islam"), btn("bud"), btn("cath"), btn("jud")]
        ]
    });
}

// клавиатура владельца в групповом чате (колокольчик всегда 🔔)
function ownerKeyboard() {
    const mk = (label, payload) => ({
        action: { type: "callback", label, payload: JSON.stringify(payload) },
        color: "secondary"
    });
    return JSON.stringify({ inline: true, buttons: [[mk("🗑", { c: "del" }), mk("🔔", { c: "bell" }), mk("🧬", { c: "tree" }), mk("-+=", { c: "flat" }), mk("❌", { c: "close" })]] });
}

// клавиатура обычного участника группового чата (колокольчик всегда 🔔)
function bellKeyboard() {
    const mk = (label, payload) => ({
        action: { type: "callback", label, payload: JSON.stringify(payload) },
        color: "secondary"
    });
    return JSON.stringify({ inline: true, buttons: [[mk("🔔", { c: "bell" }), mk("🧬", { c: "tree" }), mk("-+=", { c: "flat" }), mk("❌", { c: "close" })]] });
}

const snackbar = text => JSON.stringify({ type: "show_snackbar", text });

async function answerEvent(eventId, userId, peerId, text) {
    // тост — косметика: ВК отвечает 100 invalid event_id на повторный/старый
    // event (reconnect long poll, черновик старой клавиатуры) — не роняем
    // обработчик, дерево уже применено, правку сообщения (editOrigin) делаем
    try {
        return await vkApi("messages.sendMessageEventAnswer", {
            event_id: eventId,
            user_id: userId,
            peer_id: peerId,
            event_data: snackbar(text)
        });
    } catch (e) {
        console.error("answerEvent:", e.message, "(peer", peerId, "event", String(eventId).slice(0, 24) + ")");
        return null;
    }
}

// удалить сообщение по conversation_message_id чата. В личных чатах удаление
// работает честно. В беседах messages.delete по conversation_message_ids
// удаляет только для бота (даже с delete_for_all), поэтому там сначала
// затираем сообщение messages.edit — текст и клавиатуру (правка своих
// сообщений боту разрешена всегда) — затем удаляем best-effort
async function deleteByCmid(peerId, cmid) {
    if (!cmid) {
        console.log("deleteByCmid: нет cmid");
        return false;
    }
    if (peerId >= 2000000000) {
        let wiped = false;
        try {
            await vkApi("messages.edit", {
                peer_id: peerId, conversation_message_id: cmid,
                message: helpText(getSettings(peerId)), keyboard: JSON.stringify({ inline: true, buttons: [] })
            });
            console.log("message edit: затёрто", cmid);
            wiped = true;
        } catch (e) {
            console.error("message edit:", e.message); // уже удалено — ок
        }
        try {
            const res = await vkApi("messages.delete", {
                peer_id: peerId, conversation_message_ids: cmid, delete_for_all: 1
            });
            console.log("message delete", cmid, "->", JSON.stringify(res).slice(0, 200));
        } catch (e) {
            console.error("message delete:", e.message);
        }
        return wiped;
    }
    try {
        const res = await vkApi("messages.delete", {
            peer_id: peerId, conversation_message_ids: cmid, delete_for_all: 1
        });
        const item = Array.isArray(res) ? res[0] : null;
        if (item && item.error) {
            console.log("message delete", cmid, "->", item.error.code, item.error.description);
            return false;
        }
        console.log("message delete", cmid, "->", JSON.stringify(res).slice(0, 200));
        return true;
    } catch (e) {
        console.error("message delete:", e.message);
        return false;
    }
}

// ---- очередь отправки: flood control (ошибка 9) при массовом импорте ----
const SEND_GAP = 400; // мс между сообщениями
let sendChain = Promise.resolve();

function queueSend(params, replyCmid) {
    const queued = LOG_VK_TIMINGS && performance.now();
    const job = sendChain.then(LOG_VK_TIMINGS ? async () => {
        const started = performance.now();
        const timing = { peer: params.peer_id, random_id: params.random_id, reply_to: params.reply_to,
            reply_cmid: replyCmid,
            queue_ms: elapsedMs(queued, started) };
        let status = 'error';
        try {
            const result = await sendWithRetry(params);
            status = 'ok';
            return result;
        } finally {
            vkTiming('send_done', { ...timing, status, api_ms: elapsedMs(started) });
        }
    } : () => sendWithRetry(params));
    sendChain = job.then(() => sleep(SEND_GAP), () => sleep(SEND_GAP));
    return job;
}

async function sendWithRetry(params) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await vkApi("messages.send", params);
        } catch (e) {
            if (e.message.includes("messages.send 9:") && attempt < 5) {
                await sleep(3000); // flood control — подождать и повторить
                continue;
            }
            if (e.message.includes("911") && params.keyboard) {
                console.error("keyboard rejected (" + e.message + "):", params.keyboard);
                await bisectKeyboard(params);
                delete params.keyboard; // деградация: текст без клавиатуры
                continue;
            }
            throw e;
        }
    }
}

// 911: проверить каждую кнопку отдельным сообщением-«…», найти виновника
async function bisectKeyboard(params) {
    let kb;
    try { kb = JSON.parse(params.keyboard); } catch (e) { return; }
    const peerId = params.peer_id ?? params.peer_ids;
    const flat = kb.buttons.flatMap((row, ri) => row.map((b, ci) => ({ ...b, _pos: ri + ":" + ci })));
    for (const b of flat) {
        const one = JSON.stringify({ inline: true, buttons: [[{ action: { type: b.action.type, label: b.action.label, payload: b.action.payload, color: b.action.color } }]] });
        try {
            await vkApi("messages.send", {
                peer_id: peerId,
                message: "кнопка " + b._pos + " " + b.action.label,
                random_id: Date.now() % 2147483647,
                keyboard: one
            });
            console.log("кнопка", b._pos, b.action.label, "— ОК");
        } catch (e) {
            console.log("кнопка", b._pos, b.action.label, "— ОТКЛОНЕНА:", e.message);
        }
        await sleep(400);
    }
}

// ============================== CATCH UP ==============================
// Как в pinguin (messages.getHistory): после простоя догоняем сообщения,
// пришедшие пока бот не работал. Очерёдность — по lastSeen (unix время
// последнего обработанного сообщения; meta-таблица), пиры — из дерева.

function markSeen(date) {
    const last = Number((q1("SELECT v FROM meta WHERE k='lastSeen'") || {}).v || 0);
    if (date > last)
        qr("INSERT OR REPLACE INTO meta(k,v) VALUES('lastSeen',?)", String(date));
}

async function catchUp(startAt) {
    const peers = qa("SELECT DISTINCT chat AS c FROM indi UNION SELECT DISTINCT chat AS c FROM links").map(r => r.c);
    const lastSeen = Number((q1("SELECT v FROM meta WHERE k='lastSeen'") || {}).v || 0);
    for (const peer of peers) {
        let items;
        try {
            const res = await vkApi("messages.getHistory", { peer_id: peer, count: 200 });
            items = res.items || [];
        } catch (e) {
            console.error("catchUp", peer, e.message);
            continue;
        }
        let n = 0;
        for (const tm of items) { // от новых к старым
            if (tm.out || tm.from_id < 0) continue;   // только чужие входящие
            if (tm.date <= lastSeen || tm.date > startAt) continue;
            n++;
            const started = LOG_VK_TIMINGS && performance.now();
            const trace = LOG_VK_TIMINGS && { source: 'catch_up', type: 'message_new', peer, cmid: tm.conversation_message_id,
                message_id: tm.id, sent_at_ms: tm.date * 1000, age_ms: Date.now() - tm.date * 1000 };
            if (trace) vkTiming('handler_start', trace);
            let status = 'error';
            try {
                await updateRouter.catchUp(tm, peer);
                status = 'ok';
            } catch (e) {
                console.error("catchUp", peer, tm.id, e.message);
            } finally {
                if (trace) vkTiming('handler_done', { ...trace, status, ms: elapsedMs(started) });
            }
        }
        if (n) console.log("catchUp peer", peer, "replayed", n);
    }
}

// ============================== VK ==============================


// необязательное ограничение: обслуживать только эту группу (число из club…)
const GROUP_ID = Number(process.env.VK_GROUP_ID || 0) || 0;

let token = process.env.VK_TOKEN || "";
if (!token) {
    try {
        const m = fs.readFileSync(path.join(__dirname, ".env"), "utf8").match(/^\s*VK_TOKEN\s*=\s*(\S+)\s*$/m);
        if (m) token = m[1];
    } catch (e) { /* .env не обязателен */ }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOG_RAW = !!process.env.LOG_VK; // сырые ответы VK API и Long Poll
const LOG_VK_TIMINGS = process.env.LOG_VK_TIMINGS === '1';
const elapsedMs = (start, end = performance.now()) => Math.round(end - start);
const vkTiming = (stage, fields) => console.log('vk timing', JSON.stringify({ stage, at_ms: Date.now(), ...fields }));

function watchVkLoop() {
    const interval = 250;
    let last = performance.now();
    setInterval(() => {
        const now = performance.now();
        const loopLag = elapsedMs(last + interval, now);
        last = now;
        if (loopLag >= interval) vkTiming('loop_lag', { loop_lag_ms: loopLag });
    }, interval).unref();
}

const vkApi = reqVk("lib/api").createVkApi(token, LOG_RAW);

// ответ на сообщение: reply_to по глобальному id (личка) либо forward по
// conversation_message_id (в чатах id приходит 0 — как в pinguin vk.go)
async function messagesSend(peerId, text, msgId, convMsgId, keyboard, attachment, withCmid = false) {
    const params = {
        [withCmid ? 'peer_ids' : 'peer_id']: peerId,
        message: text,
        random_id: Date.now() % 2147483647
    };
    if (msgId > 0) params.reply_to = msgId;
    else if (convMsgId > 0) params.forward = JSON.stringify({
        peer_id: peerId, conversation_message_ids: [convMsgId], is_reply: true
    });
    if (keyboard) params.keyboard = keyboard;
    if (attachment) params.attachment = attachment;
    console.log(params.attachment ? "файл отправлен" : "ответ отправлен", "peer", peerId);
    return queueSend(params, params.forward ? convMsgId : undefined);
}

let lp = null; // { server, key, ts }
let groupId = GROUP_ID;
let ownerId = 0; // создатель сообщества (role=creator), 0 — неизвестен

// админ беседы или создатель сообщества; кэш на 5 минут
const adminCache = new Map();
async function isChatAdmin(peerId, userId) {
    if (userId === ownerId) return true;
    const now = Date.now();
    const hit = adminCache.get(peerId + ":" + userId);
    if (hit !== undefined && now - hit.at < 5 * 60000) return hit.val;
    let val = false;
    try {
        const r = await vkApi("messages.getConversationMembers", { peer_id: peerId });
        val = (r.items || []).some(m => m.member_id === userId && m.is_admin);
    } catch (e) {
        console.log("admin check:", e.message);
        val = false;
    }
    adminCache.set(peerId + ":" + userId, { at: now, val });
    return val;
}

async function initOwner() {
    try {
        const r = await vkApi("groups.getMembers", { group_id: groupId, filter: "managers" });
        const c = (r.items || []).find(x => x.role === "creator");
        ownerId = c ? c.id : 0;
        console.log("owner:", ownerId || "не найден");
    } catch (e) {
        ownerId = 0;
        console.log("owner unknown:", e.message);
    }
}

async function longPollInit() {
    // как в pinguin (NewLongPollCommunity): группа из токена через groups.getById
    if (!groupId) {
        try {
            const r = await vkApi("groups.getById", {});
            const g = (r.groups && r.groups[0]) || (r.items && r.items[0]);
            if (g && g.id) {
                groupId = g.id;
                console.log("группа из токена:", groupId);
            }
        } catch (e) { /* укажем VK_GROUP_ID по ошибке ниже */ }
    }
    try {
        lp = await vkApi("groups.getLongPollServer", groupId ? { group_id: groupId } : {});
    } catch (e) {
        // ВК требует group_id (токен не привязан однозначно) — групповой токен
        // не позволяет узнать свои группы (groups.get недоступен), поэтому
        // просим указать группу явно
        if (/\bgroup_id\b/.test(e.message) && e.message.includes("100")) {
            throw new Error("задайте VK_GROUP_ID (число из club…, напр. VK_GROUP_ID=241064685)");
        } else throw e;
    }
    console.log("long poll ready", lp.server);
}

// параллельная обработка по чатам: обновление разных peer_id идёт
// одновременно (тяжёлая замена древа в одном чате не останавливает
// остальные), внутри одного чата — строго по порядку (состояние древа,
// gedPending и toggle-логика кнопок опираются на последовательность).
// Синхронные участки БД-мутаций не перемежаются await'ами — гонок
// между чатами нет; узкое место (event loop на sync-SQLite) смягчают
// транзакция и WAL
const peerChains = new Map(); // peerId -> промис последней задачи чата
const byPeer = (peerId, run, trace, urgent = false) => {
    const tail = peerChains.get(peerId) || Promise.resolve();
    const next = (urgent ? Promise.resolve() : tail).then(trace ? async () => {
        const { received, ...fields } = trace;
        const started = performance.now();
        vkTiming('handler_start', { ...fields, queue_ms: elapsedMs(received, started) });
        let status = 'error';
        try {
            await run();
            status = 'ok';
        } finally {
            vkTiming('handler_done', { ...fields, status, ms: elapsedMs(started) });
        }
    } : run);
    peerChains.set(peerId, urgent ? Promise.allSettled([tail, next]) : next.catch(() => {}));
    return next.catch(e => {
        if (!isWorkerCancelled(e)) console.error("handle:", e.message, "\n", (e.stack || "").split("\n").slice(1, 4).join("\n"));
    });
};

// один запрос long poll; обрабатывает пришедшие message_new
async function longPollStep() {
    return reqVk('lib/long-poll').pollStep(lp, {
        init: longPollInit, onUpdate: (upd, trace) => updateRouter.longPoll(upd, groupId, trace),
        timing: LOG_VK_TIMINGS ? vkTiming : undefined, raw: LOG_RAW, logUpdates: process.env.LOG_UPDATES,
    });
}


// большой ответ — одним файлом: «.ged.txt» (роспись древа) либо «.txt» (список
// событий); не выложился — сообщение об ошибке (без кусков). Файл — ответом
// (reply) на то же сообщение, к которому кнопки, а не отдельным
async function sendTailDoc(peerId, text, nameBase, ext = ".ged.txt", convMsgId = 0) {
    const name = fileBaseOf(nameBase || "Продолжение") + ext;
    try {
        // BOM — чтобы Windows-браузер распознал UTF-8 (иначе кракозябры)
        await messagesSend(peerId, "📄 " + name, 0, convMsgId, null,
            await vkUploadDoc(peerId, name, "\uFEFF" + text));
        return;
    } catch (e) {
        console.error("tail doc:", e.message);
        await messagesSend(peerId, "💥 Не удалось выложить файл " + name);
    }
}

// прицеп файла к сообщению с ⏳ (поиск, панель одиночного попадания):
// upload с ретраями vkUploadDoc; ок — правка attachment (+keyboard), затем
// текстовая правка (⏳ снят; вторая правка нужна: messages.edit с
// message+attachment текст не меняет, а без attachment сбрасывает вложения —
// повторяем их); правка не вышла — файл отдельным сообщением (fallbackTxt);
// upload не вышел — в сообщении ⏳ → «✂️💥 <ошибка>»
// (правило метки NOT_FOR_GRAFT — коммент у её определения)
async function holdAttach(peerId, log, sent, holdTxt, finalTxt, name, content,
    kb = null, fallbackTxt = null, msgId = 0, convMsgId = 0) {
    try {
        let att = null;
        const t0 = Date.now();
        try {
            att = await vkUploadDoc(peerId, name, content);
        } catch (e) {
            console.error(log + " doc upload:", e.message);
            try { await vkApi("messages.edit", { peer_id: peerId, message_id: sent,
                ...(kb ? { keyboard: kb } : {}),
                message: holdTxt.replace("\n✂️⏳", "\n✂️💥 " + e.message) }); } catch {}
            return;
        }
        console.log(log + " upload:", name, (Date.now() - t0) + "ms");
        const attach = { peer_id: peerId, message_id: sent, attachment: att };
        if (kb) attach.keyboard = kb;
        try {
            await vkApi("messages.edit", attach);
            try {
                await vkApi("messages.edit", { ...attach, message: finalTxt });
            } catch (e2) {
                console.error(log + " origin text:", e2.message, "— правлю текст без клавиатуры");
                const bare = { ...attach, message: finalTxt }; delete bare.keyboard;
                try { await vkApi("messages.edit", bare); } catch {}
            }
            console.log(log + " doc:", att, "peer", peerId);
        } catch (e) {
            console.error(log + " edit:", e.message, "— отношу файлом");
            try { await vkApi("messages.edit", { peer_id: peerId, message_id: sent,
                ...(kb ? { keyboard: kb } : {}), message: holdTxt.replace("\n✂️⏳", "\n✂️") }); } catch {}
            await messagesSend(peerId, fallbackTxt || finalTxt, msgId, convMsgId, kb, att);
        }
    } catch (e) { console.error(log + " doc:", e.message); }
}

// «Начать» (payload {"command":"start"}) работает как «/»

// дроп .ged-документа: скачать, разобрать и спросить кнопками «Да/Нет»;
// текст файла до ответа держим в памяти (последний дроп выигрывает, живёт час)
const GED_TTL = 3600000;
const gedPending = new Map(); // peerId → {name, text, fromId, ts}

// скачать текст документа-дропа с ретраями: CDN отдаёт файл не сразу
// (наблюдалось HTTP 502), поэтому после дропа ждём 3 с, попытка; провал —
// ещё 3 с и попытка, ещё 3 с и последняя (ТГ-копия: handlers/message.js)
async function fetchDocText(url, ged = false) {
    for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!res.ok) throw new Error("HTTP " + res.status);
            return ged ? decodeGedcom(new Uint8Array(await res.arrayBuffer())) : await res.text();
        } catch (e) {
            if (i === 2) throw e;
            console.warn("doc download retry", (i + 1) + "/3:", e.message);
        }
    }
    return null; // недостижимо
}

async function handleGedDrop(peerId, doc, msgId, convMsgId, fromId) {
    const name = doc.title || "gedcom.ged";
    let text, g;
    try {
        text = await fetchDocText(doc.url, true);
    } catch (e) {
        console.error("ged download:", e.message);
        await messagesSend(peerId, "💥 Не удалось скачать файл " + name + " (трижды; повторите написанием файла в чат)", msgId, convMsgId);
        return;
    }
    try { g = await parseImport(peerId, 'parse_gedcom', text); }
    catch (e) { if (isWorkerCancelled(e)) throw e; console.error('ged parse:', e.message); }
    if (!g) {
        await messagesSend(peerId, "💥 Не удалось разобрать GEDCOM-файл " + name, msgId, convMsgId);
        return;
    }
    const s = gedStats(g);
    gedPending.set(peerId, { name, text, fromId, ts: Date.now() });
    const btn = (label, c) => ({
        action: { type: "callback", label, payload: JSON.stringify({ c }) }, color: "secondary"
    });
    const kb = JSON.stringify({ inline: true, buttons: [[
        btn("Нет", "ged:ign"),
        btn("Да", "ged:rep"),
    ]] });
    await messagesSend(peerId, "🧬 Файл " + name + ": персон " + s.persons + ", семей " + s.fams
        + ", детей " + s.links + ". Заменить события чата деревом?", msgId, convMsgId, kb);
}

// дроп .txt-документа с родословной росписью -+=: в ответе на триггер —
// применить сразу (ветвь цитируемого срезана, роспись привита);
// просто дроп — «Да/Нет» с автоматическим резервом, как у .ged (ТГ: txtDrop)
async function handleTxtDrop(peerId, doc, msgId, convMsgId, fromId, replyMsg) {
    const resolved = resolveReply(peerId, replyMsg);
    if (replyMsg && !resolved) {
        await messagesSend(peerId, REPLY_TARGET_ERROR, msgId, convMsgId);
        return;
    }
    const name = doc.title || "пачка.ged.txt";
    let text;
    try {
        text = await fetchDocText(doc.url);
    } catch (e) {
        console.error("txt download:", e.message);
        await messagesSend(peerId, "💥 Не удалось скачать файл " + name + " (трижды; повторите написанием файла в чат)", msgId, convMsgId);
        return;
    }
    let tree;
    try { tree = await parseImport(peerId, 'parse_flat', text); }
    catch (e) {
        if (isWorkerCancelled(e)) throw e;
        console.error('flat parse:', e.message);
        await messagesSend(peerId, '💥 Не удалось разобрать роспись. Попробуйте ещё раз.', msgId, convMsgId);
        return;
    }
    if (replyMsg && resolveReply(peerId, replyMsg)?.xref !== resolved?.xref) {
        await messagesSend(peerId, REPLY_TARGET_ERROR, msgId, convMsgId);
        return;
    }
    if (!tree.persons.length && !tree.errors.length) {
        await messagesSend(peerId, "💥 Не удалось разобрать файл " + name + " (ждём пачку «плоское древо»)", msgId, convMsgId);
        return;
    }
    if (resolved) {
        // в ответе на триггер — резка-прививка: цитируемый — герой росписи
        let anchor = null;
        const sh = resolved;
        if (sh) anchor = sh.n + " " + sh.d;
        if (!anchor) {
            // цитата на триггера не нашлась — добавлять молча нельзя: так
            // роспись применилась бы целиком (мимо героя)
            await messagesSend(peerId, "💥 В ответе — не триггер: пачка не применена. Герой ветви должен быть «Имя ГГГГ-ММ-ДД» из древа чата.", msgId, convMsgId);
            console.log("txt drop reply: триггера нет, мимо, peer", peerId);
            return;
        }
        const rep = cutAndGraft(peerId, anchor, tree, getSettings(peerId).trim);
        for (const part of splitText(treeReport(rep))) await messagesSend(peerId, part, msgId, convMsgId);
        console.log("txt tree:", rep.cut !== undefined ? "срезано " + rep.cut + ", " : "", rep.persons, "персон,", rep.links, "детей, peer", peerId);
        return;
    }
    gedPending.set(peerId, { name, text, fromId, ts: Date.now() });
    const btn = (label, c) => ({
        action: { type: "callback", label, payload: JSON.stringify({ c }) }, color: "secondary"
    });
    const kb = JSON.stringify({ inline: true, buttons: [[
        btn("Нет", "ged:ign"),
        btn("Да", "ged:rep"),
    ]] });
    await messagesSend(peerId, "📄 Файл " + name + ": персон " + new Set(tree.persons
        .map(p => p.rec.n + "|" + (p.rec.d ?? ""))).size
        + ", семей " + tree.weddings.length + ", детей " + tree.children.length
        + ". Заменить тем древо чата? В ответ на триггер — без замены: будет срезана и привита ветвь триггера.",
        msgId, convMsgId, kb);
}

// ---- фокус-сообщение: «/» ответом на триггер, радиус родни 1–5 ----

// подпись радиуса в тостах фокус-кнопок (цифры и 🧬) и в чарте у героя:
const focusLabel = rangeLevel;
// dd — дата смерти/развода, если есть; радиус — цифрой перед ключом
const focusHead = (key, radius, dd) => String(radius) + " " + key + (dd ? " " + dd : "");

// A process-local capability binds every button to the message VK actually sent.
// Entry eviction/restart fails closed; tree replacement and person removal revoke it.
const datelessPanels = new Map();

function invalidateDatelessPanels(peerId, xref) {
    for (const [id, panel] of datelessPanels) {
        if (panel.peerId !== peerId || (xref !== undefined && panel.xref !== xref)) continue;
        datelessPanels.delete(id);
        if (panel.cmid) cancelDnaExport(peerId, panel.cmid);
    }
}

function datelessPanel(peerId, cmid, id) {
    const panel = datelessPanels.get(id);
    if (!panel || !cmid || panel.peerId !== peerId || panel.cmid !== cmid) return null;
    const row = indiOf(peerId, panel.xref);
    return row?.birt_d === null && row.name === panel.name ? panel : null;
}

function datelessView(peerId, panel, requested = panel.radius) {
    const data = exportData(peerId);
    const scope = createFlatAnnotationScope(data.flatRows(), data.pairsOf(), data.spousesOf());
    const depth = scope.depthOf(panel.xref);
    const radius = normalizeFocusRadius(requested, depth);
    const mk = (label, a, r) => ({ action: { type: 'callback', label,
        payload: JSON.stringify({ c: 'dateless', id: panel.id, a, r }) }, color: 'secondary' });
    const digits = [1, 2, 3, 4, 5].filter(n => n !== radius && n <= depth).map(n => mk(String(n), 'radius', n));
    const head = NOT_FOR_GRAFT + '\n' + panel.line + (radius === 1 ? '' : '\n' + focusLabel(radius));
    const kb = JSON.stringify({ inline: true, buttons: [
        [...digits, mk('👎', 'delete')],
        [mk('🔔', 'bell'), mk('🧬', 'tree'), mk('-+=', 'branch'), mk('❌', 'close')],
    ] });
    return { radius, head, kb, scope };
}

async function sendExactSearchResult(peerId, hit, line, msgId, convMsgId, fromId) {
    const rec = indiOf(peerId, hit.key);
    if (!rec || rec.name !== hit.name || (rec.birt_d ?? null) !== (hit.d ?? null)
        || (rec.birt_abt || 0) !== (hit.abt || 0)) return false;
    if (rec.birt_d != null) {
        await sendJubileeMsg(peerId, personFromRow(rec), '', msgId, convMsgId, fromId);
        return true;
    }
    if (!line) return false;
    const id = require('node:crypto').randomUUID();
    const panel = { id, peerId, xref: rec.xref, name: rec.name, line: line.length > 3000 ? line.slice(0, 2999) + '…' : line, radius: 1 };
    const { head, kb } = datelessView(peerId, panel);
    if (datelessPanels.size >= 2048) datelessPanels.delete(datelessPanels.keys().next().value);
    datelessPanels.set(id, panel);
    try {
        const items = await messagesSend(peerId, head, msgId, convMsgId, kb, undefined, true);
        const sent = items?.[0];
        if (sent?.peer_id !== peerId || !(sent.conversation_message_id > 0) || sent.error) {
            datelessPanels.delete(id);
            console.error('dateless panel: VK did not confirm conversation_message_id', peerId);
        } else panel.cmid = sent.conversation_message_id;
    } catch (e) {
        datelessPanels.delete(id);
        throw e;
    }
    return true;
}

function closeDatelessPanel(panel) {
    datelessPanels.delete(panel.id);
}

// клавиатура фокуса: как «/»-ответ по роли, но 🔔/🧬 действуют в радиусе,
// а в ряд с ❌ добавлены неактивные цифры радиуса (активная скрыта;
// цифра r выводится, если есть предки глубины r — глубина depth = focusDepth)
async function focusKeyboard(peerId, userId, key, radius, depth) {
    const mk = (label, payload) => ({
        action: { type: "callback", label, payload: JSON.stringify(payload) },
        color: "secondary"
    });
    const bell = mk("🔔", { c: "foc:bell", k: key, r: radius });
    const tree = mk("🧬", { c: "foc:tree", k: key, r: radius });
    const flat = mk("-+=", { c: "foc:flat", k: key, r: radius });
    const digits = [1, 2, 3, 4, 5]
        .filter(n => n !== radius && n <= (depth === undefined ? 5 : depth))
        .map(n => mk(String(n), { c: "foc", k: key, r: n }));
    // 🗑-радиус снят: удаление — только глобальное (кнопка 🗑 у 🔔 чата)
    // единая раскладка с юбилеем (jubileeKeyboard): ряд 1 [цифры 👎],
    // ряд 2 [👀 🔔 🧬 -+= ❌] — новые кнопки не отпадают после тапа по
    // 🔔/🧬/-+=/цифре на сообщении-юбилее
    return JSON.stringify({ inline: true, buttons: [
        [...digits, mk("👎", { c: "del1", k: key })],
        [mk("👀", { c: "det", k: key }), bell, tree, flat, mk("❌", { c: "close" })],
    ] });
}

// клавиатура сообщения-юбилея (ответ на триггер, поиск одного попадания,
// развёрнутое 👀): ряд 1 — цифры радиуса (по глубине, радиус 1 скрыт) + 👎
// (удалить событие, как реакция 👎); ряд 2 — 👀/🌙 (тоггл детальности),
// 🔔/🧬/-+= в радиусе 1 и ❌ (payload-и stateless, как у фокуса);
// detail=true — сообщение развёрнуто, кнопка 🌙 сворачивает обратно.
// Раскладка единая с ТГ (jubileeMarkup): ряд 1 [2 3 4 5 👎], ряд 2 [👀 🔔 🧬 -+= ❌];
// у свадьбы (wed, «Имя+Имя») цифры/🔔/🧬/-+= бессмысленны (пара-заглушка) —
// один ряд [👀|🌙 👎 ❌]
async function jubileeKeyboard(peerId, userId, key, depth, detail = false, wed = false) {
    const mk = (label, payload) => ({
        action: { type: "callback", label, payload: JSON.stringify(payload) },
        color: "secondary"
    });
    if (wed) return JSON.stringify({ inline: true, buttons: [[
        mk(detail ? "🌙" : "👀", { c: detail ? "mon" : "det", k: key }),
        mk("👎", { c: "del1", k: key }), mk("❌", { c: "close" }),
    ]] });
    const digits = [2, 3, 4, 5]
        .filter(n => n <= (depth === undefined ? 5 : depth))
        .map(n => mk(String(n), { c: "foc", k: key, r: n }));
    return JSON.stringify({ inline: true, buttons: [
        [...digits, mk("👎", { c: "del1", k: key })],
        [mk(detail ? "🌙" : "👀", { c: detail ? "mon" : "det", k: key }),
            mk("🔔", { c: "foc:bell", k: key, r: 1 }),
            mk("🧬", { c: "foc:tree", k: key, r: 1 }),
            mk("-+=", { c: "foc:flat", k: key, r: 1 }),
            mk("❌", { c: "close" })],
    ] });
}

// список событий по множеству фокуса (focusListText) — канон tgcloud/lib/tree.cjs
// (с A3): формат строки и сортировки (полная дата / круговая «от сегодня»)
// общие с ТГ; копий больше нет.

// супруги персон чата: fam с двумя датированными родителями — пары точные
// (по xref); интерактивные свадьбы-заглушки без персон сюда не попадают —
// привязываются confirmPair'ом (раньше «по первому имени» и тёзки ловили
// чужие свадьбы)
function focusSpousePairs(peerId) {
    return famList(peerId).filter(f => f.parents.length === 2).map(f => f.parents);
}

// текст фокуса: заголовок (с датой смерти dd) + (bell ? список : гедком-фрагмент)
function focusText(peerId, key, radius, dd, byFull = false, indicator) {
    const { mo, d: dToday } = mskNowParts();
    const mmdd = String(mo).padStart(2, "0") + "-" + String(dToday).padStart(2, "0");
    return computeExport(peerId, 'bell', { heroKey: key, radius, head: focusHead(key, radius, dd) },
        { weddings: weddingRows(peerId), mmdd, byFull }, indicator);
}

async function sendFocus(peerId, key, msgId, convMsgId, fromId, dd) {
    const txt = focusHead(key, 1, dd); // тело (список/гедком) — после тапа по кнопке
    const depth = focusDepth(linkPairs(peerId), focusSpousePairs(peerId), key);
    const kb = await focusKeyboard(peerId, fromId, key, 1, depth);
    await messagesSend(peerId, txt, msgId, convMsgId, kb);
    console.log("focus:", key, "peer", peerId);
}

// сжатый юбилей + клавиатура-юбилей (единая с ТГ jubileeMarkup): триггер,
// правка триггером, поиск одного попадания
async function sendJubileeMsg(peerId, rec, note, msgId, convMsgId, fromId = 0) {
    const key = rec.n + " " + rec.d;
    const depth = focusDepth(linkPairs(peerId), focusSpousePairs(peerId), key);
    await messagesSend(peerId, jubileeText(rec, note), msgId, convMsgId,
        await jubileeKeyboard(peerId, fromId, key, depth, false, rec.n.includes("+")));
    console.log("jubilee:", key, "peer", peerId);
}

async function sendChatFlatArtifacts(peerId, pack, target, keyboard, log = "flat") {
    const edit = { peer_id: peerId, ...target,
        ...(keyboard ? { keyboard } : {}) };
    try {
        const artifacts = chatFlatArtifacts(pack);
        const att = await vkUploadDoc(peerId, artifacts.txt.name, artifacts.txt.content);
        let csv = "";
        try {
            const file = artifacts.csv();
            csv = await vkUploadDoc(peerId, file.name, file.content);
        } catch (e) { console.error(log + " csv upload:", e.message); }
        const ready = { ...edit, attachment: csv ? att + "," + csv : att, message: "-+=" };
        try {
            await vkApi("messages.edit", ready);
            console.log(log + " doc:", ready.attachment, "peer", peerId);
        } catch (e) {
            console.error(log + " edit:", e.message, "— повторяю");
            try { await vkApi("messages.edit", ready); } catch {}
        }
    } catch (e) {
        console.error(log + " doc upload:", e.message);
        try { await vkApi("messages.edit", { ...edit,
            message: "💥 Не удалось выложить файл «Древо чата.ged.txt»" }); } catch {}
    }
}

// ответ на «/» или «Начать»: справка + клавиатура по чату/роли;
// replyMsg — msg.reply_message (ответ триггером на триггер = связь)
function resolveReply(peerId, reply) {
    if (!reply || !Number.isInteger(reply.from_id) || reply.from_id === 0
        || (reply.peer_id != null && reply.peer_id !== peerId)) return null;
    const bot = reply.from_id < 0;
    if (bot && reply.from_id !== -groupId) return null;
    return resolveReplyRecord([...personRows(peerId), ...weddingRows(peerId)], reply.text, bot);
}


// резерв прежнего дерева чата файлом <имя>-old.ged (фолбэк — текстом);
// true — выложен (или чат пуст), false — не смогли (замена отменяется)
async function sendTreeBackup(peerId) {
    if (!q1("SELECT xref FROM indi WHERE chat=? LIMIT 1", peerId)) return true;
    let g;
    try { g = await computeExport(peerId, 'gedcom'); }
    catch (e) { if (isWorkerCancelled(e)) throw e; console.error('backup prepare:', e.message); return false; }
    const base = fileBaseOf("Гедком-древо чата");
    try {
        await messagesSend(peerId, "🧬 Резерв прежнего дерева", 0, 0, null,
            await vkUploadDoc(peerId, base + "-old.ged", g));
        return true;
    } catch (e) {
        console.error("backup upload:", e.message);
    }
    try {
        const parts = splitText("🧬 Резерв прежнего дерева (текстом):\n" + g);
        for (const p of parts) await messagesSend(peerId, p);
        return true;
    } catch (e) {
        console.error("backup text:", e.message);
        return false;
    }
}

// замена дерева чата гедкомом; backup=true — сначала выложить прежнее
// дерево файлом (не смогли — замена отменяется, старые данные целы).
// Возвращает {ok, head} для ответа в чат; древо всегда очищается и заливается
async function replaceWithGedcom(peerId, g, backup) {
    if (backup && !(await sendTreeBackup(peerId)))
        return { ok: false, head: "💥 Не удалось выложить резерв — замена отменена, прежнее дерево цело" };
    // одна транзакция: без неё каждый INSERT — свой коммит на диск, большое
    // древо (тысячи персон) пишется минутами
    const started = LOG_VK_TIMINGS && performance.now();
    let status = 'error';
    sq().exec("BEGIN");
    try {
        const r = importGedcom(peerId, g);
        sq().exec("COMMIT");
        status = 'ok';
        return { ok: true, head: treeReport(r) };
    } catch (e) {
        sq().exec("ROLLBACK");
        throw e;
    } finally {
        if (LOG_VK_TIMINGS) vkTiming('import_transaction', { peer: peerId, status, ms: elapsedMs(started) });
    }
}

// payload — JSON-объект (после перехода на POST ВК отдаёт его объектом)
// или JSON/plain строка (легаси)
function unpay(p) {
    if (p && typeof p === "object") return p;
    try {
        const v = JSON.parse(p);
        if (typeof v === "string" || typeof v === "object") return v;
    } catch (e) { /* plain */ }
    return String(p);
}

// «Имя ГГГГ-ММ-ДД[ ГГГГ-ММ-ДД смерти][ ЧЧ:ММ]»; "" — событий нет.
// формат, фильтр примерных и порядок (круговой «от сегодня» / по полной
// дате) — канон eventListText из tgcloud/lib/tree.cjs (с A3, общий с ТГ);
// здесь только выборка БД
function upcomingEvents(peerId, byFullDate = false, mmddNow = "") {
    return eventListText([...personRows(peerId), ...weddingRows(peerId)], byFullDate, mmddNow);
}

// клавиатура «/»-ответа по чату и роли пользователя
async function peerKeyboard(peerId, userId) {
    if (peerId < 2000000000) return relKeyboard(peerId);
    return (await isChatAdmin(peerId, userId)) ? ownerKeyboard() : bellKeyboard();
}

// текст сообщения по cmid беседы; null если недоступен
async function cmidText(peerId, cmid) {
    try {
        const res = await vkApi("messages.getByConversationMessageId", {
            peer_id: peerId, conversation_message_ids: cmid
        });
        return res.items?.[0]?.text ?? null;
    } catch (e) {
        return null;
    }
}

// разбить текст на куски < 4000 символов по границам строк
function splitText(text) {
    if (text.length < 4000) return [text];
    const parts = [];
    for (let line of text.split("\n")) {
        const last = parts[parts.length - 1];
        if (last !== undefined && last.length + line.length + 1 < 4000) parts[parts.length - 1] += "\n" + line;
        else parts.push(line);
    }
    return parts;
}

// ответ на кнопку — правка исходного «/»-сообщения, при ошибке — новое сообщение
async function editOrigin(o, text, kb) {
    try {
        await vkApi("messages.edit", {
            peer_id: o.peer_id, conversation_message_id: o.conversation_message_id,
            message: text, keyboard: kb
        });
    } catch (e) {
        console.error("editOrigin:", e.message, "— отправляю сообщением");
        await messagesSend(o.peer_id, text, 0, 0, kb);
    }
}

// правка исходного сообщения с вложением-файлом (текст не меняется):
// большой список событий/роспись уезжает документом в то же сообщение
async function editOriginDoc(o, name, content, kb) {
    try {
        const att = await vkUploadDoc(o.peer_id, name, content);
        await vkApi("messages.edit", {
            peer_id: o.peer_id, conversation_message_id: o.conversation_message_id,
            attachment: att, keyboard: kb
        });
        console.log("editOriginDoc: вложение", att, "в сообщение д~" + o.conversation_message_id, "peer", o.peer_id);
    } catch (e) {
        console.error("editOriginDoc:", e.message, "— отношу файлом");
        const ext = /\.ged\.txt$/.test(name) ? ".ged.txt" : (/\.txt$/.test(name) ? ".txt" : "");
        await sendTailDoc(o.peer_id, content.replace(/^\uFEFF/, ""), name.replace(/(\.ged)?\.txt$/, ""), ext, o.conversation_message_id);
    }
}


// реакции на ответы/уведомления бота; формат события (по факту):
// { reacted_id, peer_id, cmid, reaction_id } — 👎 = 9, 👀 = REACTION_EYES_ID

// найти запись по тексту ответа бота (заголовок «Имя ГГГГ-ММ-ДД»)
async function findRecordByCmid(peerId, cmid) {
    let text = "";
    try {
        const res = await vkApi("messages.getByConversationMessageId", {
            peer_id: peerId, conversation_message_ids: cmid
        });
        text = res.items?.[0]?.text || "";
    } catch (e) {
        console.error("reaction lookup:", e.message);
        return null;
    }
    // показанный текст несёт новый стиль/суффикс (см. recordShownOf); `_` в
    // датах шапки — маркер нового стиля (см. jubileeText) — нормализуем;
    // фокус-сообщение печатает цифру радиуса перед ключом («2 Имя Д») —
    // если без неё не нашлось, пробуем срезав (как replyHeadOf; прямой порядок
    // не ломает имена вида «8 Марта»)
    const RX = /^(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/;
    const m0 = text.match(RX);
    if (m0) {
        const r = recordShownOf(peerId, m0[1].trim() + " " + m0[2]);
        if (r) return r;
    }
    const m1 = text.match(/^\d\s+(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/);
    if (!m1) return null;
    return recordShownOf(peerId, m1[1].trim() + " " + m1[2]) || null;
}

// ============================== ПЛАНИРОВЩИК ==============================
// Ежедневно в 09:00 МСК: события с сегодняшней датой (МСК) получают список
// раз в год (sent.last_year — переживает замену дерева). Проверка досылаема
// в тот же день: checkedDate пишется только в конце полного успеха, поэтому
// падение отправки/рестарт не теряет день — повторный запуск повторит
// несостоявшее (юбилеи защищает sent-дедуп с откатом, дайджест —
// digest:<peer> в meta, пишется после успешной отправки).

function mskNowParts() {
    if (replDate) return { y: replDate[0], mo: replDate[1], d: replDate[2], h: replHour ?? 9, min: 0 };
    const t = new Date(Date.now() + TZ_MS);
    return {
        y: t.getUTCFullYear(),
        mo: t.getUTCMonth() + 1,
        d: t.getUTCDate(),
        h: t.getUTCHours(),
        min: t.getUTCMinutes()
    };
}

function msUntilNext9() {
    const n = mskNowParts();
    let wait = 9 * 3600000 - (n.h * 3600000 + n.min * 60000);
    if (wait <= 0) wait += 24 * 3600000;
    return wait;
}

async function dailyCheck() {
    const n = mskNowParts();
    const today = n.y + "-" + String(n.mo).padStart(2, "0") + "-" + String(n.d).padStart(2, "0");
    const mmdd = String(n.mo).padStart(2, "0") + "-" + String(n.d).padStart(2, "0");
    // checkedDate — «день полностью отработал»: пишем в конце; в начале только
    // дешёвый пропуск уже успешного дня. Падение в середине оставляет день
    // досылаемым при рестарте/следующем запуске в тот же день.
    if ((q1("SELECT v FROM meta WHERE k='checkedDate'") || {}).v === today) return;
    // годовщины персон и свадеб с сегодняшней датой (МСК); sent — раз в год.
    // Даты до 1918 хранятся по старому стилю — оповещаем по новому (новый
    // ММ-ДД сдвинутой даты; декабрьский хвост ложится на январь сам собой)
    const jobs = [
        ...qa(`SELECT chat, name, birt_d, birt_h, birt_m, deat_d, deat_abt FROM indi
            WHERE birt_d IS NOT NULL AND (birt_abt IS NULL OR birt_abt=0)`)
            .filter(r => newStyleDate(r.birt_d).slice(5, 10) === mmdd)
            .map(r => ({
                chat: r.chat, key: r.name + " " + r.birt_d,
                rec: { n: r.name, d: r.birt_d, ...(r.birt_h !== null ? { h: r.birt_h, m: r.birt_m } : {}), ...(r.deat_d ? { dd: r.deat_d, dabt: r.deat_abt || 0 } : {}) },
            })),
        ...qa(`SELECT f.chat, (SELECT name FROM indi i WHERE i.chat=f.chat AND i.xref=f.husb) AS hn,
            (SELECT name FROM indi i WHERE i.chat=f.chat AND i.xref=f.wife) AS wn,
            f.marr_d, f.div_d, f.div_abt FROM fam f WHERE f.marr_d IS NOT NULL AND (f.marr_abt IS NULL OR f.marr_abt=0)`)
            .filter(r => newStyleDate(r.marr_d).slice(5, 10) === mmdd)
            .filter(r => r.hn && r.wn)
            .map(r => ({
                chat: r.chat, key: r.hn + "+" + r.wn + " " + r.marr_d,
                rec: { n: r.hn + "+" + r.wn, d: r.marr_d, ...(r.div_d ? { dd: r.div_d, dabt: r.div_abt || 0 } : {}) },
            })),
    ];
    for (const j of jobs) {
        if (!getSettings(j.chat).bell) continue;
        const s = q1("SELECT last_year FROM sent WHERE chat=? AND key=?", j.chat, j.key);
        if (s && s.last_year >= n.y) continue;
        qr("INSERT OR REPLACE INTO sent(chat,key,last_year) VALUES(?,?,?)", j.chat, j.key, n.y); // до отправки — не задвоить
        try {
            await messagesSend(j.chat, jubileeText(j.rec, ""));
            console.log("annual:", j.rec.n, j.rec.d, "peer", j.chat);
        } catch (e) {
            qr("INSERT OR REPLACE INTO sent(chat,key,last_year) VALUES(?,?,?)", j.chat, j.key, s ? s.last_year : 0); // откат
            console.error("annual send failed:", e.message);
        }
    }
    // религиозный дайджест: чатам с включёнными религиями, только если есть дни
    const peers = [...new Set([
        ...qa("SELECT chat AS c FROM settings").map(r => r.c),
        ...qa("SELECT DISTINCT chat AS c FROM indi").map(r => r.c),
    ])];
    for (const peer of peers) {
        const settings = getSettings(peer);
        if (!REL_ORDER.some(k => settings[k])) continue;
        const digest = religiousDigest(settings);
        if (!digest) continue;
        // суточный дедуп дайджеста per-peer: пишется после успешной отправки,
        // неуспешная — без записи, ретрай при следующем запуске в тот же день
        if ((q1("SELECT v FROM meta WHERE k=?", "digest:" + peer) || {}).v === today) continue;
        try {
            await messagesSend(peer, digest);
            qr("INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)", "digest:" + peer, today);
            console.log("digest:", peer);
        } catch (e) {
            console.error("digest send failed:", e.message);
        }
    }
    qr("INSERT OR REPLACE INTO meta(k,v) VALUES('checkedDate',?)", today);
}

function scheduleDaily() {
    setTimeout(async () => {
        try { await dailyCheck(); } catch (e) { console.error("daily:", e.message); }
        scheduleDaily();
    }, msUntilNext9());
}

// ============================== TEST / MAIN ==============================

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === "probe") {
        // диагностика: диалоги, отправка теста, сырой long poll 2 варианта
        let noGroupOk = false;
        try {
            const r = await vkApi("groups.getLongPollServer", {});
            noGroupOk = true;
            console.log("без group_id сервер получен:", r.server);
        } catch (e) {
            console.log("без group_id:", e.message);
        }
        try {
            lp = await vkApi("groups.getLongPollServer", groupId ? { group_id: groupId } : {});
        } catch (e) {
            console.log("getLongPollServer:", e.message);
            lp = null;
        }
        try {
            const conv = await vkApi("messages.getConversations", { count: 5, extended: 0 });
            const items = conv.items || [];
            console.log("диалогов:", conv.count, items.map(i =>
                (i.conversation.peer && (i.conversation.peer.type + ":" + i.conversation.peer.id)) + " " +
                (i.last_message && JSON.stringify(i.last_message.text).slice(0, 40))).join("\n  "));
            const peer = items[0]?.conversation?.peer?.id;
            if (peer) {
                const s = await vkApi("messages.send", { peer_id: peer, message: "probe " + new Date().toISOString(), random_id: Date.now() % 2147483647 });
                console.log("messages.send в peer", peer, "→", JSON.stringify(s));
            }
        } catch (e) {
            console.log("сообщения:", e.message);
        }
        if (!lp) return;
        // по очереди: как vksdk и как новые клиенты (version=3)
        const variants = [["как vksdk", ""], ["version=3", "&version=3"]];
        let ts = lp.ts, vi = 0;
        const until = Date.now() + 120000;
        let t0 = 0;
        while (Date.now() < until) {
            const [label, extra] = variants[vi % variants.length];
            // каждый вариант ~60 c, затем смена
            if (Date.now() - (t0 || Date.now()) > 60000 && t0) { vi++; t0 = 0; }
            if (!t0) t0 = Date.now();
            const u = new URL(lp.server + "?act=a_check&key=" + encodeURIComponent(lp.key) +
                "&ts=" + encodeURIComponent(ts) + "&wait=10" + extra);
            let b;
            try {
                b = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json();
            } catch (e) {
                console.log(label, "poll error:", e.message);
                continue;
            }
            console.log("[" + label + "] poll:", JSON.stringify(b).slice(0, 600));
            if (b.ts) ts = b.ts;
            if (b.failed) { console.log("failed", b.failed); if (b.ts) ts = b.ts; }
        }
        return;
    }
    if (args[0] === "test") {
        const arg = args[1] || "";
        if (arg === "rel") {
            const all = {};
            for (const k of REL_ORDER) all[k] = true;
            console.log(religiousDigest(all) || "сегодня религиозных дней нет");
            return;
        }
        if (arg.startsWith("rel:")) {
            const key = arg.slice(4);
            if (!REL_DEFS[key]) { console.log("религии нет:", key); process.exit(1); }
            console.log(REL_DEFS[key].icon + " " + REL_DEFS[key].name + " дни\n" + religiousYear(key));
            return;
        }
        const input = args.slice(1).join(" ") || "Костя 1963-09-27";
        // родословная роспись -+=: маркеры '-'/'=', «+дата»/«+» в начале строк → applyTree
        if (input.split(/\r?\n/).some(l => /^[-+=]/.test(l.trim()))) {
            const tree = parseTree(input);
            const rep = applyTree(0, tree);
            console.log("✅ древо: добавлено " + rep.persons + " персон, " + rep.fams + " семей, " + rep.links + " детей");
            for (const e of rep.errors) console.log("💥 стр " + e.line + ": " + e.msg);
            for (const f of famList(0)) console.log(JSON.stringify(f));
            process.exit(0);
        }
        for (const line of input.split(/\s*\n+\s*/).filter(Boolean)) {
            const parsed = parseTrigger(line);
            if (!parsed) { console.log(line, "— не похоже на триггер"); continue; }
            if (parsed.error) { console.log("💥 " + parsed.error); continue; }
            console.log("событие (МСК):", JSON.stringify(parsed.rec));
            if (parsed.note) console.log("примечание:", parsed.note);
            console.log("---");
            console.log(jubileeText(parsed.rec, parsed.note));
        }
        return;
    }
    if (!token) {
        console.error("нет токена: задайте VK_TOKEN (env или .env рядом с lunarreturns.js)");
        process.exit(1);
    }
    if (LOG_VK_TIMINGS) watchVkLoop();
    sq(); // открыть/создать базу
    await longPollInit();
    await initOwner();
    // догнать сообщения, накопившиеся за простой (как catchUp в pinguin)
    const startAt = Math.floor(Date.now() / 1000);
    const lastSeen = Number((q1("SELECT v FROM meta WHERE k='lastSeen'") || {}).v || 0);
    if (!lastSeen) {
        qr("INSERT OR REPLACE INTO meta(k,v) VALUES('lastSeen',?)", String(startAt));
    } else {
        try { await catchUp(startAt); } catch (e) { console.error("catchUp:", e.message); }
    }
    // стартовая суточная проверка: только если сейчас 09:00 МСК или позже
    // (иначе сообщение уйдёт сразу после полуночи). Проверка досылаема в тот
    // же день: проверка встала/упала до 09:00 — догонит после подъёма,
    // падение в середине — повторный запуск повторит несостоявшее (дедупы
    // sent и digest:<peer> не дадут задвоить); между 00:00 и 09:00 ждём
    // scheduleDaily до 09:00.
    if (mskNowParts().h >= 9) {
        try { await dailyCheck(); } catch (e) { console.error("daily:", e.message); }
    }
    scheduleDaily();
    let errors = 0;
    for (;;) {
        try {
            await longPollStep();
            errors = 0;
        } catch (e) {
            console.error("long poll:", e.message);
            if (++errors >= 10) {
                await longPollInit();
                errors = 0;
            }
            await sleep(5000);
        }
    }
}

const { createUpdateRouter } = reqVk('updates');
const updateRouter = createUpdateRouter({
    GED_TTL, answerEvent, applyTree, bellKeyboard,
    clearChatTree, cmidText, cutAndGraft, deleteByCmid, deleteEventCascade, editOrigin,
    editOriginDoc, editTrigger, findRecordByCmid, focusHead, focusLabel, focusKeyboard,
    focusSpousePairs, focusText, gedPending, getSettings, handleGedDrop, handleTxtDrop, hasTree,
    holdAttach, isChatAdmin, jubileeKeyboard, jubileeText, linkPairs, markSeen, messagesSend,
    mskNowParts, ownerKeyboard, peerKeyboard, personRows, pkey, recordOf, relKeyboard,
    replaceWithGedcom, resolveReply, sendChatFlatArtifacts, sendFocus, sendGedcom,
    sendJubileeMsg, sendPdf, sendTailDoc, sendTreeBackup, sendViewer, setChatSetting, splitText,
    unpay, upcomingEvents, upsertPerson, vkApi, vkUploadDoc, weddingRows,
    exportFocused, exportWhole, cancelDnaExport, computeExport, parseImport,
    hasDnaExport: (peer, cmid) => activeDnaExports.has(peer + ':' + cmid),
    cancelWorkerIndicator, isWorkerCancelled,
    datelessPanel, datelessView, closeDatelessPanel, deleteDatelessPerson, sendExactSearchResult,
    withWorkerUpdate: (peerId, run) => workerUpdates.run({ peerId }, run),
    get groupId() { return groupId; }, get ownerId() { return ownerId; },
}, byPeer);

if (require.main === module) {
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
        closeExportPool();
        process.exit(0);
    });
    main().catch(e => { closeExportPool(); console.error("fatal:", e); process.exit(1); });
}

// Offline CLI shares the bot adapters, but must never open a persistent store.
module.exports.convertGenealogy = function (mode, text) {
    if (DB_FILE !== ":memory:") throw new Error("Offline conversion requires LR_DB=:memory:");
    try {
        if (mode === "ged2txt") {
            const ged = parseGedcom(text);
            if (!ged) throw new Error("Invalid GEDCOM: expected HEAD and GEDC/INDI/FAM records");
            const { birthOrderErrors } = importGedcom(0, ged);
            const output = chatFlatText(0);
            if (!output) throw new Error("GEDCOM contains no exportable persons");
            const warnings = birthOrderReport(birthOrderErrors);
            if (warnings) console.error(warnings);
            return output;
        }
        if (mode !== "txt2ged") throw new Error("Unknown conversion mode");
        const tree = parseTree(text);
        if (!tree.persons.length || tree.errors.length) {
            throw new Error(tree.errors.map(e => "line " + e.line + ": " + e.msg).join("; ") || "TXT contains no persons");
        }
        const rep = applyTree(0, tree);
        if (rep.errors.length) throw new Error(rep.errors.map(e => "line " + e.line + ": " + e.msg).join("; "));
        return gedcomText(0);
    } finally {
        closeStore();
    }
};

module.exports.__test = {
    HELP,
    parseTrigger, parseGedcom, gedStats, parseTree, parseTreeLine, applyTree, treeReport,
    focusGraphKeys, focusKeys, focusHasPair, focusWithSpouses, focusListKeys, focusLabel, focusHead,
    focusListText, kinLabel, focusDepth, addLink, pairRecords, confirmPair, linkPairs,
    personRows, weddingRows, famList, famView, focusSpousePairs, upsertPerson, deleteEventCascade,
    clearChatTree, recordOf, recordAnyOf, chartPdf, chartModel, chartFor, fileBaseOf, b64ToBytes, parseTtf,
    gedcomText, importGedcom, jubileeText, setLinkCand, weddingByFx, upsertWedding, linkRowOf,
    chatFlatText, flatTreeText, branchFlatText, subsetBranch, flatRows, flatSearch,
    flatHitPerson, flatHitKey, packToCsv,
    cutAndGraft, setPersonByXref, editTrigger, rootOf, uniqueKeyOf, upcomingEvents, hasTree,
    recordShownOf, newStyleDate, oldStyleDate,
    dispatch: updateRouter.direct, q1, qa, qr, dailyCheck, messagesSend, sendGedArtifacts,
    getSettings, resolveReply, closeExportPool, vkUploadDoc,
    setWorkerTestOptions(options) { workerTestOptions = options; },
    setReplDate(parts, hour) { replDate = parts; replHour = hour; },
};
