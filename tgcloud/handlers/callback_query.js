import { api } from 'sdk';
import { eq } from 'sdk/db';
import { events, settings } from '../schema.js';
import { jubileeText } from '../lib/text.js';
import { relMarkup, upcomingText, getSettings, sendLong } from '../lib/bot.js';

export default async function (cq, ctx) {
    const chatId = cq.message?.chat?.id;
    const data = cq.data || "";
    const answer = (text, alert) =>
        api.answerCallbackQuery({ callback_query_id: cq.id, text, show_alert: !!alert }).catch(() => {});
    const editMarkup = markup =>
        api.editMessageReplyMarkup({ chat_id: chatId, message_id: cq.message.message_id, reply_markup: markup }).catch(() => {});

    if (data.startsWith("rel:")) {
        const key = data.slice(4);
        const row = await db.select().from(settings).where(eq(settings.chatId, chatId)).get();
        const cur = row ? row[key] : false;
        if (row) {
            await db.update(settings).set({ [key]: !cur }).where(eq(settings.chatId, chatId)).run();
        } else {
            const vals = { chatId };
            vals[key] = true;
            await db.insert(settings).values(vals).run();
        }

        await answer((!cur ? "🔔 " : "🔕 ") + key);
        await editMarkup(relMarkup(chatId, await getSettings(chatId)));
        return;
    }

    if (data === "del") {
        const list = await upcomingText(chatId);
        if (!list) { await answer("Событий нет"); return; }
        await editMarkup({
            inline_keyboard: [[
                { text: "🗑 удалить всё", callback_data: "del:yes" },
                { text: "❌ отмена", callback_data: "del:no" },
            ]]
        });
        await answer("Удалить все события чата?");
        return;
    }

    if (data === "del:yes") {
        await db.delete(events).where(eq(events.chatId, chatId)).run();
        await editMarkup(undefined);
        await answer("🗑 События чата удалены");
        return;
    }

    if (data === "del:no") {
        await editMarkup(relMarkup(chatId, await getSettings(chatId)));
        await answer("Отменено");
        return;
    }

    if (data === "close") {
        await editMarkup(undefined);
        await answer();
        return;
    }

    if (data.startsWith("del1:")) {
        const id = Number(data.slice(5));
        const row = await db.select().from(events).where(eq(events.id, id)).get();
        if (!row || row.chatId !== chatId) { await answer("Событие не найдено"); return; }
        await editMarkup({
            inline_keyboard: [[
                { text: "🗑 " + row.name + " — точно?", callback_data: "del1s:" + id },
                { text: "❌", callback_data: "close" },
            ]]
        });
        await answer("Подтвердите удаление");
        return;
    }

    if (data.startsWith("del1s:")) {
        const id = Number(data.slice(6));
        const row = await db.select().from(events).where(eq(events.id, id)).get();
        if (!row || row.chatId !== chatId) { await answer("Событие не найдено"); return; }
        await db.delete(events).where(eq(events.id, id)).run();
        await editMarkup(undefined);
        await answer("🗑 Событие удалено");
        console.log("deleted:", row.name, row.date, "chat", chatId);
        return;
    }

    if (data.startsWith("det:")) {
        const id = Number(data.slice(4));
        const row = await db.select().from(events).where(eq(events.id, id)).get();
        if (!row || row.chatId !== chatId) { await answer("Событие не найдено"); return; }
        const rec = { n: row.name, d: row.date };
        if (row.hour !== null && row.hour !== undefined) { rec.h = row.hour; rec.m = row.minute; }

        await sendLong(chatId, jubileeText(rec, "", true));
        await answer();
        return;
    }

    await answer();
}
