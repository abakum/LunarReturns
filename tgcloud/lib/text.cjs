// text.cjs — общий канон примерных дат (approxOut) для ВК и ТГ (план
// .kilo/plans/20261107-shared-modules-plan.md): ВК require-ит из
// lunarreturns.js, ТГ импортирует через ESM-шим tgcloud/lib/text.js;
// юбилейные тексты (jubileeText) платформенные и остаются в копиях
// (ТГ: tg-spoiler/htmlEsc, ВК: plain). Правки — только здесь.

// примерная дата текстом: гранулярность G — урезание («1234», «1234-05»),
// квалификатор Q — суффикс за датой: «?» ABT, «=» CAL, «<» BEF, «>» AFT,
// «~» EST (на любой гранулярности: «1234-05-06?», «1234-05?», «1234~»);
// точная дата — как есть (так же печатаются коллизии ключа в отчёте импорта)
const ABT_MARK = { 1: "?", 2: "=", 3: "<", 4: ">", 5: "~" };
function approxOut(d, abt) {
    const a = abt || 0, q = Math.floor(a / 3), g = a % 3;
    return d.slice(0, 10 - g * 3) + (ABT_MARK[q] || "");
}

module.exports = { approxOut };
