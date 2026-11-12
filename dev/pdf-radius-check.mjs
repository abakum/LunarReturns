import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { chartRows, chartModel, chartPdf, chartFont, parseTtf } from '../tgcloud/lib/chart.cjs';
import { focusKeys, focusListKeys } from '../tgcloud/lib/tree.cjs';
import { createFlatAnnotationText, flatTreeText } from '../tgcloud/lib/flat.cjs';

const tmp = fs.mkdtempSync('/tmp/kilo/lr-pdf-radius-');
{
    const persons = [
        { key: 'father', name: 'Отец', d: '1950-01-01', sex: 'M' },
        { key: 'mother', name: 'Тёзка', sex: 'F', nameOnly: true, note: 'Первая' },
        { key: 'other', name: 'Тёзка', sex: 'F', nameOnly: true, note: 'Вторая' },
        { key: 'child', name: 'Ребёнок', d: '1980-01-01', sex: 'M', plac: 'Пермь' },
        { key: 'grandchild', name: 'Внук', d: '2000-01-01' },
        { key: 'alone', name: 'Один', d: '1900-01-01' },
    ];
    const fams = [{ hKey: 'father', wKey: 'mother', children: ['child'], marr: { d: '1970-01-01' } }];
    const snapshot = JSON.stringify([persons, fams]);
    const textOf = createFlatAnnotationText([persons, fams], [['Ребёнок 1980-01-01', 'Внук 2000-01-01']], []);
    const mother = textOf({ xref: 'mother' });
    assert.match(mother, /Отец/);
    assert.match(mother, /Ребёнок/);
    assert.match(mother, /Первая/);
    assert.doesNotMatch(mother, /Вторая|Внук/);
    assert.match(textOf({ xref: 'other' }), /Вторая/);
    assert.doesNotMatch(textOf({ xref: 'other' }), /Первая|Ребёнок/);
    assert.match(textOf({ xref: 'child' }), /Внук/, 'relatives outside PDF and interactive edges retained');
    assert.equal(textOf({ xref: 'alone' }), flatTreeText([persons[5]], [], true));
    assert.equal(JSON.stringify([persons, fams]), snapshot, 'snapshot unchanged');
    const dated = persons.filter(p => ['father', 'child', 'grandchild'].includes(p.key));
    const allPairs = [['Отец 1950-01-01', 'Ребёнок 1980-01-01'], ['Ребёнок 1980-01-01', 'Внук 2000-01-01']];
    const datedText = createFlatAnnotationText([dated, []], allPairs, []);
    const keys = focusListKeys(allPairs, [], 'Отец 1950-01-01', 1, () => null, false);
    assert.equal(datedText({ xref: 'father' }), flatTreeText(dated.filter(p => keys.includes(p.name + ' ' + p.d)), [], true));
}
function checkAnnotations(pdf, expectedCount) {
    const objects = new Map([...pdf.matchAll(/(?:^|\n)(\d+) 0 obj\n([\s\S]*?)\nendobj/g)]
        .map(m => [+m[1], m[2]]));
    const annots = [...objects].filter(([, body]) => body.includes('/Type /Annot'));
    assert.equal(annots.length, expectedCount);
    const refs = new Set();
    for (const [pageId, page] of objects) {
        if (!/\/Type \/Page\b/.test(page)) continue;
        for (const match of (page.match(/\/Annots \[([^\]]*)\]/)?.[1] || '').matchAll(/(\d+) 0 R/g)) {
            const id = +match[1], body = objects.get(id);
            assert.ok(!refs.has(id), 'annotation belongs to exactly one page');
            refs.add(id);
            assert.ok(body.includes('/P ' + pageId + ' 0 R'));
            const rect = body.match(/\/Rect \[([^\]]+)\]/)[1].split(' ').map(Number);
            assert.ok(rect[0] > 0 && rect[2] > rect[0] && rect[2] <= 842, 'connection region stays inside chart');
            assert.ok(rect[1] >= 0 && rect[3] <= 595 && rect[3] > rect[1]);
            const contents = objects.get(+body.match(/\/Contents (\d+) 0 R/)[1]);
            assert.match(contents, /^<FEFF[\da-f]*>$/);
            const bytes = Buffer.from(contents.slice(5, -1), 'hex');
            const text = bytes.swap16().toString('utf16le');
            assert.ok(text.length);
            assert.ok(!text.includes('#not for cut and graft'));
            const ap = body.match(/\/AP << \/N (\d+) 0 R >>/);
            assert.match(objects.get(+ap[1]), /\/Length 0/);
            assert.doesNotMatch(body, /\/R \d+ 0 R/, 'no rollover appearance');
            assert.match(body, /\/F 0\b/);
        }
    }
    assert.equal(refs.size, expectedCount);
    const start = +pdf.match(/startxref\n(\d+)/)[1];
    assert.equal(pdf.slice(start, start + 5), 'xref\n');
    const lines = pdf.slice(start).split('\n');
    const size = +lines[1].split(' ')[1];
    for (let id = 1; id < size; id++) {
        const offset = +lines[id + 2].slice(0, 10);
        assert.ok(pdf.startsWith(id + ' 0 obj\n', offset), 'valid xref for ' + id);
    }
    return annots;
}
// Every page repeats the axis; the final one follows the last person row.
for (const count of [1, 44, 45, 100]) {
    const rows = Array.from({ length: count }, (_, i) => ({
        name: 'Person' + i, birth: '1960-01-01', death: '2030-01-01', sex: 'M',
    }));
    const file = path.join(tmp, 'page-axis-' + count + '.pdf');
    const scale = 842 / chartModel('Page axis', rows, []).W;
    const bodyBottom = 595 - 42 * scale;
    const annotation = 'Роспись (тест) \\ строка\n=Персона \u{1f600}';
    const pdf = chartPdf('Page axis', rows, [], chartFont(), null, null, () => annotation);
    const targets = checkAnnotations(pdf, count);
    const model = chartModel('Page axis', rows, []);
    const bars = model.draws.filter(d => d.k === 'rrect');
    for (const [i, [, body]] of targets.entries()) {
        const rect = body.match(/\/Rect \[([^\]]+)\]/)[1].split(' ').map(Number);
        assert.ok(Math.abs(rect[0] - bars[i].x * scale) < 0.001, 'target begins at bar start');
        assert.ok(Math.abs(rect[2] - rect[0] - 16 * scale) < 0.002, 'wide touch target');
        assert.ok(Math.abs(rect[3] - rect[1] - 16 * scale) < 0.002, 'full row height target');
    }
    fs.writeFileSync(file, pdf, 'latin1');
    const bbox = spawnSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
    assert.equal(bbox.status, 0, bbox.stderr);
    const pages = [...bbox.stdout.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)];
    assert.ok(pages.length >= (count === 100 ? 2 : 1));
    let expectedAxis;
    const people = [];
    for (const [pageIndex, [, page]] of pages.entries()) {
        const words = [...page.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]+)<\/word>/g)]
            .map(m => ({ x: +m[1], y: +m[2], bottom: +m[4], s: m[5] }));
        const axisYs = new Set(words.filter(w => /^(19|20|00|10|30)$/.test(w.s) && w.y >= 0 && w.bottom < 595).map(w => w.y));
        const axis = words.filter(w => /^\d{2}$/.test(w.s) && axisYs.has(w.y));
        assert.ok(axis.length >= 16, 'axis present on every page');
        assert.equal(new Set(axis.map(w => w.y)).size, 2, 'two axis rows');
        assert.ok(axis.every(w => w.bottom < 595), 'axis inside page');
        const signature = axis.map(w => [w.x, w.s]);
        if (expectedAxis) assert.deepEqual(signature, expectedAxis, 'identical axis horizontal position and years');
        expectedAxis = signature;
        // Poppler bbox includes text outside a body clip; count visible rows only.
        const persons = words.filter(w => /^Person\d+$/.test(w.s) && w.y >= 0 && w.bottom <= bodyBottom);
        assert.ok(persons.every(w => w.bottom < Math.min(...axis.map(w => w.y))), 'person rows above axis');
        const axisTop = Math.min(...axis.map(w => w.y));
        if (pageIndex === pages.length - 1) {
            const gap = axisTop - Math.max(...persons.map(w => w.bottom));
            assert.ok(gap > 0 && gap < 30 * scale, 'final axis immediately below last person: ' + gap);
        } else assert.ok(axisTop > 560, 'intermediate axis at page bottom');
        people.push(...persons.map(w => w.s));
    }
    assert.deepEqual(people.sort(), rows.map(r => r.name).sort(), 'all people exactly once');
    console.log('Page axis: ' + count + ' people, ' + pages.length + ' pages OK');
}
{
    let calls = 0;
    const rows = Array.from({ length: 1001 }, (_, i) => ({ name: 'Limit' + i, birth: (1000 + i) + '-01-01' }));
    const links = [{ child: 'Limit1000 2000-01-01', parents: ['Limit1 1001-01-01'] },
        { child: 'Limit2 1002-01-01', parents: ['Limit0 1000-01-01'] }];
    const annotation = 'Роспись (тест) \\ строка\n=Персона \u{1f600}';
    const pdf = chartPdf('Limit', rows, links, chartFont(), null, null, r => {
        calls++; assert.notEqual(r.name, 'Limit0'); return annotation;
    });
    const annots = [...pdf.matchAll(/\/Type \/Annot\b/g)].length;
    assert.ok(annots > 1, 'long connection split between pages');
    const checked = checkAnnotations(pdf, annots);
    assert.equal(calls, 1000, 'each retained person computes annotation once, including connected child');
    assert.equal(new Set(checked.map(([, b]) => b.match(/\/Contents (\d+) 0 R/)[1])).size, 1);
    const id = checked[0][1].match(/\/Contents (\d+) 0 R/)[1];
    const encoded = pdf.match(new RegExp('\\n' + id + ' 0 obj\\n<FEFF([a-f0-9]+)>'))[1];
    assert.equal(Buffer.from(encoded, 'hex').swap16().toString('utf16le'), annotation);
    const model = chartModel('Limit', rows, links);
    const region = model.annotationRegions[0], scale = 842 / model.W;
    assert.equal(region.w, 1.5, 'connection width matches line width');
    assert.ok(model.annotationRegions.slice(1, 3).every(r => r.w === 7 && r.h === 7), 'separate point targets');
    for (const [, body] of checked.slice(0, checked.length - 1000)) {
        const rect = body.match(/\/Rect \[([^\]]+)\]/)[1].split(' ').map(Number);
        const width = (rect[2] - rect[0]) / scale;
        assert.ok(Math.abs(width - 1.5) < 0.003 || Math.abs(width - 7) < 0.003);
        if (Math.abs(width - 1.5) < 0.003) {
            assert.ok(Math.abs(rect[0] - region.x * scale) < 0.001);
            assert.ok(Math.abs(rect[2] - (region.x + region.w) * scale) < 0.001);
        }
    }
    const distinct = chartPdf('Own R1', rows.slice(0, 2), [], chartFont(), null, null, r => r.name);
    const own = checkAnnotations(distinct, 2);
    assert.equal(new Set(own.map(([, b]) => b.match(/\/Contents (\d+) 0 R/)[1])).size, 2,
        'bar-start targets have individual contents');
}
// Independent measurement of the actual PDF /W advances, including Cyrillic.
{
    const rows = [{ name: 'Parent', birth: '1950-01-01' }];
    const a = { name: 'OutsideA', xref: 'a', birth: '1980-01-01' }, b = { name: 'OutsideB', xref: 'b' };
    for (const parents of [rows, [...rows, { name: 'Mother', birth: '1952-01-01' }]]) {
        const rel = { phantoms: [{ fam: parents.map(r => r.name + ' ' + r.birth), years: [1980],
            children: [{ year: 1980, r: a }, { year: 1980, r: b }] }] };
        const model = chartModel('Phantom annotations', parents, [], rel);
        assert.equal(model.annotationRegions[0].r, a, 'one child represents the phantom family');
        assert.equal(model.annotationRegions[0].w, 1.5);
        assert.ok(model.annotationRegions.slice(1, 1 + parents.length).every(r => r.w === 7 && r.h === 7));
        const pdf = chartPdf('Phantom annotations', parents, [], chartFont(), rel, null,
            r => {
                assert.notEqual(r.xref, 'b', 'do not concatenate twin genealogies');
                return r.xref ? 'R1 ' + r.xref + '^Note' : 'Own ' + r.name;
            });
        const annotations = checkAnnotations(pdf, 2 * parents.length + 1);
        const title = annotations[0][1].match(/\/T <FEFF([a-f0-9]+)>/)[1];
        assert.equal(Buffer.from(title, 'hex').swap16().toString('utf16le'), 'OutsideA 1980-01-01');
        const id = annotations[0][1].match(/\/Contents (\d+) 0 R/)[1];
        const encoded = pdf.match(new RegExp('\\n' + id + ' 0 obj\\n<FEFF([a-f0-9]+)>'))[1];
        assert.equal(Buffer.from(encoded, 'hex').swap16().toString('utf16le'), 'R1 a\nNote');
    }
}
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
    const longest = ['прабабушка', 'пра2бабушка', 'пра3бабушка'][radius - 3] + ' ' + (2000 - radius * 25);
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
    assert.equal(selected.includes('Half'), radius === 2, 'chain radius independent of ordinary display');
    assert.ok(selected.includes('Wife'));
    assert.ok(!selected.includes('Next'), 'no further marriages through a spouse');
    assert.ok(!selected.includes('Last'));
    assert.ok(!rel.labels.has(key('Unrelated')), 'no labels outside cheap candidates');
    assert.ok(!rel.labels.has(key('Last')), 'bounded marriage candidates');
    const allowed = new Set([...focusKeys(pairs, rel.hero, radius), key('Wife')]);
    assert.ok([...rel.labels.keys()].every(k => allowed.has(k)));
    // A cached label must be sufficient for drawing, without consulting sex again.
    rel.sex = new Proxy({}, { get() { throw Error('label recomputed'); } });
    chartModel('cache', chartRowsNoop(selected), [], rel);
}
function chartRowsNoop(names) { return rows.filter(r => names.includes(r.name)); }
// Count actual kinLabel calls, including drawing, without a production hook.
const require = createRequire(new URL('../tgcloud/lib/chart.cjs', import.meta.url));
// Both marriage directions, maternal blood lines, overlapping blood/marriage paths.
const policyPairs = [['Grandmother', 'Mother'], ['Grandmother', 'Aunt'],
    ['Mother', 'Husband'], ['Mother', 'Brother'], ['WifeMother', 'Wife'],
    ['WifeMother', 'WifeBrother'], ['WifeGrandmother', 'WifeMother'],
    ['Husband', 'Child'], ['Wife', 'Child']].map(p => p.map(key));
