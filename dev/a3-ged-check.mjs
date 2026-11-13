// dev/a3-ged-check.mjs — независимые ожидаемые результаты каскада фиктивных
// дат GEDCOM-импорта (волна A3, план .kilo/plans/20261108-canon-pure-a3-plan.md).
//
// Литералы сняты с текущего ВК ДО удаления встроенной копии: тело каскада
// (block fullOf в importGedcom lunarreturns.js) вырезается из исходника и
// исполняется в VM с каноническим datePlusYears (flat.cjs). После переноса
// в канон проверяется tgcloud/lib/parse.cjs gedFictiveDates (тот же контракт:
// (g, famRefs, resolved) → Map xref → полная дата|null; входы не мутируются).
// Поведенческая сверка ВК/ТГ на импорте — в dev/sync-check.mjs (GED_KIDS и
// соседние блоки), здесь — чистый seam с конкретными ожиданиями.
//
// Запуск: node dev/a3-ged-check.mjs (также автоматически из dev/sync-check.mjs)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const canon = require('../tgcloud/lib/parse.cjs');
const { datePlusYears } = require('../tgcloud/lib/flat.cjs');

// каскад: канон после переноса, иначе — встроенное тело из ВК (этап снятия
// ожиданий, канона ещё нет)
function loadCascade() {
    if (typeof canon.gedFictiveDates === 'function') return { canon: true, f: canon.gedFictiveDates };
    const src = fs.readFileSync(new URL('../lunarreturns.js', import.meta.url), 'utf8');
    const m = src.match(/const fullOf = new Map\(\);[\s\S]*?if \(!changed\) break;\n    \}/);
    if (!m) throw new Error('каскад не найден: ни канона gedFictiveDates, ни блока fullOf в lunarreturns.js');
    return { canon: false, f: vm.runInNewContext('(function (g, famRefs, resolved, datePlusYears) {' + m[0] + '\nreturn fullOf;\n})', {}) };
}
const cascade = loadCascade();
const run = (g, famRefs, resolved) => cascade.canon
    ? cascade.f(g, famRefs, resolved)
    : cascade.f(g, famRefs, resolved, datePlusYears);

// входы адаптеров: famRefs — xref'ы, упомянутые в семьях; resolved —
// послеколлизионные даты датированных
const famRefsOf = g => {
    const s = new Set();
    for (const f of g.fams) {
        if (f.husb) s.add(f.husb);
        if (f.wife) s.add(f.wife);
        for (const cx of f.chil) s.add(cx);
    }
    return s;
};
const ged = lines => canon.parseGedcom(['0 HEAD', '1 GEDC', '2 VERS 5.5.1', ...lines, '0 TRLR'].join('\n'));

