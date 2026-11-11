import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync('/tmp/kilo/lr-fynny-');
const ged = path.join(tmp, 'ancestors.ged');
fs.writeFileSync(ged, ['0 HEAD', '1 CHAR UTF-8',
    '0 @I1@ INDI', '1 NAME Hero', '1 SEX M', '1 BIRT', '2 DATE 1 JAN 2000',
    '0 @I2@ INDI', '1 NAME Father', '1 SEX M', '1 BIRT', '2 DATE 1 JAN 1975',
    '0 @I3@ INDI', '1 NAME Grandfather', '1 SEX M', '1 BIRT', '2 DATE 1 JAN 1950',
    '0 @F1@ FAM', '1 HUSB @I2@', '1 CHIL @I1@',
    '0 @F2@ FAM', '1 HUSB @I3@', '1 CHIL @I2@', '0 TRLR'].join('\n'));
for (const platform of ['tg', 'vk']) {
    const env = { ...process.env, LR_DEV_DB: path.join(tmp, platform + '.json'),
        LR_DB: path.join(tmp, platform + '.db'), LR_VKOFF: '952' };
    const run = (commands, tag, fresh = false, chat = 1) => {
        const trace = path.join(tmp, platform + '-' + tag + '.jsonl');
        const result = spawnSync(process.execPath, [platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs',
            ...(fresh ? ['--fresh'] : []), '--chat', String(chat), ...(platform === 'tg' ? ['--private'] : [])], {
            env: { ...env, LR_VK_TRACE: trace }, input: commands.join('\n') + '\n',
            encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
        });
        const log = result.stdout + result.stderr;
        fs.writeFileSync(path.join(tmp, platform + '-' + tag + '.log'), log);
        assert.equal(result.status, 0, log);
        assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError/);
        return { log, trace };
    };
    run(['!ged ' + ged, '/2 2', '/fynny1', '/fynny1'], 'import', true);
    for (const [mode, set] of [[1, false], [0, true], [1, true]]) {
        if (set) {
            const reply = run(['/fynny' + mode], 'set-' + mode).log;
            assert.ok(reply.includes(mode ? 'Родство: цепочки.' : 'Родство: обычные названия.'), reply);
            assert.doesNotMatch(reply, /Радиус всегда/);
        }
        const rendered = run(['Hero 2000-01-01', '>1 /bell2', '>1 /gedcom2', '!wait 300'],
            'render-' + mode + '-' + set);
        const label = mode ? 'отец отца' : 'дедушка';
        assert.ok(rendered.log.includes('Grandfather 1950-01-01 ' + label), rendered.log);
        let file;
        if (platform === 'tg') file = rendered.log.match(/→ (.+\.pdf)/)?.[1];
        else {
            const calls = fs.readFileSync(rendered.trace, 'utf8').trim().split('\n').map(JSON.parse);
            const upload = calls.find(c => c.method === 'upload' && c.body.includes('.pdf"'));
            assert.ok(upload, rendered.log);
            const bytes = Buffer.from(upload.base64, 'base64');
            file = path.join(tmp, platform + '-mode-' + mode + '.pdf');
            fs.writeFileSync(file, bytes.subarray(bytes.indexOf('\r\n\r\n') + 4, bytes.lastIndexOf('\r\n--')));
        }
        assert.ok(file, rendered.log);
        const text = spawnSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
        assert.equal(text.status, 0, text.stderr);
        assert.ok(text.stdout.includes(label), text.stdout);
        console.log(platform + ': persisted mode ' + mode + ', list/PDF OK');
    }
    const other = run(['/fynny0', '/fynny1@test_bot', '/fynny0'], 'other-chat', false, 2);
    assert.match(other.log, /Родство: обычные названия\./);
    assert.match(other.log, /Родство: цепочки\./);
    assert.doesNotMatch(other.log, /Радиус всегда/);
    const unchanged = run(['Hero 2000-01-01', '>1 /bell2'], 'isolation');
    assert.ok(unchanged.log.includes('Grandfather 1950-01-01 отец отца'), unchanged.log);
}
console.log('Fynny commands, persistence and chat isolation OK; artifacts: ' + tmp);
