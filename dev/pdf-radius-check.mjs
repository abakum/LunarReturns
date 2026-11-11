import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { chartRows, chartModel, chartFont, parseTtf } from '../tgcloud/lib/chart.cjs';
import { focusKeys, focusListKeys } from '../tgcloud/lib/tree.cjs';

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
        kinBlood: require(name).kinBlood,
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
        assert.match(log, /Павел I[^\n]* сын сына/);
    }
    console.log(name + ': spouse kept, ' + (wife ? 'maternal and sibling blood retained' : 'wife kin excluded') + ' OK');
}
