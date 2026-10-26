#!/usr/bin/env node
// dev/sync-check.mjs — проверка синхронности чистой логики ВК (lunarreturns.js)
// и ТГ (tgcloud/lib): обе стороны исполняются на одинаковых сценариях
// (parseTrigger, parseGedcom, гедком-импорт/экспорт, связи/семьи/каскад) и
// результаты сравниваются дословно. Расхождение → вывод diff и exit 1.
// Использование: node dev/sync-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';
import { createRequire } from 'node:module';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-sync-'));

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
const TGP = await import(path.join(ROOT, 'tgcloud', 'lib', 'parse.js'));

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
// 1662-03-01 (первым числом известного месяца/года, квалификатор срезан)
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

// ========================= 1б. плоское древо =========================
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
// плоское древо чата (формат пачки — тап на колокольчик): вывод идентичен
cmp('applyTree chatFlatText', VK.chatFlatText(TREE_CH), await TG.chatFlatText(TREE_CH));
cmp('applyTree повтор chatFlatText', VK.chatFlatText(TREE_CH), await TG.chatFlatText(TREE_CH));

// примечания с маркером «^» (дата в начале — не смерть/развод; внутренние
// «^» — переносы строк NOTE гедкома): вывод пачки всегда с «^», реимпорт
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
// round-trip: реимпорт выведенной пачки идемпотентен (примечание и смерти
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

// ===================== 4б. ветвь героя: резка-прививка =====================
// «-+=» на фокусе — пачка ветви: поддерево потомков на всю глубину, герой
// корневой строкой; вывод обеих копий — дословно (чистая subsetBranch)
const vkBranch = VK.branchFlatText(TREE_CH, 'Фёдор III 1661-06-09');
const tgBranch = await TG.branchFlatText(TREE_CH, 'Фёдор III 1661-06-09');
cmp('branchFlatText «Фёдор III»', vkBranch, tgBranch);
if (!vkBranch || !vkBranch.startsWith('-Фёдор III 1661-06-09 1682-04-27')) {
    failed++;
    console.log('✗ пачка ветви не начинается с корневой строки героя\n  ' + vkBranch);
}
// пачка в ответе на цитату = резка-прививка (cutAndGraft): ветвь цитируемого
// срезана молча, поля героя (в т.ч. имя) обновлены первой строкой пачки,
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
// якорь не найден — пачка применяется без среза (добавление merge'ем)
const vkRepM = VK.cutAndGraft(TREE_CH, 'Нет-Такого-Человека 1690-01-01', VK.parseTree(TREE1));
const tgRepM = await TG.cutAndGraft(TREE_CH, 'Нет-Такого-Человека 1690-01-01', TGP.parseTree(TREE1));
cmp('cutAndGraft без якоря', vkRepM, tgRepM);

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
// коллизия: правка на существующее имя+дату отклоняется, древо не меняется
const vkColl = VK.editTrigger(TREE_CH, 'Фёдор Алексеевич 1661-06-09', { n: 'Агафья Анна', d: '1663-01-01' });
const tgColl = await TG.editTrigger(TREE_CH, 'Фёдор Алексеевич 1661-06-09', { n: 'Агафья Анна', d: '1663-01-01' });
cmp('editTrigger коллизия', vkColl, tgColl);
if (!vkColl || !vkColl.error) { failed++; console.log('✗ editTrigger: коллизия не отклонена'); }
// якорь не найден — null (правки нет, транспорт ведёт как обычный ввод)
cmp('editTrigger мимо якоря',
    VK.editTrigger(TREE_CH, 'Нет-Такого 1690-01-01', { n: 'Имя', d: '1690-01-01' }),
    await TG.editTrigger(TREE_CH, 'Нет-Такого 1690-01-01', { n: 'Имя', d: '1690-01-01' }));

// сводка пачки — общий формат ответа (обе копии)
cmp('treeReport пачка', VK.treeReport(Object.assign(vkRep3, { errors: [{ line: 2, msg: 'свадьба без подходящей пары' }] })),
    TG.treeReport(Object.assign({}, tgRep3, { errors: [{ line: 2, msg: 'свадьба без подходящей пары' }] })));
// stripHtml — снятие разметки для .txt-хвоста (только ТГ; ВК присылает без HTML)
cmp('stripHtml', TG.stripHtml('<b>Иван</b> &lt;гр&gt; 20&nbsp;июня'), 'Иван <гр> 20 июня');

