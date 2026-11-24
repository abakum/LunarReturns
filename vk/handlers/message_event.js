"use strict";
const { fileBaseOf } = require('../../tgcloud/lib/chart.cjs');
const { cutLines, treeReport } = require('../../tgcloud/lib/flat.cjs');
const { NOT_FOR_GRAFT, trimImport, withGraftMark } = require('../../tgcloud/lib/parse.cjs');
const { REL_DEFS, religiousYear } = require('../../tgcloud/lib/religion.cjs');
const { HELP, helpText } = require('../../tgcloud/lib/text.cjs');
const { focusDepth, normalizeFocusRadius } = require('../../tgcloud/lib/tree.cjs');

module.exports = async (o, { deps, peerId, source }) => {
    const {
        GED_TTL, cancelDnaExport, answerEvent, applyTree, computeExport, exportFocused, exportWhole, parseImport,
        clearChatTree, cmidText, deleteByCmid, deleteEventCascade, editOrigin,
        editOriginDoc, findRecordByCmid, focusHead, focusKeyboard, focusLabel, focusSpousePairs, focusText,
        gedPending, getSettings, isChatAdmin, jubileeKeyboard, jubileeText, linkPairs, messagesSend,
        mskNowParts, peerKeyboard, personRows, pkey, relKeyboard, replaceWithGedcom,
        sendChatFlatArtifacts, sendTailDoc, sendTreeBackup, setChatSetting,
        splitText, unpay, upcomingEvents, vkApi, vkUploadDoc, weddingRows,
    } = deps;
    const p = unpay(o.payload);
    console.log("кнопка:", JSON.stringify(p), "peer", peerId);
    const action = p && typeof p === "object" ? p.c : p;
    if (action === 'work:cancel') return deps.cancelWorkerIndicator(o, p.id);
    if (action === 'close') {
        const job = cancelDnaExport(peerId, o.conversation_message_id);
        await job?.progressTail;
        await deleteByCmid(peerId, o.conversation_message_id);
        await answerEvent(o.event_id || o.id, o.user_id, peerId, job ? 'экспорт отменён' : 'закрыто');
        return;
    }
    if (['foc', 'foc:bell', 'foc:flat', 'bell', 'flat', 'det', 'mon', 'del1'].includes(action))
        cancelDnaExport(peerId, o.conversation_message_id);
    // кнопки фокус-сообщения: радиус родни 1–5, 🔔/🧬 в радиусе, «-+=» ветвь
    if (p && typeof p === "object" && (p.c === "foc" || p.c === "foc:bell" || p.c === "foc:tree" || p.c === "foc:flat")) {
        // герой — по сообщению (findRecordByCmid), не по payload-ключу:
        // свадьба «Имя+Имя Д» и старый стиль/примерные даты по ключу мимоходили
        const rec = await findRecordByCmid(peerId, o.conversation_message_id);
        if (!rec) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "персона не найдена");
            return;
        }
        const key = pkey(rec);
        const depth = focusDepth(linkPairs(peerId), focusSpousePairs(peerId), key);
        // радиус не глубже имеющихся предков (старые сообщения могут нести снятые кнопки)
        const radius = normalizeFocusRadius(p.r, depth);
        await answerEvent(o.event_id || o.id, o.user_id, peerId,
            p.c === "foc" ? focusLabel(radius)
                : (p.c === "foc:bell" ? "список " : (p.c === "foc:flat" ? "пачка ветви " : "древо ")) + focusLabel(radius));
        if (p.c === "foc:tree") {
            const head = focusHead(key, radius, rec.dd);
            const kb = await focusKeyboard(peerId, o.user_id, key, radius, depth);
            try {
                await exportFocused(o, head, key, radius, kb);
            } catch (e) {
                console.error("DNA export:", e);
                await editOrigin(o, head + "\n💥 Не удалось подготовить древо. Попробуйте ещё раз.", kb);
            }
            return;
        }
        // «-+=» на фокусе: роспись ВЕТВИ героя (.ged.txt) — вся глубина, герой
        // первой строкой; реплай правленной росписью на цитату заменяет ветвь
        if (p.c === "foc:flat") {
            const head = focusHead(key, radius, rec.dd);
            const kb = await focusKeyboard(peerId, o.user_id, key, radius, depth);
            if (!deps.withWorkerUpdate || source !== 'long_poll') await vkApi("messages.edit", { peer_id: peerId, conversation_message_id: o.conversation_message_id,
                message: head + "\n-+=⏳", keyboard: kb }).catch(e => console.error("flat loading:", e.message));
            try {
            const pack = await computeExport(peerId, 'branch', {}, key,
                { cmid: o.conversation_message_id, text: head + '\n-+=⏳', keyboard: kb });
            if (!pack) { await editOrigin(o, head + "\n(ветвь пуста)", kb); return; }
            const txt = focusHead(key, radius, rec.dd) + "\n" + pack;
            if (txt.length <= 4000) { await editOrigin(o, txt, kb); return; }
            // перелив: держ = голова, метка, обрезанные целые строки росписи
            // (до ~4000) и ✂️⏳ в конце; роспись — файлом, после прицепа — тот
            // же текст со ✂️ без часов (правка текста обязательно с
            // повторным attachment — ВК сбрасывает вложения у правки без них)
            const fh = focusHead(key, radius, rec.dd);
            const inner = cutLines(pack, 4000,
                fh.length + 1 + NOT_FOR_GRAFT.length + 1 + "\n✂️⏳".length, false);
            const holdTxt = fh + "\n" + NOT_FOR_GRAFT + "\n" + inner + "\n✂️⏳";
            const finalTxt = fh + "\n" + NOT_FOR_GRAFT + "\n" + inner + "\n✂️";
            await editOrigin(o, holdTxt, kb);
            try {
                const att = await vkUploadDoc(o.peer_id,
                    fileBaseOf(fh) + ".ged.txt", "\uFEFF" + pack);
                try {
                    await vkApi("messages.edit", {
                        peer_id: peerId, conversation_message_id: o.conversation_message_id,
                        attachment: att, keyboard: kb });
                    await vkApi("messages.edit", {
                        peer_id: peerId, conversation_message_id: o.conversation_message_id,
                        attachment: att, keyboard: kb, message: finalTxt });
                } catch (e2) {
                    console.error("foc:flat edit:", e2.message, "— отношу файлом");
                    try { await editOrigin(o, finalTxt, kb); } catch {}
                    await messagesSend(peerId, finalTxt, 0, 0, kb, att);
                }
                console.log("foc:flat doc:", att, "peer", peerId);
            } catch (e) {
                console.error("foc:flat doc upload:", e.message);
                await sendTailDoc(peerId, pack, fileBaseOf(fh), ".ged.txt", o.conversation_message_id);
                await editOrigin(o, finalTxt + "\n💥 Не удалось прикрепить файл к сообщению.", kb);
            }
            } catch (e) {
                if (deps.isWorkerCancelled?.(e)) return;
                console.error("flat export:", e);
                await editOrigin(o, head + "\n💥 Не удалось подготовить ветвь. Попробуйте ещё раз.", kb);
            }
            return;
        }
        // список всегда по ММ-ДД (сортировка подписки касается только дампа)
        const byFull = false;
        const head = focusHead(key, radius, rec.dd);
        const kb = await focusKeyboard(peerId, o.user_id, key, radius, depth);
        if (p.c === "foc") {
            await editOrigin(o, head, kb);
            return;
        }
        const loading = "🔔⏳";
        // Не используем fallback отправки для промежуточных часов.
        if (!deps.withWorkerUpdate || source !== 'long_poll') await vkApi("messages.edit", {
            peer_id: peerId, conversation_message_id: o.conversation_message_id,
            message: head + "\n" + loading, keyboard: kb
        }).catch(e => console.error("focus loading:", e.message));
        let text;
        try {
            text = await focusText(peerId, key, radius, rec.dd, byFull,
                { cmid: o.conversation_message_id, text: head + '\n' + loading, keyboard: kb });
        } catch (e) {
            if (deps.isWorkerCancelled?.(e)) return;
            console.error("focus list:", e);
            text = head + "\nНе удалось подготовить список. Попробуйте ещё раз.";
        }
        await editOrigin(o, text, kb);
        return;
    }
    // кнопки сообщения-юбилея: 👎 — удалить событие, 👀/🌙 — тоггл
    // детальности (как реакции 👀/снятие, но тапом; клавиатура едина с ТГ).
    // Запись резолвим по сообщению — findRecordByCmid, как у реакций: payload
    // несёт хранимый ключ (старый стиль/примерная дата), а свадьба «Имя+Имя Д»
    // и вовсе не персона — по ключу были ложные «Событие не найдено»
    if (p && typeof p === "object" && (p.c === "del1" || p.c === "det" || p.c === "mon")) {
        const rec = await findRecordByCmid(peerId, o.conversation_message_id);
        if (!rec) { await answerEvent(o.event_id || o.id, o.user_id, peerId, "Событие не найдено"); return; }
        const key = pkey(rec);
        if (p.c === "del1") {
            // связи персоны, свадьба пары «Имя+Имя», висячие кандидаты, семьи
            deleteEventCascade(peerId, key);
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "удалено");
            console.log("кнопка 👎: удалено событие", rec.n, rec.d, "peer", peerId);
            await editOrigin(o, "🗑 Событие удалено: " + rec.n + " " + rec.d,
                JSON.stringify({ inline: true, buttons: [] }));
            return;
        }
        // det — развернуть (кнопка 🌙), mon — сжать обратно (как снятие реакции)
        const detail = p.c === "det";
        const depth = focusDepth(linkPairs(peerId), focusSpousePairs(peerId), key);
        await answerEvent(o.event_id || o.id, o.user_id, peerId, detail ? "подробно" : "сжато");
        await editOrigin(o, jubileeText(rec, "", detail),
            await jubileeKeyboard(peerId, o.user_id, key, depth, detail, rec.n.includes("+")));
        return;
    }
    // нормализуем: {c} / {rel} либо строка "del" / "del:yes" / "rel:orth"
    const payload = typeof p === "object" ? (p.rel ? "rel:" + p.rel : String(p.c ?? "")) : p;
    console.log("event:", payload, "peer", peerId);
    if (!["del", "del:yes", "del:no", "bell", "flat", "tree", "close", "ged:rep", "ged:bak", "ged:ign"].includes(payload) && !payload.startsWith("rel:")) {
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "неизвестная кнопка");
        return;
    }
    // 🗑/❌ в групповом чате — только админ беседы или создатель сообщества
    if (peerId >= 2000000000 && ["del", "del:yes", "del:no"].includes(payload) && !(await isChatAdmin(peerId, o.user_id))) {
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "только владелец");
        return;
    }
    // «Нет / Да» на дроп: замена с резервом или отказ.
    // ged:bak остаётся для уже отправленных подтверждений живого дропа.
    // (в группе — только отправивший файл)
    if (payload === "ged:rep" || payload === "ged:bak" || payload === "ged:ign") {
        const emptyKeyboard = JSON.stringify({ inline: true, buttons: [] });
        const pend = gedPending.get(peerId);
        if (!pend || Date.now() - pend.ts > GED_TTL) {
            gedPending.delete(peerId);
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "файл не найден — перешлите .ged заново");
            return;
        }
        if (peerId >= 2000000000 && o.user_id !== pend.fromId) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "только отправивший файл");
            return;
        }
        gedPending.delete(peerId);
        // тост сразу: event_id у ВК живёт секунды, а замена большого древа
        // идёт дольше — поздний answerEvent ВК отвергает (100 invalid
        // event_id), и «вращение» висит на кнопке до конца работы
        await answerEvent(o.event_id || o.id, o.user_id, peerId,
            payload === "ged:ign" ? "не добавлено" : "идёт замена древа…");
        if (payload === "ged:ign") {
            await editOrigin(o, "Файл не добавлен: " + pend.name, emptyKeyboard);
            return;
        }
        await editOrigin(o, "Идёт замена древа: " + pend.name, emptyKeyboard);
        // роспись .ged.txt: ЗАМЕНА дерева чата (с резервом — прежнее дерево файлом)
        if (/\.ged\.txt$/i.test(pend.name)) {
            if (!(await sendTreeBackup(peerId))) {
                await editOrigin(o, "💥 Не удалось выложить резерв — замена отменена, прежнее дерево цело",
                    emptyKeyboard);
                return;
            }
            const tree = await parseImport(peerId, 'parse_flat', pend.text);
            if (getSettings(peerId).trim) trimImport(tree);
            clearChatTree(peerId);
            const rep = applyTree(peerId, tree);
            const parts = splitText(treeReport(rep));
            await editOrigin(o, parts[0], emptyKeyboard);
            for (const part of parts.slice(1)) await messagesSend(peerId, part);
            console.log("txt replace:", rep.persons, "персон,", rep.links, "детей, peer", peerId);
            return;
        }
        const g = await parseImport(peerId, 'parse_gedcom', pend.text);
        if (!g) {
            await editOrigin(o, "Файл не добавлен: " + pend.name + " (ждём GEDCOM в UTF-8)", emptyKeyboard);
            return;
        }
        const r = await replaceWithGedcom(peerId, getSettings(peerId).trim ? trimImport(g) : g, true);
        const parts = splitText(r.head);
        await editOrigin(o, parts[0], emptyKeyboard);
        for (const part of parts.slice(1)) await messagesSend(peerId, part);
        console.log("ged replace:", r.head, "peer", peerId);
        return;
    }
    if (payload === "del") {
        // подтверждение: список событий чата по полной дате ГГГГ-ММ-ДД + 🗑/❌
        // (🗑-радиус снят: удаление — только глобальное)
        const list = upcomingEvents(peerId, true); // по полной дате, со смертями
        if (!list) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "событий нет");
            return;
        }
        const head = "Удалить все события чата?";
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "подтвердите удаление");
        const kb = JSON.stringify({
            inline: true,
            buttons: [[
                { action: { type: "callback", label: "🗑", payload: JSON.stringify({ c: "del:yes" }) }, color: "secondary" },
                { action: { type: "callback", label: "❌", payload: JSON.stringify({ c: "del:no" }) }, color: "secondary" }
            ]]
        });
        // длинный список — голова + ✂️⏳, весь список — одним .txt-вложением
        // в это же сообщение (как «-+=» и .ged/.pdf), потом ⏳ снят (✂️ остаётся)
        if ((head + "\n" + list).length >= 4000) {
            const head0 = (head + "\n" + list).split("\n")[0];
            await editOrigin(o, NOT_FOR_GRAFT + "\n" + head0 + "\n✂️⏳", kb);
            await editOriginDoc(o, fileBaseOf(head0) + ".txt",
                "\uFEFF" + withGraftMark(head + "\n" + list), kb);
            try { await editOrigin(o, NOT_FOR_GRAFT + "\n" + head0 + "\n✂️", kb); } catch {}
            return;
        }
        await editOrigin(o, head + "\n" + list, kb);
    } else if (payload === "del:yes") {
        // глобальное удаление: дерево чата (персоны/свадьбы/связи/семьи) целиком
        const n = personRows(peerId).length + weddingRows(peerId).length;
        clearChatTree(peerId);
        console.log("deleted", n, "records peer", peerId);
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "удалено событий: " + n);
        await editOrigin(o, "Удалено событий: " + n + "\n" + helpText(getSettings(peerId)), await peerKeyboard(peerId, o.user_id));
    } else if (payload === "del:no") {
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "отмена удаления");
        await editOrigin(o, helpText(getSettings(peerId)), await peerKeyboard(peerId, o.user_id));
    } else if (payload === "bell") {
        // список событий (не родословная роспись -+=): всегда рендер по ММ-ДД,
        // без подписного переключения тапом; список начинается с сегодня —
        // что не влезает в сообщение, просто отрезаем (целые строки)
        // «от сегодня» (МСК) — MM-DD
        const { mo, d: dToday } = mskNowParts();
        const list = upcomingEvents(peerId, false,
            String(mo).padStart(2, "0") + "-" + String(dToday).padStart(2, "0"));
        if (!list) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "событий нет");
            const current = await cmidText(peerId, o.conversation_message_id);
            if (current !== null && current.replace(/\((fynny|trim)=[01]\)/g, '($1=0)') !== HELP)
                await editOrigin(o, "Событий нет", await peerKeyboard(peerId, o.user_id));
            return;
        }
        // снекбар останавливает «вращение» на кнопке
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "список событий");
        const shownList = cutLines(list, 4000);
        await editOrigin(o, shownList || "Событий нет", await peerKeyboard(peerId, o.user_id));
    } else if (payload === "flat") {
        // «-+=» — родословная роспись -+= древа чата: файлами .ged.txt и .ged.csv (зеркало ТГ:
        // sendFlatPack key=null) — правка этого сообщения «-+=⏳», вложение
        // правкой в него же (editOrigin без attachment сбросил бы вложение),
        // потом держатель → «-+=» (видимая метка — цитата живёт); клавиатура
        // (kb0) остаётся на сообщении; провал — правка «💥». Метка
        // NOT_FOR_GRAFT — первой строкой файла
        const kb0 = await peerKeyboard(peerId, o.user_id);
        const flat = await computeExport(peerId, 'flat', {}, undefined,
            { cmid: o.conversation_message_id, text: '-+=⏳', keyboard: kb0 });
        if (!flat) {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "древо пусто");
            if (source === 'long_poll') await editOrigin(o, 'Древо пусто', kb0);
            return;
        }
        await answerEvent(o.event_id || o.id, o.user_id, peerId, "пачка древа чата");
        try {
            await editOrigin(o, "-+=⏳", kb0);
            await sendChatFlatArtifacts(peerId, flat,
                { conversation_message_id: o.conversation_message_id }, kb0);
        } catch (e) {
            console.error("flat doc:", e.message);
            await editOrigin(o, "💥 Не удалось выложить файл «Древо чата.ged.txt»", kb0);
        }
    } else if (payload === "tree") {
        try { await exportWhole(o, await peerKeyboard(peerId, o.user_id)); }
        catch (e) {
            console.error('DNA export:', e);
            await editOrigin(o, '💥 Не удалось подготовить древо. Попробуйте ещё раз.', await peerKeyboard(peerId, o.user_id));
        }
    } else if (payload.startsWith("rel:")) {
        const key = payload.slice(4);
        if (!REL_DEFS[key]) return;
        const head = REL_DEFS[key].icon + " " + REL_DEFS[key].name + " дни";
        // календарь уже показан в этом сообщении (заголовок совпадает) — toggle,
        // иначе первый тап: показать календарь
        const cur = await cmidText(peerId, o.conversation_message_id);
        const shown = cur !== null && cur.split("\n", 1)[0] === head;
        if (shown) {
                const on = setChatSetting(peerId, key);
            // снекбар останавливает «вращение» на кнопке
            await answerEvent(o.event_id || o.id, o.user_id, peerId, on ? "🔔 включены" : "🔕 выключены");
            await editOrigin(o, head + "\n" + religiousYear(key), relKeyboard(peerId));
        } else {
            await answerEvent(o.event_id || o.id, o.user_id, peerId, "календарь на год");
            await editOrigin(o, head + "\n" + religiousYear(key), relKeyboard(peerId));
        }
    }
};
