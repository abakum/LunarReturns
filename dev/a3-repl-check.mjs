import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-a3-repl-'));
const root = new URL('../', import.meta.url);
const romanov = fs.readFileSync(new URL('./fixtures/Romanov_family.ged.txt', import.meta.url), 'utf8').trim().replaceAll('\n', '\\n');
const kids = '-Родитель 1950-01-01\\n+1970-02-28\\nСупруга 1952-01-01\\n--Старший 1972-02-29\\n--Младший\\n==Младшая';
const huge = Array.from({ length: 180 }, (_, i) => '-Тестовый' + String(i).padStart(3, '0') + ' Длинное Имя Для Переполнения 2000-01-01').join('\\n');
// REPL проверяет видимые правки; дополнительно фиксируем await до построения списка.
const tgCallback = fs.readFileSync(new URL('../tgcloud/handlers/callback_query.js', import.meta.url), 'utf8');
assert.match(tgCallback, /await api\.editMessageText\([\s\S]*?text: head \+ "\\n" \+ loading[\s\S]*?\)\.catch\([^\n]*\);\s*let text;\s*try \{\s*const sex = await sexOf\(\);\s*const keys = focusListKeys/);
const vkSource = fs.readFileSync(new URL('../lunarreturns.js', import.meta.url), 'utf8');
assert.match(vkSource, /await vkApi\("messages.edit", \{\s*peer_id: peerId,[\s\S]*?message: head \+ "\\n" \+ loading, keyboard: kb\s*\}\)\.catch\([^\n]*\);\s*let text;\s*try \{\s*const txt = focusText/);
// Сетевая ошибка на любом этапе загрузки повторяется, постоянная save-ошибка нет.
const uploadSource = vkSource.slice(vkSource.indexOf('async function vkUploadDoc('), vkSource.indexOf('// тап 🧬 /', vkSource.indexOf('async function vkUploadDoc(')));
for (const failure of ['server', 'post', 'save', 'permanent', 'exhausted']) {
    const calls = { server: 0, post: 0, save: 0 };
    const upload = vm.runInNewContext(uploadSource + '; vkUploadDoc', {
        groupId: 0, FormData, Blob, AbortSignal, console: { error() {} }, sleep: async () => {},
        vkApi: async method => {
            const stage = method === 'docs.save' ? 'save' : 'server';
            calls[stage]++;
            if (failure === stage && calls[stage] === 1 || failure === 'exhausted' && stage === 'server') throw new TypeError('fetch failed');
            if (failure === 'permanent' && stage === 'save') throw new Error('docs.save 100: invalid file');
            return stage === 'save' ? { doc: { owner_id: 1, id: 2 } } : { upload_url: 'https://upload.invalid' };
        },
        fetch: async () => {
            calls.post++;
            if (failure === 'post' && calls.post === 1) throw new TypeError('fetch failed');
            return { text: async () => '{"file":"accepted"}' };
        },
    });
    if (failure === 'permanent' || failure === 'exhausted') await assert.rejects(upload(1, 'test.ged', 'test'));
    else assert.equal(await upload(1, 'test.ged', 'test'), 'doc1_2');
    assert.deepEqual(calls, {
        server: failure === 'exhausted' ? 3 : ['server', 'post'].includes(failure) ? 2 : 1,
        post: failure === 'exhausted' ? 0 : failure === 'post' ? 2 : 1,
        save: failure === 'exhausted' ? 0 : failure === 'save' ? 2 : 1,
    });
}
// Ошибка одного артефакта не теряет успешные и не останавливает следующие.
const artifactsStart = vkSource.indexOf('const files = [[base + ".ged", g]]');
const artifactsEnd = vkSource.indexOf('// Чат-кейс:', artifactsStart);
assert.ok(artifactsStart >= 0 && artifactsEnd > artifactsStart);
for (const failed of ['.ged', '.pdf', '.ged.txt', 'all', 'none']) {
    const attempted = [];
    const progress = [];
    const result = vm.runInNewContext('(async () => { let t0; ' + vkSource.slice(artifactsStart, artifactsEnd)
        + ' return { atts, readyTxt }; })()', {
        base: 'test', g: 'ged', pdf: 'pdf', overflow: true, pack: 'pack', finalTxt: 'header', Buffer,
        holdTxt: 'header\n⏳', kb: 'keyboard', origin: { conversation_message_id: 42 }, sent: -1,
        vkApi: async (method, params) => { progress.push({ method, ...params }); },
        console: { log() {}, error() {} },
        vkUploadDoc: async (peer, name) => {
            attempted.push(name);
            if (failed === 'all' || name === 'test' + failed) throw new Error('timeout');
            return name;
        }, peerId: 1,
    });
    if (failed === 'all') await assert.rejects(result, /timeout/);
    else {
        const ready = await result;
        assert.deepEqual(Array.from(ready.atts), ['test.ged', 'test.pdf', 'test.ged.txt'].filter(n => n !== 'test' + failed));
        assert.equal(progress.length, ready.atts.length);
        progress.forEach((edit, i) => {
            assert.equal(edit.method, 'messages.edit');
            assert.equal(edit.conversation_message_id, 42);
            assert.equal(edit.message, 'header\n⏳');
            assert.equal(edit.attachment, Array.from(ready.atts).slice(0, i + 1).join(','));
        });
        if (failed === 'none') assert.equal(ready.readyTxt, 'header');
        else assert.ok(ready.readyTxt.includes('test' + failed + ': timeout'));
    }
    assert.deepEqual(attempted, ['test.ged', 'test.pdf', 'test.ged.txt']);
}
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
        const r = spawnSync(process.execPath, [script, '--fresh', ...(platform === 'tg' ? ['--private'] : [])], {
            cwd: root, env, input: radiusCommands.join('\n') + '\n', encoding: 'utf8', timeout: 120000,
        });
        assert.equal(r.status, 0, r.stdout + r.stderr);
        assert.doesNotMatch(r.stdout + r.stderr, /ERROR:|TypeError|ReferenceError/);
        return r.stdout;
    };
    let radiusLog = runRadius();
    for (const label of ['2', '3', '1', '5', '4', '🔔', '🔔']) {
        const buttons = [...radiusLog.matchAll(new RegExp('\\[(\\d+)\\.(\\d+)\\] ' + label + '(?=  |\\n|$)', 'g'))];
        const button = buttons.at(-1);
        assert.ok(button, radiusLog);
        radiusCommands.push('/' + button[1] + ' ' + button[2]);
        radiusLog = runRadius();
        const updates = [...radiusLog.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)].slice(-2);
        assert.equal(updates.length, 2, radiusLog);
        assert.equal(updates[0][1], button[1]);
        assert.equal(updates[1][1], button[1]);
        const radius = label === '🔔' ? '4' : label;
        assert.match(updates[0][2], new RegExp('^    ' + radius + ' Пятый 2020-01-01\\n    🔔⏳\\n'));
        assert.match(updates[1][2], new RegExp('^    ' + radius + ' Пятый 2020-01-01\\n'));
        assert.match(updates[1][2], /Пятый 2020-01-01/);
        assert.doesNotMatch(updates[1][2], /⏳/);
    }
    fs.writeFileSync(path.join(tmp, platform + '-radius.log'), radiusLog);
    const dna = [...radiusLog.matchAll(/\[(\d+)\.(\d+)\] 🧬/g)].at(-1);
    radiusCommands.push('/' + dna[1] + ' ' + dna[2]);
    if (platform === 'vk') radiusCommands.push('!wait 3000');
    const dnaLog = runRadius();
    fs.writeFileSync(path.join(tmp, platform + '-dna.log'), dnaLog);
    const dnaEdits = [...dnaLog.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)];
    const start = dnaEdits.findIndex(m => m[2].includes('🧬⏳'));
    assert.ok(start >= 0, dnaLog);
    assert.match(dnaEdits[start][2], /^    4 Пятый 2020-01-01\n    🧬⏳\n/);
    assert.equal(dnaEdits[start + 1][1], dnaEdits[start][1]);
    assert.match(dnaEdits[start + 1][2], /⏳/);
    assert.match(dnaEdits[start + 1][2], /Пятый 2020-01-01/);
    assert.doesNotMatch(dnaEdits[start + 1][2], /🧬⏳/);
    assert.doesNotMatch(dnaEdits.at(-1)[2], /⏳/);
    assert.match(dnaLog, /\.ged/);
    radiusCommands.push('-Глава 1950-01-01\\n' + Array.from({ length: 100 }, (_, i) =>
        '--Потомок' + i + ' Очень Длинное Имя Для Перелива 1980-01-01').join('\\n'), '/Глава');
    const overflowSetup = runRadius();
    const overflowDna = [...overflowSetup.matchAll(/\[(\d+)\.(\d+)\] 🧬/g)].at(-1);
    radiusCommands.push('/' + overflowDna[1] + ' ' + overflowDna[2]);
    if (platform === 'vk') radiusCommands.push('!wait 3000');
    const overflowLog = runRadius();
    const overflowEdits = [...overflowLog.matchAll(/\[(\d+)\] текст →\n((?:    .*\n)*)/g)]
        .filter(m => m[1] === overflowDna[1]);
    assert.match(overflowEdits[0][2], /1 Глава 1950-01-01\n    🧬⏳/);
    assert.match(overflowEdits[1][2], /✂️⏳/);
    assert.match(overflowEdits.at(-1)[2], /✂️/);
    assert.doesNotMatch(overflowEdits.at(-1)[2], /⏳/);
    assert.match(overflowLog, /\.ged\.txt/);
    if (platform === 'tg') {
        const documents = [...overflowLog.matchAll(/\[\d+\] sendDocument: ([^\n]+)/g)].slice(-3);
        assert.equal(documents.length, 3);
        assert.match(documents[0][1], /\.ged \(/);
        assert.match(documents[1][1], /\.ged\.txt \(/);
        assert.match(documents[2][1], /\.pdf \(/);
        assert.ok(documents[2].index < overflowLog.lastIndexOf('[' + overflowDna[1] + '] текст →'));
    }
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
            cwd: root, env, input: [kids, '/Старший', '>3 /', '>3 /links', '>3 /gedcom2', '/links', '/gedcom'].join('\n') + '\n',
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
        assert.match(commandLog, /🧬⏳/);
        assert.ok([...commandLog.matchAll(/sendDocument:/g)].length >= 6, commandLog);
        fs.writeFileSync(path.join(tmp, 'tg-commands.log'), commandLog);
    }
    console.log('A3 ' + platform + ' REPL: Romanov, dateless batch, search, bell, links, overflow OK');
}

// ---- показанные ключи (план .kilo/plans/20261109-shown-key-fixes-plan.md):
// reply с `>` для AFT-дат полной/месячной/годовой гранулярности, reply с
// точками и `_` (отображённые ключи), точный-vs-отображённый выбор
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
    // колокольчик: старый стиль — новым с дефисами (уникальные для 🔔 строки), свадьбы включены
    assert.match(plain, /Старик 1900-01-13/);
    assert.match(plain, /Олег\+Пелагея 1900-01-25/); // юлианская 1900-01-13 + 12 дней
    assert.match(plain, /Точная 2000-02-03/);
    // reply-разрешение показанных ключей → фокус с хранимым ключом героя
    assert.match(plain, /1 Афтполная 1971-05-20/); // `>` полная (могла бы найтись и точным ключом)
    assert.match(plain, /1 Афтмесяц 1901-05-01/); // `>` месяц (без суффикса не нашлась бы)
    assert.match(plain, /1 Афтгод 1901-01-01/); // `>` год
    assert.match(plain, /1 Точная 2000-02-03/); // точки → точная запись
    assert.match(plain, /1 Афтжених\+Афтневеста 1901-05-01/); // свадьба-AFT
    assert.match(plain, /1 Старик 1900-01-01/); // `_`-шапка персоны
    assert.match(plain, /1 Олег\+Пелагея 1900-01-13/); // дефисы: точный ключ свадьбы (вторая fam)
    assert.match(plain, /1 Олег\+Пелагея 1900-01-01/); // `_`/точки: отображённый fallback (первая fam)
    const tail = plain.slice(plain.lastIndexOf('/Афтгод\n')); // от эха команды, не от console-строки
    assert.match(tail, /Афтгод 1901>/);
    assert.doesNotMatch(tail, /-Афтгод/); // список = тёзки/дубль, а не юбилей
    console.log('A3 ' + platform + ' REPL keys: AFT/dotted replies, wedding exact-vs-displayed OK');
}
console.log('REPL logs: ' + tmp);
