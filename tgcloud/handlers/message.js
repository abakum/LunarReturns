import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { gedDrops, focusView } from '../schema.js';
import { parseTrigger, parseGedcom, gedStats, parseTree } from '../lib/parse.js';
import { jubileeText } from '../lib/text.js';
import {
    HELP, startMarkup, chatAdmin, getSettings, todayText, eventMarkup, sendLong,
    linkText, linkMarkup, recordOf, replaceWithGedcom,
    linkPairs, linksAll, personRows, gedcomText, sendGedPdf, splitText, focusKeys, focusHead, focusMarkup,
    focusWithSpouses, focusSpousePairs, focusDepth, upsertPerson, applyTree, cutAndGraft, treeReport,
    chatFlatText, flatSearch,
} from '../lib/bot.js';

// заголовок «Имя ГГГГ-ММ-ДД» (+ кейкап радиуса у фокус-сообщений) в цитате;
// для пачки в ответе цитатой может быть и сообщение бота (фокус-пачка) —
// отдельный якорь бот-цитат не отвергает
const replyHeadOf = reply => reply && reply.from && !reply.from.is_bot
    ? String(reply.text || "").match(/^(?:\d\u20E3\s+)?(.+?)\s+(\d{4}-\d{2}-\d{2})/) : null;
const anchorOf = reply => reply
    ? String(reply.text || "").match(/^(?:\d\u20E3\s+)?(.+?)\s+(\d{4}-\d{2}-\d{2})/) : null;

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
async function gedDrop(chatId, doc, fromId) {
    const name = doc.file_name || "gedcom.ged";
    let content;
    try {
        const bytes = await api.getFileContent(doc.file_id);
        content = new TextDecoder().decode(bytes);
    } catch (e) {
        console.error("ged download:", e.message);
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось скачать файл " + name });
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
        reply_markup: dropKb((await personRows(chatId)).length > 0),
    });
    console.log("ged drop:", name, "chat", chatId);
}

// дроп .txt-документа с пачкой «плоское древо» (см. txtDrop ниже в коде)
async function txtDrop(chatId, doc, fromId, replyTo) {
    const name = doc.file_name || "пачка.ged.txt";
    let content;
    try {
        const bytes = await api.getFileContent(doc.file_id);
        content = new TextDecoder().decode(bytes);
    } catch (e) {
        console.error("txt download:", e.message);
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось скачать файл " + name });
        return;
    }
    const tree = parseTree(content);
    if (!tree.persons.length && !tree.errors.length) {
        await api.sendMessage({ chat_id: chatId, text: "💥 Не удалось разобрать файл " + name + " (ждём пачку «плоское древо»)" });
        return;
    }
    // в ответе на триггер/фокус — ветвь цитируемого: срезана, пачка привита
    const rh = anchorOf(replyTo);
    if (rh) {
        let anchor = null;
        const k = rh[1].trim() + " " + rh[2];
        if (await recordOf(chatId, k)) anchor = k;
        const rep = anchor ? await cutAndGraft(chatId, anchor, tree) : await applyTree(chatId, tree);
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
        text: "📄 Файл " + name + ": персон " + tree.persons.length
            + ", семей " + tree.weddings.length + ", детей " + tree.children.length
            + ". Добавить пачку к дереву чата?",
        // «Да, с резервом» — только при непустом дереве чата
        reply_markup: dropKb((await personRows(chatId)).length > 0),
    });
    console.log("txt drop:", name, "chat", chatId);
}

