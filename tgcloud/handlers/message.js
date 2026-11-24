import { api, db, InputFile } from 'sdk';
import { eq } from 'sdk/db';
import { gedDrops, focusView } from '../schema.js';
import { parseTrigger, decodeGedcom, parseGedcom, gedStats, parseTree } from '../lib/parse.cjs';
import { fileBaseOf } from '../lib/chart.cjs';
import { parseSearchQuery } from '../lib/flat.cjs';
import { jubileeText } from '../lib/text.js';
import { normalizeFocusRadius, focusListMessage, focusSearch, searchChain, searchRadius, searchProgressHead, prepareReplySearch } from '../lib/tree.cjs';
import { REPLY_TARGET_ERROR, resolveReplyRecord, TREE_EXPORT_COMMAND, exportReplyRadius,
    CHAT_SWITCH_COMMAND, CHAT_SWITCH_REPLY_ERROR, chatSwitchText } from '../lib/text.cjs';
import {
    helpText, startMarkup, chatAdmin, getSettings, patchSetting, todayText, jubileeMarkup, sendLong,
    recordOf, recordShownOf, recordByXref, replaceWithGedcom,
    linkPairs, personRows, weddingRows, sendGedcom, sendViewer, sendPdf, focusHead, focusMarkup,
    focusListKeys, focusSpousePairs, focusDepth, focusListText, mmddToday, upcomingText, upsertPerson, applyTree, cutAndGraft, treeReport,
    editTrigger, hasTree, NOT_FOR_GRAFT,
    chatFlatText, flatSearch, sendFlatPack, flatHitKey, searchHead, cutLines,
} from '../lib/bot.js';

async function resolveReply(chatId, reply) {
    if (!reply || reply.chat?.id !== chatId || !Number.isInteger(reply.from?.id)
        || reply.from.id <= 0 || reply.sender_chat) return null;
    const bot = !!reply.from?.is_bot;
    let context = null;
    if (bot) {
        let me;
        try { me = await api.getMe({}); } catch { return null; }
        if (reply.from.id !== me.id) return null;
        const contexts = (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all())
            .filter(r => r.messageId === reply.message_id);
        if (contexts.length > 1) return null;
        context = contexts[0] || null;
    }
    const rec = resolveReplyRecord([...await personRows(chatId), ...await weddingRows(chatId)], reply.text, bot, context);
    if (!rec) return null;
    const ids = new Set((reply.reply_markup?.inline_keyboard || []).flat()
        .map(b => b.callback_data?.match(/^(?:det|mon|del1):(.+)$/)?.[1]).filter(Boolean));
    for (const id of ids) {
        const identified = await recordByXref(chatId, id);
        if (!identified || identified.n !== rec.n || identified.d !== rec.d) return null;
    }
    return rec;
}

// сжатый юбилей + единая клавиатура (jubileeMarkup): цифры радиуса, 👎,
// 👀/🌙, 🔔/🧬/-+=/❌; фок-кнопки работают через строку focus_view —
// вставляем её по message_id отправленного сообщения (радиус 1);
// replyTo — реплай на запрос поиска (как фокус-панель раньше)
const sendJubilee = async (chatId, rec, note = "", replyTo = 0) => {
    const key = rec.n + " " + rec.d;
    const depth = Math.max(1, await focusDepth(await linkPairs(chatId), await focusSpousePairs(chatId), key));
    // xref персоны, у свадьбы — fx fam-пары (recordByXref резолвит оба);
    // свадьба — сокращённый ряд [👀|🌙 👎 ❌]
    const xref = rec.xref ?? rec.fx ?? null;
    if (!xref) throw new Error("нет xref у записи");
    const sent = await sendLong(chatId, jubileeText(rec, note),
        jubileeMarkup(xref, depth, false, rec.n.includes("+")), undefined, replyTo);
    if (sent && sent.message_id) {
        // чистка устаревших строк чата (старше 7 суток) + запись текущей
        const weekAgo = Date.now() - 7 * 24 * 3600000;
        const stale = (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all())
            .filter(r => r.ts < weekAgo);
        for (const r of stale) await db.delete(focusView).where(eq(focusView.id, r.id)).run();
        await db.insert(focusView).values({
            chatId, messageId: sent.message_id, pkey: key, radius: 1, ts: Date.now(),
        }).run();
    }
    return sent;
};

