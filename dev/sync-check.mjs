#!/usr/bin/env node
// dev/sync-check.mjs — проверка синхронности чистой логики ВК (lunarreturns.js)
// и ТГ (tgcloud/lib): обе стороны исполняются на одинаковых сценариях
// (parseTrigger, parseGedcom, гедком-импорт/экспорт, связи/семьи/каскад) и
// результаты сравниваются дословно. Расхождение → вывод diff и exit 1.
// Использование: node dev/sync-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import './a3-text-check.mjs';
import './a3-flat-check.mjs';
import './a3-ged-check.mjs';
import './a3-list-check.mjs';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join('/tmp/kilo', 'lr-sync-'));

let failed = 0;
function cmp(what, vk, tg) {
    const a = typeof vk === 'string' ? vk : JSON.stringify(vk);
    const b = typeof tg === 'string' ? tg : JSON.stringify(tg);
    if (a === b) return;
    failed++;
    console.log('✗ ' + what);
    console.log('  ВК: ' + a);
    console.log('  ТГ: ' + b);
}

// ---- ВК: копия lunarreturns.js уходит в тихий test-режим; __test-экспорт
// уже в файле (SQLite store: personRows/weddingRows/famList/upsertPerson…);
// __extra — низкоуровневый доступ к SQL для VK-only сценариев (sent)
process.env.LR_DB = path.join(TMP, 'vk.db');
const vkHook = '\nmodule.exports.__extra = { qa, q1, qr };\n';
const vkFile = path.join(TMP, 'vk.cjs');
fs.writeFileSync(vkFile, fs.readFileSync(path.join(ROOT, 'lunarreturns.js'), 'utf8') + vkHook);
const require = createRequire(import.meta.url);
const prevArgv = process.argv.slice();
process.argv = [process.argv[0], vkFile, 'test', ''];
const prevLog = console.log;
console.log = () => {};
let VK;
try { VK = require(vkFile).__test; } finally { console.log = prevLog; process.argv = prevArgv; }
const VKX = require(vkFile).__extra; // низкоуровневые qa/q1/qr для VK-only (sent)

// ---- ТГ: tgcloud/lib через sdk-mock (как dev/repl.mjs) ----
process.env.LR_DEV_DB = path.join(TMP, 'tg-db.json');
fs.cpSync(path.join(ROOT, 'dev', 'sdk-mock'), path.join(ROOT, 'node_modules', 'sdk'), { recursive: true });
const TG = await import(path.join(ROOT, 'tgcloud', 'lib', 'bot.js'));
assert.equal(typeof VK.HELP, 'string');
assert.equal(VK.HELP, TG.HELP, 'VK and TG HELP must match');
const TGP = await import(path.join(ROOT, 'tgcloud', 'lib', 'parse.cjs'));
const TGOS = await import(path.join(ROOT, 'tgcloud', 'lib', 'religion.cjs'));
// chart нужен уже в блоке 3в (бездатные в связях) — грузим сразу;
// шрифт — единственный источник tgcloud/lib/font-cyr.cjs (ВК читает его же)
const TGC = await import(path.join(ROOT, 'tgcloud', 'lib', 'chart.cjs'));
const FONT = TGC.chartFont();

// Repeated complete marriages retain database family identities and children.
for (const api of [VK, TG]) {
    const id = 898989;
    const source = TGP.parseGedcom(fs.readFileSync(path.join(ROOT, 'dev/fixtures/repeated-full-couple-marriages.ged'), 'utf8'));
    await api.importGedcom(id, source);
    const txt = await api.chatFlatText(id);
    assert.match(txt, /\+1970 1980 ~F1/);
    assert.match(txt, /\+1990 ~F2/);
    for (let i = 0; i < 2; i++) await api.applyTree(id, TGP.parseTree(txt));
    let ged = TGP.parseGedcom(await api.gedcomText(id));
    assert.equal(ged.fams.length, 3);
    assert.equal(ged.indis.length, 6);
    for (const [date, child] of [['1970-01-01', 'FirstChild'], ['1982-01-01', 'MiddleChild'], ['1990-01-01', 'LastChild']]) {
        assert.deepEqual(ged.fams.find(f => f.marr.date === date).chil.map(x => ged.indis.find(p => p.__xref === x).name), [child]);
    }
    const collision = '-Stranger 1940\n+1965 ~F1\nDifferent 1942\n--TheirChild 1967';
    for (let i = 0; i < 2; i++) await api.applyTree(id, TGP.parseTree(collision));
    ged = TGP.parseGedcom(await api.gedcomText(id));
    assert.equal(ged.fams.length, 4);
    assert.equal(ged.fams.find(f => f.__xref === 'F1').marr.date, '1970-01-01');
    assert.equal(ged.fams.find(f => f.__xref === 'F1_2').marr.date, '1965-01-01');
    const hashSource = TGP.parseGedcom(fs.readFileSync(path.join(ROOT, 'dev/fixtures/repeated-full-couple-marriages.ged'), 'utf8').replaceAll('@F1@', '@F#1@'));
    await api.importGedcom(id, hashSource);
    const hashTxt = await api.chatFlatText(id);
    assert.match(hashTxt, /~F№1/);
    for (let i = 0; i < 2; i++) await api.applyTree(id, TGP.parseTree(hashTxt));
    ged = TGP.parseGedcom(await api.gedcomText(id));
    assert.equal(ged.fams.length, 3);
    assert.ok(ged.fams.some(f => f.__xref === 'F#1'));
    const noSuffix = '-Repeat 1940\n+1970\nPartner 1942\n+1970\nPartner';
    await api.clearChatTree(id);
    for (let i = 0; i < 2; i++) await api.applyTree(id, TGP.parseTree(noSuffix));
    ged = TGP.parseGedcom(await api.gedcomText(id));
    assert.equal(ged.fams.length, 2);
    assert.equal(ged.indis.length, 2);
    for (const row of ['+ ~F2', '+1970 (Town) 1980 (Away) ~F2 ^note', '+ 1980 (Away) ~F2 ^note']) {
        const parsed = TGP.parseTree('-Owner 1940\n' + row);
        assert.deepEqual(parsed.errors, []);
        assert.equal(parsed.weddings[0].xref, 'F2');
        assert.equal(parsed.weddings[0].note, row.includes('^note') ? 'note' : '');
        if (row.startsWith('+ ' ) && row.includes('1980')) {
            assert.equal(parsed.weddings[0].rec.d, undefined);
            assert.equal(parsed.weddings[0].rec.dd, '1980-01-01');
        }
        assert.ok(TGP.packToCsv('-Owner 1940\n' + row).endsWith('\t~F2'));
    }
    const solo = '-Single 1940\n+ ~Solo\n--Kid 1960\n+ 1980 (Away) ~Div ^note';
    await api.clearChatTree(id);
    for (let i = 0; i < 2; i++) await api.applyTree(id, TGP.parseTree(solo));
    ged = TGP.parseGedcom(await api.gedcomText(id));
    assert.equal(ged.fams.length, 2);
    assert.equal(ged.fams.find(f => f.__xref === 'Solo').chil.length, 1);
    assert.equal(ged.fams.find(f => f.__xref === 'Div').div.plac, 'Away');
}

// ============================== 1. parseTrigger ==============================
const TRIGGERS = [
    'Иван 1960-05-10',
    'Иван 1960-05-10 06:30',
    'Иван 1960-05-10 06:30 (Пермь)',
    'Иван 1960-05-10 12:30 МСК+2',
    'Иван 1960-05-10 12:30 UTC-3',
    'Иван 1960-05-10 04:30',
    'Агафья 1663 1681-07-14',
    'Пётр I 1672 1725 Император',
    'Иван+Мария 1983-06-04 (Пермь) 1990-01-01 (Казань)',
    'Иван 1960-05-10 06:30 2020-02-03 04:00',
    'Иван 1960-13-10',
    'Иван 1960-05-10 (Тьмутаракань)',
    'Иван 1960-05-10 2020-02-03',
    'Пётр 1985-07-07 23:45 (Пермь) 2020-02-03 04:00',
    'Иван+Мария 1983-06-04 1990-01-01',
    // «^» — маркер примечания: после него — дословно, дата в начале
    // примечания не парсится как смерть/развод
    'Николай 1868-05-18 ^1917 отрёкся',
    'Иван 1960-05-10 2020-02-03 ^продолжение^вторая строка',
    'Иван+Мария 1983-06-04 (Пермь) ^1990 разъехались',
    // «_» в разделителях полной даты — показанный новый стиль (шапка юбилея):
    // разбор конвертирует в хранимый старый; урезанные и поздние — как есть
    'Мария 1624_04_11',
    'Мария 1624_04_11 12:30 (Пермь)',
    'Агафья 1663_07_24 1681_07_24',
    'Николай 1918_02_13',
    'Николай 1918_02_14',
    'Иван 1963_09_27',
    'Мария 1624_04',
];
for (const t of TRIGGERS) cmp('parseTrigger ' + JSON.stringify(t), VK.parseTrigger(t), TGP.parseTrigger(t));

// ============================== 2. parseGedcom ==============================
const GEDCOM = [
    '0 HEAD', '1 GEDC', '2 VERS 5.5.1',
    '0 @I1@ INDI', '1 NAME Иван /Иванов/', '1 SEX M', '1 BIRT', '2 DATE 10 MAY 1960', '2 TIME 06:30',
    '1 NOTE 1960 год уточня', '2 CONC ется', '2 CONT вторая строка',
    '0 @I2@ INDI', '1 NAME Мария /Иванова/', '1 SEX F', '1 BIRT', '2 DATE 1 MAR 1962',
    '0 @I3@ INDI', '1 NAME Пётр /Иванов/', '1 BIRT', '2 DATE 7 JUL 1985', '2 TIME 23:45',
    '1 DEAT', '2 DATE 3 FEB 2020', '2 TIME 05:15', '1 ADOP', '2 FAMC @F1@',
    '0 @I4@ INDI', '1 NAME Год /Только/', '1 BIRT', '2 DATE 1624', '1 DEAT', '2 DATE 1669',
    '0 @I5@ INDI', '1 NAME Анна /Месяц/', '1 SEX F', '1 BIRT', '2 DATE ABT MAR 1662',
    '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 CHIL @I3@', '2 PEDI adopted',
    '1 CHIL @I4@',
    '1 MARR', '2 DATE 4 JUN 1983', '2 PLAC Пермь', '1 DIV', '2 DATE 1 JAN 1990',
    '1 NOTE венчание', '2 CONT в Перми',
    '0 TRLR',
].join('\n');
cmp('parseGedcom', VK.parseGedcom(GEDCOM), TGP.parseGedcom(GEDCOM));
cmp('gedStats', VK.gedStats(VK.parseGedcom(GEDCOM)), TGP.gedStats(TGP.parseGedcom(GEDCOM)));
// неполные даты не ломают импорт: «1624» → 1624-01-01, «ABT MAR 1662» →
// 1662-03-01 (первым числом известного месяца/года, ABT → abt 4)
const gUnf = VK.parseGedcom(GEDCOM);
const unfB = gUnf.indis.find(i => i.__xref === 'I4');
const unfM = gUnf.indis.find(i => i.__xref === 'I5');
if (unfB.birt.date !== '1624-01-01' || unfB.deat.date !== '1669-01-01' || unfM.birt.date !== '1662-03-01') {
    failed++;
    console.log('✗ неполные даты гедкома\n  I4: ' + unfB.birt.date + ' / ' + unfB.deat.date
        + ', I5: ' + unfM.birt.date);
}
// NOTE с продолжениями: CONC — склейка без пробела, CONT — новая строка («^»)
const unfA = gUnf.indis.find(i => i.__xref === 'I1');
const unfF = gUnf.fams.find(f => f.__xref === 'F1');
if (unfA.note !== '1960 год уточняется^вторая строка')
    { failed++; console.log('✗ NOTE+CONC+CONT: ' + JSON.stringify(unfA.note)); }
if (unfF.note !== 'венчание^в Перми')
    { failed++; console.log('✗ FAM NOTE+CONT: ' + JSON.stringify(unfF.note)); }
// хвостовые пробелы строки и ведущие пробелы CONT принадлежат значению
// («Иванов » + 2 CONC «Иван» → «Иванов Иван»); табуляции при импорте — прочь
const GED2 = [
    '0 HEAD', '1 GEDC',
    '0 @I1@ INDI', '1 NAME Иван\t/Иванов/', '1 BIRT', '2 DATE 10 MAY 1960',
    '1 NOTE Иванов ', '2 CONC Иван', '2 CONT  отступ сохранён',
    '0 @I2@ INDI', '1 NAME Мария /Петрова/', '1 NOTE текст\tс\tтабом',
].join('\n');
cmp('parseGedcom NOTE-пробелы/табы', VK.parseGedcom(GED2), TGP.parseGedcom(GED2));
const g2 = VK.parseGedcom(GED2);
const g2a = g2.indis.find(i => i.__xref === 'I1'), g2b = g2.indis.find(i => i.__xref === 'I2');
if (g2a.note !== 'Иванов Иван^ отступ сохранён')
    { failed++; console.log('✗ NOTE+CONC хвостовой пробел: ' + JSON.stringify(g2a.note)); }
if (g2b.note !== 'текст с табом' || g2b.name !== 'Мария Петрова')
    { failed++; console.log('✗ табы в значениях: ' + JSON.stringify(g2b.note) + ' / ' + g2b.name); }
// «^» в триггере: дата в начале примечания — не смерть
const hatP = VK.parseTrigger('Николай 1868-05-18 ^1917 отрёкся');
if (!hatP || hatP.rec.dd !== undefined || hatP.tail !== '1917 отрёкся')
    { failed++; console.log('✗ parseTrigger «^»: ' + JSON.stringify(hatP)); }

// частичные даты и хвост-примечание триггеров («1663» → 1663-01-01,
// «1693-01» → 1693-01-01; хвост после дат — примечание целиком)
const TREE_TRIGGERS = [
    'Агафья 1663 1681-07-14 Царица',
    'Пётр 1672-05 1725-01-28 Первый (Пермь)',
    'Иван 1663',
    'Иван 1960-05-10 06:30 (Пермь) шутка',
    'Иван 1960-05-10 2020-02-03 царь всея Руси',
];
for (const t of TREE_TRIGGERS) cmp('parseTrigger(tree) ' + JSON.stringify(t), VK.parseTrigger(t), TGP.parseTrigger(t));

// ========================= 1б. родословная роспись -+= =========================
// мини-древо: пара, свадьба, дети с семьями (грамматика 2026-10-23 v2:
// «+»×n — свадьба владельца глубины n−1; вторая половина — строкой ниже)
const TREE1 = `\
-Алексей Михайлович 1629-03-19 1676-02-08 Царь (1645—1676)
+1648-01-16
Мария Ильинична 1624-07-11 1669-03-11 1663 год в источнике
--Фёдор III 1661-06-09 1682-04-27
--Софья Алексеевна 1657-09-27 1704-07-14
+1671-09-09
Наталья Кирилловна 1651-09-01 1694-02-04
--Пётр I 1672-05-30 1725-01-28 Император Всероссийский`;
// муж с двумя жёнами (правдоподобие ухватывает правду: Марфа — Фёдору;
// Фёдор на глубине 1 → его свадьбы «++»)
const TREE2 = `-Алексей Михайлович 1629-03-19 1676-02-08
+1648-01-16
Мария Ильинична 1624-07-11 1669-03-11
--Фёдор III 1661-06-09 1682-04-27
++1680-07-28
Агафья 1663 1681-07-14
---Илья 1681-07-11 1681-07-21
++1682-02-15
Марфа 1664-03-15
==Феодосия 1682-06-14`;
// ошибки: датная свадьба без половины остаётся односторонней, глубина без
// родителей, непонятный маркер, строка дат без «+» (свадьба — «+»×n + даты),
// имя без открытой «+»
const TREE3 = `\
+1960-01-01
-Одинокий 1900-01-01
-Сирота 1900-01-01
---Глубоко 1900-01-01
+-+=
1960-01-01
1960-01-01 Имя без маркера
Одинокое Имя`;
const TREES = [['мини-древо', TREE1], ['две жены', TREE2], ['ошибки', TREE3]];
for (const [t, txt] of TREES) {
    cmp('parseTree «' + t + '»', VK.parseTree(txt), TGP.parseTree(txt));
    cmp('parseTreeLine «' + t + '»',
        txt.split(/\r?\n/).map(l => VK.parseTreeLine(l.trim())),
        txt.split(/\r?\n/).map(l => TGP.parseTreeLine(l.trim())));
}
// применённое древо: персоны/пары/связи/гедком поровну
const TREE_CH = 77;
VK.clearChatTree(TREE_CH);
await TG.clearChatTree(TREE_CH);
for (const [t, txt] of TREES) {
    const vkRep = VK.applyTree(TREE_CH, VK.parseTree(txt));
    const tgRep = await TG.applyTree(TREE_CH, TGP.parseTree(txt));
    // аккуратно: обе стороны получили одинаковое parseTree-значение
    cmp('applyTree отчёт «' + t + '»', vkRep, tgRep);
}
cmp('applyTree personRows', VK.personRows(TREE_CH), await TG.personRows(TREE_CH));
cmp('applyTree weddingRows', VK.weddingRows(TREE_CH), await TG.weddingRows(TREE_CH));
cmp('applyTree famList', VK.famList(TREE_CH), await TG.famList(TREE_CH));
cmp('applyTree gedcomText', VK.gedcomText(TREE_CH), await TG.gedcomText(TREE_CH));
// повторное применение того же сообщения — стабильный пересбор (дубликаты съедены)
const vkRep2 = VK.applyTree(TREE_CH, VK.parseTree(TREE1));
const tgRep2 = await TG.applyTree(TREE_CH, TGP.parseTree(TREE1));
cmp('applyTree повтор «мини-древо»', vkRep2, tgRep2);
cmp('applyTree повтор gedcomText', VK.gedcomText(TREE_CH), await TG.gedcomText(TREE_CH));
// родословная роспись -+= чата (тап на «-+=»): вывод идентичен
cmp('applyTree chatFlatText', VK.chatFlatText(TREE_CH), await TG.chatFlatText(TREE_CH));
cmp('applyTree повтор chatFlatText', VK.chatFlatText(TREE_CH), await TG.chatFlatText(TREE_CH));

// примечания с маркером «^» (дата в начале — не смерть/развод; внутренние
// «^» — переносы строк NOTE гедкома): вывод росписи всегда с «^», реимпорт
// идемпотентен
const NOTE_CH = 78;
const TREE_NOTE = `\
-Николай II 1868-05-18 ^1917 отрёкся^вторая строка примечания
+1894-11-26 ^венчание в Зимнем
Александра 1872-06-06 ^получила 18 орденов
--Ольга 1895-11-15 1918-07-17 ^старшая дочь`;
cmp('parseTree «примечания»', VK.parseTree(TREE_NOTE), TGP.parseTree(TREE_NOTE));
VK.clearChatTree(NOTE_CH); await TG.clearChatTree(NOTE_CH);
cmp('applyTree отчёт «примечания»',
    VK.applyTree(NOTE_CH, VK.parseTree(TREE_NOTE)),
    await TG.applyTree(NOTE_CH, TGP.parseTree(TREE_NOTE)));
cmp('applyTree chatFlatText «примечания»',
    VK.chatFlatText(NOTE_CH), await TG.chatFlatText(NOTE_CH));
cmp('applyTree gedcomText «примечания»',
    VK.gedcomText(NOTE_CH), await TG.gedcomText(NOTE_CH));
const noteFlat = VK.chatFlatText(NOTE_CH);
const NOTE_FLAT_EXPECT = '-Николай II 1868-05-18 ^1917 отрёкся^вторая строка примечания\n'
    + '+1894-11-26 ^венчание в Зимнем\n'
    + 'Александра 1872-06-06 ^получила 18 орденов\n'
    + '--Ольга 1895-11-15 1918-07-17 ^старшая дочь';
if (noteFlat !== NOTE_FLAT_EXPECT)
    { failed++; console.log('✗ пачка с «^»-примечаниями:\n  ' + noteFlat); }
// round-trip: реимпорт выведенной росписи идемпотентен (примечание и смерти
// на месте), гедком раскладывает переносы в 2 CONT
VK.applyTree(NOTE_CH, VK.parseTree(noteFlat));
await TG.applyTree(NOTE_CH, TGP.parseTree(noteFlat));
cmp('round-trip chatFlatText «примечания»',
    VK.chatFlatText(NOTE_CH), await TG.chatFlatText(NOTE_CH));
if (VK.chatFlatText(NOTE_CH) !== NOTE_FLAT_EXPECT)
    { failed++; console.log('✗ round-trip пачки:\n  ' + VK.chatFlatText(NOTE_CH)); }
const noteGed = VK.gedcomText(NOTE_CH);
if (!noteGed.includes('1 NOTE 1917 отрёкся') || !noteGed.includes('2 CONT вторая строка примечания')
    || !noteGed.includes('1 NOTE венчание в Зимнем'))
    { failed++; console.log('✗ гедком с NOTE/CONT:\n  ' + noteGed); }
// роспись → CSV (Excel): маркер пола не клеится к имени («=Имя» — формула
// для Excel); maxDepth — максимум глубины префиксов росписи; строка глубины
// n — maxDepth−n пустых ячеек, затем символы префикса по одному в каждой
// колонке («--Сын» → «-\t-\tСын» при maxDepth=2), затем Имя — имена у
// всех строк в колонке maxDepth+1, глубина видна по дефисам у правого
// края структуры; поля — свои ячейки (даты/места/примечание), пустые
// резервируются; скобки мест сняты; первый «^» — таб примечания; строки
// с «#» — мимо, «#» в строке — обрезка
const CSV_SRC = [
    '#not for cut and graft',
    '-Иван 1980-01-01 12:30 (Пермь) 2010-01-02 (Казань)^заметка^строка два',
    '+1985-05-10 1995-01-02 (Москва)',
    'Мария 1962-03-01',
    '++',
    'Ева',
    '--Сын 2010-02-03',
    'Комментарий в строке # хвост',
    '==Дочь 2012-03-04 (Киев)',
].join('\n');
const CSV_EXPECT = [
    '\t-\tИван\t1980-01-01 12:30\tПермь\t2010-01-02\tКазань\tзаметка^строка два',
    '\t+\t\t1985-05-10\t\t1995-01-02\tМосква\t',
    '\t\tМария\t1962-03-01\t\t\t\t',
    '+\t+\t\t\t\t\t\t',
    '\t\tЕва\t\t\t\t\t',
    '-\t-\tСын\t2010-02-03\t\t\t\t',
    '\t\tКомментарий в строке\t\t\t\t\t',
    '=\t=\tДочь\t2012-03-04\tКиев\t\t\t',
].join('\n');
cmp('packToCsv «примечания»', VK.packToCsv(noteFlat), TGP.packToCsv(noteFlat));
cmp('packToCsv', VK.packToCsv(CSV_SRC), TGP.packToCsv(CSV_SRC));
if (VK.packToCsv(CSV_SRC) !== CSV_EXPECT)
    { failed++; console.log('✗ packToCsv:\n' + VK.packToCsv(CSV_SRC).split('\n').map(l => '  ' + JSON.stringify(l)).join('\n')); }

