import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync('/tmp/kilo/lr-branch-spouse-');
const root = new URL('../', import.meta.url);
const source = '-КА 1963-09-27\n+1988-09-24\nГК 1965-08-01\n--СА 1992-06-13 ^123\n++2016-08-27\nАК 1990-09-19\n---АА 2024-03-01 ^456\n-ГК 1963-07-14\n+1987-08-29\nГЧ 1963-05-14\n==АК 1990-09-19';
const replacement = '-СА 1992-06-13\n+2016-08-27\nАК 1990-09-19\n--АА 2024-03-01';
const line = text => text.replaceAll('\n', '\\n');
for (const platform of ['tg', 'vk']) {
    const env = { ...process.env, LR_DEV_DB: path.join(tmp, platform + '.json'),
        LR_DB: path.join(tmp, platform + '.db'), LR_VKOFF: '939' };
    const commands = [line(source), 'СА 1992-06-13', '/СА'];
    const run = () => {
        const result = spawnSync(process.execPath,
            [platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs', '--fresh', ...(platform === 'tg' ? ['--private'] : [])],
            { cwd: root, env, input: commands.join('\n') + '\n', encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
        const log = result.stdout + result.stderr;
        fs.writeFileSync(path.join(tmp, platform + '.log'), log);
        assert.equal(result.status, 0, log);
        assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError|💥/);
        return log;
    };
    let log = run();
    const anchor = log.match(/\[(\d+)\] ты:\n    СА 1992-06-13\n/);
    assert.ok(anchor, log);
    const tap = label => {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const button = [...log.matchAll(new RegExp('\\[(\\d+)\\.(\\d+)\\] ' + escaped + '(?=  |\\n|$)', 'g'))].at(-1);
        assert.ok(button, label + '\n' + log);
        commands.push('/' + button[1] + ' ' + button[2]);
        log = run();
    };
    tap('-+=');
    assert.match(log, /-СА 1992-06-13 \^123/);
    commands.push('>' + anchor[1] + ' ' + line(replacement), '/АК');
    log = run();
    assert.match(log, /ветвь срезана: 1 персон, 1 семей/);
    tap('2');
    tap('🔔');
    const edits = [...log.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)];
    const radius = edits.at(-1)[2];
    assert.match(radius, /2 АК 1990-09-19/);
    assert.match(radius, /ГК 1963-07-14 отец/);
    assert.match(radius, /ГЧ 1963-05-14 мать/);
    commands.push('>' + anchor[1] + ' -СА 1992-06-13', '/АК');
    log = run();
    tap('2');
    const finalRadius = [...log.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)].at(-1)[2];
    assert.match(finalRadius, /ГК 1963-07-14 отец/);
    assert.match(finalRadius, /ГЧ 1963-05-14 мать/);
    assert.doesNotMatch(finalRadius, /СА 1992-06-13|АА 2024-03-01/);
    fs.renameSync(path.join(tmp, platform + '.log'), path.join(tmp, platform + '-branch.log'));
    console.log(platform + ': reply graft, branch button, radius, bell, omitted spouse OK');
    commands.splice(0, commands.length,
        '!txt dev/fixtures/Romanov_family.ged.txt', '/2 2', '/Алексей', '/links', '/bell');
    log = run();
    assert.match(log, /древо: персон 57, семей 13, детей 43/);
    assert.match(log, /Романов/);
    assert.match(log, /Алексей/);
    fs.renameSync(path.join(tmp, platform + '.log'), path.join(tmp, platform + '-romanov.log'));
    console.log(platform + ': full Romanov import, focus, flat output, bell OK');
}
console.log('REPL logs: ' + tmp);