const cases = [
    {
        name: 'старый стиль: сохранение даты якоря без сдвига календаря',
        g: ged([
            '0 @OS1@ INDI', '1 NAME Родитель /С/', '1 BIRT', '2 DATE 31 DEC 1899',
            '0 @OS2@ INDI', '1 NAME Ребёнок /С/',
            '0 @OS3@ INDI', '1 NAME Умерший /С/', '1 DEAT', '2 DATE 1 JAN 1950',
            '0 @OSF@ FAM', '1 HUSB @OS1@', '1 CHIL @OS2@', '1 CHIL @OS3@', '1 MARR']),
        resolved: new Map([['OS1', '1899-12-31']]),
        want: [['OS1', '1899-12-31'], ['OS2', '1919-12-31'], ['OS3', '1920-12-31']],
    },
    {
        // дети без дат: якорь — датный сиблинг +1, следующий +1 к предыдущему
        name: 'дети без дат: якорь датный сиблинг, каскад +1',
        g: ged([
            '0 @A1@ INDI', '1 NAME Отец /Т/', '1 BIRT', '2 DATE 15 JUN 1950',
            '0 @A2@ INDI', '1 NAME Мать /Т/', '1 SEX F', '1 BIRT', '2 DATE 1 AUG 1952',
            '0 @A3@ INDI', '1 NAME Старший /Т/', '1 BIRT', '2 DATE 10 MAR 1975',
            '0 @A4@ INDI', '1 NAME Средний /Т/',
            '0 @A5@ INDI', '1 NAME Младший /Т/',
            '0 @K1@ FAM', '1 HUSB @A1@', '1 WIFE @A2@', '1 CHIL @A3@', '1 CHIL @A4@', '1 CHIL @A5@',
            '1 MARR', '2 DATE 1 MAY 1974']),
        resolved: new Map([['A1', '1950-06-15'], ['A2', '1952-08-01'], ['A3', '1975-03-10']]),
        want: [['A1', '1950-06-15'], ['A2', '1952-08-01'], ['A3', '1975-03-10'],
            ['A4', '1976-03-10'], ['A5', '1977-03-10']],
    },
    {
        // несколько поколений: супруг — дата партнёра; ребёнок — родитель +20;
        // фиктивная ДР родителя (Сын) — якорь для следующего поколения
        name: 'поколения: супруг←партнёр, ребёнок←родитель+20, внук←фиктивный родитель+20',
        g: ged([
            '0 @B1@ INDI', '1 NAME Дед /Р/', '1 BIRT', '2 DATE 1 JAN 1930',
            '0 @B2@ INDI', '1 NAME Бабушка /Р/', '1 SEX F',
            '0 @B3@ INDI', '1 NAME Сын /Р/',
            '0 @B4@ INDI', '1 NAME Невестка /Р/', '1 SEX F',
            '0 @B5@ INDI', '1 NAME Внук /Р/',
            '0 @K1@ FAM', '1 HUSB @B1@', '1 WIFE @B2@', '1 CHIL @B3@',
            '0 @K2@ FAM', '1 HUSB @B3@', '1 WIFE @B4@', '1 CHIL @B5@']),
        resolved: new Map([['B1', '1930-01-01']]),
        want: [['B1', '1930-01-01'], ['B2', '1930-01-01'], ['B3', '1950-01-01'],
            ['B4', '1950-01-01'], ['B5', '1970-01-01']],
    },
    {
        // неполная семья (без мужа): якорь — свадьба +1; 29 февраля → 1 марта
        // (1981 невисокосный); второй бездатный — +1 к предыдущему
        name: 'мать одна: якорь свадьба+1, сдвиг 29 фев → 1 мар',
        g: ged([
            '0 @C1@ INDI', '1 NAME Мать /М/', '1 SEX F', '1 BIRT', '2 DATE 28 FEB 1960',
            '0 @C2@ INDI', '1 NAME Дочь /М/', '1 SEX F',
            '0 @C3@ INDI', '1 NAME Сын /М/',
            '0 @K1@ FAM', '1 WIFE @C1@', '1 CHIL @C2@', '1 CHIL @C3@',
            '1 MARR', '2 DATE 29 FEB 1980']),
        resolved: new Map([['C1', '1960-02-28']]),
        want: [['C1', '1960-02-28'], ['C2', '1981-03-01'], ['C3', '1982-03-01']],
    },
    {
        // отсутствие опорных дат: бездатные в семье — заглушки (null);
        // бездатный вне семей и безымянный датированный — вовсе мимо карты
        name: 'без якорей: null-заглушки, посторонние мимо',
        g: ged([
            '0 @D1@ INDI', '1 NAME Сирота1 /С/',
            '0 @D2@ INDI', '1 NAME Сирота2 /С/',
            '0 @D3@ INDI', '1 NAME Сирота3 /С/',
            '0 @D4@ INDI', '1 BIRT', '2 DATE 1 JAN 1900',
            '0 @K1@ FAM', '1 CHIL @D1@', '1 CHIL @D2@']),
        resolved: new Map(),
        want: [['D1', null], ['D2', null]],
    },
    {
        // дубль имени в файле: resolved несёт послеколлизионные (здесь —
        // несдвинутые) даты обоих; бездатный брат якорится по датному сиблингу
        name: 'дубли «Иван»: resolved, брат←сиблинг+1',
        g: ged([
            '0 @E1@ INDI', '1 NAME Иван /И/', '1 BIRT', '2 DATE 10 MAY 1960',
            '0 @E2@ INDI', '1 NAME Иван /И/', '1 BIRT', '2 DATE 10 MAY 1960',
            '0 @E3@ INDI', '1 NAME Брат /И/',
            '0 @K1@ FAM', '1 CHIL @E1@', '1 CHIL @E3@',
            '0 @K2@ FAM', '1 CHIL @E2@']),
        resolved: new Map([['E1', '1960-05-10'], ['E2', '1960-05-10']]),
        want: [['E1', '1960-05-10'], ['E2', '1960-05-10'], ['E3', '1961-05-10']],
    },
    {
        // контракт resolved: послеколлизионная дата перекрывает дату файла
        // (адаптер кладёт u.birtD; якорь сиблинга — от перекрытой даты)
        name: 'resolved перекрывает дату файла',
        g: ged([
            '0 @E1@ INDI', '1 NAME Иван /И/', '1 BIRT', '2 DATE 10 MAY 1960',
            '0 @E2@ INDI', '1 NAME Иван /И/', '1 BIRT', '2 DATE 10 MAY 1960',
            '0 @E3@ INDI', '1 NAME Брат /И/',
            '0 @K1@ FAM', '1 CHIL @E1@', '1 CHIL @E3@',
            '0 @K2@ FAM', '1 CHIL @E2@']),
        resolved: new Map([['E1', '1962-07-07'], ['E2', '1960-05-10']]),
        want: [['E1', '1962-07-07'], ['E2', '1960-05-10'], ['E3', '1963-07-07']],
    },
    {
        // приоритет якоря: свадьба+1 бьёт «родитель+20» (дети 1941-го при
        // отцах 1945-го); одинаковые имена/даты разных семей — фиктивная
        // коллизия уже на уровне адаптера (uniqueKeyOf yearly), здесь же
        // обе карты сходятся к одной дате
        name: 'приоритет: свадьба+1 сильнее родитель+20 (29 фев 1940)',
        g: ged([
            '0 @G1@ INDI', '1 NAME Отец1 /Г/', '1 BIRT', '2 DATE 1 JAN 1945',
            '0 @G2@ INDI', '1 NAME Отец2 /Г/', '1 BIRT', '2 DATE 1 JAN 1945',
            '0 @G3@ INDI', '1 NAME Близнец /Г/',
            '0 @G4@ INDI', '1 NAME Близнец /Г/',
            '0 @K1@ FAM', '1 HUSB @G1@', '1 CHIL @G3@', '1 MARR', '2 DATE 29 FEB 1940',
            '0 @K2@ FAM', '1 HUSB @G2@', '1 CHIL @G4@', '1 MARR', '2 DATE 29 FEB 1940']),
        resolved: new Map([['G1', '1945-01-01'], ['G2', '1945-01-01']]),
        want: [['G1', '1945-01-01'], ['G2', '1945-01-01'],
            ['G3', '1941-03-01'], ['G4', '1941-03-01']],
    },
    {
        // родитель+20 через високосный 29 февраля: 1984+20=2004 високосный —
        // день сохраняется
        name: 'родитель+20: 29 фев 1984 → 29 фев 2004',
        g: ged([
            '0 @H1@ INDI', '1 NAME Отец /Х/', '1 BIRT', '2 DATE 29 FEB 1984',
            '0 @H2@ INDI', '1 NAME Ребёнок /Х/',
            '0 @K1@ FAM', '1 HUSB @H1@', '1 CHIL @H2@']),
        resolved: new Map([['H1', '1984-02-29']]),
        want: [['H1', '1984-02-29'], ['H2', '2004-02-29']],
    },
    {
        // неполная семья (без родителей вовсе): якорь — датный сиблинг;
        // 29 февраля +1 в невисокосный → 1 марта
        name: 'без родителей: сиблинг 29 фев 1984 → +1 = 1 мар 1985',
        g: ged([
            '0 @J1@ INDI', '1 NAME Старшая /Й/', '1 SEX F', '1 BIRT', '2 DATE 29 FEB 1984',
            '0 @J2@ INDI', '1 NAME Средний /Й/',
            '0 @J3@ INDI', '1 NAME Младший /Й/',
            '0 @K1@ FAM', '1 CHIL @J1@', '1 CHIL @J2@', '1 CHIL @J3@']),
        resolved: new Map([['J1', '1984-02-29']]),
        want: [['J1', '1984-02-29'], ['J2', '1985-03-01'], ['J3', '1986-03-01']],
    },
    {
        // общий родитель, семьи без свадьбы у второй: максимум+1 среди датных
        // детей семей общего родителя (первенцы разных жён не совпадают);
        // порядок fam файла значим (поведение ВК зафиксировано как есть)
        name: 'полусиблы по общему родителю: cousMax+1',
        g: ged([
            '0 @L1@ INDI', '1 NAME Отец /Л/', '1 BIRT', '2 DATE 1 JAN 1950',
            '0 @L2@ INDI', '1 NAME Жена1 /Л/', '1 SEX F',
            '0 @L3@ INDI', '1 NAME Жена2 /Л/', '1 SEX F',
            '0 @L4@ INDI', '1 NAME Дочь1 /Л/', '1 SEX F',
            '0 @L5@ INDI', '1 NAME Сын1 /Л/',
            '0 @K1@ FAM', '1 HUSB @L1@', '1 WIFE @L2@', '1 CHIL @L4@', '1 MARR', '2 DATE 1 JUN 1975',
            '0 @K2@ FAM', '1 HUSB @L1@', '1 WIFE @L3@', '1 CHIL @L5@']),
        resolved: new Map([['L1', '1950-01-01']]),
        want: [['L1', '1950-01-01'], ['L2', '1950-01-01'], ['L3', '1950-01-01'],
            ['L4', '1976-06-01'], ['L5', '1977-06-01']],
    },
];