const policySpouses = [['Husband', 'Wife'], ['Brother', 'BrotherWife'],
    ['BrotherWife', 'Next'], ['Aunt', 'AuntHusband']].map(p => p.map(key));
const policyNames = [...new Set([...policyPairs, ...policySpouses].flat())];
const policyRows = policyNames.map(k => ({ name: k.slice(0, -11), birth: '1980-01-01' }));
{
    const treeModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync('tgcloud/lib/tree.cjs', 'utf8'),
    { module: treeModule, require });
    const chartModule = { exports: {} };
    vm.runInNewContext(fs.readFileSync('tgcloud/lib/chart.cjs', 'utf8'), {
        module: chartModule, require: name => name === './tree.cjs' ? treeModule.exports : require(name),
    });
    for (const [hero, spouse, own, affinal] of [
        ['Husband', 'Wife', ['Mother', 'Grandmother', 'Aunt', 'Brother', 'BrotherWife', 'AuntHusband'],
            ['WifeMother', 'WifeGrandmother', 'WifeBrother']],
        ['Wife', 'Husband', ['WifeMother', 'WifeGrandmother', 'WifeBrother'],
            ['Mother', 'Grandmother', 'Aunt', 'Brother']],
    ]) {
        const rel = { hero: key(hero), range: 5, pairs: policyPairs, spouses: policySpouses, sex: {} };
        const exports = treeModule.exports.focusListKeys(policyPairs, policySpouses, rel.hero, 5, () => null);
        const pdf = chartModule.exports.chartRows(policyRows, rel).map(r => key(r.name));
        for (const selection of [exports, pdf]) {
            for (const n of [hero, spouse, ...own]) assert.ok(selection.includes(key(n)), `${hero} keeps ${n}`);
            for (const n of affinal) assert.ok(!selection.includes(key(n)), `${hero} excludes affinal ${n}`);
            assert.ok(!selection.includes(key('Next')), 'no chained spouses');
        }
        const bell = treeModule.exports.focusListKeys(policyPairs, policySpouses, rel.hero, 5, () => null, true);
        for (const n of [hero, spouse, ...own]) assert.ok(bell.includes(key(n)), 'bell keeps ' + n);
        for (const n of affinal) assert.ok(!bell.includes(key(n)), 'bell excludes affinal ' + n);
    }
    const overlap = [...policyPairs, [key('Mother'), key('WifeBrother')]];
    assert.ok(treeModule.exports.focusListKeys(overlap, policySpouses, key('Husband'), 5, () => null)
        .includes(key('WifeBrother')), 'blood path wins over affinal exclusion');
}
const calls = [];
const module = { exports: {} };
vm.runInNewContext(fs.readFileSync('tgcloud/lib/chart.cjs', 'utf8'), {
    module, require: name => name === './kinship.cjs' ? {
        fynny: require(name).fynny,
        kinBlood: require(name).kinBlood,
        kinLabel: (...args) => { calls.push(args[4]); return require(name).kinLabel(...args); },
    } : require(name),
});
const countedRel = { hero: key('Hero'), range: 1, pairs, spouses, sex: {} };
const countedRows = module.exports.chartRows([...rows, ...Array.from({ length: 1000 }, (_, i) => ({
    name: 'Outside' + i, birth: '2000-01-01' }))], countedRel);
