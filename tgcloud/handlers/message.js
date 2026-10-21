import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { gedDrops, focusView } from '../schema.js';
import { parseTrigger, parseGedcom, gedStats } from '../lib/parse.js';
import { jubileeText } from '../lib/text.js';
import {
    HELP, startMarkup, chatAdmin, getSettings, todayText, eventMarkup, sendLong,
    addLink, setLinkCand, pairRecords, linkText, linkMarkup, recordOf, replaceWithGedcom,
    linkPairs, gedcomText, sendGedPdf, splitText, focusKeys, focusHead, focusMarkup,
    focusWithSpouses, focusSpousePairs, focusDepth, upsertPerson,
} from '../lib/bot.js';

// заголовок «Имя ГГГГ-ММ-ДД» (+ кейкап радиуса у фокус-сообщений) в цитате
const replyHeadOf = reply => reply && reply.from && !reply.from.is_bot
    ? String(reply.text || "").match(/^(?:\d\u20E3\s+)?(.+?)\s+(\d{4}-\d{2}-\d{2})/) : null;

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
    await api.sendMessage({
        chat_id: chatId,
        text: "🧬 Файл " + name + ": персон " + s.persons + ", связей " + s.links
            + ", свадеб " + s.weddings + ". Заменить события чата деревом?",
        reply_markup: {
            inline_keyboard: [[
                { text: "Нет", callback_data: "ged:ign" },
                { text: "Да", callback_data: "ged:rep" },
                { text: "Да, с резервом", callback_data: "ged:bak" },
            ]],
        },
    });
    console.log("ged drop:", name, "chat", chatId);
}

// фокус-сообщение: «/» ответом на триггер, радиус 1 сразу; ключ персоны —
// в focus_view по id сообщения с кнопками (callback_data короткий)
async function sendFocus(chat, chatId, key, radius, dd) {
    // тело (список/гедком) — после тапа по кнопке; цифры радиуса — по глубине предков
    const markup = focusMarkup(chat, chatId, await getSettings(chatId), radius,
        focusDepth(await linkPairs(chatId), key));
    const first = await api.sendMessage({ chat_id: chatId, text: focusHead(key, radius, dd), reply_markup: markup });
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
                await sendFocus(message.chat, chatId, key, 1, rec.dd);
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
                await sendGedPdf(chatId, keys, focusHead(key, radius, rec.dd));
                console.log("focus text:", key, "радиус", radius, "chat", chatId);
                return;
            }
        }
        if (!(await linkPairs(chatId)).length) {
            await api.sendMessage({ chat_id: chatId, text: "связей пока нет — ответьте триггером на триггер" });
            return;
        }
        await sendGedPdf(chatId, undefined, "🧬 Гедком-древо чата");
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

    if (text.startsWith("/")) return;

    // ответ триггером на триггер пользователя = связь родитель→ребёнок:
    // заголовок «Имя ГГГГ-ММ-ДД» в цитируемом сообщении (у ответа бота связей нет)
    const replyHead = replyHeadOf(message.reply_to_message);

    const lines = text.split(/\s*\n+\s*/).filter(Boolean);
    for (const line of lines) {
        const parsed = parseTrigger(line);
        if (!parsed) continue;
        if (parsed.error) {
            await api.sendMessage({ chat_id: chatId, text: "💥 " + line + "\n" + parsed.error });
            continue;
        }
        const rec = await upsertPerson(chatId, parsed.rec);
        if (replyHead) {
            const otherKey = replyHead[1].trim() + " " + replyHead[2];
            const newKey = rec.n + " " + rec.d;
            if (rec.n.includes("+")) {
                // пара «Имя+Имя» — свадьба, ребёнком быть не может
                await sendLong(chatId, jubileeText(rec, parsed.note)
                    + "\n🔗 связь не добавлена: пара «" + rec.n + "» не может быть ребёнком");
                continue;
            }
            if (rec.d === replyHead[2]) {
                // близнецы: даты рождения совпали — связь не добавляем
                await sendLong(chatId, jubileeText(rec, parsed.note)
                    + "\n🔗 связь не добавлена: даты рождения совпадают (близнецы?)");
                continue;
            }
            // по-простому: ответ на триггер — связь «цитируемый = родитель,
            // отвечающий = ребёнок» (без свопов по датам)
            const { link, dup } = await addLink(chatId, otherKey, newKey, 'c');
            if (link && !dup) setLinkCand(link, await pairRecords(chatId, link)); // свадьбы «Иван+Мария»
            if (link) {
                const txt = (dup ? await linkText(chatId, link) + "\n🔗 связь уже записана" : await linkText(chatId, link))
                    + "\n" + await gedcomText(chatId, [link.p, link.c]);
                await sendLong(chatId, txt, dup ? eventMarkup(rec.xref) : await linkMarkup(chatId, link));
                console.log("link:", link.p, "→", link.c, "chat", chatId, dup ? "(повтор)" : "");
            }
            continue;
        }
        await sendLong(chatId, jubileeText(rec, parsed.note), eventMarkup(rec.xref));
        console.log("record:", rec.n, rec.d, "xref", rec.xref, "chat", chatId);
    }
}
