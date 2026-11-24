#!/usr/bin/env node
// End-to-end command/button parity. No cloud access or persistent REPL databases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import vm from 'node:vm';
import { resolveReplyRecord, replyHeader } from '../tgcloud/lib/text.cjs';
import { graftError } from '../tgcloud/lib/flat.cjs';
import { parseTree } from '../tgcloud/lib/parse.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync('/tmp/kilo/lr-command-button-');
const marker = '#not for cut and graft';
let sequence = 0;

function ged(children) {
    const persons = [
        '0 @I1@ INDI\n1 NAME Hero\n1 SEX M\n1 BIRT\n2 DATE 1 JAN 1950',
        ...children.map((c, i) => `0 @I${i + 2}@ INDI\n1 NAME ${c.name}\n1 SEX M\n1 BIRT\n2 DATE ${c.date || '1 MAR 1980'}${c.death ? '\n1 DEAT\n2 DATE ABT 1 JAN 2020' : ''}`),
    ];
    return ['0 HEAD', '1 CHAR UTF-8', ...persons, '0 @F1@ FAM', '1 HUSB @I1@',
        ...children.map((_, i) => `1 CHIL @I${i + 2}@`), '0 TRLR'].join('\n').replaceAll('\n', '\\n');
}

function messages(log) {
    return [...log.matchAll(/\[(\d+)\] (sendMessage:[^\n]*|текст →)\n((?:    [^\n]*\n)*)/g)]
        .map(m => ({ id: m[1], text: m[3].split('\n').filter(l => l.startsWith('    '))
            .map(l => l.slice(4)).filter(l => !/^\[\d+\.\d+\] /.test(l)
                && l !== 'клавиатура →' && !l.startsWith('↳ ')
                // VK REPL renders attachment metadata as a synthetic text line.
                && !l.startsWith('📎 вложение ')).join('\n') }));
}

function button(log, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hit = [...log.matchAll(new RegExp('\\[(\\d+)\\.(\\d+)\\] ' + escaped + '(?=  |\\n|$)', 'g'))].at(-1);
    assert.ok(hit, `Missing button ${label}\n${log}`);
    return '/' + hit[1] + ' ' + hit[2];
}

function anchor(log) {
    const hit = log.match(/\[(\d+)\] ты:\n    Hero 1950-01-01\n/);
    assert.ok(hit, log);
    return hit[1];
}

function run(platform, name, commands, date) {
    const base = path.join(tmp, `${platform}-${++sequence}-${name}`);
    const trace = base + '.jsonl';
    const env = { ...process.env, TMPDIR: tmp, LR_DEV_DB: base + '.json', LR_DB: base + '.db',
        LR_VK_TRACE: trace, LR_VKOFF: String(11000 + process.pid % 20000 + sequence) };
    const input = [...commands, ...(platform === 'vk' ? ['!wait 2500'] : [])].join('\n') + '\n';
    // VK's !date does not reach the shared religious calendar. Pin both REPL clocks.
    const clock = date ? ['--import', 'data:text/javascript,' + encodeURIComponent(
        `const realNow = Date.now; const offset = Date.parse('${date}T06:00:00Z') - realNow(); Date.now = () => realNow() + offset;`)] : [];
    const result = spawnSync(process.execPath,
        [...clock, platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs', '--fresh', ...(platform === 'tg' ? ['--private'] : [])],
        { cwd: root, env, input, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
    const log = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(base + '.log', log);
    assert.ifError(result.error);
    assert.equal(result.status, 0, base + '.log\n' + log);
    assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError|ECONNREFUSED|EADDRINUSE|keyboard contains incorrect JSON/, base + '.log');
    const files = [];
    if (platform === 'tg') {
        for (const m of log.matchAll(/^    → (.+)$/gm)) {
            const filename = m[1].trim();
            files.push({ name: path.basename(filename), bytes: fs.readFileSync(filename) });
        }
    } else {
        for (const line of fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean)) {
            const entry = JSON.parse(line);
            if (entry.method !== 'upload') continue;
            const bytes = Buffer.from(entry.base64, 'base64');
            const headerEnd = bytes.indexOf('\r\n\r\n');
            const filename = bytes.subarray(0, headerEnd).toString().match(/filename="([^"]+)"/);
            assert.ok(filename, 'Missing multipart filename: ' + trace);
            const boundary = bytes.subarray(0, bytes.indexOf('\r\n'));
            const end = bytes.lastIndexOf(Buffer.concat([Buffer.from('\r\n'), boundary]));
            assert.ok(end > headerEnd, 'Malformed multipart upload: ' + trace);
            files.push({ name: filename[1], bytes: bytes.subarray(headerEnd + 4, end) });
        }
    }
    for (const [i, file] of files.entries()) fs.writeFileSync(base + '-export-' + i + '-' + file.name.replace(/[/\\]/g, '_'), file.bytes);
    let tree, sent;
    if (platform === 'tg') {
        const data = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
        tree = Object.fromEntries(['indi', 'fam', 'chil', 'edges'].map(t => [t, data[t] || []]));
    } else {
        const db = new DatabaseSync(base + '.db');
        tree = Object.fromEntries(['indi', 'fam', 'chil', 'links'].map(t => [t, db.prepare('SELECT * FROM ' + t).all()]));
        if (date) sent = db.prepare('SELECT key FROM sent ORDER BY key').all().map(r => r.key);
        db.close();
    }
    return { log, files, output: messages(log), tree, sent };
}

