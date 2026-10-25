import { api, db, InputFile } from 'sdk';
import { and, eq } from 'sdk/db';
import { settings, gedDrops, focusView } from '../schema.js';
import { jubileeText } from '../lib/text.js';
import { parseGedcom, parseTree } from '../lib/parse.js';
import { fileBaseOf } from '../lib/chart.js';
import { REL_DEFS, religiousYear } from '../lib/religion.js';
import {
    HELP, GED_TTL, relMarkup, chatFlatText, getSettings, startMarkup, chatAdmin, eventMarkup,
    recordOf, recordByXref, setLinkCand, confirmPair, linkText, linkMarkup, gedcomText, sendLong,
    deleteEventCascade, replaceWithGedcom, clearChatTree, deleteLink, setIndiSex, toggleAdopted,
    linkById, linksAll, linkPairs, xrefOfKey, personRows, weddingRows, sendTreeBackup,
    upcomingText, mmddToday, focusKeys, focusHasPair, focusHead, focusLabel, focusMarkup, splitText,
    focusWithSpouses, focusSpousePairs, focusListText, focusDepth, sendGedPdf,
    applyTree, branchFlatText, keyOfXref, cutAndGraft, treeReport,
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

    // большой текст — ВЕСЬ текст одним файлом: «.ged.txt» (пачка древа) либо
    // «.txt» (список событий); не выложился — ошибка. Файл — ответом на то же
    // сообщение (к которому кнопки), а не отдельным
    const tailDoc = async (text, nameBase, ext = ".ged.txt") => {
        const base = fileBaseOf(nameBase || "Продолжение") + ext;
        try {
            await api.sendDocument({
                chat_id: chatId,
                // BOM — чтобы Windows-редакторы открывали как UTF-8
                document: new InputFile(new TextEncoder().encode("\uFEFF" + text), base,
                    { type: "text/plain" }),
                reply_parameters: { message_id: cq.message.message_id, allow_sending_without_reply: true },
            });
            return;
        } catch (e) {
            console.error("tail document:", e.message);
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
        let shownList = "";
        for (const l of list.split("\n")) {
            if (shownList.length + 1 + l.length > 4000) break;
            shownList += (shownList ? "\n" : "") + l;
        }
        await editText(shownList || "Событий нет", markup);
        return;
    }

    if (data === "flat") {
        // «-+=» — плоская пачка древа чата (.ged.txt, импортируется пачкой);
        // не влезает — файлом ответом на это сообщение
        const flat = await chatFlatText(chatId);
        if (!flat) { await answer("древо пусто"); return; }
        await answer("пачка древа чата");
        const markup = await startMarkup(cq.message.chat, await chatAdmin(cq.message.chat, cq.from?.id),
            chatId, await getSettings(chatId));
        if (flat.length > 4000) {
            // текст и кнопки сообщения не трогаем; полный список — файлом ответом
            await tailDoc(flat, "Древо чата", ".ged.txt");
            return;
        }
        await editText(flat, markup);
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

    // события чата записями {n,d,h,m,dd} (персоны + свадьбы)
    const items = async () => [...await personRows(chatId), ...await weddingRows(chatId)];
    // пол по ключу «Имя Д» (ярлыки родства)
    const sexOf = async () => (rows => k => (rows.find(r => r.n + " " + r.d === k) || {}).sex ?? null)
        (await personRows(chatId));
    // радиус не глубже имеющихся предков; [radius, ключи родни]
    const radiusOf = async (key, fvRadius) => {
        const depth = Math.max(1, focusDepth(await linkPairs(chatId), key));
        const r = Math.min(fvRadius, depth);
        const keys = focusWithSpouses(focusKeys(await linkPairs(chatId), key, r),
            await focusSpousePairs(chatId));
        return [r, keys, depth];
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
            // список — .txt (не древо); в сообщении остаётся заголовок, файл —
            // ответом на это же сообщение
            await editText(full.split("\n")[0], delKb);
            await tailDoc(full, full.split("\n")[0], ".txt");
            return;
        }
        await editText(full, delKb);
        return;
    }

    if (data === "del:yes") {
        // глобальное удаление: дерево чата (персоны/свадьбы/связи/семьи) целиком,
        // настройки остаются
        const n = (await items()).length;
        await clearChatTree(chatId);
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

    if (data.startsWith("det:")) {
        // 👀 — детализировать правкой сообщения, кнопки сохраняются;
        // повторное нажатие сворачивает обратно (как снятие реакции в VK)
        const xref = data.slice(4);
        const rec = await recordByXref(chatId, xref);
        if (!rec) { await answer("Событие не найдено"); return; }
        // сжатый вид отличается от детального спойлером: если в сообщении нет
        // spoiler-entity — оно детальное (в моке entity эмулирует repl)
        const ent = cq.message?.entities || [];
        const isDetail = !ent.some(e => e.type === 'spoiler');
        const depth = focusDepth(await linkPairs(chatId), rec.n + " " + rec.d);
        if (!isDetail) { // детализировать + кнопки фокуса (как «/»-ответ)
            // строка focusView по id сообщения — чтобы foc*/focbell/foctree/del
            // работали на развёрнутом отчёте
            await db.delete(focusView).where(and(eq(focusView.chatId, chatId), eq(focusView.messageId, cq.message.message_id))).run();
            await db.insert(focusView).values({
                chatId, messageId: cq.message.message_id, pkey: rec.n + " " + rec.d, radius: 1, ts: Date.now(),
            }).run();
            await editText(jubileeText(rec, "", true),
                focusMarkup(cq.message.chat, chatId, await getSettings(chatId), 1, depth), 'HTML');
        } else { // повторное нажатие сворачивает обратно (как снятие реакции в VK)
            await db.delete(focusView).where(and(eq(focusView.chatId, chatId), eq(focusView.messageId, cq.message.message_id))).run();
            await editText(jubileeText(rec, "", false), eventMarkup(xref), 'HTML');
        }
        await answer(isDetail ? "сжато" : "подробно");
        return;
    }

    // «↺ связи» (🔗 на сообщении персоны): заново выложить сообщения-связи
    // персон с их кнопками (пропали из чата — восстановить нечем было)
    if (data.startsWith("links:")) {
        const key = await keyOfXref(chatId, data.slice(6));
        if (!key) { await answer("персона не найдена"); return; }
        const links = (await linksAll(chatId)).filter(l => l.p === key || l.c === key);
        if (!links.length) { await answer("связей пока нет"); return; }
        await answer("связи: " + links.length);
        for (const l of links) {
            if (cq.message.reply_markup) await editMarkup(undefined);
            await api.sendMessage({
                chat_id: chatId,
                text: await linkText(chatId, l) + "\n" + await gedcomText(chatId, [l.p, l.c]),
                reply_markup: await linkMarkup(chatId, l),
            });
        }
        return;
    }

    // 🧬 — гедком-древо чата (как /gedcom); /start править нельзя — тост
    if (data === "tree") {
        if (!(await linkPairs(chatId)).length) {
            await answer("связей пока нет");
            return;
        }
        await answer("гедком-древо чата");
        await sendGedPdf(chatId, undefined, "🧬 Гедком-древо чата", null, cq.message.message_id);
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
        const [radius, keys, depth] = await radiusOf(row.pkey, wantR);
        const bell = data === "focbell";
        // список всегда по ММ-ДД (сортировка подписки касается только дампа)
        const byFull = false;
        if (/^foc[1-5]$/.test(data))
            await db.update(focusView).set({ radius }).where(eq(focusView.id, row.id)).run();
        await answer(data === "focbell" ? "список " + focusLabel(radius)
            : (data === "foctree" ? "древо " + focusLabel(radius)
                : (data === "focflat" ? "пачка ветви " : "") + focusLabel(radius)));
        // 🧬 в радиусе: <имя>.ged + <имя>.pdf (родство к герою), правка не нужна
        if (data === "foctree") {
            await sendGedPdf(chatId, keys, focusHead(row.pkey, radius, rec.dd), row.pkey, cq.message.message_id);
            return;
        }
        const head = focusHead(row.pkey, radius, rec.dd);
        // «-+=» на фокусе: пачка ВЕТВИ героя (.ged.txt) — вся глубина, герой
        // первой строкой; реплай правленной пачкой на цитату заменяет ветвь
        if (data === "focflat") {
            const pack = await branchFlatText(chatId, row.pkey);
            if (!pack) { await answer("ветвь пуста"); return; }
            const fKb0 = focusMarkup(cq.message.chat, chatId, await getSettings(chatId), radius, depth);
            if (pack.length > 4000) {
                await editText(head, fKb0);
                await tailDoc(pack, head, ".ged.txt");
                return;
            }
            await editText(head + "\n" + pack, fKb0);
            return;
        }
        // цифра — только заголовок; тело (список) — по 🔔
        let body = null;
        if (bell) {
            const pairs = await linkPairs(chatId);
            const spPairs = await focusSpousePairs(chatId);
            body = focusListText(await items(), keys, row.pkey, pairs, spPairs, await sexOf(), byFull, mmddToday())
                || "(в радиусе нет событий)";
        }
        const full = head + (body ? "\n" + body : "");
        const fKb = focusMarkup(cq.message.chat, chatId, await getSettings(chatId), radius, depth);
        if (full.length > 4000) {
            // список начинается с сегодня — что не влезает в сообщение,
            // просто отрезаем (целые строки)
            let tail = "";
            for (const l of body.split("\n")) {
                if (head.length + 1 + tail.length + l.length > 4000) break;
                tail += (tail ? "\n" : "") + l;
            }
            await editText(head + "\n" + tail, fKb);
            return;
        }
        await editText(full, fKb);
        return;
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
        if (data === "ged:ign") {
            await editText("Файл не добавлен: " + row.fileName, undefined);
            await answer("не добавлено");
            return;
        }
        // .ged.txt-пачка: без замены — дерево ДОБАВЛЯЕТСЯ (с резервом сначала файлом)
        if (/\.ged\.txt$/i.test(row.fileName)) {
            if (data === "ged:bak") await sendTreeBackup(chatId);
            const rep = await applyTree(chatId, parseTree(row.content), null);
            await editText(treeReport(rep), undefined);
            await answer("пачка добавлена");
            console.log("txt apply:", rep.persons, "персон,", rep.links, "детей, chat", chatId);
            return;
        }
        const r = await replaceWithGedcom(chatId, parseGedcom(row.content), data === "ged:bak");
        await editText(r.head, undefined);
        await answer(r.ok ? "♻️ Заменено" : "💥 замена отменена");
        console.log("ged replace:", data, "chat", chatId);
        return;
    }

    await answer();
}