// Один бездатный ребёнок; датные сиблинги намеренно стоят после него в CHIL.
for (const [name, marr, div, death, siblings, want] of [
    ['свадьба ограничивает ранний якорь', '1900-06-01', null, null, ['1900-01-01'], '1901-06-01'],
    ['смерть: свободное место до младшего', null, null, '1904-01-01', ['1905-01-01'], '1904-01-01'],
    ['развод: свободное место между детьми', '1900-01-01', '1904-01-01', null, ['1902-01-01', '1906-01-01'], '1905-01-01'],
    ['ровно год между детьми', '1900-01-01', '1902-01-01', '1903-01-01', ['1902-01-01', '1904-01-01'], '1903-01-01'],
    ['нет места: день смерти', '1900-01-01', null, '1901-06-01', ['1901-01-01'], '1901-06-01'],
    ['нет места и смерти: старый вариант', '1900-01-01', '1900-01-01', null, ['1901-01-01'], '1902-01-01'],
    ['смерть до свадьбы', '1900-01-01', null, '1899-12-31', [], '1899-12-31'],
    ['только смерть', null, null, '1900-05-06', [], '1900-05-06'],
    ['високосная граница свадьбы', '1904-02-29', null, '1905-03-01', [], '1905-03-01'],
    ['ограничение внутри одного года', null, null, '1904-04-01', ['1905-03-01'], '1904-03-01'],
]) {
    const g = {
        indis: [{ __xref: 'C', name: 'Child', deat: death ? { date: death } : undefined },
            ...siblings.map((d, i) => ({ __xref: 'S' + i, name: 'Sibling' + i, birt: { date: d } }))],
        fams: [{ chil: ['C', ...siblings.map((_, i) => 'S' + i)],
            marr: marr ? { date: marr } : undefined, div: div ? { date: div } : undefined }],
    };
    cases.push({ name, g, resolved: new Map(), want: [['C', want], ...siblings.map((d, i) => ['S' + i, d])] });
}
cases.push({
    name: 'частичные даты: первая назначившая семья, супруги без изменений',
    g: ged([
        '0 @P@ INDI', '1 NAME Parent', '1 BIRT', '2 DATE 1880',
        '0 @W@ INDI', '1 NAME Wife',
        '0 @C@ INDI', '1 NAME Child', '1 DEAT', '2 DATE JUN 1903',
        '0 @S@ INDI', '1 NAME Sibling', '1 BIRT', '2 DATE 1904',
        '0 @F@ FAM', '1 HUSB @P@', '1 WIFE @W@', '1 CHIL @C@', '1 CHIL @S@',
        '1 MARR', '2 DATE 1900', '1 DIV', '2 DATE 1902',
        '0 @F2@ FAM', '1 CHIL @C@', '1 MARR', '2 DATE 1950',
    ]),
    resolved: new Map(),
    want: [['P', '1880-01-01'], ['W', '1880-01-01'], ['C', '1903-01-01'], ['S', '1904-01-01']],
});
cases.push({
    name: 'полусиблинг не блокирует место, выбранная дата якорит следующего',
    g: ged([
        '0 @P@ INDI', '1 NAME Parent', '1 BIRT', '2 DATE 1 JAN 1880',
        '0 @S@ INDI', '1 NAME Half', '1 BIRT', '2 DATE 1 JUN 1901',
        '0 @C@ INDI', '1 NAME Child', '0 @D@ INDI', '1 NAME Next',
        '0 @F1@ FAM', '1 HUSB @P@', '1 CHIL @S@',
        '0 @F2@ FAM', '1 HUSB @P@', '1 CHIL @C@', '1 CHIL @D@',
        '1 MARR', '2 DATE 1 JAN 1900',
    ]),
    resolved: new Map(),
    want: [['P', '1880-01-01'], ['S', '1901-06-01'], ['C', '1901-01-01'], ['D', '1902-01-01']],
});

