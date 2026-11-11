// Run before/after with the same Node version and --output=<JSON path>.
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { parseTree } from '../tgcloud/lib/parse.cjs';

const require = createRequire(new URL('../tgcloud/lib/tree.cjs', import.meta.url));
const counts = { kinBlood: 0, kinLabel: 0 };
const kinship = require('./kinship.cjs');
const measuredKinship = { ...kinship };
for (const name of Object.keys(counts)) measuredKinship[name] = (...args) => {
    counts[name]++;
    return kinship[name](...args);
};
function load(name, overrides) {
    const module = { exports: {} };
    const ref = process.argv.find(a => a.startsWith('--ref='))?.slice(6);
    const source = ref ? execFileSync('git', ['show', ref + ':tgcloud/lib/' + name + '.cjs'], { encoding: 'utf8' })
        : fs.readFileSync(new URL('../tgcloud/lib/' + name + '.cjs', import.meta.url), 'utf8');
    vm.runInNewContext(source, {
        module, require: id => overrides[id] ?? require(id),
    });
    return module.exports;
}
const tree = load('tree', { './kinship.cjs': measuredKinship });
const chart = load('chart', { './tree.cjs': tree, './kinship.cjs': measuredKinship });
const parsed = parseTree(fs.readFileSync(new URL('./fixtures/Romanov_family.ged.txt', import.meta.url), 'utf8'));
if (parsed.errors.length) throw Error(JSON.stringify(parsed.errors));
// Name-only reuses in a flat import refer to the existing dated person.
const keyOf = i => {
    const person = parsed.persons[i];
    const rec = person.rec.d ? person.rec : parsed.persons.find(p => p.rec.n === person.rec.n && p.rec.d)?.rec;
    if (!rec?.d) throw Error('Unresolved profile person: ' + person.rec.n);
    return rec.n + ' ' + rec.d;
};
const romanov = { name: 'romanov', pairs: [], spouses: [], sex: {} };
for (const c of parsed.children) for (const p of [c.m, c.f])
    if (p !== null) romanov.pairs.push([keyOf(p), keyOf(c.c)]);
for (const w of parsed.weddings)
    if (w.m !== null && w.f !== null) romanov.spouses.push([keyOf(w.m), keyOf(w.f)]);
for (let i = 0; i < parsed.persons.length; i++) romanov.sex[keyOf(i)] = parsed.persons[i].sex;
const heroes = ['Карл Фридрих', 'Анна Петровна', 'Пётр III'];
const scenarios = heroes.map(prefix => ({ ...romanov,
    hero: Object.keys(romanov.sex).find(k => k.startsWith(prefix)), name: 'romanov-' + prefix }));

// Three generations, branching descendants with independent affinal ancestors.
const wide = { name: 'descendant-affinal-branches', pairs: [], spouses: [], sex: {}, hero: 'Hero 1900-01-01' };
wide.sex[wide.hero] = 'M';
let frontier = [wide.hero], serial = 0;
for (let generation = 0; generation < 3; generation++) {
    const next = [];
    for (const person of frontier) {
        const spouse = 'Spouse' + serial + ' 1900-01-01';
        wide.sex[spouse] = 'F';
        wide.spouses.push([person, spouse]);
        let child = spouse;
        for (let i = 0; i < 5; i++) {
            const parent = 'Affinal' + serial + '-' + i + ' 1850-01-01';
            wide.sex[parent] = 'F';
            wide.pairs.push([parent, child]);
            child = parent;
        }
        for (let i = 0; i < 3; i++) {
            const kid = 'Child' + serial + '-' + i + ' 1950-01-01';
            wide.sex[kid] = 'M';
            wide.pairs.push([person, kid], [spouse, kid]);
            next.push(kid);
        }
        serial++;
    }
    frontier = next;
}
scenarios.push(wide);
const samples = Number(process.env.LR_PROFILE_SAMPLES || 5);
const results = [];
for (const data of scenarios) {
    const rows = Object.keys(data.sex).map(k => ({ k, name: k.slice(0, -11), birth: k.slice(-10) }));
    for (let radius = 1; radius <= 5; radius++) {
        const args = [data.pairs, data.spouses, data.hero, radius, k => data.sex[k]];
        const operations = {
            diamond: () => tree.focusKeys(data.pairs, data.hero, radius),
            levels: () => tree.focusGraphKeys(data.pairs, [], data.hero, radius),
            export: () => tree.focusListKeys(...args),
            bell: () => tree.focusListKeys(...args, true),
            pdf: () => chart.chartRows(rows, { hero: data.hero, range: radius,
                pairs: data.pairs, spouses: data.spouses, sex: data.sex }),
        };
        for (const [operation, run] of Object.entries(operations)) {
            run(); // Warm-up excluded from measurements and call counts.
            const times = [];
            let selected;
            counts.kinBlood = counts.kinLabel = 0;
            for (let i = 0; i < samples; i++) {
                const start = performance.now();
                selected = run();
                times.push(performance.now() - start);
            }
            times.sort((a, b) => a - b);
            results.push({ scenario: data.name, persons: rows.length, radius, operation,
                candidates: selected.length, medianMs: +times[Math.floor(samples / 2)].toFixed(3),
                kinBlood: counts.kinBlood / samples, kinLabel: counts.kinLabel / samples });
        }
    }
}
const report = { node: process.version, cpu: os.cpus()[0].model, samples,
    ref: process.argv.find(a => a.startsWith('--ref='))?.slice(6) || 'worktree',
    note: 'In-memory selection only; kinBlood counts exclude internal kinLabel calls. diamond/levels are raw candidates; export/bell/pdf are selected results.',
    results };
const output = process.argv.find(a => a.startsWith('--output='))?.slice(9);
const compare = process.argv.find(a => a.startsWith('--compare='))?.slice(10);
if (compare) {
    const before = JSON.parse(fs.readFileSync(compare, 'utf8'));
    for (const row of results.filter(r => ['export', 'bell', 'pdf'].includes(r.operation))) {
        const old = before.results.find(r => r.scenario === row.scenario && r.radius === row.radius && r.operation === row.operation);
        assert.ok(old, 'Missing baseline row');
        assert.equal(row.candidates, old.candidates, `${row.scenario} R${row.radius} ${row.operation} result size`);
    }
    console.log('All export/bell/pdf result sizes match baseline at R1–5');
}
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.table(results.filter(r => r.radius === 5));
if (output) console.log('Profile: ' + output);
