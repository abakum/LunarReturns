import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-a3-repl-'));
const root = new URL('../', import.meta.url);
const romanov = fs.readFileSync(new URL('../Romanov_family.ged.txt', import.meta.url), 'utf8').trim().replaceAll('\n', '\\n');
const kids = '-Родитель 1950-01-01\\n+1970-02-28\\nСупруга 1952-01-01\\n--Старший 1972-02-29\\n--Младший\\n==Младшая';
const huge = Array.from({ length: 180 }, (_, i) => '-Тестовый' + String(i).padStart(3, '0') + ' Длинное Имя Для Переполнения 2000-01-01').join('\\n');
for (const platform of ['tg', 'vk']) {
    const env = { ...process.env, LR_DEV_DB: path.join(tmp, platform + '.json'), LR_DB: path.join(tmp, platform + '.db'), LR_VKOFF: '937' };
    const commands = [romanov, '/Алексей', '/bell', '/links', kids, '/Млад', huge, '/Тестовый', '/bell'];
    const script = platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs';
    const result = spawnSync(process.execPath, [script, '--fresh', ...(platform === 'tg' ? ['--private'] : [])], {
        cwd: root, env, input: commands.join('\n') + '\n', encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    });
    const log = result.stdout + result.stderr;
    fs.writeFileSync(path.join(tmp, platform + '.log'), log);
    assert.equal(result.status, 0, log);
    assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError/);
    assert.match(log, /Романов/);
    assert.match(log, /Младш/);
    assert.match(log, /✂️/);
    const focus = spawnSync(process.execPath, [script, '--fresh', ...(platform === 'tg' ? ['--private'] : [])], {
        cwd: root, env,
        input: [kids, '/Старший', '/4 3', '/4 5', '/4 3'].join('\n') + '\n',
        encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    });
    const focusLog = focus.stdout + focus.stderr;
    fs.writeFileSync(path.join(tmp, platform + '-focus.log'), focusLog);
    assert.equal(focus.status, 0, focusLog);
    assert.doesNotMatch(focusLog, /ERROR:|TypeError|ReferenceError/);
    assert.match(focusLog, /Родитель 1950-01-01 отец/);
    assert.match(focusLog, /-Старший 1972-02-29/);
    console.log('A3 ' + platform + ' REPL: Romanov, dateless batch, search, bell, links, overflow OK');
}
console.log('REPL logs: ' + tmp);
