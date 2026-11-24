#!/usr/bin/env node
// dev/vk-repl.mjs — консольная отладка lunarreturns.js (ВК-бот) без API ВК:
//   node dev/vk-repl.mjs [--fresh] [--chat 2000000001] [--admin] [--user 1001]
//   LR_DB sets the scratch DB path; --raw prints mocked VK API calls.
//   --long-poll: real VK bot in a child process; !chat ID switches chat,
//   !post <input> queues text, replies, taps or files without waiting.
// Ввод: текст сообщения (триггер/роспись/команды), `/N M [uID]` — нажать кнопку
// M ответа N (можно от участника uID), `>N текст` — ответ (reply) на сообщение
// N (бота или своё), `!ged путь` / `!txt путь [>N]` — дроп документа,
// `!dump` — таблицы базы. Ctrl-C — выход.
//
// Без --long-poll вызывается тестовый вход реальных обработчиков, без main().
// Оба режима направляют VK API на локальный фейковый сервер (ниже).
// Сервер ведёт журнал сообщений
// чата (текст + клавиатура), по которому тапы нумеруются как в ТГ-репле,
// и отвечает на getByConversationMessageId из этого журнала (toggle-логика
// бота сравнивает текст сообщения).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---- аргументы ----
const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
const LONG_POLL = argv.includes('--long-poll');
const ADMIN = argv.includes('--admin');
let CHAT = 1; // 1 — личный чат; группы — 2000000001+
{
    const i = argv.indexOf('--chat');
    if (i !== -1 && argv[i + 1]) CHAT = Number(argv[i + 1]) || 1;
}
const RAW = argv.includes('--raw');
let USER = 1001;
{
    const i = argv.indexOf('--user');
    if (i !== -1 && argv[i + 1]) USER = Number(argv[i + 1]) || 1001;
}

const DB_FILE = process.env.LR_DB || path.join('dev', LONG_POLL ? 'vk-poll-db.db' : 'vk-db.db');
const dbAbs = path.isAbsolute(DB_FILE) ? DB_FILE : path.join(ROOT, DB_FILE);
if (fresh) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(dbAbs + s)) fs.unlinkSync(dbAbs + s);
if (fresh) console.log('fresh:', dbAbs);

let PORT = 8899 + Number(process.env.LR_VKOFF || 0);
let T;

// ---- фейковый VK API: журнал сообщений чата + кнопки + документы ----
const msgs = [];               // { cmid, fromBot, text, kb } — по порядку появления
let cmid0 = 10;                // conversation_message_id
let mid0 = 1000;               // message_id (peer-local, как_vk отдает messages.send)
const cmidByNum = () => msgs.map(m => m.cmid);
const kbButtons = kb => JSON.parse(kb).buttons.flat();
const files = [""];            // маршруты /file/<n> — дропы !ged/!txt
let fileN = 0;
let snackN = 0;
let uploadHits = 0; // LR_UPLOAD_FAIL1: самый первый /upload/ — HTML (проверка ретрая)
let attachmentEdits = 0;
const trace = entry => {
    if (process.env.LR_VK_TRACE) fs.appendFileSync(process.env.LR_VK_TRACE, JSON.stringify(entry) + '\n');
};
let cursor = 1, pollReply, bot, botClosed, closing = false;
const updates = [], awaiting = new Map(), posted = new Set();
const showTimings = process.env.LOG_VK_TIMINGS === '1';
let post = false;
const flushPoll = () => {
    if (!pollReply || !updates.length) return;
    pollReply({ ts: String(++cursor), updates: updates.splice(0) });
    pollReply = null;
};