// ===================== 4б. ветвь героя: резка-прививка =====================
// Независимые ожидания: границы односторонних семей и поля всех событий.
const ROUND_CH = 790;
const datelessNotes = '-Отец ^1980 заметка^ещё\n+ ^семья^строка\nМать ^супруга\n--Сын ^ребёнок\n-Якорь\n+^односторонняя';
for (const parser of [VK, TGP]) {
    const parsed = parser.parseTree('\uFEFF\n#not for cut and graft\n' + datelessNotes + ' # cut ^ignored');
    assert.equal(parsed.noGraft, true);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.persons.map(p => [p.rec, p.note, p.nameOnly]), [
        [{ n: 'Отец' }, '1980 заметка^ещё', true],
        [{ n: 'Мать' }, 'супруга', true], [{ n: 'Сын' }, 'ребёнок', true],
        [{ n: 'Якорь' }, '', true],
    ]);
    assert.deepEqual(parsed.weddings.map(w => [w.rec, w.note]), [[{}, 'семья^строка'], [{}, 'односторонняя']]);
    assert.equal(parser.parseTree('#comment\n#not for cut and graft\n-Имя# cut ^note').noGraft, false);
    assert.deepEqual(parser.parseTree('-Имя# cut ^note').persons[0].rec, { n: 'Имя' });
    assert.equal(parser.parseTree('-Имя ^keep# cut^lost').persons[0].note, 'keep');
}
for (const api of [VK, TG]) {
    await api.clearChatTree(ROUND_CH);
    await api.applyTree(ROUND_CH, TGP.parseTree(datelessNotes));
    const expected = '=Мать ^супруга\n+ ^семья^строка\nОтец ^1980 заметка^ещё\n--Сын ^ребёнок\n-Якорь\n+ ^односторонняя';
    assert.equal(await api.chatFlatText(ROUND_CH), expected);
    await api.applyTree(ROUND_CH, TGP.parseTree(expected));
    assert.equal(await api.chatFlatText(ROUND_CH), expected);
    const ged = TGP.parseGedcom(await api.gedcomText(ROUND_CH));
    assert.ok(ged.indis.every(i => i.birt === null));
    assert.equal(ged.indis.find(i => i.name === 'Мать').note, 'супруга');
    assert.ok(ged.fams.every(f => f.marr === null));
    assert.ok(ged.fams.some(f => f.note === 'семья^строка'));
    // A repeated bare spouse is a reference, not a request to erase its note.
    await api.applyTree(ROUND_CH, TGP.parseTree('-Другой\n+\nМать'));
    assert.equal(TGP.parseGedcom(await api.gedcomText(ROUND_CH)).indis.find(i => i.name === 'Мать').note, 'супруга');
}
const ROUND_TXT = '-Иван 1950? (Родина) 2020-02= (Покой)\n+\n+\n==Мария 1980-03-04?\n--Пётр 1982=\n+1970-01? (Венчание) 1990= (Развод) ^семья\n==Анна 1992-04?\n+2000= 2005? (Разъезд)\n==Ева 2001-01-02=';
for (const api of [VK, TG]) {
    const parsed = VK.parseTree(ROUND_TXT);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.weddings.length, 4);
    assert.equal(parsed.persons[1].spouseLine, false);
    assert.equal(parsed.children[0].w, 1);
    assert.equal(parsed.persons[1].sex, 'F');
    await api.clearChatTree(ROUND_CH);
    await api.applyTree(ROUND_CH, parsed);
    const flat = await api.chatFlatText(ROUND_CH);
    assert.equal(flat, ROUND_TXT);
    await api.applyTree(ROUND_CH, VK.parseTree(flat));
    assert.equal(await api.chatFlatText(ROUND_CH), flat, 'повтор не плодит и не сливает семьи');
    const ged = await api.gedcomText(ROUND_CH);
    assert.equal((ged.match(/0 @[^@]+@ FAM/g) || []).length, 4);
    assert.match(ged, /1 DIV\n2 DATE CAL 1990\n2 PLAC Развод/);
    assert.match(ged, /1 DIV\n2 DATE ABT 2005\n2 PLAC Разъезд/);
    const csv = VK.packToCsv(flat);
    assert.match(csv, /1970-01\?\tВенчание\t1990=\tРазвод\tсемья/);
    assert.match(csv, /2000=\t\t2005\?\tРазъезд/);
    await api.clearChatTree(ROUND_CH);
    await api.applyTree(ROUND_CH, VK.parseTree(flat));
    assert.equal(await api.chatFlatText(ROUND_CH), flat, 'чистый round-trip');
    // Неявная семья перед явной не должна переехать в первый +.
    const implicit = '-Отец\n--Первый\n+\n==Вторая';
    await api.clearChatTree(ROUND_CH);
    await api.applyTree(ROUND_CH, VK.parseTree(implicit));
    assert.equal(await api.chatFlatText(ROUND_CH), '-Отец\n+\n--Первый\n+\n==Вторая');
    const mixed = '-Отец 1950-01-01\n+1970 (Свадьба) 1990 (Развод)\nМать 1952-01-01\n==Дочь 1975-01-01\n+1995\n==Другая 1996-01-01\n+1995\n--Сын 1998-01-01';
    await api.clearChatTree(ROUND_CH);
    await api.applyTree(ROUND_CH, VK.parseTree(mixed));
    assert.equal(await api.chatFlatText(ROUND_CH), mixed, 'дети не переезжают в первый полный брак');
    await api.applyTree(ROUND_CH, VK.parseTree(mixed));
    assert.equal(await api.chatFlatText(ROUND_CH), mixed, 'две односторонние свадьбы одной даты');
}
for (const suffix of ['?', '=']) for (const date of ['1950', '1950-02', '1950-02-03']) {
    const token = date + suffix;
    const p = VK.parseTree('-Тест ' + token + ' ' + token + '\n+' + token + ' (Брак) ' + token + ' (Развод)');
    const abt = (suffix === '?' ? 3 : 6) + (date.length === 4 ? 2 : date.length === 7 ? 1 : 0);
    assert.equal(p.persons[0].rec.abt, abt);
    assert.equal(p.persons[0].rec.dabt, abt);
    assert.equal(p.weddings[0].rec.abt, abt);
    assert.equal(p.weddings[0].rec.dabt, abt);
    assert.equal(p.weddings[0].rec.plac2, 'Развод');
}
assert.equal(VK.parseTree('-Иван\n+\n+\n--Мария').persons[1].sex, 'M');
for (const parser of [VK, TGP]) {
    const closed = parser.parseTree('-Иван\n+\n--Ребёнок\nПоздний супруг');
    assert.equal(closed.errors.length, 1);
    assert.equal(closed.errors[0].line, 4);
    assert.equal(closed.persons.length, 2);
    assert.equal(closed.weddings[0].f, null);
    assert.equal(closed.children[0].w, 0);
    const expected = { d: '1973-01-01', abt: 2, dd: '1980-01-01', dabt: 2, plac2: 'Казань' };
    assert.deepEqual(parser.parseTreeLine('+1973 1980 (Казань)').rec, expected);
    const emptyPlace = parser.parseTreeLine('+1973 () 1980 (Казань)').rec;
    delete emptyPlace.plac;
    assert.deepEqual(emptyPlace, expected);
    assert.equal(parser.parseTreeLine('+1980').rec.d, '1980-01-01');
    assert.equal(parser.parseTreeLine('+ ^семья без дат').note, 'семья без дат');
    for (const depth of [1, 2, 4]) for (const suffix of ['', '?', '=', '~', '<', '>'])
        for (const date of ['1980', '1980-02', '1980-02-03']) {
            const prefix = '+'.repeat(depth), token = date + suffix;
            const parsed = parser.parseTreeLine(prefix + ' ' + token + ' (Казань) ^семья^строка');
            const dated = parser.parseTreeLine(prefix + token).rec;
            assert.equal(parsed.depth, depth - 1);
            assert.deepEqual(parsed.rec, { dd: dated.d, ...(dated.abt ? { dabt: dated.abt } : {}), plac2: 'Казань' });
            assert.equal(parsed.note, 'семья^строка');
            const csv = parser.packToCsv(prefix + ' ' + token + ' (Казань) ^семья^строка');
            assert.equal(csv, prefix.split('').join('\t') + '\t\t\t\t' + token + '\tКазань\tсемья^строка');
        }
}
for (const api of [VK, TG]) {
    const txt = '-Отец 1940\n+ 1980 (Казань) ^развод без свадьбы\n--Сын 1960\n++ 2001-02? (Пермь) ^семья сына\nЖена 1962\n===Дочь 1985\n+1973 1980 (Казань)';
    await api.clearChatTree(ROUND_CH);
    const parsed = VK.parseTree(txt);
    assert.deepEqual(parsed.errors, []);
    await api.applyTree(ROUND_CH, parsed);
    assert.equal(await api.chatFlatText(ROUND_CH), txt);
    await api.applyTree(ROUND_CH, parsed);
    assert.equal(await api.chatFlatText(ROUND_CH), txt);
    const ged = await api.gedcomText(ROUND_CH);
    assert.match(ged, /1 DIV\n2 DATE 1980\n2 PLAC Казань\n/);
    assert.match(ged, /1 NOTE развод без свадьбы/);
    await api.clearChatTree(ROUND_CH);
    await api.applyTree(ROUND_CH, VK.parseTree(txt));
    assert.equal(await api.chatFlatText(ROUND_CH), txt);
}

// «-+=» на фокусе — роспись ветви: поддерево потомков на всю глубину, герой
// корневой строкой; вывод обеих копий — дословно (чистая subsetBranch)
const vkBranch = VK.branchFlatText(TREE_CH, 'Фёдор III 1661-06-09');
const tgBranch = await TG.branchFlatText(TREE_CH, 'Фёдор III 1661-06-09');
cmp('branchFlatText «Фёдор III»', vkBranch, tgBranch);
if (!vkBranch || !vkBranch.startsWith('-Фёдор III 1661-06-09 1682-04-27')) {
    failed++;
    console.log('✗ пачка ветви не начинается с корневой строки героя\n  ' + vkBranch);
}
// роспись в ответе на цитату = резка-прививка (cutAndGraft): ветвь цитируемого
// срезана молча, поля героя (в т.ч. имя) обновлены первой строкой росписи,
// новая ветвь прививается; у героя — свои браки с половинами, потомки глубже
const BRANCH_EDIT = `\
-Пётр Фёдорович 1661-06-09 1682-04-27
+1680-07-28
Агафья Анна 1663 1681-07-14 Царица
--Илья 1681-07-11 1681-07-25
++1682-02-15
Марфа Апраксина 1664-06-04`;
cmp('parseTree «ветвь»', VK.parseTree(BRANCH_EDIT), TGP.parseTree(BRANCH_EDIT));
cmp('rootOf «ветвь»', VK.rootOf(VK.parseTree(BRANCH_EDIT)), TG.rootOf(TGP.parseTree(BRANCH_EDIT)));
const vkRep3 = VK.cutAndGraft(TREE_CH, 'Фёдор III 1661-06-09', VK.parseTree(BRANCH_EDIT));
const tgRep3 = await TG.cutAndGraft(TREE_CH, 'Фёдор III 1661-06-09', TGP.parseTree(BRANCH_EDIT));
cmp('cutAndGraft отчёт', vkRep3, tgRep3);
if (vkRep3.cut !== 3 || vkRep3.famsCut !== 2)
    { failed++; console.log('✗ резка не сработала: cut=' + vkRep3.cut + ' famsCut=' + vkRep3.famsCut); }
cmp('cutAndGraft personRows', VK.personRows(TREE_CH), await TG.personRows(TREE_CH));
cmp('cutAndGraft edges', [...VK.linkPairs(TREE_CH)].sort(), (await TG.linksAll(TREE_CH)).map(l => [l.p, l.c]).sort());
cmp('cutAndGraft weddingRows', VK.weddingRows(TREE_CH), await TG.weddingRows(TREE_CH));
cmp('cutAndGraft famList', VK.famList(TREE_CH), await TG.famList(TREE_CH));
cmp('cutAndGraft gedcomText', VK.gedcomText(TREE_CH), await TG.gedcomText(TREE_CH));
cmp('cutAndGraft chatFlatText', VK.chatFlatText(TREE_CH), await TG.chatFlatText(TREE_CH));
// гедком-резерв живёт: срезанные записи доступны старым файлом (сам резерв
// выкладывается транспортом, не логикой)
// якорь не найден — роспись применяется без среза (добавление merge'ем)
const vkRepM = VK.cutAndGraft(TREE_CH, 'Нет-Такого-Человека 1690-01-01', VK.parseTree(TREE1));
const tgRepM = await TG.cutAndGraft(TREE_CH, 'Нет-Такого-Человека 1690-01-01', TGP.parseTree(TREE1));
cmp('cutAndGraft без якоря', vkRepM, tgRepM);

// A spouse's parental families are outside the replaced descendant branch.
for (const api of [VK, TG]) {
    for (const [index, place] of ['Неизвестный город', 'Пермь', 'UTC+14'].entries()) {
        const id = 893900 + index;
        const pack = '-Без времени 1960-01-01 (' + place + ') 2020-01-01 (' + place + ')\n+1980\nСупруга 1962-01-01 (' + place + ')\n--Ребёнок 1985-01-01 (' + place + ')';
        const parsed = TGP.parseTree(pack);
        assert.deepEqual(parsed.errors, []);
        for (const p of parsed.persons) {
            assert.equal(p.rec.h, undefined);
            assert.equal(p.rec.dh, undefined);
            assert.equal(p.rec.srcH, undefined);
        }
        assert.equal(parsed.persons[0].rec.d, '1960-01-01');
        assert.equal(parsed.persons[0].rec.dd, '2020-01-01');
        await api.applyTree(id, parsed);
        for (let i = 0; i < 2; i++) {
            const exported = await api.branchFlatText(id, 'Без времени 1960-01-01');
            assert.doesNotMatch(exported, /\d{2}:\d{2}/);
            await api.cutAndGraft(id, 'Без времени 1960-01-01', TGP.parseTree(exported));
            const people = await api.personRows(id);
            for (const p of people) assert.equal(p.h, undefined);
            const hero = people.find(p => p.n === 'Без времени');
            assert.equal(hero.dh, undefined);
        }
    }
}
const explicitNoon = TGP.parseTree('-Полдень 1960-01-01 12:00 (Пермь) 2020-01-01 12:00 (Пермь)').persons[0].rec;
assert.equal(explicitNoon.srcH, 12);
assert.equal(explicitNoon.dsrcH, 12);
assert.equal(TGP.parseTrigger('Полдень 1960-01-01 (Пермь)').rec.srcH, undefined);
assert.equal(typeof TGP.parseTrigger('Полдень 1960-01-01 (Пермь)').rec.h, 'number');

const SPOUSE_PARENTS = `-КА 1963-09-27
+1988-09-24
ГК 1965-08-01
--СА 1992-06-13 ^123
++2016-08-27
АК 1990-09-19
---АА 2024-03-01 ^456
-ГК 1963-07-14
+1987-08-29
ГЧ 1963-05-14
==АК 1990-09-19`;
for (const [index, [scenario, extra, replacement, cut]] of [
    ['retained', '', '-СА 1992-06-13\n+2016-08-27\nАК 1990-09-19\n--АА 2024-03-01', 1],
    ['omitted', '', '-СА 1992-06-13', 1],
    ['multiple parents', '\n-Другой отец 1960-01-01\n+1986\nДругая мать 1961-01-01\n==АК 1990-09-19', '-СА 1992-06-13', 1],
    ['other marriage', '\n=АК 1990-09-19\n+2010\nДругой супруг 1988-01-01', '-СА 1992-06-13', 1],
    ['branch-only spouse', null, '-СА 1992-06-13', 2],
].entries()) {
    const id = 894000 + index;
    const results = [];
    for (const api of [VK, TG]) {
        const source = (extra === null || scenario === 'other marriage'
            ? SPOUSE_PARENTS.split('\n-ГК 1963-07-14')[0] : SPOUSE_PARENTS) + (extra || '');
        await api.applyTree(id, TGP.parseTree(source));
        const before = TGP.parseGedcom(await api.gedcomText(id));
        const ak = before.indis.find(p => p.name === 'АК').__xref;
        const external = before.fams.filter(f => f.chil.includes(ak) || (f.marr?.date === '2010-01-01'));
        const sa = before.indis.find(p => p.name === 'СА').__xref;
        const saParents = before.fams.find(f => f.chil.includes(sa));
        for (let repeat = 0; repeat < 2; repeat++) {
            const rep = await api.cutAndGraft(id, 'СА 1992-06-13', TGP.parseTree(replacement));
            assert.equal(rep.cut, repeat ? (replacement.includes('АА') ? 1 : 0) : cut, scenario);
            assert.equal(rep.famsCut, repeat && !replacement.includes('АА') ? 0 : 1);
            const after = TGP.parseGedcom(await api.gedcomText(id));
            assert.equal(after.fams.length, before.fams.length - (replacement.includes('АА') ? 0 : 1));
            assert.equal(after.indis.length, before.indis.length - (replacement.includes('АА') ? 0 : cut));
            assert.deepEqual(after.fams.find(f => f.__xref === saParents.__xref), saParents);
            for (const family of external)
                assert.deepEqual(after.fams.find(f => f.__xref === family.__xref), family);
            const partners = after.indis.filter(p => p.name === 'АК');
            assert.equal(partners.length, extra === null ? 0 : 1);
            if (partners.length) assert.equal(partners[0].__xref, ak);
            const edges = api === VK ? VK.linkPairs(id) : (await TG.linksAll(id)).map(l => [l.p, l.c]);
            assert.equal(new Set(edges.map(e => JSON.stringify(e))).size, edges.length);
            for (const family of external.filter(f => f.chil.includes(ak))) {
                for (const parent of [family.husb, family.wife].filter(Boolean)) {
                    const p = before.indis.find(p => p.__xref === parent);
                    assert.ok(edges.some(([a, b]) => a === p.name + ' ' + p.birt.date && b === 'АК 1990-09-19'));
                }
            }
            assert.equal(after.indis.some(p => p.name === 'АА'), replacement.includes('АА'));
            assert.equal(after.fams.some(f => f.marr?.date === '2016-08-27'), replacement.includes('АА'));
            assert.equal(edges.some(([a, b]) => a === 'АК 1990-09-19' && b === 'АА 2024-03-01'), replacement.includes('АА'));
        }
        results.push({ ged: await api.gedcomText(id), flat: await api.chatFlatText(id) });
    }
    cmp('cutAndGraft spouse external families ' + scenario, results[0], results[1]);
}

// ===================== 4в. точечная правка триггера =====================
// одна строка без маркера в ответе на триггер — ПОЛНАЯ замена записи:
// пол цел, ветвь и связи не трогаются, ключи связей переименовываются
// (Фёдор III после «без якоря» уже есть из TREE1 — берём имя без коллизии)
const EDIT_HERO = 'Пётр Фёдорович 1661-06-09';
const EDIT1 = { n: 'Фёдор Алексеевич', d: '1661-06-09', h: 1, m: 30, note: 'Царь' };
cmp('editTrigger отчёт',
    VK.editTrigger(TREE_CH, EDIT_HERO, { ...EDIT1 }),
    await TG.editTrigger(TREE_CH, EDIT_HERO, { ...EDIT1 }));
cmp('editTrigger personRows', VK.personRows(TREE_CH), await TG.personRows(TREE_CH));
cmp('editTrigger edges', [...VK.linkPairs(TREE_CH)].sort(),
    (await TG.linksAll(TREE_CH)).map(l => [l.p, l.c]).sort());
cmp('editTrigger chatFlatText', VK.chatFlatText(TREE_CH), await TG.chatFlatText(TREE_CH));
cmp('editTrigger gedcomText', VK.gedcomText(TREE_CH), await TG.gedcomText(TREE_CH));
const hero1 = VK.personRows(TREE_CH).find(r => r.n === 'Фёдор Алексеевич' && r.d === '1661-06-09');
if (!hero1 || hero1.sex !== 'M')
    { failed++; console.log('✗ editTrigger: пол не сохранён\n  ' + JSON.stringify(hero1)); }
if (!VK.linkPairs(TREE_CH).some(([p]) => p === 'Фёдор Алексеевич 1661-06-09'))
    { failed++; console.log('✗ editTrigger: связь не перевешена на новый ключ'); }
// полная замена: не заданные в строке поля (время, примечание) стираются
cmp('editTrigger полная замена отчёт',
    VK.editTrigger(TREE_CH, 'Фёдор Алексеевич 1661-06-09', { n: 'Фёдор Алексеевич', d: '1661-06-09' }),
    await TG.editTrigger(TREE_CH, 'Фёдор Алексеевич 1661-06-09', { n: 'Фёдор Алексеевич', d: '1661-06-09' }));
cmp('editTrigger полная замена personRows', VK.personRows(TREE_CH), await TG.personRows(TREE_CH));
const hero2 = VK.personRows(TREE_CH).find(r => r.n === 'Фёдор Алексеевич' && r.d === '1661-06-09');
if (!hero2 || hero2.h !== undefined || hero2.note !== undefined || hero2.sex !== 'M')
    { failed++; console.log('✗ editTrigger: полная замена не стёрла время/примечание\n  ' + JSON.stringify(hero2)); }
// коллизия: правка на существующее имя+дату — суффикс «~xref» правимой
// персоны (не отказ), дата применяется, ключи связей переименовываются
const vkColl = VK.editTrigger(TREE_CH, 'Фёдор Алексеевич 1661-06-09', { n: 'Агафья Анна', d: '1663-01-01' });
const tgColl = await TG.editTrigger(TREE_CH, 'Фёдор Алексеевич 1661-06-09', { n: 'Агафья Анна', d: '1663-01-01' });
cmp('editTrigger коллизия', vkColl, tgColl);
cmp('editTrigger коллизия personRows', VK.personRows(TREE_CH), await TG.personRows(TREE_CH));
if (!vkColl || !vkColl.rec || !/^Агафья Анна ~\S+$/.test(vkColl.rec.n) || vkColl.rec.d !== '1663-01-01')
    { failed++; console.log('✗ editTrigger: коллизия не разрулена суффиксом ~\n  ' + JSON.stringify(vkColl)); }
if (!VK.personRows(TREE_CH).some(r => r.n === 'Агафья Анна' && r.d === '1663-01-01'))
    { failed++; console.log('✗ editTrigger: прежняя Агафья Анна потерялась'); }
// якорь не найден — null (правки нет, транспорт ведёт как обычный ввод)
cmp('editTrigger мимо якоря',
    VK.editTrigger(TREE_CH, 'Нет-Такого 1690-01-01', { n: 'Имя', d: '1690-01-01' }),
    await TG.editTrigger(TREE_CH, 'Нет-Такого 1690-01-01', { n: 'Имя', d: '1690-01-01' }));

// сводка росписи — общий формат ответа (обе копии)
cmp('treeReport пачка', VK.treeReport(Object.assign(vkRep3, { errors: [{ line: 2, msg: 'свадьба без подходящей пары' }] })),
    TG.treeReport(Object.assign({}, tgRep3, { errors: [{ line: 2, msg: 'свадьба без подходящей пары' }] })));
// stripHtml — снятие разметки для .txt-хвоста (только ТГ; ВК присылает без HTML)
cmp('stripHtml', TG.stripHtml('<b>Иван</b> &lt;гр&gt; 20&nbsp;июня'), 'Иван <гр> 20 июня');

// ==================== 5а. flatSearch: поиск по росписи ====================
const FLAT = [
    '-Антон Ульрих 1714-08-17 герцог',
    '-----Иван VI Антонович 1740-08-12 Император',
    '=====Екатерина Антоновна 1741-07-26',
    '=Мария 1970',
    '++1995-06-06 (Пермь)',
    'Иван Петрович', // безмарковая — вторая половина «+»-свадьбы
    '--Иван 1996-01-01',
    '==Мария 1998-02-02',
    '-Пётр 2000-03-03',
    '++2001-01-01 примечание',
].join('\n');
for (const q of ['/Иван', '/иван', '/Иван Петрович', '/-Пётр', '/--Иван', '/=Мария',
    '/==Мария', '/ Петрович', '/ пермь', '/ 1996', '/-', '/', '/ нет-такого',
    '/--', '/===', '/++', '/+++', '/- ', '/== '])
    cmp('flatSearch ' + JSON.stringify(q), VK.flatSearch(FLAT, q), TG.flatSearch(FLAT, q));
