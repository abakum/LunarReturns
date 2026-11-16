// dev/a3-list-check.mjs — A3 «списки фокуса и колокольчика»: независимые
// ожидаемые результаты, зафиксированные по ВК ДО переноса (дословные строки —
// вывод функций ВК-бота на фиксированных fixture, снимок до правок).
// Проверяет:
// 1) focusListText — формат строки (дата смерти, время, ярлык родства) и
//    обе сортировки списка фокуса: круговая «от сегодня» (MM-DD отсечка,
//    вкл. переход декабрь/январь и 29 февраля) и по полной дате;
// 2) eventListText — формат строки, фильтр примерных дат и круговой порядок
//    списка колокольчика; обёртки upcomingEvents (ВК) / upcomingText (ТГ)
//    после волны A3 только выбирают rows из БД и зовут канон tree.cjs.
// Импорт (из dev/sync-check.mjs) — только чистые проверки канона, без
// прикосновений к env/БД. Прямой запуск `node dev/a3-list-check.mjs`
// дополнительно проверяет адаптеры: ВК через временную копию lunarreturns.js
// (LR_DB в своём TMP), ТГ через sdk-mock (LR_DEV_DB в своём TMP;
// dev/tg-db.json не трогается).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');

// ============================== fixture ==============================
// Список фокуса: Бабка с датой смерти, Дочь со временем, пара «Отец+Мать»,
// примерная (Столетний) и старый стиль (Агафья), Чужой вне множества.
const items = [
    { n: 'Бабка', d: '1932-02-02', dd: '2000-03-03' },
    { n: 'Дед', d: '1930-01-01' },
    { n: 'Отец', d: '1955-03-03' },
    { n: 'Тётя', d: '1957-04-04' },
    { n: 'Мать', d: '1956-05-05' },
    { n: 'Сын', d: '1980-06-06' },
    { n: 'Дочь', d: '1982-07-07', h: 4, m: 5 },
    { n: 'Тесть', d: '1931-12-12' },
    { n: 'Отец+Мать', d: '1979-01-01', dd: '1990-01-01' },
    { n: 'Столетний', d: '1234-01-01', abt: 17 },
    { n: 'Агафья', d: '1663-07-14', dd: '1681-07-14' },
    { n: 'Чужой', d: '1999-09-09' },
];
const pairs = [
    ['Прадед 1900-01-01', 'Дед 1930-01-01'],
    ['Дед 1930-01-01', 'Отец 1955-03-03'], ['Бабка 1932-02-02', 'Отец 1955-03-03'],
    ['Дед 1930-01-01', 'Тётя 1957-04-04'], ['Бабка 1932-02-02', 'Тётя 1957-04-04'],
    ['Отец 1955-03-03', 'Сын 1980-06-06'], ['Мать 1956-05-05', 'Сын 1980-06-06'],
    ['Отец 1955-03-03', 'Дочь 1982-07-07'], ['Мать 1956-05-05', 'Дочь 1982-07-07'],
];
const spousePairs = [
    ['Отец 1955-03-03', 'Мать 1956-05-05'],
    ['Дед 1930-01-01', 'Бабка 1932-02-02'],
    ['Тётя 1957-04-04', 'Тесть 1931-12-12'],
];
const sexOf = k => ({ 'Дед 1930-01-01': 'M', 'Бабка 1932-02-02': 'F', 'Отец 1955-03-03': 'M',
    'Тётя 1957-04-04': 'F', 'Мать 1956-05-05': 'F', 'Сын 1980-06-06': 'M',
    'Дочь 1982-07-07': 'F', 'Тесть 1931-12-12': 'M' }[k] ?? null);
const sonKey = 'Сын 1980-06-06';
// ключи r1/r2 зафиксированы как есть (состав множеств — канон focusKeys,
// проверяется отдельно в sync-check); отсюда только готовые списки
const R1_KEYS = ['Сын 1980-06-06', 'Отец 1955-03-03', 'Мать 1956-05-05', 'Дочь 1982-07-07'];
const R2_KEYS = [...R1_KEYS, 'Дед 1930-01-01', 'Бабка 1932-02-02', 'Тётя 1957-04-04', 'Тесть 1931-12-12'];

