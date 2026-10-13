import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { events, settings } from '../schema.js';
import { jubileeText } from '../lib/text.js';
import { REL_DEFS, religiousYear } from '../lib/religion.js';
import { relMarkup, upcomingText, getSettings, startMarkup, chatAdmin, eventMarkup } from '../lib/bot.js';

export default async function (cq, ctx) {
    const chatId = cq.message?.chat?.id;
    const data = cq.data || "";
    const answer = (text, alert) =>
        api.answerCallbackQuery({ callback_query_id: cq.id, text, show_alert: !!alert }).catch(() => {});
    const editMarkup = markup =>
        api.editMessageReplyMarkup({ chat_id: chatId, message_id: cq.message.message_id, reply_markup: markup }).catch(() => {});
    // как editOrigin в VK: при неудачной правке (сообщение старое/удалено) —
    // новым сообщением; «message is not modified» (повторное нажатие) глушим
    const editText = (text, markup) =>
        api.editMessageText({ chat_id: chatId, message_id: cq.message.message_id, text, reply_markup: markup })
            .catch(e => {
                if (e && /not modified/i.test(e.description || e.message || "")) return;
                console.error("editMessageText:", e.message, "— отправляю сообщением");
                return api.sendMessage({ chat_id: chatId, text, reply_markup: markup }).catch(() => {});
            });

    if (data.startsWith("rel:")) {
        const key = data.slice(4);
        if (!REL_DEFS[key]) { await answer(); return; }
        const head = REL_DEFS[key].icon + " " + REL_DEFS[key].name + " дни";
        // календарь уже показан в этом сообщении (заголовок совпадает) — toggle,
        // иначе первый тап: показать календарь (как в VK-боте)
        const cur = cq.message?.text;
        const shown = cur !== undefined && cur.split("\n", 1)[0] === head;
        if (shown) {
            const row = await db.select().from(settings).where(eq(settings.chatId, chatId)).get();
            const curVal = row ? row[key] : false;
            if (row) {
                await db.update(settings).set({ [key]: !curVal }).where(eq(settings.chatId, chatId)).run();
            } else {
                const vals = { chatId };
                vals[key] = true;
                await db.insert(settings).values(vals).run();
            }
            await answer((!curVal ? "🔔 " : "🔕 ") + key);
        } else {
            await answer("календарь на год");
        }
        await editText(head + "\n" + religiousYear(key), relMarkup(chatId, await getSettings(chatId)));
        return;
    }

    if (data === "bell") {
        const list = await upcomingText(chatId);
        if (!list) { await answer("Событий нет"); return; }
        await answer("список событий");
        // как в VK: список в этом же сообщении, клавиатура остаётся
        const parts = splitList(list);
        await editText(parts[0], cq.message.reply_markup);
        for (let i = 1; i < parts.length; i++) {
            await api.sendMessage({ chat_id: chatId, text: parts[i] });
        }
        return;
    }

    if (data === "del" || data === "del:yes") {
        // 🗑 в групповом чате — только админ (кнопка висит на сообщении в чате,
        // нажать может любой участник); в личке chatAdmin всегда true
        if (!(await chatAdmin(cq.message.chat, cq.from?.id))) {
            await answer("только владелец");
            return;
        }
    }

    if (data === "del") {
        // сортировка по полной дате ГГГГ-ММ-ДД (в отличие от списка 🔔 — по ММ-ДД)
        const list = await upcomingText(chatId, true);
        if (!list) { await answer("Событий нет"); return; }
        await answer("Удалить все события чата?");
        // как в VK: подтверждение с показом списка событий
        await editText("Удалить все события чата?\n" + list, {
            inline_keyboard: [[
                { text: "🗑 удалить всё", callback_data: "del:yes" },
                { text: "❌ отмена", callback_data: "del:no" },
            ]]
        });
        return;
    }

    if (data === "del:yes") {
        const n = await db.$count(events, eq(events.chatId, chatId));
        await db.delete(events).where(eq(events.chatId, chatId)).run();
        await editText("🗑 Удалено событий: " + n, undefined);
        await answer("🗑 События чата удалены");
        return;
    }

    if (data === "del:no") {
        // вернуть клавиатуру по чату/роли: религии — только в личке
        const isAdmin = await chatAdmin(cq.message.chat, cq.from?.id);
        await editMarkup(startMarkup(cq.message.chat, isAdmin, chatId, await getSettings(chatId)));
        await answer("Отменено");
        return;
    }

    if (data === "close") {
        await editMarkup(undefined);
        await answer();
        return;
    }

    if (data.startsWith("del1:")) {
        // 👎 — удалить событие, правкой самого сообщения (как реакция 👎 в VK-боте)
        const id = Number(data.slice(5));
        const row = await db.select().from(events).where(eq(events.id, id)).get();
        if (!row || row.chatId !== chatId) { await answer("Событие не найдено"); return; }
        await db.delete(events).where(eq(events.id, id)).run();
        await editText("🗑 Событие удалено: " + row.name + " " + row.date, undefined);
        await answer();
        console.log("deleted:", row.name, row.date, "chat", chatId);
        return;
    }

    if (data.startsWith("det:")) {
        // 👀 — детализировать правкой сообщения, кнопки сохраняются;
        // повторное нажатие сворачивает обратно (как снятие реакции в VK)
        const id = Number(data.slice(4));
        const row = await db.select().from(events).where(eq(events.id, id)).get();
        if (!row || row.chatId !== chatId) { await answer("Событие не найдено"); return; }
        const rec = { n: row.name, d: row.date };
        if (row.hour !== null && row.hour !== undefined) { rec.h = row.hour; rec.m = row.minute; }
        const t = cq.message?.text || "";
        // признак детальности: текст сообщения совпадает с детальной версией
        // (в проде .text без тегов/ентитей, в моке — с буквальными тегами)
        const norm = s => s.replace(/<\/?tg-spoiler>/g, "");
        const isDetail = t !== "" && norm(t) === norm(jubileeText(rec, "", true));
        await editText(
            jubileeText(rec, "", !isDetail),
            eventMarkup(id));
        await answer(isDetail ? "сжато" : "подробно");
        return;
    }

    await answer();
}

// разбить длинный список на куски < 4000 по границам строк (как splitText VK)
function splitList(text) {
    const MAX = 4000;
    if (text.length <= MAX) return [text];
    const parts = [];
    let rest = text;
    while (rest.length > MAX) {
        let cut = rest.lastIndexOf("\n", MAX);
        if (cut < MAX / 2) cut = MAX;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, "");
    }
    if (rest) parts.push(rest);
    return parts;
}
