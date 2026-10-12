// Мок sdk для локальной отладки: api пишет в hook (см. dev/repl.mjs),
// db — из ./db.js, fetch/BotApiError/EndpointError — заглушки.
import { db, table, integer, text, boolean, json, index, uniqueIndex, check, sql, eq, and, or, not, ne, gt, gte, lt, lte, asc, desc, inArray } from './db.js';

export { db, table, integer, text, boolean, json, index, uniqueIndex, check, sql, eq, and, or, not, ne, gt, gte, lt, lte, asc, desc, inArray };

export class BotApiError extends Error {}
export class EndpointError extends Error {}
export class InputFile {}

export const fetch = async () => ({ ok: true, status: 200, statusText: 'mock', url: '', json: async () => ({}), text: async () => '' });

const hook = (method, params) => {
    const h = globalThis.__tgdev && globalThis.__tgdev.onApi;
    const r = h ? h(method, params || {}) : undefined;
    return Promise.resolve(r || {});
};

export const api = new Proxy({}, { get: (_t, method) => (params) => hook(method, params) });
