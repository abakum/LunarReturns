import { la, ageSuffix } from './astro.js';
import { newStyleDate } from './religion.js';
// approxOut — общий канон tgcloud/lib/text.cjs (план
// .kilo/plans/20261107-shared-modules-plan.md); правки — только в .cjs
import { approxOut } from './text.cjs';

const htmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function jubileeText(rec, note, detail = false) {
    const hasTime = rec.h !== undefined && rec.m !== undefined;
    // дата — по новому стилю с суффиксом (приблизительные — через approxOut);
    // хранение и экспорт остаются старым стилем (см. newStyleDate). Даты, где
    // стили различаются (≤ 1918-02-13), печатаются с разделителями `_`:
    // скопипащенная шапка-триггер разбирается как новый стиль (см.
    // parseDateGroups) и находит ту же запись, а не плодит дубль
    const sd = newStyleDate(rec.d), sdd = rec.dd ? newStyleDate(rec.dd) : rec.dd;
    // `_` — только у полных дат (урезанные «1624-04» остаются с `-`: день
    // скрыт, конверсия при вводе невозможна и не нужна — год-месяц совпадают)
    const nsd = (iso, marked, abt) => { const s = approxOut(iso, abt); return marked && s.length === 10 ? s.replace(/-/g, "_") : s; };
    const [y, mo, d] = sd.split("-").map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, rec.h !== undefined ? rec.h : 12, rec.m !== undefined ? rec.m : 0, 0));
    const head = rec.n + " " + nsd(sd, sd !== rec.d, rec.abt || rec.mabt || 0) + (hasTime ? " " + String(rec.h).padStart(2, "0") + ":" + String(rec.m).padStart(2, "0") : "")
        + (sdd ? " " + nsd(sdd, sdd !== rec.dd, rec.dabt || rec.mabt || 0) : "")
        + ageSuffix(rec.n, sd, sdd)
        + (note ? "\n" + note : "");
    // годы до текущего включительно видны; сжатый вид — будущие юбилеи под
    // спойлером, детальный — всё открыто (по наличию спойлера callback и
    // различает сжатое/детальное)
    const years = la(t, detail);
    const thisYear = new Date().getFullYear();
    const parts = [];
    let future = [];
    const futureBlock = () => {
        const body = htmlEsc(future.join("\n"));
        return detail ? body : "<tg-spoiler>" + body + "</tg-spoiler>";
    };
    for (const line of years) {
        const m = line.match(/#(\d{4})г/);
        if (m && Number(m[1]) > thisYear) { future.push(line); continue; }
        if (future.length) { parts.push(futureBlock()); future = []; }
        parts.push(htmlEsc(line));
    }
    if (future.length) parts.push(futureBlock());
    return htmlEsc(head) + "\n" + parts.join("\n");
}

export { jubileeText, approxOut };
