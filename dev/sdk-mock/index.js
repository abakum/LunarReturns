// Мок sdk для локальной отладки.
// TG_TOKEN не задан (REPL): api пишет в hook globalThis.__tgdev.onApi.
// TG_TOKEN задан (dev/poll.mjs): реальные вызовы Bot API через fetch,
// результат развёрнут, ошибка — BotApiError (как на платформе).
import { db, table, integer, text, boolean, json, index, uniqueIndex, check, sql, eq, and, or, not, ne, gt, gte, lt, lte, asc, desc, inArray } from './db.js';

export { db, table, integer, text, boolean, json, index, uniqueIndex, check, sql, eq, and, or, not, ne, gt, gte, lt, lte, asc, desc, inArray };

export class BotApiError extends Error {
    constructor(description, code) {
        super(description);
        this.name = 'BotApiError';
        this.description = description;
        this.code = code;
    }
}
export class EndpointError extends Error {}
export class InputFile {}

export const fetch = async () => ({ ok: true, status: 200, statusText: 'mock', url: '', json: async () => ({}), text: async () => '' });

async function realCall(method, params) {
    const token = process.env.TG_TOKEN;
    const res = await globalThis.fetch('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
        signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new BotApiError('HTTP ' + res.status, res.status);
    const body = await res.json();
    if (!body.ok) throw new BotApiError(body.description, body.error_code);
    return body.result;
}

const hook = (method, params) => {
    const h = globalThis.__tgdev && globalThis.__tgdev.onApi;
    if (h) h(method, params || {});
    return Promise.resolve({});
};

export const api = new Proxy({}, {
    get: (_t, method) => (params) => {
        if (process.env.TG_TOKEN) return realCall(method, params);
        if (method === 'getChatMember') {
            const role = globalThis.__tgdev && globalThis.__tgdev.role;
            return Promise.resolve({ status: role === 'administrator' ? 'administrator' : 'member', user: { id: params && params.user_id } });
        }
        return hook(method, params);
    },
});
