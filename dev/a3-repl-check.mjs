import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import handleVkEvent from '../vk/handlers/message_event.js';
import { createUpdateRouter } from '../vk/updates.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-a3-repl-'));
const root = new URL('../', import.meta.url);
const romanov = fs.readFileSync(new URL('./fixtures/Romanov_family.ged.txt', import.meta.url), 'utf8').trim().replaceAll('\n', '\\n');
const kids = '-Родитель 1950-01-01\\n+1970-02-28\\nСупруга 1952-01-01\\n--Старший 1972-02-29\\n--Младший\\n==Младшая';
const huge = Array.from({ length: 180 }, (_, i) => '-Тестовый' + String(i).padStart(3, '0') + ' Длинное Имя Для Переполнения 2000-01-01').join('\\n');
// REPL проверяет видимые правки; дополнительно фиксируем await до построения списка.
const tgCallback = fs.readFileSync(new URL('../tgcloud/handlers/callback_query.js', import.meta.url), 'utf8');
assert.match(tgCallback, /await api\.editMessageText\([\s\S]*?text: head \+ "\\n" \+ loading[\s\S]*?\)\.catch\([^\n]*\);\s*let text;\s*try \{\s*const sex = await sexOf\(\);\s*const s = await getSettings\(chatId\);\s*const keys = focusListKeys/);
{
    const order = [];
    await handleVkEvent({ payload: { c: 'foc:bell', r: 1 }, conversation_message_id: 42 }, {
        peerId: 1,
        deps: {
            unpay: p => p, activeDnaExports: new Map(), cancelDnaExport() {},
            findRecordByCmid: async () => ({ n: 'Person', d: '2000-01-01' }), pkey: r => r.n + ' ' + r.d,
            linkPairs: () => [], focusSpousePairs: () => [], focusLabel: String,
            focusHead: () => 'Person', answerEvent: async () => {}, focusKeyboard: async () => 'keyboard',
            vkApi: async (_, params) => { await Promise.resolve(); order.push(params.message); },
            focusText: () => { order.push('build'); return 'List'; },
            editOrigin: async (_, text) => { order.push(text); },
        },
    });
    assert.deepEqual(order, ['Person\n🔔⏳', 'build', 'List']);
}
{
    const seen = [];
    const router = createUpdateRouter({
        groupId: 99, ownerId: 1001,
        resolveReply: (_, reply) => { assert.equal(reply, null); return null; },
        markSeen: date => seen.push(['date', date]),
        parseImport: () => null,
        unpay: value => value,
        activeDnaExports: new Map(), cancelDnaExport() {},
        answerEvent: async (_, user, peer, text) => seen.push(['answer', peer, user, text]),
        findRecordByCmid: async (peer, cmid) => { seen.push(['reaction', peer, cmid]); return null; },
    }, async (peer, run, trace) => {
        seen.push(['queue', peer, trace]);
        return run();
    });
    const trace = (update, payload) => [update.type, payload.peer_id];
    for (const update of [null, { type: 'message_event', group_id: 99, object: {} },
        { type: 'unknown', group_id: 99, object: { peer_id: 1 } },
        { type: 'message_new', group_id: 98, object: { peer_id: 1, text: 'ignored' } }]) {
        assert.equal(router.longPoll(update, 99, trace), undefined);
    }
    await router.longPoll({ type: 'message_new', group_id: 99, object: { peer_id: 1, text: 'plain', date: 10 } }, 99, trace);
    await router.longPoll({ type: 'message_new', group_id: 99, object: { message: { peer_id: 2, text: 'plain', date: 20 } } }, 99, trace);
    await router.longPoll({ type: 'message_reaction_remove', group_id: 99, object: { peer_id: 2, from_id: 5, message_id: 8 } }, 99, trace);
    await router.longPoll({ type: 'message_event', group_id: 99, object: { peer_id: 1, user_id: 5, payload: 'old:unknown' } }, 99, trace);
    // Historical replay ignores action, attachments and the original author/reply.
    await router.catchUp({ peer_id: 4, text: '', date: 30, from_id: 5, reply_message: {}, action: {} }, 1);
    assert.deepEqual(seen, [
        ['queue', 1, ['message_new', 1]], ['date', 10],
        ['queue', 2, ['message_new', 2]], ['date', 20],
        ['queue', 2, ['message_reaction_remove', 2]], ['reaction', 2, 8],
        ['queue', 1, ['message_event', 1]], ['answer', 1, 5, 'неизвестная кнопка'],
        ['date', 30],
    ]);
}
process.env.LR_DB = path.join(tmp, 'vk-direct.db');
process.env.VK_TOKEN = 'repl-token';
const { vkUploadDoc, sendGedArtifacts } = (await import('../lunarreturns.js')).default.__test;
const realFetch = globalThis.fetch;
const apiResult = response => Response.json({ response });
const saveError = () => Response.json({ error: { error_code: 100, error_msg: 'invalid file' } });
// Сетевая ошибка на любом этапе загрузки повторяется, постоянная save-ошибка нет.
for (const failure of ['server', 'post', 'save', 'permanent', 'exhausted']) {
    const calls = { server: 0, post: 0, save: 0 };
    globalThis.fetch = async input => {
        const stage = {
            'https://api.vk.com/method/docs.getMessagesUploadServer': 'server',
            'https://api.vk.com/method/docs.save': 'save',
            'https://upload.invalid': 'post',
        }[input];
        assert.ok(stage, `Unexpected URL: ${input}`);
        calls[stage]++;
        if (failure === stage && calls[stage] === 1 || failure === 'exhausted' && stage === 'server') throw new TypeError('fetch failed');
        if (failure === 'permanent' && stage === 'save') return saveError();
        if (stage === 'post') return Response.json({ file: 'accepted' });
        return apiResult(stage === 'save' ? { doc: { owner_id: 1, id: 2 } } : { upload_url: 'https://upload.invalid' });
    };
    if (failure === 'permanent' || failure === 'exhausted') await assert.rejects(vkUploadDoc(1, 'test.ged', 'test'));
    else assert.equal(await vkUploadDoc(1, 'test.ged', 'test'), 'doc1_2');
    assert.deepEqual(calls, {
        server: failure === 'exhausted' ? 3 : ['server', 'post'].includes(failure) ? 2 : 1,
        post: failure === 'exhausted' ? 0 : failure === 'post' ? 2 : 1,
        save: failure === 'exhausted' ? 0 : failure === 'save' ? 2 : 1,
    });
}
// Ошибка одного артефакта не теряет успешные и не останавливает следующие.
const artifactNames = ['test.ged.txt', 'test.ged', 'test.pdf', 'test.epub'];
for (const failed of ['.ged', '.pdf', '.ged.txt', '.epub', 'all', 'none']) {
    const attempted = [];
    const edits = [];
    const final = Promise.withResolvers();
    globalThis.fetch = async (input, { body }) => {
        const method = input.split('/').at(-1);
        if (method === 'docs.getMessagesUploadServer') return apiResult({ upload_url: 'https://upload.invalid' });
        if (input === 'https://upload.invalid') return Response.json({ file: body.get('file').name });
        if (method === 'docs.save') {
            const name = body.get('title');
            attempted.push(name);
            if (failed === 'all' || name === 'test' + failed) return saveError();
            return apiResult({ doc: { owner_id: 1, id: attempted.length } });
        }
        assert.equal(method, 'messages.edit');
        const edit = Object.fromEntries(body);
        edits.push(edit);
        if (edit.message && !edit.message.includes('⏳')) final.resolve();
        return apiResult(1);
    };
    const lease = { async step(op) { return op === 'epub' ? ['test.epub', 'epub'] : op; }, release() {} };
    await sendGedArtifacts({ peer_id: 1, conversation_message_id: 42 }, undefined, 'test', null,
        '-Person\n' + 'x'.repeat(4000), { gedcom: true, pdf: true, epub: true }, 'keyboard',
        { lease, control: new AbortController() });
    let timer;
    try {
        await Promise.race([final.promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Missing final DNA edit: ' + failed)), 1000);
        })]);
    } finally { clearTimeout(timer); }
    assert.deepEqual(attempted, artifactNames);
    const successful = failed === 'all' ? [] : artifactNames.map((n, i) => n === 'test' + failed ? null : `doc1_${i + 1}`).filter(Boolean);
    const progress = edits.filter(edit => edit.message?.includes('⏳'));
    assert.equal(progress.length, successful.length + 1);
    progress.forEach((edit, i) => {
        assert.equal(edit.conversation_message_id, '42');
        assert.equal(edit.message, '-Person\n✂️⏳');
        assert.equal(edit.attachment, successful.slice(0, i).join(','));
    });
    const ready = edits.at(-1);
    assert.equal(ready.attachment, successful.join(','));
    assert.match(ready.message, /^-Person\n✂️/);
    if (failed === 'none') assert.equal(ready.message, '-Person\n✂️');
    else assert.match(ready.message, /Не удалось выложить файлы/);
}
globalThis.fetch = realFetch;
for (const platform of ['tg', 'vk']) {
    const script = platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs';
    const args = [script, '--fresh', ...(platform === 'tg' ? ['--private'] : [])];
    const env = { ...process.env, LR_DEV_DB: path.join(tmp, platform + '-anchor.json'),
        LR_DB: path.join(tmp, platform + '-anchor.db'), LR_VKOFF: process.env.LR_VKOFF || '937' };
    const commands = [kids, '/Старший', '>4 / родитель\\n$', '/ 1972-02-29\\n$', '/ 1972-02\\n$',
        '/Старший\\n Супруга\\n 1952-01-01\\n$\\n/\\n|',
        '>4 /#2\\n родитель\\n$\\n!\\n/'];
    const result = spawnSync(process.execPath, args, {
        cwd: root, env, input: commands.join('\n') + '\n', encoding: 'utf8', timeout: 120000,
    });
    const log = result.stdout + result.stderr;
    assert.equal(result.status, 0, log);
    assert.doesNotMatch(log, /ERROR:|Ошибка поискового запроса/);
    assert.match(log, /    \/ отец\n    \$\n    \| мать\n    \$/);
    assert.match(log, /Родитель 1950-01-01 отец/);
    assert.match(log, /Супруга 1952-01-01 мать/);
    const [, exact, partial, postfix, ...replyParts] = log.split(/^ {4}(?:\/ 1972-02(?:-29)?|\/Старший(?=\r?\n {4} Супруга)|\/#2(?=\r?\n {4} родитель))\r?$/m);
    const replyPostfix = replyParts.join('\n');
    assert.match(exact, /Старший 1972[\-_.]02[\-_.]29/);
    assert.doesNotMatch(exact, /Ничего не найдено/);
    assert.match(partial, /Ничего не найдено/);
    assert.match(postfix, /Супруга 1952-01-01/);
    assert.match(postfix, /Старший 1972-02-29/);
    assert.match(replyPostfix, /    \/#2 \/fynny1/);
    assert.match(replyPostfix, /Разложение по условиям/);
    assert.doesNotMatch(postfix + replyPostfix, /Условие:|Ошибка поискового запроса/);
    console.log(`A3 ${platform} REPL: global and reply end anchors and postfix OK`);
}
if (!process.argv.includes('--search-anchors-only')) for (const platform of ['tg', 'vk']) {
    const trace = path.join(tmp, platform + '-radius.jsonl');
    const env = { ...process.env, LR_DEV_DB: path.join(tmp, platform + '.json'), LR_DB: path.join(tmp, platform + '.db'),
        LR_VKOFF: '937', LR_VK_TRACE: trace };
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
    const edits = [...focusLog.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)];
    const loading = edits.filter(m => m[2].includes('⏳'));
    assert.equal(loading.length, 3, focusLog);
    for (const pending of loading) {
        assert.match(pending[2], /^    1 Старший 1972-02-29\n    (?:🔔|-\+=)⏳\n/);
        assert.match(pending[2], /\[4\.3\] 🔔/);
        const ready = edits[edits.indexOf(pending) + 1];
        assert.equal(ready[1], pending[1]);
        assert.doesNotMatch(ready[2], /⏳/);
        assert.match(ready[2], pending[2].includes('-+=⏳') ? /-Старший 1972-02-29/ : /Родитель 1950-01-01 отец/);
    }
    // Повторяем накопленные команды с чистой БД, выбирая номера из живой клавиатуры.
    const radiusCommands = ['-Предок 1920-01-01\\n--Первый 1940-01-01\\n---Второй 1960-01-01\\n----Третий 1980-01-01\\n-----Четвёртый 2000-01-01\\n------Пятый 2020-01-01', '/Пятый'];
    const runRadius = () => {
        fs.rmSync(trace, { force: true });
        const r = spawnSync(process.execPath, [script, '--fresh', ...(platform === 'tg' ? ['--private'] : [])], {
            cwd: root, env, input: radiusCommands.join('\n') + '\n', encoding: 'utf8', timeout: 120000,
        });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.doesNotMatch(r.stdout + r.stderr, /ERROR:|TypeError|ReferenceError/);
        return r.stdout;
    };
    const vkUploads = () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
        .filter(entry => entry.method === 'upload')
        .map(entry => entry.body.match(/filename="[^"]+(\.ged\.txt|\.ged|\.pdf|\.epub)"/)[1]);
    const textEdits = log => [...log.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)];
    let radiusLog = runRadius();
    let selectedRadius = '1';
    for (const label of ['2', '3', '1', '5', '4', '🔔', '🔔']) {
        const buttons = [...radiusLog.matchAll(new RegExp('\\[(\\d+)\\.(\\d+)\\] ' + label + '(?=  |\\n|$)', 'g'))];
        const button = buttons.at(-1);
        assert.ok(button, radiusLog);
        // The VK mock prints the old keyboard before storing the edited one.
        const index = platform === 'vk' && label !== '🔔'
            ? ['1', '2', '3', '4', '5'].filter(r => r !== selectedRadius).indexOf(label) + 1 : button[2];
        radiusCommands.push('/' + button[1] + ' ' + index);
        const previous = textEdits(radiusLog).length;
        radiusLog = runRadius();
        const updates = textEdits(radiusLog).slice(previous);
        assert.equal(updates.length, label === '🔔' ? 2 : 1, radiusLog);
        assert.ok(updates.every(m => m[1] === button[1]), radiusLog);
        if (label !== '🔔') selectedRadius = label;
        const head = '^    ' + selectedRadius + ' Пятый 2020-01-01\\n';
        if (label === '🔔') assert.match(updates[0][2], new RegExp(head + '    🔔⏳\\n'));
        assert.match(updates.at(-1)[2], new RegExp(head), radiusLog);
        assert.doesNotMatch(updates.at(-1)[2], /⏳/);
    }
    fs.writeFileSync(path.join(tmp, platform + '-radius.log'), radiusLog);
    const dna = [...radiusLog.matchAll(/\[(\d+)\.(\d+)\] 🧬/g)].at(-1);
    radiusCommands.push('/gedcom1', '/pdf1', '/epub1', '/' + dna[1] + ' ' + dna[2]);
    if (platform === 'vk') radiusCommands.push('!wait 6000');
    const dnaLog = runRadius();
    fs.writeFileSync(path.join(tmp, platform + '-dna.log'), dnaLog);
    const dnaEdits = textEdits(dnaLog).slice(textEdits(radiusLog).length)
        .filter(m => m[1] === dna[1]);
    assert.ok(dnaEdits.length >= 2, dnaLog);
    assert.match(dnaEdits[0][2], /^    4 Пятый 2020-01-01\n/);
    assert.match(dnaEdits[0][2], /    ⏳\n/);
    assert.match(dnaEdits.at(-1)[2], /Пятый 2020-01-01/);
    assert.doesNotMatch(dnaEdits.at(-1)[2], /⏳/);
    if (platform === 'tg') assert.match(dnaLog, /sendDocument: [^\n]+\.ged \(/);
    else assert.deepEqual(vkUploads(), ['.ged', '.pdf', '.epub']);
    radiusCommands.push('-Глава 1950-01-01\\n' + Array.from({ length: 100 }, (_, i) =>
        '--Потомок' + i + ' Очень Длинное Имя Для Перелива 1980-01-01').join('\\n'), '/Глава');
    const overflowSetup = runRadius();
    const overflowDna = [...overflowSetup.matchAll(/\[(\d+)\.(\d+)\] 🧬/g)].at(-1);
    radiusCommands.push('/' + overflowDna[1] + ' ' + overflowDna[2]);
    if (platform === 'vk') radiusCommands.push('!wait 6000');
    const overflowLog = runRadius();
    const overflowEdits = [...overflowLog.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)]
        .filter(m => m[1] === overflowDna[1]);
    assert.match(overflowEdits[0][2], /1 Глава 1950-01-01\n/);
    assert.match(overflowEdits[0][2], /✂️⏳/);
    assert.match(overflowEdits.at(-1)[2], /✂️/);
    assert.doesNotMatch(overflowEdits.at(-1)[2], /⏳/);
    if (platform === 'tg') {
        const docPattern = /\[\d+\] sendDocument: ([^\n]+)/g;
        const documents = [...overflowLog.matchAll(docPattern)].slice([...overflowSetup.matchAll(docPattern)].length);
        assert.deepEqual(documents.map(m => m[1].match(/(\.ged\.txt|\.ged|\.pdf|\.epub) \(/)?.[1]),
            ['.ged.txt', '.ged', '.pdf', '.epub']);
        assert.ok(documents[3].index < overflowLog.lastIndexOf('[' + overflowDna[1] + '] текст →'));
    } else assert.deepEqual(vkUploads().slice(3), ['.ged.txt', '.ged', '.pdf', '.epub']);
    fs.writeFileSync(path.join(tmp, platform + '-dna-overflow.log'), overflowLog);
    const flatButton = [...overflowLog.matchAll(/\[(\d+)\.(\d+)\] -\+=/g)].at(-1);
    radiusCommands.push('/' + flatButton[1] + ' ' + flatButton[2]);
    const flatLog = runRadius();
    const flatEdits = [...flatLog.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)]
        .filter(m => m[1] === flatButton[1]);
    const flatStart = flatEdits.findIndex(m => m[2].includes('-+=⏳'));
    assert.ok(flatStart >= 0, flatLog);
    assert.match(flatEdits[flatStart][2], /1 Глава 1950-01-01\n    -\+=⏳/);
    assert.match(flatEdits[flatStart + 1][2], /✂️⏳/);
    assert.match(flatEdits.at(-1)[2], /✂️/);
    assert.doesNotMatch(flatEdits.at(-1)[2], /⏳/);
    assert.match(flatEdits.at(-1)[2], new RegExp('\\[' + flatButton[1] + '\\.\\d+\\] -\\+='));
    fs.writeFileSync(path.join(tmp, platform + '-flat-overflow.log'), flatLog);
    if (platform === 'tg') {
        const commands = spawnSync(process.execPath, [script, '--fresh', '--private'], {
            cwd: root, env, input: [kids, '/Старший', '>4 /', '>4 /links', '>4 /gedcom2', '/links', '/gedcom'].join('\n') + '\n',
            encoding: 'utf8', timeout: 120000,
        });
        const commandLog = commands.stdout + commands.stderr;
        assert.equal(commands.status, 0, commandLog);
        assert.doesNotMatch(commandLog, /ERROR:|TypeError|ReferenceError|💥/);
        const botIds = new Set([...commandLog.matchAll(/\[(\d+)\] sendMessage:/g)].map(m => m[1]));
        const commandEdits = [...commandLog.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)];
        for (const edit of commandEdits) assert.ok(botIds.has(edit[1]), 'edited user message: ' + edit[1]);
        for (const id of new Set(commandEdits.map(m => m[1]))) {
            assert.doesNotMatch(commandEdits.filter(m => m[1] === id).at(-1)[2], /⏳/);
        }
        assert.match(commandLog, /-\+=⏳/);
        assert.equal([...commandLog.matchAll(/sendDocument: [^\n]+\.ged \(/g)].length, 2, commandLog);
        assert.doesNotMatch(commandLog, /sendDocument: [^\n]+\.(?:pdf|epub) \(/);
        fs.writeFileSync(path.join(tmp, 'tg-commands.log'), commandLog);
    }
    console.log('A3 ' + platform + ' REPL: Romanov, dateless batch, search, bell, links, overflow OK');
}

// ---- показанные ключи (план .kilo/plans/20261109-shown-key-fixes-plan.md):
// reply с `>` для AFT-дат полной/месячной/годовой гранулярности, reply с
// точками и `_` (отображённые ключи), неоднозначный-vs-отображённый выбор
// старостильной свадьбы (две FAM одной пары). Якоря reply — свои сообщения;
// `>N` требует номер сообщения, поэтому сначала сухой прогон setup-скрипта,
// из эха «[N] ты:» берутся номера якорей (реплаи идут после всех якорей,
// нумерация setup-части совпадает с сухим прогоном)
const shownGed = '0 HEAD\\n1 CHAR UTF-8\\n0 @I1@ INDI\\n1 NAME Олег\\n1 SEX M\\n1 BIRT\\n2 DATE 1 JAN 1880\\n0 @I2@ INDI\\n1 NAME Пелагея\\n1 SEX F\\n1 BIRT\\n2 DATE 1 JAN 1880\\n0 @F1@ FAM\\n1 HUSB @I1@\\n1 WIFE @I2@\\n1 MARR\\n2 DATE 1 JAN 1900\\n0 @F2@ FAM\\n1 HUSB @I1@\\n1 WIFE @I2@\\n1 MARR\\n2 DATE 13 JAN 1900\\n0 TRLR';
const shownPack = '-Афтполная 1971-05-20>\\n-Афтмесяц 1901-05>\\n-Афтгод 1901>\\n-Точная 2000.02.03';
const shownSetup = [
    shownGed,
    shownPack,
    'Старик 1900-01-01',
    'Афтжених+Афтневеста 1901-05>', // свадьба-AFT: пара-заглушка, mabt-суффикс
    'Афтполная 1971-05-20>', // триггеры = jubilee-ответы + якоря reply (полная — после 1918:
    'Афтмесяц 1901-05>', // показанная полная дата == хранимой, урезанные стиль-инвариантны)
    'Афтгод 1901>',
    'Точная 2000.02.03',
    'Старик 1900_01_13', // `_`-шапка старостильной персоны (идемпотентный upsert)
    // 💥-якоря свадебных ключей: время 25:00 невалидно — upsert нет, записи
    // FAM не мутируют (обычный триггер «Олег+Пелагея Д» переписал бы marr_d
    // первой fam пары и разрушил неоднозначность)
    'Олег+Пелагея 1900-01-13 25:00',
    'Олег+Пелагея 1900_01_13 25:00',
    'Олег+Пелагея 1900.01.13 25:00',
    '/bell',
];
const shownAnchor = (log, text) => {
    const m = log.match(new RegExp('\\[(\\d+)\\] ты:\\n {4}' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\n|$)'));
    assert.ok(m, 'нет эха якоря «' + text + '»:\n' + log.slice(-2000));
    return m[1];
};
for (const platform of ['tg', 'vk']) {
    const env = { ...process.env, LR_DEV_DB: path.join(tmp, platform + '-keys.json'), LR_DB: path.join(tmp, platform + '-keys.db'), LR_VKOFF: '937' };
    const script = platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs';
    const spawn = input => spawnSync(process.execPath, [script, '--fresh', ...(platform === 'tg' ? ['--private'] : [])],
        { cwd: root, env, input, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    const dry = spawn(shownSetup.join('\n') + '\n');
    const dryLog = dry.stdout + dry.stderr;
    fs.writeFileSync(path.join(tmp, platform + '-keys-dry.log'), dryLog);
    assert.equal(dry.status, 0, dryLog);
    assert.match(dryLog, /персон 2, семей 2/);
    const a = {
        wed: shownAnchor(dryLog, 'Афтжених+Афтневеста 1901-05>'),
        full: shownAnchor(dryLog, 'Афтполная 1971-05-20>'),
        month: shownAnchor(dryLog, 'Афтмесяц 1901-05>'),
        year: shownAnchor(dryLog, 'Афтгод 1901>'),
        dots: shownAnchor(dryLog, 'Точная 2000.02.03'),
        uscore: shownAnchor(dryLog, 'Старик 1900_01_13'),
        w2: shownAnchor(dryLog, 'Олег+Пелагея 1900-01-13 25:00'),
        w1u: shownAnchor(dryLog, 'Олег+Пелагея 1900_01_13 25:00'),
        w1d: shownAnchor(dryLog, 'Олег+Пелагея 1900.01.13 25:00'),
    };
    const commands = [
        ...shownSetup,
        `>${a.full} /`, `>${a.month} /`, `>${a.year} /`, // reply с `>` на трёх гранулярностях
        `>${a.dots} /`, `>${a.wed} /`, `>${a.uscore} /`, // точки, свадьба-AFT, `_`-персона
        `>${a.w2} /`, `>${a.w1u} /`, `>${a.w1d} /`, // свадьба: дефисы vs `_` vs точки
        '/Афтгод', // суффикс пережил все reply-потоки, дубля нет (одиночное попадание)
    ];
    const result = spawn(commands.join('\n') + '\n');
    const log = result.stdout + result.stderr;
    fs.writeFileSync(path.join(tmp, platform + '-keys.log'), log);
    assert.equal(result.status, 0, log);
    assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError/);
    // тексты бота ТГ идут HTML-экранированными (`>` → `&gt;`) — сопоставляем в едином виде
    const plain = log.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
    assert.match(plain, /персон 2, семей 2/); // обе FAM одной пары в выборке, первая раньше
    assert.match(plain, /персон 4/); // роспись AFT-персон влилась
    assert.match(plain, /некорректное время/); // 💥-якоря ничего не добавили
    // суффикс AFT хранится и печатается (триггерные юбилеи; полная — как хранится)
    assert.match(plain, /Афтжених\+Афтневеста 1901-05>/);
    assert.match(plain, /Афтполная 1971-05-20>/);
    assert.match(plain, /Афтмесяц 1901-05>/);
    assert.match(plain, /Афтгод 1901>/);
    // Колокольчик маркирует новый стиль так же, как легенда юбилея.
    assert.match(plain, /Старик 1900_01_13/);
    assert.match(plain, /Олег\+Пелагея 1900_01_25/); // юлианская 1900-01-13 + 12 дней
    assert.match(plain, /Точная 2000-02-03/);
    // reply-разрешение показанных ключей → фокус с хранимым ключом героя
    assert.match(plain, /1 Афтполная 1971-05-20/); // `>` полная (могла бы найтись и точным ключом)
    assert.match(plain, /1 Афтмесяц 1901-05-01/); // `>` месяц (без суффикса не нашлась бы)
    assert.match(plain, /1 Афтгод 1901-01-01/); // `>` год
    assert.match(plain, /1 Точная 2000-02-03/); // точки → точная запись
    assert.match(plain, /1 Афтжених\+Афтневеста 1901-05-01/); // свадьба-AFT
    assert.match(plain, /1 Старик 1900-01-01/); // `_`-шапка персоны
    // Дефисы совпадают с хранимой датой второй свадьбы и показанной датой первой.
    assert.equal([...plain.matchAll(/Не удалось найти цитируемую запись/g)].length, 1, plain);
    assert.doesNotMatch(plain, /1 Олег\+Пелагея 1900-01-13/);
    // `_` и точки однозначно совпадают только с показанной датой первой свадьбы.
    assert.equal([...plain.matchAll(/^focus: Олег\+Пелагея 1900-01-01 /gm)].length, 2, plain);
    const tail = plain.slice(plain.lastIndexOf('/Афтгод\n')); // от эха команды, не от console-строки
    assert.match(tail, /Афтгод 1901>/);
    assert.doesNotMatch(tail, /-Афтгод/); // список = тёзки/дубль, а не юбилей
    console.log('A3 ' + platform + ' REPL keys: AFT/dotted replies and ambiguous wedding rejection OK');
}
console.log('REPL logs: ' + tmp);
