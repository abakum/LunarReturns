#!/usr/bin/env node
// dev/vk-repl.mjs — консольная отладка lunarreturns.js (ВК-бот) без API ВК:
//   node dev/vk-repl.mjs [--fresh] [--chat 2000000001] [--admin] [--user 1001]
//   [--db dev/vk-db.db] [--chat <peerId>] [--user 1001] [--raw]
// Ввод: текст сообщения (триггер/пачка/команды), `/N M [uID]` — нажать кнопку
// M ответа N (можно от участника uID), `>N текст` — ответ (reply) на сообщение
// N (бота или своё), `!ged путь` / `!txt путь [>N]` — дроп документа,
// `!dump` — таблицы базы. Ctrl-C — выход.
//
// Как это устроено: из lunarreturns.js собирается рабочая копия — VK_API
// подменяется на локальный фейковый сервер (ниже), main() отключается,
// внутренние обработчики экспортируются. Сервер ведёт журнал сообщений
// чата (текст + клавиатура), по которому тапы нумеруются как в ТГ-репле,
// и отвечает на getByConversationMessageId из этого журнала (toggle-логика
// бота сравнивает текст сообщения).

import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline/promises';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---- аргументы ----
const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
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

const DB_FILE = process.env.LR_DB || path.join('dev', 'vk-db.db');
const dbAbs = path.isAbsolute(DB_FILE) ? DB_FILE : path.join(ROOT, DB_FILE);
if (fresh) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(dbAbs + s)) fs.unlinkSync(dbAbs + s);
if (fresh) console.log('fresh:', dbAbs);

// ---- рабочая копия lunarreturns.js: VK_API → локальный порт, main() — выключить,
// ---- внутренние обработчики — экспортировать
const SRC = fs.readFileSync(path.join(ROOT, 'lunarreturns.js'), 'utf8');
const PATCHES = [
    ['const VK_API = "https://api.vk.com/method/";',
     'const VK_API = "http://127.0.0.1:" + (globalThis.__VK_REPL_PORT || 8899) + "/method/";'],
    ['main().catch(e => { console.error("fatal:", e); process.exit(1); });',
     'if (!process.env.LR_NO_MAIN) main().catch(e => { console.error("fatal:", e); process.exit(1); });'],
    ['    cutAndGraft, setPersonByXref, editTrigger, rootOf,\n};',
     '    cutAndGraft, setPersonByXref, editTrigger, rootOf, handleEvent, handleMessage, handleGedDrop, handleTxtDrop,\n'
     + '    peerKeyboard, getSettings, qa, isChatAdmin, dailyCheck, mskNowParts,\n};'],
    // подмена «сегодня»: !date YYYY-MM-DD [hh] → globalThis.__LR_TODAY/[__LR_HOUR]
    ['const mskToday = () => {',
     'const mskToday = () => {\n    if (globalThis.__LR_TODAY) return globalThis.__LR_TODAY;'],
    ['function mskNowParts() {\n    const t = new Date(Date.now() + TZ_MS);',
     'function mskNowParts() {\n'
     + '    if (globalThis.__LR_TODAY) {\n'
     + '        const [y, mo, d] = globalThis.__LR_TODAY;\n'
     + '        return { y, mo, d, h: globalThis.__LR_HOUR !== undefined ? globalThis.__LR_HOUR : 9, min: 0 };\n'
     + '    }\n'
     + '    const t = new Date(Date.now() + TZ_MS);'],
    ['    if (!token) {',
     '    if (!token && !process.env.LR_NO_MAIN) {'],
];
function patch(src) {
    for (const [from, to] of PATCHES) if (!src.includes(from)) throw new Error('lunarreturns.js сместился — нет фрагмента: ' + from);
    for (const [from, to] of PATCHES) src = src.replace(from, to);
    return src;
}
const PORT = 8899 + Number(process.env.LR_VKOFF || 0);
globalThis.__VK_REPL_PORT = PORT;
const MOD = path.join(os.tmpdir(), 'lrvk-repl-' + crypto.randomBytes(4).toString('hex') + '.cjs');
fs.writeFileSync(MOD, patch(SRC));
process.env.LR_NO_MAIN = '1'; // main() Not to launch — only in the repl
process.env.LR_DB = process.env.LR_DB || path.resolve(DB_FILE); // изолированная скретч-база (иначе модуль взял бы tmpdir/lunarreturns.db общий для всех прогонов)
const mod = await import(url.pathToFileURL(MOD));
const T = mod.__test;

