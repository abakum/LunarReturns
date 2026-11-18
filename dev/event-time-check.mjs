import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { eventToMsk, localEvent, localRecord, mskGedcom } = require('../tgcloud/lib/event-time.cjs');
const { parseTrigger, parseTreeLine, parseGedcom } = require('../tgcloud/lib/parse.cjs');
const { flatTreeText } = require('../tgcloud/lib/flat.cjs');
let checks = 0;
function check(name, run) {
    run();
    checks++;
    console.log('OK ' + name);
}

check('Julian leap day survives timed conversion without a place', () => {
    assert.deepEqual(eventToMsk({ date: '1900-02-29', time: '12:00' }),
        { d: '1900-02-29', h: 12, m: 0, srcH: 12, srcM: 0 });
});

for (const [date, time, plac, expectedDate, h, m] of [
    ['1900-03-01', '00:30', 'UTC+5', '1900-02-29', 22, 30],
    ['1900-02-29', '00:30', 'UTC+5', '1900-02-28', 22, 30],
    ['1900-02-28', '23:30', 'UTC', '1900-02-29', 2, 30],
    ['1900-02-29', '23:30', 'UTC', '1900-03-01', 2, 30],
    ['1918-01-31', '23:30', 'UTC', '1918-02-14', 2, 30],
    ['1918-02-14', '00:30', 'UTC+5', '1918-01-31', 22, 30],
    ['2000-03-01', '00:30', 'UTC+5', '2000-02-29', 22, 30],
    ['2001-03-01', '00:30', 'UTC+5', '2001-02-28', 22, 30],
]) {
    check('calendar rollover and inverse: ' + date + ' ' + time + ' (' + plac + ')', () => {
        const rec = eventToMsk({ date, time, plac });
        assert.deepEqual([rec.d, rec.h, rec.m], [expectedDate, h, m]);
        const local = localEvent(rec.d, rec.h, rec.m, rec.srcH, rec.srcM, plac);
        assert.deepEqual([local.d, local.h, local.m], [date, ...time.split(':').map(Number)]);
    });
}

check('new-style trigger converts once, before zone arithmetic', () => {
    for (const [input, expected] of [
        ['1900_03_13 12:00', ['1900-02-29', 12]],
        ['1900_03_14 00:30 (UTC+5)', ['1900-02-29', 22]],
        ['1918_02_14 00:30 (UTC+5)', ['1918-01-31', 22]],
    ]) {
        const parsed = parseTrigger('Clock ' + input);
        assert.equal(parsed.error, undefined);
        assert.deepEqual([parsed.rec.d, parsed.rec.h], expected);
    }
});

check('GED birth and death preserve Julian nested times', () => {
    const ged = parseGedcom('0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @I@ INDI\n1 NAME Clock\n1 BIRT\n2 DATE 29 FEB 1900\n3 TIME 12:00\n1 DEAT\n2 DATE 1 MAR 1900\n3 TIME 00:30\n2 PLAC UTC+5\n0 TRLR');
    const ind = mskGedcom(ged).indis[0];
    assert.deepEqual([ind.birt.date, ind.birt.h], ['1900-02-29', 12]);
    assert.deepEqual([ind.deat.date, ind.deat.h], ['1900-02-29', 22]);
});

check('assumed noon restores local date without becoming explicit birth/death time', () => {
    const rec = parseTrigger('Clock 2000-01-02 (UTC+23)').rec;
    assert.equal(rec.d, '2000-01-01');
    assert.equal(rec.srcH, undefined);
    const local = localRecord({ ...rec, dd: rec.d, dh: rec.h, dm: rec.m, dp: rec.plac,
        dsrcH: null, dsrcM: null });
    assert.deepEqual([local.d, local.dd], ['2000-01-02', '2000-01-02']);
    for (const key of ['h', 'm', 'srcH', 'srcM', 'dh', 'dm', 'dsrcH', 'dsrcM']) {
        assert.equal(local[key], undefined, key);
    }
    const text = flatTreeText([{ ...rec, key: 'clock', sex: 'M' }], []);
    assert.match(text, /2000-01-02 \(UTC\+23\)/);
    assert.doesNotMatch(text, /12:00/);
    const again = parseTreeLine(text.trim());
    assert.equal(again.rec.srcH, undefined);
    assert.equal(again.rec.h, undefined);
});

check('explicit and legacy source times stay explicit, including midnight', () => {
    const rec = eventToMsk({ date: '1900-03-01', time: '00:30', plac: 'UTC+5' });
    const local = localRecord({ ...rec, plac: 'UTC+5', dd: rec.d, dh: rec.h, dm: rec.m,
        dsrcH: rec.srcH, dsrcM: rec.srcM, dp: 'UTC+5' });
    assert.deepEqual([local.d, local.srcH, local.srcM], ['1900-03-01', 0, 30]);
    assert.deepEqual([local.dd, local.dsrcH, local.dsrcM], ['1900-03-01', 0, 30]);
    const legacy = localRecord({ d: '1900-02-29', srcH: 0, srcM: 30, plac: 'UTC+5' });
    assert.deepEqual([legacy.d, legacy.srcH, legacy.srcM], ['1900-02-29', 0, 30]);
});

check('surname and name-only rows are not interpreted as unparenthesized zones', () => {
    assert.equal(parseTrigger('Иван Московский 2000-01-01').rec.n, 'Иван Московский');
    assert.equal(parseTrigger('Иван Московский'), null);
    for (const input of ['-Московский', 'Московский', '-Иван Московский']) {
        const line = parseTreeLine(input);
        assert.equal(line.nameOnly, true, input);
        assert.notEqual(line.k, 'err', input);
    }
});

check('zone validation still rejects unparenthesized birth/death suffixes', () => {
    for (const suffix of ['2000-01-01 UTC+5', '20000101 12:00 МСК+2',
        '2000-01-01 2020-01-01 12:00 GMT', '2000-01-01 Москва']) {
        assert.match(parseTrigger('Иван Московский ' + suffix).error, /в скобках/, suffix);
    }
    assert.equal(parseTrigger('Иван Московский 2000-01-01 12:00 (UTC+5)').error, undefined);
    assert.equal(parseTrigger('Иван 2000-01-01 ^ UTC+5').tail, 'UTC+5');
});

console.log('event-time-check: ' + checks + ' checks passed');
