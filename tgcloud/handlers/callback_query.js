import { api, db, InputFile } from 'sdk';
import { and, eq } from 'sdk/db';
import { settings, gedDrops, focusView } from '../schema.js';
import { jubileeText } from '../lib/text.js';
import { parseGedcom, parseTree } from '../lib/parse.cjs';
import { fileBaseOf } from '../lib/chart.cjs';
import { sendFlatPack } from '../lib/bot.js';
import { REL_DEFS, religiousYear } from '../lib/religion.cjs';
import {
    HELP, GED_TTL, relMarkup, getSettings, startMarkup, chatAdmin, jubileeMarkup, branchFlatText,
    recordOf, recordByXref, setLinkCand, confirmPair, linkText, linkMarkup, gedcomText, sendLong,
    deleteEventCascade, replaceWithGedcom, clearChatTree, deleteLink, setIndiSex, toggleAdopted,
    linkById, linkPairs, xrefOfKey, personRows, weddingRows, sendTreeBackup,
    NOT_FOR_GRAFT, cutLines,
    upcomingText, mmddToday, focusKeys, focusHasPair, focusHead, focusLabel, focusMarkup, splitText,
    focusWithSpouses, focusListKeys, focusSpousePairs, focusListText, focusDepth, sendGedPdf,
    applyTree, cutAndGraft, treeReport, hasTree,
} from '../lib/bot.js';

