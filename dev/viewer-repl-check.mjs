import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { viewerFileBase } from '../tgcloud/lib/viewer.cjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync('/tmp/kilo/lr-viewer-repl-');
console.log('Artifacts and logs: ' + tmp);
const preload = path.join(tmp, 'offline.cjs');
// Inject faults only in child-process mocks, never in production source files.
fs.writeFileSync(preload, `
const fs = require('node:fs');
const fail = process.env.VIEWER_FAIL;
if (fail === 'generation') {
    const viewer = require(${JSON.stringify(path.join(root, 'tgcloud/lib/viewer.cjs'))});
    viewer.viewerHtml = viewer.viewerZip = () => { throw new Error('injected viewer generation'); };
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
            LR_DEV_DB: prefix + '.json', LR_DB: prefix + '.db', LR_VKOFF: '1453',
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

function checkPayloads(platform, result, focused) {
    const ged = result.files.find(f => f.name.endsWith('.ged'));
    const pdf = result.files.find(f => f.name.endsWith('.pdf'));
    const viewer = result.files.find(f => f.name.endsWith(platform === 'tg' ? '.html' : '.gz'));
    assert.ok(ged && pdf && viewer, 'Missing artifact: ' + result.files.map(f => f.name));
    assert.match(pdf.bytes.toString('ascii', 0, 8), /^%PDF-/);
    let html = viewer.bytes.toString();
    if (platform === 'vk') {
        assert.equal(viewer.bytes.readUInt16BE(0), 0x1f8b);
        assert.ok(viewer.bytes[3] & 0x08, 'Gzip must carry an original filename');
        assert.equal(viewer.name, ged.name.replace(/\.ged$/, '.gz'));
        assert.equal(viewer.bytes.subarray(10, viewer.bytes.indexOf(0, 10)).toString('ascii'), viewerFileBase(ged.name.replace(/\.ged$/, '')) + '.html');
        html = gunzipSync(viewer.bytes).toString('utf8');
        assert.doesNotMatch(result.log, /ged viewer HTML:|viewer HTML debug:/);
    }
    const data = JSON.parse(html.match(/<script id="tree-data" type="application\/json">(.*?)<\/script>/s)[1]);
    assert.equal(data.gedcom, ged.bytes.toString(), 'Viewer must embed exactly the exported GED');
    assert.ok(Object.keys(data.annotations).length);
    assert.ok(Object.values(data.annotations).some(text => /Романов/.test(text)));
    for (const id of Object.keys(data.annotations)) assert.ok(data.gedcom.includes('0 @' + id + '@ INDI'));
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
    assert.match(html, /connect-src 'none'/);
    if (platform === 'tg') {
        const documents = result.events.filter(e => e.method === 'sendDocument');
        assert.ok(documents.every(e => e.params.reply_parameters?.message_id));
        assert.equal(documents.find(e => e.params.document.filename.endsWith('.html')).params.document.type, 'text/html; charset=utf-8');
    } else {
        const edits = result.events.filter(e => e.method === 'messages.edit' && e.params.attachment);
        assert.ok(edits.length >= 3);
        assert.ok(edits.some(e => e.params.message && !e.params.message.includes('⏳') && e.params.attachment.split(',').length >= 3));
    }
    return data.gedcom;
}

const setup = ['!ged dev/fixtures/Romanov_family.ged', '/2 2'];
const outputs = {};
const flatOutputs = {};
for (const platform of ['tg', 'vk']) {
    const full = run(platform, 'full', [...setup, '/bell', '/gedcom']);
    assert.match(full.log, /✅ древо: персон 57, семей 13, детей 43/);
    assert.match(full.log, /bell chat: 67->67 строк/);
    outputs[platform] = checkPayloads(platform, full, false);
    const flat = run(platform, 'flat-full', ['!txt dev/fixtures/Romanov_family.ged.txt', '/2 2', '/bell', '/gedcom']);
    assert.match(flat.log, /✅ древо: персон 57, семей 13, детей 43/);
    assert.match(flat.log, /bell chat: 67->67 строк/);
    flatOutputs[platform] = checkPayloads(platform, flat, false);
    const focus = run(platform, 'focus-reply', [...setup, '/Павел I', '>4 /gedcom1']);
    checkPayloads(platform, focus, true);
    const button = [...focus.log.matchAll(/\[4\.(\d+)\] 🧬/g)].at(-1);
    assert.ok(button, focus.log);
    const tapped = run(platform, 'focus-button', [...setup, '/Павел I', '/4 ' + button[1]]);
    checkPayloads(platform, tapped, true);
    const finalized = tapped.events.filter(e => ['editMessageText', 'messages.edit'].includes(e.method))
        .filter(e => platform === 'tg' ? e.params.message_id === 4 : e.params.conversation_message_id === '12');
    assert.ok(finalized.length);
    assert.ok(!(finalized.at(-1).params.text || finalized.at(-1).params.message).includes('⏳'));
    assert.ok(platform === 'tg' ? finalized.at(-1).params.reply_markup : finalized.at(-1).params.keyboard);
    for (const failure of [platform === 'tg' ? 'html' : 'gz', 'ged', 'pdf', 'generation']) {
        const failed = run(platform, 'fail-' + failure, [...setup, '/gedcom'], failure);
        assert.match(failed.log, /injected/);
        const ext = platform === 'tg' ? 'html' : 'gz';
        const expected = ['ged', 'pdf', ext].filter(e => e !== failure && !(failure === 'generation' && e === ext));
        for (const e of expected) assert.ok(failed.files.some(f => f.name.endsWith('.' + e)), e + ' lost after ' + failure);
        assert.ok(!failed.files.some(f => f.name.endsWith('.' + (failure === 'generation' ? ext : failure))));
        const edits = failed.events.filter(e => ['editMessageText', 'messages.edit'].includes(e.method));
        const finalText = edits.at(-1).params.text || edits.at(-1).params.message;
        assert.match(finalText, /Не удалось выложить файлы/);
        assert.ok(!finalText.includes('⏳'));
    }
    console.log(platform + ': Romanov GED/flat import confirmation and bell, full/reply/button GED+PDF+viewer payloads, four isolated failures OK');
}
assert.equal(outputs.tg, outputs.vk, 'Full GED exports must match between platforms');
assert.equal(flatOutputs.tg, flatOutputs.vk, 'Full flat-import GED exports must match between platforms');
console.log('Mirrored viewer REPL checks: OK');