// ---- фейковый VK API: журнал сообщений чата + кнопки + документы ----
const msgs = [];               // { cmid, fromBot, text, kb } — по порядку появления
let cmid0 = 10;                // conversation_message_id
const cmidByNum = () => msgs.map(m => m.cmid);
const kbButtons = kb => JSON.parse(kb).buttons.flat();
const files = [""];            // маршруты /file/<n> — дропы !ged/!txt
let fileN = 0;
let snackN = 0;
let uploadHits = 0; // LR_UPLOAD_FAIL1: самый первый /upload/ — HTML (проверка ретрая)

const srv = http.createServer((req, res) => {
    // без keep-alive: undici переиспользует сокет после /file/-загрузки,
    // и следующий запрос ловит ECONNRESET (артефакт локального сервера)
    res.setHeader('Connection', 'close');
    const json = j => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
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
        return json({ file: 'xyz' });
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
        const p = Object.fromEntries(new URLSearchParams(body));
        const method = req.url.replace('/method/', '').split('?')[0];
        if (RAW) console.log('>> vk', method, JSON.stringify(p).slice(0, 160));
        try {
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
                const m = { cmid, fromBot: true, text: String(p.message || ''), kb: p.keyboard || null };
                if (p.forward) { try { m.reply = 'д №' + JSON.parse(p.forward).conversation_message_ids[0]; } catch { /* — */ } }
                if (p.reply_to) m.reply = 'д №' + p.reply_to;
                msgs.push(m);
                showBot(m);
                return json({ response: 12345 });
            }
            if (method === 'messages.edit') {
                const cmid = Number(p.conversation_message_id);
                const m = msgs.find(x => x.cmid === cmid);
                if (!m) return json({ response: 1 });
                if (p.attachment) { m.text = (m.text ? m.text + '\n' : '') + '📎 вложение ' + String(p.attachment); showBot(m, true); }
                else if (p.message !== undefined) { m.text = String(p.message); showBot(m, true); }
                if (p.keyboard !== undefined) m.kb = p.keyboard;
                return json({ response: 1 });
            }
            if (method === 'messages.getByConversationMessageId') {
                const cmid = Number(String(p.conversation_message_ids || '').split(',')[0]);
                const m = msgs.find(x => x.cmid === cmid);
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
                return json({ response: { server: `http://127.0.0.1:${PORT}/poll`, key: 'k', ts: '1' } });
            return json({ response: 1 });
        } catch (e) { console.log('vk-sim server error:', e.message); return json({ error: { error_code: 1, error_msg: e.message } }); }
    });
});
await new Promise(r => srv.listen(PORT, r));

