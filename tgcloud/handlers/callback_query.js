import { api, db } from 'sdk';
import { and, eq } from 'sdk/db';
import { settings, gedDrops, focusView } from '../schema.js';
import { jubileeText } from '../lib/text.js';
import { parseGedcom } from '../lib/parse.js';
import { REL_DEFS, religiousYear } from '../lib/religion.js';
import {
    HELP, GED_TTL, relMarkup, upcomingText, getSettings, startMarkup, chatAdmin, eventMarkup,
    recordOf, recordByXref, setLinkCand, confirmPair, linkText, linkMarkup, gedcomText, sendLong,
    deleteEventCascade, replaceWithGedcom, clearChatTree, deleteLink, setIndiSex, toggleAdopted,
    linkById, linkPairs, xrefOfKey, personRows, weddingRows,
    focusKeys, focusHasPair, focusHead, focusLabel, focusMarkup, splitText,
    focusWithSpouses, focusSpousePairs, focusListText, focusDepth, sendGedPdf,
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
        // как религиозные дни: первый клик показывает список, не меняя подписку
        // (сортировка по подписке: 🔔 вкл — ММ-ДД, 🔕 выкл — ГГГГММДД);
        // клик по уже показанному списку переключает подписку и пересортирует
        const s = await getSettings(chatId);
        const on = s.bell !== false;
        const md = await upcomingText(chatId, false);
        const full = await upcomingText(chatId, true);
        const cur = cq.message?.text;
        const shown = cur !== undefined
            && ((md && (cur === md || md.startsWith(cur))) || (full && (cur === full || full.startsWith(cur))));
        if (shown) {
            s.bell = !on;
            const row = await db.select().from(settings).where(eq(settings.chatId, chatId)).get();
            if (row) await db.update(settings).set({ bell: s.bell }).where(eq(settings.chatId, chatId)).run();
            else await db.insert(settings).values({ chatId, bell: s.bell }).run();
        }
        const list = await upcomingText(chatId, s.bell === false);
        if (!list) {
            if (!isHelp) await editText("Событий нет", cq.message.reply_markup);
            await answer("Событий нет");
            return;
        }
        await answer(shown ? (s.bell !== false ? "подписка включена" : "подписка отключена") : "список событий");
        // как в VK: список в этом же сообщении, клавиатура с новой подпиской
        const markup = await startMarkup(cq.message.chat, await chatAdmin(cq.message.chat, cq.from?.id),
            chatId, await getSettings(chatId));
        const parts = splitText(list);
        await editText(parts[0], markup);
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
        // список подтверждения — по полной дате ГГГГ-ММ-ДД (🔔 — по ММ-ДД без года);
        // 🗑 на фокус-сообщении — только родня в радиусе (список тот же, что у 🔔)
        const fv = await fvOf();
        let head, list;
        if (fv) {
            const rec = await recordOf(chatId, fv.pkey);
            if (!rec) { await answer("персона не найдена"); return; }
            const [radius, keys, depth] = await radiusOf(fv.pkey, fv.radius);
            const list0 = focusListText(await items(), keys, fv.pkey,
                await linkPairs(chatId), await focusSpousePairs(chatId), await sexOf());
            if (!list0) { await answer("в радиусе нет событий"); return; }
            list = list0;
            head = focusHead(fv.pkey, radius, rec.dd) + "\nУдалить родню в радиусе?";
        } else {
            list = await upcomingText(chatId, true);
            if (!list) {
                if (!isHelp) await editText("Событий нет", cq.message.reply_markup);
                await answer("Событий нет");
                return;
            }
            head = "Удалить все события чата?";
        }
        await answer(fv ? "Удалить родню в радиусе?" : "Удалить все события чата?");
        // как в VK: подтверждение с показом списка событий; длинный — кусками
        // (начало с кнопками правкой исходного, хвост досылкой — как фокус)
        const parts = splitText(head + "\n" + list);
        await editText(parts[0], {
            inline_keyboard: [[
                { text: fv ? "🗑 удалить родню" : "🗑 удалить всё", callback_data: "del:yes" },
                { text: "❌ отмена", callback_data: "del:no" },
            ]]
        });
        for (let i = 1; i < parts.length; i++) await api.sendMessage({ chat_id: chatId, text: parts[i] });
        return;
    }

    if (data === "del:yes") {
        // фокус-контекст: удалить родню в радиусе; связи/свадьбы/семьи — каскадом,
        // как при одиночном удалении (deleteEventCascade)
        const fv = await fvOf();
        if (fv) {
            const [radius, keys] = await radiusOf(fv.pkey, fv.radius);
            const victimRows = (await items()).filter(r => keys.includes(r.n + " " + r.d)
                || (r.n.includes("+") && focusHasPair(r.n, keys)));
            for (const v of victimRows) await deleteEventCascade(chatId, v.n + " " + v.d);
            // фокус-строки удалённых персон устарели
            const gone = new Set(victimRows.map(v => v.n + " " + v.d));
            for (const r of (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all()))
                if (gone.has(r.pkey)) await db.delete(focusView).where(eq(focusView.id, r.id)).run();
            console.log("deleted:", victimRows.length, "events (focus) chat", chatId);
            // клавиатуру снимаем явно: повторный тап по висячей кнопке не должен
            // уйти в глобальное удаление (focusView-строка уже удалена)
            await editText("🗑 Удалено событий: " + victimRows.length, { inline_keyboard: [] });
            await answer("🗑 События родни удалены");
            return;
        }
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

    // 🧬 — гедком-древо чата (как /gedcom); /start править нельзя — тост
    if (data === "tree") {
        if (!(await linkPairs(chatId)).length) {
            await answer("связей пока нет");
            return;
        }
        await answer("гедком-древо чата");
        await sendGedPdf(chatId, undefined, "🧬 Гедком-древо чата");
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

    // фокус-сообщение: радиус родни 1–5, 🔔/🧬 в радиусе
    if (/^foc[1-5]$/.test(data) || data === "focbell" || data === "foctree") {
        const row = await fvOf();
        if (!row) { await answer("сообщение устарело — ответьте «/» на триггер заново"); return; }
        const rec = await recordOf(chatId, row.pkey);
        if (!rec) { await answer("персона не найдена"); return; }
        const [radius, keys, depth] = await radiusOf(row.pkey, row.radius);
        const bell = data === "focbell";
        // сортировка списка — по подписке (🔔 вкл — ММ-ДД, 🔕 выкл — ГГГГММДД);
        // клик по уже показанному списку переключает подписку
        const s = await getSettings(chatId);
        const on = s.bell !== false;
        let byFull = bell && !on;
        if (data !== "focbell" && data !== "foctree")
            await db.update(focusView).set({ radius }).where(eq(focusView.id, row.id)).run();
        await answer(data === "focbell" ? "список в радиусе" : (data === "foctree" ? "древо в радиусе" : "от " + focusLabel(radius)));
        // 🧬 в радиусе: <имя>.ged + <имя>.pdf (родство к герою), правка не нужна
        if (data === "foctree") {
            await sendGedPdf(chatId, keys, focusHead(row.pkey, radius, rec.dd));
            return;
        }
        // цифра — только заголовок; тело (список/гедком) — по 🔔/🧬
        let body = null;
        if (bell) {
            const pairs = await linkPairs(chatId);
            const spPairs = await focusSpousePairs(chatId);
            const render = async bf => focusListText(await items(), keys, row.pkey, pairs, spPairs, await sexOf(), bf)
                || "(в радиусе нет событий)";
            let list = await render(byFull);
            const cur = cq.message?.text || "";
            const head = focusHead(row.pkey, radius, rec.dd);
            // «уже показан» — показанное длиннее заголовка (сообщение-заголовок
            // само по себе префикс рендера списка)
            if (cur && cur !== head && (head + "\n" + list).startsWith(cur)) {
                s.bell = !on;
                const srow = await db.select().from(settings).where(eq(settings.chatId, chatId)).get();
                if (srow) await db.update(settings).set({ bell: s.bell }).where(eq(settings.chatId, chatId)).run();
                else await db.insert(settings).values({ chatId, bell: s.bell }).run();
                byFull = s.bell === false;
                list = await render(byFull);
            }
            body = list;
        }
        const parts = splitText(focusHead(row.pkey, radius, rec.dd) + (body ? "\n" + body : ""));
        await editText(parts[0], focusMarkup(cq.message.chat, chatId, await getSettings(chatId), radius, depth));
        for (let i = 1; i < parts.length; i++) await api.sendMessage({ chat_id: chatId, text: parts[i] });
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
        const r = await replaceWithGedcom(chatId, parseGedcom(row.content), data === "ged:bak");
        await editText(r.head, undefined);
        await answer(r.ok ? "♻️ Заменено" : "💥 замена отменена");
        console.log("ged replace:", data, "chat", chatId);
        return;
    }

    await answer();
}
