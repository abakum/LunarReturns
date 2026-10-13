#!/usr/bin/env node
// dev/poll.mjs — long-poll драйвер TG-бота на реальном Telegram без облака:
//   node dev/poll.mjs
// Токен как у VK-бота: env TG_TOKEN или корневой .env (TG_TOKEN=…).
// Бот — отдельный тестовый (у основного webhook занят платформой tgcloud,
// getUpdates вместе с webhook Telegram не даёт). Нужен VPN.
// База — dev/db.json (общая с dev/repl.mjs), формат как у VK-бота.
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---- токен: env TG_TOKEN или .env в корне (как lunarreturns.js:798) ----
let token = process.env.TG_TOKEN || '';
if (!token) {
    try {
        const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(/^\s*TG_TOKEN\s*=\s*(\S+)\s*$/m);
        if (m) token = m[1];
    } catch { /* .env не обязателен */ }
}
if (!token) {
    console.error('нет токена: задайте TG_TOKEN (env или .env рядом с репо)');
    process.exit(1);
}
process.env.TG_TOKEN = token; // sdk-mock api уйдёт в реальный режим

// ---- установка мока sdk ДО импорта хендлеров ----
fs.cpSync(path.join(__dirname, 'sdk-mock'), path.join(ROOT, 'node_modules', 'sdk'), { recursive: true });

const API = 'https://api.telegram.org/bot' + token + '/';

async function call(method, params) {
    const res = await globalThis.fetch(API + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
        signal: AbortSignal.timeout(35000),
    });
    const body = await res.json();
    if (!body.ok) throw new Error(method + ' ' + body.error_code + ': ' + body.description);
    return body.result;
}

const messageHandler = (await import(path.join(ROOT, 'tgcloud/handlers/message.js'))).default;
const callbackHandler = (await import(path.join(ROOT, 'tgcloud/handlers/callback_query.js'))).default;

console.log(`tgdev-poll: token ${token.split(':')[0]}:…, база dev/db.json (Ctrl-C — выход)`);

let offset = 0;
for (;;) {
    let updates;
    try {
        updates = await call('getUpdates', {
            offset,
            timeout: 25,
            allowed_updates: ['message', 'callback_query'],
        });
    } catch (e) {
        console.error('getUpdates:', e.message);
        await new Promise(r => setTimeout(r, 3000));
        continue;
    }
    for (const u of updates) {
        offset = u.update_id + 1;
        try {
            if (u.message) {
                await messageHandler(u.message, { update: u });
            } else if (u.callback_query) {
                await callbackHandler(u.callback_query, { update: u });
            }
        } catch (e) {
            console.error('handle:', e.message, (e.stack || '').split('\n')[1] || '');
        }
    }
}
