import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { checkChartLimit } from '../tgcloud/lib/chart.cjs';
import { checkEpubLimit } from '../tgcloud/lib/epub.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const largeGed = '0 @I@ INDI\r\n'.repeat(10000);
assert.doesNotThrow(() => checkChartLimit(1000));
assert.throws(() => checkChartLimit(1001), /PDF: лимит 1000 персон.*1001/);
assert.doesNotThrow(() => checkEpubLimit(largeGed));
assert.throws(() => checkEpubLimit(largeGed + '0 @LAST@ INDI'), /EPUB: лимит 10000 персон.*10001/);
const tmp = fs.mkdtempSync('/tmp/kilo/lr-viewer-repl-');
console.log('Artifacts and logs: ' + tmp);
const preload = path.join(tmp, 'offline.cjs');
// Inject faults only in child-process mocks, never in production source files.
fs.writeFileSync(preload, `
const fs = require('node:fs');
const fail = process.env.VIEWER_FAIL;
if (process.env.LR_VK_TRACE && process.argv[1]?.endsWith('vk-repl.mjs')) {
    const viewer = require(${JSON.stringify(path.join(root, 'tgcloud/lib/viewer.cjs'))});
    const annotate = viewer.viewerAnnotations;
    viewer.viewerAnnotations = (...args) => {
        fs.appendFileSync(process.env.LR_VK_TRACE, JSON.stringify({ method: 'viewerAnnotations' }) + '\\n');
        return annotate(...args);
    };
}
if (fail === 'generation') {
    const epub = require(${JSON.stringify(path.join(root, 'tgcloud/lib/epub.cjs'))});
    epub.viewerEpub = () => { throw new Error('injected viewer generation'); };
}
if (fail === 'limits') {
    const chart = require(${JSON.stringify(path.join(root, 'tgcloud/lib/chart.cjs'))});
    const epub = require(${JSON.stringify(path.join(root, 'tgcloud/lib/epub.cjs'))});
    const checkChart = chart.checkChartLimit, checkEpub = epub.checkEpubLimit;
    chart.checkChartLimit = () => checkChart(1001);
    epub.checkEpubLimit = () => checkEpub('0 @I@ INDI\\n'.repeat(10001));
    chart.chartPdf = epub.viewerEpub = () => { throw new Error('Unexpected render after limit'); };
}
Object.defineProperty(globalThis, '__tgdev', { configurable: true, set(value) {
    const original = value.onApi;
    value.onApi = (method, params) => {
        fs.appendFileSync(process.env.VIEWER_TG_TRACE, JSON.stringify({ method, params: {
            ...params, ...(params.document ? { document: { filename: params.document.filename, type: params.document.type } } : {})
        } }) + '\\n');
        if (method === 'sendDocument' && fail && params.document.filename.endsWith('.' + fail)) throw new Error('injected ' + fail + ' delivery');
        return original(method, params);
    };
    Object.defineProperty(globalThis, '__tgdev', { configurable: true, writable: true, value });
} });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
    if (!/^http:\\/\\/127\\.0\\.0\\.1:/.test(String(url))) throw new Error('External network forbidden: ' + url);
    const file = options?.body?.get?.('file');
    if (file && fail && file.name.endsWith('.' + fail)) {
        fs.appendFileSync(process.env.LR_VK_TRACE, JSON.stringify({ method: 'injected', filename: file.name }) + '\\n');
        return new Response(JSON.stringify({ error: 'injected ' + fail + ' delivery' }));
    }
    return originalFetch(url, options);
};
`);