// Список колокольчика: вставки в БД (persons + примерная свадьба «1985~»)
const persons = [
    { n: 'Агафья', d: '1663-07-14', dd: '1681-07-14' }, // старый стиль, +10 дней
    { n: 'Фёдор', d: '1899-12-31' },                    // +12, смена года
    { n: 'Столетний', d: '1234-01-01', abt: 17 },       // год-only примерная
    { n: 'Совет', d: '1918-02-01' },                    // уже новый стиль
    { n: 'Високосный', d: '1904-02-16' },               // → 1904-02-29
    { n: 'Ранний', d: '1960-01-10', h: 6, m: 30 },      // время и ничья с Поздним
    { n: 'Поздний', d: '1960-01-10' },
];

// ============================== ожидания (ВК до переноса) ==============================
const EXPECTED = {
    focus: {
        r1_bell: 'Отец+Мать 1979-01-01 1990-01-01\nОтец 1955-03-03 отец\nМать 1956-05-05 мать\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра',
        r1_full: 'Отец 1955-03-03 отец\nМать 1956-05-05 мать\nОтец+Мать 1979-01-01 1990-01-01\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра',
        r1_d1: 'Отец+Мать 1979-01-01 1990-01-01\nОтец 1955-03-03 отец\nМать 1956-05-05 мать\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра',
        r1_1215: 'Отец+Мать 1979-01-01 1990-01-01\nОтец 1955-03-03 отец\nМать 1956-05-05 мать\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра',
        r1_0115: 'Отец 1955-03-03 отец\nМать 1956-05-05 мать\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра\nОтец+Мать 1979-01-01 1990-01-01',
        r2_bell: 'Дед 1930-01-01 дедушка\nОтец+Мать 1979-01-01 1990-01-01\nБабка 1932-02-02 2000-03-03 бабушка\nОтец 1955-03-03 отец\nТётя 1957-04-04 тётя\nМать 1956-05-05 мать\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра\nТесть 1931-12-12 муж тёти',
        r2_full: 'Дед 1930-01-01 дедушка\nТесть 1931-12-12 муж тёти\nБабка 1932-02-02 2000-03-03 бабушка\nОтец 1955-03-03 отец\nМать 1956-05-05 мать\nТётя 1957-04-04 тётя\nОтец+Мать 1979-01-01 1990-01-01\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра',
        r2_d1: 'Дед 1930-01-01 дедушка\nОтец+Мать 1979-01-01 1990-01-01\nБабка 1932-02-02 2000-03-03 бабушка\nОтец 1955-03-03 отец\nТётя 1957-04-04 тётя\nМать 1956-05-05 мать\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра\nТесть 1931-12-12 муж тёти',
        r2_1215: 'Тесть 1931-12-12 муж тёти\nДед 1930-01-01 дедушка\nОтец+Мать 1979-01-01 1990-01-01\nБабка 1932-02-02 2000-03-03 бабушка\nОтец 1955-03-03 отец\nТётя 1957-04-04 тётя\nМать 1956-05-05 мать\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра',
        r2_0115: 'Бабка 1932-02-02 2000-03-03 бабушка\nОтец 1955-03-03 отец\nТётя 1957-04-04 тётя\nМать 1956-05-05 мать\nСын 1980-06-06\nДочь 1982-07-07 04:05 сестра\nТесть 1931-12-12 муж тёти\nДед 1930-01-01 дедушка\nОтец+Мать 1979-01-01 1990-01-01',
        empty: '',
        empty_full: '',
    },
    events: {
        full: 'Столетний 1234~\nАгафья 1663_07_24 1681_07_24\nФёдор 1900_01_12\nВисокосный 1904_02_29\nСовет 1918-02-01\nПоздний 1960-01-10\nРанний 1960-01-10 06:30\nАнна+Пётр 1985~',
        bell: 'Поздний 1960-01-10\nРанний 1960-01-10 06:30\nФёдор 1900_01_12\nСовет 1918-02-01\nВисокосный 1904_02_29\nАгафья 1663_07_24 1681_07_24',
        bell_0115: 'Совет 1918-02-01\nВисокосный 1904_02_29\nАгафья 1663_07_24 1681_07_24\nПоздний 1960-01-10\nРанний 1960-01-10 06:30\nФёдор 1900_01_12',
        bell_1215: 'Поздний 1960-01-10\nРанний 1960-01-10 06:30\nФёдор 1900_01_12\nСовет 1918-02-01\nВисокосный 1904_02_29\nАгафья 1663_07_24 1681_07_24',
        bell_0229: 'Високосный 1904_02_29\nАгафья 1663_07_24 1681_07_24\nПоздний 1960-01-10\nРанний 1960-01-10 06:30\nФёдор 1900_01_12\nСовет 1918-02-01',
        empty: '',
        empty_bell: '',
    },
};