// фокус-сообщение: «/» ответом на триггер, радиус 1 сразу; ключ персоны —
// в focus_view по id сообщения с кнопками (callback_data короткий);
// само сообщение — реплаем на «/» (как в VK sendFocus)
async function sendFocus(chat, chatId, key, radius, dd, replyTo = 0) {
    // тело (список/гедком) — после тапа по кнопке; цифры радиуса — по глубине предков
    const markup = focusMarkup(chat, chatId, await getSettings(chatId), radius,
        focusDepth(await linkPairs(chatId), key));
    const first = await api.sendMessage({
        chat_id: chatId, text: focusHead(key, radius, dd), reply_markup: markup,
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
    // .ged.txt-документ (тексты бота) = пачка «плоское древо»: в ответе на
    // триггер — сразу применяем (ветвь цитируемого срезана, пачка привита);
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
            const key = rh[1].trim() + " " + rh[2];
            const rec = await recordOf(chatId, key);
            if (rec) {
                await sendFocus(message.chat, chatId, key, 1, rec.dd, message.message_id);
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

    // гедком-древо чата (то же выводит кнопка 🧬); ответом на триггер — только
    // текст родни выбранного радиуса (/gedcom2 = 2), без кнопок
    const gm = text.match(/^\/gedcom([1-5])?(?:@\S+)?$/);
    if (gm) {
        const radius = Number(gm[1]) || 1;
        const rh = replyHeadOf(message.reply_to_message);
        if (rh) {
            const key = rh[1].trim() + " " + rh[2];
            const rec = await recordOf(chatId, key);
            if (rec) {
                const pairs = await linkPairs(chatId);
                const keys = focusWithSpouses(
                    focusKeys(pairs, key, radius), await focusSpousePairs(chatId));
                await sendGedPdf(chatId, keys, focusHead(key, radius, rec.dd), key, message.message_id);
                console.log("focus text:", key, "радиус", radius, "chat", chatId);
                return;
            }
        }
        if (!(await linkPairs(chatId)).length) {
            await api.sendMessage({ chat_id: chatId, text: "связей пока нет" });
            return;
        }
        await sendGedPdf(chatId, undefined, "🧬 Гедком-древо чата", null, message.message_id);
        return;
    }

    // «/links» / «связи» (как в VK): заново выложить сообщения-связи с их
    // кнопками (листинг одноразовый, пропало — восстановить); в ответе на
    // триггер — только связи цитируемого персонажа
    if (/^\/links(?:@\S+)?$/i.test(text) || text.toLowerCase() === "связи") {
        const replyTo = { message_id: message.message_id, allow_sending_without_reply: true };
        if (!(await linkPairs(chatId)).length) {
            await api.sendMessage({ chat_id: chatId, text: "связей пока нет",
                reply_parameters: replyTo });
            return;
        }
        const lrh = replyHeadOf(message.reply_to_message);
        const lkey = lrh ? lrh[1].trim() + " " + lrh[2] : null;
        const links = (await linksAll(chatId)).filter(l => !lkey || l.p === lkey || l.c === lkey);
        if (!links.length) {
            await api.sendMessage({ chat_id: chatId, text: "у этой персоны связей нет",
                reply_parameters: replyTo });
            return;
        }
        for (const l of links) {
            await api.sendMessage({
                chat_id: chatId,
                text: await linkText(chatId, l) + "\n" + await gedcomText(chatId, [l.p, l.c]),
                reply_markup: await linkMarkup(chatId, l),
                reply_parameters: replyTo,
            });
        }
        console.log("links re-listed:", links.length, "chat", chatId);
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

    // /Иван — префиксный поиск по пачке «плоское древо» (/-Пётр — только
    // мужчины глубины 0, /--Иван — глубины 1, /=… — женщины); "/ текст" —
    // подстрока. Пусто — справка. (логика — flatSearch в lib/bot.js)
    if (text.startsWith("/")) {
        const hits = flatSearch(await chatFlatText(chatId), text);
        if (hits.length) {
            await sendLong(chatId, hits.join("\n"));
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

    // пачка «плоское древо»: строки с маркерами '-'/'=' (глубина), «+дата»/«+»
    // (свадьбы) и безмарковыми именами вторых половин — весь разбор одним
    // сообщением; в ответе сводка + ошибки построчно. В ответе на триггер —
    // резка-прививка: ветвь цитируемого срезана, пачка (герой = цитируемый,
    // ветвь целиком) привита; мимо цитаты — добавление merge'ем
    const lines0 = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines0.some(l => /^[-+=]/.test(l))) {
        const tree = parseTree(text);
        if (tree.persons.length || tree.errors.length) {
            // цитата — и триггер пользователя, и фокус-пачка бота (yитированная
            // ветвь); anchorOf также снимает кейкап радиуса
            const rh0 = anchorOf(message.reply_to_message);
            let anchor = null;
            if (rh0) {
                const k = rh0[1].trim() + " " + rh0[2];
                if (await recordOf(chatId, k)) anchor = k;
            }
            const rep = anchor ? await cutAndGraft(chatId, anchor, tree) : await applyTree(chatId, tree);
            const body = treeReport(rep);
            await sendLong(chatId, body);
            console.log("tree:", rep.cut !== undefined ? "срезано " + rep.cut + ", " : "", rep.persons, "персон,", rep.fams, "семей,",
                rep.links, "детей,", rep.errors.length, "ошибок, чат", chatId);
            return;
        }
    }

    // поштучного ввода детей больше нет: ребёнок/ветвь добавляется пачкой
    // «плоское древо» в ответе на героя (cutAndGraft выше)

    const lines = text.split(/\s*\n+\s*/).filter(Boolean);
    for (const line of lines) {
        const parsed = parseTrigger(line);
        if (!parsed) continue;
        if (parsed.error) {
            await api.sendMessage({ chat_id: chatId, text: "💥 " + line + "\n" + parsed.error });
            continue;
        }
        const rec = await upsertPerson(chatId, parsed.rec);
        await sendLong(chatId, jubileeText(rec, parsed.note), eventMarkup(rec.xref));
        console.log("record:", rec.n, rec.d, "xref", rec.xref, "chat", chatId);
    }
}
