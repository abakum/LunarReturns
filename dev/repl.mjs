#!/usr/bin/env node
// dev/repl.mjs — консольная отладка tgcloud/handlers/* без облака:
//   node dev/repl.mjs [--chat 1] [--fresh] [--private] [--admin]
// Ввод: текст сообщения (в т.ч. /start, /today), `/N M [uID]` — нажать
// кнопку M ответа N (можно от участника uID), `>N текст` — ответ (reply)
// на сообщение N (бота или своё), `!ged путь` — дроп .ged-файла,
// `!dump` — показать таблицы БД, `\n` — перевод строки.
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
const DB_FILE = process.env.LR_DEV_DB || path.join('dev', 'db.json');
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

// как настоящий клиент: <tg-spoiler>…</tg-spoiler> → plain-текст + entity
// (тексты бота всегда HTML — parse_mode шлётся во всех sendMessage/editText)
function tgRender(text) {
    const entities = [];
    let plain = '';
    let i = 0;
    for (;;) {
        const open = text.indexOf('<tg-spoiler>', i);
        if (open === -1) break;
        const close = text.indexOf('</tg-spoiler>', open);
        if (close === -1) break;
        plain += text.slice(i, open);
        entities.push({ type: 'spoiler', offset: plain.length, length: close - open - '<tg-spoiler>'.length });
        plain += text.slice(open + '<tg-spoiler>'.length, close);
        i = close + '</tg-spoiler>'.length;
    }
    plain += text.slice(i);
    return { text: plain, entities };
}

globalThis.__tgdev = {
    role: ADMIN ? 'administrator' : 'member',
    onApi(method, params) {
        if (method === 'sendMessage') {
            const { text, entities } = tgRender(params.text);
            const n = ++counter;
            const m = { n, text, entities, markup: params.reply_markup,
                updateMsg: { chat: { id: CHAT, type: CHAT_TYPE }, from: { id: 999, is_bot: true } } };
            m.flat = flatButtons(m.markup);
            messages.push(m);
            console.log(`[${m.n}] sendMessage:`);
            String(m.text).split('\n').forEach(l => console.log('    ' + l));
            showButtons(m);
            return { message_id: n, chat: { id: CHAT, type: CHAT_TYPE } }; // как Bot API
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
            const r = tgRender(params.text);
            m.text = r.text;
            m.entities = r.entities;
            m.markup = params.reply_markup;
            m.flat = flatButtons(m.markup);
            console.log(`[${m.n}] текст →`);
            String(m.text).split('\n').forEach(l => console.log('    ' + l));
            if (m.flat.length) { console.log('    клавиатура →'); showButtons(m); }
        } else if (method === 'answerCallbackQuery') {
            const kind = params.show_alert ? 'alert' : 'toast';
            console.log(`    ↳ ${kind}: ${params.text || ''}`);
        } else if (method === 'sendDocument') {
            const n = ++counter;
            const doc = params.document || {};
            const size = doc.bytes ? doc.bytes.length : 0;
            messages.push({ n, text: `[файл ${doc.filename || '?'} (${size} байт)]`, entities: [], markup: null, flat: [],
                updateMsg: { chat: { id: CHAT, type: CHAT_TYPE }, from: { id: 999, is_bot: true } } });
            console.log(`[${n}] sendDocument: ${doc.filename || '?'} (${doc.type || '—'}, ${size} байт)`);
            if (doc.bytes && doc.filename) {
                const p = '/tmp/opencode/' + doc.filename.replace(/[\/\\:*?"<>|#]/g, '_');
                fs.mkdirSync('/tmp/opencode', { recursive: true });
                fs.writeFileSync(p, doc.bytes);
                console.log(`    → ${p}`);
            }
            if (params.caption) console.log('    caption: ' + params.caption);
            return { message_id: n, chat: { id: CHAT, type: CHAT_TYPE } };
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

const press = async (n, m, uid) => {
    const msg = messages.find(x => x.n === n);
    const btn = msg && msg.flat[m - 1];
    if (!btn) { console.log(`ERROR: нет кнопки [${n}.${m}]`); return; }
    const cq = {
        id: String(++updSeq),
        from: { id: uid || 1, first_name: 'dev' },
        data: btn.data,
        message: { chat: { id: CHAT, type: CHAT_TYPE }, message_id: n, text: msg.text, entities: msg.entities || [], reply_markup: msg.markup },
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
console.log('Ввод: текст | /N M [uID] — кнопка (можно от другого участника) | >N текст — ответ на сообщение N (бота или твой) | !ged путь — дроп .ged-файла | !dump — база | Ctrl-C — выход\n');

const handle = async raw => {
    const input = String(raw || '').replace(/\\n/g, '\n').trim();
    if (!input) return;
    if (input === '!dump') { dump(); return; }
    const gm = input.match(/^!ged\s+(\S+)$/);
    if (gm) {
        // дроп .ged-файла: контент регистрируется в моке как file_id
        let content;
        try { content = fs.readFileSync(path.resolve(gm[1]), 'utf8'); }
        catch (e) { console.log('ERROR: ' + e.message); return; }
        const fileName = path.basename(gm[1]);
        const fid = 'dev-' + fileName;
        globalThis.__tgdev.files = globalThis.__tgdev.files || {};
        globalThis.__tgdev.files[fid] = new TextEncoder().encode(content);
        const msg = {
            chat: { id: CHAT, type: CHAT_TYPE },
            from: { id: 1, first_name: 'dev' },
            document: { file_id: fid, file_name: fileName },
        };
        const m = { n: ++counter, text: '📎 ' + fileName, entities: [], markup: undefined, flat: [], user: true,
            updateMsg: { chat: { id: CHAT, type: CHAT_TYPE }, from: { id: 1 } } };
        messages.push(m);
        console.log(`[${m.n}] ты:`);
        console.log('    📎 ' + fileName);
        try { await messageHandler(msg, { update: { update_id: ++updSeq } }); }
        catch (e) { console.log('ERROR:', e.message); }
        return;
    }
    const bm = input.match(/^\/(\d+)\s+(\d+)(?:\s+u(\d+))?$/);
    if (bm) {
        await press(Number(bm[1]), Number(bm[2]), bm[3] ? Number(bm[3]) : 0);
        return;
    }
    const rm = input.match(/^>(\d+)\s+([\s\S]+)$/);
    const reply = rm ? (() => {
        const m = messages.find(x => x.n === Number(rm[1]));
        if (!m) { console.log(`ERROR: нет сообщения ${rm[1]}`); return null; }
        return {
            ...m.updateMsg,        // chat + автор (бот или пользователь)
            message_id: m.n,
            text: m.text,
            entities: m.entities || [],
            reply_markup: m.markup,
        };
    })() : undefined;
    if (rm && !reply) return;
    try {
        const msg = {
            chat: { id: CHAT, type: CHAT_TYPE },
            from: { id: 1, first_name: 'dev' },
            text: rm ? rm[2] : input,
            ...(reply ? { reply_to_message: reply } : {}),
        };
        // сообщение пользователя тоже получает номер [N] (общий счётчик)
        const m = {
            n: ++counter,
            text: msg.text,
            entities: [],
            markup: undefined,
            flat: [],
            user: true,
            updateMsg: { chat: { id: CHAT, type: CHAT_TYPE }, from: { id: 1 } },
        };
        messages.push(m);
        console.log(`[${m.n}] ты:`);
        String(m.text).split('\n').forEach(l => console.log('    ' + l));
        await messageHandler(msg, { update: { update_id: ++updSeq } });
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