const fsExp = (q, want, what) => {
    const got = VK.flatSearch(FLAT, q).join('\n');
    if (got !== want) { failed++; console.log('✗ flatSearch ' + what + ' ' + JSON.stringify(q) + '\n  ждём: ' + JSON.stringify(want) + '\n  вышло: ' + JSON.stringify(got)); }
};
fsExp('/Иван', '-----Иван VI Антонович 1740-08-12 Император\nИван Петрович\n--Иван 1996-01-01', 'префикс любой глубины');
fsExp('/иван', '-----Иван VI Антонович 1740-08-12 Император\nИван Петрович\n--Иван 1996-01-01', 'префикс без регистра');
fsExp('/Антон', '-Антон Ульрих 1714-08-17 герцог', 'префикс: Антоновичи не матчатся');
fsExp('/ Антон', '-Антон Ульрих 1714-08-17 герцог\n-----Иван VI Антонович 1740-08-12 Император\n=====Екатерина Антоновна 1741-07-26', 'подстрока: Антоновичи матчатся');
fsExp('/-Пётр', '-Пётр 2000-03-03', 'мужчины глубины 0');
fsExp('/--Иван', '--Иван 1996-01-01', 'мужчины глубины 1');
fsExp('/=Мария', '=Мария 1970', 'женщины глубины 0');
fsExp('/==Мария', '==Мария 1998-02-02', 'женщины глубины 1');
fsExp('/ Петрович', 'Иван Петрович', 'подстрока');
fsExp('/ пермь', '++1995-06-06 (Пермь)', 'подстрока в свадьбе');
fsExp('/-', '-Антон Ульрих 1714-08-17 герцог\n-Пётр 2000-03-03', 'все мужчины глубины 0');
fsExp('/--', '--Иван 1996-01-01', 'все мужчины глубины 1');
fsExp('/==', '==Мария 1998-02-02', 'все женщины глубины 1');
fsExp('/===', '', 'женщины глубины 2 — пусто');
fsExp('/++', '++1995-06-06 (Пермь)\n++2001-01-01 примечание', 'все свадьбы глубины 1');
fsExp('/- ', '-Антон Ульрих 1714-08-17 герцог\n-Пётр 2000-03-03', 'маркер + пробел — все мужчины глубины 0');

// ==================== 5б. flatHit*: единственное попадание → фокус ====================
for (const line of FLAT.split('\n').concat([
    '', '+Антон Ульрих', '(Пермь)', '12:30', '^заметка',
    '======Maria 1999-12-31', 'Мария 1970-05-06~', 'Иван 21:30 (Сочи)',
]))
    cmp('flatHitPerson ' + JSON.stringify(line), VK.flatHitPerson(line), TG.flatHitPerson(line));

const HIT_ROWS = [
    { n: 'Антон Ульрих', d: '1714-08-17' },
    { n: 'Мария', d: '1970-05-06', abt: 15 },          // печатается «1970-05-06~»
    { n: 'Иван Петрович', d: '1880-01-01' },
    { n: 'Мария', d: '1930-01-01' },                   // тёзка Марии
];
// ключи для фокус-панели (VK.flatHitKey / TG.flatHitKey) — сравнение
cmp('flatHitKey Антон', VK.flatHitKey('-Антон Ульрих 1714-08-17 герцог', HIT_ROWS), TG.flatHitKey('-Антон Ульрих 1714-08-17 герцог', HIT_ROWS));
cmp('flatHitKey приблизительная', VK.flatHitKey('=Мария 1970-05-06~', HIT_ROWS), TG.flatHitKey('=Мария 1970-05-06~', HIT_ROWS));
cmp('flatHitKey тёзки одна дата', VK.flatHitKey('=Мария 1930-01-01', HIT_ROWS), TG.flatHitKey('=Мария 1930-01-01', HIT_ROWS));
cmp('flatHitKey тёзки без даты в строке', VK.flatHitKey('Мария', HIT_ROWS), TG.flatHitKey('Мария', HIT_ROWS));
cmp('flatHitKey имя-заглушка', VK.flatHitKey('Иван Петрович', HIT_ROWS), TG.flatHitKey('Иван Петрович', HIT_ROWS));
cmp('flatHitKey свадьба', VK.flatHitKey('++1995-06-06 (Пермь)', HIT_ROWS), TG.flatHitKey('++1995-06-06 (Пермь)', HIT_ROWS));
cmp('flatHitKey пустая', VK.flatHitKey('', HIT_ROWS), TG.flatHitKey('', HIT_ROWS));
cmp('flatHitKey нет имени', VK.flatHitKey('-Иван 1996-01-01', HIT_ROWS), TG.flatHitKey('-Иван 1996-01-01', HIT_ROWS));
cmp('flatHitKey дата мимо', VK.flatHitKey('=Мария 1971', HIT_ROWS), TG.flatHitKey('=Мария 1971', HIT_ROWS));

// ==================== 6. jubileeText: шапка с датой смерти/развода ====================
const { jubileeText: tgJubilee } = await import(path.join(ROOT, 'tgcloud', 'lib', 'text.js'));
const JUBILEE_RECS = [
    { n: 'Иван', d: '1963-09-27', h: 12, m: 30 },
    { n: 'Иван', d: '1963-09-27', dd: '2001-05-01' },
    { n: 'Пётр', d: '1985-07-07', h: 23, m: 45, dd: '2020-02-03' },
    { n: 'Иван+Мария', d: '1983-06-04' },
    { n: 'Иван+Мария', d: '1983-06-04', dd: '1990-01-01' },
];
for (const r of JUBILEE_RECS)
    cmp('jubileeText ' + JSON.stringify(r),
        VK.jubileeText(r, 'note'),
        tgJubilee(r, 'note').replace(/<\/?tg-spoiler>/g, '')); // будущие года: в ТГ под спойлером
// формат: голова пары с разводом — оба возраста и без названия годовщины;
// голова живой персоны — прежнего вида
const divHead = VK.jubileeText({ n: 'Иван+Мария', d: '1983-06-04', dd: '1990-01-01' }, '').split('\n')[0];
if (!/^Иван\+Мария 1983-06-04 1990-01-01 \d+ \d+$/.test(divHead) || /ситцевая|серебряная|золотая/.test(divHead))
    { failed++; console.log('✗ голова развод-пары без типа годовщины\n  ' + divHead); }
const livingHead = VK.jubileeText(JUBILEE_RECS[0], '').split('\n')[0];
if (!/^Иван 1963-09-27 12:30 \d+$/.test(livingHead))
    { failed++; console.log('✗ голова живой персоны прежнего вида\n  ' + livingHead); }

// ==================== 4а. старый стиль (даты ≤ 1918-01-31) ====================
// Хранение и экспорт — старым стилем (реэкспорт не пересдвигает), оповещения —
// по новому: голова юбилея и 🔔 печатают сдвинутую дату (с суффиксом
// приблизительных — через approxOut); неполные (год-only) не сдвигаются.
const OS_CH = 148;
if (VK.newStyleDate('1663-07-14') !== '1663-07-24') { failed++; console.log('✗ newStyleDate 1663: ' + VK.newStyleDate('1663-07-14')); }
if (VK.newStyleDate('1899-12-31') !== '1900-01-12') { failed++; console.log('✗ newStyleDate 1899 (смена года): ' + VK.newStyleDate('1899-12-31')); }
if (VK.newStyleDate('1918-01-31') !== '1918-02-13') { failed++; console.log('✗ newStyleDate 1918-01-31: ' + VK.newStyleDate('1918-01-31')); }
if (VK.newStyleDate('1918-02-01') !== '1918-02-01' || VK.newStyleDate('') !== '')
    { failed++; console.log('✗ newStyleDate новый стиль/пустая: ' + VK.newStyleDate('1918-02-01') + ' / ' + VK.newStyleDate('')); }
// обратная конверсия (показанный новый стиль → хранимый старый)
for (const [iso, want] of [['1624-04-11', '1624-04-01'], ['1918-02-13', '1918-01-31'], ['1918-02-14', '1918-02-14'], ['', '']])
    if (VK.oldStyleDate(iso) !== want || TGOS.oldStyleDate(iso) !== want)
        { failed++; console.log('✗ oldStyleDate ' + JSON.stringify(iso) + ': ' + VK.oldStyleDate(iso) + ' / ' + TGOS.oldStyleDate(iso) + ', ждали ' + JSON.stringify(want)); }
const OS_RECS = [
    { n: 'Агафья', d: '1663-07-14', dd: '1681-07-14' }, // сдвиг +10 дней (XVII век)
    { n: 'Фёдор', d: '1899-12-31' },                    // сдвиг +12, смена года (XIX век)
    { n: 'Столетний', d: '1234-01-01', abt: 17 },       // год-only приблизительная — без сдвига
    { n: 'Совет', d: '1918-02-01' },                    // уже новый стиль — без сдвига
];
for (const r of OS_RECS)
    cmp('newStyle jubilee ' + r.n, VK.jubileeText(r, ''),
        tgJubilee(r, '').replace(/<\/?tg-spoiler>/g, '')); // будущие года: в ТГ под спойлером
const osWanted = ['Агафья 1663_07_24 1681_07_24', 'Фёдор 1900_01_12', 'Столетний 1234~', 'Совет 1918-02-01'];
const osHeads = OS_RECS.map(r => VK.jubileeText(r, '').split('\n')[0].split(/\s\d+\s/)[0]);
for (let i = 0; i < osWanted.length; i++)
    if (!osHeads[i].startsWith(osWanted[i]))
        { failed++; console.log('✗ голова юбилея/новый стиль: ждали «' + osWanted[i] + '», было «' + osHeads[i] + '»'); }
for (const r of OS_RECS) {
    VK.upsertPerson(OS_CH, r);
    await TG.upsertPerson(OS_CH, r);
}
cmp('newStyle bell полный', VK.upcomingEvents(OS_CH, true), await TG.upcomingText(OS_CH, true));
cmp('newStyle bell круговой', VK.upcomingEvents(OS_CH, false, '07-01'), await TG.upcomingText(OS_CH, false, '07-01'));
const osBell = VK.upcomingEvents(OS_CH, true);
for (const s of ['Агафья 1663-07-24 1681-07-24', 'Фёдор 1900-01-12', 'Столетний 1234~', 'Совет 1918-02-01'])
    if (!osBell.includes(s))
        { failed++; console.log('✗ bell/новый стиль: нет «' + s + '»\n  ' + osBell); }
// ⚠️ примерные по-прежнему скрыты из 🔔-веток (список оповещений)
const osBellMinus = VK.upcomingEvents(OS_CH, false);
if (osBellMinus.includes('Столетний') || !osBellMinus.includes('Агафья'))
    { failed++; console.log('✗ bell: фильтр примерных сломан\n  ' + osBellMinus); }
// реэкспорт даты-хранения дословно (старый стиль, без повторного сдвига)
cmp('newStyle экспорт гедком', VK.gedcomText(OS_CH), await TG.gedcomText(OS_CH));
cmp('newStyle экспорт пачка', VK.chatFlatText(OS_CH), await TG.chatFlatText(OS_CH));
const osGed = VK.gedcomText(OS_CH);
if (!osGed.includes('14 JUL 1663') || osGed.includes('24 JUL 1663'))
    { failed++; console.log('✗ экспорт/старый стиль: гедком пересдвинут\n  ' + osGed.split('\n').filter(l => l.includes('DATE')).join(' | ')); }
const osPack = VK.chatFlatText(OS_CH);
if (!osPack.includes('1663-07-14') || osPack.includes('1663-07-24'))
    { failed++; console.log('✗ экспорт/старый стиль: пачка пересдвинута\n  ' + osPack); }
// показанный ключ (новый стиль/суффикс, `_`-маркер нового стиля) резолвится
// обратно в хранимую запись; ключ берётся тем же reply-regex'ом, что у
// обработчиков (усечён до первой даты), `_` сохраняется до общего fallback
const osKey = t => t.match(/^(?:\d\s+)?(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/).slice(1).join(" ");
const normOf = r => r ? { n: r.n, d: r.d, dd: r.dd, abt: r.abt } : null;
cmp('recordShownOf точный', normOf(VK.recordShownOf(OS_CH, 'Агафья 1663-07-14')), normOf(await TG.recordShownOf(OS_CH, 'Агафья 1663-07-14')));
cmp('recordShownOf показ', normOf(VK.recordShownOf(OS_CH, osKey('Агафья 1663-07-24 1681-07-24'))), { n: 'Агафья', d: '1663-07-14', dd: '1681-07-14' });
cmp('recordShownOf `_`-шапка', normOf(VK.recordShownOf(OS_CH, osKey('Агафья 1663_07_24 1681_07_24'))), { n: 'Агафья', d: '1663-07-14', dd: '1681-07-14' });
cmp('recordShownOf суффикс', normOf(VK.recordShownOf(OS_CH, osKey('Столетний 1234~'))), { n: 'Столетний', d: '1234-01-01', abt: 17 });
cmp('recordShownOf мимо', VK.recordShownOf(OS_CH, osKey('Чужой 1663-07-24')), normOf(await TG.recordShownOf(OS_CH, osKey('Чужой 1663-07-24'))));
for (const key of ['Агафья 1663-07-14', 'Агафья 1663_07_24', 'Столетний 1234~', 'Чужой 1663-07-24', 'Агафья 1663-07-24>'])
    cmp('A3 recordShownOf адаптеры ' + key, normOf(VK.recordShownOf(OS_CH, key)), normOf(await TG.recordShownOf(OS_CH, key)));
const SHOWN_CH = 149;
for (const r of [{ n: 'Тёзка', d: '1900-01-01' }, { n: 'Тёзка', d: '1900-01-13' }]) {
    VK.upsertPerson(SHOWN_CH, r);
    await TG.upsertPerson(SHOWN_CH, r);
}
for (const [key, d] of [['Тёзка 1900-01-13', '1900-01-13'], ['Тёзка 1900_01_13', '1900-01-01']]) {
    const expected = { n: 'Тёзка', d };
    cmp('A3 recordShownOf ВК приоритет ' + key, normOf(VK.recordShownOf(SHOWN_CH, key)), expected);
    cmp('A3 recordShownOf ТГ приоритет ' + key, normOf(await TG.recordShownOf(SHOWN_CH, key)), expected);
}
const WED_SHOWN_CH = 150;
const shownWeddings = ['0 HEAD', '0 @I1@ INDI', '1 NAME Альфа', '1 SEX M', '1 BIRT', '2 DATE 1 JAN 1870',
    '0 @I2@ INDI', '1 NAME Бета', '1 SEX F', '1 BIRT', '2 DATE 1 JAN 1872',
    '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 MARR', '2 DATE 1 JAN 1900',
    '0 @F2@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 MARR', '2 DATE 13 JAN 1900', '0 TRLR'].join('\n');
VK.importGedcom(WED_SHOWN_CH, VK.parseGedcom(shownWeddings));
await TG.importGedcom(WED_SHOWN_CH, TGP.parseGedcom(shownWeddings));
for (const [key, d] of [['Альфа+Бета 1900-01-13', '1900-01-13'],
    ['Альфа+Бета 1900_01_13', '1900-01-01'], ['Альфа+Бета 1900.01.13', '1900-01-01']]) {
    for (const [platform, rec] of [['VK', VK.recordShownOf(WED_SHOWN_CH, key)],
        ['TG', await TG.recordShownOf(WED_SHOWN_CH, key)]])
        cmp('wedding exact/displayed ' + platform + ' ' + key, rec && { n: rec.n, d: rec.d }, { n: 'Альфа+Бета', d });
}
for (const abt of [12, 13, 14]) {
    const r = { n: 'После' + abt, d: '2000-02-03', abt };
    VK.upsertPerson(SHOWN_CH, r);
    await TG.upsertPerson(SHOWN_CH, r);
    for (const sep of ['-', '_', '.']) {
        const key = r.n + ' ' + ['2000-02-03>', '2000-02>', '2000>'][abt - 12].replaceAll('-', sep);
        for (const [platform, rec] of [['VK', VK.recordShownOf(SHOWN_CH, key)], ['TG', await TG.recordShownOf(SHOWN_CH, key)]])
            cmp('AFT adapter ' + platform + ' ' + key, rec && { n: rec.n, d: rec.d, abt: rec.abt }, r);
    }
}
for (const mabt of [12, 13, 14]) {
    const n = 'ПослеМуж' + mabt + '+ПослеЖена' + mabt;
    VK.upsertPerson(SHOWN_CH, { n, d: '2000-02-03', abt: mabt });
    await TG.upsertPerson(SHOWN_CH, { n, d: '2000-02-03', abt: mabt });
    const key = n + ' ' + ['2000.02.03>', '2000.02>', '2000>'][mabt - 12];
    for (const [platform, rec] of [['VK', VK.recordShownOf(SHOWN_CH, key)], ['TG', await TG.recordShownOf(SHOWN_CH, key)]])
        cmp('AFT wedding adapter ' + platform + ' ' + key, rec && { n: rec.n, d: rec.d, mabt: rec.mabt }, { n, d: '2000-02-03', mabt });
}
// скопипащенная шапка как триггер: `_`-даты конвертируются в хранимые —
// та же запись (дубля нет), dd и свадьба — по тому же правилу
{
    const before = [VK.personRows(OS_CH).length, (await TG.personRows(OS_CH)).length];
    VK.upsertPerson(OS_CH, VK.parseTrigger('Агафья 1663_07_24 1681_07_24').rec);
    await TG.upsertPerson(OS_CH, TGP.parseTrigger('Агафья 1663_07_24 1681_07_24').rec);
    const after = [VK.personRows(OS_CH).length, (await TG.personRows(OS_CH)).length];
    if (before[0] !== after[0] || before[1] !== after[1])
        { failed++; console.log('✗ `_`-шапка как триггер создала дубль: ' + before + ' → ' + after); }
    const vkA = VK.recordShownOf(OS_CH, 'Агафья 1663_07_24'), tgA = await TG.recordShownOf(OS_CH, 'Агафья 1663_07_24');
    cmp('`_`-триггер та же запись', normOf(vkA), normOf(tgA));
    if (!vkA || vkA.dd !== '1681-07-14')
        { failed++; console.log('✗ `_`-триггер: dd не сохранился (сдвиг стиля?) ' + JSON.stringify(vkA)); }
    const vkW = VK.parseTrigger('Муж+Жена 1655_01_11').rec, tgW = TGP.parseTrigger('Муж+Жена 1655_01_11').rec;
    cmp('`_`-свадьба', vkW, tgW);
    if (vkW.d !== '1655-01-01') { failed++; console.log('✗ `_`-свадьба: дата не переведена в старый стиль: ' + vkW.d); }
}

// ==================== 5. фокус-радиус родни ====================
// дерево: дед+бабка → (отец, тётя), отец+мать → (сын, дочь), тётя → двоюродный
const FOCUS_CH = 3;
const focusPersons = [
    { n: 'Дед', d: '1930-01-01' }, { n: 'Бабка', d: '1932-02-02' },
    { n: 'Отец', d: '1955-03-03' }, { n: 'Тётя', d: '1957-04-04' }, { n: 'Мать', d: '1956-05-05' },
    { n: 'Сын', d: '1980-06-06' }, { n: 'Дочь', d: '1982-07-07' }, { n: 'Двоюродный', d: '1984-08-08' },
    { n: 'Чужой', d: '1990-09-09' },
];
const fkeys = p => p.n + ' ' + p.d;
VK.clearChatTree(FOCUS_CH);
for (const p of focusPersons) { VK.upsertPerson(FOCUS_CH, p); await TG.upsertPerson(FOCUS_CH, p); }
const focusPairs = [
    ['Дед 1930-01-01', 'Отец 1955-03-03'], ['Бабка 1932-02-02', 'Отец 1955-03-03'],
    ['Дед 1930-01-01', 'Тётя 1957-04-04'], ['Бабка 1932-02-02', 'Тётя 1957-04-04'],
    ['Отец 1955-03-03', 'Сын 1980-06-06'], ['Мать 1956-05-05', 'Сын 1980-06-06'],
    ['Отец 1955-03-03', 'Дочь 1982-07-07'], ['Мать 1956-05-05', 'Дочь 1982-07-07'],
    ['Тётя 1957-04-04', 'Двоюродный 1984-08-08'],
    ['Чужой 1990-09-09', 'Сын 1980-06-06'], // чужой родитель — тоже предки
];
for (const [p, c] of focusPairs) { VK.addLink(FOCUS_CH, p, c, 'c'); await TG.addLink(FOCUS_CH, p, c, 'c'); }
VK.upsertPerson(FOCUS_CH, { n: 'Отец+Мать', d: '1979-01-01' });
await TG.upsertPerson(FOCUS_CH, { n: 'Отец+Мать', d: '1979-01-01' });
VK.upsertPerson(FOCUS_CH, { n: 'Дед+Чужая', d: '1954-01-01' });
await TG.upsertPerson(FOCUS_CH, { n: 'Дед+Чужая', d: '1954-01-01' });
// повторный триггер свадьбы правит дату (пара — якорь, не дата):
// «Отец+Мать 1979-01-01» → «Отец+Мать 1985-05-05 (Курск)»
VK.upsertPerson(FOCUS_CH, { n: 'Отец+Мать', d: '1985-05-05', plac: 'Курск' });
await TG.upsertPerson(FOCUS_CH, { n: 'Отец+Мать', d: '1985-05-05', plac: 'Курск' });
const vkWed = VK.weddingRows(FOCUS_CH).find(r => r.n === 'Отец+Мать');
cmp('upsertWedding правка даты', vkWed, (await TG.weddingRows(FOCUS_CH)).find(r => r.n === 'Отец+Мать'));
if (!vkWed || vkWed.d !== '1985-05-05' || vkWed.plac !== 'Курск')
    { failed++; console.log('✗ повторный триггер свадьбы не правит дату\n  ' + JSON.stringify(vkWed)); }
// якорь-свадьба — не персона: точечной правки нет (null у обеих копий)
cmp('editTrigger якорь-свадьба',
    VK.editTrigger(FOCUS_CH, 'Отец+Мать 1985-05-05', { n: 'Отец', d: '1955-03-03' }),
    await TG.editTrigger(FOCUS_CH, 'Отец+Мать 1985-05-05', { n: 'Отец', d: '1955-03-03' }));
if (VK.editTrigger(FOCUS_CH, 'Отец+Мать 1985-05-05', { n: 'Отец', d: '1955-03-03' }) !== null)
    { failed++; console.log('✗ editTrigger: якорь-свадьба не null'); }
const son = 'Сын 1980-06-06';
for (const r of [1, 2, 3, 5]) {
    const vkK = VK.focusKeys(focusPairs, son, r);
    const tgK = TG.focusKeys(focusPairs, son, r);
    cmp('focusKeys радиус ' + r, vkK, tgK);
    cmp('gedcomText фокус радиус ' + r, VK.gedcomText(FOCUS_CH, vkK), await TG.gedcomText(FOCUS_CH, tgK));
}
// фрагмент-гедком не рвёт родственные связи: в .ged радиуса есть CHIL/FAMC
// (регресс: chd обнулялся до фильтра по keys — дети терялись всегда)
const fragGed = VK.gedcomText(FOCUS_CH, VK.focusKeys(focusPairs, son, 2));
if (!fragGed.includes('1 CHIL @') || !fragGed.includes('1 FAMC @') || !fragGed.includes('1 FAMS @'))
    { failed++; console.log('✗ фрагмент .ged без CHIL/FAMC/FAMS:\n  ' + fragGed.split('\n').filter(l => /^0 @|1 (CHIL|FAMC|FAMS)/.test(l)).join('\n  ')); }
// радиус 1 у Сына: предки (Отец, Мать, Чужой) + их потомки (Сын, Дочь)
cmp('focusKeys r1 состав', [...VK.focusKeys(focusPairs, son, 1)].sort(),
    ['Сын 1980-06-06', 'Дочь 1982-07-07', 'Отец 1955-03-03', 'Мать 1956-05-05', 'Чужой 1990-09-09'].sort());
// радиус 2: + деды и тётя; кузен (u2d2) требует 3 слова цепочки
cmp('focusKeys r2 состав', [...VK.focusKeys(focusPairs, son, 2)].sort(),
    [...new Set(focusPairs.flat())].filter(k => k !== 'Двоюродный 1984-08-08').sort());
cmp('focusHasPair оба в множестве', VK.focusHasPair('Отец+Мать', VK.focusKeys(focusPairs, son, 1)),
    TG.focusHasPair('Отец+Мать', TG.focusKeys(focusPairs, son, 1)));
cmp('focusHasPair один вне', VK.focusHasPair('Дед+Чужая', VK.focusKeys(focusPairs, son, 2)),
    TG.focusHasPair('Дед+Чужая', TG.focusKeys(focusPairs, son, 2)));// супруги: у Тёти появляется муж из семьи, половина которой в множестве
const r1tet = VK.focusKeys(focusPairs, 'Тётя 1957-04-04', 1); // {Тётя, Дед, Бабка, Двоюродный}
const spPairs = [['Дед 1930-01-01', 'Бабка 1932-02-02'], ['Тётя 1957-04-04', 'Тесть 1931-12-12']];
cmp('focusWithSpouses', VK.focusWithSpouses(r1tet, spPairs), TG.focusWithSpouses(r1tet, spPairs));
cmp('gedcomText фокус+супруги',
    VK.gedcomText(FOCUS_CH, VK.focusWithSpouses(r1tet, spPairs)),
    await TG.gedcomText(FOCUS_CH, TG.focusWithSpouses(r1tet, spPairs)));
cmp('focusHead подписи радиусов',
    [1, 2, 3, 4, 5].map(r => VK.focusHead('Имя 2000-01-01', r)),
    [1, 2, 3, 4, 5].map(r => TG.focusHead('Имя 2000-01-01', r)));
cmp('focusHead с датой смерти',
    [1, 3, 5].map(r => VK.focusHead('Пётр 1930-01-01', r, '2001-02-03')),
    [1, 3, 5].map(r => TG.focusHead('Пётр 1930-01-01', r, '2001-02-03')));
if (VK.focusHead('Имя 2000-01-01', 2) !== '2 Имя 2000-01-01')
    { failed++; console.log('✗ focusHead: префикс кейкапа\n  ' + VK.focusHead('Имя 2000-01-01', 2)); }
// кусковой regex «/»-ответа снимает цифру радиуса с заголовка фокуса;
// `_`-маркер нового стиля в дате шапки тоже распознаётся
const RH_RE = /^(?:\d\s+)?(.+?)\s+(\d{4}[-._]\d{2}[-._]\d{2})/;
if ('2 Константин Абакумов 1963-09-27 2001-03-03'.match(RH_RE)?.slice(1).map(s => s.replace(/_/g, "-")).join(' ')
    !== 'Константин Абакумов 1963-09-27')
    { failed++; console.log('✗ regex reply-заголовка'); }
if ('Агафья 1663_07_24'.match(RH_RE)?.slice(1).map(s => s.replace(/_/g, "-")).join(' ')
    !== 'Агафья 1663-07-24')
    { failed++; console.log('✗ regex reply-заголовка (`_`)'); }

// ==================== 7. kinLabel: ярлыки родства ====================
const TGK = await import(path.join(ROOT, 'tgcloud', 'lib', 'kinship.cjs'));
const kinPersons = [
    ['Дед', '1930-01-01', 'M'], ['Бабка', '1932-02-02', 'F'],
    ['Отец', '1955-03-03', 'M'], ['Тётя', '1957-04-04', 'F'], ['Мать', '1956-05-05', 'F'],
    ['Сын', '1980-06-06', 'M'], ['Дочь', '1982-07-07', 'F'], ['Двоюродный', '1984-08-08', 'M'],
    ['Тесть', '1931-12-12', 'M'], ['Чужая', '1991-10-10', 'F'], ['Сноха', '1981-03-03', 'F'],
    ['Отец Снохи', '1952-02-02', 'M'],
    ['Прадед', '1900-01-01', 'M'],
    ['Дядька', '1928-07-07', 'M'], ['Тётка', '1929-08-08', 'F'], // сын/дочь Прадеда — брат/сестра Деда
    ['Прапрадед', '1870-01-01', 'M'], ['Брат Прадеда', '1898-09-09', 'M'],
    ['Жена Дядьки', '1927-05-05', 'F'],
    ['Кузина', '1956-06-06', 'F'], ['Троюродный', '1958-09-09', 'M'], // дочь/внук Брата Прадеда
    ['Муж Кузины', '1955-11-11', 'M'],
    ['Племянник', '2003-03-03', 'M'], ['Внучатый', '2005-04-04', 'M'], // потомки Дочи
    ['Правнучатый', '2007-07-07', 'M'],
    ['ДвПлем', '2006-05-05', 'M'], ['ДвВнуч', '2007-06-06', 'M'], // потомки Двоюродного
];
const kinKeys = Object.fromEntries(kinPersons.map(p => [p[0], p[0] + ' ' + p[1]]));
const kinSex = Object.fromEntries(kinPersons.map(p => [p[0] + ' ' + p[1], p[2]]));
const kinPairs = [
    ['Прапрадед 1870-01-01', 'Прадед 1900-01-01'],
    ['Прапрадед 1870-01-01', 'Брат Прадеда 1898-09-09'],
    ['Прадед 1900-01-01', 'Дед 1930-01-01'],
    ['Прадед 1900-01-01', 'Дядька 1928-07-07'],
    ['Прадед 1900-01-01', 'Тётка 1929-08-08'],
    ['Брат Прадеда 1898-09-09', 'Кузина 1956-06-06'],
    ['Кузина 1956-06-06', 'Троюродный 1958-09-09'],
    ['Дочь 1982-07-07', 'Племянник 2003-03-03'],
    ['Племянник 2003-03-03', 'Внучатый 2005-04-04'],
    ['Внучатый 2005-04-04', 'Правнучатый 2007-07-07'],
    ['Двоюродный 1984-08-08', 'ДвПлем 2006-05-05'],
    ['ДвПлем 2006-05-05', 'ДвВнуч 2007-06-06'],
    ['Дед 1930-01-01', 'Отец 1955-03-03'], ['Бабка 1932-02-02', 'Отец 1955-03-03'],
    ['Дед 1930-01-01', 'Тётя 1957-04-04'], ['Бабка 1932-02-02', 'Тётя 1957-04-04'],
    ['Отец 1955-03-03', 'Сын 1980-06-06'], ['Мать 1956-05-05', 'Сын 1980-06-06'],
    ['Отец 1955-03-03', 'Дочь 1982-07-07'], ['Мать 1956-05-05', 'Дочь 1982-07-07'],
    ['Тётя 1957-04-04', 'Двоюродный 1984-08-08'],
    ['Чужая 1991-10-10', 'Двоюродный 1984-08-08'],
    ['Отец Снохи 1952-02-02', 'Сноха 1981-03-03'],
];
const kinSpouses = [
    ['Отец 1955-03-03', 'Мать 1956-05-05'], ['Дед 1930-01-01', 'Бабка 1932-02-02'],
    ['Тётя 1957-04-04', 'Тесть 1931-12-12'], ['Сын 1980-06-06', 'Сноха 1981-03-03'],
    ['Дядька 1928-07-07', 'Жена Дядьки 1927-05-05'],
    ['Кузина 1956-06-06', 'Муж Кузины 1955-11-11'],
];
const sonKey = 'Сын 1980-06-06';
// focusDepth: глубина уровней (объединённый граф: кровь 1, брак 1,
// полнокровный сиблинг 1; не зависит от длины обычного ярлыка) — у Сына 5
// (Правнучатый/ДвВнуч на пятом), у Двоюродного 5, вертикаль 1/2
const depthCases = [
    [kinPairs, kinSpouses, sonKey], [kinPairs, kinSpouses, kinKeys['Двоюродный']],
    [[['Родитель 1930-01-01', 'Сын 1990-01-01']], [], 'Сын 1990-01-01'],
];
cmp('focusDepth глубины',
    depthCases.map(c => VK.focusDepth(c[0], c[1], c[2])),
    depthCases.map(c => TG.focusDepth(c[0], c[1], c[2])));
if (JSON.stringify([5, 5, 1]) !== JSON.stringify(depthCases
    .map(c => VK.focusDepth(c[0], c[1], c[2]))))
    { failed++; console.log('✗ focusDepth: неверные глубины'); }
// цифры радиуса: при depth 1 активная 1 скрыта и 2–5 нет — ряд [💬 цифры]
const digs = (radius, depth) => TG.focusMarkup('private', 1, {}, radius, depth)
    .inline_keyboard[0].filter(b => /^\d/.test(b.text)).map(b => b.text).join('');
if (digs(1, 1) !== '') { failed++; console.log('✗ focusMarkup: без дедов цифры не скрыты\n  ' + digs(1, 1)); }
if (digs(1, 2) !== '2') { failed++; console.log('✗ focusMarkup: с дедом нет 2\n  ' + digs(1, 2)); }
if (digs(2, 2) !== '1') { failed++; console.log('✗ focusMarkup: радиус 2/деды\n  ' + digs(2, 2)); }
if (digs(1, 3) !== '23')
    { failed++; console.log('✗ focusMarkup: прадеды 23\n  ' + digs(1, 3)); }
if (digs(3, 3) !== '12') { failed++; console.log('✗ focusMarkup: радиус 3/прадеды\n  ' + digs(3, 3)); }
const KIN_CASES = [
    [kinKeys['Отец'], 'отец'], [kinKeys['Мать'], 'мать'],
    [kinKeys['Дед'], 'дедушка'], [kinKeys['Бабка'], 'бабушка'],
    [kinKeys['Тётя'], 'тётя'], [kinKeys['Двоюродный'], 'двоюродный брат'],
    [kinKeys['Дочь'], 'сестра'],
    [kinKeys['Тесть'], 'муж тёти'],
    [kinKeys['Прадед'], 'прадед'],                    // глубина 3
    [kinKeys['Прапрадед'], 'пра2дед'],                // глубина 4
    [kinKeys['Дядька'], 'двоюродный дед'],            // брат деда (u3d1)
    [kinKeys['Тётка'], 'двоюродная бабушка'],         // сестра деда (u3d1)
    [kinKeys['Брат Прадеда'], 'двоюродный прадед'],   // брат прадеда (u4d1)
    [kinKeys['Кузина'], 'двоюродная сестра дедушки'], // (u4d2)
    [kinKeys['Троюродный'], 'троюродный брат отца'],  // (u4d3)
    [kinKeys['Племянник'], 'племянник'],             // (u1d2)
    [kinKeys['Внучатый'], 'внучатый племянник'],      // (u1d3)
    [kinKeys['Правнучатый'], 'правнучатый племянник'], // (u1d4)
    [kinKeys['ДвПлем'], 'двоюродный племянник'],      // (u2d3)
    [kinKeys['ДвВнуч'], 'двоюродный внучатый племянник'], // (u2d4)
    [kinKeys['Чужая'], 'мать двоюродного брата'],     // родня родни по крови
];
let kinOK = true;
for (const [to, want] of KIN_CASES) {
    const vkL = VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, to);
    const tgL = TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, to);
    cmp('kinLabel ' + to, vkL, tgL);
    if (vkL !== want) { kinOK = false; console.log('✗ kinLabel ' + to + ': ' + vkL + ' ≠ ' + want); }
}
if (!kinOK) { failed++; console.log('✗ kinLabel: неверные ярлыки (см. выше)'); }
for (const api of [VK, TGK]) {
    assert.equal(api.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Дед']), 'дедушка');
    assert.equal(api.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Дед'], 2, true), 'отец отца');
}
// обычные ярлыки: полукровный сиблинг — тоже «брат», сводный — через брак
// «сын жены отца»; уровневый BFS различает их по реальным связям
const halfPairs = [
    ['Отец 1930-01-01', 'Герой 1955-11-11'], ['Отец 1930-01-01', 'Полукровный 1958-01-01'],
    ['Мать 1932-01-01', 'Герой 1955-11-11'], ['ДругаяМать 1934-01-01', 'Полукровный 1958-01-01'],
];
const noSp = [];
if (VK.kinLabel(halfPairs, noSp, k => /Мать|ДругаяМать|Мам/.test(k) ? 'F' : 'M', 'Герой 1955-11-11', 'Полукровный 1958-01-01') !== 'брат')
    { failed++; console.log('✗ kinLabel: полукровный сиблинг не «брат»'); }
// сводный: ребёнок мачехи (у него нет общих родителей с героем)
const stepPairs = [
    ['Отец 1930-01-01', 'Герой 1955-11-11'],
    ['ДедСводного 1920-01-01', 'Сводный 1958-01-01'], ['Мачеха 1935-01-01', 'Сводный 1958-01-01'],
];
const stepSp = [['Отец 1930-01-01', 'Мачеха 1935-01-01']];
if (VK.kinLabel(stepPairs, stepSp, k => k === 'Мачеха 1935-01-01' ? 'F' : 'M', 'Герой 1955-11-11', 'Сводный 1958-01-01') !== 'сын жены отца')
    { failed++; console.log('✗ kinLabel: сводный сиблинг не «сын жены отца»'); }
// без пола — нейтральные ярлыки
const noSex = { ...kinSex };
delete noSex[kinKeys['Отец']];
cmp('kinLabel без пола', VK.kinLabel(kinPairs, kinSpouses, k => noSex[k] ?? null, sonKey, kinKeys['Отец']),
    TGK.kinLabel(kinPairs, kinSpouses, k => noSex[k] ?? null, sonKey, kinKeys['Отец']));
if (VK.kinLabel(kinPairs, kinSpouses, k => noSex[k] ?? null, sonKey, kinKeys['Отец']) !== 'родитель')
    { failed++; console.log('✗ kinLabel нейтральный «родитель»'); }
// супруг цитируемому
cmp('kinLabel муж цитируемой', VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, 'Мать 1956-05-05', kinKeys['Отец']),
    TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, 'Мать 1956-05-05', kinKeys['Отец']));
