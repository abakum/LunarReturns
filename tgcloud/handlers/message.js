import { api, db, InputFile } from 'sdk';
import { eq } from 'sdk/db';
import { gedDrops, focusView } from '../schema.js';
import { parseTrigger, parseGedcom, gedStats, parseTree } from '../lib/parse.cjs';
import { fileBaseOf } from '../lib/chart.cjs';
import { jubileeText } from '../lib/text.js';
import {
    HELP, startMarkup, chatAdmin, getSettings, todayText, jubileeMarkup, sendLong,
    recordOf, recordShownOf, replaceWithGedcom,
    linkPairs, personRows, weddingRows, sendGedPdf, focusHead, focusMarkup,
    focusListKeys, focusSpousePairs, focusDepth, focusListText, mmddToday, upcomingText, upsertPerson, applyTree, cutAndGraft, treeReport,
    editTrigger, hasTree, NOT_FOR_GRAFT,
    chatFlatText, flatSearch, sendFlatPack, flatHitKey, searchHead, cutLines,
} from '../lib/bot.js';

// заголовок «Имя ГГГГ-ММ-ДД» (+ цифра радиуса у фокус-сообщений) в цитате;
// якорь — только сообщение пользователя (не бота), как в ВК; `_` в датах —
// маркер показанного нового стиля: сохраняем до поиска по отображённой форме
const replyHeadOf = reply => reply && reply.from && !reply.from.is_bot
    ? String(reply.text || "").match(/^(?:\d\s+)?(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)/) : null;
const keyOfHead = m => m[1].trim() + " " + m[2];

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

// клавиатура дропа: «Да, с резервом» — только при непустом дереве чата
const dropKb = hasTree => ({
    inline_keyboard: [[
        { text: "Нет", callback_data: "ged:ign" },
        { text: "Да", callback_data: "ged:rep" },
        ...(hasTree ? [{ text: "Да, с резервом", callback_data: "ged:bak" }] : []),
    ]]
});

// дроп .ged-документа: скачать, разобрать, запомнить в ged_drops (последний
// дроп выигрывает); «Да» — ЗАМЕНА дерева (с резервом — прежнее дерево файлом
// <имя>-old.ged перед очисткой)

// скачать текст документа-дропа с ретраями: файл отдаётся не сразу
// (ВК: HTTP 502 от CDN) — после дропа ждём 3 с, попытка; провал — ещё 3 с и
// попытка, ещё 3 с и последняя (ВК-копия: lunarreturns.js, fetchDocText)
async function downloadDoc(doc) {
    for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 3000));
        try {
            const bytes = await api.getFileContent(doc.file_id);
            return new TextDecoder().decode(bytes);
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
        content = await downloadDoc(doc);
    } catch (e) {
        console.error("ged download:", e.message);
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось скачать файл " + name + " (трижды; повторите отправку файла в чат)" });
        return;
    }
    const g = parseGedcom(content);
    if (!g) {
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось разобрать файл " + name + " (ждём GEDCOM в UTF-8)" });
        return;
    }
    const s = gedStats(g);
    const vals = { fromId: fromId || 0, fileName: name, content, ts: Date.now() };
    const old = await db.select().from(gedDrops).where(eq(gedDrops.chatId, chatId)).get();
    if (old) await db.update(gedDrops).set(vals).where(eq(gedDrops.chatId, chatId)).run();
    else await db.insert(gedDrops).values({ chatId, ...vals }).run();
    // «Да, с резервом» — только при непустом дереве чата (резервовать нечего)
    await api.sendMessage({
        chat_id: chatId,
        text: "🧬 Файл " + name + ": персон " + s.persons + ", семей " + s.fams
            + ", детей " + s.links + ". Заменить события чата деревом?",
        reply_markup: dropKb(await hasTree(chatId)),
    });
    console.log("ged drop:", name, "chat", chatId);
}

