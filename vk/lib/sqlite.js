"use strict";

const { DatabaseSync } = require('node:sqlite');

function createStore(DB_FILE) {
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
        chat INTEGER PRIMARY KEY, config TEXT NOT NULL DEFAULT '{}');
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
        const legacy = ["orth", "islam", "bud", "cath", "jud", "fynny", "trim", "bell"];
        const settingsColumns = () => new Set(sdb.prepare("PRAGMA table_info(settings)").all().map(col => col.name));
        let cols = settingsColumns();
        if (!cols.has("config") || legacy.some(key => cols.has(key))) {
            sdb.exec("BEGIN IMMEDIATE");
            try {
                cols = settingsColumns();
                if (!cols.has("config")) sdb.exec("ALTER TABLE settings ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
                for (const key of legacy) if (cols.has(key)) sdb.exec("ALTER TABLE settings DROP COLUMN " + key);
                sdb.exec("COMMIT");
            } catch (e) {
                sdb.exec("ROLLBACK");
                throw e;
            }
        }
        return sdb;
    }
    const qa = (sql, ...a) => sq().prepare(sql).all(...a);
    const q1 = (sql, ...a) => sq().prepare(sql).get(...a);
    const qr = (sql, ...a) => sq().prepare(sql).run(...a);
    return { sq, qa, q1, qr, close() { if (sdb) { sdb.close(); sdb = null; } } };
}
module.exports = { createStore };