for (const [name, parentBirth, parentDeath, spouseBirth, childBirth, want] of [
    ['день смерти ограничен первенцем', null, '1937-01-01', '1886-03-01', '1909-10-19', '1886-03-01'],
    ['поздний супруг ограничен первенцем', null, null, '1937-01-01', '1909-10-19', '1889-10-19'],
    ['известная дата родителя не исправляется', '1937-01-01', null, '1886-03-01', '1909-10-19', '1937-01-01'],
    ['високосный первенец минус двадцать', null, null, '2000-01-01', '1904-02-29', '1884-02-29'],
]) {
    const g = { indis: [
        { __xref: 'P', name: 'Parent', birt: parentBirth ? { date: parentBirth } : undefined,
            deat: parentDeath ? { date: parentDeath } : undefined },
        { __xref: 'W', name: 'Spouse', birt: { date: spouseBirth } },
        { __xref: 'C', name: 'First', birt: { date: childBirth } },
    ], fams: [{ husb: 'P', wife: 'W', chil: ['C'] }] };
    cases.push({ name, g, resolved: new Map(), want: [['P', want], ['W', spouseBirth], ['C', childBirth]] });
}
cases.push({
    name: 'запасная смерть ребёнка-родителя ограничена первенцем другого брака',
    g: ged([
        '0 @G@ INDI', '1 NAME Grandparent', '1 BIRT', '2 DATE 1900',
        '0 @P@ INDI', '1 NAME Parent', '1 DEAT', '2 DATE 1937',
        '0 @C@ INDI', '1 NAME Child', '1 BIRT', '2 DATE 19 OCT 1909',
        '0 @D@ INDI', '1 NAME Older', '1 BIRT', '2 DATE 1 JAN 1900',
        '0 @F@ FAM', '1 HUSB @G@', '1 CHIL @P@', '1 MARR', '2 DATE 1938',
        '0 @F2@ FAM', '1 HUSB @P@', '1 CHIL @C@',
        '0 @F3@ FAM', '1 HUSB @P@', '1 CHIL @D@',
    ]), resolved: new Map(),
    want: [['G', '1900-01-01'], ['P', '1880-01-01'], ['C', '1909-10-19'], ['D', '1900-01-01']],
});