// ============================== чистый канон (tree.cjs) ==============================
const tree = require(path.join(ROOT, 'tgcloud', 'lib', 'tree.cjs'));
function checkCanon(tag) {
    const rows = [...persons, { n: 'Анна+Пётр', d: '1985-01-01', mabt: 17 }];
    assert.equal(tree.eventListText([...rows], true), EXPECTED.events.full);
    assert.equal(tree.eventListText(rows, false), EXPECTED.events.bell);
    assert.equal(tree.eventListText(rows, false, '02-28'), EXPECTED.events.bell_0229);
    assert.equal(tree.eventListText([], false), '');
    assert.ok(tree.eventListText(rows, false, '01-10').startsWith('Поздний 1960-01-10\nРанний 1960-01-10 06:30'));
    const tied = [{ n: 'Second', d: '2000-03-01' }, { n: 'First', d: '2000-03-01' }];
    assert.equal(tree.eventListText(tied, false, '03-01'), 'Second 2000-03-01\nFirst 2000-03-01');
    const old = [{ n: 'Old', d: '1900-01-01', dd: '1901-01-01', abt: 3 }];
    assert.equal(tree.focusListText(old, ['Old 1900-01-01'], 'Old 1900-01-01', [], [], () => null), '');
    assert.equal(tree.focusListText(old, ['Old 1900-01-01'], 'Old 1900-01-01', [], [], () => null, true), 'Old 1900_01_13? 1901_01_14');
    const { parseTrigger } = require(path.join(ROOT, 'tgcloud/lib/parse.cjs'));
    for (const row of [...persons, ...Array.from({ length: 18 }, (_, abt) =>
        ({ n: 'Approx', d: '1900-01-01', dd: '1901-01-01', abt, dabt: abt }))]) {
        const key = row.n + ' ' + row.d;
        for (const line of [tree.eventListText([row], true),
            tree.focusListText([row], [key], key, [], [], () => null, true)]) {
            const parsed = parseTrigger(line).rec;
            // Truncated dates deliberately omit day/month; full dates must round-trip.
            if (!(row.abt % 3)) assert.equal(parsed.d, row.d, line);
            if (row.dd && !(row.dabt % 3)) assert.equal(parsed.dd, row.dd, line);
            assert.equal(parsed.abt || 0, row.abt || 0, line);
        }
    }
    const exact = { n: 'Exact', d: '2000-03-01' };
    const uncertain = ['abt', 'dabt', 'mabt'].flatMap(field =>
        Array.from({ length: 17 }, (_, i) => ({ n: field + (i + 1), d: '2000-03-01', [field]: i + 1 })));
    const mixed = [exact, ...uncertain];
    const keys = mixed.map(r => r.n + ' ' + r.d);
    for (const full of [false, true]) {
        const focus = tree.focusListText(mixed, keys, keys[0], [], [], () => null, full);
        assert.equal(focus, tree.eventListText(mixed, full), 'focus/chat share date filtering');
        assert.equal(focus.split('\n').length, full ? mixed.length : 18);
    }
    const bell = tree.focusListText(mixed, keys, keys[0], [], [], () => null);
    assert.ok(bell.startsWith('Exact 2000-03-01\n'));
    assert.doesNotMatch(bell, /(?:^|\n)(?:abt|mabt)\d/);
    for (let i = 1; i <= 17; i++) {
        assert.ok(bell.includes('dabt' + i + ' 2000-03-01'));
        assert.equal(tree.isExactEvent({ d: '2000-03-01', dabt: i }), true);
        assert.equal(tree.isExactEvent({ d: '2000-03-01', abt: i }), false);
        assert.equal(tree.isExactEvent({ d: '2000-03-01', mabt: i }), false);
    }
    assert.equal(tree.isExactEvent({}), false);
    assert.equal(tree.normalizeFocusRadius(5, 2), 2);
    assert.equal(tree.normalizeFocusRadius(0, 0), 1);
    assert.equal(tree.normalizeFocusRadius(8, 9), 5);
    for (let radius = 1; radius <= 5; radius++) {
        assert.equal(tree.normalizeFocusRadius(radius, 5), radius);
        assert.equal(tree.normalizeFocusRadius(radius, 2), Math.min(radius, 2));
    }
    for (const head of ['Hero', 'Иван', 'x'.repeat(4001)]) {
        for (const body of ['a\n'.repeat(3000), 'x'.repeat(4001), '']) {
            assert.ok(tree.focusListMessage(head, body).length <= 4000);
        }
    }
    assert.equal(tree.focusListMessage('Hero', 'Exact'), 'Hero\nExact');
    const anniversary = [
        { n: 'Birthday', d: '1950-01-02', dd: '2020-01-01', dabt: 17 },
        { n: 'A+B', d: '1970-03-04', dd: '1980-01-01', dabt: 5 },
    ];
    const anniversaryText = 'Birthday 1950-01-02 2020~\nA+B 1970-03-04 1980?';
    assert.equal(tree.eventListText(anniversary), anniversaryText);
    assert.equal(tree.focusListText(anniversary, anniversary.map(r => r.n + ' ' + r.d),
        'Birthday 1950-01-02', [], [], () => null), anniversaryText);
    const E = EXPECTED.focus;
    assert.equal(tree.focusListText(items, R1_KEYS, sonKey, pairs, spousePairs, sexOf), E.r1_bell, tag + ' r1 bell');
    assert.equal(tree.focusListText(items, R1_KEYS, sonKey, pairs, spousePairs, sexOf, true), E.r1_full, tag + ' r1 full');
    assert.equal(tree.focusListText(items, R1_KEYS, sonKey, pairs, spousePairs, sexOf, false, '', 1), E.r1_d1, tag + ' r1 depth1');
    assert.equal(tree.focusListText(items, R1_KEYS, sonKey, pairs, spousePairs, sexOf, false, '12-01'), E.r1_1215, tag + ' r1 от 12-01');
    assert.equal(tree.focusListText(items, R1_KEYS, sonKey, pairs, spousePairs, sexOf, false, '01-15'), E.r1_0115, tag + ' r1 от 01-15');
    assert.equal(tree.focusListText(items, R2_KEYS, sonKey, pairs, spousePairs, sexOf), E.r2_bell, tag + ' r2 bell');
    assert.equal(tree.focusListText(items, R2_KEYS, sonKey, pairs, spousePairs, sexOf, true), E.r2_full, tag + ' r2 full');
    assert.equal(tree.focusListText(items, R2_KEYS, sonKey, pairs, spousePairs, sexOf, false, '', 1), E.r2_d1, tag + ' r2 depth1');
    assert.equal(tree.focusListText(items, R2_KEYS, sonKey, pairs, spousePairs, sexOf, false, '12-01'), E.r2_1215, tag + ' r2 от 12-01');
    assert.equal(tree.focusListText(items, R2_KEYS, sonKey, pairs, spousePairs, sexOf, false, '01-15'), E.r2_0115, tag + ' r2 от 01-15');
    assert.equal(tree.focusListText(items, ['Никого 2000-01-01'], sonKey, pairs, spousePairs, sexOf), E.empty, tag + ' пустой фокус');
    assert.equal(tree.focusListText([], [], sonKey, pairs, spousePairs, sexOf, true), E.empty_full, tag + ' пустые items');

    const relatives = items.filter(r => !r.n.includes('+')).map(r => ({
        ...r, sex: sexOf(r.n + ' ' + r.d),
        ...(r.n === 'Дочь' ? { abt: 17 } : {}),
    }));
    const weddings = items.filter(r => r.n.includes('+')).map(r => ({ ...r, mabt: 17 }));
    const search = (query, chain = false) => tree.focusSearch(relatives, weddings,
        pairs, spousePairs, sonKey, query, chain);
    assert.deepEqual(search('/доч'), ['Дочь 1982~ 04:05 сестра']);
    assert.deepEqual(search('/ сестра'), ['Дочь 1982~ 04:05 сестра']);
    assert.deepEqual(search('/сестра'), []);
    assert.deepEqual(search('/Чужой'), []);
    assert.deepEqual(search('/Неизвестный'), []);
    assert.deepEqual(search('/ #comment'), []);
    assert.deepEqual(search('/Дочь #boundary'), ['Дочь 1982~ 04:05 сестра']);
    assert.deepEqual(search('/Отец+'), ['Отец+Мать 1979~ 1990-01-01']);
    assert.deepEqual(search('/ сестра', true), ['Дочь 1982~ 04:05 сестра']);
    assert.deepEqual(search('/ сестра отца', true), ['Тётя 1957-04-04 сестра отца']);
    assert.deepEqual(search('/ сестра#2', true), ['Тётя 1957-04-04 сестра отца', 'Дочь 1982~ 04:05 сестра']);
    assert.deepEqual(search('/ тётя'), ['Тётя 1957-04-04 тётя']);
    assert.deepEqual(search('/ тётя#1'), []);
    assert.deepEqual(search('/  тётя#2'), ['Тётя 1957-04-04 тётя']);
    assert.deepEqual(search('/Тётя'), ['Тётя 1957-04-04 тётя']);
    assert.deepEqual(search('/Тётя#2'), ['Тётя 1957-04-04 тётя']);
    assert.deepEqual(search('/ 19#5'), [
        'Дед 1930-01-01 дедушка', 'Тесть 1931-12-12 муж тёти',
        'Бабка 1932-02-02 2000-03-03 бабушка', 'Отец 1955-03-03 отец',
        'Мать 1956-05-05 мать', 'Тётя 1957-04-04 тётя',
        'Отец+Мать 1979~ 1990-01-01', 'Сын 1980-06-06', 'Дочь 1982~ 04:05 сестра',
    ]);
    assert.deepEqual(search('/#5'), search('/ 19#5'));
    for (const chain of [false, true]) for (let radius = 1; radius <= 9; radius++) {
        const keys = tree.focusListKeys(pairs, spousePairs, sonKey, radius, sexOf, true);
        const expected = tree.focusListText([...relatives, ...weddings], keys, sonKey,
            pairs, spousePairs, sexOf, true, '', radius, chain).split('\n');
        assert.deepEqual(search('/#' + radius, chain), expected);
    }
    for (const query of ['/ #2', '/#comment', '/#', '/#0', '/#10'])
        assert.deepEqual(search(query), []);
    assert.deepEqual(tree.focusSearch([], [], [], [], sonKey, '/#2'), []);
    const generations = Array.from({ length: 7 }, (_, i) =>
        ({ n: 'Ancestor' + i, d: `${2000 - i * 20}-01-01`, sex: 'M', abt: 17 }));
    const ancestors = generations.slice(1).map((r, i) =>
        [r.n + ' ' + r.d, generations[i].n + ' ' + generations[i].d]);
    const ancestorHits = tree.focusSearch(generations, [], ancestors, [],
        'Ancestor0 2000-01-01', '/Ancestor#5', false);
    assert.equal(ancestorHits.length, 6);
    assert.ok(ancestorHits[0].startsWith('Ancestor5 '));
    assert.ok(!ancestorHits.some(l => l.startsWith('Ancestor6 ')));
    const large = Array.from({ length: 180 }, (_, i) =>
        ({ n: 'Child' + String(i).padStart(3, '0'), d: '2000-01-01', sex: 'M' }));
    const largePersons = [{ n: 'Hero', d: '1970-01-01', sex: 'M' }, ...large];
    const largePairs = large.map(r => ['Hero 1970-01-01', r.n + ' ' + r.d]);
    const snapshot = JSON.stringify([largePersons, largePairs]);
    assert.ok(tree.focusSearch(largePersons, [], largePairs, [], 'Hero 1970-01-01', '/Child').join('\n').length > 4000);
    assert.equal(tree.focusSearch(largePersons, [], largePairs, [], 'Hero 1970-01-01', '/#1').length, 181);
    assert.deepEqual(tree.focusSearch(largePersons, [], largePairs, [], 'Hero 1970-01-01', '/Child179'),
        ['Child179 2000-01-01 сын']);
    assert.equal(JSON.stringify([largePersons, largePairs]), snapshot);
    for (const chain of [false, true]) {
        for (const [query, radius] of [
            ['/Иван', 1], ['/ брат', 1], ['/ брат отца', 2], ['/ жена брата отца', 3],
            ['/ дочь матери жены', 3], ['/ сын сестры матери жены брата отца', 5],
            ['/ отец матери#1', 1], ['/неизвестно#2', 2], ['/ брат#5', 5],
            ['/#comment', 1], ['/ брат#отец матери', 1], ['/ брат # 2 ', 2],
            ['/ брат#99', 9], ['/ брат#0', 1], ['/ БРАТ ОТЦА', 2],
            ['/ мать ребёнка', 2], ['/ супруг сиблинга', 2], ['/ муж дочки', 2],
            ['/Отецкий Материн', 1], ['/ отец, мать', 2], ['/ брат#comment сестра', 1],
        ]) assert.equal(tree.searchRadius(query, chain), radius, `${query}, chain=${chain}`);
    }
    for (const [label, radius] of [
        ['дядя', 2], ['тётя', 2], ['дедушка', 2], ['бабушки', 2], ['внук', 2],
        ['племянница', 2], ['прародитель', 2], ['прародителя', 2], ['прадед', 3], ['пра2бабушки', 4],
        ['правнук', 3], ['пра3внучка', 5], ['двоюродный брат', 3],
        ['двоюродного дяди', 4], ['троюродная сестра', 5],
        ['внучатый племянник', 4], ['правнучатая племянница', 5],
        ['внучатого племянника', 4], ['внучатой племянницы', 4],
        ['жена внука', 3], ['дядя жены', 3], ['двоюродная сестра бабушки', 5],
    ]) assert.equal(tree.searchRadius('/ ' + label), radius, label);
    assert.equal(tree.searchRadius('/ дядя', true), 1);
    assert.equal(tree.searchRadius('/ двоюродный брат', true), 1);
    const distant = Array.from({ length: 10 }, (_, i) =>
        ({ n: 'Distant' + i, d: `${2000 - i * 20}-01-01`, sex: 'M' }));
    const distantPairs = distant.slice(1).map((r, i) =>
        [r.n + ' ' + r.d, distant[i].n + ' ' + distant[i].d]);
    for (const chain of [false, true]) for (let radius = 6; radius <= 9; radius++) {
        const query = '/Distant' + radius;
        const searchDistant = r => tree.focusSearch(distant, [], distantPairs, [],
            'Distant0 2000-01-01', query + '#' + r, chain);
        assert.equal(tree.searchRadius(query + '#' + radius, chain), radius);
        assert.equal(searchDistant(radius - 1).length, 0);
        assert.equal(searchDistant(radius).length, 1);
    }
    const halfRows = ['Hero', 'Sibling', 'Nephew', 'Grandnephew', 'Father', 'Mother', 'OtherMother']
        .map(n => ({ n, d: '2000-01-01', sex: 'M' }));
    const halfPairs = [['Father', 'Hero'], ['Mother', 'Hero'],
        ['Father', 'Sibling'], ['OtherMother', 'Sibling'],
        ['Sibling', 'Nephew'], ['Nephew', 'Grandnephew']]
        .map(pair => pair.map(n => n + ' 2000-01-01'));
    const halfSearch = query => tree.focusSearch(halfRows, [], halfPairs, [],
        'Hero 2000-01-01', query, false);
    assert.deepEqual(halfSearch('/ внучатый племянник#3'), []);
    assert.deepEqual(halfSearch('/ внучатый племянник'),
        ['Grandnephew 2000-01-01 внучатый племянник']);
    assert.deepEqual(halfSearch('/ внучатый племянник'), halfSearch('/ внучатый племянник#4'));
}

