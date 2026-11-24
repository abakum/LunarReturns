#!/usr/bin/env node
// End-to-end VK Long Poll latency check. No token, external network or live DB.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const A = 2000000001, B = 2000000002;
const dualOnly = process.argv.includes('--dual');
    const preload = 'data:text/javascript,' + encodeURIComponent(`
    const http = globalThis.fetch;
    const origin = process.env.LR_BENCH_ORIGIN;
    let block = false, sends = 0;
    process.on('message', message => {
        if (message === 'ping') process.send({ kind: 'pong' });
        if (message === 'arm') { block = true; process.send({ kind: 'armed' }); }
    });
    globalThis.fetch = (input, options) => {
        let url = new URL(input);
        if (url.origin === 'https://api.vk.com' && url.pathname.startsWith('/method/'))
            url = new URL(url.pathname + url.search, origin);
        if (url.origin !== origin) throw new Error('External network forbidden: ' + url.origin);
        if (block && url.pathname === '/method/messages.send' && Number(options.body.get('peer_id')) === ${A} && ++sends === 2) {
            const at = Date.now();
            process.send({ kind: 'blocking', at });
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1400);
            process.send({ kind: 'unblocked', at: Date.now() });
        }
        return http(url, { ...options, redirect: 'error' });
    };
`);

const message = (peer, cmid, text, reply_message) => ({ type: 'message_new', group_id: 99, object: { message: {
    peer_id: peer, from_id: 123, id: cmid, conversation_message_id: cmid, date: Math.floor(Date.now() / 1000), text, reply_message,
} } });

function largeTreeGedcom(hero = 'Bench Hero') {
    const rows = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8'];
    const family = (id, depth) => {
        rows.push(`0 @I${id}@ INDI`, `1 NAME ${id ? 'Relative ' + id : hero}`, '1 SEX M',
            '1 BIRT', `2 DATE 1 JAN ${1850 + depth * 25}`);
        if (depth === 5) return;
        const children = Array.from({ length: 4 }, (_, i) => id * 4 + i + 1);
        rows.push(`0 @F${id}@ FAM`, `1 HUSB @I${id}@`, ...children.map(i => `1 CHIL @I${i}@`));
        for (const child of children) family(child, depth + 1);
    };
    family(0, 0);
    rows.push('0 TRLR');
    return rows.join('\n');
}

function seedLargeTree(db, peer = A, hero) {
    execFileSync(process.execPath, ['-e', `
        const fs = require('node:fs');
        const bot = require('./lunarreturns.js').__test;
        const tree = bot.parseGedcom(fs.readFileSync(0, 'utf8'));
        require('node:assert/strict').equal(tree.indis.length, 1365);
        bot.importGedcom(${peer}, tree);
    `], { cwd: root, input: largeTreeGedcom(hero), timeout: 30000,
        env: { PATH: process.env.PATH, TZ: 'UTC', VK_TOKEN: 'test-token', LR_DB: db } });
}

