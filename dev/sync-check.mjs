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

// ---- ВК: копия lunarreturns.js с дописанными тестовыми экспортами ----
// argv "test" уводит main() в тихий путь (печать юбилея) без токена и poll.
process.env.LR_DB = path.join(TMP, 'vk-db.json');
const vkHook = '\nmodule.exports.__test = { parseTrigger, parseGedcom, gedStats, focusKeys, focusHasPair, focusWithSpouses, focusLabel, focusHead, focusListText, kinLabel, focusDepth, addLink, ensureFam, ensureFamSingle, '
    + 'pairRecords, confirmPair, linkText, gedcomText, importGedcom, upsertRecord, refreshFams, deleteEventCascade, jubileeText, '
    + 'getDb: () => db, setDb: d => { db = d; } };\n';
const vkFile = path.join(TMP, 'vk.cjs');
fs.writeFileSync(vkFile, fs.readFileSync(path.join(ROOT, 'lunarreturns.js'), 'utf8') + vkHook);
const require = createRequire(import.meta.url);
const prevArgv = process.argv.slice();
process.argv = [process.argv[0], vkFile, 'test', ''];
const prevLog = console.log;
console.log = () => {};
let VK;
try { VK = require(vkFile).__test; } finally { console.log = prevLog; process.argv = prevArgv; }

// ---- ТГ: tgcloud/lib через sdk-mock (как dev/repl.mjs) ----
process.env.LR_DEV_DB = path.join(TMP, 'tg-db.json');
fs.cpSync(path.join(ROOT, 'dev', 'sdk-mock'), path.join(ROOT, 'node_modules', 'sdk'), { recursive: true });
const TG = await import(path.join(ROOT, 'tgcloud', 'lib', 'bot.js'));
const TGP = await import(path.join(ROOT, 'tgcloud', 'lib', 'parse.js'));
const { db, eq, and, or } = await import(path.join(ROOT, 'node_modules', 'sdk', 'db.js'));
const { links } = await import(path.join(ROOT, 'tgcloud', 'schema.js'));

// ============================== 1. parseTrigger ==============================
const TRIGGERS = [
    'Иван 1960-05-10',
    'Иван 1960-05-10 06:30',
    'Иван 1960-05-10 06:30 (Пермь)',
    'Иван 1960-05-10 12:30 МСК+2',
    'Иван 1960-05-10 12:30 UTC-3',
    'Иван+Мария 1983-06-04 (Пермь) 1990-01-01 (Казань)',
    'Иван 1960-05-10 06:30 2020-02-03 04:00',
    'Иван 1960-13-10',
    'Иван 1960-05-10 (Тьмутаракань)',
    'Иван 1960-05-10 2020-02-03',
    'Пётр 1985-07-07 23:45 (Пермь) 2020-02-03 04:00',
    'Иван+Мария 1983-06-04 1990-01-01',
];
for (const t of TRIGGERS) cmp('parseTrigger ' + JSON.stringify(t), VK.parseTrigger(t), TGP.parseTrigger(t));