const srv = http.createServer((req, res) => {
    // без keep-alive: undici переиспользует сокет после /file/-загрузки,
    // и следующий запрос ловит ECONNRESET (артефакт локального сервера)
    res.setHeader('Connection', 'close');
    const json = j => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (LONG_POLL && req.url.startsWith('/poll?')) {
        const respond = value => { clearTimeout(timer); json(value); };
        const timer = setTimeout(() => {
            if (pollReply === respond) pollReply = null;
            respond({ ts: String(cursor), updates: [] });
        }, 25000);
        res.on('close', () => {
            clearTimeout(timer);
            if (pollReply === respond) pollReply = null;
        });
        pollReply = respond;
        flushPoll();
        return;
    }
    if (req.url.startsWith('/file/')) {
        const i = Number(req.url.slice(6));
        try { const b = fs.readFileSync(files[i]); res.writeHead(200); res.end(b); }
        catch (e) { res.writeHead(404); res.end('нет файла'); }
        return;
    }
    if (req.url.startsWith('/upload/')) {
        uploadHits++;
        const fail1 = process.env.LR_UPLOAD_FAIL1 && uploadHits === 1; // самый первый — HTML 502 (проверка ретрая vkUploadDoc)
        if (fail1) console.log('    (upload #' + uploadHits + ' — HTML 502)');
        if (fail1) {
            res.writeHead(502, { 'Content-Type': 'text/html' });
            return res.end('<!DOCTYPE html><html><body>bad gateway</body></html>');
        }
        let body = '';
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const bytes = Buffer.concat(chunks);
            body = bytes.toString('utf8');
            trace({ method: 'upload', body, base64: bytes.toString('base64') });
            if (process.env.LR_BACKUP_FAIL && body.includes('-old.ged"'))
                return json({ error: 'injected backup upload failure' });
            if (process.env.LR_CSV_FAIL && body.includes('.ged.csv"'))
                return json({ error: 'injected CSV upload failure' });
            if (process.env.LR_TXT_FAIL && body.includes('.ged.txt"'))
                return json({ error: 'injected TXT upload failure' });
            json({ file: 'xyz' });
        });
        return;
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        const p = Object.fromEntries(new URLSearchParams(body));
        const method = req.url.replace('/method/', '').split('?')[0];
        trace({ method, params: p });
        if (RAW) console.log('>> vk', method, JSON.stringify(p).slice(0, 160));
        try {
            if (process.env.LR_BACKUP_FAIL === 'all' && method === 'messages.send'
                && String(p.message).startsWith('🧬 Резерв прежнего дерева'))
                return json({ error: { error_code: 100, error_msg: 'injected backup text failure' } });
            if ((method === 'messages.send' || method === 'messages.edit') && p.keyboard !== undefined) {
                let keyboard;
                try { keyboard = JSON.parse(p.keyboard); } catch { /* rejected below */ }
                if (!keyboard || typeof keyboard !== 'object' || !Array.isArray(keyboard.buttons))
                    return json({ error: { error_code: 100, error_msg: 'keyboard contains incorrect JSON' } });
            }
            if (method === 'messages.sendMessageEventAnswer') {
                let text = '';
                try { text = JSON.parse(p.event_data).text || ''; } catch { /* нет текста */ }
                if (text) console.log('    ↳ toast:', text);
                if (process.env.LR_DEBUG) console.log('        (answerEvent #' + (++snackN) + ')');
                return json({ response: 1 });
            }
            if (method === 'messages.send') {
                // новый ответ бота; reply — если messagesSend с forward/reply_to
                const cmid = ++cmid0;
                const m = { cmid, mid: ++mid0, peer: Number(p.peer_id), fromBot: true, text: String(p.message || ''), kb: p.keyboard || null };
                if (p.forward) { try { m.reply = 'д №' + JSON.parse(p.forward).conversation_message_ids[0]; } catch { /* — */ } }
                if (p.reply_to) m.reply = 'д №' + p.reply_to;
                msgs.push(m);
                showBot(m);
                return json({ response: m.mid });
            }
            if (method === 'messages.edit') {
                if (p.attachment && ++attachmentEdits === 1 && process.env.LR_EDIT_FAIL1)
                    return json({ error: { error_code: 100, error_msg: 'injected edit failure' } });
                const cmid = Number(p.conversation_message_id);
                const mid = Number(p.message_id);
                const m = msgs.find(x => (!LONG_POLL || x.peer === Number(p.peer_id)) && ((cmid && x.cmid === cmid) || (mid && x.mid === mid)));
                if (!m) return json({ response: 1 });
                if (LONG_POLL) {
                    if (p.message !== undefined) m.text = String(p.message);
                    if (p.keyboard !== undefined) m.kb = p.keyboard;
                    if (p.attachment !== undefined) m.attachment = p.attachment;
                    showBot(m, true);
                    return json({ response: 1 });
                }
                if (p.attachment) { m.text = (p.message !== undefined ? String(p.message) + '\n' : '') + '📎 вложение ' + String(p.attachment); showBot(m, true); }
                else if (p.message !== undefined) { m.text = String(p.message); showBot(m, true); }
                if (p.keyboard !== undefined) m.kb = p.keyboard;
                return json({ response: 1 });
            }
            if (method === 'messages.getByConversationMessageId') {
                const cmid = Number(String(p.conversation_message_ids || '').split(',')[0]);
                const m = msgs.find(x => x.cmid === cmid && (!LONG_POLL || x.peer === Number(p.peer_id)));
                // как ВК: старое/не своё сообщение не отдаётся → items пусто → null у бота
                if (!m || !m.fromBot) return json({ response: { items: [] } });
                return json({ response: { items: [{ id: 1, text: m.text }] } });
            }
            if (method === 'messages.getConversationMembers') {
                return json({ response: { items: ADMIN
                    ? [{ member_id: USER, is_admin: true }]
                    : [{ member_id: USER, is_admin: false }] } });
            }
            if (method === 'docs.getMessagesUploadServer')
                return json({ response: { upload_url: `http://127.0.0.1:${PORT}/upload/` } });
            if (method === 'docs.save') return json({ response: { doc: { owner_id: -7, id: 42 } } });
            if (method === 'groups.getLongPollServer')
                return json({ response: { server: `http://127.0.0.1:${PORT}/poll`, key: 'k', ts: String(cursor) } });
            if (LONG_POLL && method === 'groups.getMembers')
                return json({ response: { items: ADMIN ? [{ id: USER, role: 'creator' }] : [] } });
            if (LONG_POLL && method === 'messages.getHistory') return json({ response: { items: [] } });
            return json({ response: 1 });
        } catch (e) { console.log('vk-sim server error:', e.message); return json({ error: { error_code: 1, error_msg: e.message } }); }
    });
});
srv.listen(LONG_POLL ? 0 : PORT, '127.0.0.1');
await once(srv, 'listening');
PORT = srv.address().port;