async function bench(name, run, logging = true, large = false, dual = false) {
    const tmp = await mkdtemp(join(tmpdir(), 'lr-vk-latency-'));
    const log = [], changed = new EventEmitter(), messages = new Map();
    let origin, child, exited, ts = 1, cmid = 100, heldSend, heldUpload, docId = 0;
    const add = (kind, fields = {}) => {
        const entry = { kind, ...fields, index: log.length };
        log.push(entry);
        changed.emit('entry');
        return entry;
    };
    let polls = 0;
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, origin);
        const json = value => res.end(JSON.stringify(value));
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/poll') {
            if (url.searchParams.get('act') !== 'a_check' || url.searchParams.get('key') !== 'k' || Number(url.searchParams.get('ts')) !== ts) {
                add('unexpected', { url: req.url });
                return json({ failed: 1, ts: String(ts) });
            }
            add('poll_request', { n: ++polls, json, drop: () => res.destroy() });
            return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        if (url.pathname === '/upload') {
            const bytes = Buffer.concat(chunks);
            const filename = bytes.subarray(0, bytes.indexOf('\r\n\r\n')).toString().match(/filename="([^"]+)"/)?.[1];
            const file = String(++docId);
            add('upload', { bytes: bytes.length, filename, peer: Number(url.searchParams.get('peer')), file });
            const send = () => json({ file });
            if (heldUpload === true) heldUpload = send;
            else send();
            return;
        }
        const method = url.pathname.slice('/method/'.length);
        const p = new URLSearchParams(Buffer.concat(chunks).toString());
        const result = response => json({ response });
        switch (method) {
        case 'groups.getLongPollServer': return result({ server: origin + '/poll', key: 'k', ts: String(ts) });
        case 'groups.getMembers': return result({ items: [{ id: 123, role: 'creator' }] });
        case 'messages.getConversationMembers': return result({ items: [{ member_id: 123, is_admin: true }] });
        case 'messages.sendMessageEventAnswer':
            add('toast', { event_id: p.get('event_id'), text: JSON.parse(p.get('event_data')).text });
            return result(1);
        case 'messages.delete':
            add('delete', { peer: Number(p.get('peer_id')), id: Number(p.get('message_ids') || p.get('conversation_message_ids')) });
            return result(1);
        case 'messages.send': {
            const peer = Number(p.get('peer_id'));
            const sent = { cmid: ++cmid, peer, text: p.get('message'), keyboard: JSON.parse(p.get('keyboard')) };
            messages.set(`${peer}:${cmid}`, sent);
            const send = () => result(sent.cmid);
            if (peer === A && heldSend === true) heldSend = send;
            else send();
            add('send', sent);
            return;
        }
        case 'messages.getByConversationMessageId': {
            const m = messages.get(p.get('peer_id') + ':' + p.get('conversation_message_ids'));
            return result({ items: m ? [{ id: m.cmid, text: m.text }] : [] });
        }
        case 'messages.edit': {
            const m = messages.get(p.get('peer_id') + ':' + (p.get('conversation_message_id') || p.get('message_id')));
            if (m && p.has('message')) {
                m.text = p.get('message');
                if (/⏳\.+$/.test(m.text)) add('progress_dots', { peer: m.peer });
                add('text_edit', { peer: m.peer, cmid: m.cmid, text: m.text, attachment: p.get('attachment'),
                    keyboard: JSON.parse(p.get('keyboard')) });
            }
            if (m && p.has('keyboard')) {
                m.keyboard = JSON.parse(p.get('keyboard'));
                add('keyboard_edit', { peer: m.peer, cmid: m.cmid, keyboard: m.keyboard });
            }
            if (m && p.get('attachment')) add('attachment_edit', { peer: m.peer, cmid: m.cmid, attachments: p.get('attachment').split(',') });
            return result(1);
        }
        case 'docs.getMessagesUploadServer': return result({ upload_url: origin + '/upload?peer=' + p.get('peer_id') });
        case 'docs.save': return result({ doc: { owner_id: -99, id: Number(p.get('file')) } });
        default:
            add('unexpected', { method });
            return json({ error: { error_code: 100, error_msg: 'Unexpected method: ' + method } });
        }
    });
    const wait = async (kind, test = () => true) => {
        const signal = AbortSignal.timeout(dual ? 240000 : large ? 90000 : 10000);
        for (;;) {
            const hit = log.find(e => e.kind === kind && test(e));
            if (hit) return hit;
            const bad = log.find(e => ['unexpected', 'exit', 'child_error'].includes(e.kind));
            if (bad) throw new Error(JSON.stringify(bad));
            try { await once(changed, 'entry', { signal }); }
            catch (e) { throw new Error('Timed out waiting for ' + kind, { cause: e }); }
        }
    };
    let nextPoll = 1;
    const takePoll = () => {
        const n = nextPoll++;
        return wait('poll_request', e => e.n === n);
    };
    const deliver = (request, ...updates) => {
        const entry = add('poll_response', { at: Date.now(), ts: ++ts });
        request.json({ ts: String(ts), updates });
        return entry;
    };
    const push = async (...updates) => deliver(await takePoll(), ...updates);
    const timing = (stage, test = () => true) => wait('timing', e => e.stage === stage && test(e));
    const handler = (stage, peer, id) => timing(stage, e => e.peer === peer && e.cmid === id);
    try {
        if (large) seedLargeTree(join(tmp, 'bench.db'));
        if (dual) seedLargeTree(join(tmp, 'bench.db'), B, 'Second Hero');
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        origin = 'http://127.0.0.1:' + server.address().port;
        child = fork(join(root, 'lunarreturns.js'), [], {
            cwd: root, silent: true, execArgv: ['--import', preload], env: {
                PATH: process.env.PATH, TZ: 'UTC', VK_TOKEN: 'test-token', VK_GROUP_ID: '99',
                LR_DB: join(tmp, 'bench.db'), LR_BENCH_ORIGIN: origin, LOG_VK_TIMINGS: logging ? '1' : '0',
            },
        });
        exited = new Promise(resolve => child.once('close', (code, signal) => {
            add('exit', { code, signal });
            resolve();
        }));
        child.on('error', e => add('child_error', { error: e.message }));
        child.on('message', e => add(e.kind, e));
        for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => {
            if (line.startsWith('vk timing ')) add('timing', JSON.parse(line.slice('vk timing '.length)));
            else add('output', { line });
        });
        await run({ wait, takePoll, deliver, push, timing, handler, child, log,
            holdSend: () => { heldSend = true; }, releaseSend: () => heldSend(),
            holdUpload: () => { heldUpload = true; }, releaseUpload: () => heldUpload(),
        });
        assert.equal(log.find(e => e.kind === 'unexpected' || e.kind === 'exit' || e.kind === 'child_error'), undefined);
        console.log('OK', name);
    } catch (e) {
        console.error(name, log.slice(-60).map(e => JSON.stringify(e)).join('\n'));
        throw e;
    } finally {
        if (child) { child.kill('SIGKILL'); await exited; }
        if (server.listening) {
            const closed = once(server, 'close');
            server.close();
            server.closeAllConnections();
            await closed;
        }
        await rm(tmp, { recursive: true, force: true });
    }
}

