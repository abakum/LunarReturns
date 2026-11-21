import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync('/tmp/kilo/lr-event-repl-');
const root = new URL('../', import.meta.url);
const ged = path.join(tmp, 'clock.ged');
fs.writeFileSync(ged, '0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @I@ INDI\n1 NAME Clock\n1 BIRT\n2 DATE 2 JAN 2000\n3 TIME 0:30:59.5\n2 PLAC UTC+5\n1 DEAT\n2 DATE 1 MAR 2020\n3 TIME 23:30\n2 PLAC МСК-2\n0 TRLR\n');
for (const platform of ['tg', 'vk']) {
    const run = (name, commands, trace, retry = false) => {
        const result = spawnSync(process.execPath, [platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs',
            '--fresh', ...(platform === 'tg' ? ['--private'] : [])], {
            cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024,
            input: commands.join('\n') + '\n',
            env: { ...process.env, LR_DEV_DB: path.join(tmp, platform + '-' + name + '.json'),
                LR_DB: path.join(tmp, platform + '-' + name + '.db'), LR_VKOFF: '947', LR_VK_TRACE: trace || '' },
        });
        const log = result.stdout + result.stderr;
        fs.writeFileSync(path.join(tmp, platform + '-' + name + '.log'), log);
        assert.equal(result.status, 0, log);
        assert.doesNotMatch(retry ? log.replace(/^.*нет кнопки \[2\.2\].*$/gm, '') : log, /ERROR:|TypeError|ReferenceError/);
        return log;
    };
    const log = run('time', ['!ged ' + ged, '/2 2', '/links', '/bell', '!dump']);
    assert.match(log, /2000-01-01/);
    assert.match(log, /22/);
    assert.match(log, /UTC\+5/);
    assert.match(log, /Clock/);
    for (const [name, command] of [['romanov-ged', '!ged dev/fixtures/Romanov_family.ged'],
        ['romanov-flat', '!txt dev/fixtures/Romanov_family.ged.txt']]) {
        const checkButton = (choice, commands) => {
            const trace = path.join(tmp, `${platform}-${name}-${choice}.jsonl`);
            const log = run(`${name}-${choice}`, [command, `/2 ${choice}`, '/2 2', ...commands], trace, true);
            assert.match(log, /нет кнопки \[2\.2\]/);
            if (platform === 'vk') {
                const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
                const edits = events.filter(e => e.method === 'messages.edit');
                assert.ok(edits.length, log);
                assert.match(edits[0].params.message, choice === 1 ? /^Файл не добавлен/ : /^Идёт замена древа/);
                assert.deepEqual(JSON.parse(edits[0].params.keyboard).buttons, []);
            } else if (choice === 2) assert.match(log, /\[2\] клавиатура убрана[\s\S]*✅ древо/);
            return log;
        };
        assert.match(checkButton(1, []), /Файл не добавлен/);
        const romanov = checkButton(2, ['/links', '/bell']);
        assert.match(romanov, /персон/);
        assert.doesNotMatch(romanov, /💥/);
    }
    console.log(platform + ': nested GED time, Romanov GED/flat import, exports and bell OK');
}
console.log('REPL logs: ' + tmp);