// ==================== 5а. flatSearch: поиск по пачке ====================
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
// радиус 1 у Сына: предки (Отец, Мать, Чужой) + их потомки (Сын, Дочь)
cmp('focusKeys r1 состав', [...VK.focusKeys(focusPairs, son, 1)].sort(),
    ['Сын 1980-06-06', 'Дочь 1982-07-07', 'Отец 1955-03-03', 'Мать 1956-05-05', 'Чужой 1990-09-09'].sort());
// радиус 2: + деды и все их потомки (Тётя, Двоюродный) — всё дерево 9 персон
cmp('focusKeys r2 состав', [...VK.focusKeys(focusPairs, son, 2)].sort(),
    [...new Set(focusPairs.flat())].sort());
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
if (VK.focusHead('Имя 2000-01-01', 2) !== '2\u20E3 Имя 2000-01-01')
    { failed++; console.log('✗ focusHead: префикс кейкапа\n  ' + VK.focusHead('Имя 2000-01-01', 2)); }
// кусковой regex «/»-ответа снимает префикс кейкапа с заголовка фокуса
const RH_RE = /^(?:\d\u20E3\s+)?(.+?)\s+(\d{4}-\d{2}-\d{2})/;
if ('2\u20E3 Константин Абакумов 1963-09-27 2001-03-03'.match(RH_RE)?.slice(1).join(' ')
    !== 'Константин Абакумов 1963-09-27')
    { failed++; console.log('✗ regex reply-заголовка'); }

// ==================== 7. kinLabel: ярлыки родства ====================
const TGK = await import(path.join(ROOT, 'tgcloud', 'lib', 'kinship.js'));
const kinPersons = [
    ['Дед', '1930-01-01', 'M'], ['Бабка', '1932-02-02', 'F'],
    ['Отец', '1955-03-03', 'M'], ['Тётя', '1957-04-04', 'F'], ['Мать', '1956-05-05', 'F'],
    ['Сын', '1980-06-06', 'M'], ['Дочь', '1982-07-07', 'F'], ['Двоюродный', '1984-08-08', 'M'],
    ['Тесть', '1931-12-12', 'M'], ['Чужая', '1991-10-10', 'F'], ['Сноха', '1981-03-03', 'F'],
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
];
const kinSpouses = [
    ['Отец 1955-03-03', 'Мать 1956-05-05'], ['Дед 1930-01-01', 'Бабка 1932-02-02'],
    ['Тётя 1957-04-04', 'Тесть 1931-12-12'], ['Сын 1980-06-06', 'Сноха 1981-03-03'],
    ['Дядька 1928-07-07', 'Жена Дядьки 1927-05-05'],
    ['Кузина 1956-06-06', 'Муж Кузины 1955-11-11'],
];
const sonKey = 'Сын 1980-06-06';
// focusDepth: глубина предков (цифры радиуса 2–5 — по сведениям о дедах/прадедах)
cmp('focusDepth глубины',
    [[kinPairs, sonKey], [kinPairs, kinKeys['Двоюродный']], [['Родитель 1930-01-01', 'Сын 1990-01-01'], 'Сын 1990-01-01']]
        .map(c => VK.focusDepth(c[0], c[1])),
    [[kinPairs, sonKey], [kinPairs, kinKeys['Двоюродный']], [['Родитель 1930-01-01', 'Сын 1990-01-01'], 'Сын 1990-01-01']]
        .map(c => TG.focusDepth(c[0], c[1])));
if (JSON.stringify([4, 4, 1]) !== JSON.stringify([
    VK.focusDepth(kinPairs, sonKey), VK.focusDepth(kinPairs, kinKeys['Двоюродный']),
    VK.focusDepth([['Родитель 1930-01-01', 'Сын 1990-01-01']], 'Сын 1990-01-01')]))
    { failed++; console.log('✗ focusDepth: неверные глубины'); }
// цифры радиуса: при depth 1 активная 1 скрыта и 2–5 нет — ряд [💬 цифры]
const digs = (radius, depth) => TG.focusMarkup('private', 1, {}, radius, depth)
    .inline_keyboard[0].filter(b => /^\d/.test(b.text)).map(b => b.text).join('');
if (digs(1, 1) !== '') { failed++; console.log('✗ focusMarkup: без дедов цифры не скрыты\n  ' + digs(1, 1)); }
if (digs(1, 2) !== '2\u20E3') { failed++; console.log('✗ focusMarkup: с дедом нет 2️⃣\n  ' + digs(1, 2)); }
if (digs(2, 2) !== '1\u20E3') { failed++; console.log('✗ focusMarkup: радиус 2/деды\n  ' + digs(2, 2)); }
if (digs(1, 3) !== '2\u20E33\u20E3')
    { failed++; console.log('✗ focusMarkup: прадеды 2⃣3⃣\n  ' + digs(1, 3)); }