// ============================== 2. parseGedcom ==============================
const GEDCOM = [
    '0 HEAD', '1 GEDC', '2 VERS 5.5.1',
    '0 @I1@ INDI', '1 NAME Иван /Иванов/', '1 SEX M', '1 BIRT', '2 DATE 10 MAY 1960', '2 TIME 06:30',
    '0 @I2@ INDI', '1 NAME Мария /Иванова/', '1 SEX F', '1 BIRT', '2 DATE 1 MAR 1962',
    '0 @I3@ INDI', '1 NAME Пётр /Иванов/', '1 BIRT', '2 DATE 7 JUL 1985', '2 TIME 23:45',
    '1 DEAT', '2 DATE 3 FEB 2020', '2 TIME 05:15', '1 ADOP', '2 FAMC @F1@',
    '0 @I4@ INDI', '1 NAME Год /Только/', '1 BIRT', '2 DATE 1624', '1 DEAT', '2 DATE 1669',
    '0 @I5@ INDI', '1 NAME Анна /Месяц/', '1 SEX F', '1 BIRT', '2 DATE ABT MAR 1662',
    '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 CHIL @I3@', '2 PEDI adopted',
    '1 CHIL @I4@',
    '1 MARR', '2 DATE 4 JUN 1983', '2 PLAC Пермь', '1 DIV', '2 DATE 1 JAN 1990',
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
VK.setDb({ records: [] });
for (const p of focusPersons) { VK.upsertRecord(p, FOCUS_CH); await TG.upsertEvent(FOCUS_CH, p); }
const focusPairs = [
    ['Дед 1930-01-01', 'Отец 1955-03-03'], ['Бабка 1932-02-02', 'Отец 1955-03-03'],
    ['Дед 1930-01-01', 'Тётя 1957-04-04'], ['Бабка 1932-02-02', 'Тётя 1957-04-04'],
    ['Отец 1955-03-03', 'Сын 1980-06-06'], ['Мать 1956-05-05', 'Сын 1980-06-06'],
    ['Отец 1955-03-03', 'Дочь 1982-07-07'], ['Мать 1956-05-05', 'Дочь 1982-07-07'],
    ['Тётя 1957-04-04', 'Двоюродный 1984-08-08'],
    ['Чужой 1990-09-09', 'Сын 1980-06-06'], // чужой родитель — тоже предки
];
for (const [p, c] of focusPairs) { VK.addLink(FOCUS_CH, p, c, 'c'); await TG.addLink(FOCUS_CH, p, c, 'c'); }
VK.upsertRecord({ n: 'Отец+Мать', d: '1979-01-01' }, FOCUS_CH);
await TG.upsertEvent(FOCUS_CH, { n: 'Отец+Мать', d: '1979-01-01' });
VK.upsertRecord({ n: 'Дед+Чужая', d: '1954-01-01' }, FOCUS_CH);
await TG.upsertEvent(FOCUS_CH, { n: 'Дед+Чужая', d: '1954-01-01' });
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
// цифры радиуса: при depth 1 активная 1 скрыта и 2–5 нет — ряд только с ❌
const digs = (radius, depth) => TG.focusMarkup('private', 1, {}, radius, depth)
    .inline_keyboard[1].filter(b => /^\d/.test(b.text)).map(b => b.text).join('');
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
    }
}
// состав по радиусам: r1 — родители и их потомки (дедов нет), r2 — деды
// (прадедов нет), r3 — прадеды; ярлык «двоюродный дед» возможен только с r3
const kinAt = (which, r) => which.focusKeys(kinPairs, sonKey, r);
for (const r of [1, 2, 3]) cmp('фокус-множество радиус ' + r, kinAt(VK, r), kinAt(TG, r));
if (kinAt(VK, 1).includes(kinKeys['Дед'])) { failed++; console.log('✗ r1 содержит деда'); }
if (kinAt(VK, 2).includes(kinKeys['Прадед'])) { failed++; console.log('✗ r2 содержит прадеда'); }
if (!kinAt(VK, 2).includes(kinKeys['Дед'])) { failed++; console.log('✗ r2 без деда'); }
if (!kinAt(VK, 3).includes(kinKeys['Прадед'])) { failed++; console.log('✗ r3 без прадеда'); }

// ==================== 3. импорт → полный экспорт гедкома ====================
const g = VK.parseGedcom(GEDCOM);
VK.setDb({ records: [] });
const vkImp = VK.importGedcom(1, g);
const tgImp = await TG.importGedcom(1, g);
cmp('importGedcom отчёт', vkImp, tgImp);
cmp('gedcomText после импорта', VK.gedcomText(1), await TG.gedcomText(1));