// ============================== адаптеры (прямой запуск) ==============================
// ВК: временная копия lunarreturns.js в тихом test-режиме (LR_DB — свой TMP);
// вставки те же, что у снимка ожиданий; upcomingEvents после A3 — обёртка.
function checkVkAdapter() {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-a3list-vk-'));
    process.env.LR_DB = path.join(TMP, 'vk.db');
    const vkFile = path.join(TMP, 'vk.cjs');
    fs.writeFileSync(vkFile, fs.readFileSync(path.join(ROOT, 'lunarreturns.js'), 'utf8'));
    const prevArgv = process.argv.slice();
    process.argv = [process.argv[0], vkFile, 'test', ''];
    const prevLog = console.log;
    console.log = () => {};
    let VK;
    try { VK = require(vkFile).__test; } finally { console.log = prevLog; process.argv = prevArgv; }
    const CH = 501, EMPTY = 502;
    for (const p of persons) VK.upsertPerson(CH, p);
    VK.upsertPerson(CH, VK.parseTrigger('Анна+Пётр 1985~').rec);
    assert.equal(VK.upcomingEvents(CH, true), EXPECTED.events.full, 'VK upcomingEvents полный');
    assert.equal(VK.upcomingEvents(CH, false), EXPECTED.events.bell, 'VK upcomingEvents круговой');
    assert.equal(VK.upcomingEvents(CH, false, '01-15'), EXPECTED.events.bell_0115, 'VK upcomingEvents от 01-15');
    assert.equal(VK.upcomingEvents(CH, false, '12-15'), EXPECTED.events.bell_1215, 'VK upcomingEvents от 12-15');
    assert.equal(VK.upcomingEvents(CH, false, '02-28'), EXPECTED.events.bell_0229, 'VK upcomingEvents от 02-28');
    assert.equal(VK.upcomingEvents(EMPTY, true), EXPECTED.events.empty, 'VK upcomingEvents пусто');
    assert.equal(VK.upcomingEvents(EMPTY, false, '06-01'), EXPECTED.events.empty_bell, 'VK upcomingEvents пусто круговой');
    // фокус-список ВК теперь канон (reqLib tree) — те же ожидания
    checkCanon('VK.focusListText');
    // канон eventListText на живых rows ВК (обёртка отдаёт те же rows канону)
    const rows = [...VK.personRows(CH), ...VK.weddingRows(CH)];
    assert.equal(tree.eventListText(rows, true), EXPECTED.events.full, 'eventListText rows ВК полный');
    assert.equal(tree.eventListText(rows, false), EXPECTED.events.bell, 'eventListText rows ВК круговой');
    assert.equal(tree.eventListText(rows, false, '01-15'), EXPECTED.events.bell_0115, 'eventListText rows ВК от 01-15');
}

