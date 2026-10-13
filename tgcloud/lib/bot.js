// Общий код TG-бота: настройки, клавиатуры, тексты «сегодня»/«список».
import { db, api } from 'sdk';
import { eq } from 'sdk/db';
import { events, settings } from '../schema.js';
import { mskToday } from './astro.js';
import { REL_DEFS, REL_ORDER, religiousDigest } from './religion.js';
import { jubileeText } from './text.js';

export const HELP = "Отправьте «Имя ГГГГ-ММ-ДД [ЧЧ:ММ]» — покажу лунно-солнечные юбилеи.\n"
    + "Можно с зоной: «… 12:30 (Пермь)» или «… 12:30 МСК+2», по одной строке на событие.\n"
    + "/today — события и религиозные праздники сегодня (МСК)\n"
    + "Кнопки под ответом: 👎 удалить, 👀 подробно.";

const DEFAULT_SETTINGS = { orth: false, islam: false, bud: false, cath: false, jud: false };

export async function getSettings(chatId) {
    const row = await db.select().from(settings).where(eq(settings.chatId, chatId)).get();
    return row || { chatId, ...DEFAULT_SETTINGS };
}

// inline-клавиатура настроек (личка): 🗑 (удалить всё) + 🔔 (список) + религии (🔔/🔕) + ❌
// раскладка как в VK relKeyboard: [🗑, 🔔, orth, islam] / [bud, cath, jud, ❌]
export function relMarkup(chatId, s) {
    const btn = (text, data) => ({ text, callback_data: data });
    const rel = key => btn(REL_DEFS[key].icon + (s[key] ? "🔔" : "🔕"), "rel:" + key);
    return {
        inline_keyboard: [
            [btn("🗑", "del"), btn("🔔", "bell"), rel("orth"), rel("islam")],
            [rel("bud"), rel("cath"), rel("jud"), btn("❌", "close")]
        ]
    };
}

// клавиатура админа группы: 🗑 (удалить всё), 🔔 (список), ❌ (как ownerKeyboard VK)
export function ownerMarkup() {
    return {
        inline_keyboard: [[
            { text: "🗑", callback_data: "del" },
            { text: "🔔", callback_data: "bell" },
            { text: "❌", callback_data: "close" },
        ]]
    };
}

// клавиатура участника группы: 🔔 (список), ❌ (как bellKeyboard VK)
export function bellMarkup() {
    return {
        inline_keyboard: [[
            { text: "🔔", callback_data: "bell" },
            { text: "❌", callback_data: "close" },
        ]]
    };
}

// события чата на сегодня (МСК) + религиозный дайджест; "" — ничего
export async function todayText(chatId) {
    const [, mo, d] = mskToday();
    const mmdd = String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    const rows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
    const parts = [];
    for (const r of rows) {
        if (r.date.slice(5) !== mmdd) continue;
        const rec = { n: r.name, d: r.date };
        if (r.hour !== null && r.hour !== undefined) { rec.h = r.hour; rec.m = r.minute; }
        parts.push(jubileeText(rec, ""));
    }
    const digest = religiousDigest(await getSettings(chatId));
    if (digest) parts.push(digest);
    return parts.join("\n\n");
}

// «Имя ГГГГ-ММ-ДД[ ЧЧ:ММ]»; "" — событий нет.
// byFullDate=false — по возрастанию ММ-ДД (список 🔔), true — по полной дате
// ГГГГ-ММ-ДД (подтверждение удаления)
export async function upcomingText(chatId, byFullDate = false) {
    const rows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
    const key = r => (byFullDate ? r.date : r.date.slice(5)) + " " + (r.hour !== null && r.hour !== undefined ? String(r.hour).padStart(2, "0") + String(r.minute ?? 0).padStart(2, "0") : "");
    return rows
        .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
        .map(r => r.name + " " + r.date + (r.hour !== null && r.hour !== undefined ? " " + String(r.hour).padStart(2, "0") + ":" + String(r.minute).padStart(2, "0") : ""))
        .join("\n");
}

// upsert события; возвращает строку с id (как upsertRecord VK-бота)
export async function upsertEvent(chatId, rec) {
    const vals = {
        chatId, name: rec.n, date: rec.d,
        hour: rec.h ?? null, minute: rec.m ?? null,
    };
    const [row] = await db.insert(events).values(vals)
        .onConflictDoUpdate({
            target: [events.chatId, events.name, events.date],
            set: { hour: vals.hour, minute: vals.minute },
        })
        .returning().run();
    return row;
}

// кнопки под ответом бота на триггер: 👎 — удалить событие (как реакция VK), 👀 — подробно
export function eventMarkup(id) {
    return {
        inline_keyboard: [[
            { text: "👎", callback_data: "del1:" + id },
            { text: "👀", callback_data: "det:" + id },
        ]]
    };
}

// админ ли пользователь в чате (в личке — да, роли нет)
export async function chatAdmin(chat, userId) {
    if (!chat || chat.type === 'private') return true;
    if (!userId) return false;
    try {
        const m = await api.getChatMember({ chat_id: chat.id, user_id: userId });
        return !!m && (m.status === 'creator' || m.status === 'administrator');
    } catch (e) {
        console.error('getChatMember:', e.message);
        return false;
    }
}

// клавиатура /start: личка — полная, админ группы — ownerMarkup, участник — bellMarkup
// (паритет VK: relKeyboard/ownerKeyboard/bellKeyboard)
export function startMarkup(chat, isAdmin, chatId, s) {
    if (chat.type === 'private') return relMarkup(chatId, s);
    return isAdmin ? ownerMarkup() : bellMarkup();
}

// sendMessage с разбиением длинного текста (лимит TG 4096);
// текст jubileeText — HTML со спойлерами, поэтому parse_mode всегда HTML
export async function sendLong(chatId, text, replyMarkup) {
    const MAX = 4000;
    if (text.length <= MAX) {
        await api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup });
        return;
    }
    const parts = [];
    let rest = text;
    while (rest.length > MAX) {
        let cut = rest.lastIndexOf("\n", MAX);
        if (cut < MAX / 2) cut = MAX;
        parts.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n/, "");
    }
    if (rest) parts.push(rest);
    for (let i = 0; i < parts.length; i++) {
        await api.sendMessage({
            chat_id: chatId, text: parts[i], parse_mode: 'HTML',
            reply_markup: i === parts.length - 1 ? replyMarkup : undefined,
        });
    }
}
