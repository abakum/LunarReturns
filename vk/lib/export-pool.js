'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');

function createExportPool(timing, testOptions, idleMs = 90000) {
    const queue = [];
    const maxBytes = 64 * 1024 * 1024;
    let worker, active, pending, serial = 0, bytes = 0, closed = false, retiring = false;

    function retire(error) {
        const old = worker;
        worker = undefined;
        if (old) {
            retiring = true;
            const resume = () => { retiring = false; pump(); };
            void old.terminate().then(resume, resume);
        }
        if (pending) pending.reject(error);
        if (active) active.release();
    }

    function ensureWorker() {
        if (worker) return;
        const current = new Worker(path.join(__dirname, 'export-worker.js'), { env: { TZ: process.env.TZ }, execArgv: [], ...testOptions });
        current.unref();
        worker = current;
        current.on('message', msg => {
            if (worker !== current || !pending) return;
            if (msg.start) {
                timing?.('worker_start', { ...active.trace, op: pending.op });
                return;
            }
            if (msg.progress) {
                const { phase, done } = msg.progress;
                if (done <= (pending.progress.get(phase) ?? 0)) return;
                pending.progress.set(phase, done);
                pending.refresh();
                active.onProgress?.(msg.progress);
                return;
            }
            if (msg.ms !== undefined) timing?.('worker_done', { ...active.trace, op: pending.op, ms: msg.ms,
                status: msg.error !== undefined ? 'error' : 'ok' });
            if (active.signal?.aborted) {
                pending.reject(new Error('VK job cancelled'));
                active.release();
            } else if (msg.error !== undefined) pending.reject(new Error(msg.error));
            else pending.resolve(msg.result);
        });
        current.on('error', e => { if (worker === current) retire(e); });
        current.on('exit', code => { if (worker === current) retire(new Error('VK worker exited: ' + code)); });
    }

    function pump() {
        if (closed || retiring || active || !queue.length) return;
        const next = queue.shift();
        active = next;
        try { ensureWorker(); }
        catch (e) { next.reject(e); next.release(); return; }
        worker.ref();
        const step = (op, input) => new Promise((resolve, reject) => {
            if (active !== next || next.signal?.aborted || pending) return reject(new Error('VK job unavailable'));
            let timer;
            const refresh = () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    if (!next.manualCancel) return retire(new Error('VK worker timed out'));
                    const fields = { ...next.trace, op, progress: Object.fromEntries(pending.progress) };
                    if (timing) timing('worker_stalled', fields);
                    else console.warn(`VK worker: no progress for ${idleMs}ms`, JSON.stringify(fields));
                }, idleMs);
            };
            const settle = fn => value => { clearTimeout(timer); pending = undefined; fn(value); };
            pending = { op, progress: new Map(), refresh, resolve: settle(resolve), reject: settle(reject) };
            refresh();
            try { worker.postMessage({ op, input }); }
            catch (e) { pending.reject(e); }
        });
        timing?.('worker_queue', { ...next.trace, queue_ms: Math.round(performance.now() - next.queued) });
        const transferStarted = performance.now();
        step('open', next.input).then(() => {
            next.input = null;
            timing?.('worker_open', { ...next.trace, ms: Math.round(performance.now() - transferStarted) });
            next.resolve({ step, release: next.release });
        }, e => { next.reject(e); next.release(); });
    }

    return {
        open(input, trace = {}, signal, size = 0, onProgress) {
            if (signal?.aborted || closed) return Promise.reject(new Error('VK job cancelled'));
            if (queue.length >= 8 || bytes + size > maxBytes) return Promise.reject(new Error('Вычисления заняты, повторите позже.'));
            return new Promise((resolve, reject) => {
                let released = false;
                bytes += size;
                const job = { input, manualCancel: input.manualCancel, onProgress, trace: { ...trace, job_id: ++serial }, queued: performance.now(), signal, resolve, reject,
                    release() {
                        if (released) return;
                        released = true;
                        signal?.removeEventListener('abort', abort);
                        bytes -= size;
                        if (active === job) {
                            active = undefined;
                            worker?.postMessage({ op: 'clear' });
                            worker?.unref();
                        } else {
                            const index = queue.indexOf(job);
                            if (index >= 0) queue.splice(index, 1);
                        }
                        pump();
                    } };
                const abort = () => {
                    if (active === job && pending) return retire(new Error('VK job cancelled'));
                    reject(new Error('VK job cancelled'));
                    job.release();
                };
                signal?.addEventListener('abort', abort, { once: true });
                queue.push(job);
                pump();
            });
        },
        close() {
            closed = true;
            const error = new Error('VK worker pool closed');
            for (const job of [...queue]) { job.reject(error); job.release(); }
            retire(error);
        },
    };
}

module.exports = { createExportPool };