assert.deepEqual(calls.slice().sort(), ['Father', 'Mother', 'Half', 'Missing', 'Wife'].flatMap(n => [key(n), key(n)]).sort());
module.exports.chartModel('counted', countedRows, [], countedRel);
assert.equal(calls.length, 10, 'render must not recalculate cached labels');
// Chain radius retains the sibling discount irrespective of display mode.
const segments = [[key('Hero'), key('Brother')], [key('Partner'), key('PartnerBrother')]];
const segmentPairs = segments.flatMap((children, i) => children.map(c => ['Parent' + i, c]));
assert.ok(!focusKeys(segmentPairs, key('Hero'), 2, [[key('Brother'), key('Partner')]])
    .includes(key('PartnerBrother')));
assert.ok(focusKeys(segmentPairs, key('Hero'), 3, [[key('Brother'), key('Partner')]])
    .includes(key('PartnerBrother')));
for (const radius of [1, 2]) {
    const rel = { hero: key('Hero'), range: radius, pairs,
        spouses: [[key('Hero'), 'DatelessHero 1980'], [key('Father'), 'DatelessFather 1980']], sex: {} };
    const selected = chartRows([...rows, ...['Hero', 'Father'].map(n => ({
        name: 'Dateless' + n, k: 'Dateless' + n + ' 1980', birth: null, anchor: 1980 }))], rel);
    assert.ok(selected.some(r => r.name === 'DatelessHero'));
    assert.equal(selected.some(r => r.name === 'DatelessFather'), radius === 2, 'dateless spouse obeys chain radius');
}

