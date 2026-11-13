import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chatFlatArtifacts, NOT_FOR_GRAFT, packToCsv } from '../tgcloud/lib/parse.cjs';
import { fileBaseOf } from '../tgcloud/lib/chart.cjs';

const require = createRequire(import.meta.url);
const canon = require('../tgcloud/lib/parse.cjs');
const tmp = fs.mkdtempSync(path.join('/tmp/kilo', 'lr-flat-'));
const pack = '-Отец 1950-01-01\n+1970-01-01\nМать 1952-01-01\n--Сын 1975-01-01';
for (const input of [pack, NOT_FOR_GRAFT + '\n' + pack, '\uFEFF' + NOT_FOR_GRAFT + '\n' + pack]) {
    const files = chatFlatArtifacts(input);
    assert.deepEqual(files.txt, canon.chatFlatArtifacts(input).txt);
    assert.deepEqual(files.csv(), canon.chatFlatArtifacts(input).csv());
    assert.equal(files.txt.name, fileBaseOf('Древо чата') + '.ged.txt');
    assert.equal(files.txt.type, 'text/plain');
    assert.equal(files.txt.content, '\uFEFF' + NOT_FOR_GRAFT + '\n' + pack);
    assert.deepEqual(files.csv(), { name: 'Древо чата.ged.csv', type: 'text/csv',
        content: '\uFEFF' + packToCsv(pack) });
    assert.ok(files.csv().content.includes('\t'));
}

function run(platform, name, commands, extra = {}) {
    const trace = path.join(tmp, name + '.jsonl');
    const result = spawnSync(process.execPath,
        [platform === 'vk' ? 'dev/vk-repl.mjs' : 'dev/repl.mjs', '--fresh',
            ...(platform === 'tg' ? ['--private'] : [])], {
            cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 120000,
            maxBuffer: 16 * 1024 * 1024, input: commands.join('\n') + '\n',
            env: { ...process.env, LR_DB: path.join(tmp, name + '.db'),
                LR_DEV_DB: path.join(tmp, name + '.json'), LR_VK_TRACE: trace,
                LR_VKOFF: '943', ...extra },
        });
    const log = result.stdout + result.stderr;
    fs.writeFileSync(path.join(tmp, name + '.log'), log);
    assert.equal(result.status, 0, log);
    assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError/);
    return { log, calls: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}
