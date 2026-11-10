import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-a3-repl-'));
const root = new URL('../', import.meta.url);
const romanov = fs.readFileSync(new URL('./fixtures/Romanov_family.ged.txt', import.meta.url), 'utf8').trim().replaceAll('\n', '\\n');
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