// ==================== 4. связи: reply-флоу, свадьба, каскад ====================
const CH = 2; // VK peerId = TG chatId
const persons = [
    { n: 'Отец', d: '1955-02-02' },
    { n: 'Мать', d: '1957-04-04', srcH: 3, srcM: 15 },
    { n: 'Дочь', d: '1982-09-09' },
];
const pair = { n: 'Отец+Мать', d: '1980-01-20', plac: 'Пермь' };
VK.setDb({ records: [] });
for (const p of persons) { VK.upsertRecord(p, CH); await TG.upsertEvent(CH, p); }
VK.upsertRecord(pair, CH); await TG.upsertEvent(CH, pair);

// связь родитель→ребёнок (как reply-триггер)
const pk = 'Отец ' + persons[0].d, mk = 'Мать ' + persons[1].d, ck = 'Дочь ' + persons[2].d;
const vkL1 = VK.addLink(CH, pk, ck, 'c').link;
const tgL1 = (await TG.addLink(CH, pk, ck, 'c')).link;
cmp('pairRecords (один родитель)', VK.pairRecords(CH, vkL1), await TG.pairRecords(CH, tgL1));

// второй родитель → семья; кандидаты свадьбы с обоими
const vkL2 = VK.addLink(CH, mk, ck, 'c').link;
const tgL2 = (await TG.addLink(CH, mk, ck, 'c')).link;
VK.ensureFam(CH, ck); await TG.ensureFam(CH, ck);
cmp('pairRecords (двое родителей)', VK.pairRecords(CH, vkL2), await TG.pairRecords(CH, tgL2));

// подтвердить свадьбу — сравнить текст связи и фрагмент гедкома
const vkCand = VK.pairRecords(CH, vkL2);
const tgCand = await TG.pairRecords(CH, tgL2);
VK.confirmPair(CH, vkL2, vkCand[0]);
await TG.confirmPair(CH, tgL2, tgCand[0]);
const tgFresh = await db.select().from(links).where(eq(links.id, tgL2.id)).get();
cmp('linkText после confirmPair', VK.linkText(CH, vkL2), await TG.linkText(CH, tgFresh));
cmp('gedcomText фрагмент', VK.gedcomText(CH, [pk, mk, ck]), await TG.gedcomText(CH, [pk, mk, ck]));
cmp('gedcomText весь чат', VK.gedcomText(CH), await TG.gedcomText(CH));

// каскад: удалить свадьбу-пару «Отец+Мать» — MARR уходит из семьи,
// кандидаты у оставшихся связей чистятся (как del1/👎 на записи пары)
const pairKey = pair.n + ' ' + pair.d;
const vkCand0 = VK.pairRecords(CH, vkL1);
await TG.setLinkCand(tgL1, vkCand0);
vkL1.pairCand = vkCand0;
const vdbPair = VK.getDb();
const vkPairRec = vdbPair.records.find(r => r.peerId === CH && r.n + ' ' + r.d === pairKey);
VK.deleteEventCascade(CH, vkPairRec);
await TG.deleteEventCascade(CH, pairKey);
const tgL1f = await db.select().from(links).where(eq(links.id, tgL1.id)).get();
cmp('linkText: pairCand после удаления пары', VK.linkText(CH, vkL1), await TG.linkText(CH, tgL1f));
cmp('gedcomText: MARR после удаления пары', VK.gedcomText(CH), await TG.gedcomText(CH));

// каскад: удалить персону «Мать» — связи падают, семья остаётся с «Отцом»
const vdbP = VK.getDb();
const vkMRec = vdbP.records.find(r => r.peerId === CH && r.n === 'Мать');
VK.deleteEventCascade(CH, vkMRec);
await TG.deleteEventCascade(CH, mk);
cmp('gedcomText после удаления персоны', VK.gedcomText(CH), await TG.gedcomText(CH));

if (failed) { console.log('\n✗ расхождений: ' + failed); process.exit(1); }
console.log('✓ ВК и ТГ синхронны (' + TRIGGERS.length + ' триггеров, гедком-импорт/экспорт, связи/семьи/каскад)');