if (VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, 'Мать 1956-05-05', kinKeys['Отец']) !== 'муж')
    { failed++; console.log('✗ kinLabel супруг = «муж»'); }
// супруги родни цитируемого: «муж дочки», «жена внука»
cmp('kinLabel муж дочки',
    VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, kinKeys['Дед'], kinKeys['Тесть']),
    TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, kinKeys['Дед'], kinKeys['Тесть']));
if (VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, kinKeys['Дед'], kinKeys['Тесть']) !== 'муж дочки')
    { failed++; console.log('✗ kinLabel муж дочки'); }
cmp('kinLabel жена внука',
    VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, kinKeys['Дед'], kinKeys['Сноха']),
    TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, kinKeys['Дед'], kinKeys['Сноха']));
if (VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, kinKeys['Дед'], kinKeys['Сноха']) !== 'жена внука')
    { failed++; console.log('✗ kinLabel жена внука'); }
// супруг сиблинга деда: ярлык в родительном падеже — «жена двоюродного деда»
cmp('kinLabel жена двоюродного деда',
    VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Жена Дядьки']),
    TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Жена Дядьки']));
if (VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Жена Дядьки']) !== 'жена двоюродного деда')
    { failed++; console.log('✗ kinLabel жена двоюродного деда'); }
// супруг кузены предков: составной ярлык в родительном падеже
cmp('kinLabel муж кузины',
    VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Муж Кузины']),
    TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Муж Кузины']));
if (VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Муж Кузины']) !== 'муж двоюродной сестры дедушки')
    { failed++; console.log('✗ kinLabel муж двоюродной сестры дедушки'); }

// родство через супруга: «отец жены», «племянник мужа», «отец жены внука»
cmp('kinLabel отец жены',
    VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Отец Снохи']),
    TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Отец Снохи']));
if (VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Отец Снохи']) !== 'отец жены')
    { failed++; console.log('✗ kinLabel отец жены'); }
cmp('kinLabel племянник мужа',
    VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, 'Мать 1956-05-05', kinKeys['Двоюродный']),
    TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, 'Мать 1956-05-05', kinKeys['Двоюродный']));
if (VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, 'Мать 1956-05-05', kinKeys['Двоюродный']) !== 'племянник мужа')
    { failed++; console.log('✗ kinLabel племянник мужа'); }
cmp('kinLabel отец жены внука',
    VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, kinKeys['Дед'], kinKeys['Отец Снохи']),
    TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, kinKeys['Дед'], kinKeys['Отец Снохи']));
if (VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, kinKeys['Дед'], kinKeys['Отец Снохи']) !== 'отец жены внука')
    { failed++; console.log('✗ kinLabel отец жены внука'); }

// Состав списков ограничен словами цепочки, независимо от обычных ярлыков:
// муж тёти — 3 слова; муж кузины предков — 6, за пределами r5.
const fkeysOf = (which, r) =>
    which.focusListKeys(kinPairs, kinSpouses, sonKey, r, k => kinSex[k] ?? null);
for (const r of [1, 2, 3, 4, 5]) cmp('focusListKeys радиус ' + r, fkeysOf(VK, r), fkeysOf(TG, r));
if (!fkeysOf(VK, 1).includes(kinKeys['Сноха']) || fkeysOf(VK, 1).includes(kinKeys['Тесть']))
    { failed++; console.log('✗ focusListKeys r1: жена героя должна остаться, муж тёти — нет'); }
if (fkeysOf(VK, 2).includes(kinKeys['Тесть']))
    { failed++; console.log('✗ focusListKeys r2: муж тёти требует 3 слова'); }
if (!fkeysOf(VK, 3).includes(kinKeys['Тесть']))
    { failed++; console.log('✗ focusListKeys r3: нет мужа тёти'); }
if (fkeysOf(VK, 3).includes(kinKeys['Муж Кузины']) || fkeysOf(VK, 4).includes(kinKeys['Муж Кузины']))
    { failed++; console.log('✗ focusListKeys: муж кузины предков требует 6 слов'); }
if (!fkeysOf(VK, 5).includes(kinKeys['Жена Дядьки']) || fkeysOf(VK, 5).includes(kinKeys['Муж Кузины']))
    { failed++; console.log('✗ focusListKeys r5: неверная граница супругов дальней родни'); }
// уровневый список (levels=true, «жизненный» радиус): кровь 1, брак 1,
// полнокровный сиблинг 1; брачная родня исключена, супруги остаются.
// Все кандидаты, включая кровное ядро, фильтруются словами цепочки.
const lkeysOf = (which, r) =>
    which.focusListKeys(kinPairs, kinSpouses, sonKey, r, k => kinSex[k] ?? null, true);
for (const r of [1, 2, 3, 5]) cmp('focusListKeys levels ' + r, lkeysOf(VK, r), lkeysOf(TG, r));
if (!lkeysOf(VK, 1).includes(kinKeys['Сноха']) || !lkeysOf(VK, 1).includes(kinKeys['Мать']))
    { failed++; console.log('✗ levels r1: без жены/матери'); }
if (lkeysOf(VK, 2).includes(kinKeys['Отец Снохи']) || !lkeysOf(VK, 2).includes(kinKeys['Тётя']))
    { failed++; console.log('✗ levels r2: отец жены включён либо кровная тётя исключена'); }
if (lkeysOf(VK, 2).includes(kinKeys['Прадед']))
    { failed++; console.log('✗ levels r2: прадед проникнул на 2'); }
for (const api of [VK, TG]) for (const levels of [false, true]) {
    for (const [name, firstRadius] of [['Двоюродный', 3], ['ДвПлем', 4], ['Кузина', 5], ['Муж Кузины', 6]]) {
        for (const r of [1, 2, 3, 4, 5]) {
            assert.equal(api.focusListKeys(kinPairs, kinSpouses, sonKey, r, k => kinSex[k] ?? null, levels)
                .includes(kinKeys[name]), r >= (levels && name === 'Кузина' ? 6 : firstRadius),
                `${name}: radius ${r}, levels ${levels}`);
        }
    }
}
// Execute both display defaults in memory without changing production files.
for (const mode of [0, 1]) {
    const kinModule = { exports: {} }, treeModule = { exports: {} };
    const kinSource = fs.readFileSync(path.join(ROOT, 'tgcloud/lib/kinship.cjs'), 'utf8');
    assert.match(kinSource, /const fynny = 0;/);
    vm.runInNewContext(kinSource.replace('const fynny = 0;', `const fynny = ${mode};`), { module: kinModule });
    const treeRequire = createRequire(path.join(ROOT, 'tgcloud/lib/tree.cjs'));
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'tgcloud/lib/tree.cjs'), 'utf8'), {
        module: treeModule,
        require: name => name === './kinship.cjs' ? kinModule.exports : treeRequire(name),
    });
    for (const r of [1, 2, 3, 4, 5]) {
        cmp(`focusKeys display mode ${mode}, r${r}`, [...treeModule.exports.focusKeys(kinPairs, sonKey, r)].sort(),
            [...VK.focusKeys(kinPairs, sonKey, r)].sort());
        for (const levels of [false, true])
            cmp(`focusListKeys display mode ${mode}, r${r}, levels ${levels}`,
                [...treeModule.exports.focusListKeys(kinPairs, kinSpouses, sonKey, r, k => kinSex[k] ?? null, levels)].sort(),
                [...VK.focusListKeys(kinPairs, kinSpouses, sonKey, r, k => kinSex[k] ?? null, levels)].sort());
    }
}

// клика полных сиблингов: дистанция 1 независимо от порядка строк связей —
// ВК-SELECT шёл по индексу (алфавит) и звезда от kids[0] выкидывала
// «лишних» сиблингов из r1 (Феодора Алексеевна у Петра I, Romanov_family.ged)
const ROM_SIBS = [
    ['Пётр I Романов 1672-05-30', 'Наталья Романова 1673-08-22'],
    ['Пётр I Романов 1672-05-30', 'Феодора Романова 1674-09-04'],
    ['Алексей Романов 1629-03-19', 'Пётр I Романов 1672-05-30'],
    ['Алексей Романов 1629-03-19', 'Наталья Романова 1673-08-22'],
    ['Алексей Романов 1629-03-19', 'Феодора Романова 1674-09-04'],
    ['Наталья Нарышкина 1651-08-22', 'Пётр I Романов 1672-05-30'],
    ['Наталья Нарышкина 1651-08-22', 'Наталья Романова 1673-08-22'],
    ['Наталья Нарышкина 1651-08-22', 'Феодора Романова 1674-09-04'],
];
const ROM_ALPHA = [ // порядок ВК-индекса: пары по алфавиту родителя, ребёнка
    ['Алексей Романов 1629-03-19', 'Наталья Романова 1673-08-22'],
    ['Алексей Романов 1629-03-19', 'Пётр I Романов 1672-05-30'],
    ['Алексей Романов 1629-03-19', 'Феодора Романова 1674-09-04'],
    ['Наталья Нарышкина 1651-08-22', 'Наталья Романова 1673-08-22'],
    ['Наталья Нарышкина 1651-08-22', 'Пётр I Романов 1672-05-30'],
    ['Наталья Нарышкина 1651-08-22', 'Феодора Романова 1674-09-04'],
];
const ROM_SEX = { 'Пётр I Романов 1672-05-30': 'M', 'Наталья Романова 1673-08-22': 'F',
    'Феодора Романова 1674-09-04': 'F', 'Алексей Романов 1629-03-19': 'M', 'Наталья Нарышкина 1651-08-22': 'F' };
for (const [tag, romPairs] of [['id', ROM_SIBS], ['алфавит', ROM_ALPHA]]) {
    const rk = r => VK.focusListKeys(romPairs, [], 'Пётр I Романов 1672-05-30', r, k => ROM_SEX[k] ?? null, true);
    const tk = r => TG.focusListKeys(romPairs, [], 'Пётр I Романов 1672-05-30', r, k => ROM_SEX[k] ?? null, true);
    cmp('focusListKeys levels r1 Романовы (' + tag + ')', rk(1), tk(1));
    if (!rk(1).includes('Наталья Романова 1673-08-22') || !rk(1).includes('Феодора Романова 1674-09-04'))
        { failed++; console.log('✗ levels r1 (' + tag + '): без полных сиблингов Петра I'); }
}
// состав (не порядок обхода — списки сортируются по дате, чарт берёт
// множество) один и тот же при любом порядке строк связей
const asSet = ks => JSON.stringify([...ks].sort());
if (asSet(VK.focusListKeys(ROM_SIBS, [], 'Пётр I Романов 1672-05-30', 1, k => ROM_SEX[k] ?? null, true))
    !== asSet(VK.focusListKeys(ROM_ALPHA, [], 'Пётр I Романов 1672-05-30', 1, k => ROM_SEX[k] ?? null, true)))
    { failed++; console.log('✗ levels r1 Романовы: состав зависит от порядка пар'); }