function enqueue(type, object) {
    if (bot.exitCode !== null || bot.signalCode !== null) throw new Error('VK bot exited');
    const key = updateKey(type, object);
    const done = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { awaiting.delete(key); reject(new Error('Long Poll handler did not finish in 30s')); }, 30000);
        awaiting.set(key, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
    });
    updates.push({ type, group_id: 99, object: type === 'message_new' ? { message: object } : object });
    flushPoll();
    if (post) {
        const background = done.catch(fail).finally(() => posted.delete(background));
        posted.add(background);
        return;
    }
    return done;
}

function updateKey(type, o) {
    return JSON.stringify([type, o.peer_id ?? o.peer, o.event_id ?? o.conversation_message_id ?? o.cmid]);
}

function mockVkFetch(origin) {
    const http = globalThis.fetch;
    globalThis.fetch = (input, options) => {
        let url = new URL(input);
        if (url.origin === 'https://api.vk.com' && url.pathname.startsWith('/method/'))
            url = new URL(url.pathname + url.search, origin);
        if (url.origin !== origin) throw new Error('External network forbidden: ' + url.origin);
        return http(url, { ...options, redirect: 'error' });
    };
}
const origin = `http://127.0.0.1:${PORT}`;
if (LONG_POLL) {
    const preload = 'data:text/javascript,' + encodeURIComponent(`(${mockVkFetch})(${JSON.stringify(origin)});`);
    bot = fork(path.join(ROOT, 'lunarreturns.js'), [], { execArgv: ['--import', preload], silent: true,
        env: { ...process.env, VK_TOKEN: 'repl-token', VK_GROUP_ID: '99', LR_DB: dbAbs, LOG_VK_TIMINGS: '1' } });
    botClosed = new Promise(resolve => bot.once('close', (code, signal) => {
        const error = new Error(`VK bot exited (${code ?? signal})`);
        for (const finish of awaiting.values()) finish(error);
        awaiting.clear();
        if (!closing) { process.exitCode = 1; fail(error); process.stdin.destroy(); }
        resolve();
    }));
    bot.on('error', fail);
    bot.stderr.pipe(process.stderr, { end: false });
    readline.createInterface({ input: bot.stdout }).on('line', line => {
        if (!line.startsWith('vk timing ') || showTimings) console.log(line);
        if (!line.startsWith('vk timing ')) return;
        const e = JSON.parse(line.slice('vk timing '.length));
        if (e.stage !== 'handler_done' || e.source === 'catch_up') return;
        const key = updateKey(e.type, e);
        const finish = awaiting.get(key);
        if (finish) {
            awaiting.delete(key);
            finish(e.status === 'ok' ? null : new Error('VK handler failed'));
        }
    });
} else {
    mockVkFetch(origin);
    process.env.VK_TOKEN = 'repl-token';
    process.env.VK_GROUP_ID = '99';
    process.env.LR_DB = DB_FILE === ':memory:' ? DB_FILE : dbAbs;
    T = (await import('../lunarreturns.js')).default.__test;
}