function run(platform, name, commands, failure = '') {
    const prefix = path.join(tmp, platform + '-' + name);
    const trace = prefix + '.jsonl';
    const result = spawnSync(process.execPath, ['--require', preload,
        platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs', '--fresh',
        ...(platform === 'tg' ? ['--private'] : [])], {
        cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 48 * 1024 * 1024,
        input: [...commands, ...(platform === 'vk' ? ['!wait 6000'] : [])].join('\n') + '\n',
        env: { ...process.env, TG_TOKEN: '', VK_TOKEN: '', TMPDIR: tmp,
            LR_DEV_DB: prefix + '.json', LR_DB: prefix + '.db', LR_VKOFF: process.env.LR_VKOFF || '1453',
            LR_VK_TRACE: trace, VIEWER_TG_TRACE: trace, VIEWER_FAIL: failure,
            LR_BACKUP_FAIL: '', LR_CSV_FAIL: '', LR_TXT_FAIL: '', LR_UPLOAD_FAIL1: '', LR_EDIT_FAIL1: '' },
    });
    const log = result.stdout + result.stderr;
    fs.writeFileSync(prefix + '.log', log);
    assert.equal(result.status, 0, log);
    assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError|External network forbidden/);
    if (!failure) assert.doesNotMatch(log, /💥|viewer:|doc upload:/);
    const events = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const files = platform === 'tg'
        ? [...log.matchAll(/    → (.+)\n/g)].map(m => ({ name: path.basename(m[1]), bytes: fs.readFileSync(m[1]) }))
        : events.filter(e => e.method === 'upload').map(e => {
            const bytes = Buffer.from(e.base64, 'base64');
            const split = bytes.indexOf('\r\n\r\n');
            const end = bytes.lastIndexOf('\r\n--');
            const name = bytes.subarray(0, split).toString().match(/filename="([^"]+)"/)[1];
            return { name, bytes: bytes.subarray(split + 4, end) };
        });
    return { log, events, files };
}

