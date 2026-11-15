import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync('/tmp/kilo/lr-bell-date-');
const root = new URL('../', import.meta.url);
for (const platform of ['tg', 'vk']) {
    const env = { ...process.env, LR_DEV_DB: path.join(tmp, platform + '.json'),
        LR_DB: path.join(tmp, platform + '.db'), LR_VKOFF: '938' };
    const script = platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs';
    const spawn = input => spawnSync(process.execPath, [script, '--fresh', ...(platform === 'tg' ? ['--private'] : [])],
        { cwd: root, env, input, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    const setup = 'Копия 1900-01-01 1901-01-01\n/bell\n';
    const first = spawn(setup);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const copied = first.stdout.match(/^ {4}(Копия 1900_01_13 1901_01_14)$/m)?.[1];
    assert.ok(copied, first.stdout);
    const repeated = spawn(setup + copied + '\n!dump\n');
    const log = repeated.stdout + repeated.stderr;
    fs.writeFileSync(path.join(tmp, platform + '.log'), log);
    assert.equal(repeated.status, 0, log);
    assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError/);
    const records = log.split('\n').filter(line => /"name":"Копия"/.test(line)).flatMap(line => JSON.parse(line.trim()));
    assert.equal(records.length, 1, log);
    const row = records[0];
    assert.equal(row.birtD ?? row.birt_d, '1900-01-01');
    assert.equal(row.deatD ?? row.deat_d, '1901-01-01');
    console.log(platform + ': copied /bell date preserves the original record');
}
console.log('REPL logs: ' + tmp);