export default async function (cq, ctx) {
    const chatId = cq.message?.chat?.id;
    const data = cq.data || "";
    const answer = (text, alert) =>
        api.answerCallbackQuery({ callback_query_id: cq.id, text, show_alert: !!alert }).catch(() => {});
    const editMarkup = markup =>
        api.editMessageReplyMarkup({ chat_id: chatId, message_id: cq.message.message_id, reply_markup: markup }).catch(() => {});
    // как editOrigin в VK: при неудачной правке (сообщение старое/удалено) —
    // новым сообщением; «message is not modified» (повторное нажатие) глушим
    const editText = (text, markup, parseMode) =>
        api.editMessageText({ chat_id: chatId, message_id: cq.message.message_id, text, parse_mode: parseMode, reply_markup: markup })
            .catch(e => {
                if (e && /not modified/i.test(e.description || e.message || "")) return;
                console.error("editMessageText:", e.message, "— отправляю сообщением");
                return api.sendMessage({ chat_id: chatId, text, reply_markup: markup }).catch(() => {});
            });

    // большой текст — ВЕСЬ текст одним файлом: «.ged.txt» (роспись древа) либо
    // «.txt» (список событий); не выложился — ошибка. Файл — ответом на то же
    // сообщение (к которому кнопки), а не отдельным; после выкладки — правка:
    // ⏳ снимается, ✂️ остаётся (признак «не влезло — полное в файле»);
    // finalText — сообщение с ✂️
    const tailDoc = async (text, nameBase, ext = ".ged.txt", finalText = null, markup = undefined) => {
        const base = fileBaseOf(nameBase || "Продолжение") + ext;
        // BOM и метка «не для прививки»; если роспись уже несёт метку — не двоим
        const content = "\uFEFF" + (text.trimStart().toLowerCase()
            .startsWith(NOT_FOR_GRAFT.toLowerCase())
            ? text : NOT_FOR_GRAFT + "\n" + text);
        try {
            await api.sendDocument({
                chat_id: chatId,
                document: new InputFile(new TextEncoder().encode(content), base,
                    { type: "text/plain" }),
                reply_parameters: { message_id: cq.message.message_id, allow_sending_without_reply: true },
            });
            if (finalText !== null)
                await api.editMessageText({ chat_id: chatId,
                    message_id: cq.message.message_id, text: finalText, reply_markup: markup });
            return;
        } catch (e) {
            console.error("tail document:", e.message);
            if (finalText !== null) {
                await editText(finalText + "\n💥 Не удалось выложить файл.", markup);
                return;
            }
            await api.sendMessage({ chat_id: chatId,
                text: "💥 Не удалось выложить файл " + base });
        }
    };

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

    // сообщение со справкой (/start) редактировать нельзя — только тост;
    // в остальных (со списком событий) при пустом списке стираем показанное
    const isHelp = cq.message?.text === HELP;

    if (data === "bell") {
        // список событий (.txt): всегда рендер по ММ-ДД, без подписного
        // переключения тапом; список начинается с сегодня — что не влезает
        // в сообщение, просто отрезаем
        // список событий: круговой порядок «от сегодня» (как religiousYear)
        const list = await upcomingText(chatId, false, mmddToday());
        if (!list) {
            if (!isHelp) await editText("Событий нет", cq.message.reply_markup);
            await answer("Событий нет");
            return;
        }
        await answer("список событий");
        // список в этом же сообщении, клавиатура с той же подпиской
        const markup = await startMarkup(cq.message.chat, await chatAdmin(cq.message.chat, cq.from?.id),
            chatId, await getSettings(chatId));
        // целые строки, суммарно не превышающие лимит сообщения
        const shownList = cutLines(list, 4000);
        await editText(shownList || "Событий нет", markup);
        return;
    }

    if (data === "flat") {
        // «-+=» — родословная роспись -+= древа чата: ВСЕГДА файлом .ged.txt — правка
        // этого сообщения «⏳», файл ответом на него, потом ⏳ → невидимый
        // символ (sendFlatPack с key=null; клавиатура остаётся на сообщении)
        const markup = await startMarkup(cq.message.chat, await chatAdmin(cq.message.chat, cq.from?.id),
            chatId, await getSettings(chatId));
        await answer("пачка древа чата");
        const ok = await sendFlatPack(chatId, null, "", 0,
            { edit: { message_id: cq.message.message_id, markup } });
        if (!ok) await answer("древо пусто");
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

    // строка focus_view по сообщению с кнопками
    const fvOf = async () =>
        (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all())
            .find(r => r.messageId === cq.message?.message_id);

    // события чата записями {n,d,h,m,dd} (персоны + свадьбы);
    // 🔔-ветки (bell/focbell) — без примерных дат (список оповещений)
    const items = async () => [...await personRows(chatId), ...await weddingRows(chatId)];
    const bellItems = async () => (await items()).filter(r => !r.abt && !r.dabt && !r.mabt);
    // пол по ключу «Имя Д» (ярлыки родства)
    const sexOf = async () => (rows => k => (rows.find(r => r.n + " " + r.d === k) || {}).sex ?? null)
        (await personRows(chatId));
    // Метаданные радиуса без построения списка: часы показываем до обхода родни.
    const radiusOf = async (key, fvRadius) => {
        const pairs = await linkPairs(chatId);
        const spPairs = await focusSpousePairs(chatId);
        const depth = Math.max(1, focusDepth(pairs, spPairs, key));
        const r = Math.min(fvRadius, depth);
        return [r, pairs, spPairs, depth];
    };

    if (data === "del") {
        // список подтверждения — по полной дате ГГГГ-ММ-ДД (🔔 — по ММ-ДД)
        const list = await upcomingText(chatId, true);
        if (!list) {
            if (!isHelp) await editText("Событий нет", cq.message.reply_markup);
            await answer("Событий нет");
            return;
        }
        await answer("подтвердите удаление");
        const head = "Удалить все события чата?";
        // как в VK: подтверждение с показом списка событий; длинный — весь
        // список одним файлом <имя>.ged.txt (правка исходного — короткая пометка)
        const full = head + "\n" + list;
        const delKb = {
            inline_keyboard: [[
                { text: "🗑 удалить всё", callback_data: "del:yes" },
                { text: "❌ отмена", callback_data: "del:no" },
            ]]
        };
        if (full.length > 4000) {
            // список — .txt (не древо); голова + ✂️⏳, весь список — файлом
            // ответом на это же сообщение, потом ⏳ снят (✂️ остаётся)
            await editText(full.split("\n")[0] + "\n✂️⏳", delKb);
            await tailDoc(NOT_FOR_GRAFT + "\n" + full, full.split("\n")[0], ".txt",
                NOT_FOR_GRAFT + "\n" + full.split("\n")[0] + "\n✂️");
            return;
        }
        await editText(full, delKb);
        return;
    }

    if (data === "del:yes") {
        // глобальное удаление: дерево чата (персоны/свадьбы/связи/семьи) целиком,
        // настройки остаются; как в VK: HELP и клавиатура возвращаются
        const n = (await items()).length;
        await clearChatTree(chatId);
        await editText("Удалено событий: " + n + "\n" + HELP,
            await startMarkup(cq.message.chat, await chatAdmin(cq.message.chat, cq.from?.id),
                chatId, await getSettings(chatId)));
        await answer("🗑 События чата удалены");
        return;
    }

    if (data === "del:no") {
        // вернуть справку и клавиатуру по чату/роли: религии — только в личке
        const isAdmin = await chatAdmin(cq.message.chat, cq.from?.id);
        await editText(HELP, startMarkup(cq.message.chat, isAdmin, chatId, await getSettings(chatId)));
        await answer("Отменено");
        return;
    }

    if (data === "close") {
        await editMarkup(undefined);
        await answer();
        return;
    }

    if (data.startsWith("del1:")) {
        // 👎 — удалить событие правкой сообщения (как реакция 👎 в VK-боте);
        // xref — персоны (INDI) либо fam-пары (свадьба/развод)
        const xref = data.slice(5);
        const rec = await recordByXref(chatId, xref);
        if (!rec) { await answer("Событие не найдено"); return; }
        // связи персоны, свадьба пары «Имя+Имя», висячие кандидаты, семьи
        await deleteEventCascade(chatId, rec.n + " " + rec.d);
        await editText("🗑 Событие удалено: " + rec.n + " " + rec.d, undefined);
        await answer();
        console.log("deleted:", rec.n, rec.d, "xref", xref, "chat", chatId);
        return;
    }

    if (data.startsWith("det:") || data.startsWith("mon:")) {
        // 👀/🌙 — тоггл детальности правкой сообщения (подпись кнопки —
        // состояние: 👀 на сжатом, 🌙 на подробном); xref — персоны (INDI)
        // либо fam-пары (свадьба/развод)
        const xref = data.slice(4);
        const rec = await recordByXref(chatId, xref);
        if (!rec) { await answer("Событие не найдено"); return; }
        const expand = data.startsWith("det:");
        const depth = focusDepth(await linkPairs(chatId), await focusSpousePairs(chatId), rec.n + " " + rec.d);
        // строка focusView по id сообщения — чтобы foc*/focbell/foctree
        // работали и на развёрнутом отчёте, и на сжатом юбилее (радиус 1)
        await db.delete(focusView).where(and(eq(focusView.chatId, chatId), eq(focusView.messageId, cq.message.message_id))).run();
        await db.insert(focusView).values({
            chatId, messageId: cq.message.message_id, pkey: rec.n + " " + rec.d, radius: 1, ts: Date.now(),
        }).run();
        if (expand) { // детализировать + кнопки остаются (ряд 2 с 🌙)
            await editText(jubileeText(rec, "", true),
                jubileeMarkup(xref, depth, true, rec.n.includes("+")), 'HTML');
        } else { // 🌙 сворачивает обратно (как снятие реакции в VK)
            await editText(jubileeText(rec, "", false), jubileeMarkup(xref, depth, false, rec.n.includes("+")), 'HTML');
        }
        await answer(expand ? "подробно" : "сжато");
        return;
    }

    // 🧬 — гедком-древо чата (как /gedcom); /start править нельзя — тост.
    // «🧬⏳» на сообщении (клавиатура остаётся), прицепы — медиа-группой
    // ответом на это сообщение; по готовности — «🧬»
    if (data === "tree") {
        if (!(await hasTree(chatId))) {
            await answer("связей пока нет");
            return;
        }
        await answer("гедком-древо чата");
        const kb = cq.message.reply_markup;
        await editText("🧬⏳", kb);
        await sendGedPdf(chatId, undefined, "🧬 Гедком-древо чата", null, cq.message.message_id, kb);
        return;
    }

    // кнопки сообщения-связи: пол нового лица (♂/♀), свадьба (Да/Нет, 1 2…),
    // 👎 — удалить связь
    if (data.startsWith("sex:") || data.startsWith("pair:") || data.startsWith("adop:") || data.startsWith("dell:")) {
        const [act, idStr, arg] = data.split(":");
        const link = await linkById(chatId, Number(idStr));
        if (!link) { await answer("связь не найдена"); return; }
        if (act === "sex") {
            const xref = await xrefOfKey(chatId, link[link.who === 'p' ? 'p' : 'c']);
            if (xref) await setIndiSex(chatId, xref, arg);
            await answer("пол: " + (arg === 'F' ? "♀" : "♂"));
        } else if (act === "adop") {
            const on = await toggleAdopted(chatId, link);
            link.adopted = on;
            await answer(on ? "🤱 усыновление" : "усыновление снято");
        } else if (act === "pair") {
            const i = Number(arg);
            let fragKeys = [link.p, link.c];
            const cand = link.pairCand;
            if (i >= 0 && cand && cand[i]) {
                const f = await confirmPair(chatId, link, cand[i]);
                await answer(f && f.marr ? "💍 " + f.marr.d + (f.marr.plac ? ", " + f.marr.plac : "") : "не найдено");
                if (f) fragKeys = [...f.parents, ...f.children]; // все трое
            } else {
                await setLinkCand(link, null);
                await answer("без свадьбы");
            }
            const fresh = await linkById(chatId, link.id);
            if (fresh) await editText(await linkText(chatId, fresh) + "\n" + await gedcomText(chatId, fragKeys), await linkMarkup(chatId, fresh), 'HTML');
            return;
        } else { // dell — удалить связь, событие остаётся; семья чистится
            const heroKey = link[link.who === 'p' ? 'p' : 'c'];
            const rec = await recordOf(chatId, heroKey);
            await deleteLink(chatId, link);
            await editText("🔗 Связь удалена: " + link.p + " → " + link.c
                + (rec ? "\n" + jubileeText(rec, "") : ""), undefined, 'HTML');
            await answer();
            console.log("link deleted:", link.p, "→", link.c, "chat", chatId);
            return;
        }
        const fresh = await linkById(chatId, link.id);
        if (fresh) {
            // sex/adop: фрагмент — новое лицо (с полом) либо родитель+ребёнок
            const fragKeys = act === "sex" ? [fresh[fresh.who === 'p' ? 'p' : 'c']] : [fresh.p, fresh.c];
            await editText(await linkText(chatId, fresh) + "\n" + await gedcomText(chatId, fragKeys), await linkMarkup(chatId, fresh), 'HTML');
        }
        return;
    }

    // фокус-сообщение: радиус родни 1–5, 🔔/🧬 в радиусе; «-+=» — ветвь героя
    if (/^foc[1-5]$/.test(data) || data === "focbell" || data === "foctree" || data === "focflat") {
        const row = await fvOf();
        if (!row) { await answer("сообщение устарело — ответьте «/» на триггер заново"); return; }
        const rec = await recordOf(chatId, row.pkey);
        if (!rec) { await answer("персона не найдена"); return; }
        // foc[1-5] — целевой радиус из кнопки (row.radius мог быть другим):
        // обновляем focus_view и пересчитываем ключи под НОВЫЙ радиус
        const wantR = /^foc[1-5]$/.test(data) ? Number(data.slice(3)) : row.radius;
        // список/цифры — уровневый радиус (bell), 🧬 — кровный ромб (экспорт);
        // «-+=» ключи родни не использует
        const bell = data === "focbell" || /^foc[1-5]$/.test(data);
        const [radius, pairs, spPairs, depth] = await radiusOf(row.pkey, wantR);
        // xref для единых кнопок 👎/👀 (персона — xref, свадьба — fx fam-пары)
        const fxref = rec.xref ?? rec.fx ?? null;
        // список всегда по ММ-ДД (сортировка подписки касается только дампа)
        const byFull = false;
        if (/^foc[1-5]$/.test(data))
            await db.update(focusView).set({ radius }).where(eq(focusView.id, row.id)).run();
        await answer(data === "focbell" ? "список " + focusLabel(radius)
            : (data === "foctree" ? "древо " + focusLabel(radius)
                : (data === "focflat" ? "пачка ветви " : "") + focusLabel(radius)));
        const head = focusHead(row.pkey, radius, rec.dd);
        const loading = "🔔⏳";
        if (bell) {
            let kb = cq.message.reply_markup;
            // Не создаём отдельное сообщение с вечными часами, если правка недоступна.
            await api.editMessageText({ chat_id: chatId, message_id: cq.message.message_id,
                text: head + "\n" + loading, reply_markup: kb }).catch(e => console.error("focus loading:", e.message));
            let text;
            try {
                const sex = await sexOf();
                const s = await getSettings(chatId);
                const keys = focusListKeys(pairs, spPairs, row.pkey, radius, sex, true);
                const body = focusListText(await bellItems(), keys, row.pkey, pairs, spPairs, sex, byFull, mmddToday(), radius, s.fynny)
                    || "(в радиусе нет событий)";
                kb = focusMarkup(cq.message.chat, chatId, s, radius, depth, fxref);
                text = head + "\n" + (head.length + 1 + body.length > 4000
                    ? cutLines(body, 4000, head.length + 1, false) : body);
            } catch (e) {
                console.error("focus list:", e);
                text = head + "\nНе удалось подготовить список. Попробуйте ещё раз.";
            }
            await editText(text, kb);
            return;
        }
        // 🧬 в радиусе: <имя>.ged + <имя>.pdf (родство к герою); клавиатура
        // передаётся в правку (роспись <4000 правит текст сообщения)
        if (data === "foctree") {
            const kb = cq.message.reply_markup;
            await api.editMessageText({ chat_id: chatId, message_id: cq.message.message_id,
                text: head + "\n🧬⏳", reply_markup: kb }).catch(e => console.error("DNA loading:", e.message));
            try {
                const keys = focusListKeys(pairs, spPairs, row.pkey, radius, await sexOf(), false);
                await sendGedPdf(chatId, keys, head, row.pkey, cq.message.message_id,
                    focusMarkup(cq.message.chat, chatId, await getSettings(chatId), radius, depth, fxref));
            } catch (e) {
                console.error("DNA export:", e);
                await editText(head + "\n💥 Не удалось подготовить древо. Попробуйте ещё раз.", kb);
            }
            return;
        }
        // «-+=» на фокусе: роспись ВЕТВИ героя (.ged.txt) — вся глубина, герой
        // первой строкой; реплай правленной росписью на цитату заменяет ветвь
        if (data === "focflat") {
            const kb = cq.message.reply_markup;
            await api.editMessageText({ chat_id: chatId, message_id: cq.message.message_id,
                text: head + "\n-+=⏳", reply_markup: kb }).catch(e => console.error("flat loading:", e.message));
            try {
            const pack = await branchFlatText(chatId, row.pkey);
            if (!pack) { await editText(head + "\n(ветвь пуста)", kb); return; }
            const fKb0 = focusMarkup(cq.message.chat, chatId, await getSettings(chatId), radius, depth, fxref);
            if ((head + "\n" + pack).length >= 4000) {
                // перелив: порядок строк — герой, метка (правило — коммент
                // у NOT_FOR_GRAFT в lib/bot.js); ВСЯ роспись — файлом ответом
                // на это сообщение, потом ⏳ снят
                const inner = cutLines(pack, 4000, head.length + 1 + NOT_FOR_GRAFT.length + 1);
                await editText(head + "\n" + NOT_FOR_GRAFT + "\n" + inner + "\n✂️⏳", fKb0);
                await tailDoc(pack, head, ".ged.txt",
                    head + "\n" + NOT_FOR_GRAFT + "\n" + inner + "\n✂️", fKb0);
                return;
            }
            await editText(head + "\n" + pack, fKb0);
            } catch (e) {
                console.error("flat export:", e);
                await editText(head + "\n💥 Не удалось подготовить ветвь. Попробуйте ещё раз.", kb);
            }
            return;
        }
    }

    // «Нет / Да / Да, с резервом» на дроп .ged: ЗАМЕНА дерева или отказ
    // (в группе — только отправивший файл)
    if (data === "ged:rep" || data === "ged:bak" || data === "ged:ign") {
        const row = await db.select().from(gedDrops).where(eq(gedDrops.chatId, chatId)).get();
        if (!row || Date.now() - row.ts > GED_TTL) {
            if (row) await db.delete(gedDrops).where(eq(gedDrops.chatId, chatId)).run();
            await answer("файл не найден — перешлите .ged заново");
            return;
        }
        if (cq.message.chat.type !== "private" && row.fromId !== cq.from?.id) {
            await answer("только отправивший файл");
            return;
        }
        await db.delete(gedDrops).where(eq(gedDrops.chatId, chatId)).run();
        // ответ сразу: callback_query короткоживущий, замена большого древа
        // идёт дольше — поздний answer теряется, «вращение» висит на кнопке
        await answer(data === "ged:ign" ? "не добавлено" : "идёт замена древа…");
        if (data === "ged:ign") {
            await editText("Файл не добавлен: " + row.fileName, undefined);
            return;
        }
        // роспись .ged.txt: ЗАМЕНА дерева чата (с резервом сначала файлом)
        if (/\.ged\.txt$/i.test(row.fileName)) {
            if (data === "ged:bak" && !(await sendTreeBackup(chatId))) {
                await editText("💥 Не удалось выложить резерв — замена отменена, прежнее дерево цело", undefined);
                return;
            }
            await clearChatTree(chatId);
            const rep = await applyTree(chatId, parseTree(row.content), null);
            await editText(treeReport(rep), undefined);
            console.log("txt replace:", rep.persons, "персон,", rep.links, "детей, chat", chatId);
            return;
        }
        const r = await replaceWithGedcom(chatId, parseGedcom(row.content), data === "ged:bak");
        await editText(r.head, undefined);
        console.log("ged replace:", data, "chat", chatId);
        return;
    }

    await answer();
}
