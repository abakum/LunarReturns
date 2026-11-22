import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { unzipSync } from 'fflate';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { viewerHtml, viewerAnnotations } = require('../tgcloud/lib/viewer.cjs');
const { viewerEpub } = require('../tgcloud/lib/epub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-viewer-'));
const gedcom = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Иван /Тест/
1 SEX M
1 BIRT
2 DATE 1 JAN 1980
2 PLAC SECRET_PLACE
1 FAMC @F1@
0 @I2@ INDI
1 NAME Отец /Тест/
1 FAMS @F1@
0 @I3@ INDI
1 NAME Мать /Тест/
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
0 TRLR`;
const snapshot = [[{ key: 'I1', name: 'Иван Тест', d: '1980-01-01', plac: 'SECRET_PLACE', sex: 'M', note: 'Первая^Вторая^' },
    { key: 'I2', name: 'Отец Тест', sex: 'M' }, { key: 'I3', name: 'Мать Тест', sex: 'F' },
    { key: 'OUT', name: 'Брат вне файла', sex: 'M', d: '2000-01-01', plac: 'чужое место', note: 'чужая заметка' },
    { key: 'OUTCHILD', name: 'Сын вне файла', sex: 'M', d: '2020-01-01' },
    { key: 'UNRELATED', name: 'НЕ_ЭКСПОРТИРОВАН', d: '2000-01-01' }],
    [{ xref: 'F1', hKey: 'I2', wKey: 'I3', children: ['I1', 'OUT'] },
        { xref: 'FOUT', hKey: 'I1', children: ['OUTCHILD'] }]];
const annotations = viewerAnnotations(gedcom, snapshot);
assert.doesNotMatch(JSON.stringify(annotations.I1), /НЕ_ЭКСПОРТИРОВАН|чужая|чужое|OUT/);
assert.deepEqual(Object.keys(annotations).sort(), ['I1', 'I2', 'I3']);
assert.deepEqual(annotations.I1.slice(0, 4), [
    { prefix: '=', text: 'Мать Тест', xref: 'I3', kinship: 'мать' }, { text: '+' },
    { prefix: '', text: 'Отец Тест', xref: 'I2', kinship: 'отец' },
    { hero: true, text: '--Иван Тест 1980-01-01 (SECRET_PLACE)\nПервая\nВторая', links: [
        { start: 23, end: 37, href: 'https://ya.ru/maps/?text=SECRET_PLACE' },
    ] },
]);
assert.deepEqual(annotations.I1.filter(row => row.text.includes('вне файла')).map(({ text, kinship }) => [text, kinship]),
    [['Сын вне файла 2020-01-01', 'сын'], ['Брат вне файла 2000-01-01', 'брат']]);
assert.equal(annotations.I2[0].text, '-Отец Тест');
assert.equal(annotations.I2.find(row => row.xref === 'I1').kinship, 'сын');
{
    const [persons, fams] = structuredClone(snapshot);
    const coords = 'https://ya.ru/maps/?pt=33.821283,48.466825&z=13';
    persons[0].note += 'Жил: 2000 (Первый район Город) <личная заметка>^Титул: Герой 2001[^Титул: Герой 2002]^'
        + `Рождение: 1980-01-01 (SECRET_PLACE) справка ${coords}^Похоронен: ${coords}^Жил: 1920 (Старый)^Жил: 1921 (Город & край)^Жил: (Недатированный)^`;
    persons[1].note = 'чужая заметка';
    persons.push({ key: 'I4', name: 'Тёзка', nameOnly: true },
        { key: 'I5', name: 'Ребёнок', d: '2000-01-01', abt: 1, plac: 'чужое место' },
        { key: 'I6', name: 'Тёзка', nameOnly: true });
    fams[0].marr = { d: '1979-01-01', plac: 'чужая свадьба' };
    fams.push({ xref: 'F2', hKey: 'I1', wKey: 'I4', children: ['I5'],
        marr: { d: '2001-01-01', plac: 'Город, Область' }, div: { d: '2002-01-01' },
        note: `семейная заметка^Свадьба: 2001-01-01 (Город, Область) ${coords}^` },
    { xref: 'F3', hKey: 'I1', wKey: 'I6', children: [] });
    const extended = gedcom.replace('0 TRLR', '0 @I4@ INDI\n0 @I5@ INDI\n0 @I6@ INDI\n0 @F2@ FAM\n0 @F3@ FAM\n0 TRLR');
    const before = structuredClone([persons, fams]);
    const byId = viewerAnnotations(extended, [persons, fams]);
    assert.match(byId.I1.find(row => row.hero).text,
        /Жил: 2000 \(Первый район Город\) <личная заметка>\nТитул: Герой 2001\[\nТитул: Герой 2002\]/);
    assert.doesNotMatch(byId.I1.map(row => row.text).join('\n'), /чужая|чужое|семейная заметка|НЕ_ЭКСПОРТИРОВАН/);
    const wedding = byId.I1.find(row => row.text.startsWith('++2001-01-01 (Город, Область) 2002-01-01'));
    assert.ok(wedding);
    assert.deepEqual(wedding.links.map(l => [wedding.text.slice(l.start, l.end), l.href]),
        [['(Город, Область)', coords]]);
    assert.doesNotMatch(wedding.text, /Свадьба:/);
    const hero = byId.I1.find(row => row.hero);
    assert.doesNotMatch(hero.text, /https:\/\//);
    assert.match(hero.text, /\(SECRET_PLACE\) справка\nПохоронен: \(48\.466825, 33\.821283\)/);
    assert.deepEqual(hero.links.map(l => [hero.text.slice(l.start, l.end), l.href]), [
        ['(SECRET_PLACE)', coords],
        ['(Первый район Город)', 'https://ya.ru/maps/?text=' + encodeURIComponent('Первый район Город')],
        ['(SECRET_PLACE)', coords], ['(48.466825, 33.821283)', coords],
        ['(Город & край)', 'https://ya.ru/maps/?text=' + encodeURIComponent('Город & край')],
        ['(Недатированный)', 'https://ya.ru/maps/?text=' + encodeURIComponent('Недатированный')],
    ]);
    assert.deepEqual(byId.I1.filter(row => row.text === 'Тёзка').map(row => row.xref).sort(), ['I4', 'I6']);
    assert.deepEqual(byId.I1.find(row => row.xref === 'I5'), { prefix: '---', text: 'Ребёнок 2000-01', xref: 'I5', kinship: 'ребёнок' });
    assert.equal(byId.I1.find(row => row.xref === 'I4').kinship, 'супруг');
    assert.deepEqual([persons, fams], before);
    for (const d of ['1919-01-01', '1920-01-01', undefined]) {
        const old = viewerAnnotations(extended, [[{ ...persons[0], d, nameOnly: !d }, ...persons.slice(1)], fams]);
        const row = old.I1.find(row => row.hero);
        assert.ok(!row.links.some(l => row.text.slice(l.start, l.end) === '(Недатированный)'));
        assert.ok(row.links.some(l => row.text.slice(l.start, l.end) === '(48.466825, 33.821283)' && l.href === coords));
    }
}
{
    const coords = 'https://ya.ru/maps/?pt=33.821283,48.466825&z=13';
    const other = 'https://ya.ru/maps/?pt=34,49&z=13';
    const [persons, fams] = structuredClone(snapshot);
    Object.assign(persons[0], { dd: '1969-03-07', dp: 'Миллерово', note: [
        `Рождение: 1980-01-01 (SECRET_PLACE) ${coords}`,
        `Смерть: 1969-03-07 (Миллерово) ${coords}`,
        `Похоронен: 1969-03-07 (Миллерово) ${coords}`,
        `Похоронен: 1969-03-09 (Миллерово) ${coords}`,
        `Похоронен: 1969-03-07 (Миллерово) ${other}`,
        'Похоронен: 1969-03-07 (Миллерово) участок 3',
    ].join('^') });
    Object.assign(fams[0], { hKey: 'I1', wKey: 'I2', children: [],
        marr: { d: '2001-01-01', plac: 'Город' }, div: { d: '2002-01-01', plac: 'Город' },
        note: `Свадьба: 2001-01-01 (Город) ${coords}^Развод: 2002-01-01 (Город) ${other}^Развод: 2003-01-01 (Город) решение суда`,
    });
    const rows = viewerAnnotations(gedcom, [persons, fams]).I1;
    const hero = rows.find(row => row.hero);
    assert.doesNotMatch(hero.text, /Рождение:|Смерть:/);
    assert.equal(hero.text.match(/^Похоронен:/gm).length, 3);
    assert.match(hero.text, /Похоронен: 1969-03-09.*\nПохоронен: 1969-03-07.*\nПохоронен: 1969-03-07 \(Миллерово\) участок 3/);
    assert.deepEqual(hero.links.slice(0, 2).map(l => l.href), [coords, coords]);
    const family = rows.find(row => row.text.includes('2001-01-01 (Город)'));
    assert.doesNotMatch(family.text, /Свадьба:|Развод: 2002/);
    assert.match(family.text, /Развод: 2003-01-01 \(Город\) решение суда/);
    assert.deepEqual(family.links.slice(0, 2).map(l => l.href), [coords, other]);
}
{
    const [persons, fams] = structuredClone(snapshot);
    const place = 'Россия, Ростовская область, Каменский район, станция Лихая';
    const href = 'https://ya.ru/maps/?text=' + encodeURIComponent(place);
    Object.assign(persons[0], { d: '1909-04-11', dd: '1976-12-04', dp: place });
    for (const [date, linked] of [['', true], ['1920 ', false]]) {
        const burial = `Похоронен: ${date}(${place}) старое кладбище в районе парка Победы`;
        persons[0].note = burial + '^';
        const row = viewerAnnotations(gedcom, [persons, fams]).I1.find(row => row.hero);
        assert.ok(row.text.endsWith('\n' + burial));
        assert.deepEqual(row.links.filter(l => l.start >= row.text.indexOf('Похоронен:')).map(l => l.href), linked ? [href] : []);
    }
}
const html = viewerHtml(gedcom, 'Тест <дерева>', 'I1', annotations);
const data = JSON.parse(html.match(/<script id="tree-data" type="application\/json">(.*?)<\/script>/s)[1]);
assert.equal(data.gedcom, gedcom);
assert.equal(data.heroXref, 'I1');
const hostile = viewerHtml('</script><script>globalThis.pwned=1</script>\u2028', '<img src=x onerror=alert(1)>');
assert(!hostile.includes('<img src=x'));
assert(!hostile.includes('</script><script>globalThis.pwned'));
fs.writeFileSync(path.join(dir, 'tree.html'), html);
fs.writeFileSync(path.join(dir, 'empty.html'), viewerHtml('0 HEAD\n0 TRLR', 'Пустое дерево'));
const romanov = fs.readFileSync(new URL('./fixtures/Romanov_family.ged', import.meta.url), 'utf8');
fs.writeFileSync(path.join(dir, 'romanov.html'), viewerHtml(romanov, 'Романовы'));
fs.writeFileSync(path.join(dir, 'single.html'), viewerHtml('0 HEAD\n0 @I1@ INDI\n1 NAME Один\n0 TRLR', 'Один', 'absent'));
const large = '0 HEAD\n' + Array.from({ length: 10000 }, (_, i) => `0 @I${i}@ INDI\n1 NAME Тёзка\n`).join('') + '0 TRLR';
fs.writeFileSync(path.join(dir, 'large.html'), viewerHtml(large, '10 000 персон'));
const longText = '0 HEAD\n0 @I0@ INDI\n1 NAME Один\n1 NOTE Длинное примечание\n'
    + ('2 CONT ' + 'x'.repeat(200) + '\n').repeat(41000) + '0 TRLR';
assert.ok(Buffer.byteLength(longText) > 8 * 1024 * 1024);
fs.writeFileSync(path.join(dir, 'long-text.html'), viewerHtml(longText, 'Большой GEDCOM'));
const wide = '0 HEAD\n0 @I0@ INDI\n1 NAME Родитель\n1 FAMS @F1@\n'
    + Array.from({ length: 999 }, (_, i) => `0 @I${i + 1}@ INDI\n1 NAME Ребёнок ${i}\n1 FAMC @F1@\n`).join('')
    + '0 @F1@ FAM\n1 HUSB @I0@\n' + Array.from({ length: 999 }, (_, i) => `1 CHIL @I${i + 1}@\n`).join('') + '0 TRLR';
fs.writeFileSync(path.join(dir, 'wide.html'), viewerHtml(wide, 'Большая семья', 'I0'));
fs.writeFileSync(path.join(dir, 'refocus.html'), viewerHtml(wide, 'Большая семья', 'I1'));
fs.writeFileSync(path.join(dir, 'oversized.html'), viewerHtml(large.replace('0 TRLR', '0 @I10000@ INDI\n1 NAME Лишний\n0 TRLR'), '10 001 персона'));
console.log('viewer generation and escaping: OK');
const browser = await chromium.launch();
try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport, offline: true, hasTouch: viewport.width < 500 });
        const page = await context.newPage();
        const errors = [], external = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (/^https?:/.test(r.url())) external.push(r.url()); });
        await page.goto(pathToFileURL(path.join(dir, 'tree.html')).href);
        const picker = page.getByRole('combobox');
        const options = page.getByRole('option');
        const hash = () => new URL(page.url()).hash;
        assert.equal(await page.locator('#status').textContent(), '');
        assert.equal(await page.locator('h1, label, details, .privacy').count(), 0);
        assert.match(await picker.inputValue(), /\(I1\)$/);
        const tip = page.locator('#touch-tip');
        assert(await tip.isVisible());
        const treeLink = tip.getByRole('link', { name: 'дерево', exact: true });
        assert.equal(await treeLink.getAttribute('href'), 'https://pewu.github.io/topola-viewer/');
        assert.equal(await treeLink.getAttribute('target'), '_blank');
        const docs = tip.getByRole('link', { name: 'родственные связи' });
        assert.equal(await docs.getAttribute('href'), 'https://github.com/abakum/LunarReturns/blob/main/-%2B%3D.md');
        assert.equal(await docs.getAttribute('target'), '_blank');
        const chartTransform = () => page.locator('#chart').getAttribute('transform');
        await page.locator('#plus').click();
        const beforeDismiss = await chartTransform();
        const dismiss = tip.getByRole('button');
        if (viewport.width < 500) await dismiss.tap();
        else await dismiss.click();
        assert(await tip.isHidden());
        assert.equal(await chartTransform(), beforeDismiss);
        await page.reload();
        assert(await tip.isHidden());
        await page.evaluate(() => sessionStorage.removeItem('lunarreturns.viewer.touch-tip-dismissed'));
        await page.reload();
        assert(await tip.isVisible());
        const firstName = page.getByRole('button', { name: /Роспись: Иван/ }).first();
        const beforeName = await chartTransform();
        if (viewport.width < 500) await firstName.tap();
        else await firstName.click();
        assert(await tip.isHidden());
        assert(await page.locator('#annotation').isVisible());
        const place = page.locator('#annotation').getByRole('link', { name: '(SECRET_PLACE)', exact: true });
        assert.equal(await place.getAttribute('href'), 'https://ya.ru/maps/?text=SECRET_PLACE');
        assert.equal(await place.getAttribute('target'), '_blank');
        assert.equal(await chartTransform(), beforeName);
        assert.equal(hash(), '');
        await page.reload();
        assert(await tip.isHidden());
        assert(!(await page.locator('#chart').textContent()).includes('SECRET_PLACE'));
        assert.match(await page.locator('#chart').textContent(), /Иван/);
        assert(await page.locator('#chart rect').count() > 0);
        const initial = await page.locator('#chart').getAttribute('transform');
        await page.locator('#plus').click();
        assert.notEqual(await page.locator('#chart').getAttribute('transform'), initial);
        await page.locator('#fit').click();
        assert.equal(await page.locator('#chart').getAttribute('transform'), initial);
        await page.mouse.move(150, 300); await page.mouse.down();
        await page.mouse.move(180, 330); await page.mouse.up();
        assert.notEqual(await page.locator('#chart').getAttribute('transform'), initial);
        const beforeSearch = await chartTransform();
        await picker.click();
        assert.equal(await chartTransform(), beforeSearch);
        if (viewport.width < 500) {
            // Simulate a keyboard shrinking the layout viewport while the input has focus.
            for (const height of [viewport.height - 300, viewport.height]) {
                await page.evaluate(() => {
                    window.viewerTestResize = new Promise(resolve => window.addEventListener('resize', resolve, { once: true }));
                });
                await page.setViewportSize({ width: viewport.width, height });
                await page.evaluate(() => window.viewerTestResize);
                assert.equal(await chartTransform(), beforeSearch);
            }
        }
        assert.deepEqual(await options.allTextContents(), ['Иван Тест 1980 (I1)', 'Мать Тест (I3)', 'Отец Тест (I2)']);
        await picker.fill('1980 ИВ');
        assert.deepEqual(await options.allTextContents(), ['Иван Тест 1980 (I1)']);
        await picker.fill('нет такой персоны');
        assert.match(await page.locator('#person-results').textContent(), /Никого не найдено/);
        await picker.press('Escape');
        assert.match(await picker.inputValue(), /\(I1\)$/);
        await picker.fill('ОТ');
        await picker.press('ArrowDown');
        assert.equal(await options.first().getAttribute('aria-selected'), 'true');
        await picker.press('Enter');
        assert.match(await picker.inputValue(), /\(I2\)$/);
        assert.equal(hash(), '#person=I2');
        assert.equal(await page.locator('#status').textContent(), '');
        await page.locator('#fit').click();
        const card = page.locator('#chart .indi').filter({ hasText: 'Иван' }).first().locator('rect.border');
        const name = page.getByRole('button', { name: /Роспись: Иван/ }).first();
        assert.equal(await card.evaluate(node => getComputedStyle(node).cursor), 'pointer');
        assert.equal(await name.locator('.name').evaluate(node => getComputedStyle(node).cursor), 'help');
        await name.hover();
        assert(await page.locator('#annotation').isHidden());
        await name.click();
        assert(await page.locator('#annotation').isVisible());
        for (const key of ['Enter', 'Space']) {
            await name.press('Escape');
            assert(await page.locator('#annotation').isHidden());
            await name.press(key);
            assert(await page.locator('#annotation').isVisible());
            assert.equal(hash(), '#person=I2');
        }
        const hero = page.locator('#annotation-text strong');
        assert.match(await hero.textContent(), /^--Иван Тест .*\(SECRET_PLACE\)\nПервая\nВторая$/);
        assert.equal(await hero.evaluate(node => getComputedStyle(node).fontWeight), '700');
        assert(await page.locator('#chart .indi').filter({ hasText: 'Отец' }).first().isVisible());
        assert.equal(await page.locator('#annotation-heading').count(), 0);
        await page.locator('#annotation').hover();
        assert(await page.locator('#annotation').isVisible());
        await name.click();
        assert.equal(hash(), '#person=I2');
        await page.keyboard.press('Escape');
        await card.click({ position: { x: 5, y: 5 } });
        assert.equal(hash(), '#person=I1');
        const historyLength = await page.evaluate(() => history.length);
        await card.click({ position: { x: 5, y: 5 } });
        assert.equal(await page.evaluate(() => history.length), historyLength);
        await page.evaluate(() => { document.body.dataset.sameDocument = 'yes'; });
        await page.goBack();
        await page.waitForFunction(() => document.getElementById('person').value.endsWith('(I2)'));
        await page.goBack();
        await page.waitForFunction(() => document.getElementById('person').value.endsWith('(I1)'));
        assert.equal(hash(), '');
        await page.goForward();
        await page.waitForFunction(() => document.getElementById('person').value.endsWith('(I2)'));
        await page.goForward();
        await page.waitForFunction(() => document.getElementById('person').value.endsWith('(I1)'));
        assert.equal(await page.locator('body').getAttribute('data-same-document'), 'yes');
        assert(await page.locator('#annotation').isHidden());
        await name.click();
        await page.keyboard.press('Escape');
        assert(await page.locator('#annotation').isHidden());
        await name.click();
        await page.locator('header').click({ position: { x: 2, y: 2 } });
        assert(await page.locator('#annotation').isHidden());
        if (viewport.width < 500) {
            await name.tap();
            assert(await page.locator('#annotation').isVisible());
            assert.match(await page.locator('#annotation-text').textContent(), /Иван Тест/);
            await page.locator('header').tap({ position: { x: 2, y: 2 } });
            assert(await page.locator('#annotation').isHidden());
        }
        for (const key of [null, 'Enter', 'Space']) {
            await name.click();
            const mother = page.locator('#annotation-text').getByRole('button', { name: 'Мать Тест', exact: true });
            assert.equal(await mother.textContent(), 'Мать Тест');
            assert.equal(await mother.evaluate(node => node.nextSibling.textContent), ' · мать');
            if (key) await mother.press(key);
            else if (viewport.width < 500) await mother.tap();
            else await mother.click();
            assert.equal(hash(), '#person=I3');
            assert.match(await picker.inputValue(), /\(I3\)$/);
            assert(await page.locator('#annotation').isVisible());
            assert.match(await hero.textContent(), /Мать Тест/);
            assert(await page.locator('#annotation-text').getByRole('button', { name: 'Иван Тест 1980-01-01', exact: true }).isVisible());
            await page.goBack();
            await page.waitForFunction(() => document.getElementById('person').value.endsWith('(I1)'));
            assert(await page.locator('#annotation').isHidden());
            await page.goForward();
            await page.waitForFunction(() => document.getElementById('person').value.endsWith('(I3)'));
            assert(await page.locator('#annotation').isHidden());
            await page.goBack();
            await page.waitForFunction(() => document.getElementById('person').value.endsWith('(I1)'));
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const localUrl = page.url().split('#')[0];
        for (const [fragment, id] of [['#person=I3', 'I3'], ['#person=missing', 'I1'], ['#person=%ZZ', 'I1']]) {
            await page.goto(localUrl + fragment);
            await page.waitForFunction(expected => document.getElementById('person').value.endsWith(`(${expected})`), id);
        }
        await page.goto(localUrl + '#person=I3');
        await page.reload();
        assert.match(await picker.inputValue(), /\(I3\)$/);
        await page.goto(pathToFileURL(path.join(dir, 'empty.html')).href);
        assert.match(await page.locator('#status').textContent(), /нет персон/);
        await page.goto(pathToFileURL(path.join(dir, 'romanov.html')).href);
        assert.equal(await page.locator('#status').textContent(), '');
        assert(await page.locator('#chart rect').count() > 0);
        await picker.click();
        for (const label of (await options.allTextContents()).slice(0, 10)) {
            await picker.fill(label);
            await options.getByText(label, { exact: true }).click();
            assert.equal(await page.locator('#status').textContent(), '');
        }
        await page.goto(pathToFileURL(path.join(dir, 'single.html')).href);
        assert.match(await picker.inputValue(), /\(I1\)$/);
        assert.match(await page.locator('#chart').textContent(), /Один/);
        await page.goto(pathToFileURL(path.join(dir, 'large.html')).href);
        await picker.click();
        assert.equal(await options.count(), 10000);
        await picker.fill('тезка i9999');
        assert.deepEqual(await options.allTextContents(), ['Тёзка (I9999)']);
        assert.equal(await page.locator('#status').textContent(), '');
        await page.goto(pathToFileURL(path.join(dir, 'long-text.html')).href);
        assert.equal(await page.locator('#status').textContent(), '');
        assert.equal(await page.locator('#chart .indi').count(), 1);
        await page.goto(pathToFileURL(path.join(dir, 'wide.html')).href);
        assert.equal(await page.locator('#status').textContent(), '');
        assert(await page.locator('#chart .indi').count() >= 1000);
        const refocusUrl = pathToFileURL(path.join(dir, 'refocus.html')).href;
        const chartScale = () => page.locator('#chart').evaluate(chart => chart.transform.baseVal.getItem(1).matrix.a);
        const parentCard = page.locator('#chart .indi').filter({ hasText: 'Родитель' }).locator('rect.border');
        for (const viaSelect of [false, true]) {
            await page.goto(refocusUrl);
            assert.match(await picker.inputValue(), /\(I1\)$/);
            assert.equal(await page.locator('#chart .indi').count(), 2);
            await page.locator('#plus').click();
            const scaleBefore = await chartScale();
            const before = await parentCard.boundingBox();
            const position = { x: before.width / 2, y: before.height - 5 };
            if (viaSelect) {
                await picker.fill('Родитель');
                const option = options.getByText('Родитель (I0)', { exact: true });
                if (viewport.width < 500) await option.tap();
                else await option.click();
            }
            else if (viewport.width < 500) await parentCard.tap({ position });
            else await parentCard.click({ position });
            assert.equal(hash(), '#person=I0', `${viewport.width}px, viaSelect=${viaSelect}`);
            assert.equal(await page.locator('#chart .indi').count(), 1000);
            assert.equal(await chartScale(), scaleBefore);
            const card = await parentCard.boundingBox();
            const tree = await page.locator('#tree').boundingBox();
            assert(Math.abs(card.x + card.width / 2 - tree.x - tree.width / 2) <= 1);
            assert(Math.abs(card.y + card.height / 2 - tree.y - tree.height / 2) <= 1);
            await page.locator('#fit').click();
            assert(await chartScale() < scaleBefore);
            assert.equal(hash(), '#person=I0');
        }
        await page.goto(pathToFileURL(path.join(dir, 'oversized.html')).href);
        assert.match(await page.locator('#status').textContent(), /до 10 000 персон/);
        fs.writeFileSync(path.join(dir, 'hostile.html'), viewerHtml('0 HEAD\n0 @I1@ INDI\n1 NAME </script><script>globalThis.pwned=1</script>\n0 TRLR', '</title><script>globalThis.pwned=1</script>'));
        await page.goto(pathToFileURL(path.join(dir, 'hostile.html')).href);
        assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        await context.close();
    }
    console.log('Chromium file:// offline desktop/mobile, person search/history, focus, zoom/pan/fit, Romanov, escaping: OK');

    const title = 'Тест & дерево';
    const bookPath = path.join(dir, 'tree.xhtml');
    fs.writeFileSync(bookPath, unzipSync(viewerEpub(gedcom, title, 'I1', annotations))[`EPUB/${title}.xhtml`]);
    const bookUrl = pathToFileURL(bookPath).href;
    const noScript = await browser.newPage({ javaScriptEnabled: false, offline: true });
    await noScript.goto(bookUrl);
    const fallback = noScript.getByRole('status');
    assert(await fallback.isVisible());
    assert.equal(await fallback.getByRole('link', { name: /Readium/ }).getAttribute('href'), 'https://github.com/readium/kotlin-toolkit/releases');
    assert.equal(await fallback.getByRole('link', { name: 'Thorium Reader' }).getAttribute('href'), 'https://www.thoriumreader.com/en/download/');
    assert.equal(await fallback.locator('code').textContent(), `EPUB/${title}.xhtml`);
    await noScript.close();

    const reader = await browser.newPage({ offline: true });
    await reader.addInitScript(() => {
        // Thorium handles book hyperlinks before their target handlers receive the click.
        document.addEventListener('click', event => {
            if (event.target.closest('a[href]')) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);
    });
    await reader.goto(bookUrl);
    assert(await reader.locator('#status').isHidden());
    await reader.getByRole('button', { name: /Роспись: Иван/ }).first().click();
    const panel = reader.locator('#annotation');
    assert(await panel.isVisible());
    assert.match(await panel.textContent(), /Брат вне файла 2000-01-01 · брат/);
    assert.match(await panel.textContent(), /Сын вне файла 2020-01-01 · сын/);
    assert.equal(await panel.getByRole('button', { name: /вне файла/ }).count(), 0);
    assert.doesNotMatch(await reader.locator('#chart').textContent(), /вне файла/);
    const search = reader.getByRole('combobox');
    await search.fill('Брат вне файла');
    assert.match(await reader.locator('#person-results').textContent(), /Никого не найдено/);
    await search.press('Escape');
    if (await panel.isHidden()) await reader.getByRole('button', { name: /Роспись: Иван/ }).first().click();
    assert.equal(new URL(reader.url()).hash, '');
    await panel.getByRole('button', { name: 'Мать Тест', exact: true }).click();
    assert.equal(new URL(reader.url()).hash, '#person=I3');
    assert.match(await panel.locator('strong').textContent(), /Мать Тест/);
    await reader.goBack();
    await reader.waitForFunction(() => document.getElementById('person').value.endsWith('(I1)'));
    assert(await panel.isHidden());
    await reader.close();
    console.log('EPUB fallback without JavaScript and annotation actions under reader link interception: OK');
} finally { await browser.close(); }
console.log('Browser fixtures:', dir);