// «Да» автоматически резервирует прежнее дерево перед заменой.
const dropKb = () => ({
    inline_keyboard: [[
        { text: "Нет", callback_data: "ged:ign" },
        { text: "Да", callback_data: "ged:rep" },
    ]]
});

// дроп .ged-документа: скачать, разобрать, запомнить в ged_drops (последний
// дроп выигрывает); «Да» — ЗАМЕНА дерева (сначала прежнее дерево файлом
// <имя>-old.ged перед очисткой)

// скачать текст документа-дропа с ретраями: файл отдаётся не сразу
// (ВК: HTTP 502 от CDN) — после дропа ждём 3 с, попытка; провал — ещё 3 с и
// попытка, ещё 3 с и последняя (ВК-копия: lunarreturns.js, fetchDocText)
async function downloadDoc(doc, ged = false) {
    for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const bytes = await api.getFileContent(doc.file_id);
            return ged ? decodeGedcom(bytes) : new TextDecoder().decode(bytes);
        } catch (e) {
            if (i === 2) throw e;
            console.warn("doc download retry", (i + 1) + "/3:", e.message);
        }
    }
}

async function gedDrop(chatId, doc, fromId) {
    const name = doc.file_name || "gedcom.ged";
    let content;
    try {
        content = await downloadDoc(doc, true);
    } catch (e) {
        console.error("ged download:", e.message);
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось скачать файл " + name + " (трижды; повторите отправку файла в чат)" });
        return;
    }
    const g = parseGedcom(content);
    if (!g) {
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось разобрать GEDCOM-файл " + name });
        return;
    }
    const s = gedStats(g);
    const vals = { fromId: fromId || 0, fileName: name, content, ts: Date.now() };
    const old = await db.select().from(gedDrops).where(eq(gedDrops.chatId, chatId)).get();
    if (old) await db.update(gedDrops).set(vals).where(eq(gedDrops.chatId, chatId)).run();
    else await db.insert(gedDrops).values({ chatId, ...vals }).run();
    await api.sendMessage({
        chat_id: chatId,
        text: "🧬 Файл " + name + ": персон " + s.persons + ", семей " + s.fams
            + ", детей " + s.links + ". Заменить события чата деревом?",
        reply_markup: dropKb(),
    });
    console.log("ged drop:", name, "chat", chatId);
}

