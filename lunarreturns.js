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

// ============================== KINSHIP (общий модуль) ==============================
// Канон ярлыков родства — tgcloud/lib/kinship.cjs: его же импортирует ТГ-копия
// через ESM-шим tgcloud/lib/kinship.js; правки — только в .cjs, дословных
// копий больше нет.
const { fynny, kinLabel } = reqLib("kinship");

// ============================== ФОКУС-РОДНЯ (общий модуль) ==============================
// Канон — tgcloud/lib/tree.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
const {
    familyXref, focusDepth, focusKeys, focusGraphKeys, focusHasPair, focusWithSpouses, focusListKeys, famsByGenerations,
    focusListText, eventListText} = reqLib("tree");


// ============================== ГЕДКОМ → PDF (общий модуль) ==============================
// Канон — tgcloud/lib/chart.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
const {
    CHART_MAX, b64ToBytes, parseTtf, chartModel, fileBaseOf, chartPdf, chartRows, chartFont, rangeLevel} = reqLib("chart");


// ============================== ПАРСИНГ (общий модуль) ==============================
// Канон — tgcloud/lib/parse.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
const {
    parseTrigger, parseGedcom, gedText, gedStats, gedFictiveDates, parseTreeLine, NOT_FOR_GRAFT, withGraftMark, parseTree, packToCsv, chatFlatArtifacts} = reqLib("parse");


// ============================== РЕЛИГИОЗНЫЕ ДНИ (общий модуль) ==============================
// Канон — tgcloud/lib/religion.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
const {
    newStyleDate, NEW_STYLE_END, oldStyleDate, REL_DEFS, REL_ORDER, religiousDigest, religiousYear} = reqLib("religion");


// ============================== ASTRO (общий модуль) ==============================
// Канон — tgcloud/lib/astro.cjs (план .kilo/plans/20261107-shared-modules-plan.md): его же импортирует
// ТГ-копия через ESM-шим; правки — только в .cjs, дословных копий больше нет.
const { TZ_MS, moonNew, la, ageSuffix, mskToday} = reqLib("astro");

// ============================== TEXT (общий модуль) ==============================
// Канон примерных дат — tgcloud/lib/text.cjs (approxOut): его же импортирует
// ТГ-копия через ESM-шим; юбилейные тексты (jubileeText) платформенные —
// остаются в копиях (ТГ: tg-spoiler/htmlEsc, ВК: plain).
const { HELP, approxOut, findShownRecord } = reqLib("text");

// ============================== РОДОСЛОВНАЯ РОСПИСЬ -+= — ЧИСТЫЕ ФУНКЦИИ (общий модуль) =====
// Канон — tgcloud/lib/flat.cjs (план .kilo/plans/20261108-canon-flat-pure-plan.md): его же импортирует
// ТГ-копия напрямую из bot.js (`import … from './flat.cjs'`, как tree.cjs); правки — только в .cjs.
const {
    flatTreeText, subsetBranch, flatSearch, flatHitPerson, flatHitKey,
    treeReport, rootOf, searchHead, cutLines} = reqLib("flat");


// ============================== ВЫВОД ==============================

function jubileeText(rec, note, detail = false) {
    const hasTime = rec.h !== undefined && rec.m !== undefined;
    // дата — по новому стилю с суффиксом (приблизительные — через approxOut);
    // хранение и экспорт остаются старым стилем (см. newStyleDate). Даты, где
    // стили различаются (≤ 1918-02-13), печатаются с разделителями `_`:
    // скопипащенная шапка-триггер разбирается как новый стиль (см.
    // parseDateGroups) и находит ту же запись, а не плодит дубль
    const sd = newStyleDate(rec.d), sdd = rec.dd ? newStyleDate(rec.dd) : rec.dd;
    // `_` — только у полных дат (урезанные «1624-04» остаются с `-`: день
    // скрыт, конверсия при вводе невозможна и не нужна — год-месяц совпадают)
    const nsd = (iso, marked, abt) => { const s = approxOut(iso, abt); return marked && s.length === 10 ? s.replace(/-/g, "_") : s; };
    const [y, mo, d] = sd.split("-").map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, rec.h !== undefined ? rec.h : 12, rec.m !== undefined ? rec.m : 0, 0));
    const head = rec.n + " " + nsd(sd, sd !== rec.d, rec.abt || rec.mabt || 0) + (hasTime ? " " + String(rec.h).padStart(2, "0") + ":" + String(rec.m).padStart(2, "0") : "")
        + (sdd ? " " + nsd(sdd, sdd !== rec.dd, rec.dabt || rec.mabt || 0) : "")
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
// (LR_DB; «:memory:» — тесты): записи синхронные, второй процесс упирается
// в блокировку файла. Прежний db.json конвертируется разово при первом
// старте (остаётся рядом как db.json.migrated).

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

// тестовый режим (`test`, sync-check): LR_DB задают явно (:memory: у тестов);
// при LR_DB конвертация db.json отключена — тестовые экземпляры не трогают
// боевую базу и dev-данные
const TEST_MODE = process.argv[2] === "test";
const DB_FILE = process.env.LR_DB || (TEST_MODE ? ":memory:" : path.join(__dirname, "lunarreturns.db"));
const OLD_DB_FILE = path.join(__dirname, "db.json");
let sdb = null;

