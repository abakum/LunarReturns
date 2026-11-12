import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTree, parseGedcom, trimImport } from '../tgcloud/lib/parse.cjs';
import { helpText } from '../tgcloud/lib/text.cjs';

for (const fynny of [0, 1]) for (const trim of [0, 1]) {
    const help = helpText({ fynny, trim });
    assert.ok(help.includes('(fynny=' + fynny + ')'));
    assert.ok(help.includes('(trim=' + trim + ')'));
}

const tmp = fs.mkdtempSync('/tmp/kilo/lr-trim-');
const flat = '-Foo Bar 1960-01-01 (Birthtown) 2020-01-01 (Deathtown) ^personnote\n+1980-01-01 (Wedtown) 2000-01-01 (Divtown) ^familynote\nJane Doe 1962-01-01\n--Little Kid 1985-01-01 ^kidnote';
const ged = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Foo /Bar/
1 SEX M
1 NOTE personnote
1 BIRT
2 DATE 1 JAN 1960
2 PLAC Birthtown
1 DEAT
2 DATE 1 JAN 2020
2 PLAC Deathtown
0 @I2@ INDI
1 NAME Jane /Doe/
1 SEX F
1 BIRT
2 DATE 1 JAN 1962
0 @I3@ INDI
1 NAME Little /Kid/
1 BIRT
2 DATE 1 JAN 1985
1 NOTE kidnote
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 NOTE familynote
1 MARR
2 DATE 1 JAN 1980
2 PLAC Wedtown
1 DIV
2 DATE 1 JAN 2000
2 PLAC Divtown
0 TRLR`;
fs.writeFileSync(path.join(tmp, 'input.ged'), ged);
fs.writeFileSync(path.join(tmp, 'input.ged.txt'), flat);
const tree = parseTree(flat), before = structuredClone(tree);
trimImport(tree);
assert.deepEqual(tree.persons.map(p => p.rec.n), ['FB', 'JD', 'LK']);
assert.deepEqual(tree.children, before.children);
assert.equal(tree.persons[0].rec.d, before.persons[0].rec.d);
assert.equal(tree.weddings[0].rec.dd, before.weddings[0].rec.dd);
assert.doesNotMatch(JSON.stringify(tree), /town|note"/);
const collision = trimImport(parseTree('-Foo Bar 1960\n-Fred Brown 1960\n-Foo Bar 1960'));
assert.deepEqual(collision.persons.map(p => p.rec.n), ['FB', 'FB ~trim2', 'FB']);
const parsedGed = trimImport(parseGedcom(ged));
assert.deepEqual(parsedGed.indis.map(p => p.name), ['FB', 'JD', 'LK']);
assert.doesNotMatch(JSON.stringify(parsedGed), /town|note"/);
assert.deepEqual(parsedGed.fams[0].chil, ['I3']);

for (const platform of ['tg', 'vk']) {
    const env = { ...process.env, LR_DEV_DB: path.join(tmp, platform + '.json'),
        LR_DB: path.join(tmp, platform + '.db'), LR_VKOFF: '941', LR_VK_TRACE: path.join(tmp, 'vk-trace.jsonl') };
    const commands = [];
    const run = () => {
        fs.writeFileSync(env.LR_VK_TRACE, '');
        const r = spawnSync(process.execPath, [platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs',
            '--fresh', ...(platform === 'tg' ? ['--private'] : [])],
        { env, input: [...commands, ...(platform === 'vk' ? ['!wait 1500'] : [])].join('\n') + '\n', encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
        const log = r.stdout + r.stderr;
        fs.writeFileSync(path.join(tmp, platform + '.log'), log);
        assert.equal(r.status, 0, log);
        assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError|💥/);
        return log;
    };
    const exported = log => {
        if (platform === 'vk') {
            const upload = fs.readFileSync(env.LR_VK_TRACE, 'utf8').trim().split('\n').map(s => JSON.parse(s))
                .filter(e => e.method === 'upload' && Buffer.from(e.base64, 'base64').toString('utf8').includes('.ged.txt"')).at(-1);
            assert.ok(upload, log);
            return Buffer.from(upload.base64, 'base64').toString('utf8');
        }
        const file = [...log.matchAll(/→ (.+\.ged\.txt)\n/g)].at(-1);
        assert.ok(file, log);
        return fs.readFileSync(file[1], 'utf8');
    };
    for (const ext of ['ged', 'ged.txt']) {
        commands.length = 0;
        commands.push('/trim1@TestBot', '!'+ (ext === 'ged' ? 'ged' : 'txt') + ' ' + path.join(tmp, 'input.' + ext));
        let log = run();
        const button = [...log.matchAll(/\[(\d+)\.(\d+)\] Да(?=  |\n|$)/g)].at(-1);
        assert.ok(button, log);
        commands.push('/' + button[1] + ' ' + button[2], '/links');
        log = run();
        const output = exported(log);
        assert.match(output, /-FB 1960-01-01/);
        assert.match(output, /JD 1962-01-01/);
        assert.match(output, /LK 1985-01-01/);
        assert.doesNotMatch(output, /Foo|Jane|Little|town|personnote|familynote|kidnote/);
        // Disabling restores full imports.
        commands[0] = '/trim0';
        log = run();
        const full = exported(log);
        assert.match(full, /Foo Bar/);
        assert.match(full, /Birthtown/);
        assert.match(full, /personnote/);
        commands[0] = '/trim1';
        commands[2] = '/' + button[1] + ' 1'; // Reject must never replace the tree.
        log = run();
        assert.match(log, /Файл не добавлен/);
        assert.match(log, /Событий нет|связей пока нет/);
    }
    commands.splice(0, commands.length, flat.replaceAll('\n', '\\n'), 'Foo Bar 1960-01-01', '/trim1');
    let log = run();
    const anchor = log.match(/\[(\d+)\] ты:\n    Foo Bar 1960-01-01\n/);
    assert.ok(anchor, log);
    commands.push('!txt ' + path.join(tmp, 'input.ged.txt') + ' >' + anchor[1], '/links');
    log = run();
    const reply = exported(log);
    assert.match(reply, /-FB 1960-01-01/);
    assert.doesNotMatch(reply, /Foo Bar|town|personnote|familynote|kidnote/);
    console.log(platform + ': trim commands, GED/TXT accept/reject, full import, reply graft OK');
}
console.log('Trim logs: ' + tmp);
