import { TZ_MS, moonNew, mskToday } from './astro.js';

function gregToJdn(y, m, d) {
    const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
    return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

function julianToJdn(y, m, d) {
    const a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
    return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - 32083;
}

function jdnToGreg(j) {
    const a = j + 32044, b = Math.floor((4 * a + 3) / 146097), c = a - Math.floor(146097 * b / 4);
    const d = Math.floor((4 * c + 3) / 1461), e = c - Math.floor(1461 * d / 4), m2 = Math.floor((5 * e + 2) / 153);
    return [100 * b + d - 4800 + Math.floor(m2 / 10), m2 + 3 - 12 * Math.floor(m2 / 10), e - Math.floor((153 * m2 + 2) / 5) + 1];
}

function orthodoxEasterJdn(y) {
    const a = y % 4, b = y % 7, c = y % 19, d = (19 * c + 15) % 30, e = (2 * a + 4 * b - d + 34) % 7;
    return julianToJdn(y, Math.floor((d + e + 114) / 31), (d + e + 114) % 31 + 1);
}

function catholicEasterJdn(y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
    const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    return gregToJdn(y, Math.floor((h + l - 7 * m + 114) / 31), (h + l - 7 * m + 114) % 31 + 1);
}

const hebrewLeap = y => (7 * y + 1) % 19 < 7;

function hebrewRoshJdn(y) {
    const months = 235 * Math.floor((y - 1) / 19) + 12 * ((y - 1) % 19) + Math.floor((7 * ((y - 1) % 19) + 1) / 19);
    const total = 765433 * months + 31524;
    const day = Math.floor(total / 25920), parts = total % 25920;
    let d = day;
    if (parts >= 19440 || (day % 7 === 2 && parts >= 9924 && !hebrewLeap(y)) || (day % 7 === 1 && parts >= 16789 && hebrewLeap(y - 1))) d++;
    if (d % 7 === 0 || d % 7 === 3 || d % 7 === 5) d++;
    return d + 347997;
}

function jdnToHebrew(j) {
    let y = Math.floor((j - 347997) / 366) + 1;
    while (hebrewRoshJdn(y) > j) y--;
    while (hebrewRoshJdn(y + 1) <= j) y++;
    const len = hebrewRoshJdn(y + 1) - hebrewRoshJdn(y);
    const months = [30, len === 355 || len === 385 ? 30 : 29, len === 353 || len === 383 ? 29 : 30, 29, 30]
        .concat(hebrewLeap(y) ? [30, 29] : [29]).concat([30, 29, 30, 29, 30, 29]);
    let m = 0, rem = j - hebrewRoshJdn(y);
    while (rem >= months[m]) { rem -= months[m]; m++; }
    return [y, m + 1, rem + 1];
}

function lunarNewsFulls(j1, j2) {
    const dists = [];
    for (let j = j1 - 1; j <= j2 + 1; j++) {
        const [y, m, d] = jdnToGreg(j);
        dists.push([j, moonNew(new Date(Date.UTC(y, m - 1, d, 12, 0, 0))).phase]);
    }
    const news = [], fulls = [];
    for (let i = 1; i < dists.length - 1; i++) {
        const ph = dists[i][1], prev = dists[i - 1][1], next = dists[i + 1][1];
        const dn = Math.min(ph, 1 - ph), df = Math.abs(ph - 0.5);
        if (dn < Math.min(prev, 1 - prev) && dn <= Math.min(next, 1 - next) && dn < 0.2) news.push(dists[i][0]);
        if (df < Math.abs(prev - 0.5) && df <= Math.abs(next - 0.5) && df < 0.2) fulls.push(dists[i][0]);
    }
    return [news, fulls];
}

const ORTH_OFFS = [[-7, "Вход Господень в Иерусалим"], [-1, "Великая Суббота"], [0, "Пасха"], [9, "Радоница"], [39, "Вознесение Господне"], [49, "День Святой Троицы"]];
const CATH_OFFS = [[-46, "Пепельная среда"], [-7, "Вербное воскресенье"], [0, "Пасха"], [39, "Вознесение"], [49, "Пятидесятница"], [60, "Праздник Тела и Крови Христовых"]];
// фиксированные: юлианские даты (РПЦ), при выводе +13 дней
const ORTH_FIXED = [[9, 8, "Рождество Пресвятой Богородицы"], [9, 14, "Воздвижение Креста Господня"], [10, 1, "Покров Пресвятой Богородицы"], [11, 21, "Введение во храм Пресвятой Богородицы"], [12, 25, "Рождество Христово"], [1, 6, "Крещение Господне"], [2, 2, "Сретение Господне"], [3, 25, "Благовещение"], [7, 7, "Рождество Иоанна Предтечи"], [8, 6, "Преображение Господне"], [8, 15, "Успение Богородицы"], [8, 29, "Усекновение главы Иоанна Предтечи"]];
// фиксированные: григорианские даты
const CATH_FIXED = [[1, 6, "Богоявление"], [2, 2, "Сретение Господне"], [3, 19, "День святого Иосифа"], [3, 25, "Благовещение"], [6, 29, "Святых апостолов Петра и Павла"], [8, 6, "Преображение Господне"], [8, 15, "Успение Богородицы"], [9, 14, "Воздвижение Креста Господня"], [11, 1, "День всех святых"], [11, 21, "Введение во храм Пресвятой Богородицы"], [12, 8, "Непорочное зачатие Девы Марии"], [12, 25, "Рождество Христово"]];

// переносы по римскому мартирологу: если дата попадает в Страстную седмицу или Пасхальную октаву
function adjustCatholicFixed(j, m, d, e) {
    if (m === 3 && j >= e - 7 && j <= e + 7) {
        if (d === 19) return e - 8; // св. Иосиф — суббота перед Вербным воскресеньем
        if (d === 25) return e + 8; // Благовещение — понедельник после октавы Пасхи
    }
    return j;
}

function buildChristianDays(dayStart, dayEnd, easterJdn, offs, fixed, fixedToJdn, adjust) {
    const y0 = jdnToGreg(dayStart)[0], y1 = jdnToGreg(dayEnd)[0];
    const out = [];
    for (let y = y0 - 1; y <= y1 + 1; y++) {
        const e = easterJdn(y);
        for (const [o, name] of offs) {
            const j = e + o;
            if (j >= dayStart && j < dayEnd) out.push([j, name]);
        }
        for (const [m, d, name] of fixed) {
            const j = adjust(fixedToJdn(y, m, d), m, d, e);
            if (j >= dayStart && j < dayEnd) out.push([j, name]);
        }
    }
    return out;
}

const ISLAM_HOL = [[1, 1, "Исламский новый год"], [1, 10, "Ашура"], [3, 12, "Маулид ан-Наби"], [7, 27, "Исра и Мирадж"], [10, 1, "Ураза-байрам (Ид аль-Фитр)"], [12, 10, "Курбан-байрам (Ид аль-Адха)"]];

const ISLAM_ANCHOR_JDN = gregToJdn(2025, 6, 26); // 1 Мухаррам 1447

function buildIslamic(dayStart, dayEnd) {
    // месяц начинается на следующий день после астрономического новолуния (методика ДУМ РФ)
    const [news] = lunarNewsFulls(dayStart - 15, dayEnd);
    const starts = news.map(j => j + 1).filter(j => j >= ISLAM_ANCHOR_JDN);
    const out = [];
    for (let i = 0; i < starts.length; i++) {
        const m = i % 12 + 1;
        for (const [hm, hd, name] of ISLAM_HOL) if (m === hm) {
            const j = starts[i] + hd - 1;
            if (j >= dayStart && j < dayEnd) out.push([j, name]);
        }
    }
    return out;
}

const HEB_HOL = leap => leap
    ? [[1, 1, "Рош ха-Шана"], [1, 10, "Йом-Кипур"], [1, 15, "Суккот"], [1, 22, "Шмини Ацерет"], [1, 23, "Симхат Тора"], [3, 25, "Ханука"], [7, 14, "Пурим"], [8, 15, "Песах"], [10, 6, "Шавуот"], [12, 9, "Тиша бе-Ав"]]
    : [[1, 1, "Рош ха-Шана"], [1, 10, "Йом-Кипур"], [1, 15, "Суккот"], [1, 22, "Шмини Ацерет"], [1, 23, "Симхат Тора"], [3, 25, "Ханука"], [6, 14, "Пурим"], [7, 15, "Песах"], [9, 6, "Шавуот"], [11, 9, "Тиша бе-Ав"]];

function buildJewish(dayStart, dayEnd) {
    const out = [];
    for (let j = dayStart; j < dayEnd; j++) {
        const h = jdnToHebrew(j);
        for (const [hm, hd, name] of HEB_HOL(hebrewLeap(h[0]))) if (h[1] === hm && h[2] === hd) out.push([j, name]);
    }
    return out;
}

const BURYAT_MS = 8 * 3600 * 1000;

function moonPhaseAt(ms) {
    return moonNew(new Date(ms + TZ_MS)).phase;
}

function dawnMs(j) {
    const [y, m, d] = jdnToGreg(j);
    return Date.UTC(y, m - 1, d, 6, 0, 0) - BURYAT_MS;
}

// номер лунных суток (титхи), действующих на заре в Бурятии
function dawnLunarDay(j) {
    return Math.floor((moonPhaseAt(dawnMs(j)) % 1) * 30) + 1;
}

function nmTimeMs(j) {
    const [y, m, d] = jdnToGreg(j - 1);
    let bestT = 0, bestD = 2;
    for (let h = 0; h < 72; h++) {
        const t = Date.UTC(y, m - 1, d, h, 0, 0);
        const ph = moonPhaseAt(t);
        const dist = Math.min(ph, 1 - ph);
        if (dist < bestD) { bestD = dist; bestT = t; }
    }
    return bestT;
}

function nmDayLabel(ms) {
    const loc = new Date(ms + BURYAT_MS);
    const j = gregToJdn(loc.getUTCFullYear(), loc.getUTCMonth() + 1, loc.getUTCDate());
    return dawnMs(j) >= ms ? j : j + 1;
}

// день, на заре которого действуют k-е лунные сутки месяца (пропуск суток — ближайший следующий)
function dayWithTithi(day1, k) {
    for (let j = day1; j < day1 + k + 4; j++) if (dawnLunarDay(j) === k) return j;
    for (let j = day1; j < day1 + k + 4; j++) if (dawnLunarDay(j) > k) return j;
    return day1 + k - 1;
}

function buildBuddhist(dayStart, dayEnd) {
    const y0 = jdnToGreg(dayStart)[0], y1 = jdnToGreg(dayEnd)[0];
    const out = [];
    for (let y = y0 - 1; y <= y1 + 1; y++) {
        const [news] = lunarNewsFulls(gregToJdn(y, 2, 4), gregToJdn(y, 4, 10));
        const coarse = news.find(j => j >= gregToJdn(y, 2, 4));
        if (coarse === undefined) continue;
        let t = nmTimeMs(coarse);
        const day1s = [nmDayLabel(t)];
        for (let i = 1; i <= 9; i++) {
            let bestT = 0, bestD = 2;
            for (let off = 25 * 24; off < 36 * 24; off++) {
                const ph = moonPhaseAt(t + off * 3600000);
                const dist = Math.min(ph, 1 - ph);
                if (dist < bestD) { bestD = dist; bestT = t + off * 3600000; }
            }
            t = bestT;
            day1s.push(nmDayLabel(t));
        }
        out.push(
            [day1s[0], "Сагаалган (лунный новый год)"],
            [dayWithTithi(day1s[0], 15), "Дуйнхор-хурал (Калачакра)"],
            [dayWithTithi(day1s[3], 15), "Дончод-хурал (Весак)"],
            [dayWithTithi(day1s[4], 15), "Майдари-хурал"],
            [dayWithTithi(day1s[5], 4), "Чокхор Дючен"],
            [dayWithTithi(day1s[9], 25), "Зула-хурал"]);
    }
    return out;
}

const REL_DEFS = {
    orth: { name: "Православные", icon: "☦️", build: (a, b) => buildChristianDays(a, b, orthodoxEasterJdn, ORTH_OFFS, ORTH_FIXED, julianToJdn, j => j) },
    cath: { name: "Католические", icon: "✝️", build: (a, b) => buildChristianDays(a, b, catholicEasterJdn, CATH_OFFS, CATH_FIXED, gregToJdn, adjustCatholicFixed) },
    islam: { name: "Исламские", icon: "☪️", build: buildIslamic },
    jud: { name: "Иудейские", icon: "✡️", build: buildJewish },
    bud: { name: "Буддийские", icon: "☸️", build: buildBuddhist }
};
const REL_ORDER = ["orth", "islam", "bud", "cath", "jud"];

const todayJdn = () => gregToJdn(...mskToday());

// в диапазоне [dayStart, dayEnd), сортировка по дате
function relDays(key, dayStart, dayEnd) {
    return REL_DEFS[key].build(dayStart, dayEnd)
        .filter(x => x[0] >= dayStart && x[0] < dayEnd)
        .sort((a, b) => a[0] - b[0]);
}

const REL_RU = { orth: "Православные", islam: "Исламские", bud: "Буддийские", cath: "Католические", jud: "Иудейские" };

// дайджест на сегодня по включённым религиям; "" — молчание
function religiousDigest(settings) {
    const d0 = todayJdn();
    const parts = [];
    for (const key of REL_ORDER) {
        if (!settings[key]) continue;
        const days = relDays(key, d0, d0 + 1);
        if (days.length) parts.push(REL_RU[key] + ": " + days.map(x => x[1]).join(", "));
    }
    return parts.join("\n");
}

// все дни религии на год вперёд
function religiousYear(key) {
    const d0 = todayJdn();
    return relDays(key, d0, d0 + 366)
        .map(([j, name]) => jdnToGreg(j).map((x, i) => i < 3 ? String(x).padStart(i === 0 ? 4 : 2, "0") : x).slice(0, 3).join("-") + " " + name)
        .join("\n");
}

export { REL_DEFS, REL_ORDER, relDays, religiousDigest, religiousYear };
