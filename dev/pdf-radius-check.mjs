import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { chartRows, chartModel, chartFont, parseTtf } from '../tgcloud/lib/chart.cjs';
import { focusKeys } from '../tgcloud/lib/tree.cjs';

const tmp = fs.mkdtempSync('/tmp/kilo/lr-pdf-radius-');
// Independent measurement of the actual PDF /W advances, including Cyrillic.
const font = parseTtf(chartFont()), cmap = new Map(font.cmap);
const textWidth = (s, size = 10) => [...s].reduce((w, c) => {
    const gid = cmap.get(c.codePointAt(0));
    return w + (gid ? Math.round(font.adv[gid] * 1000 / font.upem) * size / 1000 : 0);
}, 0);
const ancestors = Array.from({ length: 6 }, (_, i) => ({
    name: 'Предок' + i, birth: (2000 - i * 25) + '-01-01', sex: 'F',
}));
const ancestorKeys = ancestors.map(r => r.name + ' ' + r.birth);
for (const radius of [3, 4, 5]) {
    const rel = { hero: ancestorKeys[0], range: radius,
        pairs: ancestorKeys.slice(1).map((k, i) => [k, ancestorKeys[i]]), spouses: [],
        sex: Object.fromEntries(ancestorKeys.map(k => [k, 'F'])) };
    const selected = chartRows(ancestors, rel);
    rel.sex = new Proxy({}, { get() { throw Error('cached ancestor label recomputed'); } });
    const model = chartModel('width', selected, [], rel);
    const labels = model.draws.filter(d => d.k === 'text' && d.fill === '#333333');
    const longest = 'мать' + ' матери'.repeat(radius - 1) + ' ' + (2000 - radius * 25);
    assert.ok(labels.some(d => d.s === longest), 'actual kinLabel R' + radius);
    for (const label of labels) {
        const width = textWidth(label.s, label.size);
        assert.ok(model.KW >= width + 12, JSON.stringify({ radius, label: label.s, KW: model.KW, width }));
        assert.ok(label.x - width >= 4, 'whole label must remain inside left edge');
        const name = model.draws.find(d => d.k === 'text' && d.fill === '#111111' && d.y === label.y);
        assert.ok(name.x - textWidth(name.s, name.size) >= model.KW, 'name must not overlap label column');
    }
    console.log('R' + radius + ': ' + longest + ', column=' + model.KW + ', text=' + textWidth(longest));
}
const key = n => n + ' 1980-01-01';
const pairs = [['Father', 'Hero'], ['Mother', 'Hero'], ['Father', 'Half'],
    ['Other', 'Half'], ['Father', 'Missing']].map(p => p.map(key));
const spouses = [['Hero', 'Wife'], ['Wife', 'Next'], ['Next', 'Last']].map(p => p.map(key));
const names = ['Hero', 'Father', 'Mother', 'Half', 'Other', 'Missing', 'Wife', 'Next', 'Last', 'Unrelated'];
const rows = names.map(name => ({ name, birth: '1980-01-01' }));
for (const radius of [1, 2]) {
    const rel = { hero: key('Hero'), range: radius, pairs, spouses, sex: {} };
    const selected = chartRows(rows, rel).map(r => r.name);
    assert.ok(selected.includes('Hero'));
    assert.ok(selected.includes('Missing'), 'one-word sibling with missing parent must not be graph-vetoed');
    assert.equal(selected.includes('Half'), radius === 2);
    assert.ok(selected.includes('Wife'));
    assert.equal(selected.includes('Next'), radius === 2);
    assert.ok(!selected.includes('Last'));
    assert.ok(!rel.labels.has(key('Unrelated')), 'no labels outside cheap candidates');
    assert.ok(!rel.labels.has(key('Last')), 'bounded marriage candidates');
    const allowed = new Set(focusKeys(pairs, rel.hero, radius, spouses));
    assert.ok([...rel.labels.keys()].every(k => allowed.has(k)));
    // A cached label must be sufficient for drawing, without consulting sex again.
    rel.sex = new Proxy({}, { get() { throw Error('label recomputed'); } });
    chartModel('cache', chartRowsNoop(selected), [], rel);
}
function chartRowsNoop(names) { return rows.filter(r => names.includes(r.name)); }
// Count actual kinLabel calls, including drawing, without a production hook.
const require = createRequire(new URL('../tgcloud/lib/chart.cjs', import.meta.url));
const calls = [];
const module = { exports: {} };
vm.runInNewContext(fs.readFileSync('tgcloud/lib/chart.cjs', 'utf8'), {
    module, require: name => name === './kinship.cjs' ? {
        kinLabel: (...args) => { calls.push(args[4]); return require(name).kinLabel(...args); },
    } : require(name),
});
const countedRel = { hero: key('Hero'), range: 1, pairs, spouses, sex: {} };
const countedRows = module.exports.chartRows([...rows, ...Array.from({ length: 1000 }, (_, i) => ({
    name: 'Outside' + i, birth: '2000-01-01' }))], countedRel);