// вывод сообщения бота как в ТГ-репле: [N] sendMessage: / [N] текст → + клавиатура
function num(m) { return msgs.indexOf(m) + 1; }
function showBot(m, edited = false) {
    const n = num(m);
    console.log((edited ? '[' + n + '] текст →' : '[' + n + '] sendMessage:' + (m.reply ? ' (в ответ №' + m.reply + ')' : ''))
        + (LONG_POLL ? ` (chat ${m.peer})` : ''));
    console.log('    ' + (m.text || '(пусто)').split('\n').join('\n    '));
    if (LONG_POLL && m.attachment) console.log('    📎 вложение ' + m.attachment);
    showKb(m);
}
function showKb(m) {
    if (!m.kb) return;
    try {
        const rows = JSON.parse(m.kb).buttons;
        const flat = [];
        rows.forEach(r => r.forEach(b => {
            flat.push({ label: b.action.label, payload: b.action.payload });
        }));
        console.log('    ' + flat.map((b, i) => `[${num(m)}.${i + 1}] ${b.label}`).join('  '));
    } catch { /* не наша клавиатура */ }
}

// ---- readline-репл ----
const rl = readline.createInterface({ input: process.stdin });
let msgId = 0, myCmid = 0; // свои сообщения: msgId/convMsgId растут независимо
const pending = { text: '' }; // «\n» — продолжение строки, как в ТГ-репле

function fail(e) { console.log('ERROR:', e.message || e); if (process.env.LR_DEBUG) { if (e.stack) console.log(e.stack); if (e.cause) console.log('cause:', e.cause); } }

async function handleMessageText(text, replyMsg = null) {
    const cmid = ++myCmid;
    const n = msgs.length + 1;
    console.log(`[${n}] ты:`);
    console.log('    ' + text.split('\n').join('\n    '));
    // своё сообщение в журнал (для reply-цитат и toggle-сравнений не существенно)
    msgs.push({ cmid, peer: CHAT, fromBot: false, text, kb: null });
    try {
        if (LONG_POLL) return await enqueue('message_new', { peer_id: CHAT, from_id: USER, text,
            date: Math.floor(Date.now() / 1000), id: CHAT >= 2000000000 ? 0 : ++mid0,
            conversation_message_id: cmid, reply_message: replyMsg });
        await Promise.race([
            T.dispatch('message_new', { peer_id: CHAT, text, date: Math.floor(Date.now() / 1000),
                id: msgId++, conversation_message_id: cmid, from_id: USER, reply_message: replyMsg }),
            hang(),
        ]);
    } catch (e) { fail(e); }
}

