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
const { viewerWithChart, viewerEpub, zipFiles, checkEpubLimit, epubChart } = require('../tgcloud/lib/epub.cjs');
const { chartModel, chartSvg } = require('../tgcloud/lib/chart.cjs');
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
{
    const family = gedcom.replace('1 NAME Отец /Тест/', '1 NAME Отец & /Тест/').replace('1 WIFE @I3@\n', '');
    const opf = new TextDecoder().decode(unzipSync(viewerEpub(family, 'Тест', 'I1', {}, {
        heroKey: 'Иван & Тест 1980-01-01',
    }))['EPUB/package.opf']);
    assert.match(opf, /<dc:title>Иван &amp; Тест<\/dc:title>/);
    assert.match(opf, /<dc:date>1980-01-01<\/dc:date>/);
    assert.doesNotMatch(opf, /subtitle|title-type/);
    assert.deepEqual([...opf.matchAll(/<dc:creator>(.*?)<\/dc:creator>/g)].map(m => m[1]), ['Отец &amp; Тест']);
}
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
const html = viewerHtml(gedcom, 'Тест <дерева>', 'I1', annotations, { snapshot });
const data = JSON.parse(html.match(/<script id="tree-data" type="application\/json">(.*?)<\/script>/s)[1]);
assert.equal(data.gedcom, gedcom);
assert.equal(data.heroXref, 'I1');
assert.deepEqual(data.keys, { I1: '/Иван Тест 1980-01-01', I2: '/Отец Тест', I3: '/Мать Тест' });
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
const oversized = large.replace('0 TRLR', '0 @I10000@ INDI\n1 NAME Лишний\n0 TRLR');
assert.doesNotThrow(() => checkEpubLimit(large, 'HTML'));
assert.throws(() => checkEpubLimit(oversized, 'HTML'), { name: 'RangeError', message: /^HTML: лимит 10000 персон.*10001/ });
assert.throws(() => checkEpubLimit(oversized), { name: 'RangeError', message: /^EPUB: лимит 10000 персон.*10001/ });
fs.writeFileSync(path.join(dir, 'oversized.html'), viewerHtml(oversized, '10 001 персона'));
console.log('viewer generation and escaping: OK');
const browser = await chromium.launch();
async function checkScrollbar(page, track, matrix, horizontal, touch = false) {
    const axis = horizontal ? 'e' : 'f';
    const other = horizontal ? 'f' : 'e';
    const thumb = track.locator('.scroll-thumb');
    assert(await track.isVisible());
    await track.press('Home');
    const start = await matrix();
    assert.equal(await track.getAttribute('aria-valuenow'), '0');
    await track.press('End');
    const end = await matrix();
    assert(end[axis] < start[axis]);
    const range = Number(await track.getAttribute('aria-valuemax'));
    assert(Math.abs(start[axis] - end[axis] - range) < 1);
    assert.equal(await track.getAttribute('aria-valuenow'), String(range));
    await track.press('Home');
    await track.press('PageDown');
    assert((await matrix())[axis] < start[axis]);
    await track.press('PageUp');
    assert.deepEqual(await matrix(), start);
    const bounds = await track.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 100);
    await page.waitForFunction(id => Number(document.getElementById(id).getAttribute('aria-valuenow')) > 0, await track.getAttribute('id'));
    if (horizontal) {
        await page.mouse.wheel(-100, 0);
        await page.waitForFunction(() => document.getElementById('tree-scroll').getAttribute('aria-valuenow') === '0');
    }
    await track.press('Home');
    const box = await thumb.boundingBox();
    const a = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    const b = { x: a.x + (horizontal ? 40 : 0), y: a.y + (horizontal ? 0 : 40) };
    if (touch) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [a] });
        assert.deepEqual(await matrix(), start);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [b] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await cdp.detach();
    } else {
        await page.mouse.move(a.x, a.y);
        await page.mouse.down();
        assert.deepEqual(await matrix(), start);
        await page.mouse.move(b.x, b.y);
        await page.mouse.up();
    }
    const dragged = await matrix();
    assert(dragged[axis] < start[axis]);
    assert.equal(dragged[other], start[other]);
    assert.equal(dragged.a, start.a);
    await track.press('Home');
    if (horizontal) await page.mouse.click(bounds.x + bounds.width - 3, a.y);
    else await page.mouse.click(a.x, bounds.y + bounds.height - 3);
    assert((await matrix())[axis] < start[axis]);
    await track.press('Home');
}
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
        assert.equal(await picker.inputValue(), '/Иван Тест 1980-01-01');
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
        assert.deepEqual(await options.allTextContents(), ['/Иван Тест 1980-01-01', '/Мать Тест', '/Отец Тест']);
        for (const query of ['1980 ИВ', '1980-01-01', '~I1', '/1980', 'Иван Тест', '/Иван Тест',
            'Иван Тест 1980-01-01', '  /Иван Тест 1980-01-01  ']) {
            await picker.fill(query);
            assert.deepEqual(await options.allTextContents(), ['/Иван Тест 1980-01-01']);
        }
        await picker.fill('нет такой персоны');
        assert.match(await page.locator('#person-results').textContent(), /Никого не найдено/);
        await picker.press('Escape');
        assert.equal(await picker.inputValue(), '/Иван Тест 1980-01-01');
        await picker.fill('ОТ');
        await picker.press('ArrowDown');
        assert.equal(await options.first().getAttribute('aria-selected'), 'true');
        await picker.press('Enter');
        assert.equal(await picker.inputValue(), '/Отец Тест');
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
        await page.waitForFunction(() => document.getElementById('person').value === '/Отец Тест');
        await page.goBack();
        await page.waitForFunction(() => document.getElementById('person').value === '/Иван Тест 1980-01-01');
        assert.equal(hash(), '');
        await page.goForward();
        await page.waitForFunction(() => document.getElementById('person').value === '/Отец Тест');
        await page.goForward();
        await page.waitForFunction(() => document.getElementById('person').value === '/Иван Тест 1980-01-01');
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
            assert.equal(await picker.inputValue(), '/Мать Тест');
            assert(await page.locator('#annotation').isVisible());
            assert.match(await hero.textContent(), /Мать Тест/);
            assert(await page.locator('#annotation-text').getByRole('button', { name: 'Иван Тест 1980-01-01', exact: true }).isVisible());
            await page.goBack();
            await page.waitForFunction(() => document.getElementById('person').value === '/Иван Тест 1980-01-01');
            assert(await page.locator('#annotation').isHidden());
            await page.goForward();
            await page.waitForFunction(() => document.getElementById('person').value === '/Мать Тест');
            assert(await page.locator('#annotation').isHidden());
            await page.goBack();
            await page.waitForFunction(() => document.getElementById('person').value === '/Иван Тест 1980-01-01');
        }
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const localUrl = page.url().split('#')[0];
        for (const [fragment, id] of [['#person=I3', 'I3'], ['#person=missing', 'I1'], ['#person=%ZZ', 'I1']]) {
            await page.goto(localUrl + fragment);
            await page.waitForFunction(expected => document.getElementById('person').value === expected, data.keys[id]);
        }
        await page.goto(localUrl + '#person=I3');
        await page.reload();
        assert.equal(await picker.inputValue(), '/Мать Тест');
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
        assert.equal(await picker.inputValue(), 'Один ~I1');
        assert.match(await page.locator('#chart').textContent(), /Один/);
        await page.goto(pathToFileURL(path.join(dir, 'large.html')).href);
        await picker.click();
        assert.equal(await options.count(), 10000);
        await picker.fill('тезка i9999');
        assert.deepEqual(await options.allTextContents(), ['Тёзка ~I9999']);
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
            assert.match(await picker.inputValue(), / ~I1$/);
            assert.equal(await page.locator('#chart .indi').count(), 2);
            await page.locator('#plus').click();
            const scaleBefore = await chartScale();
            const before = await parentCard.boundingBox();
            const position = { x: before.width / 2, y: before.height - 5 };
            if (viaSelect) {
                await picker.fill('Родитель');
                const option = options.getByText('Родитель ~I0', { exact: true });
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
            const track = page.getByRole('scrollbar', { name: 'Прокрутка дерева' });
            if (viaSelect) {
                const camera = () => page.locator('#chart').evaluate(node => {
                    const { e, f } = node.transform.baseVal.getItem(0).matrix;
                    return { a: node.transform.baseVal.getItem(1).matrix.a, e, f };
                });
                const historyLength = await page.evaluate(() => history.length);
                await checkScrollbar(page, track, camera, true, viewport.width < 500);
                assert.equal(await page.evaluate(() => history.length), historyLength);
            }
            await page.locator('#fit').click();
            assert(await chartScale() < scaleBefore);
            assert(await track.isHidden());
            assert.equal((await page.locator('#tree').boundingBox()).height, tree.height);
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
    const rows = [snapshot[0][0], snapshot[0][3], ...Array.from({ length: 72 }, (_, i) => ({
        key: i === 0 ? 'I30' : 'BAR' + i, name: i === 0 ? 'Мать Тест' : 'Дополнительная персона ' + i,
        d: i < 45 ? '1990-01-01' : '2010-01-01', sex: 'M',
    }))].map(({ key, name, d, sex }) => ({ xref: key, name, birth: d, sex }));
    const model = chartModel(title, rows, [{ child: 'Брат вне файла 2000-01-01', parents: ['Иван Тест 1980-01-01'] },
        { child: 'Дополнительная персона 45 2010-01-01', parents: ['Иван Тест 1980-01-01'] }],
        { phantoms: [{ fam: ['Иван Тест 1980-01-01'], years: [2020],
        children: [{ year: 2020, r: { xref: 'OUTCHILD', name: 'Сын вне файла', birth: '2020-01-01' } }] }] });
    const chartSnapshot = structuredClone(snapshot);
    chartSnapshot[0][3].note += 'Длинная роспись^'.repeat(50);
    const chartAnnotations = viewerAnnotations(gedcom, chartSnapshot, [], [], false, model);
    assert.ok(chartAnnotations.OUTCHILD.some(row => row.hero));
    assert.ok(chartAnnotations.I1.some(row => row.xref === 'OUT'));
    const chartHtml = viewerWithChart(gedcom, title, 'I1', chartAnnotations, { chart: { model }, snapshot: chartSnapshot });
    const htmlName = `${title}.html`;
    const htmlBytes = new TextEncoder().encode(chartHtml);
    const zip = zipFiles([[htmlName, chartHtml]]);
    const zipHeader = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const entries = unzipSync(zip);
    assert.deepEqual(Object.keys(entries), [htmlName]);
    assert.deepEqual(entries[htmlName], htmlBytes);
    assert.equal(zipHeader.getUint16(6, true), 0x0800); // UTF-8 filename
    assert.equal(zipHeader.getUint16(8, true), 8); // DEFLATE
    fs.writeFileSync(path.join(dir, htmlName), htmlBytes);
    const htmlUrl = pathToFileURL(path.join(dir, htmlName)).href;
    const book = unzipSync(viewerEpub(gedcom, title, 'I1', chartAnnotations, { html: chartHtml }));
    const xhtml = new TextDecoder().decode(book[`EPUB/${title}.xhtml`]);
    assert.match(xhtml, /<!DOCTYPE html><html xmlns="http:\/\/www.w3.org\/1999\/xhtml"/);
    const payload = /<script id="tree-data" type="application\/json">(.*?)<\/script>/s;
    assert.deepEqual(JSON.parse(chartHtml.match(payload)[1]).keys, { ...data.keys, OUT: '/Брат вне файла 2000-01-01' });
    assert.deepEqual(JSON.parse(xhtml.match(payload)[1].slice(9, -3).replaceAll(']]]]><![CDATA[>', ']]>')),
        JSON.parse(chartHtml.match(payload)[1]));
    const lifeView = /<div id="life-view">(.*?)<\/div>/s;
    assert.equal(xhtml.match(lifeView)[1], chartHtml.match(lifeView)[1]);
    fs.writeFileSync(bookPath, xhtml);
    for (const count of [0, 1000, 1001]) {
        const chart = await epubChart(() => ({ model: chartModel('Лимит', Array.from({ length: count }, (_, i) => ({
            xref: 'I' + i, name: 'Персона ' + i, birth: '1980-01-01',
        })), []) }));
        const html = viewerWithChart(gedcom, title, 'I1', annotations, { chart });
        const xhtml = new TextDecoder().decode(unzipSync(viewerEpub(gedcom, title, 'I1', annotations, { chart }))[`EPUB/${title}.xhtml`]);
        for (const markup of [html, xhtml]) {
            assert.equal(markup.includes('id="life-chart"'), count === 1000);
            assert.equal(markup.includes('id="switch-view"'), count === 1000);
            if (count === 0) assert.match(markup, /Нет персон с датами для графика/);
            if (count === 1001) assert.doesNotMatch(markup, /id="chart-notice"|График: лимит 1000/);
        }
    }
    const bookUrl = pathToFileURL(bookPath).href;
    const noScript = await browser.newPage({ javaScriptEnabled: false, offline: true, viewport: { width: 390, height: 700 } });
    await noScript.goto(htmlUrl);
    assert(await noScript.locator('noscript').isVisible());
    assert.match(await noScript.locator('noscript').textContent(), /JavaScript.*браузере/);
    assert.doesNotMatch(await noScript.locator('body').textContent(), /Readium|Thorium Reader|распакуйте EPUB/);
    assert(await noScript.locator('#life-chart').isVisible());
    assert(await noScript.locator('#tree').isHidden());
    await noScript.goto(bookUrl);
    const fallback = noScript.getByRole('status');
    assert(await fallback.isVisible());
    assert.equal(await fallback.getByRole('link', { name: /Readium/ }).getAttribute('href'), 'https://github.com/readium/kotlin-toolkit/releases');
    assert.equal(await fallback.getByRole('link', { name: 'Thorium Reader' }).getAttribute('href'), 'https://www.thoriumreader.com/en/download/');
    assert.equal(await fallback.locator('code').textContent(), `EPUB/${title}.xhtml`);
    assert(await noScript.locator('#life-chart').isVisible());
    const layout = await noScript.locator('#life-chart').evaluate(node => ({
        left: node.viewBox.baseVal.x,
        width: node.viewBox.baseVal.width,
        titleX: Number(node.querySelector('text').getAttribute('x')),
        anchor: node.querySelector('text').getAttribute('text-anchor'),
        labelX: Math.min(...Array.from(node.querySelectorAll('text'), text => text.getBBox().x)),
    }));
    assert.equal(layout.titleX, (model.KW + model.W - 16) / 2);
    assert.equal(layout.anchor, 'middle');
    assert(layout.left > 0 && layout.width < model.W);
    assert(layout.labelX >= layout.left);
    const focused = chartModel('Фокус', rows.slice(0, 1), [], { hero: 'Иван Тест 1980-01-01', range: 1 });
    const focusedSvg = chartSvg(focused);
    assert.ok(focusedSvg.includes(`viewBox="0 0 ${focused.W} ${focused.H}"`));
    assert.match(focusedSvg, />родители-дети 1980<\/text>/);
    assert(await noScript.locator('#switch-view').isHidden());
    assert(await noScript.locator('#annotation').isHidden());
    assert(await noScript.locator('#tree').isHidden());
    await noScript.close();

    const standalone = await browser.newPage({ offline: true });
    const external = [], errors = [];
    standalone.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    standalone.on('pageerror', error => errors.push(error.message));
    await standalone.goto(htmlUrl);
    const standaloneSearch = standalone.getByRole('combobox');
    await standaloneSearch.fill('Мать');
    await standalone.getByRole('option', { name: '/Мать Тест' }).click();
    assert.match(standalone.url(), /#person=I3$/);
    await standalone.getByRole('button', { name: /Роспись: Мать/ }).first().click();
    assert.match(await standalone.locator('#annotation strong').textContent(), /Мать Тест/);
    await standalone.getByRole('button', { name: 'График' }).click();
    assert(await standalone.locator('#tree').isHidden());
    assert(await standalone.locator('#life-chart').isVisible());
    assert.equal(await standaloneSearch.inputValue(), '/Мать Тест');
    assert(await standalone.getByRole('status').getByText('Никого не найдено').isVisible());
    await standaloneSearch.fill('Мать Тест ~I3');
    assert.deepEqual(await standalone.getByRole('option').allTextContents(), ['Мать Тест 1990-01-01']);
    await standaloneSearch.press('Escape');
    await standalone.locator('[data-bar][data-xref="I1"]').press('Enter');
    assert.match(await standalone.locator('#annotation strong').textContent(), /Иван Тест/);
    await standalone.getByRole('button', { name: 'Древо' }).click();
    assert(await standalone.locator('#life-chart').isHidden());
    assert(await standalone.locator('#tree').isVisible());
    assert.equal(await standaloneSearch.inputValue(), '/Иван Тест 1980-01-01');
    const standaloneHistory = await standalone.evaluate(() => history.length);
    await standalone.goBack();
    assert.equal(await standaloneSearch.inputValue(), '/Мать Тест');
    await standalone.goForward();
    assert.equal(await standaloneSearch.inputValue(), '/Иван Тест 1980-01-01');
    assert.equal(await standalone.evaluate(() => history.length), standaloneHistory);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    await standalone.close();
    console.log('Standalone HTML file:// offline, ZIP payload, tree search and chart annotations: OK');

    const qualifiers = [['', ''], ['ABT ', '?'], ['CAL ', '='], ['BEF ', '<'], ['AFT ', '>'], ['EST ', '~']];
    const granularities = [['6 MAY 1234', '1234-05-06'], ['MAY 1234', '1234-05'], ['1234', '1234']];
    const dates = qualifiers.flatMap(([prefix, suffix]) => granularities.map(([date, label]) => [prefix + date, label + suffix]));
    const dateGed = '0 HEAD\n1 CHAR UTF-8\n' + dates.map(([date], i) =>
        `0 @D${i + 10}@ INDI\n1 NAME Тёзка\n1 BIRT\n2 DATE ${date.replace('1234', '1235')}\n`).join('')
        + '0 @I42@ INDI\n1 NAME Бездатный\n0 @CMD@ INDI\n1 NAME today\n0 @MULTI@ INDI\n1 NAME Сырой\n'
        + '0 @I#4@ INDI\n1 NAME Слеш\n0 TRLR';
    const dateModel = chartModel('Точность', dates.map(([, label], i) => ({
        xref: 'D' + (i + 10), name: 'Тёзка', k: String(i), birth: ['1234-05-06', '1234-05-01', '1234-01-01'][i % 3],
        abt: i,
    })), []);
    const dateSnapshot = [dates.map((_, i) => ({ key: 'D' + (i + 10), name: 'Тёзка ~D' + (i + 10),
        d: ['1234-05-06', '1234-05-01', '1234-01-01'][i % 3], abt: i })).concat([
        { key: 'I42', name: 'Бездатный ~I42' }, { key: 'CMD', name: 'today' }, { key: 'MULTI', name: 'Первая\n/bell' },
        { key: 'I#4', name: 'Слеш А/Б ~I№4', d: '1999-05-04', abt: 9 },
    ]), []];
    const dateOptions = { chart: { model: dateModel }, snapshot: dateSnapshot };
    const dateHtml = viewerWithChart(dateGed, 'Точность', 'D10', {}, dateOptions);
    const dateBook = unzipSync(viewerEpub(dateGed, 'Точность', 'D10', {}, dateOptions));
    fs.writeFileSync(path.join(dir, 'dates.html'), dateHtml);
    fs.writeFileSync(path.join(dir, 'dates.xhtml'), dateBook['EPUB/Точность.xhtml']);
    const datePage = await browser.newPage({ offline: true });
    for (const file of ['dates.html', 'dates.xhtml']) {
        await datePage.goto(pathToFileURL(path.join(dir, file)).href);
        const search = datePage.getByRole('combobox');
        const options = datePage.getByRole('option');
        for (const [query, expected] of [['~I4', '/Бездатный ~I42'], ['/А/Б', '/Слеш А/Б ~I№4 1999-05-04<'],
            ['~I#4', '/Слеш А/Б ~I№4 1999-05-04<'], ['~CMD', 'today'], ['~MULTI', 'Сырой']]) {
            await search.fill(query);
            assert.deepEqual(await options.allTextContents(), [expected]);
            await search.press('Enter');
            assert.equal(await search.evaluate(node => node.value), expected);
        }
        await search.fill('АБ');
        assert.deepEqual(await options.allTextContents(), []);
        await search.press('Escape');
        for (const switchMode of [false, true]) {
            if (switchMode) await datePage.getByRole('button', { name: 'График' }).click();
            await search.fill('тезка 1234');
            assert.deepEqual(await options.allTextContents(), dates.map(([, label], i) => `/Тёзка ~D${i + 10} ${label}`));
            for (const prefix of ['', '/']) {
                await search.fill(prefix + 'Тёзка ~D27 1234~');
                assert.deepEqual(await options.allTextContents(), ['/Тёзка ~D27 1234~']);
            }
            await search.press('Enter');
            assert.equal(await search.evaluate(node => node.value), '/Тёзка ~D27 1234~');
            await search.press('Escape');
        }
    }
    await datePage.close();

    const reader = await browser.newPage({ offline: true, hasTouch: true, viewport: { width: 390, height: 600 } });
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
    await reader.waitForFunction(() => document.getElementById('person').value === '/Иван Тест 1980-01-01');
    assert(await panel.isHidden());
    const toggle = reader.locator('#switch-view');
    assert.equal(await toggle.evaluate(node => node.previousElementSibling.id), 'fit');
    assert.deepEqual(await reader.locator('header > button').allTextContents(), ['➖', '➕', '⤢', '📊']);
    assert.equal(await reader.locator('#fit').evaluate(node => getComputedStyle(node).fontSize), '20px');
    assert(await reader.locator('#life-chart').isHidden());
    const transformBefore = await reader.locator('#chart').getAttribute('transform');
    await toggle.click();
    assert.equal(await toggle.textContent(), '🌳');
    assert.equal(await toggle.getAttribute('aria-label'), 'Древо');
    assert(await reader.locator('#tree').isHidden());
    assert.equal(await reader.locator('#fit').textContent(), '↔');
    assert.equal(await reader.locator('#fit').getAttribute('aria-label'), 'Вместить по ширине');
    const matrix = () => reader.locator('#life-chart').evaluate(node => new DOMMatrix(getComputedStyle(node).transform).toJSON());
    const initialFit = await matrix();
    const expectedFit = await reader.locator('#life-chart').evaluate(node => {
        return node.parentElement.clientWidth / node.viewBox.baseVal.width;
    });
    assert(Math.abs(initialFit.a - expectedFit) < 0.00001);
    assert.equal(initialFit.e, 0);
    assert.equal(initialFit.f, 0);
    const bar = id => reader.locator(`[data-bar][data-xref="${id}"]`);
    const phantom = reader.locator('[data-xref="OUTCHILD"]');
    assert.ok(await phantom.count());
    for (const target of await phantom.all()) {
        assert.equal(await target.evaluate(node => getComputedStyle(node).cursor), 'help');
        await target.press('Enter');
        assert.match(await panel.locator('strong').textContent(), /Сын вне файла/);
        assert.equal(new URL(reader.url()).hash, '');
    }
    const connection = reader.locator('[data-xref="OUT"][width="1.5"]');
    assert.equal(await connection.count(), 1);
    assert.equal(await connection.evaluate(node => getComputedStyle(node).cursor), 'help');
    await connection.press('Enter');
    assert.match(await panel.locator('strong').textContent(), /Брат вне файла/);
    await reader.keyboard.press('Escape');
    const first = await bar('I1').boundingBox();
    await reader.mouse.move(first.x + first.width / 2, first.y + first.height / 2);
    await reader.mouse.wheel(0, -1600);
    await reader.waitForFunction(scale => new DOMMatrix(getComputedStyle(document.getElementById('life-chart')).transform).a > scale, initialFit.a);
    await bar('I1').press('Space');
    assert.equal(await panel.getByRole('link', { name: '(SECRET_PLACE)', exact: true }).getAttribute('href'), 'https://ya.ru/maps/?text=SECRET_PLACE');
    assert.equal(await panel.getByRole('button', { name: /Мать Тест|Сын вне файла/ }).count(), 0);
    const view = await reader.locator('#life-view').boundingBox();
    assert((await bar('OUT').boundingBox()).y > view.y + view.height);
    const beforeJump = await matrix();
    await panel.getByRole('button', { name: /Брат вне файла/ }).click();
    assert.equal(await toggle.textContent(), '🌳');
    assert.equal(new URL(reader.url()).hash, '#person=OUT');
    assert.equal(await search.evaluate(node => node.value), '/Брат вне файла 2000-01-01');
    assert.match(await panel.locator('strong').textContent(), /Брат вне файла/);
    const centered = await bar('OUT').boundingBox();
    assert(Math.abs(centered.y - view.y - 12) <= 1);
    assert.equal((await matrix()).e, beforeJump.e);
    const longPanel = await panel.boundingBox();
    assert(longPanel.y >= centered.y + centered.height + 11);
    assert(longPanel.y + longPanel.height <= 589);
    assert(await panel.evaluate(node => node.scrollHeight > node.clientHeight));
    await search.fill('нет такой персоны');
    assert.match(await reader.locator('#person-results').textContent(), /Никого не найдено/);
    await search.fill('1980 ИВАН');
    assert.deepEqual(await reader.getByRole('option').allTextContents(), ['/Иван Тест 1980-01-01']);
    await search.press('ArrowDown');
    await search.press('Enter');
    assert.match(await panel.locator('strong').textContent(), /Иван Тест/);
    assert.equal(new URL(reader.url()).hash, '#person=I1');
    await reader.goBack();
    await reader.waitForFunction(() => document.getElementById('person').value === '/Брат вне файла 2000-01-01');
    assert(await panel.isHidden());
    await toggle.click();
    assert.equal(await search.evaluate(node => node.value), '/Брат вне файла 2000-01-01');
    assert(await reader.getByText('Никого не найдено', { exact: true }).isVisible());
    await toggle.click();
    assert(await reader.locator('#person-results').isHidden());
    await reader.goForward();
    await reader.waitForFunction(() => document.getElementById('person').value === '/Иван Тест 1980-01-01');
    assert(await reader.locator('#tree').isHidden());
    await bar('I1').press('Enter');
    const topOffset = async () => (await bar('I1').boundingBox()).y - (await reader.locator('#life-view').boundingBox()).y;
    assert(Math.abs(await topOffset() - 12) <= 2, `Search offset: ${await topOffset()}`);
    const fitFrom = await matrix();
    await reader.locator('#fit').click();
    const fitTo = await matrix();
    assert.equal(fitTo.a, initialFit.a);
    assert.equal(fitTo.e, 0);
    const mid = view.height / 2;
    assert(Math.abs((mid - fitFrom.f) / fitFrom.a - (mid - fitTo.f) / fitTo.a) < 0.01);
    await reader.locator('#fit').click();
    assert.deepEqual(await matrix(), fitTo);
    const lifeScroll = reader.getByRole('scrollbar', { name: 'Прокрутка графика' });
    assert(await lifeScroll.isHidden());
    async function panToTop() {
        const { f } = await matrix();
        if (!f) return;
        await reader.mouse.move(180, view.y + mid);
        await reader.mouse.down();
        // Keep even a tiny correction a drag, not a click on a person row.
        await reader.mouse.move(180, view.y + mid + 16);
        await reader.mouse.move(180, view.y + mid - f);
        await reader.mouse.up();
    }
    await panToTop();
    await bar('I1').click();
    assert(Math.abs(await topOffset() - 12) <= 2, `Click offset: ${await topOffset()}`);
    await panToTop();
    const fitted = await matrix();
    await connection.press('Enter');
    assert.deepEqual(await matrix(), fitted);
    const lineBounds = await connection.boundingBox();
    const sidePanel = await panel.boundingBox();
    assert(sidePanel.x >= lineBounds.x + lineBounds.width + 11 || sidePanel.x + sidePanel.width <= lineBounds.x - 11);
    const childPoint = reader.locator('[data-child-point][data-xref="OUT"]');
    await reader.keyboard.press('Escape');
    const pointBounds = await childPoint.boundingBox();
    await reader.mouse.click(pointBounds.x + pointBounds.width / 2, pointBounds.y + pointBounds.height / 2);
    assert(await panel.isVisible());
    assert.match(await panel.locator('strong').textContent(), /Брат вне файла/);
    const childPanel = await panel.boundingBox();
    assert(Math.abs(childPanel.y - (pointBounds.y + pointBounds.height)) < 1);
    assert(Math.min(Math.abs(childPanel.x - pointBounds.x - pointBounds.width),
        Math.abs(childPanel.x + childPanel.width - pointBounds.x)) < 1);
    assert.deepEqual(await matrix(), fitted);
    const parentPoint = reader.locator('[data-parent-point][data-xref="OUT"]');
    await reader.keyboard.press('Escape');
    const parentBounds = await parentPoint.boundingBox();
    await parentPoint.press('Enter');
    assert(await panel.isVisible());
    assert.match(await panel.locator('strong').textContent(), /Брат вне файла/);
    const hintBounds = await panel.boundingBox();
    assert(Math.abs(hintBounds.y - parentBounds.y - parentBounds.height) < 1);
    assert(Math.min(Math.abs(hintBounds.x - parentBounds.x - parentBounds.width),
        Math.abs(hintBounds.x + hintBounds.width - parentBounds.x)) < 1);
    await reader.keyboard.press('Escape');
    await reader.locator('#plus').click();
    assert((await matrix()).a > fitted.a);
    await reader.locator('#minus').click();
    assert(Math.abs((await matrix()).a - fitted.a) < 0.00001);
    const cy = Math.round(view.y + view.height / 2);
    await reader.mouse.move(180, cy);
    await reader.mouse.wheel(0, -200);
    await reader.waitForFunction(scale => new DOMMatrix(getComputedStyle(document.getElementById('life-chart')).transform).a > scale, fitted.a);
    const zoomed = await matrix();
    const selectedHash = new URL(reader.url()).hash;
    await reader.mouse.down();
    await reader.mouse.move(220, cy + 30);
    await reader.mouse.up();
    assert(Math.abs((await matrix()).e - zoomed.e - 40) < 0.001);
    assert(Math.abs((await matrix()).f - zoomed.f - 30) < 0.001);
    assert(await panel.isHidden());
    assert.equal(new URL(reader.url()).hash, selectedHash, 'mouse pan preserves selection');
    const cdp = await reader.context().newCDPSession(reader);
    const touch = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    await touch('touchStart', [{ x: 110, y: cy, id: 1 }, { x: 210, y: cy, id: 2 }]);
    await touch('touchMove', [{ x: 70, y: cy, id: 1 }, { x: 250, y: cy, id: 2 }]);
    await touch('touchEnd', []);
    const panned = await matrix();
    assert(panned.a > zoomed.a);
    assert.equal(new URL(reader.url()).hash, selectedHash, 'pinch preserves selection');
    const historyLength = await reader.evaluate(() => history.length);
    await checkScrollbar(reader, lifeScroll, matrix, false, true);
    assert.equal(new URL(reader.url()).hash, selectedHash, 'scrollbar preserves selection');
    assert.equal(await reader.evaluate(() => history.length), historyLength);
    await toggle.click();
    assert(await panel.isHidden());
    assert.equal(await toggle.textContent(), '📊');
    assert.equal(await toggle.getAttribute('aria-label'), 'График');
    assert.equal(await reader.locator('#fit').textContent(), '⤢');
    assert.equal(await reader.locator('#chart').getAttribute('transform'), transformBefore);
    assert.equal(await search.evaluate(node => node.value), '/Иван Тест 1980-01-01');
    await toggle.click();
    assert.equal((await matrix()).a, panned.a);
    assert(Math.abs((await matrix()).e - panned.e) < 0.001);
    await reader.goto(bookUrl + '#person=OUT');
    await reader.reload();
    assert.equal(await search.evaluate(node => node.value), '/Брат вне файла 2000-01-01');
    assert(await reader.getByText('Никого не найдено', { exact: true }).isVisible());
    await toggle.click();
    assert(await reader.locator('#person-results').isHidden());
    await reader.close();
    console.log('EPUB static SVG and interactive tree/chart annotations under reader link interception: OK');
} finally { await browser.close(); }
console.log('Browser fixtures:', dir);