if (digs(3, 3) !== '1\u20E32\u20E3') { failed++; console.log('✗ focusMarkup: радиус 3/прадеды\n  ' + digs(3, 3)); }
const KIN_CASES = [
    [kinKeys['Отец'], 'отец'], [kinKeys['Мать'], 'мать'],
    [kinKeys['Дед'], 'дедушка'], [kinKeys['Бабка'], 'бабушка'],
    [kinKeys['Тётя'], 'тётя'], [kinKeys['Двоюродный'], 'двоюродный брат'],
    [kinKeys['Дочь'], 'сестра'],
    [kinKeys['Тесть'], 'муж тёти'],    // муж тёти — не процитируемому
    [kinKeys['Прадед'], 'прадед'],     // глубина 3 — «пра»-приставка
    [kinKeys['Прапрадед'], 'пра2дед'], // глубина 4 — «праN» вместо «прапра…»
    [kinKeys['Дядька'], 'двоюродный дед'],      // брат деда (a=3, b=1)
    [kinKeys['Тётка'], 'двоюродная бабушка'],   // сестра деда (a=3, b=1)
    [kinKeys['Брат Прадеда'], 'двоюродный прадед'], // брат прадеда (a=4, b=1)
    [kinKeys['Кузина'], 'двоюродная сестра дедушки'],   // (a=4, b=2) — составной
    [kinKeys['Троюродный'], 'троюродный брат отца'],    // (a=4, b=3) — составной
    [kinKeys['Племянник'], 'племянник'],                // (a=1, b=2)
    [kinKeys['Внучатый'], 'внучатый племянник'],        // (a=1, b=3)
    [kinKeys['Правнучатый'], 'правнучатый племянник'],  // (a=1, b=4) — составной
    [kinKeys['ДвПлем'], 'двоюродный племянник'],        // (a=2, b=3)
    [kinKeys['ДвВнуч'], 'двоюродный внучатый племянник'], // (a=2, b=4) — составной
    [kinKeys['Чужая'], ''],            // родство не прослеживается
];
let kinOK = true;
for (const [to, want] of KIN_CASES) {
    const vkL = VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, to);
    const tgL = TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, to);
    cmp('kinLabel ' + to, vkL, tgL);
    if (vkL !== want) kinOK = false;
}
if (!kinOK) { failed++; console.log('✗ kinLabel: неверные ярлыки (см. выше)'); }
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
cmp('kinLabel муж двоюродной сестры дедушки',
    VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Муж Кузины']),
    TGK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Муж Кузины']));
if (VK.kinLabel(kinPairs, kinSpouses, k => kinSex[k] ?? null, sonKey, kinKeys['Муж Кузины']) !== 'муж двоюродной сестры дедушки')
    { failed++; console.log('✗ kinLabel муж двоюродной сестры дедушки'); }

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
// состав по радиусам (ромб): r1 — родители и сиблинги (племянников нет:
// u1d2), r2 — деды, тётя, двоюродный, племянник (но не внучатый u1d3/
// двоюродный-племя u2d3), r3 — прадеды, дядьки, кузены-линия, внучатые
const kinAt = (which, r) => which.focusKeys(kinPairs, sonKey, r);
for (const r of [1, 2, 3, 4, 5]) cmp('фокус-множество радиус ' + r, kinAt(VK, r), kinAt(TG, r));
if (kinAt(VK, 1).includes(kinKeys['Дед'])) { failed++; console.log('✗ r1 содержит деда'); }
if (kinAt(VK, 2).includes(kinKeys['Прадед'])) { failed++; console.log('✗ r2 содержит прадеда'); }
if (!kinAt(VK, 2).includes(kinKeys['Дед'])) { failed++; console.log('✗ r2 без деда'); }
if (!kinAt(VK, 3).includes(kinKeys['Прадед'])) { failed++; console.log('✗ r3 без прадеда'); }
// ромб: вниз режется тем же радиусом, что и вверх
if (kinAt(VK, 1).includes(kinKeys['Племянник'])) { failed++; console.log('✗ r1 содержит племянника (u1d2)'); }
if (kinAt(VK, 2).includes(kinKeys['Внучатый'])) { failed++; console.log('✗ r2 содержит внучатого (u1d3)'); }
if (kinAt(VK, 2).includes(kinKeys['ДвПлем'])) { failed++; console.log('✗ r2 содержит двоюродного племянника (u2d3)'); }
if (kinAt(VK, 2).includes(kinKeys['Правнучатый'])) { failed++; console.log('✗ r2 содержит правнучатого (u1d4)'); }
if (!kinAt(VK, 2).includes(kinKeys['Племянник'])) { failed++; console.log('✗ r2 без племянника (u1d2)'); }
if (!kinAt(VK, 2).includes(kinKeys['Двоюродный'])) { failed++; console.log('✗ r2 без двоюродного (u2d2)'); }
if (!kinAt(VK, 3).includes(kinKeys['Внучатый'])) { failed++; console.log('✗ r3 без внучатого (u1d3)'); }
if (!kinAt(VK, 3).includes(kinKeys['ДвПлем'])) { failed++; console.log('✗ r3 без двоюродного племянника (u2d3)'); }
if (!kinAt(VK, 3).includes(kinKeys['Дядька'])) { failed++; console.log('✗ r3 без двоюродного деда (u3d1)'); }
if (kinAt(VK, 3).includes(kinKeys['Правнучатый'])) { failed++; console.log('✗ r3 содержит правнучатого (u1d4)'); }
if (!kinAt(VK, 4).includes(kinKeys['Правнучатый'])) { failed++; console.log('✗ r4 без правнучатого (u1d4)'); }
if (!kinAt(VK, 4).includes(kinKeys['Кузина'])) { failed++; console.log('✗ r4 без кузины (u4d2)'); }
if (!kinAt(VK, 4).includes(kinKeys['Троюродный'])) { failed++; console.log('✗ r4 без троюродного (u4d3)'); }
if (!kinAt(VK, 4).includes(kinKeys['ДвВнуч'])) { failed++; console.log('✗ r4 без двоюродного внучатого племянника (u2d4)'); }
if (kinAt(VK, 3).includes(kinKeys['Брат Прадеда'])) { failed++; console.log('✗ r3 содержит брата прадеда (u4)'); }
if (!kinAt(VK, 4).includes(kinKeys['Брат Прадеда'])) { failed++; console.log('✗ r4 без брата прадеда (u4d1)'); }
// отражённый коб: потомки есть, родителей нет — цифра радиуса всё равно видна
if (JSON.stringify(VK.focusDepth([['A 1900-01-01', 'B 1930-01-01'], ['B 1930-01-01', 'C 1960-01-01'],
    ['C 1960-01-01', 'D 1985-01-01']], 'B 1930-01-01')) !== '2')
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
// сама запись удаляется: персон больше нет ни в записи, ни в пачке/поиске
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
const TGC = await import(path.join(ROOT, 'tgcloud', 'lib', 'chart.js'));
// шрифт — единственный источник tgcloud/lib/font-cyr.js (ВК читает его же)
const FONT = TGC.chartFont();
cmp('b64ToBytes (префикс с «=» и переносом)',
    [...VK.b64ToBytes('QUJDREVG//4=')].join(','),
    [...TGC.b64ToBytes('QUJDREVG//4=')].join(','));
cmp('parseTtf метрики', VK.parseTtf(FONT), TGC.parseTtf(FONT));
// имя файла из заголовка: кейкап остаётся, эмодзи/разделители уходят, ≤ 64
const FB_CASES = [
    '1\u20E3 Пётр I Алексеевич Великий Романов 1672-05-30',
    '🧬 Гедком-древо чата',
    'a/b\\c:d*e?f"g<h>i|j#k',
    'Имя с  точками...  и \n переносами ',
    'В'.repeat(100),
    '///',
    '',
];
for (const c of FB_CASES) cmp('fileBaseOf ' + JSON.stringify(c.slice(0, 30)), VK.fileBaseOf(c), TGC.fileBaseOf(c));
if (VK.fileBaseOf(FB_CASES[0]) !== '1\u20E3 Пётр I Алексеевич Великий Романов 1672-05-30')
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
    { child: 'Алексей Петрович 1690', parents: ['Пётр I 1672', 'Евдокия 1669'] },
    { child: 'Елизавета Петровна 1709', parents: ['Пётр I 1672', 'Екатерина I 1684'] },
    { child: 'Павел Петрович 1691', parents: ['Пётр I 1672'] }, // один родитель
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
    { child: 'Тест близнецов 1 1710', parents: ['Пётр I 1672', 'Екатерина I 1684'] },
    { child: 'Тест близнецов 2 1710', parents: ['Пётр I 1672', 'Екатерина I 1684'] },
    { child: 'Екатерина Ивановна 1691', parents: ['Иван V 1666', 'Прасковья 1664'] },
];
for (const [t, rows, ln] of [
    ['Пётр I: линии жизни', CHART_ROWS, CHART_LINKS],
    ['близнецы: две семьи, один год', TWIN_ROWS, TWIN_LINKS],
]) {
    cmp('chartModel «' + t + '»', VK.chartModel(t, rows, ln), TGC.chartModel(t, rows, ln));
    cmp('chartPdf «' + t + '» (байты)', VK.chartPdf(t, rows, ln, FONT), TGC.chartPdf(t, rows, ln, FONT));
}
// колонка «Связь год» к герою (ярлыки как в 🔔-списке); у героя с rel.range
// («диапазон» радиуса из кейкапа) — 1 родители-дети, 2 деды-внуки, 4 пра2…
const REL = {
    hero: 'Пётр I 1672',
    range: 4,
    pairs: CHART_LINKS.flatMap(l => l.parents.map(p => [p, l.child])),
    spouses: [['Евдокия 1669', 'Пётр I 1672']],
    sex: Object.fromEntries(CHART_ROWS.map(r => [r.name + ' ' + Number(r.birth.slice(0, 4)), r.sex || null])),
};
cmp('chartModel «Пётр I: ярлыки родства»', VK.chartModel('s', CHART_ROWS, CHART_LINKS, REL),
    TGC.chartModel('s', CHART_ROWS, CHART_LINKS, REL));