// ==================== 8. focusListText: список с датой смерти и родством ====================
const kinItems = [
    { n: 'Бабка', d: '1932-02-02', dd: '2000-03-03' }, { n: 'Дед', d: '1930-01-01' },
    { n: 'Отец', d: '1955-03-03' }, { n: 'Тётя', d: '1957-04-04' }, { n: 'Мать', d: '1956-05-05' },
    { n: 'Сын', d: '1980-06-06' }, { n: 'Дочь', d: '1982-07-07', h: 4, m: 5 },
    { n: 'Двоюродный', d: '1984-08-08' },
    { n: 'Отец+Мать', d: '1979-01-01', dd: '1990-01-01' },
    { n: 'Тесть', d: '1931-12-12' },
];
for (const r of [1, 2]) {
    const kset = VK.focusWithSpouses(VK.focusKeys(kinPairs, sonKey, r), kinSpouses);
    const want = VK.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null);
    cmp('focusListText радиус ' + r,
        VK.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null),
        TG.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null));
    // по полной дате (toggle 🔔): ММ-ДД и ГГГГ-ММ-ДД дают разный порядок
    cmp('focusListText радиус ' + r + ' по датам',
        VK.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null, true),
        TG.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null, true));
    if (r === 2) {
        if (!/^Бабка 1932-02-02 2000-03-03 бабушка$/m.test(want))
            { failed++; console.log('✗ focusListText: Бабка без даты смерти/ярлыка'); }
        const pairLine = (want.split('\n').find(l => l.startsWith('Отец+Мать')) || '').trim();
        if (!/^Отец\+Мать 1979-01-01 1990-01-01$/.test(pairLine))
            { failed++; console.log('✗ focusListText: пара без ярлыка\n  ' + pairLine); }
        if (!/^Тесть 1931-12-12 муж тёти$/m.test(want))
            { failed++; console.log('✗ focusListText: супруг тёти без «муж тёти»'); }
        const full = VK.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null, true);
        if (!full.startsWith('Дед 1930-01-01')) // старейший (1930) — первым
            { failed++; console.log('✗ focusListText byFull: первая строка не старейший\n  ' + full.split('\n')[0]); }
        // «от сегодня» — круговой порядок (как religiousYear): с MM-ДД отсечки
        // далее по году с обёрткой (прошедшая часть года — в конец);
        // при отсечке 12-01 первым идёт Тесть (12-12), затем Дед (01-01)
        cmp('focusListText «от сегодня»',
            VK.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null, false, '12-01'),
            TG.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null, false, '12-01'));
        const future = VK.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null, false, '12-01');
        if (!future.startsWith('Тесть 1931-12-12 муж тёти\nДед 1930-01-01'))
            { failed++; console.log('✗ focusListText от сегодня: не Тесть→Дед\n  ' + future.split('\n').slice(0,2).join('\n')); }
        // без отсечки — прежнее поведение (весь год)
        const all = VK.focusListText(kinItems, kset, sonKey, kinPairs, kinSpouses, k => kinSex[k] ?? null);
        if (!all.startsWith('Дед 1930-01-01') || !/^Отец\+Мать 1979-01-01 1990-01-01$/m.test(all))
            { failed++; console.log('✗ focusListText без отсечки должен показывать весь год'); }
    }
}
// Состав ромба: u,d ≤ r и u+d−1 ≤ r для боковой родни.
// Кузены u2d2 — с r3, ДвПлем u2d3 — с r4, Кузина u4d2 и ДвВнуч
// u2d4 — с r5; Троюродный u4d3 требует r6.
const kinAt = (which, r) => which.focusKeys(kinPairs, sonKey, r);
for (const r of [1, 2, 3, 4, 5]) cmp('фокус-множество радиус ' + r, kinAt(VK, r), kinAt(TG, r));
if (kinAt(VK, 1).includes(kinKeys['Дед'])) { failed++; console.log('✗ r1 содержит деда'); }
if (kinAt(VK, 2).includes(kinKeys['Прадед'])) { failed++; console.log('✗ r2 содержит прадеда'); }
if (!kinAt(VK, 2).includes(kinKeys['Дед'])) { failed++; console.log('✗ r2 без деда'); }
if (kinAt(VK, 3).includes(kinKeys['Прапрадед'])) { failed++; console.log('✗ r3 содержит прапрадеда'); }
if (!kinAt(VK, 3).includes(kinKeys['Прадед'])) { failed++; console.log('✗ r3 без прадеда'); }
if (!kinAt(VK, 4).includes(kinKeys['Прапрадед'])) { failed++; console.log('✗ r4 без прапрадеда'); }
// Нижняя граница тоже ограничена u+d−1: племянник с r2, внучатый с r3.
if (kinAt(VK, 1).includes(kinKeys['Племянник'])) { failed++; console.log('✗ r1 содержит племянника (u1d2)'); }
if (kinAt(VK, 2).includes(kinKeys['Внучатый'])) { failed++; console.log('✗ r2 содержит внучатого (u1d3)'); }
if (kinAt(VK, 2).includes(kinKeys['ДвПлем'])) { failed++; console.log('✗ r2 содержит двоюродного племянника (u2d3)'); }
if (kinAt(VK, 2).includes(kinKeys['Правнучатый'])) { failed++; console.log('✗ r2 содержит правнучатого (u1d4)'); }
if (!kinAt(VK, 2).includes(kinKeys['Племянник'])) { failed++; console.log('✗ r2 без племянника (u1d2)'); }
if (kinAt(VK, 2).includes(kinKeys['Двоюродный'])) { failed++; console.log('✗ r2 содержит кузена (u2d2, 3 слова)'); }
if (!kinAt(VK, 2).includes(kinKeys['Тётя'])) { failed++; console.log('✗ r2 без тёти (u2d1)'); }
if (!kinAt(VK, 3).includes(kinKeys['Внучатый'])) { failed++; console.log('✗ r3 без внучатого (u1d3)'); }
if (!kinAt(VK, 3).includes(kinKeys['Двоюродный'])) { failed++; console.log('✗ r3 без кузена (u2d2)'); }
if (!kinAt(VK, 3).includes(kinKeys['Дядька'])) { failed++; console.log('✗ r3 без брата деда (u3d1)'); }
if (!kinAt(VK, 3).includes(kinKeys['Тётка'])) { failed++; console.log('✗ r3 без сестры деда (u3d1)'); }
if (kinAt(VK, 3).includes(kinKeys['ДвПлем'])) { failed++; console.log('✗ r3 содержит двоюродного племянника (u2d3, 4 слова)'); }
if (kinAt(VK, 3).includes(kinKeys['Правнучатый'])) { failed++; console.log('✗ r3 содержит правнучатого (u1d4)'); }
if (!kinAt(VK, 4).includes(kinKeys['Правнучатый'])) { failed++; console.log('✗ r4 без правнучатого (u1d4)'); }
if (!kinAt(VK, 4).includes(kinKeys['ДвПлем'])) { failed++; console.log('✗ r4 без двоюродного племянника (u2d3)'); }
if (!kinAt(VK, 4).includes(kinKeys['Брат Прадеда'])) { failed++; console.log('✗ r4 без брата прадеда (u4d1)'); }
if (kinAt(VK, 3).includes(kinKeys['Кузина'])) { failed++; console.log('✗ r3 содержит кузину (u4d2)'); }
if (kinAt(VK, 4).includes(kinKeys['Кузина'])) { failed++; console.log('✗ r4 содержит кузину (u4d2, 5 слов)'); }
if (kinAt(VK, 3).includes(kinKeys['Троюродный'])) { failed++; console.log('✗ r3 содержит троюродного (u4d3)'); }
if (kinAt(VK, 4).includes(kinKeys['Троюродный'])) { failed++; console.log('✗ r4 содержит троюродного (u4d3, 6 слов)'); }
if (kinAt(VK, 3).includes(kinKeys['ДвВнуч'])) { failed++; console.log('✗ r3 содержит двоюродного внучатого (u2d4)'); }
if (kinAt(VK, 4).includes(kinKeys['ДвВнуч'])) { failed++; console.log('✗ r4 содержит двоюродного внучатого (u2d4, 5 слов)'); }
// Радиус 5 ограничен пятью словами, без исключения для дальней родни.
if (!kinAt(VK, 5).includes(kinKeys['Кузина'])) { failed++; console.log('✗ r5 без кузины (u4d2)'); }
if (!kinAt(VK, 5).includes(kinKeys['ДвВнуч'])) { failed++; console.log('✗ r5 без ДвВнуч (u2d4)'); }
if (kinAt(VK, 5).includes(kinKeys['Троюродный'])) { failed++; console.log('✗ r5 содержит троюродного (u4d3, 6 слов)'); }
if (!kinAt(VK, 5).includes(kinKeys['ДвВнуч'])) { failed++; console.log('✗ r5 без двоюродного внучатого (u2d4)'); }
if (!kinAt(VK, 5).includes(kinKeys['Прапрадед'])) { failed++; console.log('✗ r5 без прапрадеда (u4d0)'); }
if (kinAt(VK, 3).includes(kinKeys['Брат Прадеда'])) { failed++; console.log('✗ r3 содержит брата прадеда (u4)'); }
if (!kinAt(VK, 4).includes(kinKeys['Брат Прадеда'])) { failed++; console.log('✗ r4 без брата прадеда (u4d1)'); }
// отражённый коб: потомки есть, родителей нет — цифра радиуса всё равно видна
if (JSON.stringify(VK.focusDepth([['A 1900-01-01', 'B 1930-01-01'], ['B 1930-01-01', 'C 1960-01-01'],
    ['C 1960-01-01', 'D 1985-01-01']], [], 'B 1930-01-01')) !== '2')
    { failed++; console.log('✗ focusDepth: глубина по потомкам (max 1,2 = 2)'); }

// ==================== 3. импорт → полный экспорт гедкома ====================
// непустой чат до импорта: ЗАМЕНА должна стереть старое
const g = VK.parseGedcom(GEDCOM);
VK.clearChatTree(1);
for (const p of [{ n: 'Старьё', d: '1900-01-01' }, { n: 'Старьё2', d: '1901-01-01' }])
    { VK.upsertPerson(1, p); await TG.upsertPerson(1, p); }
const junk = { n: 'Старьё+Старьё2', d: '1920-01-01' };
VK.upsertPerson(1, junk); await TG.upsertPerson(1, junk);
const vkImp = VK.importGedcom(1, g);
const tgImp = await TG.importGedcom(1, g);
cmp('importGedcom: замена стирает старое',
    [VK.personRows(1).length, VK.weddingRows(1).length, VK.recordAnyOf(1, 'Старьё 1900-01-01')],
    [(await TG.personRows(1)).length, (await TG.weddingRows(1)).length, await TG.recordOf(1, 'Старьё 1900-01-01')]);
if (VK.recordAnyOf(1, 'Старьё 1900-01-01') !== null) { failed++; console.log('✗ замена: старое «Старьё» не стёрто'); }
cmp('importGedcom отчёт', vkImp, tgImp);
cmp('gedcomText после импорта', VK.gedcomText(1), await TG.gedcomText(1));
// импорт-экспорт NOTE с переносами: 1 NOTE + 2 CONT построчно
if (!VK.gedcomText(1).includes('1 NOTE 1960 год уточняется')
    || !VK.gedcomText(1).includes('2 CONT вторая строка')
    || !VK.gedcomText(1).includes('1 NOTE венчание'))
    { failed++; console.log('✗ гедком-экспорт NOTE/CONT после импорта'); }

// SEX пустой → null (нет половых ярлыков; «unknown» тоже null)
{
    const gNosex = VK.parseGedcom('0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @N1@ INDI\n1 NAME Безпола /П/\n1 BIRT\n2 DATE 1 JAN 1960\n1 SEX unknown\n0 TRLR');
    const gNosexTg = TGP.parseGedcom('0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @N1@ INDI\n1 NAME Безпола /П/\n1 BIRT\n2 DATE 1 JAN 1960\n1 SEX unknown\n0 TRLR');
    cmp('parseGedcom SEX unknown → null', gNosex.indis[0].sex, gNosexTg.indis[0].sex);
    if (gNosex.indis[0].sex !== null) { failed++; console.log('✗ SEX unknown → null, получил ' + gNosex.indis[0].sex); }
}

// ==================== 3б. бездатные супруги, места, похороны ====================
// бездатная персона импортируется при упоминании в семье (супруг/ребёнок);
// места рождения/смерти читаются из PLAC, похороны (BURI) — фолбэк смерти;
// роспись выводит места в скобках за своей датой, .ged пишет PLAC и заглушкам
const GED_STUB = ['0 HEAD',
    '0 @I1@ INDI', '1 NAME Иван /Г/', '1 SEX M', '1 BIRT', '2 DATE 10 MAY 1960', '2 PLAC Пермь',
    '1 BURI', '2 DATE 5 MAY 2020', '2 PLAC Пермь',
    '0 @I2@ INDI', '1 NAME Мария /С/', '1 SEX F', '1 BIRT', '2 PLAC Сарапул',
    '1 DEAT', '2 DATE 3 FEB 2020', '2 PLAC Курск',
    '0 @I3@ INDI', '1 BIRT', '2 DATE 1 JAN 1900',                       // безымянный — мимо
    '0 @I4@ INDI', '1 NAME Сирота /Бездатная/',                          // бездатный вне семей — мимо
    '0 @I5@ INDI', '1 NAME Сын /Бездатный/', '1 BURI', '2 DATE 5 MAY 1990', '2 PLAC Москва',
    '0 @I6@ INDI', '1 NAME Ольга /Д/', '1 SEX F', '1 BIRT', '2 DATE 1 MAR 1955',
    '1 DEAT', '2 DATE 1 JAN 2001', '1 BURI', '2 DATE 2 JAN 2001', '2 PLAC Кладбище',
    '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 CHIL @I5@', '1 MARR', '2 DATE 4 JUN 1983',
    '0 TRLR'].join('\n');
const gStub = VK.parseGedcom(GED_STUB);
cmp('parseGedcom бездатные/места/похороны', gStub, TGP.parseGedcom(GED_STUB));
cmp('gedStats бездатные/места', VK.gedStats(gStub), TGP.gedStats(TGP.parseGedcom(GED_STUB)));
if (VK.gedStats(gStub).persons !== 4 || VK.gedStats(gStub).links !== 1)
    { failed++; console.log('✗ gedStats бездатные: ' + JSON.stringify(VK.gedStats(gStub))); }
const GS_CH = 13;
VK.clearChatTree(GS_CH);
await TG.clearChatTree(GS_CH);
cmp('importGedcom бездатные отчёт',
    VK.importGedcom(GS_CH, gStub), await TG.importGedcom(GS_CH, TGP.parseGedcom(GED_STUB)));
cmp('importGedcom бездатные пачка', VK.chatFlatText(GS_CH), await TG.chatFlatText(GS_CH));
cmp('importGedcom бездатные свадьбы', VK.weddingRows(GS_CH), await TG.weddingRows(GS_CH));
cmp('importGedcom бездатные гедком', VK.gedcomText(GS_CH), await TG.gedcomText(GS_CH));
const stubFlat = VK.chatFlatText(GS_CH);
const STUB_FLAT_EXPECT = '-Иван Г 1960-05-10 (Пермь) 2020-05-05 (Пермь)\n'
    + '+1983-06-04\n'
    + 'Мария С 1960-05-10~ (Сарапул) 2020-02-03 (Курск)\n'
    + '--Сын Бездатный 1984-06-04~ 1990-05-05 (Москва)\n' // свадьба +1 год (birt_abt 15, EST-день)
    + '=Ольга Д 1955-03-01 2001-01-01 (Кладбище)';
if (stubFlat !== STUB_FLAT_EXPECT)
    { failed++; console.log('✗ пачка бездатные/места:\n  ' + stubFlat); }
// похороны: у Ивана (без DEAT) — deat от BURI; у Ольги (DEAT без места) —
// дата смерти своя, место от BURI
if (!VK.gedcomText(GS_CH).includes('2 DATE 5 MAY 2020') || !VK.gedcomText(GS_CH).includes('2 PLAC Кладбище'))
    { failed++; console.log('✗ BURI → DEAT в экспорте:\n  ' + VK.gedcomText(GS_CH)); }
// заглушка-супруга с датой смерти и местом; бездатный ребёнок — CHIL/FAMC
if (!VK.gedcomText(GS_CH).includes('1 NAME Мария С') || !VK.gedcomText(GS_CH).includes('1 NAME Сын Бездатный'))
    { failed++; console.log('✗ бездатные заглушки в экспорте:\n  ' + VK.gedcomText(GS_CH)); }
// round-trip: реимпорт выведенной росписи идемпотентен (места на месте)
VK.applyTree(GS_CH, VK.parseTree(stubFlat));
await TG.applyTree(GS_CH, TGP.parseTree(stubFlat));
cmp('round-trip пачка бездатные/места', VK.chatFlatText(GS_CH), await TG.chatFlatText(GS_CH));
if (VK.chatFlatText(GS_CH) !== STUB_FLAT_EXPECT)
    { failed++; console.log('✗ round-trip пачка бездатные/места:\n  ' + VK.chatFlatText(GS_CH)); }
// round-trip: экспорт .ged → импорт → та же роспись (заглушки с датами смерти
// возвращаются: BURI/DEAT у бездатных переживают цикл)
VK.importGedcom(GS_CH, VK.parseGedcom(VK.gedcomText(GS_CH)));
await TG.importGedcom(GS_CH, TGP.parseGedcom(await TG.gedcomText(GS_CH)));
cmp('round-trip .ged бездатные', VK.chatFlatText(GS_CH), await TG.chatFlatText(GS_CH));

// ==================== 3бв-1. полностью бездатное древо: гейт выгрузки ======
// все персоны бездатные — связи «Имя Д» (edges/links) пусты, но выгрузка
// .ged по xref возможна; гейт «связей пока нет» смотрит на fam/chil, а не
// на численность ключевых связей
const GED_NODATE = fs.readFileSync(path.join(ROOT, 'dev', 'fixtures', 'fam-nodate.ged'), 'utf8');
const ND_CH = 140;
VK.clearChatTree(ND_CH);
await TG.clearChatTree(ND_CH);
VK.importGedcom(ND_CH, VK.parseGedcom(GED_NODATE));
await TG.importGedcom(ND_CH, TGP.parseGedcom(GED_NODATE));
cmp('бездатное древо hasTree', VK.hasTree(ND_CH) ? 'да' : 'нет', (await TG.hasTree(ND_CH)) ? 'да' : 'нет');
if (!VK.hasTree(ND_CH))
    { failed++; console.log('✗ hasTree: бездатное древо не распознано'); }
cmp('бездатное древо гедком', VK.gedcomText(ND_CH), await TG.gedcomText(ND_CH));
if (!VK.gedcomText(ND_CH).includes('1 FAMS'))
    { failed++; console.log('✗ бездатное древо: выгрузка пуста'); }

// ==================== 3бв. бездатные дети: сиблинг/свадьба/родитель ======
// приоритет: ДР последнего сиблинга +1 год → свадьба +1 год →
// ДР младшего родителя +20 лет; каждый следующий бездатный ребёнок семьи —
// +1 год к предыдущей присвоенной дате (каскад, не повторно к якорю);
// одноимённые дети тоже следуют каскаду; коллизии ключей — суффикс ~xref;
// без всего перечисленного — заглушка без даты
const GED_KIDS = ['0 HEAD',
    '0 @I1@ INDI', '1 NAME Отец /О/', '1 SEX M', '1 BIRT', '2 DATE 10 MAY 1900',
    '0 @I2@ INDI', '1 NAME Мать /О/', '1 SEX F', '1 BIRT', '2 DATE 20 NOV 1903',
    '0 @I3@ INDI', '1 NAME Старший /О/', '1 BIRT', '2 DATE 1 FEB 1930',
    '0 @I4@ INDI', '1 NAME Дочь /О/', '1 SEX F',                          // сиблинг
    '0 @I5@ INDI', '1 NAME Большой /О/', '1 BIRT', '2 DATE 9 AUG 1933',
    '0 @I18@ INDI', '1 NAME Младший /О/',                                 // каскад после Дочи О
    '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 CHIL @I3@', '1 CHIL @I4@', '1 CHIL @I5@', '1 CHIL @I18@',
    '1 MARR', '2 DATE 7 JUL 1928',
    '0 @I6@ INDI', '1 NAME Папа /П/', '1 BIRT', '2 DATE 1 JAN 1901',
    '0 @I7@ INDI', '1 NAME Мама /П/', '1 SEX F', '1 BIRT', '2 DATE 2 FEB 1904',
    '0 @I8@ INDI', '1 NAME Тот /П/',                                      // родитель
    '0 @F2@ FAM', '1 HUSB @I6@', '1 WIFE @I7@', '1 CHIL @I8@',
    '0 @I9@ INDI', '1 NAME Папа2 /П/', '1 SEX M',
    '0 @I10@ INDI', '1 NAME Мама2 /П/', '1 SEX F', '1 BIRT', '2 DATE 3 MAR 1906',
    '0 @I11@ INDI', '1 NAME Сын /П/',                                     // единственный датный родитель
    '0 @I20@ INDI', '1 NAME Дочка /П/',                                   // каскад после Сына П
    '0 @F3@ FAM', '1 HUSB @I9@', '1 WIFE @I10@', '1 CHIL @I11@', '1 CHIL @I20@',
    '0 @I12@ INDI', '1 NAME Близнец /К/',
    '0 @I13@ INDI', '1 NAME Близнец /К/',
    '0 @I19@ INDI', '1 NAME Третий /К/',                                  // каскад после Близнецов
    '0 @I14@ INDI', '1 NAME Папа3 /К/', '1 BIRT', '2 DATE 5 MAY 1921',
    '0 @I15@ INDI', '1 NAME Мама3 /К/', '1 SEX F', '1 BIRT', '2 DATE 6 JUN 1922',
    '0 @F4@ FAM', '1 HUSB @I14@', '1 WIFE @I15@', '1 CHIL @I12@', '1 CHIL @I13@', '1 CHIL @I19@',
    '1 MARR', '2 DATE 1 DEC 1943',
    '0 @I16@ INDI', '1 NAME Мать4 /Н/', '1 SEX F',
    '0 @I17@ INDI', '1 NAME Реб /Н/',                                     // ничего не известно — без даты
    '0 @F5@ FAM', '1 WIFE @I16@', '1 CHIL @I17@',
    '0 TRLR'].join('\n');
const GK_CH = 15;
VK.clearChatTree(GK_CH);
await TG.clearChatTree(GK_CH);
const vkImpK = VK.importGedcom(GK_CH, VK.parseGedcom(GED_KIDS));
const tgImpK = await TG.importGedcom(GK_CH, TGP.parseGedcom(GED_KIDS));
cmp('importGedcom бездатные дети отчёт', vkImpK, tgImpK);
const kidsFlat = VK.chatFlatText(GK_CH);
cmp('importGedcom бездатные дети пачка', kidsFlat, await TG.chatFlatText(GK_CH));
cmp('importGedcom бездатные дети гедком', VK.gedcomText(GK_CH), await TG.gedcomText(GK_CH));
cmp('importGedcom бездатные дети свадьбы', VK.weddingRows(GK_CH), await TG.weddingRows(GK_CH));
// round-trip: экспорт → импорт → та же роспись
VK.importGedcom(GK_CH, VK.parseGedcom(VK.gedcomText(GK_CH)));
await TG.importGedcom(GK_CH, TGP.parseGedcom(await TG.gedcomText(GK_CH)));
cmp('round-trip .ged бездатные дети', VK.chatFlatText(GK_CH), await TG.chatFlatText(GK_CH));
if (VK.chatFlatText(GK_CH) !== kidsFlat)
    { failed++; console.log('✗ round-trip пачка бездатные дети:\n  ' + VK.chatFlatText(GK_CH)); }
const kidOf = n => VK.personRows(GK_CH).filter(r => r.n.startsWith(n));
const kidWant = (n, d, what) => {
    if (!kidOf(n).some(r => r.d === d))
        { failed++; console.log('✗ бездатные дети ' + what + ': нет ключа «' + n + ' ' + d + '»: ' + kidOf(n).map(r => r.n + ' ' + r.d).join(' | ')); }
};
kidWant('Дочь О', '1934-08-09', 'последний сиблинг +1 год');
kidWant('Младший О', '1935-08-09', 'каскад +1 год к фиктивной дате Дочи');
kidWant('Тот П', '1924-02-02', 'младший родитель +20 лет');
kidWant('Сын П', '1926-03-03', 'родитель без свадьбы +20 лет');
kidWant('Дочка П', '1927-03-03', 'каскад +1 год к фиктивной дате Сына');
kidWant('Близнец К', '1944-12-01', 'свадьба +1 год');
kidWant('Близнец К', '1945-12-01', 'второй одноимённый ребёнок — каскад +1 год');
kidWant('Третий К', '1946-12-01', 'каскад +1 год к фиктивной дате Близнеца');
{
    const reb = kidOf('Реб Н')[0];
    if (reb && reb.d !== undefined) { failed++; console.log('✗ бездатные дети: «Реб Н» получил дату ' + reb.d); }
}