function exported(result, suffix) {
    const file = result.files.filter(f => f.name.endsWith(suffix)).at(-1);
    assert.ok(file, 'Missing export ' + suffix + '\n' + result.log);
    return file.bytes.toString('utf8').replace(/\r\n/g, '\n');
}

function last(result) {
    assert.ok(result.output.length, result.log);
    return result.output.at(-1).text;
}

try {
    const records = [{ n: 'Hero', d: '1950-01-01', xref: 'I1' }];
    const vkSource = fs.readFileSync(path.join(root, 'lunarreturns.js'), 'utf8');
    const vkResolve = vm.runInNewContext('(' + vkSource.match(/^function resolveReply\([\s\S]*?^\}/m)[0] + ')', {
        groupId: 99, resolveReplyRecord, personRows: () => records, weddingRows: () => [],
    });
    for (const from_id of [undefined, 0, -98])
        assert.equal(vkResolve(1, { from_id, peer_id: 1, text: '1 Hero 1950-01-01' }), null);
    assert.equal(vkResolve(1, { from_id: -99, peer_id: 2, text: '1 Hero 1950-01-01' }), null);
    assert.equal(vkResolve(1, { from_id: -99, peer_id: 1, text: '1 Hero 1950-01-01' }), records[0]);
    let contexts = [], identity = records[0], getMeFails = false;
    const tgSource = fs.readFileSync(path.join(root, 'tgcloud/handlers/message.js'), 'utf8');
    const tgResolve = vm.runInNewContext('(' + tgSource.match(/^async function resolveReply\([\s\S]*?^\}/m)[0] + ')', {
        api: { getMe: async () => { if (getMeFails) throw Error('offline'); return { id: 999 }; } },
        db: { select: () => ({ from: () => ({ where: () => ({ all: async () => contexts }) }) }) },
        focusView: { chatId: 'chatId' }, eq: () => null, resolveReplyRecord,
        personRows: async () => records, weddingRows: async () => [], recordByXref: async () => identity,
    });
    const panel = { chat: { id: 1 }, from: { id: 999, is_bot: true }, message_id: 8, text: '1 Hero 1950-01-01' };
    for (const from of [undefined, { id: 0 }, { id: 998, is_bot: true }])
        assert.equal(await tgResolve(1, { ...panel, from }), null);
    assert.equal(await tgResolve(2, panel), null);
    assert.equal(await tgResolve(1, { ...panel, sender_chat: { id: 1 } }), null);
    assert.equal(await tgResolve(1, panel), records[0]);
    contexts = [{ messageId: 8, pkey: 'Other 1950-01-01', ts: Date.now() }];
    assert.equal(await tgResolve(1, panel), null);
    contexts = [];
    identity = null;
    assert.equal(await tgResolve(1, { ...panel, reply_markup: { inline_keyboard: [[{ callback_data: 'det:I1' }]] } }), null);
    getMeFails = true;
    assert.equal(await tgResolve(1, panel), null);
    assert.equal(resolveReplyRecord(records, 'Hero 1950-01-01'), records[0]);
    assert.equal(resolveReplyRecord(records, '1 Hero 1950-01-01', true), records[0]);
    assert.equal(resolveReplyRecord(records, 'Hero 1950-01-01 76\n♑#знак\n#1950г тест', true), records[0]);
    for (const text of ['Древо чата\nHero 1950-01-01', '#not for cut and graft\n-Hero 1950-01-01', '', 'Hero'])
        assert.equal(replyHeader(text, true), null);
    assert.equal(resolveReplyRecord([...records, { ...records[0], xref: 'I2' }], '1 Hero 1950-01-01', true), null);
    for (const context of [{ pkey: 'Other 1950-01-01', ts: Date.now() }, { pkey: 'Hero 1950-01-01', ts: 0 }])
        assert.equal(resolveReplyRecord(records, '1 Hero 1950-01-01', true, context), null);
    for (const text of ['-Hero 1950-01-01\n-Other 1960-01-01', '-Parent 1920-01-01\n--Hero 1950-01-01', marker + '\n-Hero 1950-01-01'])
        assert.ok(graftError(parseTree(text), 'Hero 1950-01-01'));
    assert.equal(graftError(parseTree('-Renamed 1951-01-01'), 'Hero 1950-01-01'), null);
    for (const platform of ['tg', 'vk']) {
        const small = ged([{ name: 'ExactSecondary', death: true },
            { name: 'ApproxPrimary', date: 'ABT 1 APR 1981' }, { name: 'ExactChild' }]);
        const setup = [small, 'Hero 1950-01-01', '/Hero'];
        const probe = run(platform, 'small-setup', setup);
        const reply = '>' + anchor(probe.log) + ' ';
        const targets = [
            { name: 'stale', setup: [...setup, reply + 'RenamedHero 1950-01-01'], id: anchor(probe.log) },
        ];
        const plainSetup = [...setup, 'Посторонний текст'];
        const plainProbe = run(platform, 'reply-plain-setup', plainSetup);
        const plainId = plainProbe.log.match(/\[(\d+)\] ты:\n    Посторонний текст/)[1];
        targets.push({ name: 'plain', setup: plainSetup, id: plainId });
        for (const target of targets) {
            const commands = ['/', '/bell2', '/gedcom2', '/links', 'связи', ...(platform === 'tg' ? ['/start'] : [])];
            const invalid = run(platform, 'reply-' + target.name, [...target.setup,
                ...commands.map(command => '>' + target.id + ' ' + command)]);
            const errors = invalid.output.filter(m => m.text.startsWith('Не удалось найти цитируемую запись'));
            assert.equal(errors.length, commands.length, platform + ': invalid reply must report errors');
            assert.equal(invalid.files.length, 0, platform + ': invalid reply must not export chat');
            const baseline = run(platform, 'baseline-' + target.name, target.setup);
            assert.deepEqual(invalid.tree, baseline.tree, platform + ': invalid commands preserve tree');
        }
        const botReply = '>' + button(probe.log, '🔔').match(/^\/(\d+)/)[1] + ' ';
        for (const command of ['/', '/bell2', '/gedcom2', '/links', 'связи', ...(platform === 'tg' ? ['/start'] : [])]) {
            const userResult = run(platform, 'user-reply-' + command.replace(/\W/g, ''), [...setup, reply + command]);
            const botResult = run(platform, 'bot-reply-' + command.replace(/\W/g, ''), [...setup, botReply + command]);
            assert.equal(last(botResult), last(userResult), platform + ': bot/user anchor ' + command);
            assert.deepEqual(botResult.files, userResult.files);
        }
        const exportProbe = run(platform, 'short-export', [...setup, reply + '/links']);
        const exportId = exportProbe.output.at(-1).id;
        const exportReply = '>' + exportId + ' ';
        const rejected = run(platform, 'safe-rejections', [...setup, reply + '/links',
            exportReply + '-Hero 1950-01-01\\n-Other 1960-01-01',
            exportReply + '-Parent 1920-01-01\\n--Hero 1950-01-01',
            exportReply + marker + '\\n-Hero 1950-01-01',
            exportReply + '-Hero 1950-01-01\\n' + marker,
            exportReply + '-ExactChild 1980-03-01',
            exportReply + '-Hero 1950-01-01\\n--YoungChild 1955-01-01',
            'Посторонний текст']);
        assert.deepEqual(rejected.tree, probe.tree, platform + ': graft validation must precede mutation');
        const trimmedSetup = [...setup, 'H 1950-01-01'];
        const trimmedBase = run(platform, 'trim-collision-base', trimmedSetup);
        // Text input intentionally ignores trim; file imports must preflight post-trim keys.
        const trimPath = path.join(tmp, platform + '-trim-collision.ged.txt');
        fs.writeFileSync(trimPath, '-Hero 1950-01-01');
        const trimFile = run(platform, 'trim-file-collision', [...trimmedSetup, '/trim1',
            `!txt ${trimPath} >${anchor(probe.log)}`]);
        assert.deepEqual(trimFile.tree, trimmedBase.tree, platform + ': trimmed root collision before cut');
        const renamed = run(platform, 'rename-root', [...setup, reply + '/links', exportReply + '-RenamedHero 1951-01-01']);
        assert.match(renamed.log, /ветвь срезана/);
        const invalidEdit = run(platform, 'invalid-edit', [...plainSetup, '>' + plainId + ' NewPerson 1980-01-01']);
        assert.deepEqual(invalidEdit.tree, probe.tree, platform + ': invalid edit must not create duplicate');
        const edited = run(platform, 'bot-edit', [...setup, botReply + 'RenamedHero 1951-01-01']);
        const beforeHero = probe.tree.indi.find(r => (r.name || r.n) === 'Hero');
        const afterHero = edited.tree.indi.find(r => (r.name || r.n) === 'RenamedHero');
        assert.equal(afterHero.xref, beforeHero.xref, platform + ': edit preserves identity');
        const commandBell = run(platform, 'bell-command', [...setup, reply + '/bell5']);
        const buttonBell = run(platform, 'bell-button', [...setup, button(probe.log, '🔔')]);
        assert.equal(last(commandBell), last(buttonBell), platform + ': reply /bell5 vs focus bell');
        assert.match(last(commandBell), /^1 Hero 1950-01-01\n/);
        assert.match(last(commandBell), /ExactSecondary 1980-03-01/);
        assert.match(last(commandBell), /ExactChild 1980-03-01/);
        assert.doesNotMatch(last(commandBell), /ApproxPrimary/);
        const commandGed = run(platform, 'ged-command', [...setup, reply + '/gedcom5']);
        const buttonGed = run(platform, 'ged-button', [...setup, '/gedcom1', button(probe.log, '🧬')]);
        const commandData = exported(commandGed, '.ged');
        assert.equal(commandData, exported(buttonGed, '.ged'), platform + ': clipped command/button GED');
        assert.match(commandData, /1 NAME ExactSecondary/);
        assert.match(commandData, /1 NAME ApproxPrimary/);
        assert.deepEqual(commandGed.files.map(f => path.extname(f.name)), ['.ged']);
        assert.match(commandGed.files[0].name, /^1 Hero 1950-01-01.*\.ged$/);

        const children = Array.from({ length: 110 }, (_, i) => ({
            name: 'Descendant' + String(i).padStart(3, '0') + ' Long Given Name For Overflow',
        }));
        const largeSetup = [ged(children), 'Hero 1950-01-01', '/Hero'];
        const largeProbe = run(platform, 'large-setup', largeSetup);
        const largeReply = '>' + anchor(largeProbe.log) + ' ';
        const longBell = run(platform, 'long-bell-command', [...largeSetup, largeReply + '/bell5']);
        const longButton = run(platform, 'long-bell-button', [...largeSetup, button(largeProbe.log, '🔔')]);
        assert.equal(last(longBell), last(longButton), platform + ': long bell parity');
        assert.ok(last(longBell).length <= 4000, platform + ': bell exceeds transport budget');
        assert.match(last(longBell), /Descendant/);
        assert.doesNotMatch(last(longBell), /Descendant109/);
        const links = run(platform, 'links-command', [...largeSetup, largeReply + '/links']);
        const flat = run(platform, 'flat-button', [...largeSetup, button(largeProbe.log, '-+=')]);
        const pack = exported(links, '.ged.txt');
        assert.equal(pack, exported(flat, '.ged.txt'), platform + ': long branch command/button file');
        assert.ok(!pack.includes(marker), platform + ': complete branch must permit graft');
        for (const child of children) assert.ok(pack.includes(child.name), 'Lost descendant: ' + child.name);
        assert.match(last(links), /✂/);
        assert.match(last(flat), /✂/);
        for (const result of [links, flat]) {
            for (const message of result.output.filter(m => m.text.includes('✂'))) {
                assert.ok(message.text.length <= 4000, platform + ': branch preview exceeds transport budget');
            }
        }
        const packPath = path.join(tmp, platform + '-branch.ged.txt');
        fs.writeFileSync(packPath, pack);
        const graft = run(platform, 'graft-export', [...largeSetup,
            `!txt ${packPath} >${anchor(largeProbe.log)}`, largeReply + '/links']);
        assert.match(graft.log, /ветвь срезана/);
        assert.equal(exported(graft, '.ged.txt'), pack, platform + ': graft preserves full exported branch');
        const longId = links.output.at(-1).id;
        const botGraft = run(platform, 'graft-bot-export', [...largeSetup, largeReply + '/links',
            ...(platform === 'vk' ? ['!wait 2500'] : []), `!txt ${packPath} >${longId}`, largeReply + '/links']);
        assert.match(botGraft.log, /ветвь срезана/);
        assert.equal(exported(botGraft, '.ged.txt'), pack);

        const romanovSetup = ['!txt dev/fixtures/Romanov_family.ged.txt', '/2 2', '/Фёдор III'];
        const romanov = run(platform, 'romanov-focus', romanovSetup);
        assert.match(romanov.log, /древо: персон 57, семей 13, детей 43/);
        const heroId = button(romanov.log, '🔔').match(/^\/(\d+)/)[1];
        const branch = run(platform, 'romanov-export', [...romanovSetup, '>' + heroId + ' /links']);
        const branchMessage = branch.output.at(-1);
        assert.match(branchMessage.text, /^1 Фёдор III/);
        const branchText = branchMessage.text.split('\n').slice(1).join('\n');
        const romanovPath = path.join(tmp, platform + '-romanov-branch.ged.txt');
        fs.writeFileSync(romanovPath, branchText);
        const romanovGraft = run(platform, 'romanov-graft', [...romanovSetup, '>' + heroId + ' /links',
            `!txt ${romanovPath} >${branchMessage.id}`, '>' + heroId + ' /links', '>' + heroId + ' /bell5']);
        assert.match(romanovGraft.log, /ветвь срезана/);
        assert.ok(romanovGraft.output.some(m => m.text === branchMessage.text), platform + ': Romanov branch round trip');
        const today = '2026-01-07'; // Orthodox Christmas in Moscow.
        const date = '7 JAN 2000';
        const dailyGed = ged([{ name: 'DailySecondary', date, death: true },
            { name: 'DailyPrimary', date: 'ABT ' + date }]).replace('ABT 1 JAN 2020', 'EST 1 JAN 2020')
            .replace('0 TRLR', [
                '0 @I20@ INDI', '1 NAME DailyHusband', '1 SEX M', '1 BIRT', '2 DATE 1 FEB 1940',
                '0 @I21@ INDI', '1 NAME DailyWife', '1 SEX F', '1 BIRT', '2 DATE 1 FEB 1941',
                '0 @F20@ FAM', '1 HUSB @I20@', '1 WIFE @I21@', '1 MARR', '2 DATE ' + date,
                '1 DIV', '2 DATE EST 1 JAN 2020', '0 TRLR',
            ].join('\\n'));
        const dailyCommands = platform === 'tg' ? ['/today'] : ['!date ' + today + ' 9', '!daily'];
        const menu = platform === 'tg' ? '/start' : '/';
        const orthProbe = run(platform, 'daily-orth-menu', [dailyGed, menu], today);
        const orth = button(orthProbe.log, '☦️🔕');
        const digest = 'Православные: Рождество Христово';
        for (const [name, switches, anniversaries, religious] of [
            ['default', [], true, false],
            ['muted', ['/bell0'], false, false],
            ['orth-only', [orth, orth, '/bell0'], false, true],
            ['restored', [orth, orth, '/bell0', '/bell1'], true, true],
        ]) {
            const daily = run(platform, 'daily-' + name, [dailyGed, menu, ...switches, ...dailyCommands], today);
            const boundary = daily.log.lastIndexOf(platform === 'tg' ? '    /today\n' : '«сегодня» = ' + today);
            assert.ok(boundary >= 0, daily.log);
            const notifications = /Daily(?:Secondary|Primary|Husband\+DailyWife)|^Православные:/m;
            assert.ok(messages(daily.log.slice(0, boundary)).every(m => !notifications.test(m.text)), daily.log);
            const dailyOutput = messages(daily.log.slice(boundary));
            const text = dailyOutput.map(m => m.text).join('\n');
            if (anniversaries) {
                for (const label of [/DailySecondary 2000-01-07 2020-01-01~/g, /DailyHusband\+DailyWife 2000-01-07 2020-01-01~/g]) {
                    assert.equal([...text.matchAll(label)].length, 1, daily.log);
                }
            } else assert.doesNotMatch(text, /DailySecondary|DailyHusband\+DailyWife/, daily.log);
            assert.doesNotMatch(text, /DailyPrimary/, daily.log);
            assert.equal(text.split('\n').includes(digest), religious, daily.log);
            if (!anniversaries && !religious) assert.deepEqual(dailyOutput, [], daily.log);
            if (platform === 'vk') assert.deepEqual(daily.sent, anniversaries
                ? ['DailyHusband+DailyWife 2000-01-07', 'DailySecondary 2000-01-07'] : [], daily.log);
        }
        console.log(platform + ': command/button parity, full branches, graft, daily bell switches and independent Orthodox digest OK');
    }
} finally {
    console.log('Command/button REPL logs and exports: ' + tmp);
}