function sq() {
    if (sdb) return sdb;
    sdb = new DatabaseSync(DB_FILE);
    sdb.exec(`
CREATE TABLE IF NOT EXISTS indi(
    chat INTEGER NOT NULL, xref TEXT NOT NULL, name TEXT NOT NULL,
    birt_d TEXT, birt_h INTEGER, birt_m INTEGER, src_h INTEGER, src_m INTEGER,
    deat_d TEXT, deat_h INTEGER, deat_m INTEGER, dsrc_h INTEGER, dsrc_m INTEGER,
    sex TEXT, plac TEXT, deat_plac TEXT, note TEXT, PRIMARY KEY(chat, xref));
CREATE TABLE IF NOT EXISTS fam(
    chat INTEGER NOT NULL, xref TEXT NOT NULL, adhoc INTEGER NOT NULL DEFAULT 0,
    husb TEXT, wife TEXT,
    marr_d TEXT, marr_plac TEXT, div_d TEXT, div_plac TEXT, note TEXT, PRIMARY KEY(chat, xref));
CREATE TABLE IF NOT EXISTS chil(
    chat INTEGER NOT NULL, fam TEXT NOT NULL, indi TEXT NOT NULL,
    adopted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(chat, fam, indi));
CREATE TABLE IF NOT EXISTS links(
    id INTEGER PRIMARY KEY AUTOINCREMENT, chat INTEGER NOT NULL,
    p TEXT NOT NULL, c TEXT NOT NULL, who TEXT, fam TEXT,
    cmid INTEGER NOT NULL DEFAULT 0, pairCand TEXT, UNIQUE(chat, p, c));
CREATE TABLE IF NOT EXISTS sent(
    chat INTEGER NOT NULL, key TEXT NOT NULL, last_year INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(chat, key));
CREATE TABLE IF NOT EXISTS settings(
    chat INTEGER PRIMARY KEY, orth INTEGER NOT NULL DEFAULT 0, islam INTEGER NOT NULL DEFAULT 0,
    bud INTEGER NOT NULL DEFAULT 0, cath INTEGER NOT NULL DEFAULT 0, jud INTEGER NOT NULL DEFAULT 0,
    bell INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);`);
    // WAL: запись в разы быстрее и чтения не блокируются записью; цена —
    // при обрыве питания может откатиться последний коммит (для бота ок).
    // busy_timeout — дождаться чужой записи вместо мгновенного «locked».
    // synchronous=NORMAL — на соединение; journal_mode=WAL персистентный
    sdb.exec("PRAGMA journal_mode=WAL");
    sdb.exec("PRAGMA synchronous=NORMAL");
    sdb.exec("PRAGMA busy_timeout=3000");
    for (const [t, c, ty] of [["indi", "note", "TEXT"], ["fam", "note", "TEXT"],
        ["indi", "deat_plac", "TEXT"],
        // признаки примерных дат (юбилеи по ним не оповещаются)
        ["indi", "birt_abt", "INTEGER"], ["indi", "deat_abt", "INTEGER"],
        ["fam", "marr_abt", "INTEGER"], ["fam", "div_abt", "INTEGER"]]) {
        const cols = qa("PRAGMA table_info(" + t + ")");
        if (!cols.some(x => x.name === c)) { try { qr("ALTER TABLE " + t + " ADD COLUMN " + c + " " + ty); } catch (e) { /* уже есть */ } }
    }
    convertOldDb();
    return sdb;
}
const qa = (sql, ...a) => sq().prepare(sql).all(...a);
const q1 = (sql, ...a) => sq().prepare(sql).get(...a);
const qr = (sql, ...a) => sq().prepare(sql).run(...a);

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
        FROM indi WHERE chat=? AND birt_d IS NOT NULL ORDER BY rowid`, peerId).map(r => {
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
    });
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
function linkById(peerId, id) {
    const r = q1("SELECT * FROM links WHERE chat=? AND id=?", peerId, id);
    return r ? linkRowOf(r) : null;
}
function linkByCmid(peerId, cmid) {
    const r = q1("SELECT * FROM links WHERE chat=? AND cmid=?", peerId, cmid);
    return r ? linkRowOf(r) : null;
}
function setLinkCand(link, cand) {
    qr("UPDATE links SET pairCand=? WHERE chat=? AND id=?", cand ? JSON.stringify(cand) : null, link.peerId, link.id);
    link.pairCand = cand || null;
}
function setLinkCmid(link, cmid) {
    qr("UPDATE links SET cmid=? WHERE chat=? AND id=?", cmid || 0, link.peerId, link.id);
    link.cmid = cmid || 0;
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
    // жертвы: потомки + половины ветви (половина остаётся, если есть семья вне ветви)
    const victims = new Set();
    for (const x of D) if (x !== px) victims.add(x);
    for (const fx of fams) {
        const f = famRows.find(t => t.xref === fx);
        for (const h of [f.husb, f.wife]) {
            if (!h || D.has(h)) continue;
            const outside = famRows.some(t => !inF.has(t.xref) && (t.husb === h || t.wife === h));
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
    for (const x of victims) qr("DELETE FROM indi WHERE chat=? AND xref=?", peerId, x);
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
// не найден — роспись применяется как есть (добавление merge'ем).
// Роспись РАДИУСА (chatFlatText по keys — .ged.txt третьего прицепа 🧬) несёт
// героя ВНУТРИ дерева (первым корнем идёт старший предок) и открывается
// меткой NOT_FOR_GRAFT: радиус не несёт всех потомков героя, прививка
// обновила бы связи лишь частично. Такая роспись отвергается — правки нет,
// ответ-ошибка предлагает родословную роспись -+= тапа «-+=». Мимо якоря метка резке
// мешает, а добавлению нет: merge росписи радиуса в чистый чат работает как прежде
function cutAndGraft(peerId, anchorKey, tree) {
    if (tree.noGraft) // метка NOT_FOR_GRAFT первой строкой (роспись радиуса)
        return { persons: 0, fams: 0, links: 0, errors: [], noGraft: true };
    const px = xrefOfKey(peerId, anchorKey);
    if (!px) { const rep = applyTree(peerId, tree); rep.cut = 0; rep.famsCut = 0; return rep; }
    const heroIdx = tree.persons.findIndex(p => !p.spouseLine
        && p.rec.n + " " + p.rec.d === anchorKey);
    const root = rootOf(tree);
    if (heroIdx >= 0 && root && tree.persons.indexOf(root) !== heroIdx) {
        const rep = applyTree(peerId, tree); // герой внутри росписи — merge без резки
        rep.cut = 0; rep.famsCut = 0;
        return rep;
    }
    const cut = cutBranch(peerId, px, tree.persons.map(p => p.rec.n)); // свадьбы-заглушки пар росписи тоже срезаются
    if (root && root.rec.d !== undefined) // герой без даты — заглушка не замещает запись
        setPersonByXref(peerId, px, Object.assign({ sex: root.sex, note: root.note }, root.rec));
    else if (!root) deleteEventCascade(peerId, anchorKey);
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

// удалить связь: ребро + chil семьи, когда других связей ребёнка в ней нет;
// опустевшая adhoc-семья без свадьбы уходит (пара с marr живёт — носитель)
function deleteLink(peerId, link) {
    qr("DELETE FROM links WHERE chat=? AND id=?", peerId, link.id);
    if (link.fam) {
        const cx = xrefOfKey(peerId, link.c);
        if (cx && !q1("SELECT id FROM links WHERE chat=? AND fam=? AND c=?", peerId, link.fam, link.c))
            qr("DELETE FROM chil WHERE chat=? AND fam=? AND indi=?", peerId, link.fam, cx);
        normalizeFam(peerId, link.fam);
    }
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
    qr("DELETE FROM indi WHERE chat=? AND xref=?", peerId, xref);
}

// разовая конвертация db.json → SQLite при первом старте (файл остаётся
// рядом как db.json.migrated); метка converted_json защищает от повтора
function convertOldDb() {
    if (process.env.LR_DB) return; // LR_DB задан (тесты/синхронизация) — без конвертации
    if (!fs.existsSync(OLD_DB_FILE)) return;
    if (q1("SELECT v FROM meta WHERE k='converted_json'")) return;
    let old;
    try { old = JSON.parse(fs.readFileSync(OLD_DB_FILE, "utf8")); } catch (e) { return; }
    if (!old || !Array.isArray(old.records)) return;
    const body = () => {
        const k2x = new Map(); // chat\0«Имя Д» → xref
        for (const r of old.records) {
            if (r.n.includes("+")) continue;
            const x = nextIndiXref(r.peerId, "P");
            qr(`INSERT INTO indi(chat,xref,name,birt_d,birt_h,birt_m,src_h,src_m,deat_d,deat_h,deat_m,dsrc_h,dsrc_m,sex,plac)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                r.peerId, x, r.n, r.d,
                r.h ?? null, r.h !== undefined ? (r.m ?? 0) : null,
                r.srcH ?? null, r.srcH !== undefined ? (r.srcM ?? 0) : null,
                r.dd ?? null, r.dh ?? null, r.dh !== undefined ? (r.dm ?? 0) : null,
                r.dsrcH ?? null, r.dsrcH !== undefined ? (r.dsrcM ?? 0) : null,
                r.sex ?? null, r.plac ?? null);
            k2x.set(r.peerId + "\0" + r.n + " " + r.d, x);
        }
        for (const f of old.fams || []) {
            const ps = (f.parents || []).map(p => k2x.get(f.peerId + "\0" + p)).filter(Boolean);
            if (!ps.length && !f.marr) continue;
            const fx = "G" + f.id;
            qr(`INSERT OR IGNORE INTO fam(chat,xref,adhoc,husb,wife,marr_d,marr_plac,div_d,div_plac) VALUES(?,?,1,?,?,?,?,?,?)`,
                f.peerId, fx, ps[0] ?? null, ps[1] ?? null,
                f.marr ? f.marr.d : null, f.marr && f.marr.plac ? f.marr.plac : null,
                f.div ? f.div.d : null, f.div && f.div.plac ? f.div.plac : null);
            for (const c of f.children || []) {
                const cx = k2x.get(f.peerId + "\0" + c);
                if (cx) qr("INSERT OR IGNORE INTO chil(chat,fam,indi) VALUES(?,?,?)", f.peerId, fx, cx);
            }
        }
        for (const l of old.links || []) {
            const px = k2x.get(l.peerId + "\0" + l.p), cx = k2x.get(l.peerId + "\0" + l.c);
            if (!px || !cx) continue;
            let fx = l.fam ? "G" + l.fam : null;
            if (fx && !famRaw(l.peerId, fx)) fx = null;
            if (!fx) {
                fx = nextFamXref(l.peerId, "L");
                qr("INSERT INTO fam(chat,xref,adhoc,husb,wife) VALUES(?,?,1,?,NULL)", l.peerId, fx, px);
            }
            qr("INSERT OR IGNORE INTO chil(chat,fam,indi) VALUES(?,?,?)", l.peerId, fx, cx);
            if (l.adopted) qr("UPDATE chil SET adopted=1 WHERE chat=? AND fam=? AND indi=?", l.peerId, fx, cx);
            qr("INSERT INTO links(chat,p,c,who,fam,cmid,pairCand) VALUES(?,?,?,?,?,?,?)",
                l.peerId, l.p, l.c, l.who, fx, l.cmid || 0, l.pairCand ? JSON.stringify(l.pairCand) : null);
        }
        // свадьбы-записи → пары-заглушки (не покрытые семьёй с той же датой)
        for (const r of old.records) {
            if (!r.n.includes("+")) continue;
            const [n1, n2] = r.n.split("+");
            let covered = false;
            for (const f of qa("SELECT xref FROM fam WHERE chat=? AND marr_d=?", r.peerId, r.d)) {
                const nm = famNames(r.peerId, f.xref);
                if (nm.hn === n1 || nm.hn === n2 || nm.wn === n1 || nm.wn === n2) { covered = true; break; }
            }
            if (covered) continue;
            qr(`INSERT INTO fam(chat,xref,adhoc,husb,wife,marr_d,marr_plac,div_d,div_plac) VALUES(?,?,1,?,?,?,?,?,?)`,
                r.peerId, nextFamXref(r.peerId, "W"), stubOf(r.peerId, n1), stubOf(r.peerId, n2),
                r.d, r.plac ?? null, r.dd ?? null, r.plac2 ?? null);
        }
        for (const r of old.records)
            if (r.lastSentYear)
                qr("INSERT OR REPLACE INTO sent(chat,key,last_year) VALUES(?,?,?)", r.peerId, r.n + " " + r.d, r.lastSentYear);
        for (const [peer, v] of Object.entries(old.settings || {}))
            qr("INSERT OR REPLACE INTO settings(chat,orth,islam,bud,cath,jud,bell) VALUES(?,?,?,?,?,?,?)",
                Number(peer), v.orth ? 1 : 0, v.islam ? 1 : 0, v.bud ? 1 : 0, v.cath ? 1 : 0, v.jud ? 1 : 0,
                v.bell === false ? 0 : 1);
        if (old.lastSeen) qr("INSERT OR REPLACE INTO meta(k,v) VALUES('lastSeen',?)", String(old.lastSeen));
        if (old.checkedDate) qr("INSERT OR REPLACE INTO meta(k,v) VALUES('checkedDate',?)", old.checkedDate);
        qr("INSERT OR REPLACE INTO meta(k,v) VALUES('converted_json','1')");
    };
    sq().exec("BEGIN");
    try { body(); sq().exec("COMMIT"); }
    catch (e) { sq().exec("ROLLBACK"); throw e; }
    try { fs.renameSync(OLD_DB_FILE, OLD_DB_FILE + ".migrated"); }
    catch (e) { console.error("db.json rename:", e.message); }
    console.log("db.json сконвертирован в SQLite (резерв: db.json.migrated)");
}