// дроп .txt-документа с родословной росписью -+= (см. txtDrop ниже в коде)
async function txtDrop(chatId, doc, fromId, replyTo) {
    const resolved = await resolveReply(chatId, replyTo);
    if (replyTo && !resolved) {
        await api.sendMessage({ chat_id: chatId, text: REPLY_TARGET_ERROR });
        return;
    }
    const name = doc.file_name || "пачка.ged.txt";
    let content;
    try {
        content = await downloadDoc(doc);
    } catch (e) {
        console.error("txt download:", e.message);
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось скачать файл " + name + " (трижды; повторите отправку файла в чат)" });
        return;
    }
    const tree = parseTree(content);
    if (replyTo && (await resolveReply(chatId, replyTo))?.xref !== resolved?.xref) {
        await api.sendMessage({ chat_id: chatId, text: REPLY_TARGET_ERROR });
        return;
    }
    if (!tree.persons.length && !tree.errors.length) {
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось разобрать файл " + name + " (ждём пачку «плоское древо»)" });
        return;
    }
    // в ответе на триггер (сообщение пользователя) — ветвь цитируемого:
    // срезана, роспись привита
    if (resolved) {
        let anchor = null;
        const sh = resolved;
        if (sh) anchor = sh.n + " " + sh.d;
        if (!anchor) {
            // цитата на триггера не нашлась — добавлять молча нельзя: так
            // роспись применилась бы целиком (мимо героя)
            await api.sendMessage({ chat_id: chatId, text: "💥 В ответе — не триггер: пачка не применена. Герой ветви должен быть «Имя ГГГГ-ММ-ДД» из древа чата." });
            console.log("txt drop reply: триггера нет, мимо, чат", chatId);
            return;
        }
        const rep = await cutAndGraft(chatId, anchor, tree, (await getSettings(chatId)).trim);
        await sendLong(chatId, treeReport(rep));
        console.log("txt tree:", rep.cut !== undefined ? "срезано " + rep.cut + ", " : "", rep.persons, "персон,", rep.links, "детей, чат", chatId);
        return;
    }
    const vals = { fromId: fromId || 0, fileName: name, content, ts: Date.now() };
    const old = await db.select().from(gedDrops).where(eq(gedDrops.chatId, chatId)).get();
    if (old) await db.update(gedDrops).set(vals).where(eq(gedDrops.chatId, chatId)).run();
    else await db.insert(gedDrops).values({ chatId, ...vals }).run();
    await api.sendMessage({
        chat_id: chatId,
        text: "📄 Файл " + name + ": персон " + new Set(tree.persons
            .map(p => p.rec.n + "|" + (p.rec.d ?? ""))).size
            + ", семей " + tree.weddings.length + ", детей " + tree.children.length
            + ". Заменить этим древо чата? В ответ на триггер — без замены: будет срезана и привита ветвь триггера.",
        reply_markup: dropKb(),
    });
    console.log("txt drop:", name, "chat", chatId);
}