cmp('chartPdf rel (байты)', VK.chartPdf('s', CHART_ROWS, CHART_LINKS, FONT, REL),
    TGC.chartPdf('s', CHART_ROWS, CHART_LINKS, FONT, REL));
// фантомные рождения: дети супругов вне чарта — вертикали между супругами
const PH = { phantoms: [{ fam: ['Пётр I 1672', 'Екатерина I 1684'], years: [1708, 1712] },
    { fam: ['Пётр I 1672', 'Екатерина I 1684'], years: [1700] },
    { fam: ['Пётр I 1672', 'Евдокия 1669'], years: [1695] }] };
cmp('chartModel фантомы', VK.chartModel('f', CHART_ROWS, CHART_LINKS, PH),
    TGC.chartModel('f', CHART_ROWS, CHART_LINKS, PH));
cmp('chartPdf фантомы (байты)', VK.chartPdf('f', CHART_ROWS, CHART_LINKS, FONT, PH),
    TGC.chartPdf('f', CHART_ROWS, CHART_LINKS, FONT, PH));
cmp('chartPdf rel+фантомы (байты)', VK.chartPdf('s', CHART_ROWS, CHART_LINKS, FONT, { ...REL, ...PH }),
    TGC.chartPdf('s', CHART_ROWS, CHART_LINKS, FONT, { ...REL, ...PH }));
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
const wantPages = Math.max(1, Math.ceil(model.H / (595 / scale) - 1e-9));
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
for (const t of famSet) if (!['#e6194b', '#f58231', '#bfa100', '#3cb44b', '#1f77b4', '#0082c8', '#911eb4'].map(trip).includes(t))
    { failed++; console.log('✗ chartPdf: цвет связи вне палитры: ' + t); }
