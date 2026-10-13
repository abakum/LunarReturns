// Мок sdk/db для локальной отладки (dev/repl.mjs / dev/poll.mjs копируют
// в node_modules/sdk). In-memory таблицы, персистентность — dev/db.json
// в формате VK-бота (records/settings, поля peerId/n/d/h/m), маппинг на
// границе persistence: схема и query-билдер работают с chatId/name/date.
import fs from 'node:fs';
import path from 'node:path';

const DB_FILE = process.env.LR_DEV_DB || 'dev/db.json';
const state = { tables: {} };

// events → records (peerId/n/d[, h, m]/id), settings → объект по peerId
function save() {
    const out = { records: [], settings: {} };
    for (const r of tables().events || []) {
        const rec = { peerId: r.chatId, n: r.name, d: r.date };
        if (r.hour !== null && r.hour !== undefined) { rec.h = r.hour; rec.m = r.minute; }
        rec.id = r.id;
        out.records.push(rec);
    }
    for (const s of tables().settings || []) {
        const v = {};
        for (const k of ['orth', 'islam', 'bud', 'cath', 'jud']) if (s[k]) v[k] = true;
        out.settings[String(s.chatId)] = v;
    }
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(out, null, 1) + '\n');
}

function load() {
    try {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (!parsed || typeof parsed !== 'object') return;
        const events = [];
        for (const rec of parsed.records || []) {
            const row = { chatId: rec.peerId, name: rec.n, date: rec.d, hour: rec.h ?? null, minute: rec.m ?? null };
            row.id = rec.id ?? 0;
            events.push(row);
        }
        // id: сохранить числовую монотонность (autoincrement = max+1)
        let maxId = events.reduce((m, r) => Math.max(m, r.id || 0), 0);
        for (const r of events) if (!r.id) r.id = ++maxId;
        state.tables.events = events;
        const settings = [];
        for (const [peer, v] of Object.entries(parsed.settings || {})) {
            const row = { chatId: Number(peer) };
            for (const k of ['orth', 'islam', 'bud', 'cath', 'jud']) row[k] = !!v[k];
            settings.push(row);
        }
        state.tables.settings = settings;
    } catch { /* нет файла или повреждён — пусто */ }
}
load();

const tables = () => state.tables;
const rows = t => (tables()[t.__name] = tables()[t.__name] || []);
const match = cs => r => cs.every(c => c && c.__cond ? r[c.prop] === c.val : true);

// ---- schema DSL ----
class Col {
    constructor(name, opts) { this.__col = name; this.__opts = opts || {}; }
    primaryKey() { return this; }
    notNull() { return this; }
    unique() { return this; }
    default() { return this; }
    deprecated() { return this; }
    generatedAlwaysAs() { return this; }
}
class Idx {
    on() { return this; }
    where() { return this; }
}
const integer = (n, o) => new Col(n, o);
const text = (n, o) => new Col(n, o);
const boolean = (n, o) => new Col(n, o);
const json = (n, o) => new Col(n, o);
const index = () => new Idx();
const uniqueIndex = () => new Idx();
const check = () => new Idx();
const sql = (strings, ...vals) => ({ __sql: strings.join('?'), __vals: vals });

function table(name, cols, extras) {
    const t = { __name: name };
    for (const k of Object.keys(cols)) {
        const c = cols[k];
        c.__prop = k;
        t[k] = c;
    }
    if (extras) { try { extras(t); } catch { /* индексы моку не нужны */ } }
    return t;
}

// ---- query builder ----
const finish = (t, conds) => ({
    async all() { return rows(t).filter(match(conds)).map(r => ({ ...r })); },
    async get() { const a = await this.all(); return a.length ? a[0] : null; },
    async values() { const a = await this.all(); return a.map(Object.values); },
});

const select = () => ({
    from: t => ({
        where: (...cs) => finish(t, cs),
        all: () => finish(t, []).all(),
        get: () => finish(t, []).get(),
        values: () => finish(t, []).values(),
    }),
});

function applyInsert(t, rec) {
    const list = rows(t);
    const conflict = rec.__conflict;
    if (conflict) {
        const props = Array.isArray(conflict.target) ? conflict.target.map(x => x.__prop) : [conflict.target.__prop];
        const found = list.find(r => props.every(p => r[p] === rec[p]));
        if (found) {
            Object.assign(found, conflict.set);
            save();
            return { ...found };
        }
    }
    const maxId = list.reduce((m, r) => Math.max(m, r.id || 0), 0);
    const row = { ...rec };
    delete row.__conflict;
    row.id = maxId + 1;
    list.push(row);
    save();
    return { ...row };
}

const insert = t => ({
    values(v) {
        const rec = { ...v };
        const wrap = row => {
            // .returning().run() — как в реальном sdk: промис с методом run()
            const p = Promise.resolve([row]);
            p.run = () => p;
            return p;
        };
        return {
            onConflictDoUpdate({ target, set }) { rec.__conflict = { target, set }; return this; },
            returning() { return wrap(applyInsert(t, rec)); },
            async run() { applyInsert(t, rec); return { rowsAffected: 1 }; },
        };
    },
});

const update = t => ({
    set(fields) {
        return {
            where: (...cs) => ({
                async run() {
                    const hit = rows(t).filter(match(cs));
                    hit.forEach(r => Object.assign(r, fields));
                    save();
                    return { rowsAffected: hit.length };
                },
            }),
        };
    },
});

const del = t => ({
    where: (...cs) => ({
        async run() {
            const before = rows(t).length;
            tables()[t.__name] = rows(t).filter(r => !match(cs)(r));
            save();
            return { rowsAffected: before - tables()[t.__name].length };
        },
    }),
});

const eq = (col, val) => ({ __cond: true, prop: col.__prop, val });
const db = {
    select, insert, update,
    delete: del,
    $count: async (t, ...cs) => rows(t).filter(match(cs)).length,
};

const ne = () => ({}), gt = () => ({}), gte = () => ({}), lt = () => ({}), lte = () => ({});
const asc = () => ({}), desc = () => ({}), inArray = () => ({});
const not = () => ({});
const and = (...cs) => ({ __cond: true, __and: cs });
const or = (...cs) => ({ __cond: true, __or: cs });
export {
    table, integer, text, boolean, json, index, uniqueIndex, check, sql,
    eq, db, ne, gt, gte, lt, lte, asc, desc, inArray, not, and, or,
};