// дроп .txt-документа с родословной росписью -+= (см. txtDrop ниже в коде)
async function txtDrop(chatId, doc, fromId, replyTo) {
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
    if (!tree.persons.length && !tree.errors.length) {
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось разобрать файл " + name + " (ждём пачку «плоское древо»)" });
        return;
    }
    // в ответе на триггер (сообщение пользователя) — ветвь цитируемого:
    // срезана, роспись привита
    const rh = replyHeadOf(replyTo);
    if (rh) {
        let anchor = null;
        const sh = await recordShownOf(chatId, keyOfHead(rh));
        if (sh) anchor = sh.n + " " + sh.d;
        if (!anchor) {
            // цитата на триггера не нашлась — добавлять молча нельзя: так
            // роспись применилась бы целиком (мимо героя)
            await api.sendMessage({ chat_id: chatId, text: "💥 В ответе — не триггер: пачка не применена. Герой ветви должен быть «Имя ГГГГ-ММ-ДД» из древа чата." });
            console.log("txt drop reply: триггера нет, мимо, чат", chatId);
            return;
        }
        const rep = await cutAndGraft(chatId, anchor, tree);
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
        // «Да, с резервом» — только при непустом дереве чата
        reply_markup: dropKb(await hasTree(chatId)),
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
    const markup = focusMarkup(chat, chatId, await getSettings(chatId), radius,
        focusDepth(await linkPairs(chatId), await focusSpousePairs(chatId), key), xref);
    const head = focusHead(key, radius, dd);
    const first = await api.sendMessage({
        chat_id: chatId,
        // перелив с героем: порядок строк — герой, метка, тело
        // (правило — коммент у NOT_FOR_GRAFT в lib/bot.js)
        text: head + (ng ? "\n" + NOT_FOR_GRAFT : "") + (body ? "\n" + body : ""),
        reply_markup: markup,
        ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    });
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
    const cmd = (text.match(/^\/[a-z_]+/i) || [""])[0].toLowerCase();

    if (cmd === "/start" || text === "/") {
        // «/» ответом на триггер — фокус-сообщение с радиусом родни
        const rh = replyHeadOf(message.reply_to_message);
        if (rh) {
            const key = keyOfHead(rh);
            const rec = await recordShownOf(chatId, key);
            if (rec) {
                // показанный ключ → хранимый
                await sendFocus(message.chat, chatId, rec.n + " " + rec.d, 1, rec.dd, message.message_id,
                    "", false, rec.xref ?? rec.fx ?? null);
                return;
            }
        }
        const admin = await chatAdmin(message.chat, message.from?.id);
        await api.sendMessage({
            chat_id: chatId, text: HELP,
            reply_markup: startMarkup(message.chat, admin, chatId, await getSettings(chatId)),
        });
        return;
    }

    // /today и /today@имя_бота (пишут и планировщики вроде Crondule)
    if (text === "/today" || text.startsWith("/today@")) {
        const body = await todayText(chatId);
        // как в VK: нечего показать — молчание (тело содержит jubileeText,
        // HTML со спойлерами; дайджест — простой текст)
        if (body) await api.sendMessage({ chat_id: chatId, text: body, parse_mode: 'HTML' });
        return;
    }

    // /bellN (в ответ на триггер): список родни в радиусе N — как тап 🔔 на
    // фокусе; без триггера — весь список чата (как 🔔 чата), не влезает —
    // отрезаем (целые строки)
    const bm = text.match(/^\/bell([1-5])?(?:@\S+)?$/i);
    if (bm) {
        const radius = Number(bm[1]) || 1;
        const rh = replyHeadOf(message.reply_to_message);
        if (rh) {
            const key = keyOfHead(rh);
            const rec = await recordShownOf(chatId, key);
            if (rec) {
                const skey = rec.n + " " + rec.d; // показанный ключ → хранимый
                // как тап: радиус не глубже имеющихся связей
                const pairs = await linkPairs(chatId);
                const r = Math.min(radius, Math.max(1, focusDepth(pairs, await focusSpousePairs(chatId), skey)));
                const sexMap = new Map((await personRows(chatId))
                    .map(rw => [rw.n + " " + rw.d, rw.sex ?? null]));
                const spPairs = await focusSpousePairs(chatId);
                // уровневый радиус («жизненный»: кровь 1, брак 1, полнокровный
                // сиблинг 1); супруги — по лимиту слов ярлыка (fynny)
                const keys = focusListKeys(pairs, spPairs, skey, r,
                    k => sexMap.get(k) ?? null, true);
                const items = [...await personRows(chatId), ...await weddingRows(chatId)];
                const body = focusListText(items, keys, skey, pairs,
                    spPairs, k => sexMap.get(k) ?? null, false, mmddToday(), r)
                    || "(в радиусе нет событий)";
                await api.sendMessage({ chat_id: chatId,
                    text: focusHead(skey, r, rec.dd) + "\n" + body });
                console.log("bell text:", skey, "радиус", r, "chat", chatId);
                return;
            }
        }
        // как у 🔔 чата: список «от сегодня» одним сообщением — что не
        // влезает, отрезаем (целые строки)
        const list = await upcomingText(chatId, false, mmddToday());
        const shownList = cutLines(list || "", 4000);
        await api.sendMessage({ chat_id: chatId, text: shownList || "Событий нет" });
        console.log("bell chat:", (list ? list.split("\n").length : 0) + "->" + shownList.split("\n").length, "строк, chat", chatId);
        return;
    }

    // гедком-древо чата (то же выводит кнопка 🧬); ответом на триггер — только
    // текст родни выбранного радиуса (/gedcom2 = 2), без кнопок
    const gm = text.match(/^\/gedcom([1-5])?(?:@\S+)?$/);
    if (gm) {
        const radius = Number(gm[1]) || 1;
        const rh = replyHeadOf(message.reply_to_message);
        if (rh) {
            const key = keyOfHead(rh);
            const rec = await recordShownOf(chatId, key);
            if (rec) {
                const skey = rec.n + " " + rec.d; // показанный ключ → хранимый
                const pairs = await linkPairs(chatId);
                const spPairs = await focusSpousePairs(chatId);
                const sexMap = new Map((await personRows(chatId))
                    .map(rw => [rw.n + " " + rw.d, rw.sex ?? null]));
                const keys = focusListKeys(pairs, spPairs, skey, radius,
                    k => sexMap.get(k) ?? null);
                await sendGedPdf(chatId, keys, focusHead(skey, radius, rec.dd), skey, message.message_id);
                console.log("focus text:", skey, "радиус", radius, "chat", chatId);
                return;
            }
        }
        if (!(await hasTree(chatId))) {
            await api.sendMessage({ chat_id: chatId, text: "связей пока нет" });
            return;
        }
        // «🧬⏳» ответом; прицепы (.ged+.pdf) — медиа-группой в ответ на
        // /gedcom (цитата — на само сообщение); по готовности — «🧬»
        const hold = await api.sendMessage({
            chat_id: chatId, text: "🧬⏳",
            reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } });
        await sendGedPdf(chatId, undefined, "🧬 Гедком-древо чата", null, message.message_id);
        await api.editMessageText({ chat_id: chatId,
            message_id: hold.message_id, text: "🧬" }).catch(() => {});
        return;
    }

    // «/links» / «связи» (как в VK): роспись ВЕТВИ героя — как «-+=» на фокусе
    // (>4000 — файлом .ged.txt); без reply (и не на триггер) — роспись древа
    // чата. Листинг сообщений-связей не восстановлен (листинг был одноразовым)
    if (/^\/links(?:@\S+)?$/i.test(text) || text.toLowerCase() === "связи") {
        const replyTo = { message_id: message.message_id, allow_sending_without_reply: true };
        const lrh = replyHeadOf(message.reply_to_message);
        let key = null, head = "";
        if (lrh) {
            const rk = keyOfHead(lrh);
            const rec = await recordShownOf(chatId, rk);
            if (rec) { key = rec.n + " " + rec.d; head = focusHead(key, 1, rec.dd); } // показанный ключ → хранимый
            else key = null; // ответ не на триггер — вся роспись
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
    // подстрока. Пусто — справка. (логика — flatSearch в lib/bot.js)
    if (text.startsWith("/")) {
        const hits = flatSearch(await chatFlatText(chatId), text);
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
        const admin = await chatAdmin(message.chat, message.from?.id);
        await api.sendMessage({
            chat_id: chatId, text: HELP,
            reply_markup: startMarkup(message.chat, admin, chatId, await getSettings(chatId)),
        });
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
            // цитата-якорь — только сообщение пользователя (триггер), как в ВК;
            // replyHeadOf также снимает кейкап радиуса
            const rh0 = replyHeadOf(message.reply_to_message);
            let anchor = null;
            if (rh0) {
                const sh = await recordShownOf(chatId, keyOfHead(rh0));
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
            const rh1 = replyHeadOf(message.reply_to_message);
            if (rh1) {
                const sh = await recordShownOf(chatId, keyOfHead(rh1));
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