// Constrained children keep their selected dates through adapter collisions and GED round-trips.
{
    const id = 151;
    const source = ['0 HEAD',
        '0 @P@ INDI', '1 NAME Constraint Parent', '1 BIRT', '2 DATE 1 JAN 1970',
        '0 @D@ INDI', '1 NAME Death Limited', '1 DEAT', '2 DATE 1 JUN 2004', '2 PLAC Rest',
        '0 @S1@ INDI', '1 NAME Death Sibling', '1 BIRT', '2 DATE 1 JUN 2005',
        '0 @V@ INDI', '1 NAME Divorce Limited',
        '0 @S2@ INDI', '1 NAME Divorce Sibling', '1 BIRT', '2 DATE 1 JUN 2005',
        '0 @C1@ INDI', '1 NAME Fallback Child', '1 DEAT', '2 DATE 1 JAN 2000', '2 PLAC Rest',
        '0 @C2@ INDI', '1 NAME Fallback Child', '1 DEAT', '2 DATE ABT 1 JAN 2000', '2 PLAC Rest',
        '0 @FD@ FAM', '1 HUSB @P@', '1 CHIL @D@', '1 CHIL @S1@', '1 MARR', '2 DATE 1 JAN 2000',
        '0 @FV@ FAM', '1 HUSB @P@', '1 CHIL @V@', '1 CHIL @S2@',
        '1 MARR', '2 DATE 1 JAN 2000', '1 DIV', '2 DATE 1 JUN 2003',
        '0 @FC@ FAM', '1 HUSB @P@', '1 CHIL @C1@', '1 CHIL @C2@', '1 MARR', '2 DATE 1 JAN 2010',
        '0 TRLR',
    ].join('\n');
    const results = [];
    for (const [platform, api] of [['VK', VK], ['TG', TG]]) {
        const report = await api.importGedcom(id, TGP.parseGedcom(source));
        assert.deepEqual(report.dups, [{ from: 'Fallback Child', to: 'Fallback Child ~C2 2000-01-01~' }], platform);
        const before = {
            rows: await api.personRows(id), families: await api.famList(id),
            flat: await api.chatFlatText(id), ged: await api.gedcomText(id),
        };
        for (let pass = 0; pass < 2; pass++) {
            const rows = await api.personRows(id);
            const ged = TGP.parseGedcom(await api.gedcomText(id));
            assert.equal(rows.length, 7, platform + ': duplicate fallback children remain distinct');
            for (const [xref, name, date, death, deathAbt] of [
                ['D', 'Death Limited', '2004-06-01', '2004-06-01', 0],
                ['V', 'Divorce Limited', '2004-06-01', null, 0],
                ['C1', 'Fallback Child', '2000-01-01', '2000-01-01', 0],
                ['C2', 'Fallback Child ~C2', '2000-01-01', '2000-01-01', 3],
            ]) {
                const row = rows.find(p => p.n === name);
                assert.ok(row, platform + ': saved ' + name);
                assert.deepEqual([row.d, row.abt, row.dd || null, row.dabt || 0],
                    [date, 15, death, deathAbt], platform + ': saved constrained birth/death ' + xref);
                const person = ged.indis.find(p => p.__xref === xref);
                assert.ok(person, platform + ': exported xref ' + xref);
                // GED exports clean names; xref restores the collision suffix on import.
                assert.equal(person.name, name.replace(/ ~\S+$/, ''));
                assert.deepEqual([person.birt.date, person.birt.abt], [date, 15], platform + ': exported EST ' + xref);
                assert.deepEqual(person.deat && [person.deat.date, person.deat.abt || 0, person.deat.plac],
                    death ? [death, deathAbt, 'Rest'] : null, platform + ': exported death ' + xref);
            }
            for (const [family, children] of [['FD', ['D', 'S1']], ['FV', ['V', 'S2']], ['FC', ['C1', 'C2']]]) {
                const f = ged.fams.find(f => f.__xref === family);
                assert.equal(f.husb, 'P');
                assert.deepEqual(f.chil, children, platform + ': preserved family ' + family);
            }
            for (const xref of ['S1', 'S2']) {
                const sibling = ged.indis.find(p => p.__xref === xref);
                assert.deepEqual([sibling.birt.date, sibling.birt.abt || 0], ['2005-06-01', 0], platform + ': factual sibling unchanged');
            }
            if (pass === 0) await api.importGedcom(id, TGP.parseGedcom(before.ged));
        }
        const after = {
            rows: await api.personRows(id), families: await api.famList(id),
            flat: await api.chatFlatText(id), ged: await api.gedcomText(id),
        };
        assert.deepEqual(after, before, platform + ': constrained children export/reimport is stable');
        results.push(after);
    }
    cmp('importGedcom constrained children export/reimport', results[0], results[1]);
}

// ==================== 3бг. первенцы жён одного родителя ==================
// у родителя с несколькими бездатными жёнами первенец семьи без датных
// сиблингов и свадьбы — максимум +1 среди датных (в т.ч. фиктивных) детей
// других семей общего родителя, а не повторный «датный родитель +20»
// (иначе все первенцы «рождаются» в один год); жёны — дата мужа по-прежнему
const GED_WIVES = ['0 HEAD',
    '0 @I1@ INDI', '1 NAME ПК', '1 SEX M', '1 BIRT', '2 DATE 4 MAR 1908',
    '0 @X1@ INDI', '1 NAME ВК', '1 SEX M', '1 FAMC @F1@', '1 FAMS @F2@', '1 FAMS @F3@',
    '0 @X2@ INDI', '1 NAME Г _', '1 SEX F', '1 FAMS @F2@',
    '0 @X3@ INDI', '1 NAME ВиК', '1 SEX M', '1 FAMC @F2@',
    '0 @X4@ INDI', '1 NAME Е _', '1 SEX F', '1 FAMS @F3@',
    '0 @X5@ INDI', '1 NAME ЛК', '1 SEX F', '1 FAMC @F3@',
    '0 @X6@ INDI', '1 NAME ВиК', '1 SEX M', '1 FAMC @F3@',
    '0 @F1@ FAM', '1 HUSB @I1@', '1 CHIL @X1@',
    '0 @F2@ FAM', '1 HUSB @X1@', '1 WIFE @X2@', '1 CHIL @X3@',
    '0 @F3@ FAM', '1 HUSB @X1@', '1 WIFE @X4@', '1 CHIL @X5@', '1 CHIL @X6@',
    '0 TRLR'].join('\n');
const GW_CH = 16;
VK.clearChatTree(GW_CH);
await TG.clearChatTree(GW_CH);
const vkImpW = VK.importGedcom(GW_CH, VK.parseGedcom(GED_WIVES));
const tgImpW = await TG.importGedcom(GW_CH, TGP.parseGedcom(GED_WIVES));
cmp('importGedcom жёны одного отца отчёт', vkImpW, tgImpW);
const wivesFlat = VK.chatFlatText(GW_CH);
cmp('importGedcom жёны одного отца пачка', wivesFlat, await TG.chatFlatText(GW_CH));
cmp('importGedcom жёны одного отца гедком', VK.gedcomText(GW_CH), await TG.gedcomText(GW_CH));
// round-trip: экспорт → импорт → та же роспись
VK.importGedcom(GW_CH, VK.parseGedcom(VK.gedcomText(GW_CH)));
await TG.importGedcom(GW_CH, TGP.parseGedcom(await TG.gedcomText(GW_CH)));
cmp('round-trip .ged жёны одного отца', VK.chatFlatText(GW_CH), await TG.chatFlatText(GW_CH));
if (VK.chatFlatText(GW_CH) !== wivesFlat)
    { failed++; console.log('✗ round-trip пачка жёны одного отца:\n  ' + VK.chatFlatText(GW_CH)); }
{
    const wRows = VK.personRows(GW_CH);
    const wWant = (n, d, what) => {
        if (!wRows.some(r => r.n.startsWith(n) && r.d === d))
            { failed++; console.log('✗ жёны одного отца ' + what + ': нет ключа «' + n + ' ' + d + '»: ' + wRows.map(r => r.n + ' ' + r.d).join(' | ')); }
    };
    wWant('ПК', '1908-03-04', 'датный в файле');
    wWant('ВК', '1928-03-04', 'датный родитель +20 лет');
    wWant('Г _', '1928-03-04', 'жена — дата мужа');
    wWant('Е _', '1928-03-04', 'вторая жена — дата мужа');
    wWant('ВиК', '1948-03-04', 'первенец первой семьи — родитель +20 лет');
    wWant('ЛК', '1949-03-04', 'первенец второй семьи — дети других семей +1 год');
    wWant('ВиК', '1950-03-04', 'второй ребёнок второй семьи — каскад +1 год');
}

// ==================== 3в. бездатный в диаграмме: точка/вертикали ========
// бездатный муж с датированной женой: связь ребёнка — точки на всех трёх
// (вертикаль мужа «Имя якорь» ↔ жена ↔ ребёнок), фантом между супругами
// за ребёнка вне чарта; явный ключ бездатного не под ckey
const GED_LINK = ['0 HEAD',
    '0 @I1@ INDI', '1 NAME Анна /Т/', '1 SEX F', '1 BIRT', '2 DATE 1 JAN 1900',
    '0 @I2@ INDI', '1 NAME Пётр /Бездатный/', '1 SEX M', '1 DEAT', '2 DATE 5 MAY 1970',
    '0 @I3@ INDI', '1 NAME Сын /Т/', '1 SEX M', '1 BIRT', '2 DATE 5 MAR 1930',
    '0 @I4@ INDI', '1 NAME Дочь /ВнеЧарта/', '1 SEX F', '1 BIRT', '2 DATE 6 JUN 1935',
    '0 @F1@ FAM', '1 HUSB @I2@', '1 WIFE @I1@', '1 CHIL @I3@', '1 CHIL @I4@',
    '0 TRLR'].join('\n');
const GL_CH = 14;
VK.clearChatTree(GL_CH);
await TG.clearChatTree(GL_CH);
VK.importGedcom(GL_CH, VK.parseGedcom(GED_LINK));
await TG.importGedcom(GL_CH, TGP.parseGedcom(GED_LINK));
// фрагмент: жена+сын; муж-бездатный в строке от якоря = год жены, дочь вне
// чарта — фантом-вертикаль между супругами (точки на строках обоих)
const LINK_KEYS = ['Анна Т 1900-01-01', 'Сын Т 1930-03-05'];
cmp('chartFor бездатный в связях (байты)',
    VK.chartFor(GL_CH, LINK_KEYS, 't'),
    await TG.chartFor(GL_CH, LINK_KEYS, 't'));
{
    const rows = [
        { name: 'Анна Т', birth: '1900-01-01', death: null, sex: 'F' },
        { name: 'Пётр Бездатный', k: 'Пётр Бездатный 1900', birth: null, anchor: 1900, death: '1970-05-05', sex: 'M' },
        { name: 'Сын Т', birth: '1930-03-05', death: null, sex: 'M' },
    ];
    const ln = [{ child: 'Сын Т 1930-03-05', parents: ['Анна Т 1900-01-01', 'Пётр Бездатный 1900'] }];
    const ph = { phantoms: [{ fam: ['Анна Т 1900-01-01', 'Пётр Бездатный 1900'], years: [1935] }] };
    cmp('chartModel бездатный в связях', VK.chartModel('l', rows, ln, ph), TGC.chartModel('l', rows, ln, ph));
    cmp('chartPdf бездатный в связях (байты)', VK.chartPdf('l', rows, ln, FONT, ph), TGC.chartPdf('l', rows, ln, FONT, ph));
    // фантом с fam из ОДНОГО родителя (второй вне чарта — при радиусе 1
    // полукровные сиблинги героя вырезаны из строк): точка + зарубка вниз
    // от бара присутствующего, цвет семьи; обе копии дословно
    const ph1 = { phantoms: [{ fam: ['Анна Т 1900-01-01'], years: [1935] }] };
    cmp('chartModel фантом одного родителя', VK.chartModel('l', rows, ln, ph1), TGC.chartModel('l', rows, ln, ph1));
    cmp('chartPdf фантом одного родителя (байты)', VK.chartPdf('l', rows, ln, FONT, ph1), TGC.chartPdf('l', rows, ln, FONT, ph1));
    {
        const m1 = VK.chartModel('l', rows, ln, ph1);
        const dots1 = m1.draws.filter(d => d.k === 'dot');
        if (dots1.length !== 4) // ребёнок+два родителя на 1930 + точка фантома на 1935
            { failed++; console.log('✗ chart фантом-одиночка: точек ' + dots1.length + ', ожидается 4'); }
        if (!m1.draws.some(d => d.k === 'line' && d.w === 1.5 && d.y2 === d.y1 + 8))
            { failed++; console.log('✗ chart фантом-одиночка: зарубки cy…cy+8 нет'); }
    }
    const m = VK.chartModel('l', rows, ln, ph);
    const dots = m.draws.filter(d => d.k === 'dot');
    if (dots.length !== 5) // ребёнок + два родителя на вертикали 1930 и фантом-пара 1935
        { failed++; console.log('✗ chart бездатный: точек ' + dots.length + ', ожидается 5'); }
    const xs = [...new Set(dots.map(d => d.x))].sort((a, b) => a - b);
    // по одной семье в каждом году → слот 0: связь на линии 1930, фантом на 1935;
    // столбца у связи два: 3 точки (родители+сын) и 2 точки (супруги)
    if (xs.length !== 2)
        { failed++; console.log('✗ chart бездатный: столбцов точек не 2: ' + xs.join(', ')); }
    if (xs.length === 2) {
        const n0 = dots.filter(d => d.x === xs[0]).length, n1 = dots.filter(d => d.x === xs[1]).length;
        if (n0 !== 3 || n1 !== 2)
            { failed++; console.log('✗ chart бездатный: точки не 3+2 по столбцам: ' + dots.map(d => d.x).join(', ')); }
    }
    // вертикали: родители➝родители и родитель➝сын (1930) + фантом супругов (1935)
    if (m.draws.filter(d => d.k === 'line' && d.w === 1.5).length !== 3)
        { failed++; console.log('✗ chart бездатный: вертикалей не 3'); }
    // якорь бездатного не признаётся «ДР» — «старше ребёнка» не бросает
    try {
        VK.chartModel('x', [{ name: 'Муж', birth: null, anchor: 1920, sex: 'M' },
            { name: 'Жена', birth: null, anchor: 1910, sex: 'F' },
            { name: 'Ребёнок', birth: null, anchor: 1910, sex: 'M' }],
            [{ child: 'Ребёнок 1910', parents: ['Муж 1920', 'Жена 1910'] }]);
    } catch (e) { failed++; console.log('✗ chart: якорь посчитан ДР: ' + e.message); }
    // дубль «Имя + полная дата» больше не бросок: вторая строка получает
    // невидимый суффикс « » и рисуется (две одинаковые строки); явный
    // бездатный ключ этому не мешает; сама модель без фаномов не бросает
    VK.chartModel('y', rows, ln);
    const dupM = VK.chartModel('y', [...rows, { name: 'Сын Т', birth: '1930-03-05', sex: 'M' }], ln);
    const dupNames = dupM.draws.filter(d => d.k === 'text' && d.fill === '#111111').map(d => d.s);
    if (dupNames.filter(s => s === 'Сын Т').length !== 2)
        { failed++; console.log('✗ chart бездатный: дубль не второй строкой: ' + dupNames.join(' | ')); }
}

// ==================== 4. связи: reply-флоу, свадьба, каскад ====================
const CH = 2; // VK peerId = TG chatId
const persons = [
    { n: 'Отец', d: '1955-02-02' },
    { n: 'Мать', d: '1957-04-04', srcH: 3, srcM: 15 },
    { n: 'Дочь', d: '1982-09-09' },
];
const pair = { n: 'Отец+Мать', d: '1980-01-20', plac: 'Пермь' };
VK.clearChatTree(CH);
for (const p of persons) { VK.upsertPerson(CH, p); await TG.upsertPerson(CH, p); }
VK.upsertPerson(CH, pair); await TG.upsertPerson(CH, pair);

// связь родитель→ребёнок (как reply-триггер)
const pk = 'Отец ' + persons[0].d, mk = 'Мать ' + persons[1].d, ck = 'Дочь ' + persons[2].d;
const vkL1 = VK.addLink(CH, pk, ck, 'c').link;
const tgL1 = (await TG.addLink(CH, pk, ck, 'c')).link;
cmp('pairRecords (один родитель)', VK.pairRecords(CH, vkL1), await TG.pairRecords(CH, tgL1));

// второй родитель добирается в ту же fam: семья на ребёнка в обеих сторонах
const vkL2 = VK.addLink(CH, mk, ck, 'c').link;
const tgL2 = (await TG.addLink(CH, mk, ck, 'c')).link;
cmp('двое родителей — одна fam', [VK.famView(CH, vkL1.fam).parents, VK.famView(CH, vkL1.fam).children],
    [(await TG.famView(CH, tgL1.famXref)).parents, (await TG.famView(CH, tgL1.famXref)).children]);
cmp('pairRecords (двое родителей)', VK.pairRecords(CH, vkL2), await TG.pairRecords(CH, tgL2));

// подтвердить свадьбу — сравнить текст связи и фрагмент гедкома
const vkCand = VK.pairRecords(CH, vkL2);
const tgCand = await TG.pairRecords(CH, tgL2);
VK.confirmPair(CH, vkL2, vkCand[0]);
await TG.confirmPair(CH, tgL2, tgCand[0]);
const tgFresh = await TG.linkById(CH, tgL2.id);
cmp('linkText после confirmPair', VK.linkText(CH, vkL2), await TG.linkText(CH, tgFresh));
cmp('gedcomText фрагмент', VK.gedcomText(CH, [pk, mk, ck]), await TG.gedcomText(CH, [pk, mk, ck]));
cmp('gedcomText весь чат', VK.gedcomText(CH), await TG.gedcomText(CH));

// каскад: удалить свадьбу-пару «Отец+Мать» — MARR уходит из семьи,
// кандидаты у оставшихся связей чистятся (как del1/👎 на записи пары)
const pairKey = pair.n + ' ' + pair.d;
const vkCand0 = VK.pairRecords(CH, vkL1);
await TG.setLinkCand(tgL1, vkCand0);
VK.setLinkCand(vkL1, vkCand0);
VK.deleteEventCascade(CH, pairKey);
await TG.deleteEventCascade(CH, pairKey);
const tgL1f = await TG.linkById(CH, tgL1.id);
cmp('linkText: pairCand после удаления пары', VK.linkText(CH, vkL1), await TG.linkText(CH, tgL1f));
cmp('gedcomText: MARR после удаления пары', VK.gedcomText(CH), await TG.gedcomText(CH));

// каскад: удалить персону «Мать» — связи падают, семья остаётся с «Отцом»;
// сама запись удаляется: персон больше нет ни в записи, ни в росписи/поиске
VK.deleteEventCascade(CH, mk);
await TG.deleteEventCascade(CH, mk);
cmp('gedcomText после удаления персоны', VK.gedcomText(CH), await TG.gedcomText(CH));
if (VK.recordOf(CH, mk) !== null || (await TG.recordOf(CH, mk)) !== null)
    { failed++; console.log('✗ каскад: удалённая персона осталась в записях'); }
if (VK.chatFlatText(CH).includes('1957-04-04') || (await TG.chatFlatText(CH)).includes('1957-04-04'))
    { failed++; console.log('✗ каскад: удалённая персона осталась в пачке'); }

// ==================== 4b. тёзки: MARR по xref, не «по первому имени» ========
// отец и сын-тёзка «Пётр Сидоров» 1908/1965; жена 1968; MARR у сына + ребёнок
const CPS = 11;
const gedTz = ['0 HEAD',
    '0 @I1@ INDI', '1 NAME Пётр /Сидоров/', '1 SEX M', '1 BIRT', '2 DATE 5 MAR 1908',
    '0 @I2@ INDI', '1 NAME Пётр /Сидоров/', '1 SEX M', '1 BIRT', '2 DATE 9 AUG 1965',
    '0 @I3@ INDI', '1 NAME Ольга /Фёдорова/', '1 SEX F', '1 BIRT', '2 DATE 2 FEB 1968',
    '0 @I4@ INDI', '1 NAME Дед Друга /Тёзок/', '1 BIRT', '2 DATE 1 DEC 1909',
    '0 @F1@ FAM', '1 CHIL @I2@', '1 HUSB @I1@',
    '0 @F2@ FAM', '1 HUSB @I2@', '1 WIFE @I3@', '1 CHIL @I5@',
    '0 @I5@ INDI', '1 NAME Павел /Сидоров/', '1 BIRT', '2 DATE 5 MAY 1990', '1 FAMS @F5@',
    '0 @F3@ FAM', '1 CHIL @I2@', '1 HUSB @I4@',
    '0 @F4@ FAM', '1 CHIL @I1@', '1 WIFE @I6@',
    '0 @I6@ INDI', '1 NAME Мамчий /Тёзок/', '1 SEX F', '1 BIRT', '2 DATE 1 NOV 1889',
    '0 @F5@ FAM', '1 HUSB @I2@', '1 WIFE @I3@', '1 MARR', '2 DATE 10 JUN 1989', '1 CHIL @I7@',
    '0 @I7@ INDI', '1 NAME Павел /Сидоров/', '1 BIRT', '2 DATE 5 MAY 1990', '0 TRLR'].join('\n');
// СХЕМА: @I1@ и @I2@ — тёзки-фамилии; @I2@ (сын 1965) женат на @I3@; MARR —
// только в @F5@ (семья сына). Пара в выводе — лишь [сын, жена]: тёзка-отец
// (1908) не перехватывает свадьбу сына даже без SEX.
const gTz = VK.parseGedcom(gedTz);
const vkTz = VK.importGedcom(CPS, gTz);
const tgTz = await TG.importGedcom(CPS, gTz);
cmp('тёзки: отчёт импорта', vkTz, tgTz);
const vkW = VK.weddingRows(CPS), tgW = await TG.weddingRows(CPS);
cmp('тёзки: свадьба одна и у сына', [vkW.length, vkW.map(w => w.n)],
    [tgW.length, tgW.map(w => w.n)]);
if (JSON.stringify(vkW.map(w => w.n)) !== JSON.stringify(['Пётр Сидоров+Ольга Фёдорова'])) {
    failed++;
    console.log('✗ тёзки: свадьба прилипла не туда\n  ' + JSON.stringify(vkW.map(w => w.n)));
}
cmp('тёзки: гедком целиком', VK.gedcomText(CPS), await TG.gedcomText(CPS));
// «предок-тёзка», сам с MARR-семой в другом: still — точная пара
const vkP = VK.famList(CPS);
cmp('тёзки: famList без слипания', vkP, await TG.famList(CPS));
if (vkP.length !== 5) { failed++; console.log('✗ тёзки: fams ' + vkP.length + ', ожидается 5'); }
// подтверждение по xref: кандидат-линк связывает точную пару, не тёзку
const vkPk = 'Пётр Сидоров 1965-08-09', ckc = 'Павел Сидоров 1990-05-05',
    vl2k = 'Ольга Фёдорова' + ' 1968-02-02';
const vkL2b = VK.addLink(CPS, vl2k, ckc, 'c').link;
const tgL2b = (await TG.addLink(CPS, vl2k, ckc, 'c')).link;
if (!vkL2b) { failed++; console.log('✗ тёзки: линк не создан'); }
const vkLP = VK.pairRecords(CPS, vkL2b), tgLP = await TG.pairRecords(CPS, tgL2b);
cmp('тёзки: кандидаты пары', vkLP, tgLP);
VK.confirmPair(CPS, vkL2b, vkLP[0]);
await TG.confirmPair(CPS, tgL2b, tgLP[0]);
cmp('тёзки: гедком после confirmPair', VK.gedcomText(CPS), await TG.gedcomText(CPS));
// sent переживает замену (VK-only: запись планировщика по ключу остаётся)
VKX.qr('INSERT OR REPLACE INTO sent(chat,key,last_year) VALUES(?,?,?)', CPS, vkPk, 2020);
VK.importGedcom(CPS, VK.parseGedcom(gedTz));
const sentRow = VKX.q1('SELECT last_year FROM sent WHERE chat=? AND key=?', CPS, vkPk);
if (!sentRow || sentRow.last_year !== 2020) { failed++; console.log('✗ sent не пережил замену'); }
// дубль fam: ребёнок с двумя FAMC → две fam (не слипаются в одну)
const g2f = VK.parseGedcom(['0 HEAD',
    '0 @I1@ INDI', '1 NAME Ребёнок /Двухсемейный/', '1 BIRT', '2 DATE 1 JAN 1980',
    '0 @I2@ INDI', '1 NAME Мать1 /Один/', '1 SEX F', '1 BIRT', '2 DATE 1 JAN 1950',
    '0 @I3@ INDI', '1 NAME Мать2 /Два/', '1 SEX F', '1 BIRT', '2 DATE 1 JAN 1952',
    '0 @F1@ FAM', '1 CHIL @I1@', '1 WIFE @I2@',
    '0 @F2@ FAM', '1 CHIL @I1@', '1 WIFE @I3@', '0 TRLR'].join('\n'));
