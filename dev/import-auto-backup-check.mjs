import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync('/tmp/kilo/lr-import-backup-');
const flat = '-New Parent 1970-01-01\n--New Child 2000-01-01';
const ged = '0 HEAD\n0 @I1@ INDI\n1 NAME New /Parent/\n1 BIRT\n2 DATE 1 JAN 1970\n0 @I2@ INDI\n1 NAME New /Child/\n1 BIRT\n2 DATE 1 JAN 2000\n0 @F1@ FAM\n1 HUSB @I1@\n1 CHIL @I2@\n0 TRLR';
fs.writeFileSync(path.join(tmp, 'input.ged'), ged);
fs.writeFileSync(path.join(tmp, 'input.ged.txt'), flat);

for (const platform of ['tg', 'vk']) for (const ext of ['ged', 'ged.txt']) {
    const drop = '!' + (ext === 'ged' ? 'ged' : 'txt') + ' ' + path.join(tmp, 'input.' + ext);
    const run = (commands, tag, failure = '') => {
        const base = path.join(tmp, platform + '-' + ext + '-' + tag);
        const env = { ...process.env, TG_TOKEN: '', LR_DEV_DB: base + '.json', LR_DB: base + '.db',
            LR_VKOFF: '948', LR_VK_TRACE: base + '.trace', LR_BACKUP_FAIL: failure };
        const r = spawnSync(process.execPath, ['dev/' + (platform === 'tg' ? 'repl' : 'vk-repl') + '.mjs',
            '--fresh', ...(platform === 'tg' ? ['--private'] : [])],
        { env, input: commands.join('\n') + '\n', encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
        const log = r.stdout + r.stderr;
        fs.writeFileSync(base + '.log', log);
        assert.equal(r.status, 0, log);
        assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError/);
        let people;
        if (platform === 'tg') people = (JSON.parse(fs.readFileSync(env.LR_DEV_DB)).indi || []).map(p => p.name);
        else {
            const db = new DatabaseSync(env.LR_DB);
            people = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='indi'").get()
                ? db.prepare('SELECT name FROM indi').all().map(p => p.name) : [];
            db.close();
        }
        return { log, people, env };
    };
    const button = log => {
        const lines = log.split('\n').filter(l => /\[\d+\.\d+\] (?:Нет|Да)(?:  |$)/.test(l));
        assert.equal(lines.length, 1, log);
        assert.match(lines[0], /^\s*\[(\d+)\.1\] Нет  \[\1\.2\] Да$/);
        assert.doesNotMatch(log, /Да, с резервом/);
        return '/' + lines[0].match(/\[(\d+)\.1\]/)[1];
    };
    for (const scenario of ['empty', 'reject', 'success', 'fallback', 'failure', 'dateless']) {
        const seed = scenario === 'empty' ? [] : [scenario === 'dateless'
            ? '-Old Parent\\n--Old Child' : '-Old Parent 1950-01-01\\n--Old Child 1980-01-01'];
        const commands = [...seed, drop];
        const discovery = run(commands, scenario + '-prompt');
        const tap = button(discovery.log);
        const failure = scenario === 'failure' ? 'all' : scenario === 'fallback' ? 'document' : '';
        const result = run([...commands, tap + (scenario === 'reject' ? ' 1' : ' 2')], scenario, failure);
        const { log, people } = result;
        if (scenario === 'reject' || scenario === 'failure') {
            assert.deepEqual(people.sort(), ['Old Child', 'Old Parent']);
            assert.match(log, scenario === 'reject' ? /Файл не добавлен/ : /замена отменена, прежнее дерево цело/);
        } else {
            assert.deepEqual(people.sort(), ['New Child', 'New Parent']);
        }
        if (scenario === 'empty' || scenario === 'reject') {
            assert.doesNotMatch(log, /Резерв прежнего дерева|backup upload:/);
        } else if (scenario === 'success' || scenario === 'dateless') {
            let backup;
            if (platform === 'tg') {
                const file = log.match(/→ (.+-old\.ged)\n/);
                assert.ok(file, log);
                backup = fs.readFileSync(file[1], 'utf8');
            } else {
                const upload = fs.readFileSync(result.env.LR_VK_TRACE, 'utf8').trim().split('\n')
                    .map(s => JSON.parse(s)).find(e => e.method === 'upload' && e.body.includes('-old.ged"'));
                assert.ok(upload, log);
                backup = upload.body;
            }
            assert.match(backup, /Old/);
            assert.doesNotMatch(backup, /New/);
            assert.match(log, /Резерв прежнего дерева/);
        } else {
            assert.match(log, /backup upload:/);
            if (scenario === 'fallback') assert.match(log, /Резерв прежнего дерева \(текстом\)/);
            else assert.match(log, /backup text:/);
        }
        console.log(platform + ' ' + ext + ' ' + scenario + ': OK');
    }
}
console.log('Import backup logs: ' + tmp);