if (!dualOnly) {
await bench('independent chats, ordered within chat, shared send queue', async s => {
    s.holdSend();
    await s.push(message(A, 1, '/html1'));
    await s.wait('send', e => e.peer === A);
    await s.push(message(A, 2, '/html0'), message(B, 3, '/html1'));
    await s.handler('handler_start', B, 3);
    assert.ok(!s.log.some(e => e.stage === 'handler_start' && e.peer === A && e.cmid === 2));
    assert.ok(!s.log.some(e => e.kind === 'send' && e.peer === B));
    s.releaseSend();
    const first = await s.handler('handler_done', A, 1);
    const second = await s.handler('handler_start', A, 2);
    assert.ok(first.index < second.index);
    const sent = await s.timing('send_done', e => e.peer === B && e.reply_to === 3);
    assert.equal(sent.status, 'ok');
    assert.ok(sent.queue_ms >= 300, JSON.stringify(sent));
    await s.handler('handler_done', A, 2);
    console.log(`  B send queue: ${sent.queue_ms} ms`);
});

await bench('delivery delay and poll recovery', async s => {
    (await s.takePoll()).drop();
    await s.timing('poll_error');
    const poll = await s.takePoll();
    const update = message(B, 1, '/html1');
    const since = performance.now();
    s.child.send('ping');
    await s.wait('pong');
    await delay(Math.max(0, 2000 - (performance.now() - since)));
    const response = s.deliver(poll, update);
    const batch = await s.timing('poll', e => Number(e.ts) === response.ts);
    const start = await s.handler('handler_start', B, 1);
    assert.ok(batch.ms >= 1500 && start.age_ms >= 1500 && start.queue_ms < 1000, JSON.stringify({ batch, start }));
    await s.handler('handler_done', B, 1);
    console.log(`  B age: ${start.age_ms} ms; handler queue: ${start.queue_ms} ms`);
});

for (const logging of [true, false]) await bench(`event loop blockage, timings ${logging ? 'on' : 'off'}`, async s => {
    s.child.send('arm');
    await s.wait('armed');
    s.holdSend();
    await s.push(message(A, 1, '/html1'));
    await s.wait('send', e => e.peer === A);
    await s.push(message(A, 2, '/html0'));
    const poll = await s.takePoll();
    s.releaseSend();
    await s.wait('blocking');
    const response = s.deliver(poll, message(B, 3, '/html1'));
    const unblocked = await s.wait('unblocked');
    assert.ok(response.at < unblocked.at, JSON.stringify({ response, unblocked }));
    if (logging) {
        const lag = await s.timing('loop_lag', e => e.loop_lag_ms >= 800);
        const start = await s.handler('handler_start', B, 3);
        assert.ok(start.at_ms >= unblocked.at && start.queue_ms < 1000, JSON.stringify(start));
        console.log(`  B waited ${start.at_ms - response.at} ms after HTTP reply; loop lag: ${lag.loop_lag_ms} ms`);
    }
    await s.wait('send', e => e.peer === B);
    if (!logging) assert.ok(!s.log.some(e => e.kind === 'timing'));
}, logging);

await bench('real focus export with a second chat active', async s => {
    await s.push(message(A, 1, '/html1'), message(A, 2, 'Bench Hero 1950-01-01'));
    const panel = await s.wait('send', e => e.peer === A && e.keyboard?.buttons.flat().some(b => b.action.label === '🧬'));
    const button = panel.keyboard.buttons.flat().find(b => b.action.label === '🧬');
    const payload = JSON.parse(button.action.payload);
    assert.equal(payload.c, 'foc:tree');
    s.holdUpload();
    await s.push({ type: 'message_event', group_id: 99, object: {
        peer_id: A, user_id: 123, conversation_message_id: panel.cmid, event_id: 'bench-export', payload,
    } });
    const upload = await s.wait('upload');
    assert.ok(upload.bytes > 0);
    await s.push(message(B, 3, '/html1'));
    const b = await s.handler('handler_done', B, 3);
    assert.ok(!s.log.some(e => e.stage === 'export_done'));
    s.releaseUpload();
    const focus = await s.timing('focus_prepare', e => e.event_id === 'bench-export');
    const done = await s.timing('export_done', e => e.event_id === 'bench-export');
    assert.equal(done.status, 'ok');
    assert.ok(b.index < done.index);
    for (const phase of ['prepare', 'upload'])
        assert.equal((await s.timing('export_stage', e => e.format === 'HTML' && e.phase === phase)).status, 'ok');
    console.log(`  Focus preparation: ${focus.ms} ms; export incl. held upload: ${done.ms} ms`);
});

await bench('large focus HTML export and two commands through Long Poll', async s => {
    await s.push(message(A, 1, '/html1'), message(A, 2, 'Bench Hero 1850-01-01'));
    const panel = await s.wait('send', e => e.peer === A && e.keyboard?.buttons.flat().some(b => b.action.label === '🧬'));
    const tap = (keyboard, label, event_id) => {
        const button = keyboard.buttons.flat().find(b => b.action.label === label);
        assert.ok(button, `missing focus button ${label}`);
        return s.push({ type: 'message_event', group_id: 99, object: {
            peer_id: A, user_id: 123, conversation_message_id: panel.cmid, event_id, payload: button.action.payload,
        } });
    };
    await tap(panel.keyboard, '5', 'bench-radius');
    assert.equal((await s.timing('handler_done', e => e.event_id === 'bench-radius')).status, 'ok');
    const updated = await s.wait('keyboard_edit', e => e.peer === A && e.cmid === panel.cmid);
    await tap(updated.keyboard, '🧬', 'bench-large');
    const poll = await s.takePoll();
    const preparing = await s.timing('worker_start', e => e.event_id === 'bench-large' && e.op === 'html');
    const response = s.deliver(poll, message(B, 3, '/html1'), message(B, 4, '/'));
    const generated = await s.timing('worker_done', e => e.job_id === preparing.job_id && e.op === 'html');
    const batch = await s.timing('poll', e => Number(e.ts) === response.ts);
    const prep = await s.timing('export_stage', e => e.event_id === 'bench-large' && e.format === 'HTML' && e.phase === 'prepare');
    const focus = await s.timing('focus_prepare', e => e.event_id === 'bench-large');
    const done = await s.timing('export_done', e => e.event_id === 'bench-large');
    assert.equal(done.status, 'ok');
    assert.equal(prep.status, 'ok');
    assert.equal(generated.status, 'ok');
    assert.ok(response.at < generated.at_ms, 'second chat was not injected during actual HTML preparation');
    for (const [id, text] of [[3, '/html1'], [4, '/']]) {
        const start = await s.handler('handler_start', B, id);
        const sent = await s.timing('send_done', e => e.peer === B && e.reply_to === id);
        assert.equal(sent.status, 'ok');
        assert.ok(start.index < generated.index, `${text} must start before HTML generation finishes`);
        if (id === 3) assert.ok(sent.index < generated.index, '/html1 must be answered before HTML generation finishes');
        console.log(`  ${text}: HTTP reply → handler ${start.at_ms - response.at} ms; queue ${start.queue_ms} ms; send queue ${sent.queue_ms} ms`);
    }
    const lag = Math.max(0, ...s.log.filter(e => e.stage === 'loop_lag' && e.at_ms >= preparing.at && e.at_ms <= batch.at_ms + 250)
        .map(e => e.loop_lag_ms));
    console.log(`  1365-person fixture; focus preparation ${focus.ms} ms; HTML preparation ${prep.ms} ms; HTTP reply → batch ${batch.received_at_ms - response.at} ms; loop lag ${lag || '<250'} ms`);

    // Exercise less expensive paths on the same fixture without imposing a speed threshold.
    for (const [id, command, op] of [[5, '/gedcom', 'gedcom'], [6, '/links', 'flat'], [7, '/Relative', 'flat_search'],
        [9, '/pdf', 'pdf'], [10, '/epub', 'epub'], [11, '/html', 'html']]) {
        const since = s.log.length;
        if (command === '/html') s.holdUpload();
        const response = await s.push(message(A, id, command), message(B, id, '/html1'));
        const start = await s.handler('handler_start', B, id);
        const computed = await s.timing('worker_done', e => e.index >= since && e.peer === A && e.op === op);
        assert.equal(computed.status, command === '/pdf' ? 'error' : 'ok');
        if (command === '/html') {
            await s.wait('upload', e => e.index >= since && e.peer === A && e.filename?.endsWith('.zip'));
            const progress = s.log.find(e => e.index >= since && e.kind === 'send' && e.peer === A && e.text === '⏳');
            assert.ok(progress);
            assert.ok(!s.log.some(e => e.index >= since && e.peer === A && e.kind === 'delete' && e.id === progress.cmid));
            assert.ok(!s.log.some(e => e.index >= since && e.kind === 'text_edit' && e.cmid === progress.cmid && !e.text.startsWith('⏳')));
            s.releaseUpload();
        }
        assert.equal((await s.handler('handler_done', A, id)).status, 'ok');
        const indicator = s.log.find(e => e.index >= since && e.kind === 'send' && e.peer === A && e.text === '⏳');
        assert.ok(indicator?.keyboard?.buttons.flat().some(b => b.action.label === '❌'), `missing ${command} cancel button`);
        if (command === '/html' || command === '/epub')
            assert.ok(s.log.some(e => e.index >= since && e.kind === 'progress_dots' && e.peer === A));
        if (command === '/pdf') assert.ok(s.log.some(e => e.index >= since && e.kind === 'text_edit' && e.cmid === indicator.cmid && /^PDF: лимит /.test(e.text)));
        if (['gedcom', 'epub', 'html'].includes(op)) {
            const edits = s.log.filter(e => e.index >= since && e.kind === 'text_edit' && e.cmid === indicator.cmid && !e.text.startsWith('⏳'));
            assert.equal(edits.length, 1);
            assert.match(edits[0].attachment, /^doc-99_\d+$/);
            assert.deepEqual(edits[0].keyboard.buttons, []);
            assert.ok(!s.log.some(e => e.index >= since && e.kind === 'delete' && e.id === indicator.cmid));
        }
        console.log(`  ${command}: worker ${computed.ms} ms; second chat started ${start.at_ms - response.at} ms after response`);
    }
    const importedPeer = A + 2;
    const responseImport = await s.push(message(importedPeer, 8, largeTreeGedcom()), message(B, 8, '/html1'));
    const startImport = await s.handler('handler_start', B, 8);
    const parsed = await s.timing('worker_done', e => e.peer === importedPeer && e.op === 'parse_gedcom');
    const txn = await s.timing('import_transaction', e => e.peer === importedPeer);
    assert.equal(parsed.status, 'ok');
    assert.equal(txn.status, 'ok');
    assert.equal((await s.handler('handler_done', importedPeer, 8)).status, 'ok');
    await s.handler('handler_done', B, 8);
    console.log(`  large GEDCOM import: worker parse ${parsed.ms} ms; SQLite transaction ${txn.ms} ms; second chat started ${startImport.at_ms - responseImport.at} ms after response`);
}, true, true);
}