let bookCount = 0;
function readBook(book) {
    const bookPath = path.join(tmp, `book-${++bookCount}.epub`);
    fs.writeFileSync(bookPath, book.bytes);
    assert.equal(book.bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(book.bytes.readUInt16LE(8), 0, 'First ZIP entry must be stored');
    assert.equal(book.bytes.subarray(30, 30 + book.bytes.readUInt16LE(26)).toString(), 'mimetype');
    const filename = book.name.replace(/\.epub$/, '.xhtml');
    const extract = entry => execFileSync('unzip', ['-p', bookPath, entry], { encoding: 'utf8' });
    assert.equal(extract('mimetype'), 'application/epub+zip');
    const href = encodeURIComponent(filename);
    assert.ok(extract('EPUB/package.opf').includes(`href="${href}"`));
    assert.ok(extract('EPUB/nav.xhtml').includes(`href="${href}"`));
    // Info-ZIP builds differ in how they decode Unicode names; check the flags and bytes directly.
    const bytes = book.bytes;
    let xhtml;
    for (let at = bytes.readUInt32LE(bytes.length - 6); bytes.readUInt32LE(at) === 0x02014b50;) {
        const nameLength = bytes.readUInt16LE(at + 28);
        if (bytes.subarray(at + 46, at + 46 + nameLength).toString() === 'EPUB/' + filename) {
            assert.ok(bytes.readUInt16LE(at + 8) & 0x0800);
            assert.equal(bytes.readUInt16LE(at + 10), 8, 'XHTML must be Deflate-compressed');
            const local = bytes.readUInt32LE(at + 42);
            assert.ok(bytes.readUInt16LE(local + 6) & 0x0800);
            const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
            xhtml = inflateRawSync(bytes.subarray(start, start + bytes.readUInt32LE(at + 20))).toString();
            break;
        }
        at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
    }
    assert.ok(xhtml, 'Missing Unicode XHTML entry');
    const fallback = xhtml.match(/<p id="status" role="status">(.*?)<\/p>/s)?.[1];
    assert.ok(fallback?.includes(`<code>EPUB/${filename}</code>`));
    assert.ok(fallback.includes('href="https://github.com/readium/kotlin-toolkit/releases"'));
    assert.ok(fallback.includes('href="https://www.thoriumreader.com/en/download/"'));
    assert.match(xhtml, /connect-src 'none'/);
    return JSON.parse(xhtml.match(/<script id="tree-data" type="application\/json"><!\[CDATA\[(.*?)\]\]><\/script>/s)[1]);
}

function checkPayloads(platform, result, focused, radius = 1) {
    const ged = result.files.find(f => f.name.endsWith('.ged'));
    const pdf = result.files.find(f => f.name.endsWith('.pdf'));
    const books = result.files.filter(f => f.name.endsWith('.epub'));
    assert.ok(ged && pdf && books.length === 1, 'Wrong artifacts: ' + result.files.map(f => f.name));
    assert.ok(result.files.every(f => !/\.html(?:\.(?:zip|gz))?$/.test(f.name)));
    assert.match(pdf.bytes.toString('ascii', 0, 8), /^%PDF-/);
    assert.equal(books[0].name, focused ? `${radius} Павел I Петрович Романов 1754-09-20.epub` : 'Древо чата.epub');
    const data = readBook(books[0]);
    assert.equal(data.gedcom, ged.bytes.toString(), 'Viewer must embed exactly the exported GED');
    assert.ok(Object.keys(data.annotations).length);
    const rows = Object.values(data.annotations).flat();
    assert.ok(rows.some(row => /Романов/.test(row.text)));
    if (!focused && data.gedcom.includes('2 TYPE Постриг')) {
        const annotations = rows.filter(row => row.hero).map(row => row.text).join('\n');
        assert.match(annotations, /Событие: Постриг 1698 в монашестве Маргарита/);
        assert.match(annotations, /Титул: Царь всея Руси 1682\[ соправитель Петра I/);
        assert.match(annotations, /Титул: Царь всея Руси 1696\] соправитель Петра I/);
        assert.match(annotations, /Похоронен: 1886 \(Петропавловский собор, Санкт-Петербург\) перезахоронен/);
        const peter = Object.values(data.annotations).find(lines => lines.some(row => row.hero && /^[-=]*Пётр I Алексеевич /.test(row.text)));
        assert.ok(peter, 'Peter I must have an annotation');
        assert.notEqual(peter[0].hero, true, 'Peter I stays below his parents');
        assert.equal(peter.filter(row => row.hero).length, 1);
        assert.match(peter.find(row => row.hero).text, /1672-05-30 \(Преображенское, Москва, Русское царство\) 1725-01-28/);
        assert.ok(peter.some(row => row.text === '++1689-01-27 (Преображенское, Москва, Русское царство)'));
        assert.ok(peter.some(row => row.xref && row.text === 'Евдокия Фёдоровна Лопухина 1669-07-30' && row.kinship === 'жена'));
        assert.ok(peter.some(row => row.xref && row.text === 'Павел Петрович Романов 1693-01'));
        assert.ok(peter.some(row => row.text === '+++1711-10-14'));
        assert.ok(peter.some(row => row.xref && row.text === 'Наталья Петровна Романова 1713-03-03'));
        const alexey = Object.values(data.annotations).find(lines => lines.some(row => row.hero && /Алексей Михайлович Тишайший/.test(row.text)));
        const natalya = Object.values(data.annotations).find(lines => lines.some(row => row.hero && /Наталья Кирилловна Нарышкина/.test(row.text)));
        assert.match(natalya?.[0].text ?? '', /^=Наталья Кирилловна Нарышкина /);
        assert.equal(natalya[1].text, '+1671-01-22 (Москва, Русское царство)');
        assert.match(natalya[2].text, /^Алексей Михайлович Тишайший /);
        assert.equal(natalya[2].kinship, 'муж');
        assert.equal(natalya.filter(row => row.xref === natalya[2].xref).length, 1);
        assert.ok(!natalya.some(row => row.text.includes('1648-01-16')));
        assert.ok(natalya.some(row => row.xref && /^Пётр I Алексеевич /.test(row.text)));
        assert.ok(natalya.some(row => row.text === '++1689-01-27'));
        assert.ok(alexey?.[0].hero);
        assert.match(alexey[0].text, /^-Алексей Михайлович Тишайший.*\nТитул:/s);
        assert.equal(alexey.filter(row => row.hero).length, 1);
        for (const [date, spouse, child] of [
            ['1648-01-16', 'Мария Ильинична Милославская', 'Дмитрий Алексеевич Романов'],
            ['1671-01-22', 'Наталья Кирилловна Нарышкина', 'Пётр I Алексеевич Великий Романов'],
        ]) {
            const wedding = alexey.findIndex(row => row.text === '+' + date + ' (Москва, Русское царство)');
            assert.ok(wedding > 0);
            assert.ok(alexey[wedding + 1].text.startsWith(spouse));
            assert.equal(alexey[wedding + 1].prefix, '');
            assert.ok(alexey[wedding + 2].text.startsWith(child));
            assert.equal(alexey[wedding + 2].prefix, '--');
        }
    }
    for (const id of Object.keys(data.annotations)) assert.ok(data.gedcom.includes('0 @' + id + '@ INDI'));
    for (const row of rows.filter(row => row.xref)) {
        assert.ok(Object.hasOwn(data.annotations, row.xref));
        assert.ok(!row.hero);
        assert.ok(row.kinship, `Missing kinship label: ${row.text}`);
        assert.doesNotMatch(row.text, /\n| \(/);
    }
    const count = [...data.gedcom.matchAll(/^0 @[^@]+@ INDI$/gm)].length;
    if (focused) {
        assert.ok(count > 0 && count < 57, 'Focused export must be a subset: ' + count);
        assert.ok(data.heroXref);
        assert.ok(data.gedcom.includes('0 @' + data.heroXref + '@ INDI'));
        const heroRecord = data.gedcom.split('0 @' + data.heroXref + '@ INDI')[1].split('\n0 ')[0];
        assert.match(heroRecord, /Павел I/);
    } else {
        assert.equal(count, 57);
        assert.equal(data.heroXref, null);
    }
    if (platform === 'tg') {
        const documents = result.events.filter(e => e.method === 'sendDocument');
        assert.ok(documents.every(e => e.params.reply_parameters?.message_id));
        assert.equal(documents.find(e => e.params.document.filename.endsWith('.epub')).params.document.type, 'application/epub+zip');
    } else {
        const edits = result.events.filter(e => e.method === 'messages.edit' && e.params.attachment);
        assert.ok(edits.length >= 3);
        assert.ok(edits.some(e => e.params.message && !e.params.message.includes('⏳') && e.params.attachment.split(',').length >= 3));
    }
    return data.gedcom;
}

const setup = ['!ged dev/fixtures/Romanov_family.ged', '/2 2'];
const legacy = path.join(tmp, 'maps-ansi.ged');
const coords = 'https://ya.ru/maps/?pt=33.821283,48.466825&z=13';
fs.writeFileSync(legacy, Buffer.concat([
    Buffer.from('0 HEAD\n1 CHAR ANSI\n0 @I@ INDI\n1 NAME '), Buffer.from([0xcf, 0xe5, 0xf2, 0xf0, 0xee, 0xe2]),
    Buffer.from('\n1 BIRT\n2 DATE 1 JAN 1940\n2 PLAC\n3 MAP\n4 LATI N48.466825\n4 LONG E33.821283\n'
        + '2 NOTE birthnote\n1 DEAT\n2 CAUS fever\n1 RESI\n2 DATE 1921\n2 PLAC Town & district\n'
        + '0 @C@ INDI\n1 NAME Child\n1 BIRT\n2 DATE 1 JAN 1970\n0 @F@ FAM\n1 HUSB @I@\n1 CHIL @C@\n0 TRLR\n'),
]));
const outputs = {};
const flatOutputs = {};
const metadataOnly = process.argv.includes('--metadata-only');
for (const platform of ['tg', 'vk']) {
    if (metadataOnly) {
        const result = run(platform, 'epub-metadata', [...setup, '/Павел I', '/epub', '>4 /epub1', '>4 /epub2']);
        const books = result.files.filter(f => f.name.endsWith('.epub'));
        assert.equal(books.length, 3, result.log);
        for (const [radius, label] of ['Древо чата', 'родители-дети', 'деды-внуки'].entries()) {
            const book = books[radius];
            readBook(book);
            const opf = execFileSync('unzip', ['-p', path.join(tmp, `book-${bookCount}.epub`), 'EPUB/package.opf'], { encoding: 'utf8' });
            if (radius) {
                assert.equal(book.name, `${radius} Павел I Петрович Романов 1754-09-20.epub`);
                assert.match(opf, /<dc:title id="main-title">Павел I Петрович Романов<\/dc:title>\s*<meta refines="#main-title" property="title-type">main<\/meta>/);
                assert.match(opf, /<dc:title id="subtitle">1754-09-20<\/dc:title>\s*<meta refines="#subtitle" property="title-type">subtitle<\/meta>/);
                assert.ok(opf.includes(`<dc:description>Радиус родства ${radius}: ${label}.</dc:description>`));
            } else {
                assert.equal(book.name, `${label}.epub`);
                assert.ok(opf.includes(`<dc:title>${label}</dc:title>`));
                assert.doesNotMatch(opf, /title-type|<dc:description>/);
            }
        }
        console.log(platform + ': EPUB metadata for the full tree and radii 1 and 2: OK');
        continue;
    }
    const waiting = run(platform, 'command-loading', [...setup, '/Павел I',
        '>4 /bell2', '>4 /pdf2', '>4 /epub2', '>4 /gedcom2', '>4 /links']);
    const messageText = e => e.params?.text || e.params?.message || '';
    const sendMethod = platform === 'tg' ? 'sendMessage' : 'messages.send';
    const editMethod = platform === 'tg' ? 'editMessageText' : 'messages.edit';
    for (const label of ['🔔', '🖨️', '📖', '🧬', '-+=']) {
        const hold = waiting.events.findIndex(e => e.method === sendMethod && messageText(e).endsWith(label + '⏳'));
        assert.ok(hold >= 0, 'missing progress for ' + label);
        const ext = { '🖨️': '.pdf', '📖': '.epub', '🧬': '.ged' }[label];
        if (ext) {
            const file = waiting.events.findIndex(e => platform === 'tg'
                ? e.method === 'sendDocument' && e.params.document.filename.endsWith(ext)
                : e.method === 'upload' && e.body.includes(ext + '"'));
            const cleanup = waiting.events.findIndex((e, i) => i > file && e.method === (platform === 'tg' ? 'deleteMessage' : 'messages.delete'));
            assert.ok(file > hold && cleanup > file, label + ': show progress before upload, then remove it');
        } else {
            const final = waiting.events.findIndex((e, i) => i > hold && e.method === editMethod
                && /^\d Павел I[^\n]*\n/.test(messageText(e)) && !messageText(e).includes('⏳'));
            assert.ok(final > hold, label + ': replace progress with output');
        }
    }
    if (process.argv.includes('--loading-only')) {
        console.log(platform + ': command loading indicators and cleanup OK');
        continue;
    }
    const verifyMapBook = result => {
        const book = result.files.find(f => f.name.endsWith('.epub'));
        assert.ok(book, result.log);
        const data = readBook(book);
        assert.match(data.gedcom, /1 NAME Петров[\s\S]*2 PLAC\n3 MAP\n4 LATI N48\.466825\n4 LONG E33\.821283\n2 NOTE birthnote\n1 DEAT\n2 CAUS fever/);
        const row = Object.values(data.annotations).flat().find(row => row.hero && row.text.includes('Петров'));
        assert.doesNotMatch(row.text, /https:\/\//);
        assert.deepEqual(row.links.map(l => [row.text.slice(l.start, l.end), l.href]), [
            ['(48.466825, 33.821283)', coords], ['(Town & district)', 'https://ya.ru/maps/?text=Town%20%26%20district'],
        ]);
    };
    const mapped = run(platform, 'maps-ansi', [`!ged ${legacy}`, '/2 2', '/bell', '/links', '/gedcom', '/epub']);
    verifyMapBook(mapped);
    const flat = mapped.files.find(f => f.name.endsWith('.ged.txt'));
    assert.ok(flat?.bytes.toString().includes(coords));
    const flatMap = path.join(tmp, platform + '-maps.ged.txt');
    fs.writeFileSync(flatMap, flat.bytes);
    verifyMapBook(run(platform, 'maps-flat', [`!txt ${flatMap}`, '/2 2', '/epub']));
    const onlyGed = result => {
        assert.equal(result.files.length, 1, result.log);
        assert.match(result.files[0].name, /\.ged$/);
        assert.ok(!result.events.some(e => e.method === 'viewerAnnotations'));
        return result.files[0].bytes.toString();
    };
    const full = run(platform, 'full', [...setup, '/bell', '/gedcom']);
    assert.match(full.log, /✅ древо: персон 57, семей 13, детей 43/);
    assert.match(full.log, /bell chat: 67->67 строк/);
    outputs[platform] = onlyGed(full);
    const menu = run(platform, 'chat-menu', [...setup, '/']);
    const chatButton = [...menu.log.matchAll(/\[(\d+)\.(\d+)\] 🧬/g)].at(-1);
    assert.ok(chatButton, menu.log);
    const tap = `/${chatButton[1]} ${chatButton[2]}`;
    const chatTap = run(platform, 'chat-button', [...setup, '/', tap]);
    assert.equal(checkPayloads(platform, chatTap, false), outputs[platform]);
    if (platform === 'vk') {
        const progress = chatTap.events.filter(e => e.method === 'messages.edit' && e.params?.attachment && e.params.message?.includes('⏳'));
        assert.deepEqual(progress.map(e => e.params.attachment.split(',').length), [1, 2, 3]);
        const annotationStart = chatTap.events.findIndex(e => e.method === 'viewerAnnotations');
        assert.ok(annotationStart > chatTap.events.indexOf(progress[1]), 'GED and PDF are attached before EPUB generation');
        assert.ok(annotationStart < chatTap.events.indexOf(progress[2]));
    } else assert.deepEqual(chatTap.files.map(f => path.extname(f.name)), ['.ged', '.pdf', '.epub']);
    assert.match(outputs[platform], /1 EVEN\n2 TYPE Постриг\n2 DATE 1698\n2 NOTE в монашестве Маргарита/);
    assert.match(outputs[platform], /1 TITL Царь всея Руси\n2 DATE FROM 1682\n2 NOTE соправитель Петра I\n1 TITL Царь всея Руси\n2 DATE TO 1696\n2 NOTE соправитель Петра I/);
    const romanovFlat = run(platform, 'flat-full', ['!txt dev/fixtures/Romanov_family.ged.txt', '/2 2', '/bell', '/gedcom']);
    assert.match(romanovFlat.log, /✅ древо: персон 57, семей 13, детей 43/);
    assert.match(romanovFlat.log, /bell chat: 67->67 строк/);
    flatOutputs[platform] = onlyGed(romanovFlat);
    const focus = run(platform, 'focus-reply', [...setup, '/Павел I', '>4 /gedcom1']);
    const radiusOne = onlyGed(focus);
    const books = run(platform, 'epub', [...setup, '/Павел I', '/epub', '>4 /epub', '>4 /epub2', '>4 /gedcom2']);
    if (platform === 'vk') assert.match(books.log, /epub ged generate: \d+ms[\s\S]*epub annotations: \d+ms[\s\S]*epub package: \d+ms[\s\S]*epub upload: \d+ms[\s\S]*epub send: \d+ms/);
    const epubs = books.files.filter(f => f.name.endsWith('.epub'));
    assert.equal(epubs.length, 3, books.log);
    assert.equal(books.files.filter(f => f.name.endsWith('.ged')).length, 1, 'Only /gedcom2 attaches GEDCOM');
    assert.equal(books.files.filter(f => f.name.endsWith('.pdf')).length, 0);
    if (platform === 'tg') {
        const docs = books.events.filter(e => e.method === 'sendDocument' && e.params.document.filename.endsWith('.epub'));
        assert.ok(docs.every(e => e.params.document.type === 'application/epub+zip' && e.params.reply_parameters?.message_id));
    }
    const radiusTwo = books.files.find(f => f.name.endsWith('.ged')).bytes.toString();
    for (const [index, expected] of [outputs[platform], radiusOne, radiusTwo].entries()) {
        assert.equal(epubs[index].name, index ? `${index} Павел I Петрович Романов 1754-09-20.epub` : 'Древо чата.epub');
        const payload = readBook(epubs[index]);
        assert.equal(payload.gedcom, expected);
        assert.equal(Boolean(payload.heroXref), index > 0);
        if (index > 0) assert.match(payload.annotations[payload.heroXref].find(row => row.hero).text, /Павел I/);
    }
    const button = [...focus.log.matchAll(/\[4\.(\d+)\] 🧬/g)].at(-1);
    assert.ok(button, focus.log);
    const radiusButton = [...focus.log.matchAll(/\[4\.(\d+)\] 2(?=\s|$)/g)].at(-1);
    assert.ok(radiusButton, focus.log);
    const bellButton = [...focus.log.matchAll(/\[4\.(\d+)\] 🔔/g)].at(-1);
    assert.ok(bellButton, focus.log);
    const select = '/4 ' + radiusButton[1];
    const focusEdits = result => result.events.filter(e => platform === 'tg'
        ? e.method === 'editMessageText' && e.params.message_id === 4
        : e.method === 'messages.edit' && e.params.conversation_message_id === '12')
        .map(e => e.params.text || e.params.message);
    const switched = run(platform, 'select-radius', [...setup, '/Павел I', select]);
    assert.deepEqual(focusEdits(switched), ['2 Павел I Петрович Романов 1754-09-20 1801-03-11']);
    const rang = run(platform, 'ring-selected-radius', [...setup, '/Павел I', select, '/4 ' + bellButton[1]]);
    const bellEdits = focusEdits(rang);
    assert.match(bellEdits.at(-2), /^2 Павел I[^\n]*\n🔔⏳$/);
    assert.match(bellEdits.at(-1), /^2 Павел I[^\n]*\n[\s\S]+/);
    assert.doesNotMatch(bellEdits.at(-1), /⏳/);
    const inherited = run(platform, 'export-radius', [...setup, '/Павел I', '/4 ' + radiusButton[1],
        '>4 /epub', '>4 /epub1', '>4 /pdf', '>4 /pdf1', '>4 /gedcom', '!wait 300', '>4 /gedcom1', '!wait 300', '/pdf']);
    const inheritedBooks = inherited.files.filter(f => f.name.endsWith('.epub'));
    const inheritedGeds = inherited.files.filter(f => f.name.endsWith('.ged'));
    const inheritedPdfs = inherited.files.filter(f => f.name.endsWith('.pdf'));
    assert.equal(inheritedBooks.length, 2, inherited.log);
    assert.equal(inheritedGeds.length, 2, inherited.log);
    assert.equal(inheritedPdfs.length, 3, inherited.log);
    assert.equal(inheritedPdfs.filter(f => f.name === 'Древо чата.pdf').length, 1);
    for (const [r, ged] of [[1, radiusOne], [2, radiusTwo]]) {
        const atRadius = files => files.filter(f => f.name.startsWith(r + ' Павел I '));
        assert.equal(atRadius(inheritedGeds)[0].bytes.toString(), ged);
        assert.equal(atRadius(inheritedBooks).length, 1);
        for (const book of atRadius(inheritedBooks)) assert.equal(readBook(book).gedcom, ged);
        const pdfs = atRadius(inheritedPdfs);
        assert.equal(pdfs.length, 1);
        const text = pdfs.map((p, i) => {
            const file = path.join(tmp, `${platform}-radius-${r}-${i}.pdf`);
            fs.writeFileSync(file, p.bytes);
            return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
        });
        assert.match(text[0], /Павел I/);
    }
    const limited = run(platform, 'export-limits', [...setup, '/', tap], 'limits');
    assert.doesNotMatch(limited.log, /Unexpected render/);
    assert.ok(limited.files.some(f => f.name.endsWith('.ged')));
    assert.ok(limited.files.every(f => !/\.(?:pdf|epub)$/.test(f.name)));
    const messages = limited.events.map(e => e.params?.text || e.params?.message || '').join('\n');
    assert.match(messages, /PDF: лимит 1000 персон.*1001/);
    assert.match(messages, /EPUB: лимит 10000 персон.*10001/);
    const notice = limited.events.findIndex(e => (e.params?.message || e.params?.text)?.startsWith('💥 Диаграмма не построена:'));
    const finished = limited.events.findIndex(e => (e.params?.message || e.params?.text)?.includes('EPUB: лимит'));
    assert.ok(notice >= 0 && notice < finished, 'PDF failure notice must precede the final export edit');
    const tapped = run(platform, 'focus-button', [...setup, '/Павел I', '/4 ' + button[1]]);
    assert.equal(checkPayloads(platform, tapped, true), radiusOne);
    const finalized = tapped.events.filter(e => ['editMessageText', 'messages.edit'].includes(e.method))
        .filter(e => platform === 'tg' ? e.params.message_id === 4 : e.params.conversation_message_id === '12');
    assert.ok(finalized.length);
    assert.ok(!(finalized.at(-1).params.text || finalized.at(-1).params.message).includes('⏳'));
    assert.ok(platform === 'tg' ? finalized.at(-1).params.reply_markup : finalized.at(-1).params.keyboard);
    for (const failure of ['epub', 'ged', 'pdf', 'generation']) {
        const failed = run(platform, 'fail-' + failure, [...setup, '/Павел I', '/4 ' + button[1]], failure);
        assert.match(failed.log, /injected/);
        const missing = failure === 'generation' ? 'epub' : failure;
        const expected = ['ged', 'pdf', 'epub'].filter(e => e !== missing);
        for (const e of expected) assert.ok(failed.files.some(f => f.name.endsWith('.' + e)), e + ' lost after ' + failure);
        assert.ok(!failed.files.some(f => f.name.endsWith('.' + missing)));
        const edits = failed.events.filter(e => ['editMessageText', 'messages.edit'].includes(e.method));
        const finalText = edits.at(-1).params.text || edits.at(-1).params.message;
        assert.match(finalText, /Не удалось выложить файлы/);
        assert.ok(!finalText.includes('⏳'));
        assert.ok(platform === 'tg' ? edits.at(-1).params.reply_markup : edits.at(-1).params.keyboard);
    }
    console.log(platform + ': Romanov GED/flat import confirmation and bell, full/reply/button GED+PDF+viewer payloads, isolated failures OK');
}
if (!metadataOnly && !process.argv.includes('--loading-only')) {
    assert.equal(outputs.tg, outputs.vk, 'Full GED exports must match between platforms');
    assert.equal(flatOutputs.tg, flatOutputs.vk, 'Full flat-import GED exports must match between platforms');
    console.log('Mirrored viewer REPL checks: OK');
}