const CH2 = 12;
VK.clearChatTree(CH2);
VK.importGedcom(CH2, g2f);
await TG.importGedcom(CH2, g2f);
cmp('две FAMC: fams', VK.famList(CH2).length, (await TG.famList(CH2)).length);
if (VK.famList(CH2).length !== 2) { failed++; console.log('✗ две FAMC: fams != 2'); }
cmp('две FAMC: гедком', VK.gedcomText(CH2), await TG.gedcomText(CH2));

// ==================== 9. chartPdf: гедком-древо → PDF ====================
cmp('b64ToBytes (префикс с «=» и переносом)',
    [...VK.b64ToBytes('QUJDREVG//4=')].join(','),
    [...TGC.b64ToBytes('QUJDREVG//4=')].join(','));
cmp('parseTtf метрики', VK.parseTtf(FONT), TGC.parseTtf(FONT));
// имя файла из заголовка: кейкап остаётся, эмодзи/разделители уходят, ≤ 64
const FB_CASES = [
    '1 Пётр I Алексеевич Великий Романов 1672-05-30',
    '🧬 Гедком-древо чата',
    'a/b\\c:d*e?f"g<h>i|j#k',
    'Имя с  точками...  и \n переносами ',
    'В'.repeat(100),
    '///',
    '',
];
for (const c of FB_CASES) cmp('fileBaseOf ' + JSON.stringify(c.slice(0, 30)), VK.fileBaseOf(c), TGC.fileBaseOf(c));
if (VK.fileBaseOf(FB_CASES[0]) !== '1 Пётр I Алексеевич Великий Романов 1672-05-30')
    { failed++; console.log('✗ fileBaseOf: кейкап-префикс не сохранён\n  ' + VK.fileBaseOf(FB_CASES[0])); }
if (VK.fileBaseOf(FB_CASES[1]) !== 'Гедком-древо чата')
    { failed++; console.log('✗ fileBaseOf: 🧬 не убран\n  ' + VK.fileBaseOf(FB_CASES[1])); }
if ([...VK.fileBaseOf(FB_CASES[4])].length !== 64 || VK.fileBaseOf(FB_CASES[5]) !== 'tree' || VK.fileBaseOf(FB_CASES[6]) !== 'tree')
    { failed++; console.log('✗ fileBaseOf: обрезка 64/фолбэк tree\n  ' + VK.fileBaseOf(FB_CASES[4]).length + ', ' + JSON.stringify(VK.fileBaseOf(FB_CASES[5])) + ', ' + JSON.stringify(VK.fileBaseOf(FB_CASES[6]))); }
// краевые случаи: без смерти (бар до края), точечный бар birth==death,
// близнецы-годы разных семей (цвета без коллизий), один родитель, без пола
const CHART_ROWS = [
    { name: 'Пётр I', birth: '1672-06-09', death: '1725-02-08', sex: 'M' },
    { name: 'Екатерина I', birth: '1684-05-04', death: '1727-05-17', sex: 'F' },
    { name: 'Алексей Петрович', birth: '1690-02-28', death: '1718-07-07', sex: 'M' },
    { name: 'Елизавета Петровна', birth: '1709-12-29', death: '1762-01-05', sex: 'F' },
    { name: 'Павел Петрович', birth: '1691-09-13', death: '1691-09-13', sex: 'M' }, // бар-точка
    { name: 'Без Смерти', birth: '1700-01-01', death: null, sex: null },            // бар до края
];
const CHART_LINKS = [
    { child: 'Алексей Петрович 1690-02-28', parents: ['Пётр I 1672-06-09', 'Евдокия 1669-11-06'] },
    { child: 'Елизавета Петровна 1709-12-29', parents: ['Пётр I 1672-06-09', 'Екатерина I 1684-05-04'] },
    { child: 'Павел Петрович 1691-09-13', parents: ['Пётр I 1672-06-09'] }, // один родитель
];
CHART_ROWS.push({ name: 'Евдокия', birth: '1669-11-06', death: '1731-05-11', sex: 'F' });
// близнецы-год: две семьи, дети родились в один год — вертикали разных цветов
const TWIN_ROWS = [
    { name: 'Пётр I', birth: '1672-06-09', death: '1725-02-08', sex: 'M' },
    { name: 'Екатерина I', birth: '1684-05-04', death: '1727-05-17', sex: 'F' },
    { name: 'Тест близнецов 1', birth: '1710-01-01', death: '1720-01-01', sex: 'M' },
    { name: 'Тест близнецов 2', birth: '1710-01-01', death: '1762-01-05', sex: 'F' },
    { name: 'Екатерина Ивановна', birth: '1691-02-02', death: '1733-01-01', sex: 'F' },
    { name: 'Иван V', birth: '1666-08-27', death: '1696-02-08', sex: 'M' },
    { name: 'Прасковья', birth: '1664-10-10', death: '1731-01-01', sex: 'F' },
];
const TWIN_LINKS = [
    { child: 'Тест близнецов 1 1710-01-01', parents: ['Пётр I 1672-06-09', 'Екатерина I 1684-05-04'] },
    { child: 'Тест близнецов 2 1710-01-01', parents: ['Пётр I 1672-06-09', 'Екатерина I 1684-05-04'] },
    { child: 'Екатерина Ивановна 1691-02-02', parents: ['Иван V 1666-08-27', 'Прасковья 1664-10-10'] },
];
for (const [t, rows, ln] of [
    ['Пётр I: линии жизни', CHART_ROWS, CHART_LINKS],
    ['близнецы: две семьи, один год', TWIN_ROWS, TWIN_LINKS],
]) {
    cmp('chartModel «' + t + '»', VK.chartModel(t, rows, ln), TGC.chartModel(t, rows, ln));
    cmp('chartPdf «' + t + '» (байты)', VK.chartPdf(t, rows, ln, FONT), TGC.chartPdf(t, rows, ln, FONT));
}
// Декады в две строки: век над последними двумя цифрами, включая 00.
{
    const rows = [{ name: 'Axis', birth: '1960-01-01', death: '2030-01-01', sex: 'M' }];
    const m = VK.chartModel('axis', rows, []);
    cmp('chartModel двухстрочная шкала', m, TGC.chartModel('axis', rows, []));
    const ticks = m.draws.filter(d => d.k === 'line' && d.stroke === '#888888' && d.x1 === d.x2);
    const labels = m.draws.filter(d => d.k === 'text' && d.fill === '#666666' && d.anchor === 'mid');
    const years = ticks.map(t => labels.filter(d => d.x === t.x1).sort((a, b) => a.y - b.y));
    if (!ticks.length || labels.length !== ticks.length * 2 || years.some(ds => ds.length !== 2
        || ds[0].y !== m.H - 20 || ds[1].y !== m.H - 8
        || ds.some(d => !/^\d{2}$/.test(d.s) || d.size !== 10)))
        { failed++; console.log('✗ chart.axis: не две центрированные строки на декаду'); }
    const joined = years.map(ds => ds.map(d => d.s).join(''));
    if (['1960', '1970', '2000', '2020', '2030'].some(y => !joined.includes(y)))
        { failed++; console.log('✗ chart.axis: потеряны декады/ведущий ноль: ' + joined.join(', ')); }
    // Высокий чарт: нижняя строка шкалы остаётся внутри последней PDF-полосы.
    const tallRows = Array.from({ length: 100 }, (_, i) => ({ ...rows[0], name: 'Axis ' + i }));
    const tall = VK.chartModel('axis tall', tallRows, []);
    const tallPdf = VK.chartPdf('axis tall', tallRows, [], FONT);
    cmp('chartPdf многостраничная двухстрочная шкала', tallPdf, TGC.chartPdf('axis tall', tallRows, [], FONT));
    if ((tallPdf.match(/\/Type \/Page[^s]/g) || []).length < 2
        || tall.draws.some(d => d.k === 'text' && d.fill === '#666666' && (d.y <= tall.H - 42 || d.y >= tall.H)))
        { failed++; console.log('✗ chart.axis: пагинация/нижнее поле двухстрочной шкалы'); }
}
// разные пары с детьми в один год (+ фантом в тот же год): вертикали
// вместо дуг — каждая следующая семья на толщину линии (1.5) правее
// вместе с точками (детская точка в баре); близнецы одной семьи — одна вертикаль
const MULTI_ROWS = [
    { name: 'Пётр I', birth: '1672-06-09', death: '1725-02-08', sex: 'M' },
    { name: 'Екатерина I', birth: '1684-05-04', death: '1727-05-17', sex: 'F' },
    { name: 'Иван V', birth: '1666-08-27', death: '1696-02-08', sex: 'M' },
    { name: 'Прасковья', birth: '1664-10-10', death: '1731-01-01', sex: 'F' },
    { name: 'Евдокия', birth: '1669-11-06', death: '1731-05-11', sex: 'F' },
    { name: 'Анна Петровна', birth: '1708-01-27', death: '1728-05-04', sex: 'F' },
    { name: 'Елизавета Петровна', birth: '1708-06-18', death: '1728-05-04', sex: 'F' },
    { name: 'Мария Ивановна', birth: '1708-07-31', death: '1733-01-01', sex: 'F' },
];
const MULTI_LINKS = [
    { child: 'Анна Петровна 1708-01-27', parents: ['Пётр I 1672-06-09', 'Екатерина I 1684-05-04'] },
    { child: 'Елизавета Петровна 1708-06-18', parents: ['Пётр I 1672-06-09', 'Екатерина I 1684-05-04'] }, // близнецы
    { child: 'Мария Ивановна 1708-07-31', parents: ['Иван V 1666-08-27', 'Прасковья 1664-10-10'] },
];
const MULTI_PH = { phantoms: [{ fam: ['Пётр I 1672-06-09', 'Евдокия 1669-11-06'], years: [1708] }] };
cmp('chartModel «две семьи, один год»', VK.chartModel('m', MULTI_ROWS, MULTI_LINKS, MULTI_PH),
    TGC.chartModel('m', MULTI_ROWS, MULTI_LINKS, MULTI_PH));
cmp('chartPdf «две семьи, один год» (байты)', VK.chartPdf('m', MULTI_ROWS, MULTI_LINKS, FONT, MULTI_PH),
    TGC.chartPdf('m', MULTI_ROWS, MULTI_LINKS, FONT, MULTI_PH));
// вертикали без дуг; семья-слот = +1.5px вправо; близнецы — одна вертикаль;
// детская точка в баре: минимум пучка = x начала баров детей 1708 года
{
    const m = VK.chartModel('m', MULTI_ROWS, MULTI_LINKS, MULTI_PH);
    const vert = m.draws.filter(d => d.k === 'line' && d.w === 1.5);
    const xs = [...new Set(vert.map(d => d.x1))].sort((a, b) => a - b);
    if (m.draws.some(d => d.k === 'qarc'))
        { failed++; console.log('✗ chart: дуга вместо вертикали'); }
    if (vert.some(d => d.x1 !== d.x2))
        { failed++; console.log('✗ chart: связь не вертикаль'); }
    if (xs.length !== 3 || xs.slice(1).some((x, i) => Math.abs(x - xs[i] - 1.5) > 0.01))
        { failed++; console.log('✗ chart: семьи-год не на толщину линии: ' + xs.join(', ')); }
    const cnt = new Map();
    for (const d of m.draws) if (d.k === 'rrect') cnt.set(d.x, (cnt.get(d.x) || 0) + 1);
    const barX = [...cnt].find(([, n]) => n === 3)?.[0];
    if (barX === undefined || Math.min(...xs) !== barX || xs.some(x => x < barX))
        { failed++; console.log('✗ chart: пучок не вправо от линии года (бар ' + barX + ', x ' + xs.join(', ') + ')'); }
    if (m.draws.filter(d => d.k === 'dot').some(d => !xs.includes(d.x)))
        { failed++; console.log('✗ chart: точка вне x своей семьи'); }
}
// колонка «Связь год» к герою (ярлыки как в 🔔-списке); у героя с rel.range
// («диапазон» радиуса из кейкапа) — 1 родители-дети, 2 деды-внуки, 4 пра2…
const REL = {
    hero: 'Пётр I 1672-06-09',
    range: 4,
    pairs: CHART_LINKS.flatMap(l => l.parents.map(p => [p, l.child])),
    spouses: [['Евдокия 1669-11-06', 'Пётр I 1672-06-09']],
    sex: Object.fromEntries(CHART_ROWS.map(r => [r.name + ' ' + r.birth, r.sex || null])),
};
cmp('chartModel «Пётр I: ярлыки родства»', VK.chartModel('s', CHART_ROWS, CHART_LINKS, REL),
    TGC.chartModel('s', CHART_ROWS, CHART_LINKS, REL));
cmp('chartPdf rel (байты)', VK.chartPdf('s', CHART_ROWS, CHART_LINKS, FONT, REL),
    TGC.chartPdf('s', CHART_ROWS, CHART_LINKS, FONT, REL));
// фантомные рождения: дети супругов вне чарта — вертикали между супругами
const PH = { phantoms: [{ fam: ['Пётр I 1672-06-09', 'Екатерина I 1684-05-04'], years: [1708, 1712] },
    { fam: ['Пётр I 1672-06-09', 'Екатерина I 1684-05-04'], years: [1700] },
    { fam: ['Пётр I 1672-06-09', 'Евдокия 1669-11-06'], years: [1695] }] };
cmp('chartModel фантомы', VK.chartModel('f', CHART_ROWS, CHART_LINKS, PH),
    TGC.chartModel('f', CHART_ROWS, CHART_LINKS, PH));
cmp('chartPdf фантомы (байты)', VK.chartPdf('f', CHART_ROWS, CHART_LINKS, FONT, PH),
    TGC.chartPdf('f', CHART_ROWS, CHART_LINKS, FONT, PH));
cmp('chartPdf rel+фантомы (байты)', VK.chartPdf('s', CHART_ROWS, CHART_LINKS, FONT, { ...REL, ...PH }),
    TGC.chartPdf('s', CHART_ROWS, CHART_LINKS, FONT, { ...REL, ...PH }));
// свадьба с супругом вне чарта (второй вне радиуса): зарубка на баре
// присутствующего — вертикаль вниз cy…cy+8, без точек (как хвост фантома)
const MARRY1 = [{ fam: ['Елизавета Петровна 1709-12-29'], year: 1727 },
    { fam: ['Пётр I 1672-06-09', 'Екатерина I 1684-05-04'], year: 1712 }];
cmp('chartModel свадьба-зарубка', VK.chartModel('w', CHART_ROWS, CHART_LINKS, null, MARRY1),
    TGC.chartModel('w', CHART_ROWS, CHART_LINKS, null, MARRY1));
cmp('chartPdf свадьба-зарубка (байты)', VK.chartPdf('w', CHART_ROWS, CHART_LINKS, FONT, null, MARRY1),
    TGC.chartPdf('w', CHART_ROWS, CHART_LINKS, FONT, null, MARRY1));
{
    const ticks = VK.chartModel('w', CHART_ROWS, CHART_LINKS, null, MARRY1)
        .draws.filter(d => d.k === 'line' && d.y2 - d.y1 === 8 && d.x2 === d.x1);
    if (ticks.length !== 1)
        { failed++; console.log('✗ chart.marry1: зарубка свадьбы не одна\n  ' + JSON.stringify(ticks)); }
    if (VK.chartModel('w', CHART_ROWS, CHART_LINKS, null, [{ fam: ['Елизавета Петровна 1709-12-29', 'Кто-то 1700-01-01'], year: 1727 }])
        .draws.some(d => d.k === 'line' && d.y2 - d.y1 === 8))
        { failed++; console.log('✗ chart.marry1: парная свадьба не должна давать зарубку'); }
}
{
    const m = VK.chartModel('s', CHART_ROWS, CHART_LINKS, REL);
    const col = m.draws.filter(d => d.k === 'text' && d.fill === '#333333' && d.anchor === 'end').map(d => d.s);
    if (!col.some(s => /(жена|муж|мать|отец|сын|дочь|брат|сестра) \d{4}$/.test(s)))
        { failed++; console.log('✗ chart.rel: нет ярлыков «Связь год»\n  ' + col.join(' | ')); }
    if (col.some(s => s.includes('NaN')))
        { failed++; console.log('✗ chart.rel: NaN в ярлыках\n  ' + col.join(' | ')); }
    // диапазон в строке героя: остальные строки — прежние ярлыки
    const heroCol = m.draws.filter(d => d.k === 'text' && d.fill === '#333333' && d.anchor === 'end')
        .filter(d => /1672$/.test(d.s));
    if (!heroCol.some(d => d.s.startsWith('пра2деды-пра2внуки')))
        { failed++; console.log('✗ chart.rel: у героя нет «пра2деды-пра2внуки»\n  ' + col.join(' | ')); }
    const noRel = VK.chartModel('s', CHART_ROWS, CHART_LINKS);
    const colN = noRel.draws.filter(d => d.k === 'text' && d.fill === '#333333' && d.anchor === 'end').map(d => d.s);
    if (!colN.every(s => /^\d{4}$/.test(s)))
        { failed++; console.log('✗ chart.rel: без героя колонка не «Год»: ' + colN.filter(s => !/^\d{4}$/.test(s)).join(' | ')); }
}
// sanity PDF: заголовок/шрифт/страницы согласованы с моделью
const pdf = VK.chartPdf('Пётр I: линии жизни', CHART_ROWS, CHART_LINKS, FONT);
const model = VK.chartModel('Пётр I: линии жизни', CHART_ROWS, CHART_LINKS);
const scale = 842 / model.W;
const wantPages = Math.max(1, Math.ceil((model.H - 42) / (595 / scale - 42) - 1e-9));
const gotPages = (pdf.match(/\/Type \/Page[^s]/g) || []).length;
if (!pdf.startsWith('%PDF-1.4\n') || !pdf.includes('/Subtype /Type0') || !pdf.includes('/FontFile2'))
    { failed++; console.log('✗ chartPdf: нет заголовка PDF/встроенного шрифта'); }
if (gotPages !== wantPages)
    { failed++; console.log('✗ chartPdf: страниц ' + gotPages + ', ожидалось ' + wantPages); }
// две семьи одного года — вертикали разных цветов (главное требование отличимости)
const twin = VK.chartPdf('близнецы', TWIN_ROWS, TWIN_LINKS, FONT);
const trip = h => [1, 3, 5].map(i => Math.round(parseInt(h.slice(i, i + 2), 16) / 255 * 1000) / 1000).join(' ');
const famSet = new Set([...twin.matchAll(/1\.5 w ([\d.]+ [\d.]+ [\d.]+) RG/g)].map(m2 => m2[1]));
if (famSet.size !== 2)
    { failed++; console.log('✗ chartPdf: близнецы-год не различён — вертикали ' + [...famSet].join(' | ')); }
for (const t of famSet) if (!['#911eb4', '#e0cc33', '#e6194b', '#ff9d45', '#3584cc', '#3cb44b', '#f032e6'].map(trip).includes(t))
    { failed++; console.log('✗ chartPdf: цвет связи вне палитры: ' + t); }
// ассерты: 3 родителя, родитель моложе ребёнка, неизвестное имя (точный дубль
// строки больше не бросок — он проверяется позитивно в разделе 3в)
const ASSERTS = [
    ['три родителя', { ...CHART_LINKS[1], parents: [...CHART_LINKS[1].parents, 'Пётр I 1672-06-09'] }, CHART_ROWS],
    ['родитель моложе', { ...CHART_LINKS[0], parents: ['Елизавета Петровна 1709-12-29', 'Екатерина I 1684-05-04'] }, CHART_ROWS],
    ['имя не найдено', { ...CHART_LINKS[0], parents: ['Немо 1650', 'Екатерина I 1684-05-04'] }, CHART_ROWS],
];
for (const [what, ln, rows] of ASSERTS) {
    let vkE = '', tgE = '';
    try { VK.chartPdf('ассерты', rows, Array.isArray(ln) ? ln : [ln], FONT); } catch (e) { vkE = e.message; }
    try { TGC.chartPdf('ассерты', rows, Array.isArray(ln) ? ln : [ln], FONT); } catch (e) { tgE = e.message; }
    cmp('chartPdf assert «' + what + '»', vkE, tgE);
    if (!vkE) { failed++; console.log('✗ chartPdf assert «' + what + '»: не бросил ошибку'); }
}
// Diagnostics collect independent failures without rendering or throwing.
{
    const rows = [
        { name: 'Child', birth: '2000-01-01', death: '1999-01-01' },
        { name: 'Young', birth: '2001-01-01' },
        { name: 'Older', birth: '1970-01-01' },
    ];
    const death = 'смерть раньше рождения Child 2000-01-01';
    const young = 'родитель не старше ребёнка Young 2001-01-01 → Child 2000-01-01';
    const count = 'родителей не 1–2 Child 2000-01-01';
    const badFont = new Uint8Array(12);
    assert.throws(() => TGC.parseTtf(badFont), /ttf: нет обязательных таблиц/);
    const cases = [
        ['valid', rows.slice(1), [], FONT, []],
        ['empty', [], [], null, ['персоны пусты']],
        ['unanchored only', [{ name: 'Hidden', birth: null }], [], null, ['персоны пусты']],
        ['death before birth', rows, [], null, [death]],
        ['younger parent', rows.slice(1).concat({ ...rows[0], death: null }),
            [{ child: 'Child 2000-01-01', parents: ['Young 2001-01-01'] }], null, [young]],
        ['no parents', [{ ...rows[0], death: null }],
            [{ child: 'Child 2000-01-01', parents: [] }], null, [count]],
        ['missing child and parents', rows.slice(1),
            [{ child: 'Missing child', parents: ['Missing parent', 'Other missing parent'] }], null,
            ['имя не найдено Missing child', 'имя не найдено Missing parent', 'имя не найдено Other missing parent']],
        ['anchored parent is not a factual birth', [
            { name: 'Parent', birth: null, anchor: 2020, death: '1990-01-01' },
            { name: 'Child', birth: null, anchor: 2000 },
        ], [{ child: 'Child 2000', parents: ['Parent 2020'] }], null, []],
        ['bad font', rows.slice(1), [], badFont, ['ttf: нет обязательных таблиц']],
        ['multiple failures, deduplicated', rows, [
            { child: 'Child 2000-01-01', parents: ['Young 2001-01-01', 'Older 1970-01-01', 'Missing parent'] },
            { child: 'Child 2000-01-01', parents: ['Young 2001-01-01'] },
        ], badFont, [death, count, young, 'имя не найдено Missing parent', 'ttf: нет обязательных таблиц']],
    ];
    for (const [label, people, links, font, expected] of cases) {
        const before = structuredClone({ people, links, font });
        assert.deepEqual(TGC.chartDiagnostics(people, links, font), expected, 'chartDiagnostics: ' + label);
        assert.deepEqual({ people, links, font }, before, 'chartDiagnostics does not mutate: ' + label);
    }
}

