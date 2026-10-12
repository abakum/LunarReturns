#!/usr/bin/env node
// dev/repl.mjs — консольная отладка tgcloud/handlers/* без облака:
//   node dev/repl.mjs [--chat 1] [--fresh] [--private] [--admin]
// Ввод: текст сообщения (в т.ч. /start, /today), `/N M` — нажать
// кнопку M ответа N, `!dump` — показать таблицы БД, `\n` — перевод строки.
// --private — личный чат (полная клавиатура), --admin — админ группы
// (ownerMarkup); по умолчанию — участник группы (bellMarkup).
// Выход — Ctrl-C. Мок sdk: dev/sdk-mock → node_modules/sdk (см. план
// .kilo/plans/20261012-tgdev-repl.md).
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline/promises';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---- аргументы ----
const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
const PRIVATE = argv.includes('--private');
const ADMIN = argv.includes('--admin');
let CHAT = 1;
{
    const i = argv.indexOf('--chat');
    if (i !== -1 && argv[i + 1]) CHAT = Number(argv[i + 1]) || 1;
}
const CHAT_TYPE = PRIVATE ? 'private' : 'group';

// ---- установка мока sdk в node_modules/sdk ----
const MOCK_SRC = path.join(__dirname, 'sdk-mock');
const MOCK_DST = path.join(ROOT, 'node_modules', 'sdk');
fs.cpSync(MOCK_SRC, MOCK_DST, { recursive: true });

// ---- сброс БД по --fresh ----
const DB_FILE = process.env.LR_MOCK_DB || path.join('dev', 'mock-db.json');
const dbAbs = path.isAbsolute(DB_FILE) ? DB_FILE : path.join(ROOT, DB_FILE);
if (fresh && fs.existsSync(dbAbs)) fs.unlinkSync(dbAbs);

// ---- шина api-вызовов мока → консоль ----
let counter = 0;   // номер сообщения [N]
let updSeq = 0;    // update_id
const messages = []; // { n, text, markup, flat }

function flatButtons(markup) {
    const out = [];
    (markup && markup.inline_keyboard || []).forEach(row => row.forEach(b => out.push({ label: b.text, data: b.callback_data })));
    return out;
}

function showButtons(m) {
    if (!m.flat.length) return;
    console.log('    ' + m.flat.map((b, i) => `[${m.n}.${i + 1}] ${b.label}`).join('  '));
}

globalThis.__tgdev = {
    onApi(method, params) {
        if (method === 'sendMessage') {
            const m = { n: ++counter, text: params.text, markup: params.reply_markup };
            m.flat = flatButtons(m.markup);
            messages.push(m);
            console.log(`[${m.n}] sendMessage:`);
            String(m.text).split('\n').forEach(l => console.log('    ' + l));
            showButtons(m);
        } else if (method === 'editMessageReplyMarkup') {
            const m = messages.find(x => x.n === params.message_id);
            if (!m) { console.log(`    editMessageReplyMarkup: нет сообщения ${params.message_id}`); return; }
            m.markup = params.reply_markup;
            m.flat = flatButtons(m.markup);
            if (m.flat.length) {
                console.log(`[${m.n}] клавиатура →`);
                showButtons(m);
            } else {
                console.log(`[${m.n}] клавиатура убрана`);
            }
        } else if (method === 'editMessageText') {
            const m = messages.find(x => x.n === params.message_id);
            if (!m) { console.log(`    editMessageText: нет сообщения ${params.message_id}`); return; }
            m.text = params.text;
            m.markup = params.reply_markup;
            m.flat = flatButtons(m.markup);
            console.log(`[${m.n}] текст →`);
            String(m.text).split('\n').slice(0, 3).forEach(l => console.log('    ' + l));
            if (m.flat.length) { console.log('    клавиатура →'); showButtons(m); }
        } else if (method === 'answerCallbackQuery') {
            const kind = params.show_alert ? 'alert' : 'toast';
            console.log(`    ↳ ${kind}: ${params.text || ''}`);
        } else if (method === 'getChatMember') {
            return { status: ADMIN ? 'administrator' : 'member' };
        } else {
            console.log(`    api.${method}(${JSON.stringify(params).slice(0, 120)})`);
        }
    },
};

// ---- импорт хендлеров (после установки мока!) ----
const messageHandler = (await import(path.join(ROOT, 'tgcloud/handlers/message.js'))).default;
const callbackHandler = (await import(path.join(ROOT, 'tgcloud/handlers/callback_query.js'))).default;

const dump = () => {
    let tables;
    try { tables = JSON.parse(fs.readFileSync(dbAbs, 'utf8')); }
    catch { tables = {}; }
    const names = Object.keys(tables).filter(k => tables[k] && tables[k].length);
    if (!names.length) { console.log('(база пуста)'); return; }
    for (const name of names) {
        console.log(`${name}:`);
        for (const r of tables[name]) console.log('    ' + JSON.stringify(r));
    }
};

const press = async (n, m) => {
    const msg = messages.find(x => x.n === n);
    const btn = msg && msg.flat[m - 1];
    if (!btn) { console.log(`ERROR: нет кнопки [${n}.${m}]`); return; }
    const cq = {
        id: String(++updSeq),
        from: { id: 1, first_name: 'dev' },
        data: btn.data,
        message: { chat: { id: CHAT, type: CHAT_TYPE }, message_id: n, text: msg.text, reply_markup: msg.markup },
    };
    try {
        await callbackHandler(cq, { update: { update_id: counter } });
    } catch (e) {
        console.log('ERROR:', e.message);
    }
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'tg> ' });
rl.on('SIGINT', () => { console.log(); rl.close(); });

const role = PRIVATE ? 'личка' : (ADMIN ? 'админ группы' : 'участник группы');
console.log(`tgdev: chat=${CHAT} (${role}), db=${path.relative(ROOT, dbAbs)}${fresh ? ' (fresh)' : ''}`);
console.log('Ввод: текст | /N M — кнопка | !dump — база | Ctrl-C — выход\n');

const handle = async raw => {
    const input = String(raw || '').replace(/\\n/g, '\n').trim();
    if (!input) return;
    if (input === '!dump') { dump(); return; }
    const bm = input.match(/^\/(\d+)\s+(\d+)$/);
    if (bm) {
        await press(Number(bm[1]), Number(bm[2]));
        return;
    }
    try {
        await messageHandler({ chat: { id: CHAT, type: CHAT_TYPE }, from: { id: 1 }, text: input }, { update: { update_id: ++updSeq } });
    } catch (e) {
        console.log('ERROR:', e.message);
    }
};

if (process.stdin.isTTY) {
    while (true) {
        rl.prompt();
        const it = rl[Symbol.asyncIterator]();
        const { value, done } = await it.next();
        if (done) break;
        await handle(value);
    }
} else {
    for await (const line of rl) await handle(line);
}
