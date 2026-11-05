import { la, ageSuffix } from './astro.js';
import { newStyleDate } from './religion.js';

const htmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// примерная дата текстом: гранулярность G — урезание («1234», «1234-05»),
// квалификатор Q — суффикс за датой: «?» ABT, «=» CAL, «<» BEF, «>» AFT,
// «~» EST (на любой гранулярности: «1234-05-06?», «1234-05?», «1234~»);
// точная дата — как есть (так же печатаются коллизии ключа в отчёте импорта)
const ABT_MARK = { 1: "?", 2: "=", 3: "<", 4: ">", 5: "~" };
function approxOut(d, abt) {
    const a = abt || 0, q = Math.floor(a / 3), g = a % 3;
    return d.slice(0, 10 - g * 3) + (ABT_MARK[q] || "");
}

function jubileeText(rec, note, detail = false) {
    const hasTime = rec.h !== undefined && rec.m !== undefined;
    // дата — по новому стилю с суффиксом (приблизительные — через approxOut);
    // хранение и экспорт остаются старым стилем (см. newStyleDate)
    const sd = newStyleDate(rec.d), sdd = rec.dd ? newStyleDate(rec.dd) : rec.dd;
    const [y, mo, d] = sd.split("-").map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, rec.h !== undefined ? rec.h : 12, rec.m !== undefined ? rec.m : 0, 0));
    const head = rec.n + " " + approxOut(sd, rec.abt || rec.mabt || 0) + (hasTime ? " " + String(rec.h).padStart(2, "0") + ":" + String(rec.m).padStart(2, "0") : "")
        + (sdd ? " " + approxOut(sdd, rec.dabt || rec.mabt || 0) : "")
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