// вывод сообщения бота как в ТГ-репле: [N] sendMessage: / [N] текст → + клавиатура
function num(m) { return msgs.indexOf(m) + 1; }
function showBot(m, edited = false) {
    const n = num(m);
    console.log((edited ? '[' + n + '] текст →' : '[' + n + '] sendMessage:' + (m.reply ? ' (в ответ №' + m.reply + ')' : '')));
    console.log('    ' + (m.text || '(пусто)').split('\n').join('\n    '));
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
    msgs.push({ cmid, fromBot: false, text, kb: null });
    try {
        await Promise.race([
            T.handleMessage(CHAT, text, Math.floor(Date.now() / 1000), msgId++, cmid, USER, '', replyMsg),
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
        await Promise.race([
            T.handleEvent({ peer_id: CHAT, user_id: uid || USER, event_id: 'e' + Math.random(),
                conversation_message_id: m.cmid, payload: b.action.payload }),
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
        // как у реального документа ВК: пачка всегда *.ГЕД.txt, гедком *.ГЕД
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
    const replyMsg = replyNum && msgs[replyNum - 1] && !msgs[replyNum - 1].fromBot
        ? { from_id: USER, text: msgs[replyNum - 1].text } : null;
    console.log(`[${msgs.length + 1}] ты: 📎 ${doc.title}`);
    msgs.push({ cmid, fromBot: false, text: '📎 ' + doc.title, kb: null });
    try {
        await Promise.race([
            kind === 'ged'
                ? T.handleGedDrop(CHAT, doc, msgId++, cmid, USER)
                : T.handleTxtDrop(CHAT, doc, msgId++, cmid, USER, replyMsg),
            hang(),
        ]);
    } catch (e) { fail(e); }
}

const hang = () => new Promise((_, rj) => setTimeout(() => rj(new Error('обработчик не завершился за 10с')), 10000));

console.log('vk-repl: chat=' + CHAT + (ADMIN ? ' (админ)' : ' (участник)'), 'user=' + USER, 'db=' + DB_FILE);
console.log('Ввод: текст | /N M [uID] — кнопка | >N текст — ответ | !ged путь | !txt путь [>N] | !dump | !daily | !date ГГГГ-ММ-ДД [hh] | Ctrl-C — выход');

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
    if (line === '!dump') { dump(); return; }
    let m;
    // !date YYYY-MM-DD [hh] — подмена «сегодня» (МСК) для dailyCheck/списков;
    // !date off — вернуть настоящее
    if (m = line.match(/^!date\s+(off|(\d{4})-(\d{2})-(\d{2}))(?:\s+(\d{1,2}))?$/)) {
        if (m[2]) { globalThis.__LR_TODAY = [Number(m[2]), Number(m[3]), Number(m[4])]; if (m[5] !== undefined) globalThis.__LR_HOUR = Number(m[5]); else delete globalThis.__LR_HOUR; console.log('«сегодня» = ' + m[2] + '-' + m[3] + '-' + m[4] + (globalThis.__LR_HOUR !== undefined ? ', час ' + m[5] : '')); }
        else { delete globalThis.__LR_TODAY; delete globalThis.__LR_HOUR; console.log('«сегодня» = настоящее'); }
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
    // /N M [uID] — тап
    if (m = line.match(/^\/(\d+)\s+(\d+)(?:\s+(\d+))?$/)) {
        const msg = msgs[Number(m[1]) - 1];
        if (!msg) { console.log('ERROR: нет сообщения ' + m[1]); return; }
        if (!msg.kb) { console.log('ERROR: у сообщения ' + m[1] + ' нет клавиатуры'); return; }
        await tap(msg, Number(m[2]), m[3] ? Number(m[3]) : undefined);
        return;
    }
    // >N текст — reply
    if (m = line.match(/^>(\d+)\s* ?\n?([\s\S]+)$/)) {
        const msg = msgs[Number(m[1]) - 1];
        if (!msg) { console.log('ERROR: нет сообщения ' + m[1]); return; }
        // цитата бота — from_id < 0 (реплай на бота связей не создаёт)
        const replyMsg = { from_id: msg.fromBot ? -99 : USER, text: msg.text };
        await handleMessageText(m[2], replyMsg);
        return;
    }
    // !ged/!txt путь [>N]
    if (m = line.match(/^!(ged|txt)\s+(\S+)(?:\s*>(\d+))?$/)) {
        await dropFile(m[1], m[2], m[3] && Number(m[3]));
        return;
    }
    // обычное сообщение (накопление «\n»)
    const text = (pending.text + line).trimEnd();
    pending.text = '';
    await handleMessageText(text);
}

if (SCRIPT) {
    for (const line of SCRIPT) await exec(line);
    if (pending.text.trim()) await exec(pending.text);
} else for (;;) {
    const line = await rl.question('> ').catch(() => 'exit');
    if (line === 'exit' || line === null) break;
    await exec(line);
}
rl.close();
srv.close();

function dump() {
    const qa = T.qa;
    const tables = qa("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .map(r => r.name).filter(n => !n.startsWith('sqlite_'));
    for (const t of tables) {
        const rows = qa('SELECT * FROM ' + t);
        console.log(t, '\n    ' + JSON.stringify(rows));
        if (!rows.length) console.log('    (пусто)');
    }
}
