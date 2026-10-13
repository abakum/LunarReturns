import { api } from 'sdk';
import { parseTrigger } from '../lib/parse.js';
import { jubileeText } from '../lib/text.js';
import { HELP, startMarkup, chatAdmin, getSettings, todayText, upsertEvent, eventMarkup, sendLong } from '../lib/bot.js';

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
