import { api } from 'sdk';
import { parseTrigger, parseGedcom } from '../lib/parse.js';
import { jubileeText } from '../lib/text.js';
import {
    HELP, startMarkup, chatAdmin, getSettings, todayText, upsertEvent, eventMarkup, sendLong,
    addLink, setLinkCand, ensureFam, pairRecords, linkText, linkMarkup, gedcomText, importGedcom,
} from '../lib/bot.js';

const recOfRow = row => ({ n: row.name, d: row.date, h: row.hour ?? undefined, m: row.minute ?? undefined });

export default async function (message, ctx) {
    const chatId = message.chat.id;
    const text = (message.text || "").trim();
    if (!text) return;

    // в группах команда приходит с упоминанием бота: /start@botname
    const cmd = (text.match(/^\/[a-z_]+/i) || [""])[0].toLowerCase();

    if (cmd === "/start" || text === "/") {
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

    // гедком-древо чата (то же выводит кнопка 🧬)
    if (text === "/gedcom" || text.startsWith("/gedcom@")) {
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
            await api.sendMessage({ chat_id: chatId, text: "📦 Гедком импортирован: персон " + r.persons
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
        ? String(reply.text || "").match(/^(.+?)\s+(\d{4}-\d{2}-\d{2})/) : null;

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