// фокус-сообщение: «/» ответом на триггер, радиус 1 сразу; ключ персоны —
// в focus_view по id сообщения с кнопками (callback_data короткий);
// само сообщение — реплаем на «/» (как в VK sendFocus); body — готовое тело
// (список 🔔, единственное попадание поиска) — сразу с панелью, не после тапа;
// ng — вести тело с меткой «не для прививки» (перед головой: реплай на такое
// сообщение прививкой не идёт); xref — для единых кнопок 👎/👀 (focusMarkup)
async function sendFocus(chat, chatId, key, radius, dd, replyTo = 0, body = "", ng = false, xref = null) {
    // тело (список/гедком) — после тапа по кнопке; цифры радиуса — по глубине предков
    const head = focusHead(key, radius, dd);
    const first = await api.sendMessage({
        chat_id: chatId,
        // перелив с героем: порядок строк — герой, метка, тело
        // (правило — коммент у NOT_FOR_GRAFT в lib/bot.js)
        text: head + "\n⏳",
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
    try {
    const markup = focusMarkup(chat, chatId, await getSettings(chatId), radius,
        focusDepth(await linkPairs(chatId), await focusSpousePairs(chatId), key), xref);
    if (first && first.message_id) {
        // чистка устаревших строк чата (старше 7 суток) + запись текущей
        const weekAgo = Date.now() - 7 * 24 * 3600000;
        const stale = (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all())
            .filter(r => r.ts < weekAgo);
        for (const r of stale) await db.delete(focusView).where(eq(focusView.id, r.id)).run();
        await db.insert(focusView).values({
            chatId, messageId: first.message_id, pkey: key, radius, ts: Date.now(),
        }).run();
    }
    await api.editMessageText({ chat_id: chatId, message_id: first.message_id,
        text: head + (ng ? "\n" + NOT_FOR_GRAFT : "") + (body ? "\n" + body : ""), reply_markup: markup });
    } catch (e) {
        console.error("focus panel:", e);
        await api.editMessageText({ chat_id: chatId, message_id: first.message_id,
            text: head + "\n💥 Не удалось подготовить кнопки: " + e.message });
    }
    console.log("focus:", key, "chat", chatId);
    return first;
}

// прицеп .txt/.ged.txt ответом на сообщение с ⏳ (панель, поиск): документ +
// правка текста (⏳ снят); провал — правка «…✂️💥 err» (часы сняты)
// (правило метки NOT_FOR_GRAFT — коммент у константы в lib/bot.js)
async function holdReply(chatId, first, holdTxt, finalTxt, content, name) {
    try {
        await api.sendDocument({
            chat_id: chatId,
            document: new InputFile(
                new TextEncoder().encode("\uFEFF" + content), name, { type: "text/plain" }),
            ...(first && first.message_id
                ? { reply_parameters: { message_id: first.message_id,
                    allow_sending_without_reply: true } } : {}),
        });
        if (first && first.message_id)
            await api.editMessageText({ chat_id: chatId,
                message_id: first.message_id, text: finalTxt });
    } catch (e) {
        console.error("hold document:", e.message);
        if (first && first.message_id)
            await api.editMessageText({ chat_id: chatId,
                message_id: first.message_id,
                text: holdTxt.replace("\n✂️⏳", "\n✂️💥 " + e.message) }).catch(() => {});
    }
}

export default async function (message, ctx) {
    const chatId = message.chat.id;
    const text = (message.text || "").trim();

    // дроп .ged-документа → вопрос «Нет / Да / Да, с резервом» (до разбора
    // команд/триггеров; сообщение может быть без текста, caption не разбираем)
    if (message.document && /\.ged$/i.test(message.document.file_name || "")) {
        await gedDrop(chatId, message.document, message.from?.id);
        return;
    }
    // .ged.txt-документ (тексты бота) = родословная роспись -+=: в ответе на
    // триггер — сразу применяем (ветвь цитируемого срезана, роспись привита);
    // просто дроп — те же 3 кнопки «Да/Нет/Да, с резервом», что у .ged
    if (message.document && /\.ged\.txt$/i.test(message.document.file_name || "")) {
        await txtDrop(chatId, message.document, message.from?.id, message.reply_to_message);
        return;
    }

    if (!text) return;

    // в группах команда приходит с упоминанием бота: /start@botname
    const start = /^\/start(?:@[a-z0-9_]+)?$/i.test(text);

    const tm = text.match(/^\/trim([01])(?:@[a-z0-9_]+)?$/i);
    if (tm) {
        const trim = tm[1] === "1";
        await patchSetting(chatId, 'trim', trim);
        await api.sendMessage({ chat_id: chatId,
            text: "Импорт: " + (trim ? "инициалы, без мест и примечаний." : "полные данные.") });
        return;
    }
    const fm = text.match(/^\/fynny([01])(?:@[a-z0-9_]+)?$/i);
    if (fm) {
        const fynny = fm[1] === "1";
        await patchSetting(chatId, 'fynny', fynny);
        await api.sendMessage({ chat_id: chatId,
            text: fynny ? "Родство: цепочки." : "Родство: обычные названия." });
        return;
    }

    const chatSwitch = CHAT_SWITCH_COMMAND.exec(text);
    if (chatSwitch) {
        const key = chatSwitch[1].toLowerCase(), enabled = chatSwitch[2] === '1';
        if (!message.reply_to_message) {
            await patchSetting(chatId, key, enabled);
            await api.sendMessage({ chat_id: chatId, text: chatSwitchText(key, enabled) });
            return;
        }
        if (!enabled) {
            await api.sendMessage({ chat_id: chatId, text: CHAT_SWITCH_REPLY_ERROR });
            return;
        }
    }

    const exportCommand = TREE_EXPORT_COMMAND.exec(text);
    const scopedCommand = start || text === "/" || exportCommand
        || /^\/(?:bell[1-5]?|links)(?:@\S+)?$/i.test(text)
        || text.toLowerCase() === "связи";
    const searchInput = /^\//.test(text.split(/\r?\n/).find(l => l.trim() && !l.trimStart().startsWith('#')) || "");
    const anchorInput = !searchInput && (text.split(/\r?\n/).some(l => /^\s*[-+=]/.test(l))
        || (text.split(/\r?\n/).length === 1 && parseTrigger(text)));
    let resolved = null;
    if (message.reply_to_message && (scopedCommand || anchorInput) && !parseGedcom(text)) {
        resolved = await resolveReply(chatId, message.reply_to_message);
        if (!resolved) {
            await api.sendMessage({ chat_id: chatId, text: REPLY_TARGET_ERROR });
            return;
        }
    }

    if (start || text === "/") {
        // «/» ответом на триггер — фокус-сообщение с радиусом родни
        if (resolved) {
            const rec = resolved;
            if (rec) {
                // показанный ключ → хранимый
                await sendFocus(message.chat, chatId, rec.n + " " + rec.d, 1, rec.dd, message.message_id,
                    "", false, rec.xref ?? rec.fx ?? null);
                return;
            }
        }
        const admin = await chatAdmin(message.chat, message.from?.id);
        await api.sendMessage({
            chat_id: chatId, text: helpText(await getSettings(chatId)),
            reply_markup: startMarkup(message.chat, admin, chatId, await getSettings(chatId)),
        });
        return;
    }

    // /today и /today@имя_бота (пишут и планировщики вроде Crondule)
    if (/^\/today(?:@[a-z0-9_]+)?$/i.test(text)) {
        const body = await todayText(chatId);
        // как в VK: нечего показать — молчание (тело содержит jubileeText,
        // HTML со спойлерами; дайджест — простой текст)
        if (body) await api.sendMessage({ chat_id: chatId, text: body, parse_mode: 'HTML' });
        return;
    }

    // /bellN (в ответ на триггер): список родни в радиусе N — как тап 🔔 на
    // фокусе; без reply — весь список чата (как 🔔 чата), не влезает —
    // отрезаем (целые строки)
    const bm = text.match(/^\/bell([1-5])?(?:@\S+)?$/i);
    if (bm) {
        const hold = await api.sendMessage({ chat_id: chatId, text: "🔔⏳",
            reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
        const finish = text => api.editMessageText({ chat_id: chatId, message_id: hold.message_id, text });
        try {
        const radius = Number(bm[1]) || 1;
        if (resolved) {
            const rec = resolved;
            if (rec) {
                const skey = rec.n + " " + rec.d; // показанный ключ → хранимый
                // как тап: радиус не глубже имеющихся связей
                const pairs = await linkPairs(chatId);
                const r = normalizeFocusRadius(radius, focusDepth(pairs, await focusSpousePairs(chatId), skey));
                const sexMap = new Map((await personRows(chatId))
                    .map(rw => [rw.n + " " + rw.d, rw.sex ?? null]));
                const spPairs = await focusSpousePairs(chatId);
                // уровневый радиус («жизненный»: кровь 1, брак 1, полнокровный
                // сиблинг 1); супруги — по лимиту слов ярлыка (fynny)
                const keys = focusListKeys(pairs, spPairs, skey, r,
                    k => sexMap.get(k) ?? null, true);
                const items = [...await personRows(chatId), ...await weddingRows(chatId)];
                const body = focusListText(items, keys, skey, pairs,
                    spPairs, k => sexMap.get(k) ?? null, false, mmddToday(), r, (await getSettings(chatId)).fynny)
                    || "(в радиусе нет событий)";
                await finish(focusListMessage(focusHead(skey, r, rec.dd), body));
                console.log("bell text:", skey, "радиус", r, "chat", chatId);
                return;
            }
        }
        // как у 🔔 чата: список «от сегодня» одним сообщением — что не
        // влезает, отрезаем (целые строки)
        const list = await upcomingText(chatId, false, mmddToday());
        const shownList = cutLines(list || "", 4000);
        await finish(shownList || "Событий нет");
        console.log("bell chat:", (list ? list.split("\n").length : 0) + "->" + shownList.split("\n").length, "строк, chat", chatId);
        return;
        } catch (e) {
            console.error("bell text:", e.message);
            await finish("Не удалось подготовить список. Попробуйте ещё раз.");
            return;
        }
    }

    if (exportCommand) {
        const format = exportCommand[1].toLowerCase();
        const hold = await api.sendMessage({ chat_id: chatId, text: (format === 'pdf' ? '🖨️' : format === 'epub' || format === 'html' ? '📖' : '🧬') + '⏳',
            reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
        try {
        const reply = message.reply_to_message;
        const radius = exportReplyRadius(exportCommand[2], reply?.from?.is_bot ? reply.text : null);
        if (resolved) {
            const rows = await personRows(chatId);
            const skey = resolved.n + ' ' + resolved.d;
            const hero = rows.find(r => r.n + ' ' + r.d === skey);
            if (!hero && format !== 'gedcom') {
                await api.sendMessage({ chat_id: chatId, text: REPLY_TARGET_ERROR });
                return;
            }
            const pairs = await linkPairs(chatId), spouses = await focusSpousePairs(chatId);
            const r = normalizeFocusRadius(radius, focusDepth(pairs, spouses, skey));
            const head = focusHead(skey, r, resolved.dd);
            if (format === 'pdf') {
                await sendPdf(chatId, head, skey, r, message.message_id);
                return;
            }
            const sex = new Map(rows.map(p => [p.n + ' ' + p.d, p.sex ?? null]));
            const keys = focusListKeys(pairs, spouses, skey, r, k => sex.get(k) ?? null);
            if (format === 'epub' || format === 'html') {
                await sendViewer(format, chatId, keys, head, skey, hero.xref, message.message_id);
                return;
            }
            await sendGedcom(chatId, keys, head, message.message_id);
            console.log("focus text:", skey, "радиус", r, "chat", chatId);
            return;
        }
        if (!(await hasTree(chatId))) {
            await api.sendMessage({ chat_id: chatId, text: "связей пока нет" });
            return;
        }
        if (format === 'epub' || format === 'html') {
            await sendViewer(format, chatId, undefined, 'Древо чата', null, null, message.message_id);
            return;
        }
        if (format === 'pdf') {
            await sendPdf(chatId, 'Древо чата', null, null, message.message_id);
            return;
        }
        await sendGedcom(chatId, undefined, "Древо чата", message.message_id);
        return;
        } catch (e) {
            console.error('tree export:', e.message);
            await api.sendMessage({ chat_id: chatId, text: 'Не удалось подготовить файл.' });
            return;
        } finally {
            await api.deleteMessage({ chat_id: chatId, message_id: hold.message_id }).catch(() =>
                api.editMessageText({ chat_id: chatId, message_id: hold.message_id, text: 'Экспорт завершён.' }).catch(() => {}));
        }
    }

    // «/links» / «связи» (как в VK): роспись ВЕТВИ героя — как «-+=» на фокусе
    // (>4000 — файлом .ged.txt); без reply — роспись древа
    // чата. Листинг сообщений-связей не восстановлен (листинг был одноразовым)
    if (/^\/links(?:@\S+)?$/i.test(text) || text.toLowerCase() === "связи") {
        const replyTo = { message_id: message.message_id, allow_sending_without_reply: true };
        let key = null, head = "";
        if (resolved) {
            const rec = resolved;
            if (rec) { key = rec.n + " " + rec.d; head = focusHead(key, 1, rec.dd); } // показанный ключ → хранимый
        }
        const ok = await sendFlatPack(chatId, key, head, message.message_id);
        if (!ok) await api.sendMessage({ chat_id: chatId, text: key ? "ветвь пуста" : "связей пока нет",
            reply_parameters: replyTo });
        console.log("links flat pack:", key || "chat", "chat", chatId);
        return;
    }

    // сообщение-гедком → ЗАМЕНА древа (до разбора триггеров); не пустой чат —
    // сначала автоматический резерв прежнего дерева файлом
    const g = parseGedcom(text);
    if (g) {
        const st = gedStats(g);
        if (st.persons || st.links) {
            const r = await replaceWithGedcom(chatId, g, true);
            await sendLong(chatId, r.head);
            return;
        }
        // гедком без персон с датами — дальше как триггеры
    }

    // /Иван — префиксный поиск по родословной росписи -+= (/-Пётр — только
    // мужчины глубины 0, /--Иван — глубины 1, /=… — женщины); "/ текст" —
    // подстрока. В reply — события родни героя, включая неточные даты.
    if (searchInput) {
        let parsed;
        try { parsed = parseSearchQuery(text); }
        catch (e) {
            await api.sendMessage({ chat_id: chatId, text: e.message });
            return;
        }
        const replySearch = !!message.reply_to_message;
        if (replySearch) {
            resolved ||= await resolveReply(chatId, message.reply_to_message);
            if (!resolved || !resolved.xref || resolved.n.includes("+")) {
                await api.sendMessage({ chat_id: chatId, text: REPLY_TARGET_ERROR });
                return;
            }
        }
        const plan = replySearch ? prepareReplySearch(parsed, (await getSettings(chatId)).fynny) : null;
        const chain = plan?.chain ?? searchChain(parsed, false);
        const radius = plan?.radius ?? searchRadius(parsed, chain);
        if (plan?.error) {
            await api.sendMessage({ chat_id: chatId, text: plan.error,
                reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
            return;
        }
        if (replySearch) {
            const fullHead = searchProgressHead(radius, chain, parsed, plan.decomposition);
            const head = fullHead.length > 2500
                ? searchProgressHead(radius, chain, parsed) + '\nПолное разложение — в файле.' : fullHead;
            if (head.length + NOT_FOR_GRAFT.length + 40 > 4000) {
                await api.sendMessage({ chat_id: chatId, text: "Ошибка поискового запроса: слишком длинный заголовок" });
                return;
            }
            const first = await api.sendMessage({ chat_id: chatId, text: head + "\n⏳",
                reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
            try {
                const hits = focusSearch(await personRows(chatId), await weddingRows(chatId),
                    await linkPairs(chatId), await focusSpousePairs(chatId),
                    resolved.n + " " + resolved.d, plan.query, chain, radius);
                const found = hits.join("\n");
                const prefix = head + "\n" + NOT_FOR_GRAFT;
                if (fullHead !== head || (found && prefix.length + 1 + found.length >= 4000)) {
                    const inner = cutLines(found, 4000, prefix.length + 1 + "\n✂️⏳".length);
                    const body = prefix + (inner ? "\n" + inner : "");
                    const holdTxt = body + "\n✂️⏳", finalTxt = body + "\n✂️";
                    await api.editMessageText({ chat_id: chatId, message_id: first.message_id, text: holdTxt });
                    await holdReply(chatId, first, holdTxt, finalTxt,
                        fullHead + '\n' + NOT_FOR_GRAFT + "\n" + (found || 'Ничего не найдено'), fileBaseOf(searchHead(text, hits.length)) + ".txt");
                } else {
                    await api.editMessageText({ chat_id: chatId, message_id: first.message_id,
                        text: found ? prefix + "\n" + found : head + "\nНичего не найдено" });
                }
            } catch (e) {
                console.error("reply search:", e);
                await api.editMessageText({ chat_id: chatId, message_id: first.message_id,
                    text: head + "\nНе удалось выполнить поиск" });
            }
            return;
        }
        const hits = flatSearch(await chatFlatText(chatId), parsed);
        if (hits.length) {
            // ровно одно попадание, резолвящееся в персону, — сжатый юбилей
            // с единой клавиатурой, реплаем на запрос; нерезолвимое (свадьба,
            // заглушка, тёзки) — списком
            if (hits.length === 1) {
                const key = flatHitKey(hits[0], await personRows(chatId));
                const rec = key ? await recordOf(chatId, key) : null;
                if (rec && rec.xref) { // резолвится в персону (xref есть)
                    await sendJubilee(chatId, rec, "", message.message_id);
                    console.log("flat search:", JSON.stringify(text), "-> юбилей", key, "чат", chatId);
                    return;
                }
            }
            // частые имена длиннее лимита — sendLong выложит файлом (как ВК);
            // имя файла — дословно как заголовок в ВК (lunarreturns.js)
            const q = text.trim();
            const head = searchHead(q, hits.length);
            // не влезает: метка + ✂️⏳ первым сообщением, ВЕСЬ список —
            // файлом .txt асинхронно ответом на него (как панель выше, как ВК;
            // текст — только метка, без «Найдено…», имя файла — из head),
            // потом ⏳ снят (✂️ остаётся)
            const found = hits.join("\n");
            if (found.length >= 4000) {
                // целые строки до ~4000 знака — в текст (как у панели выше,
                // как у 🧬), остальное — в файл; ✂️⏳ → после файла ✂️
                const inner = cutLines(found, 4000, NOT_FOR_GRAFT.length + 1);
                const holdTxt = NOT_FOR_GRAFT + (inner ? "\n" + inner : "") + "\n✂️⏳";
                const finalTxt = NOT_FOR_GRAFT + (inner ? "\n" + inner : "") + "\n✂️";
                const first = await api.sendMessage({
                    chat_id: chatId, text: holdTxt });
                holdReply(chatId, first, holdTxt, finalTxt,
                    NOT_FOR_GRAFT + "\n" + found, fileBaseOf(head) + ".txt");
            } else {
                // метка «не для прививки» — на любой ответ поиска
                await sendLong(chatId, NOT_FOR_GRAFT + "\n" + found, undefined, head);
            }
            console.log("flat search:", JSON.stringify(text), "->", hits.length, "строк, чат", chatId);
            return;
        }
        await api.sendMessage({ chat_id: chatId, text: "Ничего не найдено" });
        return;
    }

    // родословная роспись -+=: строки с маркерами '-'/'=' (глубина), «+дата»/«+»
    // (свадьбы) и безмарковыми именами вторых половин — весь разбор одним
    // сообщением; в ответе сводка + ошибки построчно. В ответе на триггер —
    // резка-прививка: ветвь цитируемого срезана, роспись (герой = цитируемый,
    // ветвь целиком) привита; мимо цитаты — добавление merge'ем
    const lines0 = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines0.some(l => /^[-+=]/.test(l))) {
        const tree = parseTree(text);
        if (tree.persons.length || tree.errors.length) {
            // The reply resolver has already validated the current hero.
            let anchor = null;
            if (resolved) {
                const sh = resolved;
                if (sh) anchor = sh.n + " " + sh.d;
            }
            const rep = anchor ? await cutAndGraft(chatId, anchor, tree) : await applyTree(chatId, tree);
            const body = treeReport(rep);
            await sendLong(chatId, body);
            console.log("tree:", rep.cut !== undefined ? "срезано " + rep.cut + ", " : "", rep.persons, "персон,", rep.fams, "семей,",
                rep.links, "детей,", rep.errors.length, "ошибок, чат", chatId);
            return;
        }
    }

    // поштучного ввода детей больше нет: ребёнок/ветвь добавляется родословной
    // росписью -+= в ответе на героя (cutAndGraft выше)

    const lines = text.split(/\s*\n+\s*/).filter(Boolean);
    // точечная правка: одна строка без маркера в ответе на триггер (сообщение
    // пользователя) — ПОЛНАЯ замена записи цитируемого (пол не трогается,
    // ветвь и связи целы); якорь не персона — правки нет, обычный ввод
    if (lines.length === 1) {
        const parsed = parseTrigger(lines[0]);
        if (parsed && !parsed.error) {
            if (resolved) {
                const sh = resolved;
                const anchor = sh ? sh.n + " " + sh.d : "";
                const ed = await editTrigger(chatId, anchor,
                    Object.assign({}, parsed.rec, parsed.tail ? { note: parsed.tail } : {}));
                if (ed) {
                    if (ed.error) {
                        await api.sendMessage({ chat_id: chatId, text: "💥 " + lines[0] + "\n" + ed.error });
                        return;
                    }
                    await sendJubilee(chatId, ed.rec, parsed.note);
                    console.log("edit:", anchor, "->", ed.rec.n, ed.rec.d, "chat", chatId);
                    return;
                }
            }
        }
    }
    for (const line of lines) {
        const parsed = parseTrigger(line);
        if (!parsed) continue;
        if (parsed.error) {
            await api.sendMessage({ chat_id: chatId, text: "💥 " + line + "\n" + parsed.error });
            continue;
        }
        const rec = await upsertPerson(chatId, parsed.rec);
        await sendJubilee(chatId, rec, parsed.note);
        console.log("record:", rec.n, rec.d, "xref", rec.xref, "chat", chatId);
    }
}
