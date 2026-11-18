// text.cjs — общий канон примерных дат и поиска показанного ключа для ВК и ТГ (план
// .kilo/plans/20261107-shared-modules-plan.md): ВК require-ит из
// lunarreturns.js, ТГ импортирует через ESM-шим tgcloud/lib/text.js;
// юбилейные тексты (jubileeText) платформенные и остаются в копиях
// (ТГ: tg-spoiler/htmlEsc, ВК: plain). Правки — только здесь.

const { newStyleDate } = require('./religion.cjs');

const REPLY_TARGET_ERROR = "Не удалось найти цитируемую запись в дереве этого чата. Ответьте на актуальное событие пользователя, расчёт, фокус или экспорт ветви самого бота с однозначным героем. Для всего чата отправьте команду без ответа.";

const HELP = "Отправьте событие, покажу лунно-солнечные юбилеи:\n"
    + "Иван 1950-01-02 12:30 (Пермь)\n"
    + "Без времени — полдень, без зоны — МСК. Можно указать дату смерти.\n\n"
    + "Часовой пояс только в скобках: (UTC+5), (МСК-2), (GMT).\n"
    + "В файлах неизвестное время сохраняется; смерть без рождения: Имя * 2000-01-02 00:30 (UTC+5).\n\n"
    + "Кнопки под ответом: 👎 — удалить событие, 👀/🌙 — подробно/сжато.\n"
    + "🔔 — список событий, 🧬 — древо, -+= — родословная роспись.\n"
    + "Цифры задают радиус родни для 🔔 и 🧬; -+= выводит всю ветвь потомков.\n\n"
    + "/today — события сегодня (МСК).\n"
    + "/bell — список событий, /gedcom — древо: в ответ на событие — родня героя, без ответа — весь чат. /bell2 и /gedcom2 — радиус 2.\n"
    + "/links — родословная роспись: в ответ — ветвь героя, без ответа — весь чат.\n"
    + "/fynny0 — обычные названия родства, /fynny1 — цепочки (fynny=0).\n"
    + "/trim1 — импорт .ged/.ged.txt: инициалы, без мест и примечаний; /trim0 — полные данные (trim=0).\n"
    + "/Иван — поиск по имени, / текст — поиск подстроки.\n\n"
    + "Родословная роспись обычным сообщением добавляет данные; в ответ на событие ЗАМЕНЯЕТ ветвь героя.\n"
    + "Одна строка события без маркера в ответ — правка записи с сохранением связей.\n"
    + "Импорт .ged или .ged.txt ЗАМЕНЯЕТ данные чата после подтверждения (Нет / Да / Да, с резервом).\n\n"
    + "Формат росписи: https://github.com/abakum/LunarReturns/blob/main/-%2B%3D.md";

function helpText(settings = {}) {
    return HELP.replace('(fynny=0)', '(fynny=' + Number(!!settings.fynny) + ')')
        .replace('(trim=0)', '(trim=' + Number(!!settings.trim) + ')');
}

// примерная дата текстом: гранулярность G — урезание («1234», «1234-05»),
// квалификатор Q — суффикс за датой: «?» ABT, «=» CAL, «<» BEF, «>» AFT,
// «~» EST (на любой гранулярности: «1234-05-06?», «1234-05?», «1234~»);
// точная дата — как есть (так же печатаются коллизии ключа в отчёте импорта)
const ABT_MARK = { 1: "?", 2: "=", 3: "<", 4: ">", 5: "~" };
function approxOut(d, abt) {
    const a = abt || 0, q = Math.floor(a / 3), g = a % 3;
    return d.slice(0, 10 - g * 3) + (ABT_MARK[q] || "");
}

// Mark converted full dates so copying a displayed event preserves its key.
function eventDate(d, abt = 0) {
    const shown = newStyleDate(d), text = approxOut(shown, abt);
    return shown !== d && abt % 3 === 0 ? text.replace(/-/g, "_") : text;
}

// Exact-key lookup stays in the adapters, before this displayed-form fallback.
function findShownRecord(records, key) {
    const m = key.match(/^(.+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?)([?=<>~]?)\s*$/);
    if (!m) return null;
    return records.find(r => r.n === m[1] && (approxOut(newStyleDate(r.d), r.abt || r.mabt || 0) === m[2].replace(/[._]/g, "-") + m[3]
        || r.d === m[2].replace(/[._]/g, "-") + m[3])) || null;
}

// Only the first line is an anchor, never a person inside a list or document.
function replyHeader(text, bot = false) {
    const lines = String(text || "").split(/\r?\n/);
    const focus = /^[1-5] /.test(lines[0]);
    if (bot && !focus && !lines.some((line, i) => i > 0 && /^#\d{4}г\s/.test(line))) return null;
    const m = lines[0].match(/^(?:[1-5] )?([^\n]+?)\s+(\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?[?=<>~]?)(?=\s|$)/);
    return m && m[1].trim() + " " + m[2];
}

function resolveReplyRecord(records, text, bot = false, context = null) {
    const key = replyHeader(text, bot);
    if (!key) return null;
    const m = key.match(/^(.+) (\d{4}(?:[-._]\d{2}(?:[-._]\d{2})?)?)([?=<>~]?)$/);
    if (!m) return null;
    const date = m[2].replace(/[._]/g, "-") + m[3];
    const hits = records.filter(r => r.n === m[1] && (r.n + " " + r.d === key
        || approxOut(newStyleDate(r.d), r.abt || r.mabt || 0) === date));
    if (hits.length !== 1) return null;
    const rec = hits[0];
    if (context && (context.pkey !== rec.n + " " + rec.d
        || context.ts < Date.now() - 7 * 24 * 3600000)) return null;
    return rec;
}

module.exports = { REPLY_TARGET_ERROR, HELP, helpText, approxOut, eventDate, findShownRecord, replyHeader, resolveReplyRecord };
