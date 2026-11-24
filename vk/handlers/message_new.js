"use strict";
const { fileBaseOf } = require('../../tgcloud/lib/chart.cjs');
const { cutLines, flatHitKey, parseSearchQuery, searchHead, treeReport } = require('../../tgcloud/lib/flat.cjs');
const { gedStats, NOT_FOR_GRAFT, parseTrigger, withGraftMark } = require('../../tgcloud/lib/parse.cjs');
const { CHAT_SWITCH_COMMAND, CHAT_SWITCH_REPLY_ERROR, REPLY_TARGET_ERROR, TREE_EXPORT_COMMAND, chatSwitchText, exportReplyRadius, helpText } = require('../../tgcloud/lib/text.cjs');
const { focusDepth, normalizeFocusRadius, prepareReplySearch, searchChain, searchProgressHead, searchRadius } = require('../../tgcloud/lib/tree.cjs');

// «Начать» (payload {"command":"start"}) работает как «/»
const isStart = (text, payload) => {
    if (text.trim() === "/" || /^\/start(?:@[a-z0-9_]+)?$/i.test(text.trim())) return true;
    if (payload && typeof payload === "object") return payload.command === "start";
    return payload === "start";
};

module.exports = async (msg, { deps, peerId, source, groupId, ownerId }) => {
    const {
        applyTree, bellKeyboard, computeExport, cutAndGraft, editTrigger, parseImport,
        focusHead, focusSpousePairs, focusText, getSettings, handleGedDrop, handleTxtDrop, hasTree, holdAttach,
        isChatAdmin, linkPairs, markSeen, messagesSend, mskNowParts, ownerKeyboard, personRows, pkey,
        recordOf, relKeyboard, replaceWithGedcom, resolveReply, sendChatFlatArtifacts, sendFocus,
        sendGedcom, sendJubileeMsg, sendPdf, sendViewer, setChatSetting, splitText, unpay,
        upcomingEvents, upsertPerson, vkApi, vkUploadDoc, weddingRows,
    } = deps;
    if (source === "catch_up") {
        return handleMessage(peerId, String(msg.text || ""), msg.date, msg.id, msg.conversation_message_id);
    }
    if (msg.action) { // сервисное: вход/выход участника и т.п.
        console.log("action:", msg.action.type, "peer", peerId, "member", msg.action.member_id ?? "");
        if (msg.action.type === "chat_invite_user" && msg.action.member_id !== -groupId) {
            await messagesSend(peerId, helpText(getSettings(peerId)), 0, msg.conversation_message_id,
                (ownerId && msg.action.member_id === ownerId) ? ownerKeyboard() : bellKeyboard());
        }
        return;
    }
    // дроп .ged-документа → вопрос «Да/Нет» (до разбора текста:
    // сообщение может быть без текста, caption не разбираем)
    const gedDoc = (msg.attachments || []).filter(a => a && a.type === "doc" && a.doc)
        .map(a => a.doc).find(d => String(d.ext || "").toLowerCase() === "ged" || /\.ged$/i.test(String(d.title || "")));
    if (gedDoc) {
        await handleGedDrop(peerId, gedDoc, msg.id, msg.conversation_message_id, msg.from_id);
        return;
    }
    // дроп .ged.txt-документа с родословной росписью -+= (см. handleTxtDrop);
    // голый .txt — мимо (не разбираем, ждём .ged или .ged.txt)
    const txtDoc = (msg.attachments || []).filter(a => a && a.type === "doc" && a.doc)
        .map(a => a.doc).find(d => /\.ged\.txt$/i.test(String(d.title || "")));
    if (txtDoc) {
        await handleTxtDrop(peerId, txtDoc, msg.id, msg.conversation_message_id, msg.from_id, msg.reply_message || null);
        return;
    }
    if (!msg.text && !msg.payload) return;
    return handleMessage(peerId, String(msg.text || ""), msg.date, msg.id, msg.conversation_message_id, msg.from_id, unpay(msg.payload || ""), msg.reply_message || null);

    async function handleMessage(peerId, text, date, msgId, convMsgId, fromId = 0, payload = "", replyMsg = null) {
        const resolved = resolveReply(peerId, replyMsg);
        const originalReply = replyMsg;
        const searchInput = /^\//.test(String(text).trim().split(/\r?\n/).find(l => l.trim() && !l.trimStart().startsWith('#')) || "");
        const anchorInput = !searchInput && (String(text).split(/\r?\n/).some(l => /^\s*[-+=]/.test(l))
            || (String(text).split(/\r?\n/).length === 1 && parseTrigger(text)));
        if (process.env.LOG_UPDATES) console.log("msg from", peerId, ":", text);
        if (text.trim().startsWith("/")) console.log("команда:", JSON.stringify(text.trim()), "peer", peerId);
        if (date) markSeen(date);
        const setting = CHAT_SWITCH_COMMAND.exec(text.trim());
        if (setting && (!originalReply || setting[2] === "0")) {
            if (originalReply) await messagesSend(peerId, CHAT_SWITCH_REPLY_ERROR, msgId, convMsgId);
            else {
                const key = setting[1].toLowerCase(), enabled = setting[2] === "1";
                setChatSetting(peerId, key, enabled);
                await messagesSend(peerId, chatSwitchText(key, enabled), msgId, convMsgId);
            }
            return;
        }
        const exportCommand = TREE_EXPORT_COMMAND.exec(text.trim());
        const scopedCommand = isStart(text, payload) || exportCommand
            || /^\/(?:bell[1-5]?|links)(?:@\S+)?$/i.test(text.trim())
            || text.trim().toLowerCase() === "связи";
        let ged;
        const getGed = async () => ged === undefined ? (ged = await parseImport(peerId, 'parse_gedcom', text)) : ged;
        if (originalReply && (scopedCommand || anchorInput) && !await getGed()) {
            if (!resolved) {
                await messagesSend(peerId, REPLY_TARGET_ERROR, msgId, convMsgId);
                return;
            }
        }
        if (isStart(text, payload)) {
            // «/» ответом на триггер — фокус-сообщение с радиусом родни
            // (заголовок фокуса «2 Имя ГГГГ-ММ-ДД» — цифру радиуса снимаем)
            if (resolved) {
                const rec = resolved;
                if (rec) {
                    await sendFocus(peerId, rec.n + " " + rec.d, msgId, convMsgId, fromId, rec.dd);
                    return;
                }
            }
            let kb;
            if (peerId < 2000000000) kb = relKeyboard(peerId);
            else kb = (await isChatAdmin(peerId, fromId)) ? ownerKeyboard() : bellKeyboard();
            await messagesSend(peerId, helpText(getSettings(peerId)), msgId, convMsgId, kb);
            return;
        }
        const t = text.trim().toLowerCase();
        const tm = t.match(/^\/trim([01])(?:@[a-z0-9_]+)?$/);
        if (tm) {
            const mode = Number(tm[1]);
            setChatSetting(peerId, "trim", !!mode);
            await messagesSend(peerId, "Импорт: " + (mode ? "инициалы, без мест и примечаний." : "полные данные."), msgId, convMsgId);
            return;
        }
        const fm = t.match(/^\/fynny([01])(?:@[a-z0-9_]+)?$/);
        if (fm) {
            const mode = Number(fm[1]);
            setChatSetting(peerId, "fynny", !!mode);
            await messagesSend(peerId, "Родство: " + (mode ? "цепочки." : "обычные названия."), msgId, convMsgId);
            return;
        }
        if (exportCommand) {
            const format = exportCommand[1].toLowerCase();
            const hold = source !== 'long_poll' && await messagesSend(peerId, (format === 'pdf' ? '🖨️' : format === 'epub' || format === 'html' ? '📖' : '🧬') + '⏳', msgId, convMsgId);
            try {
            const radius = exportReplyRadius(exportCommand[2], replyMsg?.from_id < 0 ? replyMsg.text : null);
            if (resolved) {
                const skey = pkey(resolved);
                const rows = personRows(peerId);
                const hero = rows.find(p => pkey(p) === skey);
                if (!hero && format !== 'gedcom') {
                    await messagesSend(peerId, REPLY_TARGET_ERROR, msgId, convMsgId);
                    return;
                }
                const pairs = linkPairs(peerId), spouses = focusSpousePairs(peerId);
                const r = normalizeFocusRadius(radius, focusDepth(pairs, spouses, skey));
                const head = focusHead(skey, r, resolved.dd);
                if (format === 'pdf') {
                    await sendPdf(peerId, head, skey, r, msgId, convMsgId);
                    return;
                }
                if (format === 'epub' || format === 'html') {
                    await sendViewer(format, peerId, undefined, head, skey, hero.xref, msgId, convMsgId);
                    return;
                }
                await sendGedcom(peerId, undefined, head, msgId, convMsgId, { heroKey: skey, radius: r, scoped: true });
                console.log("focus text:", skey, "радиус", r, "peer", peerId);
                return;
            }
            if (!hasTree(peerId)) { await messagesSend(peerId, "связей пока нет", msgId, convMsgId); return; }
            if (format === 'epub' || format === 'html') {
                await sendViewer(format, peerId, undefined, 'Древо чата', null, null, msgId, convMsgId);
                return;
            }
            if (format === 'pdf') { await sendPdf(peerId, 'Древо чата', null, null, msgId, convMsgId); return; }
            await sendGedcom(peerId, undefined, "Древо чата", msgId, convMsgId);
            return;
            } catch (e) {
                if (deps.isWorkerCancelled?.(e)) throw e;
                console.error('tree export:', e.message);
                await messagesSend(peerId, 'Не удалось подготовить файл.', msgId, convMsgId);
                return;
            } finally {
                if (hold) {
                    try {
                        const result = await vkApi('messages.delete', { peer_id: peerId, message_ids: hold, delete_for_all: 1 });
                        if (!(result?.[hold] === 1 || result?.[0]?.response === 1 || result === 1))
                            throw new Error('Не удалось удалить индикатор экспорта');
                    } catch {
                        await vkApi('messages.edit', { peer_id: peerId, message_id: hold, message: 'Экспорт завершён.' })
                            .catch(e => console.error('export progress:', e.message));
                    }
                }
            }
        }
        // /bellN (в ответ на триггер): список родни в радиусе N — как тап 🔔 на
        // фокусе; без reply — весь список чата (как 🔔 чата), не влезает —
        // отрезаем (целые строки)
        const bm = t.match(/^\/bell([1-5])?(?:@\S+)?$/);
        if (bm) {
            const sent = await messagesSend(peerId, "🔔⏳", msgId, convMsgId);
            const finish = async text => {
                if (sent) {
                    try { await vkApi("messages.edit", { peer_id: peerId, message_id: sent, message: text }); return; }
                    catch (e) { console.error("bell edit:", e.message); }
                }
                await messagesSend(peerId, text, msgId, convMsgId);
            };
            try {
            const radius = Number(bm[1]) || 1;
            if (resolved) {
                const rec = resolved;
                if (rec) {
                    const skey = rec.n + " " + rec.d; // показанный ключ → хранимый
                    // как тап: радиус не глубже имеющихся связей
                    const r = normalizeFocusRadius(radius, focusDepth(linkPairs(peerId), focusSpousePairs(peerId), skey));
                    const txt = await focusText(peerId, skey, r, rec.dd);
                    await finish(txt);
                    console.log("bell text:", skey, "радиус", r, "peer", peerId);
                    return;
                }
            }
            const { mo, d: dToday } = mskNowParts();
            const list = upcomingEvents(peerId, false,
                String(mo).padStart(2, "0") + "-" + String(dToday).padStart(2, "0"));
            // как у 🔔 чата: список «от сегодня» одним сообщением — что не
            // влезает, отрезаем (целые строки)
            const shownList = cutLines(list || "", 4000);
            await finish(shownList || "Событий нет");
            console.log("bell chat:", (list ? list.split("\n").length : 0) + "->" + shownList.split("\n").length, "строк, peer", peerId);
            return;
            } catch (e) {
                if (deps.isWorkerCancelled?.(e)) {
                    if (sent) await vkApi('messages.delete', { peer_id: peerId, message_ids: sent, delete_for_all: 1 }).catch(() => {});
                    throw e;
                }
                console.error("bell text:", e.message);
                await finish("Не удалось подготовить список. Попробуйте ещё раз.");
                return;
            }
        }
        // «/links» (в ТГ — кнопка 🔗 под событием): роспись ВЕТВИ героя — как тап
        // «-+=» на фокусе (>4000 — вложением); без reply — роспись
        // древа чата (листинг сообщений-связей не восстанавливается)
        if (/^\/links(?:@\S+)?$/i.test(t) || t === "связи") {
            let key = null, head = "";
            if (resolved) {
                const rec = resolved;
                if (rec) { key = rec.n + " " + rec.d; head = focusHead(key, 1, rec.dd); } // показанный ключ → хранимый
            }
            const sent = await messagesSend(peerId, (head ? head + "\n" : "") + "-+=⏳", msgId, convMsgId);
            const edit = message => vkApi("messages.edit", { peer_id: peerId, message_id: sent, message });
            try {
            const pack = await computeExport(peerId, key ? 'branch' : 'flat', {}, key);
            if (!pack) { await edit(key ? "ветвь пуста" : "связей пока нет"); return; }
            if (!key) {
                // роспись радиуса — ВСЕГДА файлом (зеркало ТГ sendFlatPack key=null):
                // «-+=⏳» ответом с цитатой на команду (⏳ = «выполняю, подождите»),
                // затем ОДНА комбинированная правка того же сообщения — часы
                // сняты, метка «-+=» и файл в нём же (комбинированная правка
                // message+attachment по message_id применяет и текст, и вложение;
                // цитата при ней исчезает — принято); повтор при ошибке; провал
                // выкладки — текстовая правка «💥». Метка NOT_FOR_GRAFT —
                // первой строкой файла (роспись радиуса прививке не подлежит)
                void sendChatFlatArtifacts(peerId, pack, { message_id: sent }, null, "links");
            } else if (head.length + 1 + pack.length > 4000) {
                // голова + ✂️⏳ первым сообщением (полное — в файле); ВСЯ роспись —
                // файлом асинхронно: upload долгий, ответ — сразу; файл правкой
                // приклеивается к тому же сообщению (⏳ снят, ✂️ остаётся),
                // мимо — отдельным сообщением
                const head0 = head || "Древо чата";
                // перелив: порядок строк — герой, метка (правило у NOT_FOR_GRAFT)
                const ngHead0 = head0 + "\n" + NOT_FOR_GRAFT;
                await edit(ngHead0 + "\n✂️⏳");
                (async () => {
                    try {
                        // ветвь — полная роспись («-+=») без метки; древо чата метку
                        // уже несёт (chatFlatText)
                        const att = await vkUploadDoc(peerId,
                            fileBaseOf(head0) + ".ged.txt", "\uFEFF" + pack);
                        try {
                            await vkApi("messages.edit", {
                                peer_id: peerId, message_id: sent, attachment: att });
                            // правка без attachment сбрасывает вложения — повторяем
                            await vkApi("messages.edit", {
                                peer_id: peerId, message_id: sent, attachment: att,
                                message: ngHead0 + "\n✂️" });
                        } catch (e) {
                            console.error("links edit:", e.message, "— отношу файлом");
                            try { await vkApi("messages.edit", {
                                peer_id: peerId, message_id: sent, message: ngHead0 + "\n✂️" }); } catch {}
                            await messagesSend(peerId, head0, msgId, convMsgId, null, att);
                        }
                        console.log("links doc:", att, "peer", peerId);
                    } catch (e) {
                        console.error("links doc upload:", e.message);
                        await edit(ngHead0 + "\n💥 Не удалось выложить роспись.").catch(() => {});
                    }
                })();
            } else {
                await edit((head ? head + "\n" : "") + pack);
            }
            } catch (e) {
                if (deps.isWorkerCancelled?.(e)) {
                    if (sent) await vkApi('messages.delete', { peer_id: peerId, message_ids: sent, delete_for_all: 1 }).catch(() => {});
                    throw e;
                }
                console.error("links flat pack:", e.message);
                const error = "Не удалось подготовить роспись. Попробуйте ещё раз.";
                await edit(error).catch(() => messagesSend(peerId, error, msgId, convMsgId));
            }
            console.log("links flat pack:", key || "chat", "peer", peerId);
            return;
        }
        // /Иван — префиксный поиск по родословной росписи -+= (/-Пётр — только
        // мужчины глубины 0, /--Иван — глубины 1, /=… — женщины); "/ текст" —
        // подстрока. В reply — события родни героя, включая неточные даты.
        if (searchInput) {
            const q = text.trim();
            let parsed;
            try { parsed = parseSearchQuery(q); }
            catch (e) {
                await messagesSend(peerId, e.message, msgId, convMsgId);
                return;
            }
            const replySearch = !!originalReply;
            if (replySearch && (!resolved || !resolved.xref || resolved.n.includes("+"))) {
                await messagesSend(peerId, REPLY_TARGET_ERROR, msgId, convMsgId);
                return;
            }
            const plan = replySearch ? prepareReplySearch(parsed, getSettings(peerId).fynny) : null;
            const chain = plan?.chain ?? searchChain(parsed, false);
            const radius = plan?.radius ?? searchRadius(parsed, chain);
            if (plan?.error) {
                await messagesSend(peerId, plan.error, msgId, convMsgId);
                return;
            }
            if (replySearch) {
                const fullHead = searchProgressHead(radius, chain, parsed, plan.decomposition);
                const head = fullHead.length > 2500
                    ? searchProgressHead(radius, chain, parsed) + '\nПолное разложение — в файле.' : fullHead;
                if (head.length + NOT_FOR_GRAFT.length + 40 > 4000) {
                    await messagesSend(peerId, "Ошибка поискового запроса: слишком длинный заголовок", msgId, convMsgId);
                    return;
                }
                const sent = await messagesSend(peerId, head + "\n⏳", msgId, convMsgId);
                try {
                    const hits = await computeExport(peerId, 'focus_search', { heroKey: pkey(resolved), radius },
                        { weddings: weddingRows(peerId), query: parsed });
                    const found = hits.join("\n");
                    const prefix = head + "\n" + NOT_FOR_GRAFT;
                    if (fullHead !== head || (found && prefix.length + 1 + found.length >= 4000)) {
                        const inner = cutLines(found, 4000, prefix.length + 1 + "\n✂️⏳".length);
                        const body = prefix + (inner ? "\n" + inner : "");
                        const holdTxt = body + "\n✂️⏳", finalTxt = body + "\n✂️";
                        await vkApi("messages.edit", { peer_id: peerId, message_id: sent, message: holdTxt });
                        await holdAttach(peerId, "search", sent, holdTxt, finalTxt,
                            fileBaseOf(searchHead(q, hits.length)) + ".txt", "\uFEFF" + fullHead + '\n' + NOT_FOR_GRAFT + "\n" + (found || 'Ничего не найдено'),
                            null, head, msgId, convMsgId);
                    } else {
                        await vkApi("messages.edit", { peer_id: peerId, message_id: sent,
                            message: found ? prefix + "\n" + found : head + "\nНичего не найдено" });
                    }
                } catch (e) {
                    if (deps.isWorkerCancelled?.(e)) {
                        if (sent) await vkApi('messages.delete', { peer_id: peerId, message_ids: sent, delete_for_all: 1 }).catch(() => {});
                        throw e;
                    }
                    console.error("reply search:", e);
                    await vkApi("messages.edit", { peer_id: peerId, message_id: sent,
                        message: head + "\nНе удалось выполнить поиск" });
                }
                return;
            }
            let hits;
            try { hits = await computeExport(peerId, 'flat_search', {}, parsed); }
            catch (e) {
                if (deps.isWorkerCancelled?.(e)) throw e;
                console.error('flat search:', e.message);
                await messagesSend(peerId, 'Не удалось выполнить поиск. Попробуйте ещё раз.', msgId, convMsgId);
                return;
            }
            if (hits.length) {
                // ровно одно попадание, резолвящееся в персону, — сжатый юбилей
                // с клавиатурой-юбилеем (триггера нет — реплаить не на что, новое
                // сообщение); нерезолвимое (свадьба, заглушка, тёзки) —
                // списком/файлом как прежде
                if (hits.length === 1) {
                    const key = flatHitKey(hits[0], personRows(peerId));
                    const rec = key ? recordOf(peerId, key) : null;
                    if (rec) {
                        await sendJubileeMsg(peerId, rec, "", msgId, convMsgId, fromId);
                        console.log("flat search:", JSON.stringify(q), "-> юбилей", key, "peer", peerId);
                        return;
                    }
                }
                console.log("результат готов:", hits.length, "строк");
                // частые имена (Андрей) длиннее лимита ВК — файлом, как /links
                // (ТГ: sendLong делает то же)
                const found = hits.join("\n");
                if (found.length >= 4000) {
                    // заголовок + ✂️⏳, ВЕСЬ список — файлом асинхронно (upload
                    // долгий, ответ — сразу); файл правкой в то же сообщение
                    // (⏳ снят, ✂️ остаётся)
                    const head = searchHead(q, hits.length);
                    // целые строки до ~4000 знака — в текст (как у 🧬-перелива),
                    // остальное — в файл; текст — только метка (без «Найдено…»),
                    // имя файла — из head; ✂️⏳ → после прицепа ✂️ (⏳ снят)
                    const inner = cutLines(found, 4000, NOT_FOR_GRAFT.length + 1);
                    const holdTxt = NOT_FOR_GRAFT + (inner ? "\n" + inner : "") + "\n✂️⏳";
                    const finalTxt = NOT_FOR_GRAFT + (inner ? "\n" + inner : "") + "\n✂️";
                    const sent = await messagesSend(peerId, holdTxt, msgId, convMsgId);
                    holdAttach(peerId, "search", sent, holdTxt, finalTxt,
                        fileBaseOf(head) + ".txt", "\uFEFF" + withGraftMark(found),
                        null, head, msgId, convMsgId);
                } else {
                    await messagesSend(peerId, NOT_FOR_GRAFT + "\n" + found, msgId, convMsgId);
                }
                return;
            }
            await messagesSend(peerId, "Ничего не найдено", msgId, convMsgId);
            return;
        }
        // цитата для родословной росписи -+=: ветвь цитируемого срезана, роспись привита
        const replyHead = resolved;
        // сообщение-гедком → замена древа (до разбора триггеров); не пустой чат —
        // сначала автоматический резерв прежнего дерева файлом
        const g = await getGed();
        if (g) {
            const st = gedStats(g);
            if (st.persons || st.links) {
                const r = await replaceWithGedcom(peerId, g, true);
                for (const part of splitText(r.head)) await messagesSend(peerId, part, msgId, convMsgId);
                return;
            }
            // гедком без персон с датами — молчим, дальше как триггеры
        }
        // родословная роспись -+=: строки с маркерами '-'/'=' (глубина), «+дата»/«+»
        // (свадьбы) и безмарковыми именами вторых половин — весь разбор одним
        // сообщением; в ответе сводка + ошибки построчно. В ответе на триггер —
        // резка-прививка: ветвь цитируемого срезана, роспись (герой = цитируемый,
        // ветвь целиком) привита; мимо цитаты — добавление merger'ем. (ТГ: handlers/message.js)
        const lines0 = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        if (lines0.some(l => /^[-+=]/.test(l))) {
            const tree = await parseImport(peerId, 'parse_flat', text);
            if (tree.persons.length || tree.errors.length) {
                // в ответе на триггер — ветвь цитируемого заменяется росписью
                let anchor = null;
                if (replyHead) {
                    const sh = resolved;
                    if (sh) anchor = sh.n + " " + sh.d;
                }
                const rep = anchor ? cutAndGraft(peerId, anchor, tree) : applyTree(peerId, tree);
                const body = treeReport(rep);
                for (const part of splitText(body)) await messagesSend(peerId, part, msgId, convMsgId);
                console.log("tree:", rep.cut !== undefined ? "срезано " + rep.cut + ", " : "", rep.persons, "персон,", rep.fams, "семей,", rep.links, "детей,", rep.errors.length, "ошибок, peer", peerId);
                return;
            }
        }
        // поштучного ввода детей больше нет: ребёнок/ветвь добавляется родословной
        // росписью -+= в ответе на героя (cutAndGraft выше)
        const lines = String(text).split(/\s*\n+\s*/).filter(Boolean);
        // точечная правка: одна строка без маркера в ответе на триггер (сообщение
        // пользователя) — ПОЛНАЯ замена записи цитируемого (пол не трогается,
        // ветвь и связи целы); якорь не персона — правки нет, обычный ввод
        // (ТГ-копия: tgcloud/handlers/message.js)
        if (lines.length === 1 && replyHead) {
            const parsed = parseTrigger(lines[0]);
            if (parsed && !parsed.error) {
                const sh = resolved;
                const anchor = sh ? sh.n + " " + sh.d : "";
                const ed = editTrigger(peerId, anchor,
                    Object.assign({}, parsed.rec, parsed.tail ? { note: parsed.tail } : {}));
                if (ed) {
                    if (ed.error) {
                        await messagesSend(peerId, "💥 " + lines[0] + "\n" + ed.error, msgId, convMsgId);
                        return;
                    }
                    await sendJubileeMsg(peerId, ed.rec, parsed.note, msgId, convMsgId, fromId);
                    console.log("edit:", anchor, "->", ed.rec.n, ed.rec.d, "peer", peerId);
                    return;
                }
            }
        }
        for (const line of lines) {
            const parsed = parseTrigger(line);
            if (!parsed) continue; // не триггер — молчим
            if (parsed.error) {
                await messagesSend(peerId, "💥 " + line + "\n" + parsed.error, msgId, convMsgId);
                continue;
            }
            upsertPerson(peerId, parsed.rec);
            await sendJubileeMsg(peerId, parsed.rec, parsed.note, msgId, convMsgId, fromId);
            console.log("record:", parsed.rec.n, parsed.rec.d, "peer", peerId);
        }
    }
};