async function tap(m, btn, uid) {
    const flat = [];
    try { JSON.parse(m.kb).buttons.forEach(r => r.forEach(b => flat.push(b))); } catch { return fail('нет клавиатуры'); }
    const b = flat[btn - 1];
    if (!b) return fail(`нет кнопки [${num(m)}.${btn}]`);
    console.log(`--- тап [${num(m)}.${btn}]`, b.action.label, uid && uid !== USER ? '(u' + uid + ')' : '');
    try {
        const event = { peer_id: CHAT, user_id: uid || USER, event_id: 'e' + Math.random(),
            conversation_message_id: m.cmid, payload: b.action.payload };
        if (LONG_POLL) return await enqueue('message_event', event);
        await Promise.race([
            T.dispatch('message_event', event),
            hang(),
        ]);
        console.log('--- завершено');
    } catch (e) { fail(e); }
}

async function dropFile(kind, file, replyNum) {
    let data;
    try { data = fs.readFileSync(path.resolve(file)); } catch (e) { return fail('файл: ' + e.message); }
    files[fileN] = path.resolve(file);
    const doc = {
        // как у реального документа ВК: роспись всегда *.ГЕД.txt, гедком *.ГЕД
        title: (() => {
            const b = path.basename(files[fileN]);
            return kind === 'ged' ? (b.endsWith('.ged') ? b : b + '.ged')
                : (/\.ged\.txt$/i.test(b) ? b : b + '.ged.txt');
        })(),
        ext: kind === 'ged' ? 'ged' : 'txt',
        url: `http://127.0.0.1:${PORT}/file/${fileN}`,
    };
    fileN++;
    const cmid = ++myCmid;
    const replyMsg = replyNum && msgs[replyNum - 1]
        ? { peer_id: CHAT, from_id: msgs[replyNum - 1].fromBot ? -99 : USER, text: msgs[replyNum - 1].text } : null;
    console.log(`[${msgs.length + 1}] ты: 📎 ${doc.title}`);
    msgs.push({ cmid, peer: CHAT, fromBot: false, text: '📎 ' + doc.title, kb: null });
    try {
        if (LONG_POLL) return await enqueue('message_new', { peer_id: CHAT, from_id: USER, text: '',
            date: Math.floor(Date.now() / 1000), id: CHAT >= 2000000000 ? 0 : ++mid0,
            conversation_message_id: cmid, reply_message: replyMsg, attachments: [{ type: 'doc', doc }] });
        await Promise.race([
            T.dispatch('message_new', { peer_id: CHAT, from_id: USER, id: msgId++,
                conversation_message_id: cmid, reply_message: replyMsg, attachments: [{ type: 'doc', doc }] }),
            hang(),
        ]);
    } catch (e) { fail(e); }
}

const hang = () => new Promise((_, rj) => setTimeout(() => rj(new Error('обработчик не завершился за 10с')), 10000).unref());

console.log('vk-repl: chat=' + CHAT + (ADMIN ? ' (админ)' : ' (участник)'), 'user=' + USER, 'db=' + DB_FILE);
console.log('Ввод: текст | /N M [uID] — кнопка | >N текст — ответ | !ged путь | !txt путь [>N] | !dump | !daily | !date ГГГГ-ММ-ДД [hh] | Ctrl-C — выход');
if (LONG_POLL) console.log('Long Poll: !chat ID | !post <ввод> — без ожидания | !wait N | LOG_VK_TIMINGS=1 — показать тайминги');

// нет TTY — пайп: readline может закрыться до опроса (весь буфер вычитан
// мгновенно) — читаем ввод весь и исполняем построчно
const SCRIPT = !process.stdin.isTTY
    ? fs.readFileSync(0, 'utf8').split('\n').filter(l => l.trim() !== '' || l === '\\n')
    : null;