// ТГ: sdk-mock + bot.js (LR_DEV_DB — свой TMP, dev/tg-db.json не трогается)
async function checkTgAdapter() {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-a3list-tg-'));
    process.env.LR_DEV_DB = path.join(TMP, 'tg-db.json');
    fs.cpSync(path.join(ROOT, 'dev', 'sdk-mock'), path.join(ROOT, 'node_modules', 'sdk'), { recursive: true });
    const TG = await import(path.join(ROOT, 'tgcloud', 'lib', 'bot.js'));
    const TGP = await import(path.join(ROOT, 'tgcloud', 'lib', 'parse.cjs'));
    const CH = 501, EMPTY = 502;
    for (const p of persons) await TG.upsertPerson(CH, p);
    await TG.upsertPerson(CH, TGP.parseTrigger('Анна+Пётр 1985~').rec);
    assert.equal(await TG.upcomingText(CH, true), EXPECTED.events.full, 'TG upcomingText полный');
    assert.equal(await TG.upcomingText(CH, false), EXPECTED.events.bell, 'TG upcomingText круговой');
    assert.equal(await TG.upcomingText(CH, false, '01-15'), EXPECTED.events.bell_0115, 'TG upcomingText от 01-15');
    assert.equal(await TG.upcomingText(CH, false, '12-15'), EXPECTED.events.bell_1215, 'TG upcomingText от 12-15');
    assert.equal(await TG.upcomingText(CH, false, '02-28'), EXPECTED.events.bell_0229, 'TG upcomingText от 02-28');
    assert.equal(await TG.upcomingText(EMPTY, true), EXPECTED.events.empty, 'TG upcomingText пусто');
    assert.equal(await TG.upcomingText(EMPTY, false, '06-01'), EXPECTED.events.empty_bell, 'TG upcomingText пусто круговой');
    // focusListText у ТГ — реэкспорт канона из bot.js (импорт handlers не менялся)
    assert.equal(typeof TG.focusListText, 'function', 'TG focusListText реэкспортирован');
    assert.equal(TG.focusListText(items, R2_KEYS, sonKey, pairs, spousePairs, sexOf, false, '12-01'),
        EXPECTED.focus.r2_1215, 'TG focusListText от 12-01');
}

const isMain = process.argv[1] && import.meta.url === url.pathToFileURL(path.resolve(process.argv[1])).href;
checkCanon('tree.cjs');
if (isMain) {
    checkVkAdapter();
    await checkTgAdapter();
    console.log('A3 list expectations: OK (канон tree.cjs + адаптеры ВК/ТГ)');
}
