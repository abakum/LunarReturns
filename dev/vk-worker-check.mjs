import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createExportPool } = require('../vk/lib/export-pool.js');
const input = { snapshot: { people: [], families: [], children: [], pairs: [], settings: {} } };
const pool = createExportPool();
try {
    const lease = await pool.open(input);
    const abort = new AbortController();
    const cancelled = assert.rejects(pool.open(input, {}, abort.signal), /cancelled/);
    abort.abort();
    await cancelled;
    const waiting = Array.from({ length: 8 }, () => pool.open(input));
    const completed = waiting.map(async p => {
        const job = await p;
        try { assert.equal(await job.step('flat'), ''); }
        finally { job.release(); }
    });
    await assert.rejects(pool.open(input), /заняты/);
    await assert.rejects(lease.step('not-a-format'), /Unknown VK computation/);
    assert.equal(await lease.step('flat'), '');
    lease.release();
    await Promise.all(completed);
    await assert.rejects(pool.open(input, {}, undefined, 65 * 1024 * 1024), /заняты/);
} finally { pool.close(); }

// The first worker throws before opening a job; queued work must continue on its replacement.
const marker = new SharedArrayBuffer(4);
const crashOnce = 'data:text/javascript,' + encodeURIComponent(`
    import { workerData } from 'node:worker_threads';
    if (Atomics.add(new Int32Array(workerData), 0, 1) === 0) throw new Error('planned worker failure');
`);
const recovery = createExportPool(undefined, { execArgv: ['--import', crashOnce], workerData: marker });
try {
    const failed = assert.rejects(recovery.open(input), /planned worker failure/);
    const next = recovery.open(input);
    await failed;
    const lease = await next;
    assert.equal(await lease.step('flat'), '');
    lease.release();
    assert.equal(new Int32Array(marker)[0], 2);
} finally { recovery.close(); }

const slow = 'data:text/javascript,' + encodeURIComponent(`
    import { parentPort } from 'node:worker_threads';
    parentPort.on('message', ({ op }) => {
        if (op !== 'slow-test') return;
        setTimeout(() => parentPort.postMessage({ progress: { phase: 'annotations', done: 1, total: 1 } }), 250);
        setTimeout(() => parentPort.postMessage({ result: 'finished' }), 500);
    });
    const on = parentPort.on.bind(parentPort);
    parentPort.on = (event, callback) => on(event, event === 'message'
        ? message => { if (message.op !== 'slow-test') callback(message); } : callback);
`);
const warnings = [], progress = [];
const diagnostic = createExportPool((stage, fields) => { if (stage === 'worker_stalled') warnings.push(fields); },
    { execArgv: ['--import', slow] }, 100);
try {
    const lease = await diagnostic.open({ ...input, manualCancel: true }, {}, undefined, 0, p => progress.push(p.done));
    warnings.length = 0;
    assert.equal(await lease.step('slow-test'), 'finished');
    assert.deepEqual(progress, [1]);
    assert.ok(warnings.some(e => e.op === 'slow-test' && e.progress.annotations === 1));
    lease.release();
} finally { diagnostic.close(); }
console.log('VK worker: stalled callback export remains cancellable and can finish');
console.log('VK worker: queue limits, cancellation, partial failure and replacement OK');
