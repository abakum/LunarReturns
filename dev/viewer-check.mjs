import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { viewerHtml, viewerFileBase, viewerAnnotations } = require('../tgcloud/lib/viewer.cjs');
assert.equal(viewerFileBase('1 КА 1963-09-27'), '1_KA_1963-09-27');
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
    { key: 'OUT', name: 'НЕ_ЭКСПОРТИРОВАН', d: '2000-01-01' }],
    [{ xref: 'F1', hKey: 'I2', wKey: 'I3', children: ['I1', 'OUT'] }]];
const annotations = viewerAnnotations(gedcom, snapshot);
assert(!JSON.stringify(annotations).includes('НЕ_ЭКСПОРТИРОВАН'));
assert.deepEqual(annotations.I1, [
    { prefix: '=', text: 'Мать Тест', xref: 'I3', kinship: 'мать' }, { text: '+' },
    { prefix: '', text: 'Отец Тест', xref: 'I2', kinship: 'отец' },
    { hero: true, text: '--Иван Тест 1980-01-01 (SECRET_PLACE)\nПервая\nВторая' },
]);
assert.equal(annotations.I2[0].text, '-Отец Тест');
assert.equal(annotations.I2.find(row => row.xref === 'I1').kinship, 'сын');
{
    const [persons, fams] = structuredClone(snapshot);
    persons[0].note += 'Жил: 2000 (Первый район Город) <личная заметка>^Титул: Герой 2001[^Титул: Герой 2002]^';
    persons[1].note = 'чужая заметка';
    persons.push({ key: 'I4', name: 'Тёзка', nameOnly: true },
        { key: 'I5', name: 'Ребёнок', d: '2000-01-01', abt: 1, plac: 'чужое место' },
        { key: 'I6', name: 'Тёзка', nameOnly: true });
    fams[0].marr = { d: '1979-01-01', plac: 'чужая свадьба' };
    fams.push({ xref: 'F2', hKey: 'I1', wKey: 'I4', children: ['I5'],
        marr: { d: '2001-01-01', plac: 'Город, Область' }, div: { d: '2002-01-01' }, note: 'семейная заметка' },
    { xref: 'F3', hKey: 'I1', wKey: 'I6', children: [] });
    const extended = gedcom.replace('0 TRLR', '0 @I4@ INDI\n0 @I5@ INDI\n0 @I6@ INDI\n0 @F2@ FAM\n0 @F3@ FAM\n0 TRLR');
    const before = structuredClone([persons, fams]);
    const byId = viewerAnnotations(extended, [persons, fams]);
    assert.match(byId.I1.find(row => row.hero).text,
        /Жил: 2000 \(Первый район Город\) <личная заметка>\nТитул: Герой 2001\[\nТитул: Герой 2002\]/);
    assert.doesNotMatch(byId.I1.map(row => row.text).join('\n'), /чужая|чужое|семейная заметка|НЕ_ЭКСПОРТИРОВАН/);
    assert.ok(byId.I1.some(row => row.text === '++2001-01-01 (Город, Область) 2002-01-01'));
    assert.deepEqual(byId.I1.filter(row => row.text === 'Тёзка').map(row => row.xref).sort(), ['I4', 'I6']);
    assert.deepEqual(byId.I1.find(row => row.xref === 'I5'), { prefix: '---', text: 'Ребёнок 2000-01', xref: 'I5', kinship: 'ребёнок' });
    assert.equal(byId.I1.find(row => row.xref === 'I4').kinship, 'супруг');
    assert.deepEqual([persons, fams], before);
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
const large = '0 HEAD\n' + Array.from({ length: 1000 }, (_, i) => `0 @I${i}@ INDI\n1 NAME Тёзка\n`).join('') + '0 TRLR';
fs.writeFileSync(path.join(dir, 'large.html'), viewerHtml(large, '1000 персон'));
const wide = '0 HEAD\n0 @I0@ INDI\n1 NAME Родитель\n1 FAMS @F1@\n'
    + Array.from({ length: 999 }, (_, i) => `0 @I${i + 1}@ INDI\n1 NAME Ребёнок ${i}\n1 FAMC @F1@\n`).join('')
    + '0 @F1@ FAM\n1 HUSB @I0@\n' + Array.from({ length: 999 }, (_, i) => `1 CHIL @I${i + 1}@\n`).join('') + '0 TRLR';
fs.writeFileSync(path.join(dir, 'wide.html'), viewerHtml(wide, 'Большая семья', 'I0'));
fs.writeFileSync(path.join(dir, 'refocus.html'), viewerHtml(wide, 'Большая семья', 'I1'));
fs.writeFileSync(path.join(dir, 'oversized.html'), viewerHtml(large.replace('0 TRLR', '0 @I1000@ INDI\n1 NAME Лишний\n0 TRLR'), '1001 персона'));
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
        const firstName = page.locator('#chart .indi').filter({ hasText: 'Иван' }).first().locator('a.name-link').first();
        const beforeName = await chartTransform();
        if (viewport.width < 500) await firstName.tap();
        else await firstName.click();
        assert(await tip.isHidden());
        assert(await page.locator('#annotation').isVisible());
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
        const name = page.locator('#chart .indi').filter({ hasText: 'Иван' }).first().locator('a.name-link').first();
        assert.equal(await card.evaluate(node => getComputedStyle(node).cursor), 'pointer');
        assert.equal(await name.locator('.name').evaluate(node => getComputedStyle(node).cursor), 'help');
        await name.hover();
        assert(await page.locator('#annotation').isHidden());
        await name.click();
        assert(await page.locator('#annotation').isVisible());
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
        for (const viaKeyboard of [false, true]) {
            await name.click();
            const mother = page.locator('#annotation-text a[href="#person=I3"]');
            assert.equal(await mother.textContent(), 'Мать Тест');
            assert.equal(await mother.evaluate(node => node.nextSibling.textContent), ' · мать');
            if (viaKeyboard) await mother.press('Enter');
            else if (viewport.width < 500) await mother.tap();
            else await mother.click();
            assert.equal(hash(), '#person=I3');
            assert.match(await picker.inputValue(), /\(I3\)$/);
            assert(await page.locator('#annotation').isVisible());
            assert.match(await hero.textContent(), /Мать Тест/);
            assert.equal(await page.locator('#annotation-text a[href="#person=I1"]').textContent(), 'Иван Тест 1980-01-01');
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
        assert.equal(await options.count(), 1000);
        await picker.fill('тезка i999');
        assert.deepEqual(await options.allTextContents(), ['Тёзка (I999)']);
        assert.equal(await page.locator('#status').textContent(), '');
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
        assert.match(await page.locator('#status').textContent(), /до 1000 персон/);
        fs.writeFileSync(path.join(dir, 'hostile.html'), viewerHtml('0 HEAD\n0 @I1@ INDI\n1 NAME </script><script>globalThis.pwned=1</script>\n0 TRLR', '</title><script>globalThis.pwned=1</script>'));
        await page.goto(pathToFileURL(path.join(dir, 'hostile.html')).href);
        assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        await context.close();
    }
    console.log('Chromium file:// offline desktop/mobile, person search/history, focus, zoom/pan/fit, Romanov, escaping: OK');
} finally { await browser.close(); }
console.log('Browser fixtures:', dir);
