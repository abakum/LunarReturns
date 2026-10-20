import { api, db } from 'sdk';
import { and, eq } from 'sdk/db';
import { events, settings, links, fams, gedDrops, focusView } from '../schema.js';
import { jubileeText } from '../lib/text.js';
import { parseGedcom } from '../lib/parse.js';
import { REL_DEFS, religiousYear } from '../lib/religion.js';
import {
        HELP, GED_TTL, relMarkup, upcomingText, getSettings, startMarkup, chatAdmin, eventMarkup,
        recordOf, setLinkCand, confirmPair, linkText, linkMarkup, gedcomText, sendLong, refreshFams, deleteEventCascade,
        importGedcom, chatLinks, focusKeys, focusHasPair, focusHead, focusLabel, focusMarkup, splitText, focusWithSpouses, focusSpousePairs,
        focusListText, focusDepth, sendGedPdf,
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
        const parts = splitList(list);
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

    if (data === "del") {
        // список подтверждения — по полной дате ГГГГ-ММ-ДД (🔔 — по ММ-ДД без года);
        // 🗑 на фокус-сообщении — только родня в радиусе (список тот же, что у 🔔)
        const fv = (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all())
            .find(r => r.messageId === cq.message?.message_id);
        let head, list;
        if (fv) {
            const rec = await recordOf(chatId, fv.pkey);
            if (!rec) { await answer("персона не найдена"); return; }
            const pairsL = await chatLinks(chatId);
            const radius = Math.min(fv.radius, Math.max(1, focusDepth(pairsL.map(l => [l.parent, l.child]), fv.pkey)));
            const spPairs = await focusSpousePairs(chatId);
            const keys = focusWithSpouses(
                focusKeys(pairsL.map(l => [l.parent, l.child]), fv.pkey, radius),
                spPairs);
            const evRows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
            const sexMap = new Map(evRows.filter(r => !r.name.includes("+")).map(r => [r.name + " " + r.date, r.sex ?? null]));
            list = focusListText(
                evRows.map(r => ({ n: r.name, d: r.date, h: r.hour ?? undefined, m: r.minute ?? undefined, dd: r.deathDate ?? undefined })),
                keys, fv.pkey, pairsL.map(l => [l.parent, l.child]), spPairs,
                k => sexMap.get(k) ?? null);
            if (!list) { await answer("в радиусе нет событий"); return; }
            head = focusHead(fv.pkey, radius, rec.deathDate ?? undefined) + "\nУдалить родню в радиусе?";
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
        const fv = (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all())
            .find(r => r.messageId === cq.message?.message_id);
        if (fv) {
            const rec = await recordOf(chatId, fv.pkey);
            if (!rec) { await answer("персона не найдена"); return; }
            const pairsL = await chatLinks(chatId);
            const radius = Math.min(fv.radius, Math.max(1, focusDepth(pairsL.map(l => [l.parent, l.child]), fv.pkey)));
            const spPairs = await focusSpousePairs(chatId);
            const keys = focusWithSpouses(
                focusKeys(pairsL.map(l => [l.parent, l.child]), fv.pkey, radius),
                spPairs);
            const set = new Set(keys);
            const rows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
            const victims = rows.filter(r => set.has(r.name + " " + r.date)
                || (r.name.includes("+") && focusHasPair(r.name, keys)));
            for (const v of victims) await deleteEventCascade(chatId, v.name + " " + v.date);
            // фокус-строки удалённых персон устарели
            const gone = new Set(victims.map(v => v.name + " " + v.date));
            for (const r of (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all()))
                if (gone.has(r.pkey)) await db.delete(focusView).where(eq(focusView.id, r.id)).run();
            console.log("deleted:", victims.length, "events (focus) chat", chatId);
            // клавиатуру снимаем явно: повторный тап по висячей кнопке не должен
            // уйти в глобальное удаление (focusView-строка уже удалена)
            await editText("🗑 Удалено событий: " + victims.length, { inline_keyboard: [] });
            await answer("🗑 События родни удалены");
            return;
        }
        const n = await db.$count(events, eq(events.chatId, chatId));
        await db.delete(events).where(eq(events.chatId, chatId)).run();
        // связи и семьи чата ссылаются на записи — уходят вместе с ними
        await db.delete(links).where(eq(links.chatId, chatId)).run();
        await db.delete(fams).where(eq(fams.chatId, chatId)).run();
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
        // связи персоны, свадьба пары «Имя+Имя», висячие кандидаты, семьи
        await deleteEventCascade(chatId, row.name + " " + row.date);
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
        if (row.deathDate) rec.dd = row.deathDate; // † / развод — в голове результата
        // сжатый вид отличается от детального спойлером: если в сообщении нет
        // spoiler-entity — оно детальное (в моке entity эмулирует repl)
        const ent = cq.message?.entities || [];
        const isDetail = !ent.some(e => e.type === 'spoiler');
        const depth = focusDepth((await chatLinks(chatId)).map(l => [l.parent, l.child]), row.name + " " + row.date);
        if (!isDetail) { // детализировать + кнопки фокуса (как «/»-ответ)
            // строка focusView по id сообщения — чтобы foc*/focbell/foctree/del
            // работали на развёрнутом отчёте
            await db.delete(focusView).where(and(eq(focusView.chatId, chatId), eq(focusView.messageId, cq.message.message_id))).run();
            await db.insert(focusView).values({
                chatId, messageId: cq.message.message_id, pkey: row.name + " " + row.date, radius: 1, ts: Date.now(),
            }).run();
            await editText(
                jubileeText(rec, "", true),
                focusMarkup(cq.message.chat, chatId, await getSettings(chatId), 1, depth), 'HTML');
        } else { // повторное нажатие сворачивает обратно (как снятие реакции в VK)
            await db.delete(focusView).where(and(eq(focusView.chatId, chatId), eq(focusView.messageId, cq.message.message_id))).run();
            await editText(
                jubileeText(rec, "", false),
                eventMarkup(id), 'HTML');
        }
        await answer(isDetail ? "сжато" : "подробно");
        return;
    }

    // 🧬 — гедком-древо чата (как /gedcom); /start править нельзя — тост
    if (data === "tree") {
        const g = await gedcomText(chatId);
        if (!g.includes("FAM")) {
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
        const link = (await db.select().from(links).where(eq(links.id, Number(idStr))).get());
        if (!link || link.chatId !== chatId) { await answer("связь не найдена"); return; }
        if (act === "sex") {
            const rec = await recordOf(chatId, link[link.who === 'p' ? 'parent' : 'child']);
            if (rec) await db.update(events).set({ sex: arg === 'F' ? 'F' : 'M' }).where(eq(events.id, rec.id)).run();
            await answer("пол: " + (arg === 'F' ? "♀" : "♂"));
        } else if (act === "adop") {
            await db.update(links).set({ adopted: !link.adopted }).where(eq(links.id, link.id)).run();
            link.adopted = !link.adopted;
            await answer(link.adopted ? "🤱 усыновление" : "усыновление снято");
        } else if (act === "pair") {
            const i = Number(arg);
            let fragKeys = [link.parent, link.child];
            const cand = link.pairCand ? JSON.parse(link.pairCand) : null;
            if (i >= 0 && cand && cand[i]) {
                const f = await confirmPair(chatId, link, cand[i]);
                await answer(f && f.marrD ? "💍 " + f.marrD + (f.marrPlac ? ", " + f.marrPlac : "") : "не найдено");
                if (f) fragKeys = [...f.parents, ...f.children]; // все трое
            } else {
                await setLinkCand(link, null);
                await answer("без свадьбы");
            }
            const fresh = await db.select().from(links).where(eq(links.id, link.id)).get();
            if (fresh) await editText(await linkText(chatId, fresh) + "\n" + await gedcomText(chatId, fragKeys), await linkMarkup(chatId, fresh), 'HTML');
            return;
        } else { // dell — удалить связь, событие остаётся
            await db.delete(links).where(eq(links.id, link.id)).run();
            // почистить семьи: ребёнок в семье, пока есть связь с famId
            await refreshFams(chatId);
            const rec = await recordOf(chatId, link[link.who === 'p' ? 'parent' : 'child']);
            await editText("🔗 Связь удалена: " + link.parent + " → " + link.child
                + (rec ? "\n" + jubileeText({ n: rec.name, d: rec.date, h: rec.hour ?? undefined, m: rec.minute ?? undefined, dd: rec.deathDate ?? undefined }, "") : ""),
                undefined, 'HTML');
            await answer();
            console.log("link deleted:", link.parent, "→", link.child, "chat", chatId);
            return;
        }
        const fresh = await db.select().from(links).where(eq(links.id, link.id)).get();
        if (fresh) {
            // sex/adop: фрагмент — новое лицо (с полом) либо родитель+ребёнок
            const fragKeys = act === "sex" ? [fresh[fresh.who === 'p' ? 'parent' : 'child']] : [fresh.parent, fresh.child];
            await editText(await linkText(chatId, fresh) + "\n" + await gedcomText(chatId, fragKeys), await linkMarkup(chatId, fresh), 'HTML');
        }
        return;
    }

    // фокус-сообщение: радиус родни 1–5, 🔔/🧬 в радиусе
    if (/^foc[1-5]$/.test(data) || data === "focbell" || data === "foctree") {
        const row = (await db.select().from(focusView).where(eq(focusView.chatId, chatId)).all())
            .find(r => r.messageId === cq.message?.message_id);
        if (!row) { await answer("сообщение устарело — ответьте «/» на триггер заново"); return; }
        const rec = await recordOf(chatId, row.pkey);
        if (!rec) { await answer("персона не найдена"); return; }
        // глубина предков: цифры радиуса без сведений не выводятся,
        // радиус не глубже имеющихся предков (старые сообщения могут нести снятые кнопки)
        const pairsL = await chatLinks(chatId);
        const depth = focusDepth(pairsL.map(l => [l.parent, l.child]), row.pkey);
        const bell = data === "focbell";
        // сортировка списка — по подписке (🔔 вкл — ММ-ДД, 🔕 выкл — ГГГГММДД);
        // клик по уже показанному списку переключает подписку
        const s = await getSettings(chatId);
        const on = s.bell !== false;
        let byFull = bell && !on;
        const radius = bell || data === "foctree"
            ? Math.min(row.radius, Math.max(1, depth))
            : Number(data.slice(3));
        if (data !== "focbell" && data !== "foctree")
            await db.update(focusView).set({ radius }).where(eq(focusView.id, row.id)).run();
        await answer(data === "focbell" ? "список в радиусе" : (data === "foctree" ? "древо в радиусе" : "от " + focusLabel(radius)));
        // 🧬 в радиусе: <имя>.ged + <имя>.pdf (родство к герою), правка не нужна
        if (data === "foctree") {
            const spPairs = await focusSpousePairs(chatId);
            const keys = focusWithSpouses(
                focusKeys(pairsL.map(l => [l.parent, l.child]), row.pkey, radius),
                spPairs);
            await sendGedPdf(chatId, keys, focusHead(row.pkey, radius, rec.deathDate ?? undefined));
            return;
        }
        // цифра — только заголовок; тело (список/гедком) — по 🔔/🧬
        let body = null;
        if (bell) {
            const spPairs = await focusSpousePairs(chatId);
            const keys = focusWithSpouses(
                focusKeys(pairsL.map(l => [l.parent, l.child]), row.pkey, radius),
                spPairs);
            if (bell) {
                const evRows = await db.select().from(events).where(eq(events.chatId, chatId)).all();
                const sexMap = new Map(evRows.filter(r => !r.name.includes("+")).map(r => [r.name + " " + r.date, r.sex ?? null]));
                let list = focusListText(
                    evRows.map(r => ({ n: r.name, d: r.date, h: r.hour ?? undefined, m: r.minute ?? undefined, dd: r.deathDate ?? undefined })),
                    keys, row.pkey, pairsL.map(l => [l.parent, l.child]), spPairs,
                    k => sexMap.get(k) ?? null, byFull) || "(в радиусе нет событий)";
                const cur = cq.message?.text || "";
                const head = focusHead(row.pkey, radius, rec.deathDate ?? undefined);
                // «уже показан» — показанное длиннее заголовка (сообщение-заголовок
                // само по себе префикс рендера списка)
                if (cur && cur !== head && (head + "\n" + list).startsWith(cur)) {
                    s.bell = !on;
                    const srow = await db.select().from(settings).where(eq(settings.chatId, chatId)).get();
                    if (srow) await db.update(settings).set({ bell: s.bell }).where(eq(settings.chatId, chatId)).run();
                    else await db.insert(settings).values({ chatId, bell: s.bell }).run();
                    byFull = s.bell === false;
                    list = focusListText(
                        evRows.map(r => ({ n: r.name, d: r.date, h: r.hour ?? undefined, m: r.minute ?? undefined, dd: r.deathDate ?? undefined })),
                        keys, row.pkey, pairsL.map(l => [l.parent, l.child]), spPairs,
                        k => sexMap.get(k) ?? null, byFull) || "(в радиусе нет событий)";
                }
                body = list;
            }
        }
        const parts = splitText(focusHead(row.pkey, radius, rec.deathDate ?? undefined) + (body ? "\n" + body : ""));
        await editText(parts[0], focusMarkup(cq.message.chat, chatId, await getSettings(chatId), radius, depth));
        for (let i = 1; i < parts.length; i++) await api.sendMessage({ chat_id: chatId, text: parts[i] });
        return;
    }

    // «Да/Нет» на дроп .ged: импорт или отказ (в группе — только отправивший)
    if (data === "gedadd" || data === "gedign") {
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
        if (data === "gedign") {
            await editText("Файл не добавлен: " + row.fileName, undefined);
            await answer("не добавлено");
            return;
        }
        const r = await importGedcom(chatId, parseGedcom(row.content));
        await editText("🧬 Гедком импортирован: персон " + r.persons + ", связей " + r.links
            + (r.weddings ? ", свадеб " + r.weddings : ""), undefined);
        await answer("🧬 Гедком импортирован");
        console.log("ged import:", r.persons, "persons chat", chatId);
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