// ассерты: 3 родителя, родитель моложе ребёнка, неизвестное имя, неуникальный ключ
const ASSERTS = [
    ['три родителя', { ...CHART_LINKS[1], parents: [...CHART_LINKS[1].parents, 'Пётр I 1672'] }, CHART_ROWS],
    ['родитель моложе', { ...CHART_LINKS[0], parents: ['Елизавета Петровна 1709', 'Екатерина I 1684'] }, CHART_ROWS],
    ['имя не найдено', { ...CHART_LINKS[0], parents: ['Немо 1650', 'Екатерина I 1684'] }, CHART_ROWS],
    ['ключ неуникален', CHART_LINKS, [...CHART_ROWS, { ...CHART_ROWS[0], sex: 'M' }]],
];
for (const [what, ln, rows] of ASSERTS) {
    let vkE = '', tgE = '';
    try { VK.chartPdf('ассерты', rows, Array.isArray(ln) ? ln : [ln], FONT); } catch (e) { vkE = e.message; }
    try { TGC.chartPdf('ассерты', rows, Array.isArray(ln) ? ln : [ln], FONT); } catch (e) { tgE = e.message; }
    cmp('chartPdf assert «' + what + '»', vkE, tgE);
    if (!vkE) { failed++; console.log('✗ chartPdf assert «' + what + '»: не бросил ошибку'); }
}

if (failed) { console.log('\n✗ расхождений: ' + failed); process.exit(1); }
console.log('✓ ВК и ТГ синхронны (' + (TRIGGERS.length + TREE_TRIGGERS.length) + ' триггеров, гедком-импорт/экспорт, плоское древо, связи/семьи/каскад, chartPdf)');
