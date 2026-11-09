import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chatFlatArtifacts, NOT_FOR_GRAFT, packToCsv } from '../tgcloud/lib/parse.cjs';
import { fileBaseOf } from '../tgcloud/lib/chart.cjs';

const require = createRequire(import.meta.url);
const canon = require('../tgcloud/lib/parse.cjs');
const tmp = fs.mkdtempSync('/tmp/opencode/lr-flat-');
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
console.log('Logs: ' + tmp);
