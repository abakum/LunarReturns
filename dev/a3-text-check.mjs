import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

// These expectations passed against the original VK implementation before A3.
const require = createRequire(import.meta.url);
const { approxOut, findShownRecord } = require('../tgcloud/lib/text.cjs');
const { newStyleDate } = require('../tgcloud/lib/religion.cjs');
const source = fs.readFileSync(new URL('../lunarreturns.js', import.meta.url), 'utf8');
const body = source.match(/^function recordShownOf\(peerId, key\) \{[\s\S]*?^\}/m)[0];
const people = [
    { n: 'Old', d: '1900-01-01' },
    ...[0, 1, 2, 3, 6, 9, 12, 15].map((abt, i) => ({ n: 'Approx' + i, d: '2000-02-03', abt })),
    { n: 'Same', d: '1900-01-01' },
    { n: 'Same', d: '1900-01-13' },
];
const weddings = [{ n: 'A+B', d: '1900-01-01', mabt: 3 }];
const find = vm.runInNewContext('(' + body + ')', {
    approxOut, newStyleDate, findShownRecord,
    recordOf: (_, key) => people.find(r => r.n + ' ' + r.d === key) || null,
    personRows: () => people, weddingRows: () => weddings,
});
assert.equal(find(1, 'Old 1900-01-01'), people[0]);
assert.equal(find(1, 'Old 1900_01_13'), people[0]);
assert.equal(find(1, 'Same 1900-01-13'), people.at(-1));
assert.equal(find(1, 'Same 1900_01_13'), people.at(-2));
for (const [i, date] of ['2000-02-03', '2000-02', '2000', '2000-02-03?', '2000-02-03=', '2000-02-03<', null, '2000-02-03~'].entries()) {
    if (date) assert.equal(find(1, 'Approx' + i + ' ' + date), people[i + 1]);
}
// The VK matcher deliberately does not accept the AFT suffix.
assert.equal(find(1, 'Approx6 2000-02-03>'), null);
assert.equal(find(1, 'A+B 1900_01_13?'), weddings[0]);
assert.equal(find(1, 'Missing 2000'), null);
assert.equal(find(1, 'not a key'), null);
for (let q = 0; q <= 5; q++) {
    for (let g = 0; g <= 2; g++) {
        const row = { n: 'Granularity', d: '2000-02-03', abt: q * 3 + g };
        const date = ['2000-02-03', '2000-02', '2000'][g] + ['', '?', '=', '<', '>', '~'][q];
        assert.equal(findShownRecord([row], row.n + ' ' + date), q === 4 ? null : row);
    }
}
const first = { n: 'Duplicate', d: '2000-02-03', abt: 2 };
assert.equal(findShownRecord([first, { ...first }], 'Duplicate 2000'), first);
assert.equal(findShownRecord([{ n: 'First+Second', d: '1900-01-01' }], 'First+Second 1900-01-01').d, '1900-01-01');
assert.equal(findShownRecord([{ n: 'Dot', d: '2000-02-03' }], 'Dot 2000.02.03'), null);
console.log('A3 displayed-key expectations: OK');
