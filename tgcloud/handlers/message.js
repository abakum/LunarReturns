import { api } from 'sdk';
import { parseTrigger } from '../lib/parse.js';
import { jubileeText } from '../lib/text.js';
import { HELP, relMarkup, getSettings, todayText, upcomingText, upsertEvent, eventMarkup, sendLong } from '../lib/bot.js';

export default async function (message, ctx) {
    const chatId = message.chat.id;
    const text = (message.text || "").trim();
    if (!text) return;

    if (text === "/start" || text === "/start@lunarreturns_bot" || text === "/") {
        await api.sendMessage({
            chat_id: chatId, text: HELP,
            reply_markup: relMarkup(chatId, await getSettings(chatId)),
        });
        return;
    }

    if (text === "/today" || text === "/list") {
        const body = text === "/today" ? await todayText(chatId) : await upcomingText(chatId);
        const none = text === "/today" ? "Сегодня событий нет" : "Событий нет";
        await api.sendMessage({ chat_id: chatId, text: body || none });
        return;
    }

    if (text.startsWith("/")) return;

    const lines = text.split(/\s*\n+\s*/).filter(Boolean);
    for (const line of lines) {
        const parsed = parseTrigger(line);
        if (!parsed) continue;
        if (parsed.error) {
            await api.sendMessage({ chat_id: chatId, text: "💥 " + line + "\n" + parsed.error });
            continue;
        }
        const row = await upsertEvent(chatId, parsed.rec);
        await sendLong(chatId, jubileeText({ n: row.name, d: row.date, h: row.hour ?? undefined, m: row.minute ?? undefined }, parsed.note), eventMarkup(row.id));
        console.log("record:", row.name, row.date, "chat", chatId);
    }
}
