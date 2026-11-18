import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { viewerHtml, viewerZip, viewerFileBase, viewerAnnotations } = require('../tgcloud/lib/viewer.cjs');
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
const annotations = viewerAnnotations(gedcom, snapshot, [], []);
assert(!JSON.stringify(annotations).includes('НЕ_ЭКСПОРТИРОВАН'));
assert.match(annotations.I1, /Иван Тест/);
assert.match(annotations.I1, /SECRET_PLACE/);
assert.match(annotations.I1, /Первая\nВторая/);
assert(!annotations.I1.includes('^'));
const html = viewerHtml(gedcom, 'Тест <дерева>', 'I1', annotations);
const data = JSON.parse(html.match(/<script id="tree-data" type="application\/json">(.*?)<\/script>/s)[1]);
assert.equal(data.gedcom, gedcom);
assert.equal(data.heroXref, 'I1');
const hostile = viewerHtml('</script><script>globalThis.pwned=1</script>\u2028', '<img src=x onerror=alert(1)>');
assert(!hostile.includes('<img src=x'));
assert(!hostile.includes('</script><script>globalThis.pwned'));
assert.throws(() => viewerZip(html, '../tree.html'));
fs.writeFileSync(path.join(dir, 'tree.html'), html);
fs.writeFileSync(path.join(dir, 'empty.html'), viewerHtml('0 HEAD\n0 TRLR', 'Пустое дерево'));
fs.writeFileSync(path.join(dir, 'tree.zip'), viewerZip(html, 'Дерево.html'));
execFileSync('unzip', ['-t', path.join(dir, 'tree.zip')]);
assert.equal(execFileSync('unzip', ['-p', path.join(dir, 'tree.zip')]).toString(), html);
const zip = viewerZip(html, 'Дерево.html');
assert.equal(new TextDecoder().decode(zip.slice(30, 30 + new DataView(zip.buffer).getUint16(26, true))), 'Дерево.html');
const romanov = fs.readFileSync(new URL('./fixtures/Romanov_family.ged', import.meta.url), 'utf8');
fs.writeFileSync(path.join(dir, 'romanov.html'), viewerHtml(romanov, 'Романовы'));
fs.writeFileSync(path.join(dir, 'single.html'), viewerHtml('0 HEAD\n0 @I1@ INDI\n1 NAME Один\n0 TRLR', 'Один', 'absent'));
const large = '0 HEAD\n' + Array.from({ length: 1000 }, (_, i) => `0 @I${i}@ INDI\n1 NAME Тёзка\n`).join('') + '0 TRLR';
fs.writeFileSync(path.join(dir, 'large.html'), viewerHtml(large, '1000 персон'));
const wide = '0 HEAD\n0 @I0@ INDI\n1 NAME Родитель\n1 FAMS @F1@\n'
    + Array.from({ length: 999 }, (_, i) => `0 @I${i + 1}@ INDI\n1 NAME Ребёнок ${i}\n1 FAMC @F1@\n`).join('')
    + '0 @F1@ FAM\n1 HUSB @I0@\n' + Array.from({ length: 999 }, (_, i) => `1 CHIL @I${i + 1}@\n`).join('') + '0 TRLR';
fs.writeFileSync(path.join(dir, 'wide.html'), viewerHtml(wide, 'Большая семья', 'I0'));
fs.writeFileSync(path.join(dir, 'oversized.html'), viewerHtml(large.replace('0 TRLR', '0 @I1000@ INDI\n1 NAME Лишний\n0 TRLR'), '1001 персона'));
console.log('viewer generation, escaping, UTF-8 ZIP: OK');
const browser = await chromium.launch();
try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport, offline: true, hasTouch: viewport.width < 500 });
        const page = await context.newPage();
        const errors = [], external = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('request', r => { if (/^https?:/.test(r.url())) external.push(r.url()); });
        await page.goto(pathToFileURL(path.join(dir, 'tree.html')).href);
        assert.equal(await page.locator('#status').textContent(), '');
        assert.equal(await page.locator('h1, label, details, .privacy').count(), 0);
        assert.equal(await page.locator('#person').inputValue(), 'I1');
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
        await page.locator('#person').selectOption('I2');
        assert.equal(await page.locator('#status').textContent(), '');
        await page.locator('#fit').click();
        const card = page.locator('#chart .indi').filter({ hasText: 'Иван' }).first().locator('rect.border');
        const name = page.locator('#chart .indi').filter({ hasText: 'Иван' }).first().locator('a.name-link').first();
        await name.hover();
        assert(await page.locator('#annotation').isHidden());
        await name.click();
        assert(await page.locator('#annotation').isVisible());
        assert.match(await page.locator('#annotation-text').textContent(), /SECRET_PLACE/);
        assert.equal(await page.locator('#annotation-heading').textContent(), 'Иван Тест 1980-01-01');
        await page.locator('#annotation').hover();
        assert(await page.locator('#annotation').isVisible());
        await name.click();
        assert.equal(await page.locator('#person').inputValue(), 'I2');
        await page.keyboard.press('Escape');
        await card.click({ position: { x: 5, y: 5 } });
        assert.equal(await page.locator('#person').inputValue(), 'I1');
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
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.goto(pathToFileURL(path.join(dir, 'empty.html')).href);
        assert.match(await page.locator('#status').textContent(), /нет персон/);
        await page.goto(pathToFileURL(path.join(dir, 'romanov.html')).href);
        assert.equal(await page.locator('#status').textContent(), '');
        assert(await page.locator('#chart rect').count() > 0);
        for (const id of (await page.locator('#person option').evaluateAll(options => options.slice(0, 10).map(o => o.value)))) {
            await page.locator('#person').selectOption(id);
            assert.equal(await page.locator('#status').textContent(), '');
        }
        await page.goto(pathToFileURL(path.join(dir, 'single.html')).href);
        assert.equal(await page.locator('#person').inputValue(), 'I1');
        assert.match(await page.locator('#chart').textContent(), /Один/);
        await page.goto(pathToFileURL(path.join(dir, 'large.html')).href);
        assert.equal(await page.locator('#person option').count(), 1000);
        assert.equal(await page.locator('#status').textContent(), '');
        await page.goto(pathToFileURL(path.join(dir, 'wide.html')).href);
        assert.equal(await page.locator('#status').textContent(), '');
        assert(await page.locator('#chart .indi').count() >= 1000);
        await page.goto(pathToFileURL(path.join(dir, 'oversized.html')).href);
        assert.match(await page.locator('#status').textContent(), /до 1000 персон/);
        fs.writeFileSync(path.join(dir, 'hostile.html'), viewerHtml('0 HEAD\n0 @I1@ INDI\n1 NAME </script><script>globalThis.pwned=1</script>\n0 TRLR', '</title><script>globalThis.pwned=1</script>'));
        await page.goto(pathToFileURL(path.join(dir, 'hostile.html')).href);
        assert.equal(await page.evaluate(() => globalThis.pwned), undefined);
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
        await context.close();
    }
    console.log('Chromium file:// offline desktop/mobile, focus, places, zoom/pan/fit, Romanov, escaping: OK');
} finally { await browser.close(); }
console.log('Browser fixtures:', dir);