// Import diagnostics are nonfatal and use all parental families, not just one.
{
    const id = 895100;
    const source = ['0 HEAD',
        '0 @C@ INDI', '1 NAME Diagnostic Child', '1 BIRT', '2 DATE 1 JAN 2000', '1 DEAT', '2 DATE 1 JAN 1999',
        '0 @Y@ INDI', '1 NAME Diagnostic Young', '1 SEX M', '1 BIRT', '2 DATE 1 JAN 2001',
        '0 @P@ INDI', '1 NAME Diagnostic Parent', '1 SEX F', '1 BIRT', '2 DATE 1 JAN 1970',
        '0 @Q@ INDI', '1 NAME Diagnostic Other', '1 SEX M', '1 BIRT', '2 DATE 1 JAN 1972',
        '0 @F1@ FAM', '1 HUSB @Y@', '1 WIFE @P@', '1 CHIL @C@',
        '0 @F2@ FAM', '1 HUSB @Q@', '1 CHIL @C@', '0 TRLR',
    ].join('\n');
    const expected = [
        'смерть раньше рождения Diagnostic Child 2000-01-01',
        'родителей не 1–2 Diagnostic Child 2000-01-01',
        'родитель не старше ребёнка Diagnostic Young 2001-01-01 → Diagnostic Child 2000-01-01',
    ];
    const results = [];
    for (const [platform, api] of [['VK', VK], ['TG', TG]]) {
        const empty = await api.chartFor(id, null, 'empty diagnostics', null, null, true);
        assert.deepEqual(empty, ['персоны пусты'], platform + ': empty diagnostic mode');
        const report = await api.importGedcom(id, TGP.parseGedcom(source));
        assert.deepEqual(report.errors, [], platform + ': diagram failures are not import failures');
        assert.deepEqual(report.chartWarnings, expected, platform + ': all import warnings');
        assert.deepEqual([report.persons, report.fams, report.links], [4, 2, 2]);
        const before = {
            rows: await api.personRows(id), families: await api.famList(id), ged: await api.gedcomText(id),
        };
        assert.deepEqual(await api.chartFor(id, null, 'diagnostics', null, null, true), expected,
            platform + ': sixth argument returns diagnostics instead of rendering');
        assert.deepEqual({ rows: await api.personRows(id), families: await api.famList(id), ged: await api.gedcomText(id) },
            before, platform + ': diagnostic mode preserves database');
        const exported = TGP.parseGedcom(before.ged);
        assert.deepEqual(exported.indis.map(p => [p.__xref, p.name, p.birt.date, p.deat?.date || null]),
            TGP.parseGedcom(source).indis.map(p => [p.__xref, p.name, p.birt.date, p.deat?.date || null]),
            platform + ': factual birth and death dates remain unchanged');
        assert.deepEqual(exported.fams.map(f => [f.__xref, f.husb, f.wife, f.chil]),
            TGP.parseGedcom(source).fams.map(f => [f.__xref, f.husb, f.wife, f.chil]), platform + ': both parental families survive');
        const edges = api === VK ? VK.linkPairs(id) : (await TG.linksAll(id)).map(l => [l.p, l.c]);
        assert.deepEqual(edges.map(([p, c]) => [p, c]).sort(),
            ['Diagnostic Young 2001-01-01', 'Diagnostic Parent 1970-01-01', 'Diagnostic Other 1972-01-01']
                .map(p => [p, 'Diagnostic Child 2000-01-01']).sort(), platform + ': all parent links survive');
        const text = api.treeReport(report);
        for (const warning of expected) assert.ok(text.includes('Диаграмма не построена: ' + warning), platform + ': report ' + warning);
        assert.equal(text.split('Диаграмма не построена: ').length - 1, expected.length);
        results.push({ report, before, text });

        const treeId = id + 1;
        const tree = TGP.parseTree('-Diagnostic Tree 2000-01-01 1999-01-01');
        assert.deepEqual(tree.errors, []);
        const treeReport = await api.applyTree(treeId, tree);
        assert.deepEqual(treeReport.errors, []);
        assert.deepEqual(treeReport.chartWarnings, ['смерть раньше рождения Diagnostic Tree 2000-01-01']);
        const saved = await api.personRows(treeId);
        assert.equal(saved.length, 1);
        assert.deepEqual([saved[0].d, saved[0].dd], ['2000-01-01', '1999-01-01']);
        assert.ok(api.treeReport(treeReport).includes('Диаграмма не построена: ' + treeReport.chartWarnings[0]));
    }
    cmp('importGedcom nonfatal chart diagnostics and preserved data', results[0], results[1]);
}

// бездатный супруг (birth null + anchor — год ДР супруга): левая колонка
// пустая, бар от якоря, «лет прожито» не выводится (год чужой); строка без
// якоря не рисуется; любые коллизии ключей — невидимый суффикс (без броска)
const ANCH_ROWS = [
    { name: 'Пётр I', birth: '1672-06-09', death: '1725-02-08', sex: 'M' },
    { name: 'Мария', birth: null, anchor: 1672, death: '1703-01-01', sex: 'F' },
    { name: 'Без якоря', birth: null, death: '1700-01-01', sex: 'F' },
];
cmp('chartModel бездатный супруг', VK.chartModel('a', ANCH_ROWS, []), TGC.chartModel('a', ANCH_ROWS, []));
cmp('chartPdf бездатный супруг (байты)', VK.chartPdf('a', ANCH_ROWS, [], FONT), TGC.chartPdf('a', ANCH_ROWS, [], FONT));
{
    const m = VK.chartModel('a', ANCH_ROWS, []);
    const left = m.draws.filter(d => d.k === 'text' && d.fill === '#333333' && d.anchor === 'end').map(d => d.s);
    if (left.join('|') !== '|1672')
        { failed++; console.log('✗ chart бездатный: колонка не «пустая|1672»: ' + left.join('|')); }
    if (m.draws.some(d => d.k === 'text' && d.s === '31'))
        { failed++; console.log('✗ chart бездатный: «лет прожито» от якоря (' + 1703 + '-' + 1672 + ')'); }
    const bars = m.draws.filter(d => d.k === 'rrect').map(d => d.x);
    if (bars.length !== 2 || bars[0] !== bars[1])
        { failed++; console.log('✗ chart бездатный: бары не от якорного года: ' + bars.join(', ')); }
}
cmp('chartModel бездатный тёзка-якорь',
    VK.chartModel('d', [...ANCH_ROWS, { name: 'Мария', birth: null, anchor: 1672, death: null, sex: 'F' }], []),
    TGC.chartModel('d', [...ANCH_ROWS, { name: 'Мария', birth: null, anchor: 1672, death: null, sex: 'F' }], []));
{
    // чарт по импорту бездатных: chartFor даёт строку с якорем (VK/TG равны
    // через модель) — бездатная Мария (GS_CH) стоит от 1960 года Ивана
    const rows = [ { name: 'Иван Г', birth: '1960-05-10', death: '2020-05-05', sex: 'M' },
        { name: 'Мария С', birth: null, anchor: 1960, death: '2020-02-03', sex: 'F' },
        { name: 'Ольга Д', birth: '1955-03-01', death: '2001-01-01', sex: 'F' } ];
    cmp('chartModel импорт бездатных', VK.chartModel('c', rows, []), TGC.chartModel('c', rows, []));
}

// ==================== 10. дубли «Имя Д» и примерные даты ====================
// импорт .ged без склейки xref: коллизия ключа «Имя Д» — суффикс «~xref»
// (дата и abt дубля сохраняются, первая запись без суффикса); отчёт росписи —
// «♻️ дубль: … → …»
const GED_DUP = ['0 HEAD',
    '0 @I1@ INDI', '1 NAME Тёзка', '1 BIRT', '2 DATE 1 JAN 1960',
    '0 @I2@ INDI', '1 NAME Тёзка', '1 BIRT', '2 DATE 1960',
    '0 @I3@ INDI', '1 NAME Тёзка', '1 BIRT', '2 DATE ABT 1 JAN 1960',
    '0 @I4@ INDI', '1 NAME Тёзка', '1 BIRT', '2 DATE 1 JAN 1960',      // точный дубль → «~I4»
    '0 @I5@ INDI', '1 NAME Тёзка2', '1 BIRT', '2 DATE 30 DEC 1955',
    '0 @I6@ INDI', '1 NAME Тёзка2', '1 BIRT', '2 DATE ABT 30 DEC 1955', // дубль ABT → «~I6»
    '0 @I7@ INDI', '1 NAME Тёзка3', '1 BIRT', '2 DATE 31 DEC 1955',
    '0 @I8@ INDI', '1 NAME Тёзка3', '1 BIRT', '2 DATE ABT 31 DEC 1955', // дубль ABT → «~I8»
    '0 TRLR'].join('\n');
const DUP_CH = 140;
{
    const vkRep = VK.importGedcom(DUP_CH, VK.parseGedcom(GED_DUP));
    const tgRep = await TG.importGedcom(DUP_CH, TGP.parseGedcom(GED_DUP));
    cmp('importGedcom дубли отчёт', vkRep, tgRep);
    cmp('importGedcom дубли personRows', VK.personRows(DUP_CH), await TG.personRows(DUP_CH));
    cmp('importGedcom дубли report-текст', VK.treeReport(vkRep), TG.treeReport(vkRep));
    const names = VK.personRows(DUP_CH).map(r => r.n + " " + r.d).sort();
    for (const want of [
        'Тёзка 1960-01-01', 'Тёзка ~I2 1960-01-01', 'Тёзка ~I3 1960-01-01',
        'Тёзка ~I4 1960-01-01', 'Тёзка2 1955-12-30', 'Тёзка2 ~I6 1955-12-30',
        'Тёзка3 1955-12-31', 'Тёзка3 ~I8 1955-12-31'])
        if (!names.includes(want)) { failed++; console.log('✗ importGedcom дубли: нет ключа «' + want + '»: ' + names.join(' | ')); }
    // ♻️-строки в отчёте (формат abt: гранулярность — урезание «ГГГГ»/
    // «ГГГГ-ММ», квалификатор — суффикс «?» ABT / «~» EST; даты дублей
    // не сдвигаются)
    const vt = VK.treeReport(vkRep), tt = TG.treeReport(vkRep);
    for (const s of ['♻️ дубль: Тёзка 1960 → Тёзка ~I2 1960',
        '♻️ дубль: Тёзка 1960-01-01? → Тёзка ~I3 1960-01-01?',
        '♻️ дубль: Тёзка 1960-01-01 → Тёзка ~I4 1960-01-01',
        '♻️ дубль: Тёзка2 1955-12-30? → Тёзка2 ~I6 1955-12-30?',
        '♻️ дубль: Тёзка3 1955-12-31? → Тёзка3 ~I8 1955-12-31?'])
        if (!vt.includes(s) || !tt.includes(s)) { failed++; console.log('✗ дубли отчёт: нет строки «' + s + '»\n  ВК: ' + vt.split("\n").filter(x => x.includes("♻️")).join(" | ") + '\n  ТГ: ' + tt.split("\n").filter(x => x.includes("♻️")).join(" | ")); }
    // помощник: точный и примерный сценарии (без коллизии — как есть;
    // резерв — занятый ключ, суффикс из свежего xref, не занятого в БД)
    cmp('uniqueKeyOf без коллизии', VK.uniqueKeyOf(141, 'Иван', '1963-09-27', false, false, 'Z9'),
        await TG.uniqueKeyOf(141, 'Иван', '1963-09-27', true, false, 'Z9'));
    cmp('uniqueKeyOf резерв', VK.uniqueKeyOf(DUP_CH, 'Тёзка', '1960-01-01', false, false, 'Z7'),
        await TG.uniqueKeyOf(DUP_CH, 'Тёзка', '1960-01-01', false, false, 'Z7'));
    cmp('uniqueKeyOf примерный резерв', VK.uniqueKeyOf(DUP_CH, 'Тёзка', '1960-01-01', true, false, 'Z8'),
        await TG.uniqueKeyOf(DUP_CH, 'Тёзка', '1960-01-01', true, false, 'Z8'));
}

// примерные даты — юбилеи не оповещаются: примерная свадьба годом через
// upsertWedding (marr_abt), точная — рядом; списки 🔔 скрывают примерные
const W_CH = 142;
{
    const vkW = VK.parseTrigger('Анна+Пётр 1985~').rec;
    const vkW2 = VK.parseTrigger('Зина+Олег 1985-04-02').rec;
    const tgW = TGP.parseTrigger('Анна+Пётр 1985~').rec;
    const tgW2 = TGP.parseTrigger('Зина+Олег 1985-04-02').rec;
    cmp('wedding abt rec', vkW, tgW);
    VK.upsertPerson(W_CH, vkW); VK.upsertPerson(W_CH, vkW2);
    await TG.upsertPerson(W_CH, tgW); await TG.upsertPerson(W_CH, tgW2);
    cmp('wedding abt weddingRows', VK.weddingRows(W_CH), await TG.weddingRows(W_CH));
    cmp('upcoming byFullDate=true', VK.upcomingEvents(W_CH, true), await TG.upcomingText(W_CH, true));
    cmp('upcoming byFullDate=false скрывает примерную свадьбу',
        VK.upcomingEvents(W_CH, false), await TG.upcomingText(W_CH, false));
    const vkMinus = VK.upcomingEvents(W_CH, false), vkFull = VK.upcomingEvents(W_CH, true);
    if (!vkFull.includes('Анна+Пётр 1985~')) { failed++; console.log('✗ wedding abt: нет в полном списке: ' + vkFull); }
    if (vkFull === vkMinus) { failed++; console.log('✗ wedding abt: списки не различились\nfull: ' + vkFull + '\nminus: ' + vkMinus); }
    cmp('wedding abt famList', VK.famList(W_CH), await TG.famList(W_CH));
    cmp('wedding abt пачка', VK.chatFlatText(W_CH), await TG.chatFlatText(W_CH));
    cmp('wedding abt гедком', VK.gedcomText(W_CH), await TG.gedcomText(W_CH));
}

// round-trip .ged с примерными датами: «1972», «MAR 1980», «ABT 3 APR 1980»
// сохраняют abt (2 год / 1 месяц / 3 ABT-день), год-онли экспортируется
// «2 DATE ГГГГ», месяц — «JUN 1987», ABT-день — «ABT …», ABT-год — «ABT ГГГГ»
const ABT_CH = 143;
{
    const GED_ABT = ['0 HEAD',
        '0 @I1@ INDI', '1 NAME Годик', '1 BIRT', '2 DATE 1972',
        '0 @I2@ INDI', '1 NAME Месяцов', '1 BIRT', '2 DATE MAR 1980',
        '0 @I3@ INDI', '1 NAME Квалификатор', '1 BIRT', '2 DATE ABT 3 APR 1980',
        '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 MARR', '2 DATE ABT 1985',
        '0 TRLR'].join('\n');
    const vkRep = VK.importGedcom(ABT_CH, VK.parseGedcom(GED_ABT));
    const tgRep = await TG.importGedcom(ABT_CH, TGP.parseGedcom(GED_ABT));
    cmp('importGedcom abt отчёт', vkRep, tgRep);
    cmp('importGedcom abt personRows', VK.personRows(ABT_CH), await TG.personRows(ABT_CH));
    cmp('importGedcom abt weddingRows', VK.weddingRows(ABT_CH), await TG.weddingRows(ABT_CH));
    // abt = Q*3+G: 2 — год, 1 — месяц, 3 — ABT-день
    const abts = VK.personRows(ABT_CH).map(r => r.n + ":" + r.abt).join(",");
    if (abts !== 'Годик:2,Месяцов:1,Квалификатор:3') { failed++; console.log('✗ abt-гранулярность: ' + abts); }
    if (VK.weddingRows(ABT_CH)[0].mabt !== 5) { failed++; console.log('✗ abt-гранулярность свадьбы'); }
    cmp('abt гедком', VK.gedcomText(ABT_CH), await TG.gedcomText(ABT_CH));
    cmp('abt пачка', VK.chatFlatText(ABT_CH), await TG.chatFlatText(ABT_CH));
    // round-trip: экспорт → импорт → то же дерево
    const vkGed = VK.gedcomText(ABT_CH), tgGed = await TG.gedcomText(ABT_CH);
    if (!vkGed.includes('2 DATE 1972') || !vkGed.includes('2 DATE ABT 3 APR 1980')
        || !vkGed.includes('2 DATE ABT 1985') || vkGed.includes('2 DATE ABT 1 JAN 1972')
        || !vkGed.includes('2 DATE MAR 1980') || vkGed.includes('2 DATE ABT MAR 1980'))
        { failed++; console.log('✗ abt гедком-экспорт:\n' + vkGed); }
    VK.importGedcom(ABT_CH, VK.parseGedcom(vkGed));
    await TG.importGedcom(ABT_CH, TGP.parseGedcom(tgGed));
    cmp('abt round-trip personRows', VK.personRows(ABT_CH), await TG.personRows(ABT_CH));
    cmp('abt round-trip пачка', VK.chatFlatText(ABT_CH), await TG.chatFlatText(ABT_CH));
}

// квалификаторы CAL/BEF/AFT/EST: импорт гедкома даёт свой abt (6–17), экспорт
// возвращает префикс на любой гранулярности (round-trip без потерь); в тексте —
// суффиксы «~» EST, «<» BEF, «>» AFT
{
    const QL_CH = 147;
    const GED_Q = ['0 HEAD',
        '0 @I1@ INDI', '1 NAME Вычисл', '1 BIRT', '2 DATE CAL 6 MAY 1234',
        '0 @I2@ INDI', '1 NAME Дошел', '1 BIRT', '2 DATE BEF JUN 1900',
        '0 @I3@ INDI', '1 NAME Послен', '1 BIRT', '2 DATE AFT 1940',
        '0 @I4@ INDI', '1 NAME Оценкин', '1 BIRT', '2 DATE EST 3 APR 1980',
        '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 MARR', '2 DATE EST 1985',
        '0 TRLR'].join('\n');
    const vkRep = VK.importGedcom(QL_CH, VK.parseGedcom(GED_Q));
    const tgRep = await TG.importGedcom(QL_CH, TGP.parseGedcom(GED_Q));
    cmp('importGedcom квалификаторы отчёт', vkRep, tgRep);
    cmp('importGedcom квалификаторы personRows', VK.personRows(QL_CH), await TG.personRows(QL_CH));
    const qabts = VK.personRows(QL_CH).map(r => r.n + ":" + r.abt).join(",");
    if (qabts !== 'Вычисл:6,Дошел:10,Послен:14,Оценкин:15')
        { failed++; console.log('✗ квалификаторы abt: ' + qabts); }
    cmp('квалификаторы гедком', VK.gedcomText(QL_CH), await TG.gedcomText(QL_CH));
    const vkGedQ = VK.gedcomText(QL_CH);
    for (const s of ['2 DATE CAL 6 MAY 1234', '2 DATE BEF JUN 1900', '2 DATE AFT 1940',
        '2 DATE EST 3 APR 1980', '2 DATE EST 1985'])
        if (!vkGedQ.includes(s)) { failed++; console.log('✗ квалификаторы экспорт: нет «' + s + '»\n' + vkGedQ); }
    VK.importGedcom(QL_CH, VK.parseGedcom(vkGedQ));
    await TG.importGedcom(QL_CH, TGP.parseGedcom(vkGedQ));
    cmp('квалификаторы round-trip personRows', VK.personRows(QL_CH), await TG.personRows(QL_CH));
    cmp('квалификаторы round-trip пачка', VK.chatFlatText(QL_CH), await TG.chatFlatText(QL_CH));
    // суффиксы в тексте: «~» EST (15), «<» BEF (9), «>» AFT (12)
    for (const [txt, d, abt] of [['Оценка 1980-04-03~', '1980-04-03', 15],
        ['Раньше 1980-04-03<', '1980-04-03', 9], ['Позже 1980-04-03>', '1980-04-03', 12],
        ['Раньше-год 1980<', '1980-01-01', 11], ['Позже-год 1980>', '1980-01-01', 14]]) {
        const [qv, qt] = [VK.parseTrigger(txt).rec, TGP.parseTrigger(txt).rec];
        if (JSON.stringify(qv) !== JSON.stringify(qt))
            { failed++; console.log('✗ суффикс «' + txt + '»: ' + JSON.stringify(qv) + ' vs ' + JSON.stringify(qt)); }
        if (qv.d !== d || qv.abt !== abt)
            { failed++; console.log('✗ суффикс «' + txt + '» разбор: ' + JSON.stringify(qv)); }
    }
}

// гранулярность примерных дат в росписи/вводе: месяц — «ГГГГ-ММ» (а не
// «ГГГГ-ММ-01~»), компактная «198706» разбирается, «JAN 1987» == «1987-01»
{
    const GR_CH = 144;
    const P = s => [VK.parseTrigger(s).rec, TGP.parseTrigger(s).rec];
    const expect = (name, rec, d, abt) => {
        if (rec.d !== d || rec.abt !== abt) { failed++; console.log('✗ ' + name + ': ' + JSON.stringify(rec)); }
    };
    const [pv, pt] = P("Месяц1 1987-06");
    if (JSON.stringify(pv) !== JSON.stringify(pt)) { failed++; console.log('✗ 1987-06: ' + JSON.stringify(pv) + ' vs ' + JSON.stringify(pt)); }
    expect("1987-06 разбор", pv, "1987-06-01", 1);
    const [cv, ct] = P("Месяц2 198706");
    if (JSON.stringify(cv) !== JSON.stringify(ct)) { failed++; console.log('✗ 198706: ' + JSON.stringify(cv) + ' vs ' + JSON.stringify(ct)); }
    expect("198706 разбор", cv, "1987-06-01", 1);
    const [tv, tt] = P("Годовик 1987");
    if (JSON.stringify(tv) !== JSON.stringify(tt)) { failed++; console.log('✗ 1987: ' + JSON.stringify(tv) + ' vs ' + JSON.stringify(tt)); }
    expect("1987 разбор", tv, "1987-01-01", 2);
    // JAN 1987 (гедком) и «1987-01» — одно и то же в БД: {1987-01-01, abt 1} —
    // проверяем через импорт гедкома в обеих сторонах
    const GED_JAN = ['0 HEAD',
        '0 @I1@ INDI', '1 NAME Январка', '1 BIRT', '2 DATE JAN 1987',
        '0 @I2@ INDI', '1 NAME Квалифик', '1 BIRT', '2 DATE ABT 15 JUN 1987',
        '0 TRLR'].join('\n');
    VK.importGedcom(GR_CH + 2, VK.parseGedcom(GED_JAN));
    await TG.importGedcom(GR_CH + 2, TGP.parseGedcom(GED_JAN));
    cmp('JAN/ABT гедком-импорт', VK.personRows(GR_CH + 2), await TG.personRows(GR_CH + 2));
    const jabs = VK.personRows(GR_CH + 2).map(r => r.n + ":" + r.abt + ":" + r.d).join(",");
    if (jabs !== 'Январка:1:1987-01-01,Квалифик:3:1987-06-15')
        { failed++; console.log('✗ JAN/ABT Гранулярность: ' + jabs); }
    // реальный цикл «роспись → древо → роспись»: месяц печатается без «-01» и «~»
    const TREE = ["- Имя 1970-01-01", "+ 1987-06", "Тёзка 1987-06", "-", "Пол 1990"].join('\n');
    cmp('applyTree месяцы отчёт', VK.applyTree(GR_CH, VK.parseTree(TREE)),
        await TG.applyTree(GR_CH, TGP.parseTree(TREE)));
    cmp('applyTree месяцы пачка', VK.chatFlatText(GR_CH), await TG.chatFlatText(GR_CH));
    const vkFlat = VK.chatFlatText(GR_CH);
    if (!vkFlat.includes("Тёзка 1987-06") || vkFlat.includes("1987-06-01"))
        { failed++; console.log('✗ месяц в пачке:\n' + vkFlat); }
    // компактная «198706» — та же свадьба 1987-06
    const TREE2 = ["- Имя 1970-01-01", "+ 198706", "Тёзка 199006"].join('\n');
    const vkRep2 = VK.applyTree(GR_CH + 1, VK.parseTree(TREE2));
    cmp('applyTree 198706 отчёт', vkRep2, await TG.applyTree(GR_CH + 1, TGP.parseTree(TREE2)));
    cmp('applyTree 198706 пачка', VK.chatFlatText(GR_CH + 1), await TG.chatFlatText(GR_CH + 1));
    if (JSON.stringify(vkRep2.errors) !== "[]") { failed++; console.log('✗ 198706: ' + JSON.stringify(vkRep2.errors)); }
}

if (failed) { console.log('\n✗ расхождений: ' + failed); process.exit(1); }
console.log('✓ ВК и ТГ синхронны (' + (TRIGGERS.length + TREE_TRIGGERS.length) + ' триггеров, гедком-импорт/экспорт, дубли/примерные, плоское древо, связи/семьи/каскад, chartPdf)');
