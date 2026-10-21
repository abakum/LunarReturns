// Мок sdk/db для локальной отладки (dev/repl.mjs / dev/sync-check.mjs копируют
// в node_modules/sdk). In-memory таблицы, персистентность — JSON-дамп всех
// таблиц (LR_DEV_DB): schema.js и query-билдер работают с ними как есть.
import fs from 'node:fs';
import path from 'node:path';

const DB_FILE = process.env.LR_DEV_DB || 'dev/tg-db.json';
const state = { tables: {} };

function save() {
    fs.mkdirSync(path.dirname(DB_FILE) || '.', { recursive: true });
    const out = {};
    for (const [name, rows] of Object.entries(state.tables)) out[name] = rows;
    fs.writeFileSync(DB_FILE, JSON.stringify(out, null, 1) + '\n');
}

function load() {
    try {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object')
            for (const [name, rows] of Object.entries(parsed))
                if (Array.isArray(rows)) state.tables[name] = rows;
    } catch { /* нет файла или повреждён — пусто */ }
}
load();

const tables = () => state.tables;
const rows = t => (tables()[t.__name] = tables()[t.__name] || []);
const cond = c => {
    if (!c) return () => true;
    if (c.__and) return r => c.__and.every(x => cond(x)(r));
    if (c.__or) return r => c.__or.some(x => cond(x)(r));
    if (c.__cond) return r => r[c.prop] === c.val;
    return () => true;
};
const match = cs => r => cs.every(c => cond(c)(r));

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
    if (rec.__ignore) {
        const props = Array.isArray(rec.__ignoreTarget) ? rec.__ignoreTarget.map(x => x.__prop) : [rec.__ignoreTarget.__prop];
        const found = list.find(r => props.every(p => r[p] === rec[p]));
        if (found) { save(); return null; }
    }
    const maxId = list.reduce((m, r) => Math.max(m, r.id || 0), 0);
    const row = { ...rec };
    delete row.__conflict;
    delete row.__ignore;
    delete row.__ignoreTarget;
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
            onConflictDoNothing({ target }) { rec.__ignore = true; rec.__ignoreTarget = target; return this; },
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