const commands = [pack.replaceAll('\n', '\\n'), '/', '/4 4', '/links', '!wait 300'];
for (const [name, extra] of [['normal', {}], ['retry', { LR_EDIT_FAIL1: '1' }], ['csv-fail', { LR_CSV_FAIL: '1' }]]) {
    const { calls, log } = run('vk', name,
        name === 'csv-fail' ? [...commands.slice(0, -1), '!wait 5500'] : commands, extra);
    const edits = calls.filter(c => c.method === 'messages.edit' && c.params.attachment);
    const button = edits.filter(c => c.params.conversation_message_id);
    const links = edits.filter(c => c.params.message_id);
    assert.equal(button.length, name === 'retry' ? 2 : 1, log);
    assert.equal(links.length, 1, log);
    for (const c of edits) {
        assert.equal(c.params.message, '-+=');
        assert.equal(c.params.attachment.split(',').length, name === 'csv-fail' ? 1 : 2);
    }
    const kb = JSON.parse(button.at(-1).params.keyboard);
    assert.ok(kb.buttons.flat().some(b => b.action.label === '-+='));
    if (name === 'retry') assert.deepEqual(button[0].params, button[1].params);
    if (name === 'csv-fail') assert.match(log, /csv upload:/);
    const uploads = calls.filter(c => c.method === 'upload');
    for (const ext of ['txt', 'csv']) {
        const bodies = uploads.filter(c => c.body.includes('.ged.' + ext + '"'));
        assert.equal(bodies.length, name === 'csv-fail' && ext === 'csv' ? 6 : 2);
        const expected = ext === 'txt' ? '\uFEFF' + NOT_FOR_GRAFT : '\uFEFF';
        assert.ok(bodies.every(c => c.body.includes(expected)));
        const content = b => b.slice(b.indexOf('\r\n\r\n') + 4, b.lastIndexOf('\r\n--'));
        assert.equal(content(bodies[0].body), content(bodies[1].body));
    }
    console.log('VK ' + name + ': button + /links OK');
}
for (const platform of ['vk', 'tg']) {
    const { log } = run(platform, platform + '-empty', ['/', '/2 4', '/links']);
    assert.match(log, /древо пусто|связей пока нет/);
    assert.doesNotMatch(log, /вложение|sendDocument:/);
}
const txtFail = run('vk', 'txt-fail', [...commands.slice(0, -1), '!wait 5500'], { LR_TXT_FAIL: '1' });
assert.equal(txtFail.calls.filter(c => c.method === 'messages.edit' && c.params.message.startsWith('💥')).length, 2);
assert.equal(txtFail.calls.filter(c => c.method === 'upload' && c.body.includes('.ged.csv"')).length, 0);
assert.match(txtFail.log, /Не удалось выложить файл/);
const tg = run('tg', 'tg-export', commands.slice(0, -1));
assert.equal((tg.log.match(/sendDocument:/g) || []).length, 4, tg.log);
assert.equal((tg.log.match(/sendDocument: Древо чата.ged.csv/g) || []).length, 2, tg.log);
assert.match(tg.log, /\[4\.4\] -\+=/);
const vkCalls = fs.readFileSync(path.join(tmp, 'normal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
for (const ext of ['txt', 'csv']) {
    const body = vkCalls.find(c => c.method === 'upload' && c.body.includes('.ged.' + ext + '"')).body;
    const content = body.slice(body.indexOf('\r\n\r\n') + 4, body.lastIndexOf('\r\n--'));
    const output = tg.log.match(new RegExp('→ (.+Древо чата\\.ged\\.' + ext + ')'))[1];
    assert.equal(fs.readFileSync(output, 'utf8'), content);
}
for (const platform of ['vk', 'tg']) {
    for (const long of [false, true]) {
        const tree = long ? pack + '\n' + Array.from({ length: 180 }, (_, i) =>
            '--Потомок' + i + ' Длинное Имя Для Переполнения 2000-01-01').join('\n') : pack;
        const { log, calls } = run(platform, platform + '-branch-' + long,
            [tree.replaceAll('\n', '\\n'), 'Отец 1950-01-01', '>3 /links',
                ...(platform === 'vk' ? ['!wait 300'] : [])]);
        assert.doesNotMatch(log, /csv|fetch failed|upload:/);
        if (long) assert.match(log, platform === 'tg' ? /sendDocument:/ : /📎 вложение/);
        else assert.match(log, /-Отец 1950-01-01/);
        if (platform === 'vk') assert.equal(calls.filter(c => c.method === 'upload').length, long ? 1 : 0);
    }
}
console.log('TG button + /links, both empty trees, CJS/ESM artifacts OK');
console.log('VK/TG file contents identical; short/long reply branches OK');
const roundPack = '-Иван 1950? (Родина) 2020-02= (Покой)\n+\n+\n==Мария 1980-03-04?\n--Пётр 1982=\n+1970-01? (Венчание) 1990= (Развод) ^семья\n==Анна 1992-04?\n+2000= 2005? (Разъезд)\n==Ева 2001-01-02=';
const divorcePack = '-Отец 1940\n+ 1980 (Казань) ^развод без свадьбы\n--Сын 1960\n++ 2001-02? (Пермь) ^семья сына\nЖена 1962\n===Дочь 1985\n+1973 1980 (Казань)';
for (const [name, source, canonical, count] of [
    ['roundtrip', roundPack, roundPack, /персон 5, семей 4, детей 4/],
    ['divorce', divorcePack, divorcePack, /персон 4, семей 3, детей 2/],
    ['empty-place', divorcePack.replace('+1973 1980', '+1973 () 1980'), divorcePack, /персон 4, семей 3, детей 2/],
]) {
const inputFile = path.join(tmp, name + '.ged.txt');
fs.writeFileSync(inputFile, source);
for (const platform of ['tg', 'vk']) {
    const { log, calls } = run(platform, platform + '-' + name,
        ['!txt ' + inputFile, '/2 2', '/links', '/bell', '!dump', ...(platform === 'vk' ? ['!wait 300'] : [])]);
    assert.match(log, count);
    assert.doesNotMatch(log, /💥/);
    assert.match(log, /Иван|Отец/);
    const contents = {};
    for (const ext of ['txt', 'csv']) {
        if (platform === 'tg') {
            const output = log.match(new RegExp('→ (.+Древо чата\\.ged\\.' + ext + ')'));
            assert.ok(output, log);
            contents[ext] = fs.readFileSync(output[1], 'utf8').replace(/^\uFEFF/, '');
        } else {
            const upload = calls.find(c => c.method === 'upload' && c.body.includes('.ged.' + ext + '"'));
            assert.ok(upload, log);
            contents[ext] = upload.body.slice(upload.body.indexOf('\r\n\r\n') + 4, upload.body.lastIndexOf('\r\n--')).replace(/^\uFEFF/, '');
        }
    }
    assert.equal(contents.txt, NOT_FOR_GRAFT + '\n' + canonical);
    assert.equal(contents.csv, packToCsv(canonical));
    if (name === 'roundtrip') assert.match(contents.csv, /1970-01\?\tВенчание\t1990=\tРазвод\tсемья/);
    else {
        assert.match(contents.csv, /\t\t\t1980\tКазань\tразвод без свадьбы/);
        assert.match(contents.csv, /2001-02\?\tПермь\tсемья сына/);
    }
    console.log(platform + ': ' + name + ', TXT drop, TXT/CSV exports, bell OK');
}
}
for (const platform of ['tg', 'vk']) {
    const { log } = run(platform, platform + '-closed-spouse',
        ['-Иван\\n+\\n--Ребёнок\\nПоздний супруг', '/links', '!dump', ...(platform === 'vk' ? ['!wait 300'] : [])]);
    assert.match(log, /имя без маркера — только вторая половина/);
    assert.match(log, /персон 2, семей 1, детей 1/);
}
console.log('Logs: ' + tmp);
// Independent real adapters: GED upload, exported files, repeated TXT application,
// and bell. Inspect each platform's GED, not just equality between platforms.
for (const platform of ['tg', 'vk']) {
    const fixture = path.resolve('dev/fixtures/repeated-full-couple-marriages.ged');
    const first = run(platform, platform + '-repeated-ged',
        ['!ged ' + fixture, '/2 2', '/links', '/bell', '!dump', ...(platform === 'vk' ? ['!wait 300'] : [])]);
    const exported = (result, ext) => {
        if (platform === 'tg') {
            const output = result.log.match(new RegExp('→ (.+(?:Древо чата|Гедком-древо чата)\\.ged' + (ext ? '\\.' + ext : '') + ')\\r?$','m'));
            assert.ok(output, result.log);
            return fs.readFileSync(output[1], 'utf8').replace(/^\uFEFF/, '');
        }
        const upload = result.calls.find(c => c.method === 'upload'
            && c.body.includes('.ged' + (ext ? '.' + ext : '') + '"'));
        assert.ok(upload, result.log);
        return upload.body.slice(upload.body.indexOf('\r\n\r\n') + 4, upload.body.lastIndexOf('\r\n--')).replace(/^\uFEFF/, '');
    };
    const txt = exported(first, 'txt');
    assert.match(txt, /\+1970 1980 ~F1/);
    assert.match(txt, /\+1990 ~F2/);
    assert.match(exported(first, 'csv'), /\t~F1/);
    const file = path.join(tmp, platform + '-repeated.ged.txt');
    fs.writeFileSync(file, txt);
    const clean = run(platform, platform + '-repeated-clean-txt',
        ['!txt ' + file, '/2 2', '/links', '/bell', ...(platform === 'vk' ? ['!wait 300'] : [])]);
    assert.equal(exported(clean, 'txt'), txt);
    const again = run(platform, platform + '-repeated-txt',
        ['!ged ' + fixture, '/2 2', txt.replaceAll('\n', '\\n'), txt.replaceAll('\n', '\\n'),
            '/links', '/gedcom', '/bell', '!dump', ...(platform === 'vk' ? ['!wait 300'] : [])]);
    assert.doesNotMatch(again.log, /💥/);
    assert.equal(exported(again, 'txt'), txt);
    const ged = canon.parseGedcom(exported(again, ''));
    assert.equal(ged.fams.length, 3);
    assert.equal(ged.indis.length, 6);
    // Fixture dates have year precision: approximate events intentionally do not ring.
    assert.match(again.log, /Событий нет/);
    for (const [date, child] of [['1970-01-01', 'FirstChild'], ['1982-01-01', 'MiddleChild'], ['1990-01-01', 'LastChild']]) {
        assert.deepEqual(ged.fams.find(f => f.marr.date === date).chil.map(x => ged.indis.find(i => i.__xref === x).name), [child]);
        assert.ok(again.log.includes(child));
    }
    console.log(platform + ': three marriages, exact children, repeated import, GED/TXT/CSV and bell OK');
}
const notesInput = '#not for cut and graft\n-Отец ^1980 заметка^ещё# cut ^lost\n+^семья^строка #cut\nМать ^супруга# cut\n--Сын ^ребёнок\n-Якорь# cut ^lost\n+ ^односторонняя\n-Датный 1950 #cut';
const notesExpected = '=Мать ^супруга\n+ ^семья^строка\nОтец ^1980 заметка^ещё\n--Сын ^ребёнок\n-Якорь\n+ ^односторонняя\n-Датный 1950';
const notesFile = path.join(tmp, 'notes-comments.ged.txt');
fs.writeFileSync(notesFile, notesInput);
for (const platform of ['tg', 'vk']) {
    for (const kind of ['notes', 'ged-hashes']) {
        const input = kind === 'notes' ? '!txt ' + notesFile
            : '!ged ' + path.resolve('dev/fixtures/hash-text-xrefs-dateless-notes.ged');
        const { log, calls } = run(platform, platform + '-' + kind,
            [input, '/2 2', '/links', '/bell', '!dump', ...(platform === 'vk' ? ['!wait 300'] : [])]);
        assert.doesNotMatch(log, /💥/);
        const contents = {};
        for (const ext of ['txt', 'csv']) {
            if (platform === 'tg') {
                const output = log.match(new RegExp('→ (.+Древо чата\\.ged\\.' + ext + ')'));
                assert.ok(output, log);
                contents[ext] = fs.readFileSync(output[1], 'utf8').replace(/^\uFEFF/, '');
            } else {
                const upload = calls.find(c => c.method === 'upload' && c.body.includes('.ged.' + ext + '"'));
                assert.ok(upload, log);
                contents[ext] = upload.body.slice(upload.body.indexOf('\r\n\r\n') + 4, upload.body.lastIndexOf('\r\n--')).replace(/^\uFEFF/, '');
            }
        }
        if (kind === 'notes') {
            assert.equal(contents.txt, NOT_FOR_GRAFT + '\n' + notesExpected);
            assert.ok(contents.csv.includes('Отец\t\t\t\t\t1980 заметка^ещё'));
            assert.ok(contents.csv.includes('Мать\t\t\t\t\tсупруга'));
            assert.ok(contents.csv.includes('\t\t\t\t\t\tсемья^строка'));
            assert.doesNotMatch(contents.csv, /cut|lost/);
            assert.match(log, /Датный/);
        } else {
            for (const token of ['Dateless №Father ~I№1 ^Father №1, continued №2^Next №3',
                'Dateless №Mother ~I№2 ^Титул: Mother №4^', '+ ^Family №5^Undated №6',
                '(Birth №7)', '(Death №8)', '(Wedding №10)', '(Divorce №11)', '(Burial №13)']) {
                assert.ok(contents.txt.includes(token), contents.txt);
            }
            assert.ok(contents.csv.includes('Father №1, continued №2^Next №3'));
            assert.ok(contents.csv.includes('Family №5^Undated №6'));
            assert.match(log, /Dated №Person/);
        }
        const parsed = canon.parseTree(contents.txt);
        assert.equal(parsed.noGraft, true);
        assert.deepEqual(parsed.errors, []);
        assert.ok(parsed.persons.filter(p => /Отец|Мать|Сын|Dateless/.test(p.rec.n)).every(p => p.rec.d === undefined));
        const roundFile = path.join(tmp, platform + '-' + kind + '-round.ged.txt');
        fs.writeFileSync(roundFile, contents.txt);
        const round = run(platform, platform + '-' + kind + '-round',
            ['!txt ' + roundFile, '/2 2', '/links', '/bell', ...(platform === 'vk' ? ['!wait 300'] : [])]);
        let roundTxt;
        if (platform === 'tg') {
            const output = round.log.match(/→ (.+Древо чата\.ged\.txt)/);
            assert.ok(output, round.log);
            roundTxt = fs.readFileSync(output[1], 'utf8').replace(/^\uFEFF/, '');
        } else {
            const upload = round.calls.find(c => c.method === 'upload' && c.body.includes('.ged.txt"'));
            assert.ok(upload, round.log);
            roundTxt = upload.body.slice(upload.body.indexOf('\r\n\r\n') + 4, upload.body.lastIndexOf('\r\n--')).replace(/^\uFEFF/, '');
        }
        assert.equal(roundTxt, contents.txt, platform + ': clean real REPL TXT roundtrip');
        console.log(platform + ': ' + kind + ', real file import, -+=, TXT/CSV, bell, dateless notes OK');
    }
}
