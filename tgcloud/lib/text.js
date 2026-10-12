import { la, ageSuffix } from './astro.js';

function jubileeText(rec, note, detail = false) {
    const hasTime = rec.h !== undefined && rec.m !== undefined;
    const [y, mo, d] = rec.d.split("-").map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, rec.h !== undefined ? rec.h : 12, rec.m !== undefined ? rec.m : 0, 0));
    const head = rec.n + " " + rec.d + (hasTime ? " " + String(rec.h).padStart(2, "0") + ":" + String(rec.m).padStart(2, "0") : "")
        + ageSuffix(rec.n, rec.d)
        + (note ? "\n" + note : "");
    return head + "\n" + la(t, detail).join("\n");
}

export { jubileeText };
