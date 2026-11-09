import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// Original A3 expectations, with explicit corrections for displayed-key defects.
const require = createRequire(import.meta.url);
const { approxOut, findShownRecord } = require('../tgcloud/lib/text.cjs');
const { newStyleDate } = require('../tgcloud/lib/religion.cjs');
const source = fs.readFileSync(new URL('../lunarreturns.js', import.meta.url), 'utf8');
const tgSource = fs.readFileSync(new URL('../tgcloud/handlers/message.js', import.meta.url), 'utf8');
// Exercise the actual reply regex literals, including the VK reaction lookup.
const replyPatterns = [...source.matchAll(/\.match\((\/\^.*?\/)\)/g),
    ...tgSource.matchAll(/\.match\((\/\^.*?\/)\)/g)]
    .map(m => m[1]).filter(s => s.includes('[-._]'));
const reactionPattern = source.match(/const RX = (\/\^.*?\/);/)[1];
assert.ok(replyPatterns.length >= 8);
for (const literal of [...replyPatterns, reactionPattern]) {
    const regex = vm.runInNewContext(literal);
    const head = literal.startsWith('/^\\d') ? '1 Person ' : 'Person ';
    for (const date of ['2000-02-03>', '2000.02>', '2000>', '1900_01_13']) {
        const match = regex.exec(head + date + ' other text');
        assert.equal(match?.[2], date, literal + ': ' + date);
    }
}
const body = source.match(/^function recordShownOf\(peerId, key\) \{[\s\S]*?^\}/m)[0];
const exactBody = source.match(/^function recordOf\(peerId, key\) \{[\s\S]*?^\}/m)[0];
const people = [
    { n: 'Old', d: '1900-01-01' },
    ...[0, 1, 2, 3, 6, 9, 12, 15].map((abt, i) => ({ n: 'Approx' + i, d: '2000-02-03', abt })),
    { n: 'Same', d: '1900-01-01' },
    { n: 'Same', d: '1900-01-13' },
];
const weddings = [{ n: 'A+B', d: '1900-01-01', mabt: 3 },
    { n: 'Pair', d: '1900-01-01' }, { n: 'Pair', d: '1900-01-13' },
    { n: 'Same', d: '1900-01-13' }];
const recordOf = vm.runInNewContext('(' + exactBody + ')', {
    pkey: r => r.n + ' ' + r.d,
    personRows: () => people, weddingRows: () => weddings,
});
const find = vm.runInNewContext('(' + body + ')', {
    approxOut, newStyleDate, findShownRecord,
    recordOf,
    personRows: () => people, weddingRows: () => weddings,
});
assert.equal(find(1, 'Old 1900-01-01'), people[0]);
assert.equal(find(1, 'Old 1900_01_13'), people[0]);
assert.equal(find(1, 'Same 1900-01-13'), people.at(-1));
assert.equal(find(1, 'Same 1900_01_13'), people.at(-2));
for (const [i, date] of ['2000-02-03', '2000-02', '2000', '2000-02-03?', '2000-02-03=', '2000-02-03<', '2000-02-03>', '2000-02-03~'].entries()) {
    assert.equal(find(1, 'Approx' + i + ' ' + date), people[i + 1]);
}
assert.equal(find(1, 'Pair 1900-01-13'), weddings[2]);
assert.equal(find(1, 'Pair 1900_01_13'), weddings[1]);
assert.equal(find(1, 'Pair 1900.01.13'), weddings[1]);
assert.equal(recordOf(1, 'Same 1900-01-13'), people.at(-1));
assert.equal(recordOf(1, 'Pair 1900_01_13'), null);
assert.equal(recordOf(1, 'Missing 2000-02-03'), null);
assert.equal(find(1, 'A+B 1900_01_13?'), weddings[0]);
assert.equal(find(1, 'Missing 2000'), null);
assert.equal(find(1, 'not a key'), null);
for (let q = 0; q <= 5; q++) {
    for (let g = 0; g <= 2; g++) {
        const row = { n: 'Granularity', d: '2000-02-03', abt: q * 3 + g };
        const date = ['2000-02-03', '2000-02', '2000'][g] + ['', '?', '=', '<', '>', '~'][q];
        for (const sep of ['-', '_', '.']) {
            assert.equal(findShownRecord([row], row.n + ' ' + date.replaceAll('-', sep)), row);
            const wedding = { n: 'Pair', d: row.d, mabt: row.abt };
            assert.equal(findShownRecord([wedding], wedding.n + ' ' + date.replaceAll('-', sep)), wedding);
        }
    }
}
const first = { n: 'Duplicate', d: '2000-02-03', abt: 2 };
const oldAft = { n: 'Old AFT', d: '1900-01-01', abt: 12 };
assert.equal(findShownRecord([oldAft], 'Old AFT 1900.01.13>'), oldAft);
assert.equal(findShownRecord([oldAft], 'Old AFT 1900_01_13>'), oldAft);
assert.equal(findShownRecord([first, { ...first }], 'Duplicate 2000'), first);
assert.equal(findShownRecord([{ n: 'First+Second', d: '1900-01-01' }], 'First+Second 1900-01-01').d, '1900-01-01');
assert.equal(findShownRecord([{ n: 'Dot', d: '2000-02-03' }], 'Dot 2000.02.03').d, '2000-02-03');
for (const key of ['Dot 2000.2.03', 'Dot 2000.02.03>>', 'Dot 2000/02/03'])
    assert.equal(findShownRecord([{ n: 'Dot', d: '2000-02-03' }], key), null);
console.log('A3 displayed-key expectations: OK');
