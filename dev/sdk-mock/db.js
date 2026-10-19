// Мок sdk/db для локальной отладки (dev/repl.mjs / dev/poll.mjs копируют
// в node_modules/sdk). In-memory таблицы, персистентность — dev/db.json
// в формате VK-бота (records/settings, поля peerId/n/d/h/m), маппинг на
// границе persistence: схема и query-билдер работают с chatId/name/date.
import fs from 'node:fs';
import path from 'node:path';

const DB_FILE = process.env.LR_DEV_DB || 'dev/db.json';
const state = { tables: {} };

// events → records (peerId/n/d[, h, m]/id), settings → объект по peerId;
// links/fams — в формате VK-бота (p/c/who/fam, parents/children без JSON)
function save() {
    const out = { records: [], links: [], fams: [], settings: {} };
    for (const r of tables().events || []) {
        const rec = { peerId: r.chatId, n: r.name, d: r.date };
        if (r.hour !== null && r.hour !== undefined) { rec.h = r.hour; rec.m = r.minute; }
        if (r.sex) rec.sex = r.sex;
        if (r.deathDate) rec.dd = r.deathDate;
        if (r.plac) rec.plac = r.plac;
        if (r.plac2) rec.plac2 = r.plac2;
        if (r.srcH !== null && r.srcH !== undefined) { rec.srcH = r.srcH; rec.srcM = r.srcM; }
        if (r.dsrcH !== null && r.dsrcH !== undefined) { rec.dsrcH = r.dsrcH; rec.dsrcM = r.dsrcM; }
        rec.id = r.id;
        out.records.push(rec);
    }
    for (const l of tables().links || []) {
        out.links.push({
            id: l.id, peerId: l.chatId, p: l.parent, c: l.child, who: l.who,
            cmid: 0, fam: l.famId ?? undefined,
            adopted: l.adopted || undefined,
            pairCand: l.pairCand ? JSON.parse(l.pairCand) : undefined,
        });
    }
    for (const f of tables().fams || []) {
        out.fams.push({
            id: f.id, peerId: f.chatId,
            parents: JSON.parse(f.parents), children: JSON.parse(f.children),
            marr: f.marrD ? { d: f.marrD, plac: f.marrPlac || undefined } : undefined,
            div: f.divD ? { d: f.divD, plac: f.divPlac || undefined } : undefined,
        });
    }
    for (const s of tables().settings || []) {
        const v = {};
        for (const k of ['orth', 'islam', 'bud', 'cath', 'jud']) if (s[k]) v[k] = true;
        v.bell = s.bell !== false; // подписка колокольчика (default true)
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
            row.sex = rec.sex ?? null;
            row.deathDate = rec.dd ?? null;
            row.plac = rec.plac ?? null;
            row.plac2 = rec.plac2 ?? null;
            row.srcH = rec.srcH ?? null;
            row.srcM = rec.srcM ?? null;
            row.dsrcH = rec.dsrcH ?? null;
            row.dsrcM = rec.dsrcM ?? null;
            row.id = rec.id ?? 0;
            events.push(row);
        }
        // id: сохранить числовую монотонность (autoincrement = max+1)
        let maxId = events.reduce((m, r) => Math.max(m, r.id || 0), 0);
        for (const r of events) if (!r.id) r.id = ++maxId;
        state.tables.events = events;
        const links = (parsed.links || []).map(l => ({
            chatId: l.peerId, parent: l.p, child: l.c, who: l.who,
            famId: l.fam ?? null,
            pairCand: l.pairCand ? JSON.stringify(l.pairCand) : null,
            adopted: !!l.adopted, id: l.id ?? 0,
        }));
        let maxL = links.reduce((m, r) => Math.max(m, r.id || 0), 0);
        for (const r of links) if (!r.id) r.id = ++maxL;
        state.tables.links = links;
        const fams = (parsed.fams || []).map(f => ({
            chatId: f.peerId,
            parents: JSON.stringify(f.parents || []),
            children: JSON.stringify(f.children || []),
            marrD: f.marr && f.marr.d ? f.marr.d : null,
            marrPlac: f.marr && f.marr.plac ? f.marr.plac : null,
            divD: f.div && f.div.d ? f.div.d : null,
            divPlac: f.div && f.div.plac ? f.div.plac : null,
            id: f.id ?? 0,
        }));
        let maxF = fams.reduce((m, r) => Math.max(m, r.id || 0), 0);
        for (const r of fams) if (!r.id) r.id = ++maxF;
        state.tables.fams = fams;
        const settings = [];
        for (const [peer, v] of Object.entries(parsed.settings || {})) {
            const row = { chatId: Number(peer) };
            for (const k of ['orth', 'islam', 'bud', 'cath', 'jud']) row[k] = !!v[k];
            row.bell = v.bell !== false; // подписка колокольчика (default true)
            settings.push(row);
        }
        state.tables.settings = settings;
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