// очистить дерево чата (замена при импорте; настройки/sent остаются)
function clearChatTree(peerId) {
    qr("DELETE FROM indi WHERE chat=?", peerId);
    qr("DELETE FROM fam WHERE chat=?", peerId);
    qr("DELETE FROM chil WHERE chat=?", peerId);
    qr("DELETE FROM links WHERE chat=?", peerId);
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

// текст сообщения-связи: строки связи (+ семья/вопрос), без юбилеев события —
// гедком-фрагмент добавляется отдельно (gedcomText с ключами)
function linkText(peerId, link) {
    let t = "🔗 Родитель: " + link.p + " → ребёнок: " + link.c + (link.adopted ? " 🤱 (усыновление)" : "");
    if (link.fam) {
        const f = famView(peerId, link.fam);
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
// 👎 в ВК не даём — реакция 👎 удаляет связь (в ТГ это кнопка)
function linkKeyboard(peerId, link) {
    const mk = (label, payload) => ({
        action: { type: "callback", label, payload: JSON.stringify(payload) },
        color: "secondary"
    });
    const rows = [];
    rows.push([mk("🤱", { c: "adop", l: link.id }, "secondary")]);
    const rec = recordOf(peerId, link[link.who]);
    if (rec && !rec.sex)
        rows.push([mk("♂", { c: "sex", l: link.id, s: "M" }), mk("♀", { c: "sex", l: link.id, s: "F" })]);
    if (link.pairCand && link.pairCand.length) {
        const btns = link.pairCand.length === 1
            ? [mk("Да", { c: "pair", l: link.id, i: 0 })]
            : link.pairCand.map((k, i) => mk(String(i + 1), { c: "pair", l: link.id, i }));
        btns.push(mk("Нет", { c: "pair", l: link.id, i: -1 }));
        rows.push(btns);
    }
    // пустая клавиатура обязана проходить в edit — иначе останется прежняя
    return JSON.stringify({ inline: true, buttons: rows });
}



// импорт разобранного гедкома = ЗАМЕНА: дерево чата очищается и заливается
// заново (слияние больше не делаем — смешивание источников ломало базу).
// fam — по одному на каждый FAM файла с точными xref'ами (без слипания
// семей ребёнка); свадьбы живут на fam — точная привязка супругов;
// бездатные импортируются, когда упомянуты в семье — с фиктивной датой
// (супруг: дата половины; ребёнок: каскад сиблинг/свадьба/родитель, birt_abt 15 — EST-день),
// без варианта — заглушки-персоны (birt_d NULL); безымянные — мимо.
// Возвращает краткий отчёт. Повторный импорт лечит любые старые данные
function importGedcom(peerId, g) {
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
            null, null,
            ind.birt.time ? Number(ind.birt.time.slice(0, 2)) : null,
            ind.birt.time ? Number(ind.birt.time.slice(3, 5)) : null,
            ind.deat && ind.deat.date ? ind.deat.date : null,
            null, null,
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
    // единый каскад фиктивных дат до фиксированной точки — канон
    // gedFictiveDates (parse.cjs): карта xref → фиктивная полная дата|null,
    // датированные в файле — послеколлизионные (resolved), бездатные
    // поимённые в famRefs — вычисленные; правила якорей (сиблинг/свадьба/
    // полусиблы/родитель, супруги) — в каноне. Вставки, коллизии фиктивных
    // дат (uniqueKeyOf yearly) и счётчики — ниже, платформенные
    const fullOf = gedFictiveDates(g, famRefs, resolved);
    // второй проход: бездатные супруги и дети — фиктивная полная дата,
    // birt_abt 15 (EST-день: в шкале PDF нет года и прожитых лет, печать —
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
            qr(`INSERT INTO indi(chat,xref,name,birt_d,birt_h,birt_m,src_h,src_m,deat_d,deat_h,deat_m,dsrc_h,dsrc_m,sex,plac,deat_plac,note,birt_abt,deat_abt)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                peerId, ind.__xref, sname, null,
                null, null, null, null,
                ind.deat && ind.deat.date ? ind.deat.date : null,
                null, null,
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
        const u = uniqueKeyOf(peerId, ind.name, full, true, true, ind.__xref);
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
            null, null,
            ind.deat && ind.deat.time ? Number(ind.deat.time.slice(0, 2)) : null,
            ind.deat && ind.deat.time ? Number(ind.deat.time.slice(3, 5)) : null,
            ind.sex ?? null,
            ind.birt && ind.birt.plac ? ind.birt.plac : null,
            ind.deat && ind.deat.plac ? ind.deat.plac : null,
            ind.note ?? null,
            uabt, // дубль со сдвинутой датой — abt 15 (EST-день; сдвиг виден в
                // печати, дублей дополнительно различает суффикс «~xref»)
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
        for (const cx of f.chil) {
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
    return { persons, fams: famCount, links: childCount, errors: [], dups };
}

function gedcomText(peerId, keys) {
    const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
    const gdate = d => { const [y, mo, dd] = d.split("-").map(Number); return dd + " " + MON[mo - 1] + " " + y; };
    // хвост-метка заглушки «Имя ~xref» живёт в БД для уникальности ключей
    // печатей (росписи/древо), но в гедкоме избыточен — xref и так в
    // идентикаторе INDI @…@; в NAME метку снимаем (реимпорт восстановит её
    // из файлового xref — круглый trip остаётся идемпотентным)
    const cleanName = n => n.replace(/ ~\S+$/, "");
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const persons = personRows(peerId).filter(r => !hasKeys || keys.includes(pkey(r)));
    const idOf = new Map(persons.map(r => [r.xref, r.xref]));
    const sexOf = new Map(persons.map(r => [r.xref, r.sex || null]));
    // усыновления: xref ребёнка → xref семьи (chil.adopted)
    const adoptedOf = new Map();
    for (const c of qa("SELECT fam, indi FROM chil WHERE chat=? AND adopted=1", peerId))
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
    for (const f of qa("SELECT * FROM fam WHERE chat=? ORDER BY rowid", peerId)) {
        const par = [], chd = [], stubs = [], kstubs = [];
        const stubOf = x => {
            const i = indiOf(peerId, x);
            if (!i || !i.name) return null;
            return { xref: x, name: i.name, sex: i.sex || null, deat: i.deat_d || null, dp: i.deat_plac || null,
                dabt: i.deat_d ? i.deat_abt || 0 : 0, note: i.note || null };
        };
        for (const x of [f.husb, f.wife]) {
            if (!x) continue;
            const k = keyOfXref(peerId, x);
            if (k) par.push({ x, k });
            else {
                const st = stubOf(x);
                if (st) stubs.push(st);
            }
        }
        for (const r of qa("SELECT indi FROM chil WHERE chat=? AND fam=? ORDER BY rowid", peerId, f.xref)) {
            const k = keyOfXref(peerId, r.indi);
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
    // и метки «~xref» в именах заглушек. HUSB/WIFE по полу (без — HUSB)
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
    const rows = qa("SELECT * FROM indi WHERE chat=? ORDER BY rowid", peerId).map(r => ({
        key: r.xref, name: r.name, sex: r.sex || null,
        d: r.birt_d ?? undefined, dd: r.deat_d ?? undefined,
        h: r.birt_h ?? undefined, m: r.birt_m ?? undefined,
        srcH: r.src_h ?? undefined, srcM: r.src_m ?? undefined,
        plac: r.plac ?? undefined, dp: r.deat_plac ?? undefined,
        note: r.note ?? undefined, nameOnly: r.birt_d == null,
        abt: r.birt_abt ?? undefined, dabt: r.deat_abt || undefined,
    }));
    const fams = [];
    for (const f of qa("SELECT * FROM fam WHERE chat=? ORDER BY rowid", peerId)) {
        const F = { xref: f.xref, hKey: null, hName: null, wKey: null, wName: null, children: [], marr: null, div: null, note: f.note || null };
        for (const x of [f.husb, f.wife]) {
            if (!x) continue;
            const r = indiOf(peerId, x);
            if (!r) continue;
            // сторона по полу (как в гедкоме: без пола — мужская); занятая — на свободную
            if (r.sex === "F" && F.wKey == null) F.wKey = x;
            else if (F.hKey == null) F.hKey = x;
            else if (F.wKey == null) F.wKey = x;
        }
        for (const r of qa("SELECT indi FROM chil WHERE chat=? AND fam=? ORDER BY rowid", peerId, f.xref)) {
            if (indiOf(peerId, r.indi)) F.children.push(r.indi);
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

function chatFlatText(peerId, keys = null) {
    // keys (опционально) — фокус-радиус: роспись только этого подмножества
    // («Имя ГГГГ-ММ-ДД»); семьи фильтруются по касанию персон карт ключей
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const [rows, allFams] = flatRows(peerId);
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





// ключи диаграммы — pkey «Имя ГГГГ-ММ-ДД» без усечения (имя может содержать
// пробелы; бездатный супруг идёт своим «Имя якорь», мимо ckey)
const ckey = k => k;

function chartFor(peerId, keys, title, heroKey = null, range = null) {
    const hasKeys = Array.isArray(keys) && keys.length > 0;
    const recs = personRows(peerId).filter(r => !hasKeys || keys.includes(pkey(r)));
    const keySet = new Set(recs.map(r => pkey(r)));
    let rows = recs.map(r => ({ name: r.n, birth: r.d, death: r.dd || null, sex: r.sex || null, abt: r.abt ?? 0 }));
    const stubSpouses = [];
    // якоря бездатных: год ДР датированного супруга (первой семьи по порядку)
    const stubs = qa("SELECT xref,name,deat_d,sex FROM indi WHERE chat=? AND birt_d IS NULL AND name!=''", peerId);
    const stubOf = new Map(stubs.map(r => [r.xref, r]));
    const anchor = new Map(); // xref бездатного → { yr, spKey, fam }
    for (const f of qa("SELECT xref,husb,wife FROM fam WHERE chat=? ORDER BY rowid", peerId)) {
        for (const [a, b] of [[f.husb, f.wife], [f.wife, f.husb]]) {
            if (!a || !b || !stubOf.has(a) || anchor.has(a)) continue;
            const sp = indiOf(peerId, b);
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
        rows.push({ name: s.name, k, birth: null, anchor: an.yr, death: s.deat_d || null, sex: s.sex || null });
    }
    // родители ребёнка: датированные, вошедшие в чарт + бездатный супруг
    // (свой ключ «Имя якорь»); fill ds/sk, ключ бездатного не под ckey
    const parentsOf = new Map();    // ребёнок (ключ «Имя ГГГГ-…») → { ds, sk }
    for (const f of famList(peerId)) {
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
        pairs: linkPairs(peerId).map(([p, c]) => [ckey(p), ckey(c)]),
        spouses: [...focusSpousePairs(peerId).map(sp => sp.map(ckey)), ...stubSpouses],
        sex: Object.fromEntries([...personRows(peerId).map(r => [pkey(r), r.sex || null]),
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
    const bornOf = new Map(personRows(peerId).map(r => [pkey(r), r.d]));
    const phantoms = [];
    const marriages = [];           // свадьбы с датой: { fam: [ключ, ключ], year };
                                    // один супруг в чарте — fam: [ключ] (зарубка)
    for (const f of famList(peerId)) {
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
        if (yrs.length) phantoms.push({ fam: pair, years: yrs });
    }
    return { pdf: chartPdf(title, rows, links, chartFont(), { ...rel, phantoms }, marriages), persons: Math.min(rows.length, CHART_MAX) };
}

// загрузка документа на серверы VK (docs… — файлы любого типа); сервер загрузки
// иногда отвечает HTML-страницей ошибки вместо JSON — до 3 попыток, каждый раз
// с новым upload_url (одноразовый) и свежим FormData; явная ошибка VK в JSON
// (нет file) — без повторов
async function vkUploadDoc(peerId, title, content) {
    let j = null, lastErr = null;
    // таймаут по размеру: 10 с + ~1 с на КБ, кап 60 с (7 КБ → 17 с; upload
    // ~7 КБ наблюдался за 5 с, так что запас ~3×; большой PDF получает больше)
    const timeoutMs = Math.min(60000, 10000 + Math.ceil(content.length / 1024) * 1000);
    for (let attempt = 1; attempt <= 3 && !j; attempt++) {
        if (attempt > 1) await sleep(1500 * (attempt - 1));
        const up = await vkApi("docs.getMessagesUploadServer",
            groupId ? { peer_id: peerId, group_id: groupId, type: "doc" } : { peer_id: peerId, type: "doc" });
        const fd = new FormData();
        fd.append("file", new Blob([content]), title);
        try {
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
    const saved = await vkApi("docs.save", { file: j.file, title });
    const d = saved.doc || (saved[0] || {}).doc;
    if (!d) throw new Error("docs.save: нет документа");
    return "doc" + d.owner_id + "_" + d.id;
}

// тап 🧬 / «/gedcom» / «/gedcomN»: <имя>.ged всегда, <имя>.pdf (диаграмма,
// имя из заголовка fileBaseOf); heroKey — pkey героя для колонки «Связь год»;
// неудача выкладки — только сообщение об ошибке, гедком текстом не дублируем
// Радиусный вызов (keys — ромб родни: тап 🧬 на фокусе и /gedcomN в ответ
// на триггер): третий прицеп <имя>.ged.txt — роспись того же радиуса
// (chatFlatText по keys): форма «-+=», но не только вниз — и вверх, и вниз,
// в пределах радиуса; всему древу чата росписи нет (его «-+=» и так весь)
// origin (тап 🧬 на «/»-сообщении) — правка исходного сообщения с вложениями
// (текст и назначение не меняются, как у «-+=»); без origin — отдельным сообщением
// 🧬: радиусное древо — три прицепа (.ged, .pdf, роспись .ged.txt). Сначала —
// мгновенное сообщение с ⏳: влезает роспись — её текст «без ножниц, с часами»,
// не влезает — метка + голова + ✂️⏳; затем асинхронно строятся/грузятся
// файлы (это долго) и правкой цепляются к тому же сообщению, ⏳ снимается
async function sendGedArtifacts(peerId, keys, head, msgId, convMsgId, heroKey = null, origin = null, kb = null) {
    const g = gedcomText(peerId, keys);
    // заголовок чарта без цифры радиуса;
    // цифра → range героя для chartFor
    const head0 = head || "Гедком-древо";
    const chartHead = head0.replace(/^\d\s+/, "");
    const rm = /^(\d)\s/.exec(head0);
    const base = fileBaseOf(head0);
    // роспись радиуса — chatFlatText по keys (метка NOT_FOR_GRAFT — первой строкой)
    const pack = Array.isArray(keys) && keys.length ? chatFlatText(peerId, keys) : "";
    const packFits = !!pack && pack.length < 4000;
    const overflow = !!pack && !packFits;
    // перелив: голова, метка, обрезанный внутренний текст росписи (первая
    // строка росписи — метка, её не двоим; целые строки до ~4000 знака) и
    // ✂️⏳ в конце; после прицепов — то же с ✂️ без часов
    let inner = "";
    if (overflow) {
        const lines = pack.split("\n")
            .filter((l, i) => !(i === 0 && l.trim().toLowerCase().startsWith(NOT_FOR_GRAFT.toLowerCase())));
        inner = cutLines(lines.join("\n"), 4000, head.length + 1 + NOT_FOR_GRAFT.length + 1);
    }
    const headTxt = head + (packFits ? "\n" + pack : "");
    // держатель: чат-кейс (/gedcom без кнопки) и тап 🧬 (origin) — «🧬⏳»
    // с цитатой на команду/кнопку (⏳ = «выполняю, подождите»); при переливе
    // роспись целиком уходит в .ged.txt-прицеп — текста и ✂️ в сообщении нет
    // (✂️ живёт на тапах по фокусам); радиусные вызовы (keys) — голова + ⏳
    // или перелив «метка + голова + … + ✂️⏳». Финал: метка «🧬» / голова —
    // ⏳ снят правкой того же сообщения
    const chatHold = !keys && !origin;
    const holdTxt = !keys ? "🧬⏳"
        : overflow ? head + "\n" + NOT_FOR_GRAFT + "\n" + inner + "\n✂️⏳" : headTxt + "\n⏳";
    const finalTxt = !keys ? "🧬"
        : overflow ? head + "\n" + NOT_FOR_GRAFT + "\n" + inner + "\n✂️" : headTxt;
    // 1) мгновенно: текст + ⏳ (правкой исходника фокуса или новым сообщением)
    let sent = 0;
    try {
        if (origin) {
            try { await editOrigin(origin, holdTxt, kb); sent = -1; }
            catch (e) { sent = await messagesSend(peerId, holdTxt, msgId, convMsgId, null); }
        } else {
            sent = await messagesSend(peerId, holdTxt, msgId, convMsgId, null);
        }
    } catch (e) { console.error("ged hold:", e.message); }
    console.log("ged hold:", base, !keys ? "🧬⏳" : overflow ? "✂️⏳" : "⏳", chatHold ? "(чат)" : "", "peer", peerId);
    // 2) асинхронно: pdf и прицепы; когда готовы — цепляются правкой к тому
    // же сообщению (чат-кейс: одна комбинированная правка — ⏳ снят, метка
    // и файлы; тап и радиусы: clique (вложение) + текстовая правка tlex)
    (async () => {
    try {
        let pdf = null, persons = 0, chartErr = null;
        let t0 = Date.now();
        try {
            // PDF candidates use the cheap blood prefix plus bounded marriages.
            // chartFor filters every final row by label words; GED/TXT keep keys.
            let chartKeys = keys;
            if (heroKey && rm) {
                chartKeys = focusKeys(linkPairs(peerId), heroKey, Number(rm[1]), focusSpousePairs(peerId));
            }
            const res = chartFor(peerId, chartKeys, chartHead, heroKey, rm ? Number(rm[1]) : null);
            persons = res.persons;
            pdf = res.pdf;
        } catch (e) { chartErr = e.message.replace(/^chart:\s*/, ""); console.error("chart:", e.message); }
        if (Date.now() - t0 > 1000) console.log("ged chart:", (Date.now() - t0) + "ms");
        t0 = Date.now();
        const atts = [await vkUploadDoc(peerId, base + ".ged", g)];
        console.log("ged upload:", base + ".ged", (Date.now() - t0) + "ms");
        if (pdf) { t0 = Date.now(); atts.push(await vkUploadDoc(peerId, base + ".pdf", Buffer.from(pdf, "latin1"))); console.log("ged upload:", base + ".pdf", (Date.now() - t0) + "ms"); }
        // роспись .ged.txt — третьим прицепом ТОЛЬКО когда текстом не вместилась;
        // влезла — её текст уже в сообщении, прицепляем только .ged+.pdf
        if (overflow) { t0 = Date.now(); atts.push(await vkUploadDoc(peerId, base + ".ged.txt", "\uFEFF" + pack)); console.log("ged upload:", base + ".ged.txt", (Date.now() - t0) + "ms"); }
        // Чат-кейс: ОДНА комбинированная правка {attachment, message} — часы
        // сняты, метка «🧬» и файлы в том же сообщении; комбинированная правка
        // message+attachment по message_id применяет и текст, и вложение
        // (цитата при ней исчезает — принято; `keyboard: null` правку ломает,
        // поэтому ключа keyboard нет). Тап/радиусы: clique (вложение) +
        // текстовая правка tlex (вложения включены повторно)
        try {
            t0 = Date.now();
            if (chatHold) {
                const edit = { peer_id: peerId, message_id: sent,
                    attachment: atts.join(","), message: finalTxt };
                try {
                    await vkApi("messages.edit", edit);
                    console.log("ged edit: text+attachment", (Date.now() - t0) + "ms");
                } catch (e2) {
                    console.error("ged edit:", e2.message, "— повторяю");
                    try { await vkApi("messages.edit", edit); } catch {}
                }
                console.log("ged artifacts edited:", base + ".ged", "peer", peerId);
            } else {
                const clique = { peer_id: peerId, attachment: atts.join(","), keyboard: kb };
                if (origin && sent === -1) clique.conversation_message_id = origin.conversation_message_id;
                else clique.message_id = sent;
                await vkApi("messages.edit", clique);
                console.log("ged edit: attachment", (Date.now() - t0) + "ms");
                const tlex = { peer_id: peerId, attachment: atts.join(","), keyboard: kb,
                    message: finalTxt };
                if (origin && sent === -1) tlex.conversation_message_id = origin.conversation_message_id;
                else tlex.message_id = sent;
                try {
                    t0 = Date.now();
                    await vkApi("messages.edit", tlex);
                    console.log("ged edit: text", (Date.now() - t0) + "ms");
                } catch (e2) {
                    console.error("ged origin text:", e2.message, "— правлю текст без клавиатуры");
                    const bare = { ...tlex }; delete bare.keyboard;
                    try { await vkApi("messages.edit", bare); } catch {}
                }
                console.log("ged artifacts edited into origin:", base + ".ged", "peer", peerId);
            }
        } catch (e) {
            console.error("editOriginAtts:", e.message, "— отношу файлом");
            await messagesSend(peerId, finalTxt, 0, 0, null, atts.join(","));
        }
        console.log("ged artifacts: " + base + ".ged" + (pdf ? " + " + base + ".pdf (" + persons + " персон)" : "")
            + (overflow ? " + " + base + ".ged.txt" : ""), "peer", peerId);
        // бездатное древо — PDF нет по построению («chart: персоны
        // пусты»), это не ошибка, алерта не шлём
        if (chartErr && !chartErr.includes("персоны пусты")) await messagesSend(peerId, "💥 Диаграмма не построена: " + chartErr);
        return;
    } catch (e) {
        console.error("doc upload:", e.message);
        await messagesSend(peerId, "💥 Не удалось выложить файлы: " + e.message);
    }
    })();
}

// ============================== НАСТРОЙКИ ==============================
// Оповещения о религиозных днях per peer: { orth, islam, bud, cath, jud }.

function getSettings(peerId) {
    const r = q1("SELECT * FROM settings WHERE chat=?", peerId);
    return r
        ? { orth: !!r.orth, islam: !!r.islam, bud: !!r.bud, cath: !!r.cath, jud: !!r.jud, bell: r.bell !== 0 }
        : {};
}

function toggleRel(peerId, key) {
    const cur = !!getSettings(peerId)[key];
    if (q1("SELECT chat FROM settings WHERE chat=?", peerId))
        qr("UPDATE settings SET " + key + "=? WHERE chat=?", cur ? 0 : 1, peerId);
    else
        qr("INSERT INTO settings(chat," + key + ") VALUES(?,?)", peerId, cur ? 0 : 1);
    return !cur;
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
                message: HELP, keyboard: JSON.stringify({ inline: true, buttons: [] })
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

function queueSend(params) {
    const job = sendChain.then(() => sendWithRetry(params));
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
    const peerId = params.peer_id;
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
            try {
                await handleMessage(peer, String(tm.text || ""), tm.date, tm.id, tm.conversation_message_id);
            } catch (e) {
                console.error("catchUp", peer, tm.id, e.message);
            }
        }
        if (n) console.log("catchUp peer", peer, "replayed", n);
    }
}

// ============================== VK ==============================

const VK_API = "https://api.vk.com/method/";
const VK_VERSION = "5.199";

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

async function vkApi(method, params) {
    // undefined-параметры не передаём вовсе: URLSearchParams превратил бы их
    // в строки «undefined» (ВК показывает их как текст сообщения); вложенные
    // объекты (клавиатуры) — строкуем
    const clean = {};
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined) continue;
        clean[k] = v && typeof v === "object" && !Buffer.isBuffer(v) ? JSON.stringify(v) : v;
    }
    const qs = new URLSearchParams(Object.assign({ access_token: token, v: VK_VERSION }, clean));
    if (LOG_RAW) console.log(">> " + method, qs.toString().replace(/access_token=[^&]+/, "access_token=…"));
    // POST с form-body — как в vksdk/pinguin: клавиатуры в query string
    // (GET) ВК портит («unknown fields» на каждой кнопке)
    const res = await fetch(VK_API + method, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: qs,
        signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(method + " HTTP " + res.status);
    const body = await res.json();
    if (LOG_RAW) console.log("<< " + method, JSON.stringify(body).slice(0, 800));
    if (body.error) throw new Error(method + " " + body.error.error_code + ": " + body.error.error_msg);
    return body.response;
}

// ответ на сообщение: reply_to по глобальному id (личка) либо forward по
// conversation_message_id (в чатах id приходит 0 — как в pinguin vk.go)
async function messagesSend(peerId, text, msgId, convMsgId, keyboard, attachment) {
    const params = {
        peer_id: peerId,
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
    return queueSend(params);
}

let lp = null; // { server, key, ts }
let groupId = GROUP_ID;
let ownerId = 0; // создатель сообщества (role=creator), 0 — неизвестен
const REACTION_EYES_ID = 32; // 👀 (детально); 👍 = 4, 👎 = 9

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
const byPeer = (peerId, run) => {
    const next = (peerChains.get(peerId) || Promise.resolve()).then(run);
    peerChains.set(peerId, next.catch(() => {}));
    return next.catch(e => console.error("handle:", e.message, "\n",
        (e.stack || "").split("\n").slice(1, 4).join("\n")));
};

// один запрос long poll; обрабатывает пришедшие message_new
async function longPollStep() {
    const u = new URL(lp.server);
    u.searchParams.set("act", "a_check");
    u.searchParams.set("key", lp.key);
    u.searchParams.set("ts", lp.ts);
    u.searchParams.set("wait", "25");
    const res = await fetch(u, { signal: AbortSignal.timeout(35000) });
    const body = await res.json();
    if (LOG_RAW) console.log("<< poll ts=" + lp.ts, JSON.stringify(body).slice(0, 1000));
    if (process.env.LOG_UPDATES && body.failed) console.log("poll failed:", JSON.stringify(body));
    if (body.failed) {
        if (body.failed === 1 && body.ts) lp.ts = body.ts;
        else await longPollInit(); // 2/3 — смена key/server
        return;
    }
    lp.ts = body.ts;
    for (const upd of body.updates || []) {
        if (process.env.LOG_UPDATES) console.log("upd:", JSON.stringify(upd).slice(0, 500));
        if (groupId && Number(upd.group_id) !== groupId) continue;
        try {
            if (upd.type === "message_new" && upd.object) {
                const msg = upd.object.message || upd.object;
                if (!msg || msg.peer_id === undefined) continue;
                byPeer(msg.peer_id, async () => {
                    if (msg.action) { // сервисное: вход/выход участника и т.п.
                        console.log("action:", msg.action.type, "peer", msg.peer_id, "member", msg.action.member_id ?? "");
                        if (msg.action.type === "chat_invite_user" && msg.action.member_id !== -groupId) {
                            await messagesSend(msg.peer_id, HELP, 0, msg.conversation_message_id,
                                (ownerId && msg.action.member_id === ownerId) ? ownerKeyboard() : bellKeyboard());
                        }
                        return;
                    }
                    // дроп .ged-документа → вопрос «Да/Нет» (до разбора текста:
                    // сообщение может быть без текста, caption не разбираем)
                    const gedDoc = (msg.attachments || []).filter(a => a && a.type === "doc" && a.doc)
                        .map(a => a.doc).find(d => String(d.ext || "").toLowerCase() === "ged" || /\.ged$/i.test(String(d.title || "")));
                    if (gedDoc) {
                        await handleGedDrop(msg.peer_id, gedDoc, msg.id, msg.conversation_message_id, msg.from_id);
                        return;
                    }
                    // дроп .ged.txt-документа с родословной росписью -+= (см. handleTxtDrop);
                    // голый .txt — мимо (не разбираем, ждём .ged или .ged.txt)
                    const txtDoc = (msg.attachments || []).filter(a => a && a.type === "doc" && a.doc)
                        .map(a => a.doc).find(d => /\.ged\.txt$/i.test(String(d.title || "")));
                    if (txtDoc) {
                        await handleTxtDrop(msg.peer_id, txtDoc, msg.id, msg.conversation_message_id, msg.from_id, msg.reply_message || null);
                        return;
                    }
                    if (!msg.text && !msg.payload) return;
                    await handleMessage(msg.peer_id, String(msg.text || ""), msg.date, msg.id, msg.conversation_message_id, msg.from_id, unpay(msg.payload || ""), msg.reply_message || null);
                });
            } else if (upd.type === "message_event" && upd.object) {
                byPeer(upd.object.peer_id, () => handleEvent(upd.object));
            } else if (upd.type && upd.type.includes("reaction") && upd.object) {
                console.log("reaction upd:", JSON.stringify(upd.object).slice(0, 400));
                byPeer(upd.object.peer_id, () => handleReaction(upd.object));
            }
        } catch (e) {
            console.error("handle:", e.message, "\n", (e.stack || "").split("\n").slice(1, 4).join("\n"));
        }
    }
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
const isStart = (text, payload) => {
    if (text.trim() === "/") return true;
    if (payload && typeof payload === "object") return payload.command === "start";
    return payload === "start";
};

// дроп .ged-документа: скачать, разобрать и спросить кнопками «Да/Нет»;
// текст файла до ответа держим в памяти (последний дроп выигрывает, живёт час)
const GED_TTL = 3600000;
const gedPending = new Map(); // peerId → {name, text, fromId, ts}

// скачать текст документа-дропа с ретраями: CDN отдаёт файл не сразу
// (наблюдалось HTTP 502), поэтому после дропа ждём 3 с, попытка; провал —
// ещё 3 с и попытка, ещё 3 с и последняя (ТГ-копия: handlers/message.js)
async function fetchDocText(url) {
    for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!res.ok) throw new Error("HTTP " + res.status);
            return await res.text();
        } catch (e) {
            if (i === 2) throw e;
            console.warn("doc download retry", (i + 1) + "/3:", e.message);
        }
    }
    return null; // недостижимо
}

async function handleGedDrop(peerId, doc, msgId, convMsgId, fromId) {
    const name = doc.title || "gedcom.ged";
    let text;
    try {
        text = await fetchDocText(doc.url);
    } catch (e) {
        console.error("ged download:", e.message);
        await messagesSend(peerId, "💥 Не удалось скачать файл " + name + " (трижды; повторите написанием файла в чат)", msgId, convMsgId);
        return;
    }
    const g = parseGedcom(text);
    if (!g) {
        await messagesSend(peerId, "💥 Не удалось разобрать файл " + name + " (ждём GEDCOM в UTF-8)", msgId, convMsgId);
        return;
    }
    const s = gedStats(g);
    gedPending.set(peerId, { name, text, fromId, ts: Date.now() });
    // «Да, с резервом» — только при непустом дереве чата (fam/chil есть,
    // бездатное древо тоже резервировать можно)
    const hasSomeTree = hasTree(peerId);
    const btn = (label, c) => ({
        action: { type: "callback", label, payload: JSON.stringify({ c }) }, color: "secondary"
    });
    const kb = JSON.stringify({ inline: true, buttons: [[
        btn("Нет", "ged:ign"),
        btn("Да", "ged:rep"),
        ...(hasSomeTree ? [btn("Да, с резервом", "ged:bak")] : []),
    ]] });
    await messagesSend(peerId, "🧬 Файл " + name + ": персон " + s.persons + ", семей " + s.fams
        + ", детей " + s.links + ". Заменить события чата деревом?", msgId, convMsgId, kb);
}

// дроп .txt-документа с родословной росписью -+=: в ответе на триггер —
// применить сразу (ветвь цитируемого срезана, роспись привита);
// просто дроп — те же 3 кнопки «Да/Нет/Да, с резервом», что у .ged (ТГ: txtDrop)
async function handleTxtDrop(peerId, doc, msgId, convMsgId, fromId, replyMsg) {
    const name = doc.title || "пачка.ged.txt";
    let text;
    try {
        text = await fetchDocText(doc.url);
    } catch (e) {
        console.error("txt download:", e.message);
        await messagesSend(peerId, "💥 Не удалось скачать файл " + name + " (трижды; повторите написанием файла в чат)", msgId, convMsgId);
        return;
    }
    const tree = parseTree(text);
    if (!tree.persons.length && !tree.errors.length) {
        await messagesSend(peerId, "💥 Не удалось разобрать файл " + name + " (ждём пачку «плоское древо»)", msgId, convMsgId);
        return;
    }
    const rh = replyMsg && replyMsg.from_id > 0
        ? String(replyMsg.text || "").match(/^(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/) : null;
    if (rh) {
        // в ответе на триггер — резка-прививка: цитируемый — герой росписи
        let anchor = null;
        const sh = recordShownOf(peerId, rh[1].trim() + " " + rh[2]);
        if (sh) anchor = sh.n + " " + sh.d;
        if (!anchor) {
            // цитата на триггера не нашлась — добавлять молча нельзя: так
            // роспись применилась бы целиком (мимо героя)
            await messagesSend(peerId, "💥 В ответе — не триггер: пачка не применена. Герой ветви должен быть «Имя ГГГГ-ММ-ДД» из древа чата.", msgId, convMsgId);
            console.log("txt drop reply: триггера нет, мимо, peer", peerId);
            return;
        }
        const rep = cutAndGraft(peerId, anchor, tree);
        await messagesSend(peerId, treeReport(rep), msgId, convMsgId);
        console.log("txt tree:", rep.cut !== undefined ? "срезано " + rep.cut + ", " : "", rep.persons, "персон,", rep.links, "детей, peer", peerId);
        return;
    }
    gedPending.set(peerId, { name, text, fromId, ts: Date.now() });
    // «Да, с резервом» — только при непустом дереве чата (fam/chil есть,
    // бездатное древо тоже резервировать можно)
    const hasSomeTree = hasTree(peerId);
    const btn = (label, c) => ({
        action: { type: "callback", label, payload: JSON.stringify({ c }) }, color: "secondary"
    });
    const kb = JSON.stringify({ inline: true, buttons: [[
        btn("Нет", "ged:ign"),
        btn("Да", "ged:rep"),
        ...(hasSomeTree ? [btn("Да, с резервом", "ged:bak")] : []),
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
function focusText(peerId, key, radius, bell, dd, byFull = false) {
    const pairs = linkPairs(peerId);
    const spPairs = focusSpousePairs(peerId);
    const sexMap = new Map(personRows(peerId).map(r => [pkey(r), r.sex ?? null]));
    // fynny-ромб (супруги — по лимиту слов ярлыка) един и для списка, и для
    // гедком-фрагмента: на r1 супруги детей для связности не нужны (черточки
    // свадеб и точки ДР детей рисуются из fam-данных), на r2 «жена сына»
    // (2 слова) влезает — связность сохраняется; радиус 5 — без лимита
    const keys = focusListKeys(pairs, spPairs, key, radius, k => sexMap.get(k) ?? null, bell);
    const items = [...personRows(peerId), ...weddingRows(peerId)];
    // 🔔-список — без примерных дат (список оповещений); гедком/дамп — как есть
    const bellItems = byFull ? items : items.filter(r => !r.abt && !r.dabt && !r.mabt);
    // круговой порядок «от сегодня» (МСК) — ось сортировки списка; MM-DD
    const { mo, d: dToday } = mskNowParts();
    const mmdd = String(mo).padStart(2, "0") + "-" + String(dToday).padStart(2, "0");
    const body = bell
        ? (focusListText(bellItems, keys, key, pairs, spPairs, k => sexMap.get(k) ?? null, byFull, mmdd, radius)
            || "(в радиусе нет событий)")
        : gedcomText(peerId, keys);
    return focusHead(key, radius, dd) + "\n" + body;
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
async function handleMessage(peerId, text, date, msgId, convMsgId, fromId = 0, payload = "", replyMsg = null) {
    if (process.env.LOG_UPDATES) console.log("msg from", peerId, ":", text);
    if (text.trim().startsWith("/")) console.log("команда:", JSON.stringify(text.trim()), "peer", peerId);
    if (date) markSeen(date);
    if (isStart(text, payload)) {
        // «/» ответом на триггер — фокус-сообщение с радиусом родни
        // (заголовок фокуса «2 Имя ГГГГ-ММ-ДД» — цифру радиуса снимаем)
        const rh = replyMsg && replyMsg.from_id > 0
            ? String(replyMsg.text || "").match(/^(?:\d\s+)?(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/) : null;
        if (rh) {
            const key = rh[1].trim() + " " + rh[2];
            const rec = recordShownOf(peerId, key);
            if (rec) {
                await sendFocus(peerId, rec.n + " " + rec.d, msgId, convMsgId, fromId, rec.dd);
                return;
            }
        }
        let kb;
        if (peerId < 2000000000) kb = relKeyboard(peerId);
        else kb = (await isChatAdmin(peerId, fromId)) ? ownerKeyboard() : bellKeyboard();
        await messagesSend(peerId, HELP, msgId, convMsgId, kb);
        return;
    }
    const t = text.trim().toLowerCase();
    const gm = t.match(/^\/gedcom([1-5])?(?:@\S+)?$/);
    if (gm) {
        const radius = Number(gm[1]) || 1;
        // ответом на триггер — только текст родни выбранного радиуса, без кнопок
        // (заголовок фокуса «2 Имя ГГГГ-ММ-ДД» — цифру радиуса снимаем)
        const grh = replyMsg && replyMsg.from_id > 0
            ? String(replyMsg.text || "").match(/^(?:\d\s+)?(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/) : null;
        if (grh) {
            const key = grh[1].trim() + " " + grh[2];
            const rec = recordShownOf(peerId, key);
            if (rec) {
                const skey = rec.n + " " + rec.d; // показанный ключ → хранимый
                const sexMap = new Map(personRows(peerId).map(r => [pkey(r), r.sex ?? null]));
                const keys = focusListKeys(linkPairs(peerId), focusSpousePairs(peerId),
                    skey, radius, k => sexMap.get(k) ?? null);
                await sendGedArtifacts(peerId, keys, focusHead(skey, radius, rec.dd), msgId, convMsgId, skey);
                console.log("focus text:", skey, "радиус", radius, "peer", peerId);
                return;
            }
        }
        if (!hasTree(peerId)) { await messagesSend(peerId, "связей пока нет", msgId, convMsgId); return; }
        // чат-кейс: «🧬⏳» ответом с цитатой на команду, затем .ged+.pdf
        // (при переливе росписи ещё и .ged.txt) комбинированной правкой цепляются
        // в то же сообщение — часы сняты, остаётся «🧬»
        await sendGedArtifacts(peerId, undefined, "Древо чата", msgId, convMsgId);
        return;
    }
    // /bellN (в ответ на триггер): список родни в радиусе N — как тап 🔔 на
    // фокусе; без триггера — весь список чата (как 🔔 чата), не влезает —
    // отрезаем (целые строки)
    const bm = t.match(/^\/bell([1-5])?(?:@\S+)?$/);
    if (bm) {
        const radius = Number(bm[1]) || 1;
        const brh = replyMsg && replyMsg.from_id > 0
            ? String(replyMsg.text || "").match(/^(?:\d\s+)?(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/) : null;
        if (brh) {
            const key = brh[1].trim() + " " + brh[2];
            const rec = recordShownOf(peerId, key);
            if (rec) {
                const skey = rec.n + " " + rec.d; // показанный ключ → хранимый
                // как тап: радиус не глубже имеющихся связей
                const r = Math.min(radius, Math.max(1, focusDepth(linkPairs(peerId), focusSpousePairs(peerId), skey)));
                const txt = focusText(peerId, skey, r, true, rec.dd, false);
                await messagesSend(peerId, txt, msgId, convMsgId);
                console.log("bell text:", skey, "радиус", r, "peer", peerId);
                return;
            }
        }
        const { mo, d: dToday } = mskNowParts();
        const list = upcomingEvents(peerId, false,
            String(mo).padStart(2, "0") + "-" + String(dToday).padStart(2, "0"));
        // как у 🔔 чата: список «от сегодня» одним сообщением — что не
        // влезает, отрезаем (целые строки)
        const shownList = cutLines(list || "", 4000);
        await messagesSend(peerId, shownList || "Событий нет", msgId, convMsgId);
        console.log("bell chat:", (list ? list.split("\n").length : 0) + "->" + shownList.split("\n").length, "строк, peer", peerId);
        return;
    }
    // «/links» (в ТГ — кнопка 🔗 под событием): роспись ВЕТВИ героя — как тап
    // «-+=» на фокусе (>4000 — вложением); без reply / не на триггер — роспись
    // древа чата (листинг сообщений-связей не восстанавливается)
    if (t === "/links" || t === "связи") {
        const lrh = replyMsg && replyMsg.from_id > 0
            ? String(replyMsg.text || "").match(/^(?:\d\s+)?(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/) : null;
        let key = null, head = "";
        if (lrh) {
            const rk = lrh[1].trim() + " " + lrh[2];
            const rec = recordShownOf(peerId, rk);
            if (rec) { key = rec.n + " " + rec.d; head = focusHead(key, 1, rec.dd); } // показанный ключ → хранимый
            else key = null; // ответ не на триггер — вся роспись
        }
        const pack = key ? branchFlatText(peerId, key) : chatFlatText(peerId);
        if (!pack) { await messagesSend(peerId, key ? "ветвь пуста" : "связей пока нет", msgId, convMsgId); return; }
        if (!key) {
            // роспись радиуса — ВСЕГДА файлом (зеркало ТГ sendFlatPack key=null):
            // «-+=⏳» ответом с цитатой на команду (⏳ = «выполняю, подождите»),
            // затем ОДНА комбинированная правка того же сообщения — часы
            // сняты, метка «-+=» и файл в нём же (комбинированная правка
            // message+attachment по message_id применяет и текст, и вложение;
            // цитата при ней исчезает — принято); повтор при ошибке; провал
            // выкладки — текстовая правка «💥». Метка NOT_FOR_GRAFT —
            // первой строкой файла (роспись радиуса прививке не подлежит)
            const sent = await messagesSend(peerId, "-+=⏳", msgId, convMsgId);
            void sendChatFlatArtifacts(peerId, pack, { message_id: sent }, null, "links");
        } else if (pack.length >= 4000) {
            // голова + ✂️⏳ первым сообщением (полное — в файле); ВСЯ роспись —
            // файлом асинхронно: upload долгий, ответ — сразу; файл правкой
            // приклеивается к тому же сообщению (⏳ снят, ✂️ остаётся),
            // мимо — отдельным сообщением
            const head0 = head || "Древо чата";
            // перелив: порядок строк — герой, метка (правило у NOT_FOR_GRAFT)
            const ngHead0 = head0 + "\n" + NOT_FOR_GRAFT;
            const sent = await messagesSend(peerId, ngHead0 + "\n✂️⏳", msgId, convMsgId);
            (async () => {
                try {
                    // ветвь — полная роспись («-+=») без метки; древо чата метку
                    // уже несёт (chatFlatText)
                    const att = await vkUploadDoc(peerId,
                        fileBaseOf(head0) + ".ged.txt", "\uFEFF" + pack);
                    try {
                        await vkApi("messages.edit", {
                            peer_id: peerId, message_id: sent, attachment: att });
                        // правка без attachment сбрасывает вложения — повторяем
                        await vkApi("messages.edit", {
                            peer_id: peerId, message_id: sent, attachment: att,
                            message: ngHead0 + "\n✂️" });
                    } catch (e) {
                        console.error("links edit:", e.message, "— отношу файлом");
                        try { await vkApi("messages.edit", {
                            peer_id: peerId, message_id: sent, message: ngHead0 + "\n✂️" }); } catch {}
                        await messagesSend(peerId, head0, msgId, convMsgId, null, att);
                    }
                    console.log("links doc:", att, "peer", peerId);
                } catch (e) { console.error("links doc upload:", e.message); }
            })();
        } else {
            await messagesSend(peerId, (head ? head + "\n" : "") + pack, msgId, convMsgId);
        }
        console.log("links flat pack:", key || "chat", "peer", peerId);
        return;
    }
    // /Иван — префиксный поиск по родословной росписи -+= (/-Пётр — только
    // мужчины глубины 0, /--Иван — глубины 1, /=… — женщины); "/ текст" —
    // подстрока. Пусто — справка. (ТГ: handlers/message.js; логика — flatSearch)
    if (text.trim().startsWith("/")) {
        const q = text.trim();
        const hits = flatSearch(chatFlatText(peerId), q);
        if (hits.length) {
            // ровно одно попадание, резолвящееся в персону, — сжатый юбилей
            // с клавиатурой-юбилеем (триггера нет — реплаить не на что, новое
            // сообщение); нерезолвимое (свадьба, заглушка, тёзки) —
            // списком/файлом как прежде
            if (hits.length === 1) {
                const key = flatHitKey(hits[0], personRows(peerId));
                const rec = key ? recordOf(peerId, key) : null;
                if (rec) {
                    await sendJubileeMsg(peerId, rec, "", msgId, convMsgId, fromId);
                    console.log("flat search:", JSON.stringify(q), "-> юбилей", key, "peer", peerId);
                    return;
                }
            }
            console.log("результат готов:", hits.length, "строк");
            // частые имена (Андрей) длиннее лимита ВК — файлом, как /links
            // (ТГ: sendLong делает то же)
            const found = hits.join("\n");
            if (found.length >= 4000) {
                // заголовок + ✂️⏳, ВЕСЬ список — файлом асинхронно (upload
                // долгий, ответ — сразу); файл правкой в то же сообщение
                // (⏳ снят, ✂️ остаётся)
                const head = searchHead(q, hits.length);
                // целые строки до ~4000 знака — в текст (как у 🧬-перелива),
                // остальное — в файл; текст — только метка (без «Найдено…»),
                // имя файла — из head; ✂️⏳ → после прицепа ✂️ (⏳ снят)
                const inner = cutLines(found, 4000, NOT_FOR_GRAFT.length + 1);
                const holdTxt = NOT_FOR_GRAFT + (inner ? "\n" + inner : "") + "\n✂️⏳";
                const finalTxt = NOT_FOR_GRAFT + (inner ? "\n" + inner : "") + "\n✂️";
                const sent = await messagesSend(peerId, holdTxt, msgId, convMsgId);
                holdAttach(peerId, "search", sent, holdTxt, finalTxt,
                    fileBaseOf(head) + ".txt", "\uFEFF" + withGraftMark(found),
                    null, head, msgId, convMsgId);
            } else {
                await messagesSend(peerId, NOT_FOR_GRAFT + "\n" + found, msgId, convMsgId);
            }
            return;
        }
        let kb;
        if (peerId < 2000000000) kb = relKeyboard(peerId);
        else kb = (await isChatAdmin(peerId, fromId)) ? ownerKeyboard() : bellKeyboard();
        await messagesSend(peerId, HELP, msgId, convMsgId, kb);
        return;
    }
    // цитата для родословной росписи -+=: ветвь цитируемого срезана, роспись привита
    const replyHead = replyMsg && replyMsg.from_id > 0
        ? String(replyMsg.text || "").match(/^(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/) : null;
    // сообщение-гедком → замена древа (до разбора триггеров); не пустой чат —
    // сначала автоматический резерв прежнего дерева файлом
    const g = parseGedcom(text);
    if (g) {
        const st = gedStats(g);
        if (st.persons || st.links) {
            const r = await replaceWithGedcom(peerId, g, true);
            await messagesSend(peerId, r.head, msgId, convMsgId);
            return;
        }
        // гедком без персон с датами — молчим, дальше как триггеры
    }
    // родословная роспись -+=: строки с маркерами '-'/'=' (глубина), «+дата»/«+»
    // (свадьбы) и безмарковыми именами вторых половин — весь разбор одним
    // сообщением; в ответе сводка + ошибки построчно. В ответе на триггер —
    // резка-прививка: ветвь цитируемого срезана, роспись (герой = цитируемый,
    // ветвь целиком) привита; мимо цитаты — добавление merger'ем. (ТГ: handlers/message.js)
    const lines0 = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines0.some(l => /^[-+=]/.test(l))) {
        const tree = parseTree(text);
        if (tree.persons.length || tree.errors.length) {
            // в ответе на триггер — ветвь цитируемого заменяется росписью
            let anchor = null;
            if (replyHead) {
                const sh = recordShownOf(peerId, replyHead[1].trim() + " " + replyHead[2]);
                if (sh) anchor = sh.n + " " + sh.d;
            }
            const rep = anchor ? cutAndGraft(peerId, anchor, tree) : applyTree(peerId, tree);
            const body = treeReport(rep);
            await messagesSend(peerId, body, msgId, convMsgId);
            console.log("tree:", rep.cut !== undefined ? "срезано " + rep.cut + ", " : "", rep.persons, "персон,", rep.fams, "семей,", rep.links, "детей,", rep.errors.length, "ошибок, peer", peerId);
            return;
        }
    }
    // поштучного ввода детей больше нет: ребёнок/ветвь добавляется родословной
    // росписью -+= в ответе на героя (cutAndGraft выше)
    const lines = String(text).split(/\s*\n+\s*/).filter(Boolean);
    // точечная правка: одна строка без маркера в ответе на триггер (сообщение
    // пользователя) — ПОЛНАЯ замена записи цитируемого (пол не трогается,
    // ветвь и связи целы); якорь не персона — правки нет, обычный ввод
    // (ТГ-копия: tgcloud/handlers/message.js)
    if (lines.length === 1 && replyHead) {
        const parsed = parseTrigger(lines[0]);
        if (parsed && !parsed.error) {
            const sh = recordShownOf(peerId, replyHead[1].trim() + " " + replyHead[2]);
            const anchor = sh ? sh.n + " " + sh.d : "";
            const ed = editTrigger(peerId, anchor,
                Object.assign({}, parsed.rec, parsed.tail ? { note: parsed.tail } : {}));
            if (ed) {
                if (ed.error) {
                    await messagesSend(peerId, "💥 " + lines[0] + "\n" + ed.error, msgId, convMsgId);
                    return;
                }
                await sendJubileeMsg(peerId, ed.rec, parsed.note, msgId, convMsgId, fromId);
                console.log("edit:", anchor, "->", ed.rec.n, ed.rec.d, "peer", peerId);
                return;
            }
        }
    }
    for (const line of lines) {
        const parsed = parseTrigger(line);
        if (!parsed) continue; // не триггер — молчим
        if (parsed.error) {
            await messagesSend(peerId, "💥 " + line + "\n" + parsed.error, msgId, convMsgId);
            continue;
        }
        upsertPerson(peerId, parsed.rec);
        await sendJubileeMsg(peerId, parsed.rec, parsed.note, msgId, convMsgId, fromId);
        console.log("record:", parsed.rec.n, parsed.rec.d, "peer", peerId);
    }
}

// резерв прежнего дерева чата файлом <имя>-old.ged (фолбэк — текстом);
// true — выложен (или чат пуст), false — не смогли (замена отменяется)
async function sendTreeBackup(peerId) {
    if (!q1("SELECT xref FROM indi WHERE chat=? AND birt_d IS NOT NULL LIMIT 1", peerId)) return true;
    const g = gedcomText(peerId);
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
    sq().exec("BEGIN");
    try {
        const r = importGedcom(peerId, g);
        sq().exec("COMMIT");
        return { ok: true, head: treeReport(r) };
    } catch (e) {
        sq().exec("ROLLBACK");
        throw e;
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

async function handleEvent(o) {
    const p = unpay(o.payload);
    const peerId = o.peer_id;
    console.log("кнопка:", JSON.stringify(p), "peer", peerId);
    // кнопки фокус-сообщения: радиус родни 1–5, 🔔/🧬 в радиусе, «-+=» ветвь
    if (p && typeof p === "object" && (p.c === "foc" || p.c === "foc:bell" || p.c === "foc:tree" || p.c === "foc:flat")) {
        // герой — по сообщению (findRecordByCmid), не по payload-ключу:
        // свадьба «Имя+Имя Д» и старый стиль/примерные даты по ключу мимоходили
        const rec = await findRecordByCmid(peerId, o.conversation_message_id);
        if (!rec) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "персона не найдена");
            return;
        }
        const key = pkey(rec);
        const depth = focusDepth(linkPairs(peerId), focusSpousePairs(peerId), key);
        // радиус не глубже имеющихся предков (старые сообщения могут нести снятые кнопки)
        const radius = Math.min(5, Math.max(1, Number(p.r) || 1), Math.max(1, depth));
        await answerEvent(o.event_id || o.id, o.user_id, peerId,
            p.c === "foc" ? focusLabel(radius)
                : (p.c === "foc:bell" ? "список " : (p.c === "foc:flat" ? "пачка ветви " : "древо ")) + focusLabel(radius));
        // 🧬 в радиусе: <имя>.ged + <имя>.pdf (диаграмма — родство к герою)
        // и <имя>.ged.txt — роспись радиуса («-+=» печатает только вниз, тут и
        // вверх, в пределах радиуса); правка не нужна — файлы отдельным сообщением
        if (p.c === "foc:tree") {
            const sexMap = new Map(personRows(peerId).map(r => [pkey(r), r.sex ?? null]));
            const keys = focusListKeys(linkPairs(peerId), focusSpousePairs(peerId),
                key, radius, k => sexMap.get(k) ?? null);
            await sendGedArtifacts(peerId, keys, focusHead(key, radius, rec.dd), 0, o.conversation_message_id, key,
                o, await focusKeyboard(peerId, o.user_id, key, radius, depth));
            return;
        }
        // «-+=» на фокусе: роспись ВЕТВИ героя (.ged.txt) — вся глубина, герой
        // первой строкой; реплай правленной росписью на цитату заменяет ветвь
        if (p.c === "foc:flat") {
            const pack = branchFlatText(peerId, key);
            if (!pack) { await answerEvent(o.event_id || o.id, o.user_id, peerId, "ветвь пуста"); return; }
            const kb = await focusKeyboard(peerId, o.user_id, key, radius, depth);
            const txt = focusHead(key, radius, rec.dd) + "\n" + pack;
            if (txt.length < 4000) { await editOrigin(o, txt, kb); return; }
            // перелив: держ = голова, метка, обрезанные целые строки росписи
            // (до ~4000) и ✂️⏳ в конце; роспись — файлом, после прицепа — тот
            // же текст со ✂️ без часов (правка текста обязательно с
            // повторным attachment — ВК сбрасывает вложения у правки без них)
            const fh = focusHead(key, radius, rec.dd);
            const inner = cutLines(pack, 4000, fh.length + 1 + NOT_FOR_GRAFT.length + 1);
            const holdTxt = fh + "\n" + NOT_FOR_GRAFT + "\n" + inner + "\n✂️⏳";
            const finalTxt = fh + "\n" + NOT_FOR_GRAFT + "\n" + inner + "\n✂️";
            await editOrigin(o, holdTxt, kb);
            try {
                const att = await vkUploadDoc(o.peer_id,
                    fileBaseOf(fh) + ".ged.txt", "\uFEFF" + pack);
                try {
                    await vkApi("messages.edit", {
                        peer_id: peerId, conversation_message_id: o.conversation_message_id,
                        attachment: att, keyboard: kb });
                    await vkApi("messages.edit", {
                        peer_id: peerId, conversation_message_id: o.conversation_message_id,
                        attachment: att, keyboard: kb, message: finalTxt });
                } catch (e2) {
                    console.error("foc:flat edit:", e2.message, "— отношу файлом");
                    try { await editOrigin(o, finalTxt, kb); } catch {}
                    await messagesSend(peerId, finalTxt, 0, 0, kb, att);
                }
                console.log("foc:flat doc:", att, "peer", peerId);
            } catch (e) {
                console.error("foc:flat doc upload:", e.message);
                await sendTailDoc(peerId, pack, fileBaseOf(fh), ".ged.txt", o.conversation_message_id);
            }
            return;
        }
        const bell = p.c === "foc:bell" || p.c === "foc";
        // список всегда по ММ-ДД (сортировка подписки касается только дампа)
        const byFull = false;
        // цифра меняет радиус и сразу показывает список (как 🔔); тело — по 🔔
        const txt = focusText(peerId, key, radius, bell, rec.dd, byFull);
        const kb = await focusKeyboard(peerId, o.user_id, key, radius, depth);
        if (txt.length < 4000) { await editOrigin(o, txt, kb); return; }
        // список начинается с сегодня — что не влезает в сообщение,
        // просто отрезаем (целые строки, после заголовка)
        const head = focusHead(key, radius, rec.dd);
        const tail = cutLines(txt.slice(head.length + 1), 4000, head.length + 1, false);
        await editOrigin(o, head + "\n" + tail, kb);
        return;
    }
    // кнопки сообщения-юбилея: 👎 — удалить событие, 👀/🌙 — тоггл
    // детальности (как реакции 👀/снятие, но тапом; клавиатура едина с ТГ).
    // Запись резолвим по сообщению — findRecordByCmid, как у реакций: payload
    // несёт хранимый ключ (старый стиль/примерная дата), а свадьба «Имя+Имя Д»
    // и вовсе не персона — по ключу были ложные «Событие не найдено»
    if (p && typeof p === "object" && (p.c === "del1" || p.c === "det" || p.c === "mon")) {
        const rec = await findRecordByCmid(peerId, o.conversation_message_id);
        if (!rec) { await answerEvent(o.event_id || o.id, o.user_id, peerId, "Событие не найдено"); return; }
        const key = pkey(rec);
        if (p.c === "del1") {
            // связи персоны, свадьба пары «Имя+Имя», висячие кандидаты, семьи
            deleteEventCascade(peerId, key);
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "удалено");
            console.log("кнопка 👎: удалено событие", rec.n, rec.d, "peer", peerId);
            await editOrigin(o, "🗑 Событие удалено: " + rec.n + " " + rec.d,
                JSON.stringify({ inline: true, buttons: [] }));
            return;
        }
        // det — развернуть (кнопка 🌙), mon — сжать обратно (как снятие реакции)
        const detail = p.c === "det";
        const depth = focusDepth(linkPairs(peerId), focusSpousePairs(peerId), key);
        await answerEvent(o.event_id || o.id, o.user_id, peerId, detail ? "подробно" : "сжато");
        await editOrigin(o, jubileeText(rec, "", detail),
            await jubileeKeyboard(peerId, o.user_id, key, depth, detail, rec.n.includes("+")));
        return;
    }
    // кнопки сообщения-связи: пол нового лица, свадьба, усыновление, удаление
    if (p && typeof p === "object" && (p.c === "sex" || p.c === "pair" || p.c === "adop" || p.c === "dell")) {
        const link = linkById(peerId, p.l);
        if (!link) { await answerEvent(o.event_id || o.id, o.user_id, peerId, "связь не найдена"); return; }
        let snack = "";
        if (p.c === "sex") {
            const x = xrefOfKey(peerId, link[link.who]);
            if (x) qr("UPDATE indi SET sex=? WHERE chat=? AND xref=?", p.s === "F" ? "F" : "M", peerId, x);
            snack = "пол: " + (p.s === "F" ? "♀" : "♂");
        } else if (p.c === "adop") {
            const cx = xrefOfKey(peerId, link.c);
            const cur = link.fam && cx
                ? !!(q1("SELECT adopted AS a FROM chil WHERE chat=? AND fam=? AND indi=?", peerId, link.fam, cx) || {}).a
                : false;
            if (link.fam && cx)
                qr("UPDATE chil SET adopted=? WHERE chat=? AND fam=? AND indi=?", cur ? 0 : 1, peerId, link.fam, cx);
            snack = !cur ? "🤱 усыновление" : "усыновление снято";
        } else if (p.c === "dell") {
            const head = "🔗 Связь удалена: " + link.p + " → " + link.c;
            deleteLink(peerId, link);
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "связь удалена");
            const rec = await findRecordByCmid(peerId, o.conversation_message_id);
            await editOrigin(o, (rec ? jubileeText(rec, "") + "\n" : "") + head, JSON.stringify({ inline: true, buttons: [] }));
            return;
        } else {
            const i = Number(p.i);
            let fragKeys = [link.p, link.c];
            if (i >= 0 && link.pairCand && link.pairCand[i]) {
                const f = confirmPair(peerId, link, link.pairCand[i]);
                snack = f && f.marr ? "💍 " + f.marr.d + (f.marr.plac ? ", " + f.marr.plac : "") : "не найдено";
                if (f) fragKeys = [...f.parents, ...f.children]; // все трое
            } else {
                setLinkCand(link, null);
                snack = "без свадьбы";
            }
            await answerEvent(o.event_id || o.id, o.user_id, peerId, snack);
            const fresh = linkById(peerId, link.id) || link;
            await editOrigin(o, linkText(peerId, fresh) + "\n" + gedcomText(peerId, fragKeys), linkKeyboard(peerId, fresh));
            return;
        }
        await answerEvent(o.event_id || o.id, o.user_id, peerId, snack);
        // sex/adop: фрагмент — новое лицо (с полом) либо родитель+ребёнок
        const fresh = linkById(peerId, link.id) || link;
        const fragKeys = p.c === "sex" ? [fresh[fresh.who]] : [fresh.p, fresh.c];
        await editOrigin(o, linkText(peerId, fresh) + "\n" + gedcomText(peerId, fragKeys), linkKeyboard(peerId, fresh));
        return;
    }
    // нормализуем: {c} / {rel} либо строка "del" / "del:yes" / "rel:orth"
    const payload = typeof p === "object" ? (p.rel ? "rel:" + p.rel : String(p.c ?? "")) : p;
    console.log("event:", payload, "peer", peerId);
    if (!["del", "del:yes", "del:no", "bell", "flat", "tree", "close", "ged:rep", "ged:bak", "ged:ign"].includes(payload) && !payload.startsWith("rel:")) {
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "неизвестная кнопка");
        return;
    }
    // 🗑/❌ в групповом чате — только админ беседы или создатель сообщества
    if (peerId >= 2000000000 && ["del", "del:yes", "del:no"].includes(payload) && !(await isChatAdmin(peerId, o.user_id))) {
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "только владелец");
        return;
    }
    // «Нет / Да / Да, с резервом» на дроп .ged: замена или отказ
    // (в группе — только отправивший файл)
    if (payload === "ged:rep" || payload === "ged:bak" || payload === "ged:ign") {
        const pend = gedPending.get(peerId);
        if (!pend || Date.now() - pend.ts > GED_TTL) {
            gedPending.delete(peerId);
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "файл не найден — перешлите .ged заново");
            return;
        }
        if (peerId >= 2000000000 && o.user_id !== pend.fromId) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "только отправивший файл");
            return;
        }
        gedPending.delete(peerId);
        // тост сразу: event_id у ВК живёт секунды, а замена большого древа
        // идёт дольше — поздний answerEvent ВК отвергает (100 invalid
        // event_id), и «вращение» висит на кнопке до конца работы
        await answerEvent(o.event_id || o.id, o.user_id, peerId,
            payload === "ged:ign" ? "не добавлено" : "идёт замена древа…");
        // роспись .ged.txt: ЗАМЕНА дерева чата (с резервом — прежнее дерево файлом)
        if (/\.ged\.txt$/i.test(pend.name)) {
            if (payload === "ged:bak" && !(await sendTreeBackup(peerId))) {
                await editOrigin(o, "💥 Не удалось выложить резерв — замена отменена, прежнее дерево цело",
                    JSON.stringify({ inline: true, buttons: [] }));
                return;
            }
            clearChatTree(peerId);
            const rep = applyTree(peerId, parseTree(pend.text), null);
            await editOrigin(o, treeReport(rep), JSON.stringify({ inline: true, buttons: [] }));
            console.log("txt replace:", rep.persons, "персон,", rep.links, "детей, peer", peerId);
            return;
        }
        if (payload === "ged:ign") {
            await editOrigin(o, "Файл не добавлен: " + pend.name, JSON.stringify({ inline: true, buttons: [] }));
            return;
        }
        const g = parseGedcom(pend.text);
        if (!g) {
            await editOrigin(o, "Файл не добавлен: " + pend.name + " (ждём GEDCOM в UTF-8)", JSON.stringify({ inline: true, buttons: [] }));
            return;
        }
        const r = await replaceWithGedcom(peerId, g, payload === "ged:bak");
        await editOrigin(o, r.head, JSON.stringify({ inline: true, buttons: [] }));
        console.log("ged replace:", r.head, "peer", peerId);
        return;
    }
    if (payload === "del") {
        // подтверждение: список событий чата по полной дате ГГГГ-ММ-ДД + 🗑/❌
        // (🗑-радиус снят: удаление — только глобальное)
        const list = upcomingEvents(peerId, true); // по полной дате, со смертями
        if (!list) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "событий нет");
            return;
        }
        const head = "Удалить все события чата?";
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "подтвердите удаление");
        const kb = JSON.stringify({
            inline: true,
            buttons: [[
                { action: { type: "callback", label: "🗑", payload: JSON.stringify({ c: "del:yes" }) }, color: "secondary" },
                { action: { type: "callback", label: "❌", payload: JSON.stringify({ c: "del:no" }) }, color: "secondary" }
            ]]
        });
        // длинный список — голова + ✂️⏳, весь список — одним .txt-вложением
        // в это же сообщение (как «-+=» и .ged/.pdf), потом ⏳ снят (✂️ остаётся)
        if ((head + "\n" + list).length >= 4000) {
            const head0 = (head + "\n" + list).split("\n")[0];
            await editOrigin(o, NOT_FOR_GRAFT + "\n" + head0 + "\n✂️⏳", kb);
            await editOriginDoc(o, fileBaseOf(head0) + ".txt",
                "\uFEFF" + withGraftMark(head + "\n" + list), kb);
            try { await editOrigin(o, NOT_FOR_GRAFT + "\n" + head0 + "\n✂️", kb); } catch {}
            return;
        }
        await editOrigin(o, head + "\n" + list, kb);
    } else if (payload === "del:yes") {
        // глобальное удаление: дерево чата (персоны/свадьбы/связи/семьи) целиком
        const n = personRows(peerId).length + weddingRows(peerId).length;
        clearChatTree(peerId);
        console.log("deleted", n, "records peer", peerId);
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "удалено событий: " + n);
        await editOrigin(o, "Удалено событий: " + n + "\n" + HELP, await peerKeyboard(peerId, o.user_id));
    } else if (payload === "close") {
        await deleteByCmid(peerId, o.conversation_message_id);
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "закрыто");
    } else if (payload === "del:no") {
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "отмена удаления");
        await editOrigin(o, HELP, await peerKeyboard(peerId, o.user_id));
    } else if (payload === "bell") {
        // список событий (не родословная роспись -+=): всегда рендер по ММ-ДД,
        // без подписного переключения тапом; список начинается с сегодня —
        // что не влезает в сообщение, просто отрезаем (целые строки)
        // «от сегодня» (МСК) — MM-DD
        const { mo, d: dToday } = mskNowParts();
        const list = upcomingEvents(peerId, false,
            String(mo).padStart(2, "0") + "-" + String(dToday).padStart(2, "0"));
        if (!list) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "событий нет");
            return;
        }
        // снекбар останавливает «вращение» на кнопке
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "список событий");
        const shownList = cutLines(list, 4000);
        await editOrigin(o, shownList || "Событий нет", await peerKeyboard(peerId, o.user_id));
    } else if (payload === "flat") {
        // «-+=» — родословная роспись -+= древа чата: файлами .ged.txt и .ged.csv (зеркало ТГ:
        // sendFlatPack key=null) — правка этого сообщения «-+=⏳», вложение
        // правкой в него же (editOrigin без attachment сбросил бы вложение),
        // потом держатель → «-+=» (видимая метка — цитата живёт); клавиатура
        // (kb0) остаётся на сообщении; провал — правка «💥». Метка
        // NOT_FOR_GRAFT — первой строкой файла
        const flat = chatFlatText(peerId);
        if (!flat) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "древо пусто");
            return;
        }
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "пачка древа чата");
        const kb0 = await peerKeyboard(peerId, o.user_id);
        try {
            await editOrigin(o, "-+=⏳", kb0);
            await sendChatFlatArtifacts(peerId, flat,
                { conversation_message_id: o.conversation_message_id }, kb0);
        } catch (e) {
            console.error("flat doc:", e.message);
            await editOrigin(o, "💥 Не удалось выложить файл «Древо чата.ged.txt»", kb0);
        }
    } else if (payload === "tree") { // 🧬 — гедком-древо чата (как /gedcom)
        if (!hasTree(peerId)) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "связей пока нет");
            return;
        }
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "гедком-древо чата");
        await sendGedArtifacts(peerId, undefined, "Древо чата", 0, o.conversation_message_id, null,
            o, await peerKeyboard(peerId, o.user_id));
    } else if (payload.startsWith("rel:")) {
        const key = payload.slice(4);
        if (!REL_DEFS[key]) return;
        const head = REL_DEFS[key].icon + " " + REL_DEFS[key].name + " дни";
        // календарь уже показан в этом сообщении (заголовок совпадает) — toggle,
        // иначе первый тап: показать календарь
        const cur = await cmidText(peerId, o.conversation_message_id);
        const shown = cur !== null && cur.split("\n", 1)[0] === head;
        if (shown) {
            const on = toggleRel(peerId, key);
            // снекбар останавливает «вращение» на кнопке
            await answerEvent(o.event_id || o.id, o.user_id, peerId, on ? "🔔 включены" : "🔕 выключены");
            await editOrigin(o, head + "\n" + religiousYear(key), relKeyboard(peerId));
        } else {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "календарь на год");
            await editOrigin(o, head + "\n" + religiousYear(key), relKeyboard(peerId));
        }
    }
}

// реакции на ответы/уведомления бота; формат события (по факту):
// { reacted_id, peer_id, cmid, reaction_id } — 👎 = 9, 👀 = REACTION_EYES_ID
async function handleReaction(o) {
    const cmid = o.cmid ?? o.conversation_message_id ?? o.message_id;
    if (!cmid) return;
    const peerId = o.peer_id;
    const from = o.reacted_id ?? o.from_id ?? o.user_id;
    if (from <= 0) return; // реакции бота игнорируем

    if (o.reaction_id === undefined) { // снятие реакции — сжать обратно
        const rec = await findRecordByCmid(peerId, cmid);
        if (!rec) {
            console.log("reaction снята: запись не найдена (cmid", cmid, "peer", peerId, ")");
            return;
        }
        try {
            await vkApi("messages.edit", {
                peer_id: peerId, conversation_message_id: cmid,
                message: jubileeText(rec, ""),
                // клавиатура-юбилей возвращается (сжатое состояние, 👀)
                keyboard: await jubileeKeyboard(peerId, from, pkey(rec),
                    focusDepth(linkPairs(peerId), focusSpousePairs(peerId), pkey(rec)), false, rec.n.includes("+"))
            });
            console.log("reaction снята: сжато", rec.n, rec.d, "peer", peerId);
        } catch (e) {
            console.error("reaction collapse:", e.message);
        }
        return;
    }
    if (o.reaction_id === 9) { // 👎 — удалить связь (сообщение-связь) либо событие
        const link = linkByCmid(peerId, cmid);
        if (link) {
            const head = "🔗 Связь удалена: " + link.p + " → " + link.c;
            deleteLink(peerId, link);
            console.log("reaction 👎: удалена связь", link.p, "→", link.c, "peer", peerId);
            // остаётся текст события без строки связи
            const rec = await findRecordByCmid(peerId, cmid);
            try {
                await vkApi("messages.edit", {
                    peer_id: peerId, conversation_message_id: cmid,
                    message: rec ? jubileeText(rec, "") + "\n" + head : head,
                    keyboard: JSON.stringify({ inline: true, buttons: [] })
                });
            } catch (e) {
                console.error("reaction edit:", e.message, "— reply");
                try {
                    await messagesSend(peerId, head, 0, cmid);
                } catch (e2) {
                    console.error("reaction reply:", e2.message);
                }
            }
            return;
        }
        const rec = await findRecordByCmid(peerId, cmid);
        if (!rec) return;
        // связи персоны, свадьба пары «Имя+Имя», висячие кандидаты, семьи
        deleteEventCascade(peerId, pkey(rec));
        console.log("reaction 👎: удалено событие", rec.n, rec.d, "peer", peerId);
        // правим сообщение события в пометку об удалении (реакции сохраняются),
        // при неудаче — reply
        try {
            await vkApi("messages.edit", {
                peer_id: peerId, conversation_message_id: cmid,
                message: "🗑 Событие удалено: " + rec.n + " " + rec.d
            });
        } catch (e) {
            console.error("reaction edit:", e.message, "— reply");
            try {
                await messagesSend(peerId, "🗑 Событие удалено: " + rec.n + " " + rec.d, 0, cmid);
            } catch (e2) {
                console.error("reaction reply:", e2.message);
            }
        }
        return;
    }
    if (REACTION_EYES_ID && o.reaction_id === REACTION_EYES_ID) { // 👀 — детализировать
        const rec = await findRecordByCmid(peerId, cmid);
        if (!rec) {
            console.log("reaction 👀: запись не найдена (cmid", cmid, "peer", peerId, ") — возможно, событие уже удалено");
            return;
        }
        try {
            await vkApi("messages.edit", {
                peer_id: peerId, conversation_message_id: cmid,
                message: jubileeText(rec, "", true),
                // клавиатура-юбилей с 🌙 (сворачивает обратно)
                keyboard: await jubileeKeyboard(peerId, from, pkey(rec),
                    focusDepth(linkPairs(peerId), focusSpousePairs(peerId), pkey(rec)), true, rec.n.includes("+"))
            });
            console.log("reaction 👀: детально", rec.n, rec.d, "peer", peerId);
        } catch (e) {
            console.error("reaction detail:", e.message);
        }
        return;
    }
    // неизвестная реакция: id в лог
    console.log("reaction:", o.reaction_id);
}

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
        ...qa(`SELECT chat, name, birt_d, birt_h, birt_m, deat_d FROM indi
            WHERE birt_d IS NOT NULL AND (birt_abt IS NULL OR birt_abt=0)`)
            .filter(r => newStyleDate(r.birt_d).slice(5, 10) === mmdd)
            .map(r => ({
                chat: r.chat, key: r.name + " " + r.birt_d,
                rec: { n: r.name, d: r.birt_d, ...(r.birt_h !== null ? { h: r.birt_h, m: r.birt_m } : {}), ...(r.deat_d ? { dd: r.deat_d } : {}) },
            })),
        ...qa(`SELECT f.chat, (SELECT name FROM indi i WHERE i.chat=f.chat AND i.xref=f.husb) AS hn,
            (SELECT name FROM indi i WHERE i.chat=f.chat AND i.xref=f.wife) AS wn,
            f.marr_d, f.div_d FROM fam f WHERE f.marr_d IS NOT NULL AND (f.marr_abt IS NULL OR f.marr_abt=0)`)
            .filter(r => newStyleDate(r.marr_d).slice(5, 10) === mmdd)
            .filter(r => r.hn && r.wn)
            .map(r => ({
                chat: r.chat, key: r.hn + "+" + r.wn + " " + r.marr_d,
                rec: { n: r.hn + "+" + r.wn, d: r.marr_d, ...(r.div_d ? { dd: r.div_d } : {}) },
            })),
    ];
    for (const j of jobs) {
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
    sq(); // открыть/создать базу (+ разовая конвертация db.json)
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

if (require.main === module) main().catch(e => { console.error("fatal:", e); process.exit(1); });

// Offline CLI shares the bot adapters, but must never open a persistent store.
module.exports.convertGenealogy = function (mode, text) {
    if (DB_FILE !== ":memory:") throw new Error("Offline conversion requires LR_DB=:memory:");
    try {
        if (mode === "ged2txt") {
            const ged = parseGedcom(text);
            if (!ged) throw new Error("Invalid GEDCOM: expected HEAD and GEDC/INDI/FAM records");
            importGedcom(0, ged);
            const output = chatFlatText(0);
            if (!output) throw new Error("GEDCOM contains no exportable persons");
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
        if (sdb) { sdb.close(); sdb = null; }
    }
};

module.exports.__test = {
    HELP,
    parseTrigger, parseGedcom, gedStats, parseTree, parseTreeLine, applyTree, treeReport,
    focusGraphKeys, focusKeys, focusHasPair, focusWithSpouses, focusListKeys, focusLabel, focusHead,
    focusListText, kinLabel, focusDepth, addLink, deleteLink, pairRecords, confirmPair, linkText, linkPairs,
    personRows, weddingRows, famList, famView, focusSpousePairs, upsertPerson, deleteEventCascade,
    clearChatTree, recordOf, recordAnyOf, chartPdf, chartModel, chartFor, fileBaseOf, b64ToBytes, parseTtf,
    gedcomText, importGedcom, jubileeText, setLinkCand, setLinkCmid, weddingByFx, upsertWedding, linkRowOf,
    chatFlatText, flatTreeText, branchFlatText, subsetBranch, flatRows, flatSearch,
    flatHitPerson, flatHitKey, packToCsv,
    cutAndGraft, setPersonByXref, editTrigger, rootOf, uniqueKeyOf, upcomingEvents, hasTree,
    recordShownOf, newStyleDate, oldStyleDate,
};