async function exec(line) {
    if (process.env.LR_DEBUG) console.log('GOT:', JSON.stringify(line));
    if (!line.trim()) return;
    if (line === '\\n') { pending.text += '\n'; return; } // литерал «\n» — перевод строки
    line = String(line).replace(/\\n/g, '\n'); // «\n» внутри строки — тоже перевод
    if (line === '!dump') { try { dump(); } catch (e) { fail(e); } return; }
    let m;
    if (LONG_POLL) {
        if ((m = line.match(/^!chat\s+([1-9]\d*)$/))) {
            CHAT = Number(m[1]);
            console.log('chat=' + CHAT);
            return;
        }
        if (!post && line.startsWith('!post ')) {
            post = true;
            try { await exec(line.slice('!post '.length)); } finally { post = false; }
            return;
        }
        if (/^!(date|daily|sendged)(?:\s|$)/.test(line)) {
            fail('Команда прямой отладки доступна без --long-poll; для экспорта нажмите 🧬.');
            return;
        }
    }
    // !date YYYY-MM-DD [hh] — подмена «сегодня» (МСК) для dailyCheck/списков;
    // !date off — вернуть настоящее
    if (m = line.match(/^!date\s+(off|(\d{4})-(\d{2})-(\d{2}))(?:\s+(\d{1,2}))?$/)) {
        if (m[2]) {
            T.setReplDate([Number(m[2]), Number(m[3]), Number(m[4])], m[5] === undefined ? undefined : Number(m[5]));
            console.log('«сегодня» = ' + m[2] + '-' + m[3] + '-' + m[4] + (m[5] === undefined ? '' : ', час ' + m[5]));
        } else {
            T.setReplDate(null);
            console.log('«сегодня» = настоящее');
        }
        return;
    }
    // !daily — прогнать суточную проверку (годовщины 09:00 + религиозный дайджест)
    if (line === '!daily') {
        try {
            await Promise.race([T.dailyCheck(), hang()]);
            console.log('--- dailyCheck завершён');
        } catch (e) { fail(e); }
        return;
    }
    // !wait N — пауза N мс: досидеть fire-and-forget хвосты (sendGedArtifacts
    // строит файлы асинхронно, пайп-скрипт без паузы закрывает сервер раньше
    // выгрузки — ECONNREFUSED 127.0.0.1:PORT в логе)
    if (m = line.match(/^!wait\s+(\d+)$/)) {
        await new Promise(r => setTimeout(r, Number(m[1])));
        return;
    }
    // !sendged «ключ» N [>N] — sendGedArtifacts радиуса N (как 🧬 на фокусе);
    // с >N — правка сообщения N (как нажатие 🧬 на его кнопках)
    if (m = line.match(/^!sendged (.+) (\d+)(?:\s+>(\d+))?$/)) {
        try {
            const key = m[1];
            const pairs = T.linkPairs(CHAT);
            const spPairs = T.focusSpousePairs(CHAT);
            const keys = T.focusWithSpouses(T.focusKeys(pairs, key, Number(m[2])), spPairs);
            const rec = T.recordOf(CHAT, key);
            const head = T.focusHead(key, Number(m[2]), rec ? rec.dd : null);
            if (!m[3]) await T.messagesSend(CHAT, head);
            const originMsg = m[3] ? msgs[Number(m[3]) - 1] : msgs.at(-1);
            if (!originMsg) throw new Error('нет исходного сообщения');
            const origin = { peer_id: CHAT, conversation_message_id: originMsg.cmid };
            await Promise.race([T.sendGedArtifacts(origin, keys, head, key, T.chatFlatText(CHAT, keys),
                T.getSettings(CHAT), originMsg.kb || undefined), hang()]);
            console.log('--- sendGedArtifacts завершён');
        } catch (e) { fail(e); }
        return;
    }
    // !eyes N [id] — реакция 👀 на сообщение N (детализировать); !eyes N off — снять
    if (m = line.match(/^!eyes (\d+)(?:\s+(off|\d+))?$/)) {
        const msg = msgs[Number(m[1]) - 1];
        if (!msg) { console.log('ERROR: нет сообщения ' + m[1]); return; }
        if (LONG_POLL && msg.peer !== CHAT) return fail('Сообщение в другом чате');
        try {
            if (LONG_POLL) return await enqueue('message_reaction_event', { peer_id: CHAT, cmid: msg.cmid,
                conversation_message_id: msg.cmid, reacted_id: m[2] && m[2] !== 'off' ? Number(m[2]) : USER,
                reaction_id: m[2] === 'off' ? undefined : 32 });
            await Promise.race([T.dispatch('message_reaction_event', { peer_id: CHAT, cmid: msg.cmid,
                reacted_id: m[2] && m[2] !== 'off' ? Number(m[2]) : USER,
                reaction_id: m[2] === 'off' ? undefined : 32 }), hang()]);
        } catch (e) { fail(e); }
        return;
    }
    if (!m) {}
    // /N M [uID] — тап
    if (m = line.match(/^\/(\d+)\s+(\d+)(?:\s+(\d+))?$/)) {
        const msg = msgs[Number(m[1]) - 1];
        if (!msg) { console.log('ERROR: нет сообщения ' + m[1]); return; }
        if (LONG_POLL && msg.peer !== CHAT) return fail('Сообщение в другом чате');
        if (!msg.kb) { console.log('ERROR: у сообщения ' + m[1] + ' нет клавиатуры'); return; }
        await tap(msg, Number(m[2]), m[3] ? Number(m[3]) : undefined);
        return;
    }
    // >N текст — reply
    if (m = line.match(/^>(\d+)\s* ?\n?([\s\S]+)$/)) {
        const msg = msgs[Number(m[1]) - 1];
        if (!msg) { console.log('ERROR: нет сообщения ' + m[1]); return; }
        if (LONG_POLL && msg.peer !== CHAT) return fail('Сообщение в другом чате');
        // цитата бота — from_id < 0 (реплай на бота связей не создаёт)
        const replyMsg = { from_id: msg.fromBot ? -99 : USER, text: msg.text };
        await handleMessageText(m[2], replyMsg);
        return;
    }
    // !ged/!txt путь [>N]
    if (m = line.match(/^!(ged|txt)\s+(\S+)(?:\s*>(\d+))?$/)) {
        if (LONG_POLL && m[3] && msgs[Number(m[3]) - 1]?.peer !== CHAT) return fail('Нет сообщения в этом чате');
        await dropFile(m[1], m[2], m[3] && Number(m[3]));
        return;
    }
    // обычное сообщение (накопление «\n»)
    const text = (pending.text + line).trimEnd();
    pending.text = '';
    await handleMessageText(text);
}

try {
    if (SCRIPT) {
        for (const line of SCRIPT) await exec(line);
        if (pending.text.trim()) await exec(pending.text);
        await Promise.all(posted);
    } else for (;;) {
        const line = await rl.question('> ').catch(() => 'exit');
        if (line === 'exit' || line === null) break;
        await exec(line);
    }
} finally {
    rl.close();
    if (bot) {
        closing = true;
        bot.kill();
        await botClosed;
        srv.close();
        srv.closeAllConnections();
    } else {
        srv.close();
        await T.closeExportPool();
    }
}

function dump() {
    const db = LONG_POLL ? new DatabaseSync(dbAbs, { readOnly: true }) : null;
    try {
        const qa = db ? sql => db.prepare(sql).all() : T.qa;
        const tables = qa("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .map(r => r.name).filter(n => !n.startsWith('sqlite_'));
        for (const t of tables) {
            const rows = qa('SELECT * FROM "' + t.replaceAll('"', '""') + '"');
            console.log(t, '\n    ' + JSON.stringify(rows));
            if (!rows.length) console.log('    (пусто)');
        }
    } finally {
        db?.close();
    }
}
