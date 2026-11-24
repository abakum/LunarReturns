"use strict";
const { focusDepth } = require('../../tgcloud/lib/tree.cjs');

const REACTION_EYES_ID = 32; // 👀 (детально); 👍 = 4, 👎 = 9

// реакции на ответы/уведомления бота; формат события (по факту):
// { reacted_id, peer_id, cmid, reaction_id } — 👎 = 9, 👀 = REACTION_EYES_ID

module.exports = async (o, { deps, peerId }) => {
    const {
        deleteEventCascade, findRecordByCmid, focusSpousePairs, jubileeKeyboard, jubileeText,
        linkPairs, messagesSend, pkey, vkApi,
    } = deps;
    const cmid = o.cmid ?? o.conversation_message_id ?? o.message_id;
    if (!cmid) return;
    const from = o.reacted_id ?? o.from_id ?? o.user_id;
    if (from <= 0) return; // реакции бота игнорируем

    if (o.reaction_id === undefined) { // снятие реакции — сжать обратно
        const rec = await findRecordByCmid(peerId, cmid);
        if (!rec) {
            console.log("reaction снята: запись не найдена (cmid", cmid, "peer", peerId, ")");
            return;
        }
        try {
            await vkApi("messages.edit", {
                peer_id: peerId, conversation_message_id: cmid,
                message: jubileeText(rec, ""),
                // клавиатура-юбилей возвращается (сжатое состояние, 👀)
                keyboard: await jubileeKeyboard(peerId, from, pkey(rec),
                    focusDepth(linkPairs(peerId), focusSpousePairs(peerId), pkey(rec)), false, rec.n.includes("+"))
            });
            console.log("reaction снята: сжато", rec.n, rec.d, "peer", peerId);
        } catch (e) {
            console.error("reaction collapse:", e.message);
        }
        return;
    }
    if (o.reaction_id === 9) { // 👎 — удалить событие
        const rec = await findRecordByCmid(peerId, cmid);
        if (!rec) return;
        // связи персоны, свадьба пары «Имя+Имя», висячие кандидаты, семьи
        deleteEventCascade(peerId, pkey(rec));
        console.log("reaction 👎: удалено событие", rec.n, rec.d, "peer", peerId);
        // правим сообщение события в пометку об удалении (реакции сохраняются),
        // при неудаче — reply
        try {
            await vkApi("messages.edit", {
                peer_id: peerId, conversation_message_id: cmid,
                message: "🗑 Событие удалено: " + rec.n + " " + rec.d
            });
        } catch (e) {
            console.error("reaction edit:", e.message, "— reply");
            try {
                await messagesSend(peerId, "🗑 Событие удалено: " + rec.n + " " + rec.d, 0, cmid);
            } catch (e2) {
                console.error("reaction reply:", e2.message);
            }
        }
        return;
    }
    if (REACTION_EYES_ID && o.reaction_id === REACTION_EYES_ID) { // 👀 — детализировать
        const rec = await findRecordByCmid(peerId, cmid);
        if (!rec) {
            console.log("reaction 👀: запись не найдена (cmid", cmid, "peer", peerId, ") — возможно, событие уже удалено");
            return;
        }
        try {
            await vkApi("messages.edit", {
                peer_id: peerId, conversation_message_id: cmid,
                message: jubileeText(rec, "", true),
                // клавиатура-юбилей с 🌙 (сворачивает обратно)
                keyboard: await jubileeKeyboard(peerId, from, pkey(rec),
                    focusDepth(linkPairs(peerId), focusSpousePairs(peerId), pkey(rec)), true, rec.n.includes("+"))
            });
            console.log("reaction 👀: детально", rec.n, rec.d, "peer", peerId);
        } catch (e) {
            console.error("reaction detail:", e.message);
        }
        return;
    }
    // неизвестная реакция: id в лог
    console.log("reaction:", o.reaction_id);
};
