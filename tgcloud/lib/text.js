import { la, ageSuffix } from './astro.js';

const htmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function jubileeText(rec, note, detail = false) {
    const hasTime = rec.h !== undefined && rec.m !== undefined;
    const [y, mo, d] = rec.d.split("-").map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, rec.h !== undefined ? rec.h : 12, rec.m !== undefined ? rec.m : 0, 0));
    const head = rec.n + " " + rec.d + (hasTime ? " " + String(rec.h).padStart(2, "0") + ":" + String(rec.m).padStart(2, "0") : "")
        + (rec.dd ? " " + rec.dd : "")
        + ageSuffix(rec.n, rec.d, rec.dd)
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

export { jubileeText };
