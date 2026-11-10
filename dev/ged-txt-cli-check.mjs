#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseGedcom, parseTree } from '../tgcloud/lib/parse.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join('/tmp/kilo', 'lr-cli-'));
const sentinel = path.join(tmp, 'do-not-touch.db');
fs.writeFileSync(sentinel, 'not a database');
const read = file => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
function run(mode, args, success = true) {
    const result = spawnSync(process.execPath, [path.join(root, 'bin', mode + '.cjs'), ...args], {
        cwd: tmp, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, LR_DB: sentinel, VK_TOKEN: '', LR_DEV_DB: sentinel },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, success ? 0 : 1, result.stdout + result.stderr);
    if (!success) assert.match(result.stderr, new RegExp(mode + ': '));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'not a database');
    return result;
}
try {
    const fixtures = ['repeated-one-sided-families', 'divorce-without-wedding',
        'qualified-partial-dates-notes-places', 'multigeneration-shared-person',
        'dateless-child-fictive-birth', 'repeated-full-couple-marriages', 'hash-text-xrefs-dateless-notes', 'fam-nodate'];
    for (const name of fixtures) {
        const source = fs.readFileSync(path.join(root, 'dev/fixtures', name + '.ged'), 'utf8');
        if (name === 'hash-text-xrefs-dateless-notes') {
            const parsed = parseGedcom(source);
            assert.equal(parsed.indis[0].__xref, 'I#1');
            assert.equal(parsed.fams[0].husb, 'I#1');
            assert.equal(parsed.fams[0].wife, 'I#2');
            assert.equal(parsed.fams[0].__xref, 'F#1');
            assert.equal(parsed.indis[0].name, 'Dateless №Father');
            assert.equal(parsed.indis[0].note, 'Father №1, continued №2^Next №3');
            assert.equal(parsed.indis[1].note, 'Mother №4');
            assert.equal(parsed.indis[0].birt, null);
            assert.equal(parsed.fams[0].marr, null);
            assert.equal(parsed.fams[0].note, 'Family №5^Undated №6');
            assert.equal(parsed.indis[2].birt.plac, 'Birth №7');
            assert.equal(parsed.indis[2].deat.plac, 'Death №8');
            assert.equal(parsed.fams[1].marr.plac, 'Wedding №10');
            assert.equal(parsed.fams[1].div.plac, 'Divorce №11');
            assert.equal(parsed.indis[4].deat.plac, 'Burial №13');
        }
        const input = path.join(tmp, name + ' with spaces.GED');
        fs.writeFileSync(input, '\uFEFF' + source);
        run('ged2txt', [input]);
        const txt = read(input + '.txt');
        assert.equal(fs.readFileSync(input + '.txt')[0], 0xef);
        assert.equal(parseTree(txt).errors.length, 0, txt);
        assert.ok(txt.length);
        run('ged2txt', [input], false);
        const output = input.replace(/\.ged$/i, '.txt.ged');
        run('txt2ged', [input + '.txt']);
        assert.equal(read(input), source);
        const converted = fs.readFileSync(output);
        assert.equal(converted[0], 0xef);
        run('txt2ged', [input + '.txt'], false);
        assert.deepEqual(fs.readFileSync(output), converted);
        const ged = parseGedcom(read(output));
        assert.ok(ged);
        if (name === 'hash-text-xrefs-dateless-notes') {
            assert.ok(txt.includes('Dateless №Father ~I№1 ^Father №1, continued №2^Next №3'), txt);
            assert.ok(txt.includes('Dateless №Mother ~I№2 ^Mother №4'), txt);
            assert.ok(txt.includes('+ ^Family №5^Undated №6'), txt);
            assert.doesNotMatch(txt, /#/);
            assert.equal(ged.indis.find(i => i.name === 'Dateless №Father').birt, null);
            assert.equal(ged.indis.find(i => i.name === 'Dateless №Mother').note, 'Mother №4');
            assert.ok(ged.fams.some(f => f.marr === null && f.note === 'Family №5^Undated №6'));
        }
        assert.equal(ged.indis.length, parseGedcom(source).indis.length);
        if (name === 'fam-nodate') {
            assert.equal(ged.fams.length, 3);
            const children = ged.indis.filter(i => i.name === 'ВиК');
            assert.equal(children.length, 2);
            assert.notEqual(children[0].__xref, children[1].__xref);
            const father = ged.indis.find(i => i.name === 'ВК');
            assert.equal(ged.fams.filter(f => f.husb === father.__xref).length, 2);
        }
        if (name === 'repeated-one-sided-families') {
            assert.equal(ged.fams.length, 3);
            assert.ok(ged.fams.some(f => !f.chil.length));
            assert.equal(txt.split('\n').filter(l => l === '+').length, 3);
        }
        if (name === 'divorce-without-wedding') {
            assert.match(txt, /\+ 1980-02\? \(Kazan\) \^Separation/);
            assert.equal(ged.fams[0].div.plac, 'Kazan');
            assert.equal(ged.fams[0].marr, null);
        }
        if (name === 'qualified-partial-dates-notes-places') {
            for (const token of ['1950?', '1952-03=', '1980-04-03~', '2020-02-02<', '1970-06>',
                '(Perm)', '(Wedding Town)', '(Divorce Town)', '^First note^Second line']) assert.ok(txt.includes(token), txt);
            assert.equal(ged.fams.length, 1);
        }
        if (name === 'multigeneration-shared-person') {
            assert.equal(ged.fams.length, 3);
            assert.ok(ged.indis.some(i => i.name === 'Mother'));
            assert.match(txt, /===Child/);
        }
        if (name === 'dateless-child-fictive-birth') assert.match(txt, /DatelessChild .*~/);
        if (name === 'repeated-full-couple-marriages') {
            assert.equal(ged.fams.length, 3);
            assert.match(txt, /\+1970 1980 ~F1/);
            assert.match(txt, /\+1990 ~F2/);
            assert.match(txt, /\+1982 1988/);
            for (const [date, child] of [['1970-01-01', 'FirstChild'], ['1982-01-01', 'MiddleChild'], ['1990-01-01', 'LastChild']]) {
                const f = ged.fams.find(f => f.marr.date === date);
                assert.deepEqual(f.chil.map(x => ged.indis.find(i => i.__xref === x).name), [child]);
            }
        }
        run('ged2txt', [output]);
        // TXT has no xref identity; a TXT->GED conversion allocates new stub IDs.
        const normalize = s => {
            if (name === 'hash-text-xrefs-dateless-notes') return s.replace(/ ~\S+(?= \^)/g, ' ~xref');
            if (name !== 'fam-nodate') return s;
            const xrefs = new Map();
            return s.replace(/ ~\S+$/gm, token => {
                if (!xrefs.has(token)) xrefs.set(token, ' ~xref' + (xrefs.size + 1));
                return xrefs.get(token);
            });
        };
        assert.equal(normalize(read(output + '.txt')), normalize(txt), name + ': normalized TXT must repeat');
        console.log(name + ': contents and round-trip OK');
    }
    for (const mode of ['ged2txt', 'txt2ged']) {
        run(mode, [], false);
        run(mode, ['a', 'b'], false);
        run(mode, ['wrong.extension'], false);
        run(mode, ['missing' + (mode === 'ged2txt' ? '.ged' : '.ged.txt')], false);
    }
    for (const [mode, name, content] of [
        ['ged2txt', 'bad.ged', 'not GEDCOM'],
        ['txt2ged', 'bad-tree.ged.txt', '-Father 1950\n===Orphan 1980'],
        ['txt2ged', 'empty.ged.txt', ''],
        ['ged2txt', 'invalid-utf8.ged', Buffer.from([0xff, 0xfe])],
    ]) {
        const input = path.join(tmp, name);
        fs.writeFileSync(input, content);
        run(mode, [input], false);
        assert.ok(!fs.existsSync(mode === 'ged2txt' ? input + '.txt' : input.replace(/\.ged\.txt$/i, '.txt.ged')));
    }
    const upper = path.join(tmp, 'Mixed.Ged.TXT');
    fs.writeFileSync(upper, '\uFEFF-Father 1950\n+\n--Child 1980');
    run('txt2ged', [upper]);
    assert.ok(fs.existsSync(path.join(tmp, 'Mixed.txt.ged')));
    assert.equal(read(upper), '-Father 1950\n+\n--Child 1980');
    const dotted = path.join(tmp, 'Stem.ged.part.gED.TxT');
    fs.writeFileSync(dotted, read(upper));
    run('txt2ged', [dotted]);
    assert.ok(fs.existsSync(path.join(tmp, 'Stem.ged.part.txt.ged')));
    fs.mkdirSync(path.join(tmp, 'directory.ged'));
    run('ged2txt', [path.join(tmp, 'directory.ged')], false);
    const link = path.join(tmp, 'linked.ged');
    fs.writeFileSync(link, fs.readFileSync(path.join(root, 'dev/fixtures/divorce-without-wedding.ged')));
    fs.symlinkSync(link, link + '.txt');
    const before = fs.readFileSync(link);
    run('ged2txt', [link], false);
    assert.deepEqual(fs.readFileSync(link), before);
    const linkedTxt = path.join(tmp, 'linked-back.ged.txt');
    fs.writeFileSync(linkedTxt, read(upper));
    fs.symlinkSync(linkedTxt, path.join(tmp, 'linked-back.txt.ged'));
    run('txt2ged', [linkedTxt], false);
    assert.equal(read(linkedTxt), read(upper));
    console.log('CLI errors, UTF-8/BOM, case, paths, existing outputs and DB isolation OK');
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}
