import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { gedDrops, focusView } from '../schema.js';
import { parseTrigger, parseGedcom, gedStats } from '../lib/parse.js';
import { jubileeText } from '../lib/text.js';
import {
    HELP, startMarkup, chatAdmin, getSettings, todayText, upsertEvent, eventMarkup, sendLong,
    addLink, setLinkCand, ensureFam, pairRecords, linkText, linkMarkup, gedcomText, importGedcom,
    recordOf, chatLinks, focusKeys, focusHead, focusMarkup, splitText, focusWithSpouses, focusSpousePairs, focusDepth,
} from '../lib/bot.js';

const recOfRow = row => ({ n: row.name, d: row.date, h: row.hour ?? undefined, m: row.minute ?? undefined, dd: row.deathDate ?? undefined });

// дроп .ged-документа: скачать, разобрать, запомнить в ged_drops (последний
// дроп выигрывает) и спросить кнопками «Да/Нет»
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
            + ", свадеб " + s.weddings + ". Добавить в список событий?",
        reply_markup: {
            inline_keyboard: [[
                { text: "✅ Да", callback_data: "gedadd" },
                { text: "❌ Нет", callback_data: "gedign" },
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
        focusDepth((await chatLinks(chatId)).map(l => [l.parent, l.child]), key));
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

    // дроп .ged-документа → вопрос «Да/Нет» (до разбора команд/триггеров;
    // сообщение может быть без текста, caption не разбираем)
    if (message.document && /\.ged$/i.test(message.document.file_name || "")) {
        await gedDrop(chatId, message.document, message.from?.id);
        return;
    }

    if (!text) return;

    // в группах команда приходит с упоминанием бота: /start@botname
    const cmd = (text.match(/^\/[a-z_]+/i) || [""])[0].toLowerCase();

    if (cmd === "/start" || text === "/") {
        // «/» ответом на триггер — фокус-сообщение с радиусом родни
        const reply = message.reply_to_message;
        const rh = reply && reply.from && !reply.from.is_bot
            ? String(reply.text || "").match(/^(?:\d\u20E3\s+)?(.+?)\s+(\d{4}-\d{2}-\d{2})/) : null;        if (rh) {
            const key = rh[1].trim() + " " + rh[2];
            const row = await recordOf(chatId, key);
            if (row) {
                await sendFocus(message.chat, chatId, key, 1, row.deathDate ?? undefined);
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
        const reply = message.reply_to_message;
        const rh = reply && reply.from && !reply.from.is_bot
            ? String(reply.text || "").match(/^(?:\d\u20E3\s+)?(.+?)\s+(\d{4}-\d{2}-\d{2})/) : null;        if (rh) {
            const key = rh[1].trim() + " " + rh[2];
            const row = await recordOf(chatId, key);
            if (row) {
                const keys = focusWithSpouses(
                    focusKeys((await chatLinks(chatId)).map(l => [l.parent, l.child]), key, radius),
                    await focusSpousePairs(chatId));
                const parts = splitText(focusHead(key, radius, row.deathDate ?? undefined) + "\n" + await gedcomText(chatId, keys));
                for (const part of parts) await api.sendMessage({ chat_id: chatId, text: part });
                console.log("focus text:", key, "радиус", radius, "chat", chatId);
                return;
            }
        }
        const g = await gedcomText(chatId);
        if (!g.includes("FAM")) {
            await api.sendMessage({ chat_id: chatId, text: "связей пока нет — ответьте триггером на триггер" });
            return;
        }
        await sendLong(chatId, g);
        return;
    }

    // сообщение-гедком → импорт древа (до разбора триггеров)
    const g = parseGedcom(text);
    if (g) {
        const r = await importGedcom(chatId, g);
        if (r.persons || r.links) {
            await api.sendMessage({ chat_id: chatId, text: "🧬 Гедком импортирован: персон " + r.persons
                + ", связей " + r.links + (r.weddings ? ", свадеб " + r.weddings : "") });
            return;
        }
        // гедком без персон с датами — дальше как триггеры
    }

    if (text.startsWith("/")) return;

    // ответ триггером на триггер пользователя = связь родитель→ребёнок:
    // заголовок «Имя ГГГГ-ММ-ДД» в цитируемом сообщении (у ответа бота связей нет)
    const reply = message.reply_to_message;
    const replyHead = reply && reply.from && !reply.from.is_bot
        ? String(reply.text || "").match(/^(?:\d\u20E3\s+)?(.+?)\s+(\d{4}-\d{2}-\d{2})/) : null;

    const lines = text.split(/\s*\n+\s*/).filter(Boolean);
    for (const line of lines) {
        const parsed = parseTrigger(line);
        if (!parsed) continue;
        if (parsed.error) {
            await api.sendMessage({ chat_id: chatId, text: "💥 " + line + "\n" + parsed.error });
            continue;
        }
        const row = await upsertEvent(chatId, parsed.rec);
        if (replyHead) {
            const otherKey = replyHead[1].trim() + " " + replyHead[2];
            const newKey = row.name + " " + row.date;
            if (row.name.includes("+")) {
                // пара «Имя+Имя» — свадьба, ребёнком быть не может
                await sendLong(chatId, jubileeText(recOfRow(row), parsed.note)
                    + "\n🔗 связь не добавлена: пара «" + row.name + "» не может быть ребёнком");
                continue;
            }
            if (row.date === replyHead[2]) {
                // близнецы: даты рождения совпали — связь не добавляем
                await sendLong(chatId, jubileeText(recOfRow(row), parsed.note)
                    + "\n🔗 связь не добавлена: даты рождения совпадают (близнецы?)");
                continue;
            }
            // по-простому: ответ на триггер — связь «цитируемый = родитель,
            // отвечающий = ребёнок» (без свопов по датам)
            const { link, dup } = await addLink(chatId, otherKey, newKey, 'c');
            if (!dup) {
                const f = await ensureFam(chatId, link.child); // 2 родителя — семья
                if (f) link.famId = f.id;
                await setLinkCand(link, await pairRecords(chatId, link));
            }
            const txt = (dup ? await linkText(chatId, link) + "\n🔗 связь уже записана" : await linkText(chatId, link))
                + "\n" + await gedcomText(chatId, [link.parent, link.child]);
            await sendLong(chatId, txt,
                dup ? eventMarkup(row.id) : await linkMarkup(chatId, link));
            console.log("link:", link.parent, "→", link.child, "chat", chatId, dup ? "(повтор)" : "");
            continue;
        }
        await sendLong(chatId, jubileeText(recOfRow(row), parsed.note), eventMarkup(row.id));
        console.log("record:", row.name, row.date, "chat", chatId);
    }
}
