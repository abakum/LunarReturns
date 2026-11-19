#!/usr/bin/env node
// node dev/ged-note-check.mjs [--pure]
// Dedicated NOTE/attribute grammar checks; integration uses isolated scratch DBs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../tgcloud/lib/parse.cjs');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
if (typeof P.gedNoteLines !== 'function') {
    console.error('ged-note-check: gedNoteLines is not exported yet; implementation unavailable.');
    process.exitCode = 1;
} else {
    let failed = 0, passed = 0;
    async function check(name, run) {
        try { await run(); passed++; console.log('PASS ' + name); }
        catch (e) { failed++; console.error('FAIL ' + name + '\n' + e.stack); }
    }
    const ged = lines => ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', ...lines, '0 TRLR'].join('\n');
    const person = lines => P.parseGedcom(ged(['0 @I1@ INDI', '1 NAME Test /Person/', ...lines])).indis[0];
    const exportNote = (note, person = true) => {
        const lines = P.gedNoteLines(note, person);
        assert.ok(Array.isArray(lines), 'helper returns physical lines without LF');
        for (const line of lines) {
            assert.doesNotMatch(line, /[\r\n]/);
            assert.ok(Buffer.byteLength(line + '\n', 'utf8') <= 255, 'UTF-8 budget including LF: ' + line);
            assert.equal(Buffer.from(line).toString('utf8'), line, 'no broken surrogate pairs');
        }
        return lines;
    };
    const plainRoundtrip = note => {
        const lines = exportNote(note);
        assert.match(lines[0], /^1 NOTE(?: |$)/);
        assert.ok(lines.slice(1).every(l => /^2 (?:CONT|CONC)(?: |$)/.test(l)));
        assert.equal(person(lines).note, note);
        return lines;
    };
    const title = '\u0422\u0438\u0442\u0443\u043b: ';
    const caste = '\u0421\u043e\u0441\u043b\u043e\u0432\u0438\u0435: ';
    const occupation = '\u0417\u0430\u043d\u044f\u0442\u0438\u0435: ';
    const residence = '\u0416\u0438\u043b: ';
    const burial = '\u041f\u043e\u0445\u043e\u0440\u043e\u043d\u0435\u043d: ';
    const event = 'Событие: ';
    const ellipsis = '\u2026';
    const globe = '\u{1F30D}';

    await check('NOTE ASCII/Cyrillic/non-BMP boundaries and exact whitespace', () => {
        for (const unit of ['a', '\u044f', globe]) {
            for (const n of [1, 60, 61, 62, 123, 124, 246, 247, 248, 249, 700]) plainRoundtrip(unit.repeat(n));
        }
        for (const note of ['first^^last', 'first^', '^last', 'first^^^last',
            ' leading  and trailing ', '  first  ^ second  ^^ final ',
            ('many   spaces ' + globe + ' ').repeat(80)]) plainRoundtrip(note);
        assert.equal(Buffer.byteLength(exportNote('a'.repeat(247))[0] + '\n'), 255);
        assert.equal(exportNote('a'.repeat(248)).length, 2);
    });

    await check('CONC prefers a word boundary without losing separators', () => {
        const lines = plainRoundtrip('a'.repeat(240) + ' ' + 'b'.repeat(20));
        const first = lines[0].slice('1 NOTE '.length);
        assert.ok(first === 'a'.repeat(240) || first === 'a'.repeat(240) + ' ',
            'split at last fitting space, not inside the next word');
        const spaced = plainRoundtrip('a'.repeat(239) + '   ' + 'b'.repeat(40));
        assert.ok(spaced.length > 1);
        const unbroken = plainRoundtrip(globe.repeat(160));
        assert.equal([...unbroken[0].slice(7)].length, 61, 'maximal whole-code-point prefix for a long word');
    });

    await check('TITL120 CAST/OCCU90 truncate only on export with one ellipsis', () => {
        for (const [label, tag, size] of [[title, 'TITL', 120], [caste, 'CAST', 90], [occupation, 'OCCU', 90]]) {
            for (const unit of ['a', '\u044f', globe]) {
                for (const count of [size - 1, size, size + 1, 400]) {
                    const input = unit.repeat(count);
                    const note = label + input + '^';
                    const lines = exportNote(note);
                    assert.equal(lines.length, 1, 'no CONT/CONC or empty trailing NOTE');
                    const prefix = '1 ' + tag + ' ';
                    assert.ok(lines[0].startsWith(prefix));
                    const value = lines[0].slice(prefix.length);
                    const fits = count <= size && Buffer.byteLength(prefix + input + '\n') <= 255;
                    let expected = input;
                    if (!fits) {
                        let n = Math.min(size - 1, count);
                        while (Buffer.byteLength(prefix + unit.repeat(n) + ellipsis + '\n') > 255) n--;
                        expected = unit.repeat(n) + ellipsis;
                    }
                    assert.equal(value, expected);
                    assert.ok([...value].length <= size);
                    assert.equal(note, label + input + '^');
                }
            }
            assert.deepEqual(exportNote(label + 'word '.repeat(100) + '^'),
                ['1 ' + tag + ' ' + ('word '.repeat(100)).slice(0, size - 1) + ellipsis]);
        }
    });

    await check('reserved labels are person-only and segment-initial', () => {
        assert.deepEqual(exportNote(title + 'Duke^' + caste + 'Noble^' + occupation + 'Writer^'),
            ['1 TITL Duke', '1 CAST Noble', '1 OCCU Writer']);
        assert.deepEqual(exportNote('prefix ' + title + 'Duke^Unknown: text'),
            ['1 NOTE prefix ' + title + 'Duke', '2 CONT Unknown: text']);
        const note = title + 'Duke^' + residence + 'Town';
        const lines = exportNote(note, false);
        assert.deepEqual(lines, ['1 NOTE ' + title + 'Duke', '2 CONT ' + residence + 'Town']);
        assert.equal(P.parseGedcom(ged(['0 @F1@ FAM', ...lines])).fams[0].note, note);
    });

    await check('RESI/BURI placement, nested parentheses, note-only and place-only', () => {
        assert.deepEqual(exportNote(residence + '(Town)^' + residence + '(Village)^'),
            ['1 RESI', '2 PLAC Town', '1 RESI', '2 PLAC Village']);
        assert.deepEqual(exportNote(burial + '(Town (District)) grave (stone)^'),
            ['1 BURI', '2 PLAC Town (District)', '2 NOTE grave (stone)']);
        assert.deepEqual(exportNote(burial + '(Town)^'), ['1 BURI', '2 PLAC Town']);
        assert.deepEqual(exportNote(burial + 'grave^'), ['1 BURI', '2 NOTE grave']);
        assert.deepEqual(exportNote(burial + '() участок 1980^'), ['1 BURI', '2 NOTE участок 1980']);
        assert.deepEqual(exportNote(burial + '2000-02-02 участок 1980^'), ['1 BURI', '2 DATE 2 FEB 2000', '2 NOTE участок 1980']);
    });

    await check('all structured fields and bounded ranges round-trip for all six types', () => {
        for (const [tag, label, value] of [['BURI', burial], ['RESI', residence],
            ['OCCU', occupation, 'Teacher'], ['TITL', title, 'Duke'], ['CAST', caste, 'Noble'], ['EVEN', event, 'Постриг']]) {
            const head = value && tag !== 'EVEN' ? [`1 ${tag} ${value}`] : [`1 ${tag}`];
            if (tag === 'EVEN') head.push('2 TYPE ' + value);
            for (const date of ['', '1698', 'CAL MAY 1698', 'ABT 6 MAY 1698', 'FROM 1698', 'TO MAY 1698', 'AFT 1698', 'BEF MAY 1698']) {
                for (const place of ['', 'Town']) for (const note of ['', '1980 участок']) {
                    if (!value && !date && !place && !note) continue;
                    const lines = [...head, ...(date ? ['2 DATE ' + date] : []),
                        ...(place ? ['2 PLAC ' + place] : []), ...(note ? ['2 NOTE ' + note] : [])];
                    const tail = person(lines).note;
                    assert.ok(tail.startsWith(label));
                    assert.deepEqual(exportNote(tail), lines, tail);
                    assert.equal(person(exportNote(tail)).note, tail);
                }
            }
            const metadata = ['2 PLAC Town', '2 NOTE downstream 1980'];
            const tail = person([...head, '2 DATE FROM 12340506 TO 12340507', ...metadata]).note;
            const prefix = label + (value ? value + ' ' : '');
            assert.equal(tail, prefix + '1234-05-06[ (Town) downstream 1980^' + prefix + '1234-05-07] (Town) downstream 1980^');
            assert.deepEqual(exportNote(tail), [...head, '2 DATE FROM 6 MAY 1234', ...metadata, ...head, '2 DATE TO 7 MAY 1234', ...metadata]);
            assert.equal(person(exportNote(tail)).note, tail);
        }
        assert.equal(person(['1 EVEN Y', '2 TYPE Постриг', '2 DATE 1698', '2 NOTE в монашестве Маргарита']).note,
            event + 'Постриг 1698 в монашестве Маргарита^');
        assert.equal(person(['1 OCCU', '2 NOTE учитель']).note, occupation + '() учитель^');
        const literal = person(['1 TITL Chapter (1980)', '2 PLAC Town (District)', '2 NOTE (keep) 1990']);
        assert.deepEqual(exportNote(literal.note), ['1 TITL Chapter 1980', '2 PLAC Town District', '2 NOTE keep 1990']);
        assert.deepEqual(exportNote(person(['1 OCCU Literal 1980[', '2 DATE TO 1990']).note), ['1 OCCU Literal 1980[', '2 DATE TO 1990']);
        assert.deepEqual(exportNote(person(['1 RESI', '2 NOTE 1980] literal']).note), ['1 RESI', '2 NOTE 1980] literal']);
        assert.equal(person(['1 RESI', '2 DATE BET 1 JAN 1980 AND 1 JAN 1985', '2 PLAC Town']).note, residence + '(Town)^');
    });

    await check('BURI NOTE is one maximally filled truncated line, never CONT/CONC', () => {
        for (const unit of ['a', '\u044f', globe]) {
            for (const count of [1, 60, 61, 62, 123, 124, 247, 248, 400]) {
                const input = unit.repeat(count);
                const lines = exportNote(burial + '(Town) ' + input + '^');
                assert.deepEqual(lines.slice(0, 2), ['1 BURI', '2 PLAC Town']);
                assert.equal(lines.length, 3);
                let expected = input;
                if (Buffer.byteLength('2 NOTE ' + input + '\n') > 255) {
                    let n = count;
                    while (Buffer.byteLength('2 NOTE ' + unit.repeat(n) + ellipsis + '\n') > 255) n--;
                    expected = unit.repeat(n) + ellipsis;
                }
                assert.equal(lines[2], '2 NOTE ' + expected);
            }
        }
        assert.deepEqual(exportNote(burial + 'word '.repeat(80) + '^'),
            ['1 BURI', '2 NOTE ' + ('word '.repeat(80)).slice(0, 244) + ellipsis]);
    });

    await check('import accumulates repeated NOTE and attributes in order; continuations stay scoped', () => {
        const p = person(['1 NOTE first ', '2 CONC joined', '2 CONT', '2 CONT last',
            '1 BIRT', '2 NOTE ignored', '3 CONT ignored too', '1 NOTE second',
            '1 TITL Duke', '2 CONT must not leak', '1 TITL Count',
            '1 CAST Noble', '1 CAST Citizen', '1 OCCU Writer', '1 OCCU Teacher',
            '1 RESI', '2 PLAC Town', '1 RESI', '2 PLAC Village',
            '1 NOTE final', '1 OCCU Farmer', '2 CONC must not leak']);
        assert.equal(p.note, 'first joined^^last^second^' + title + 'Duke^' + title + 'Count^'
            + caste + 'Noble^' + caste + 'Citizen^' + occupation + 'Writer^' + occupation + 'Teacher^'
            + residence + '(Town)^' + residence + '(Village)^final^' + occupation + 'Farmer^');
        const f = P.parseGedcom(ged(['0 @F1@ FAM', '1 NOTE first', '2 CONT line',
            '1 MARR', '2 NOTE ignored', '1 NOTE second', '2 CONC joined'])).fams[0];
        assert.equal(f.note, 'first^line^secondjoined');
    });

    await check('import repeated BURI notes join with spaces and retain fallback DEAT', () => {
        const p = person(['1 BURI', '2 DATE 2 FEB 2000', '2 PLAC Town (District)',
            '2 NOTE grave', '3 CONC stone', '3 CONT next', '2 NOTE last',
            '1 BURI', '2 PLAC Elsewhere', '1 BURI', '2 NOTE only note']);
        assert.equal(p.note, burial + '2000-02-02 (Town District) gravestone next last^'
            + burial + '(Elsewhere)^' + burial + 'only note^');
        assert.equal(p.deat.date, '2000-02-02');
        assert.equal(p.deat.plac, 'Elsewhere', 'legacy BURI fallback uses the last supplied place');
        assert.deepEqual(exportNote(p.note), ['1 BURI', '2 DATE 2 FEB 2000', '2 PLAC Town District',
            '2 NOTE gravestone next last', '1 BURI', '2 PLAC Elsewhere', '1 BURI', '2 NOTE only note']);
        const ownDeath = person(['1 DEAT', '2 DATE 1 JAN 1999', '2 PLAC Home',
            '1 BURI', '2 DATE 2 FEB 2000', '2 PLAC Cemetery']);
        assert.equal(ownDeath.deat.date, '1999-01-01');
        assert.equal(ownDeath.deat.plac, 'Home');
        const period = person(['1 BURI', '2 DATE FROM 1999 TO 2000']);
        assert.equal(period.note, burial + '1999[^' + burial + '2000]^');
        assert.equal(period.deat.date, '2000-01-01');
        assert.equal(period.deat.abt, person(['1 BURI', '2 DATE BEF 2000']).deat.abt);
    });

    if (!process.argv.includes('--pure')) {
        await check('VK/TG isolated DB -> flat -> DB -> GEDCOM -> import', async () => {
            const tmp = fs.mkdtempSync(path.join('/tmp/kilo', 'lr-ged-note-'));
            process.env.LR_DB = path.join(tmp, 'vk.db');
            process.env.LR_DEV_DB = path.join(tmp, 'tg.json');
            const vkFile = path.join(tmp, 'vk.cjs');
            fs.writeFileSync(vkFile, fs.readFileSync(path.join(ROOT, 'lunarreturns.js'), 'utf8'));
            const argv = process.argv, log = console.log;
            let VK;
            try {
                process.argv = [process.execPath, vkFile, 'test', ''];
                console.log = () => {};
                VK = require(vkFile).__test;
            } finally { process.argv = argv; console.log = log; }
            fs.cpSync(path.join(ROOT, 'dev/sdk-mock'), path.join(ROOT, 'node_modules/sdk'), { recursive: true });
            const TG = await import('../tgcloud/lib/bot.js');
            const source = ged(['0 @I1@ INDI', '1 NAME Parent', '1 BIRT', '2 DATE 1 JAN 1950',
                '2 PLAC Town (District)', '1 DEAT', '2 DATE 1 JAN 2000', '2 PLAC City (District)',
                '1 NOTE first (keep)', '1 NOTE second', '2 CONT line', '1 TITL Duke', '1 TITL Count',
                '1 CAST Noble', '1 OCCU Writer', '1 RESI', '2 PLAC Town',
                '1 EVEN', '2 TYPE Move', '2 DATE FROM 1970 TO 1980', '2 PLAC Town', '2 NOTE family',
                '1 BURI', '2 PLAC Cemetery', '2 NOTE stone',
                '0 @I2@ INDI', '1 NAME Dateless', '1 NOTE stub', '1 OCCU Teacher',
                '0 @I3@ INDI', '1 NAME Unanchored', '1 NOTE undated', '1 TITL Baron',
                '0 @I4@ INDI', '1 NAME UnanchoredPartner', '1 RESI', '2 PLAC Village',
                '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 MARR', '2 DATE 1 JAN 1970',
                '2 PLAC Village (District)', '1 DIV', '2 DATE 1 JAN 1980', '2 PLAC Capital (District)',
                '1 NOTE family (keep)', '1 NOTE ' + title + 'ordinary family text',
                '0 @F2@ FAM', '1 HUSB @I3@', '1 WIFE @I4@', '1 NOTE undated family']);
            const expected = P.parseGedcom(source);
            assert.equal(expected.indis[0].birt.plac, 'Town District');
            assert.equal(expected.indis[0].deat.plac, 'City District');
            assert.equal(expected.fams[0].marr.plac, 'Village District');
            assert.equal(expected.fams[0].div.plac, 'Capital District');
            assert.match(expected.indis[0].note, /first \(keep\)/);
            assert.match(expected.fams[0].note, /family \(keep\)/);
            const snapshots = [];
            for (const [label, api] of [['VK', VK], ['TG', TG]]) {
                const id = 761113;
                await api.importGedcom(id, P.parseGedcom(source));
                const flat = await api.chatFlatText(id);
                assert.ok(flat.includes(title + 'Duke'), label + ': attributes in flat text');
                const tree = P.parseTree(flat);
                assert.deepEqual(tree.errors, []);
                await api.clearChatTree(id);
                await api.applyTree(id, tree);
                const text = await api.gedcomText(id);
                const restored = P.parseGedcom(text);
                for (const original of expected.indis) {
                    assert.equal(restored.indis.find(p => p.name === original.name)?.note,
                        original.note, label + ': ' + original.name);
                }
                assert.deepEqual(restored.fams.map(f => f.note).sort(), expected.fams.map(f => f.note).sort(),
                    label + ': family labels stay plain');
                for (const place of ['Town', 'City', 'Village', 'Capital']) {
                    assert.ok(flat.includes('(' + place + ' District)'), label + ': flat place ' + place);
                    assert.ok(text.includes('2 PLAC ' + place + ' District\n'), label + ': GED place ' + place);
                }
                assert.match(text, /1 TITL Duke\n1 TITL Count/);
                assert.match(text, /1 BURI\n2 PLAC Cemetery\n2 NOTE stone/);
                await api.importGedcom(id, restored);
                const again = P.parseGedcom(await api.gedcomText(id));
                snapshots.push({ people: again.indis.map(p => [p.name, p.note]).sort(),
                    families: again.fams.map(f => f.note) });
            }
            assert.deepEqual(snapshots[0], snapshots[1], 'VK/TG semantic snapshots match');
            console.log('Isolated integration artifacts: ' + tmp);
        });
    }
    console.log(`ged-note-check: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
}