const fixture = fs.readFileSync('dev/fixtures/half-brothers-radius-one-estimated-birth.ged', 'utf8');
const policyGed = ['0 HEAD', '1 CHAR UTF-8', ...policyRows.flatMap((r, i) => [
    `0 @I${i}@ INDI`, '1 NAME ' + r.name, '1 BIRT', '2 DATE 1 JAN 1980',
]), ...policyPairs.map(([p, c]) => [p, null, c]).concat(policySpouses.map(([a, b]) => [a, b]))
    .flatMap(([a, b, c], i) => [`0 @F${i}@ FAM`, `1 HUSB @I${policyNames.indexOf(a)}@`,
        ...(b ? [`1 WIFE @I${policyNames.indexOf(b)}@`] : []),
        ...(c ? [`1 CHIL @I${policyNames.indexOf(c)}@`] : [])]), '0 TRLR'].join('\n');
for (const exact of [false, true, 3, 4, 5, 'Husband', 'Wife']) {
    const policy = typeof exact === 'string';
    const long = typeof exact === 'number';
    const file = path.join(tmp, policy ? 'affinal.ged' : long ? 'ancestors.ged' : exact ? 'exact.ged' : 'abt.ged');
    const chainGed = ['0 HEAD', '1 CHAR UTF-8', ...ancestors.flatMap((r, i) => [
        `0 @I${i}@ INDI`, '1 NAME ' + r.name, '1 SEX F', '1 BIRT', '2 DATE 1 JAN ' + r.birth.slice(0, 4),
    ]), ...ancestors.slice(1).flatMap((r, i) => [
        `0 @F${i}@ FAM`, `1 WIFE @I${i + 1}@`, `1 CHIL @I${i}@`,
    ]), '0 TRLR'].join('\n');
    fs.writeFileSync(file, policy ? policyGed : long ? chainGed : exact ? fixture.replace('DATE ABT 20 MAY 1980', 'DATE 20 MAY 1980') : fixture);
    for (const platform of ['tg', 'vk']) for (const radius of policy ? [5] : long ? [exact] : [1, 2]) {
        const name = `${platform}-${exact}-${radius}`;
        const trace = path.join(tmp, name + '.jsonl');
        const commands = ['!ged ' + file, '/2 2', policy ? key(exact) : long ? 'Предок0 2000-01-01' : 'Иван 1975-04-15',
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
        let ged;
        if (platform === 'tg') {
            const output = log.match(/→ (.+\.pdf)/);
            assert.ok(output, log);
            fs.copyFileSync(output[1], pdf);
            if (policy) ged = fs.readFileSync(log.match(/→ (.+\.ged)\n/)[1], 'utf8');
        } else {
            const calls = fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
            const upload = calls.find(c => c.method === 'upload' && c.body.includes('.pdf"'));
            assert.ok(upload, log);
            const bytes = Buffer.from(upload.base64, 'base64');
            const start = bytes.indexOf('\r\n\r\n') + 4, end = bytes.lastIndexOf('\r\n--');
            fs.writeFileSync(pdf, bytes.subarray(start, end));
            if (policy) {
                const body = calls.find(c => c.method === 'upload' && c.body.includes('.ged"')).body;
                ged = body.slice(body.indexOf('\r\n\r\n') + 4, body.lastIndexOf('\r\n--'));
            }
        }
        const pdfBody = fs.readFileSync(pdf, 'latin1');
        const countAnnotations = [...pdfBody.matchAll(/\/Type \/Annot\b/g)].length;
        assert.ok(countAnnotations > 0, 'real bot export has annotations');
        checkAnnotations(pdfBody, countAnnotations);
        const text = spawnSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8' });
        assert.equal(text.status, 0, text.stderr);
        if (policy) {
            const expected = focusListKeys(policyPairs, policySpouses, key(exact), radius, () => null);
            for (const r of policyRows) {
                const included = expected.includes(key(r.name));
                assert.equal(ged.includes('1 NAME ' + r.name + '\n'), included, name + ': GED ' + r.name);
                assert.equal(text.stdout.split('\n').some(line => line.trim().split(/\s+/).at(-1) === r.name), included,
                    name + ': PDF ' + r.name + '\n' + text.stdout);
            }
            console.log(name + ': actual GED/PDF blood and spouses only OK');
        } else if (long) {
            const label = ['прабабушка', 'пра2бабушка', 'пра3бабушка'][radius - 3] + ' ' + (2000 - radius * 25);
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
            assert.equal(text.stdout.includes('Пётр'), radius === 2, name + ': half brother obeys chain radius\n' + text.stdout);
            console.log(name + ': actual PDF hero present, half brother radius OK');
        }
    }
}
console.log('Candidate/cache, missing parent, marriage chains, dateless spouse OK; artifacts: ' + tmp);

// User regression: the live level-based bell used to ignore the export policy.
for (const platform of ['tg', 'vk']) for (const radius of [1, 2, 5]) for (const wife of [false, true]) {
    const name = `${platform}-${wife ? 'anna' : 'karl'}-bell-${radius}`;
    const hero = wife ? 'Анна Петровна Романова 1708-01-27' : 'Карл Фридрих Гольштейн-Готторпский 1700-04-20';
    const result = spawnSync(process.execPath, [platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs',
        '--fresh', ...(platform === 'tg' ? ['--private'] : [])], {
        encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
        input: [fs.readFileSync('dev/fixtures/Romanov_family.ged.txt', 'utf8').trim().replaceAll('\n', '\\n'),
            wife ? '/Анна Петровна' : '/Карл Фридрих',
            hero, '>5 /bell' + radius,
            '>5 /gedcom' + radius, '!wait 300'].join('\n') + '\n',
        env: { ...process.env, LR_DB: path.join(tmp, name + '.db'), LR_DEV_DB: path.join(tmp, name + '.json'),
            LR_VKOFF: '951', LR_VK_TRACE: path.join(tmp, name + '.jsonl') },
    });
    const log = result.stdout + result.stderr;
    fs.writeFileSync(path.join(tmp, name + '.log'), log);
    assert.equal(result.status, 0, log);
    assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError/);
    const bellLog = log.slice(log.indexOf('    /bell' + radius));
    assert.match(bellLog, wife ? /Карл Фридрих[^\n]* муж/ : /Анна Петровна Романова[^\n]* жена/);
    if (!wife) assert.doesNotMatch(bellLog, /(?:отец|мать|брат|сестра) жены/);
    let exportLog = log.slice(log.indexOf('    /gedcom' + radius));
    const txtPath = exportLog.match(/→ (.+\.ged\.txt)/);
    if (txtPath) exportLog += fs.readFileSync(txtPath[1], 'utf8');
    if (platform === 'vk') {
        const calls = fs.readFileSync(path.join(tmp, name + '.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        exportLog += calls.filter(c => c.method === 'upload' && c.body.includes('.ged.txt"')).map(c => c.body).join('\n');
    }
    const relatives = /Пётр I Алексеевич|Екатерина I Алексеевна|Елизавета Петровна/;
    if (wife) {
        assert.match(bellLog, /Екатерина I Алексеевна[^\n]* мать/);
        assert.match(bellLog, /Елизавета Петровна[^\n]* сестра/);
        assert.match(exportLog, relatives);
    } else assert.doesNotMatch(exportLog, relatives);
    const pdfPath = log.match(/→ (.+\.pdf)/);
    if (platform === 'tg') {
        assert.ok(pdfPath, log);
        const text = spawnSync('pdftotext', ['-layout', pdfPath[1], '-'], { encoding: 'utf8' });
        assert.equal(text.status, 0, text.stderr);
        if (wife) assert.match(text.stdout, relatives);
        else assert.doesNotMatch(text.stdout, relatives);
        assert.match(text.stdout, /Анна Петровна/);
    }
    if (radius === 2) {
        assert.match(log, /Екатерина II[^\n]* жена сына/);
        assert.match(log, /Павел I[^\n]* внук/);
    }
    console.log(name + ': spouse kept, ' + (wife ? 'maternal and sibling blood retained' : 'wife kin excluded') + ' OK');
}