assert.deepEqual(calls.slice().sort(), ['Father', 'Mother', 'Half', 'Missing', 'Wife'].map(key).sort());
module.exports.chartModel('counted', countedRows, [], countedRel);
assert.equal(calls.length, 5, 'render must not recalculate cached labels');
// Blood segments on both sides of a marriage each retain the sibling discount.
const segments = [[key('Hero'), key('Brother')], [key('Partner'), key('PartnerBrother')]];
const segmentPairs = segments.flatMap((children, i) => children.map(c => ['Parent' + i, c]));
assert.ok(focusKeys(segmentPairs, key('Hero'), 3, [[key('Brother'), key('Partner')]])
    .includes(key('PartnerBrother')));
for (const radius of [1, 2]) {
    const rel = { hero: key('Hero'), range: radius, pairs,
        spouses: [[key('Hero'), 'DatelessHero 1980'], [key('Father'), 'DatelessFather 1980']], sex: {} };
    const selected = chartRows([...rows, ...['Hero', 'Father'].map(n => ({
        name: 'Dateless' + n, k: 'Dateless' + n + ' 1980', birth: null, anchor: 1980 }))], rel);
    assert.ok(selected.some(r => r.name === 'DatelessHero'));
    assert.equal(selected.some(r => r.name === 'DatelessFather'), radius === 2);
}

const fixture = fs.readFileSync('dev/fixtures/half-brothers-radius-one-estimated-birth.ged', 'utf8');
for (const exact of [false, true, 3, 4, 5]) {
    const long = typeof exact === 'number';
    const file = path.join(tmp, long ? 'ancestors.ged' : exact ? 'exact.ged' : 'abt.ged');
    const chainGed = ['0 HEAD', '1 CHAR UTF-8', ...ancestors.flatMap((r, i) => [
        `0 @I${i}@ INDI`, '1 NAME ' + r.name, '1 SEX F', '1 BIRT', '2 DATE 1 JAN ' + r.birth.slice(0, 4),
    ]), ...ancestors.slice(1).flatMap((r, i) => [
        `0 @F${i}@ FAM`, `1 WIFE @I${i + 1}@`, `1 CHIL @I${i}@`,
    ]), '0 TRLR'].join('\n');
    fs.writeFileSync(file, long ? chainGed : exact ? fixture.replace('DATE ABT 20 MAY 1980', 'DATE 20 MAY 1980') : fixture);
    for (const platform of ['tg', 'vk']) for (const radius of long ? [exact] : [1, 2]) {
        const name = `${platform}-${exact}-${radius}`;
        const trace = path.join(tmp, name + '.jsonl');
        const commands = ['!ged ' + file, '/2 2', long ? 'Предок0 2000-01-01' : 'Иван 1975-04-15',
            '>3 /gedcom' + radius, '!wait 300'];
        const result = spawnSync(process.execPath, [platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs',
            '--fresh', ...(platform === 'tg' ? ['--private'] : [])], {
            encoding: 'utf8', input: commands.join('\n') + '\n', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
            env: { ...process.env, LR_DB: path.join(tmp, name + '.db'), LR_DEV_DB: path.join(tmp, name + '.json'),
                LR_VK_TRACE: trace, LR_VKOFF: '951' },
        });
        const log = result.stdout + result.stderr;
        fs.writeFileSync(path.join(tmp, name + '.log'), log);
        assert.equal(result.status, 0, log);
        assert.doesNotMatch(log, /ERROR:|chart:|TypeError|ReferenceError/);
        const pdf = path.join(tmp, name + '.pdf');
        if (platform === 'tg') {
            const output = log.match(/→ (.+\.pdf)/);
            assert.ok(output, log);
            fs.copyFileSync(output[1], pdf);
        } else {
            const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
            const upload = calls.find(c => c.method === 'upload' && c.body.includes('.pdf"'));
            assert.ok(upload, log);
            const bytes = Buffer.from(upload.base64, 'base64');
            const start = bytes.indexOf('\r\n\r\n') + 4, end = bytes.lastIndexOf('\r\n--');
            fs.writeFileSync(pdf, bytes.subarray(start, end));
        }
        const text = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
        assert.equal(text.status, 0, text.stderr);
        if (long) {
            const label = 'мать' + ' матери'.repeat(radius - 1) + ' ' + (2000 - radius * 25);
            assert.ok(text.stdout.includes(label), name + ': full label\n' + text.stdout);
            const bbox = spawnSync('pdftotext', ['-bbox', pdf, '-'], { encoding: 'utf8' });
            assert.equal(bbox.status, 0, bbox.stderr);
            const words = [...bbox.stdout.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]+)<\/word>/g)]
                .map(m => ({ x: +m[1], y: +m[2], right: +m[3], s: m[5] }));
            const person = words.find(w => w.s === 'Предок' + radius);
            assert.ok(person, bbox.stdout);
            const labelWords = words.filter(w => Math.abs(w.y - person.y) < 0.01 && w.x < person.x);
            assert.equal(labelWords.map(w => w.s).join(' '), label, 'no clipped words');
            assert.ok(labelWords[0].x > 0, 'left page clipping');
            assert.ok(labelWords.at(-1).right < person.x, 'label/name overlap');
            console.log(name + ': actual PDF full label and non-overlapping bbox OK');
        } else {
            assert.match(text.stdout, /Иван/);
            assert.equal(text.stdout.includes('Пётр'), radius === 2, name + '\n' + text.stdout);
            console.log(name + ': actual PDF hero present, Pyotr ' + (radius === 2 ? 'present' : 'absent'));
        }
    }
}
console.log('Candidate/cache, missing parent, marriage chains, dateless spouse OK; artifacts: ' + tmp);