cases.push({
    name: 'одинокий бездатный родитель: первенец сам служит якорем',
    g: ged(['0 @P@ INDI', '1 NAME Parent',
        '0 @C@ INDI', '1 NAME Child', '1 BIRT', '2 DATE 19 OCT 1909',
        '0 @F@ FAM', '1 HUSB @P@', '1 CHIL @C@']),
    resolved: new Map(), want: [['P', '1889-10-19'], ['C', '1909-10-19']],
});

for (const c of cases) {
    const famRefs = famRefsOf(c.g);
    const resolvedBefore = JSON.stringify([...c.resolved.entries()]);
    const gedBefore = JSON.stringify(c.g);
    const refsBefore = [...famRefs];
    const norm = m => [...m.entries()].map(([k, v]) => [k, v]).sort((a, b) => a[0] < b[0] ? -1 : 1); // VM-realm → host
    const fullOf = run(c.g, famRefs, c.resolved);
    const got = norm(fullOf);
    const want = [...c.want].sort((a, b) => a[0] < b[0] ? -1 : 1);
    assert.deepEqual(got, want, c.name + '\n  факт: ' + JSON.stringify(got));
    // чистота: входы не мутируются, повторный вызов — тот же результат
    assert.equal(JSON.stringify([...c.resolved.entries()]), resolvedBefore, c.name + ': resolved мутирован');
    assert.equal(JSON.stringify(c.g), gedBefore, c.name + ': GEDCOM мутирован');
    assert.deepEqual([...famRefs], refsBefore, c.name + ': famRefs мутирован');
    assert.deepEqual(norm(run(c.g, famRefs, c.resolved)), want, c.name + ': повторный вызов');
}

console.log('A3 ged fictive-cascade expectations: OK'
    + ' (' + (cascade.canon ? 'canon gedFictiveDates' : 'inline VK body, pre-extraction') + ', '
    + cases.length + ' сценариев)');
