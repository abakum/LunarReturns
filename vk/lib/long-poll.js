"use strict";

const elapsed = (start, end = performance.now()) => Math.round(end - start);

async function pollStep(state, { init, onUpdate, timing, raw, logUpdates }) {
    const lp = state;
    const u = new URL(lp.server);
    u.searchParams.set("act", "a_check");
    u.searchParams.set("key", lp.key);
    u.searchParams.set("ts", lp.ts);
    u.searchParams.set("wait", "25");
    const pollStarted = timing && performance.now();
    let body;
    try {
        const res = await fetch(u, { signal: AbortSignal.timeout(35000) });
        body = await res.json();
    } catch (e) {
        if (timing) timing('poll_error', { ms: elapsed(pollStarted), error: e.name });
        throw e;
    }
    const received = timing && performance.now();
    const receivedAt = timing && Date.now();
    if (timing && (body.failed || body.updates?.length)) {
        timing('poll', { received_at_ms: receivedAt, ms: elapsed(pollStarted, received),
            ts: body.ts ?? lp.ts, updates: body.updates?.length || 0, failed: body.failed });
    }
    if (raw) console.log("<< poll ts=" + lp.ts, JSON.stringify(body).slice(0, 1000));
    if (logUpdates && body.failed) console.log("poll failed:", JSON.stringify(body));
    if (body.failed) {
        if (body.failed === 1 && body.ts) lp.ts = body.ts;
        else await init(); // 2/3 — смена key/server
        return;
    }
    lp.ts = body.ts;
    const trace = timing && ((upd, o) => {
        const sent = Number(o.date);
        return { received, ts: body.ts, type: upd.type, peer: o.peer_id, cmid: o.conversation_message_id,
            message_id: upd.type === 'message_new' ? o.id : undefined,
            event_id: upd.type === 'message_event' ? o.event_id || o.id : undefined,
            ...(Number.isFinite(sent) && sent > 0 ? { sent_at_ms: sent * 1000, age_ms: receivedAt - sent * 1000 } : {}) };
    });
    for (const upd of body.updates || []) {
        if (logUpdates) console.log("upd:", JSON.stringify(upd).slice(0, 500));
        try {
            onUpdate(upd, trace);
        } catch (e) {
            console.error("handle:", e.message, "\n", (e.stack || "").split("\n").slice(1, 4).join("\n"));
        }
    }
}

module.exports = { pollStep };