for (const cancel of [null, A, B, 'command', 'bell']) await bench(cancel ? `cancel ${cancel === A ? 'running' : cancel === B ? 'queued' : cancel} VK work` : 'two simultaneous fifth-radius VK HTML exports', async s => {
    await s.push(message(A, 1, '/html1'), message(B, 1, '/html1'));
    await Promise.all([A, B].map(peer => s.handler('handler_done', peer, 1)));
    await s.push(message(A, 2, 'Bench Hero 1850-01-01'), message(B, 2, 'Second Hero 1850-01-01'));
    const panels = await Promise.all([A, B].map(peer => s.wait('send', e => e.peer === peer
        && e.keyboard?.buttons.flat().some(b => b.action.label === '🧬'))));
    const tap = (panel, keyboard, label, event_id) => {
        const button = keyboard.buttons.flat().find(b => b.action.label === label);
        assert.ok(button, `missing ${label} in chat ${panel.peer}`);
        return { type: 'message_event', group_id: 99, object: {
            peer_id: panel.peer, user_id: 123, conversation_message_id: panel.cmid, event_id, payload: button.action.payload,
        } };
    };
    await s.push(...panels.map(p => tap(p, p.keyboard, '5', `radius-${p.peer}`)));
    const focused = await Promise.all(panels.map(p => s.wait('keyboard_edit', e => e.peer === p.peer && e.cmid === p.cmid)));
    await s.push(tap(panels[0], focused[0].keyboard, '🧬', 'dual-a'));
    const poll = await s.takePoll();
    const startA = await s.timing('worker_start', e => e.event_id === 'dual-a' && e.op === 'html');
    if (cancel === 'bell') {
        const since = s.log.length;
        s.deliver(poll, tap(panels[1], focused[1].keyboard, '🔔', 'bell'));
        const progress = await s.wait('keyboard_edit', e => e.peer === B && e.cmid === panels[1].cmid && e.index >= since);
        await s.timing('worker_snapshot', e => e.peer === B && e.index > startA.index);
        assert.equal(progress.keyboard.buttons.flat().filter(b => b.action.label === '❌').length, 1);
        await s.push(tap(panels[1], progress.keyboard, '❌', 'cancel-bell'));
        assert.equal((await s.wait('toast', e => e.event_id === 'cancel-bell')).text, 'экспорт отменён');
        await s.timing('handler_done', e => e.event_id === 'bell');
        assert.equal((await s.timing('export_done', e => e.event_id === 'dual-a')).status, 'ok');
        assert.ok(!s.log.some(e => e.kind === 'send' && e.peer === B && e.index >= since));
        return;
    }
    if (cancel === 'command') {
        s.deliver(poll, message(B, 3, '/html'));
        const indicator = await s.wait('send', e => e.peer === B && e.text === '⏳');
        await s.timing('worker_snapshot', e => e.peer === B && e.index > startA.index);
        await s.push(tap(indicator, indicator.keyboard, '❌', 'cancel-direct'));
        assert.equal((await s.wait('toast', e => e.event_id === 'cancel-direct')).text, 'работа отменена');
        await s.handler('handler_done', B, 3);
        assert.equal((await s.timing('export_done', e => e.event_id === 'dual-a')).status, 'ok');
        assert.ok(!s.log.some(e => e.peer === B && (e.kind === 'upload' || (e.kind === 'send' && e.index > indicator.index))));
        return;
    }
    s.deliver(poll, tap(panels[1], focused[1].keyboard, '🧬', 'dual-b'));
    const bEntered = await s.timing('handler_start', e => e.event_id === 'dual-b');
    const bQueued = await s.timing('worker_snapshot', e => e.event_id === 'dual-b');
    if (cancel) {
        const i = cancel === A ? 0 : 1;
        await s.push(tap(panels[i], focused[i].keyboard, '❌', 'cancel'));
        const toast = await s.wait('toast', e => e.event_id === 'cancel');
        assert.equal(toast.text, 'экспорт отменён');
        const survivor = cancel === A ? 'dual-b' : 'dual-a';
        assert.equal((await s.timing('export_done', e => e.event_id === survivor)).status, 'ok');
        assert.ok(s.log.some(e => e.kind === 'progress_dots' && e.peer !== cancel));
        assert.ok(!s.log.some(e => e.kind === 'upload' && e.peer === cancel && e.filename?.endsWith('.zip')));
        if (cancel === B) assert.ok(!s.log.some(e => e.stage === 'worker_queue' && e.event_id === 'dual-b'));
        else assert.equal((await s.timing('export_done', e => e.event_id === 'dual-a')).status, 'superseded');
        return;
    }
    const htmlA = await s.timing('worker_done', e => e.job_id === startA.job_id && e.op === 'html');
    assert.ok(startA.index < bEntered.index && bEntered.index <= bQueued.index && bQueued.index < htmlA.index,
        'second export must enter during the first HTML computation');
    const bSlot = await s.timing('worker_queue', e => e.event_id === 'dual-b');
    assert.ok(bSlot.index > htmlA.index, 'one worker must serialize computations');
    const results = await Promise.all(panels.map(async (p, i) => {
        const eventId = i ? 'dual-b' : 'dual-a', title = i ? 'Second Hero' : 'Bench Hero';
        const done = await s.timing('export_done', e => e.event_id === eventId);
        assert.equal(done.status, 'ok');
        const html = await s.timing('worker_done', e => e.event_id === eventId && e.op === 'html');
        const queue = await s.timing('worker_queue', e => e.event_id === eventId);
        const upload = await s.wait('upload', e => e.peer === p.peer && e.filename?.endsWith('.zip'));
        assert.ok(upload.filename.includes(title), upload.filename);
        assert.ok(s.log.some(e => e.kind === 'attachment_edit' && e.peer === p.peer && e.cmid === p.cmid
            && e.attachments.includes(`doc-99_${upload.file}`)), 'HTML must be attached to its originating chat');
        return { peer: p.peer, queue: queue.queue_ms, html: html.ms, bytes: upload.bytes };
    }));
    for (const r of results) console.log(`  VK ${r.peer}: queue ${r.queue} ms; HTML ${r.html} ms; multipart ${r.bytes} bytes`);
}, true, true, true);
