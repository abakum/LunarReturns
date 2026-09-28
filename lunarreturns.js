#!/usr/bin/env node
// lunarreturns.js — VK-бот лунно-солнечных юбилеев (порт логики из
// LunarReturns/index.html). Один файл, ноль зависимостей, Node >= 18.
//
// Запуск:  VK_TOKEN=... node lunarreturns.js
// Проверка без токена:  node lunarreturns.js test "Дедушка Костя 1963-09-27 12:30 (Пермь)"
"use strict";

// ============================== ASTRO ==============================
// Дословный порт из LunarReturns/index.html (moonNew, титхи, зодиаки,
// legend, la). TZ_MS — смещение МСК.

const TZ_MS = 3 * 3600 * 1000;
const SPACE = "\u2002\u2004";
const WIDE_SPACE = "\u2003\u2004";

function moonNew(date) {
    const fixangle = a => a - 360 * Math.floor(a / 360);
    const sin = d => Math.sin(d * Math.PI / 180);
    const jde = (date.getTime() - TZ_MS) / 86400000 + 2440587.5;
    const T = (jde - 2451545.0) / 36525;
    const Lp = 218.3164477 + 481267.88123421 * T - 0.0015786 * T * T + T ** 3 / 538841 - T ** 4 / 65194000;
    const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T * T + T ** 3 / 545868 - T ** 4 / 113065000;
    const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T * T + T ** 3 / 24490000;
    const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T * T + T ** 3 / 69699 - T ** 4 / 14712000;
    const F = 93.2720950 + 483202.0175233 * T - 0.0036539 * T * T - T ** 3 / 3526000 + T ** 4 / 863310000;
    const TERMS = [
        [0, 0, 1, 0, 6288774], [2, 0, -1, 0, 1274027], [2, 0, 0, 0, 658314], [0, 0, 2, 0, 213618],
        [0, 1, 0, 0, -185116], [0, 0, 0, 2, -114332], [2, 0, -2, 0, 58793], [2, -1, -1, 0, 57066],
        [2, 0, 1, 0, 53322], [2, -1, 0, 0, 45758], [0, 1, -1, 0, -40923], [1, 0, 0, 0, -34720],
        [0, 1, 1, 0, -30383], [2, 0, 0, -2, 15327], [0, 0, 1, 2, -12528], [0, 0, 1, -2, 10980],
        [4, 0, -1, 0, 10675], [0, 0, 3, 0, 10034], [4, 0, -2, 0, 8548], [2, 1, -1, 0, -7888],
        [2, 1, 0, 0, -6766], [1, 0, -1, 0, -5163], [1, 1, 0, 0, 4987], [2, -1, 1, 0, 4036],
        [2, 0, 2, 0, 3994], [4, 0, 0, 0, 3861], [2, 0, -3, 0, 3665], [0, 1, -2, 0, -2689],
        [2, 0, -1, 2, -2602], [2, -1, -2, 0, 2390], [1, 0, 1, 0, -2348], [2, -2, 0, 0, 2236],
        [0, 1, 2, 0, -2120], [0, 2, 0, 0, -2069], [2, -2, -1, 0, 2048], [2, 0, 1, -2, -1773],
        [2, 0, 0, 2, -1595], [4, -1, -1, 0, 1215], [0, 0, 2, 2, -1110], [3, 0, -1, 0, -892],
        [2, 1, 1, 0, -810], [4, -1, -2, 0, 759], [0, 2, -1, 0, -713], [2, 2, -1, 0, -700],
        [2, 1, -2, 0, 691], [2, -1, 0, -2, 596], [4, 0, 1, 0, 549], [0, 0, 4, 0, 537],
        [4, -1, 0, 0, 520], [1, 0, -2, 0, -487], [2, 1, 0, -2, -399], [0, 0, 2, -2, -381],
        [1, 1, 1, 0, 351], [3, 0, -2, 0, -340], [4, 0, -3, 0, 330], [2, -1, 2, 0, 327],
        [0, 2, 1, 0, -323], [1, 1, -1, 0, 299], [2, 0, 3, 0, 294]
    ];
    let sum = 0;
    for (const [d, m, mp, f, c] of TERMS) sum += c * sin(d * D + m * M + mp * Mp + f * F);
    const A1 = 119.75 + 131.849 * T;
    const A2 = 53.09 + 479264.290 * T;
    sum += 3958 * sin(A1) + 1962 * sin(Lp - F) + 318 * sin(A2);
    const moonLon = Lp + sum / 1e6;
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const Ms = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
    const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(Ms)
        + (0.019993 - 0.000101 * T) * sin(2 * Ms) + 0.000289 * sin(3 * Ms);
    const sunLon = L0 + C;
    return { phase: fixangle(moonLon - sunLon) / 360, longitude: fixangle(moonLon) };
}

const PHASE_ICON = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
const PHASE_RU = ["Новолуние", "Молодая луна", "Первая четверть", "Прибывающая луна", "Полнолуние", "Убывающая луна", "Последняя четверть", "Старая луна"];
const TITHI_PHASE = [0, 1, 1, 1, 1, 1, 2, 2, 3, 3, 3, 3, 3, 3, 4, 5, 5, 5, 5, 5, 5, 6, 6, 7, 7, 7, 7, 7, 7, 0];
const phaseName = (n, ru) => (ru ? PHASE_RU : PHASE_ICON)[TITHI_PHASE[n - 1]];

const tithiInt = m => Math.floor(m.phase * 30) + 1;
const TITHI_BASE = ["пратипада", "двитья", "трития", "чатуртхи", "панчами", "шаштхи",
    "саптами", "аштами", "навами", "дашами", "экадаши", "двадаши", "трайодаши", "чатурдаши"];
const tithiName = n => n === 15 ? "пурнима" : n === 30 ? "амавасья" : TITHI_BASE[(n - 1) % 15];

const MZODIAC_ICON = ["♈︎", "♉︎", "♊︎", "♋︎", "♌︎", "♍︎", "♎︎", "♏︎", "♐︎", "♑︎", "♒︎", "♓︎"];
const MZODIAC_RU = ["овен", "телец", "близнецы", "рак", "лев", "дева", "весы", "скорпион", "стрелец", "козерог", "водолей", "рыбы"];
const norm360 = a => a - 360 * Math.floor(a / 360);
function moonZodiacInt(m) {
    return Math.floor(norm360(m.longitude) / 30) % 12;
}

const moonZodiacName = (m, ru) => (ru ? MZODIAC_RU : MZODIAC_ICON)[moonZodiacInt(m)];

const ZODIAC_ICON = ["♈︎", "♉︎", "♊︎", "♋︎", "♌︎", "♍︎", "♎︎", "♏︎", "♐︎", "♑︎", "♒︎", "♓︎"];
const ZODIAC_RU = ["Овен", "Телец", "Близнецы", "Рак", "Лев", "Дева", "Весы", "Скорпион", "Стрелец", "Козерог", "Водолей", "Рыбы"];
function sunZodiacInts(date) {
    const mo = date.getUTCMonth() + 1, d = date.getUTCDate();
    const A = 0, T = 1, G = 2, C = 3, L = 4, V = 5, Li = 6, S = 7, Sg = 8, Cp = 9, Aq = 10, P = 11;
    switch (mo) {
        case 1: return d < 20 ? [Cp] : d === 20 ? [Cp, Aq] : [Aq];
        case 2: return d < 18 ? [Aq] : d === 18 ? [Aq, P] : [P];
        case 3: return d < 20 ? [P] : d === 20 ? [P, A] : [A];
        case 4: return d < 19 ? [A] : d === 19 ? [A, T] : [T];
        case 5: return d < 20 ? [T] : d === 20 ? [T, G] : [G];
        case 6: return d < 21 ? [G] : d === 21 ? [G, C] : [C];
        case 7: return d < 22 ? [C] : d === 22 ? [C, L] : [L];
        case 8: return d < 22 ? [L] : d === 22 ? [L, V] : [V];
        case 9: return d < 22 ? [V] : d === 22 ? [V, Li] : [Li];
        case 10: return d < 23 ? [Li] : d === 23 ? [Li, S] : [S];
        case 11: return d < 22 ? [S] : d === 22 ? [S, Sg] : [Sg];
        case 12: return d < 21 ? [Sg] : d === 21 ? [Sg, Cp] : [Cp];
    }
    return [P];
}
const sunZodiacNames = (date, ru) => sunZodiacInts(date).map(i => (ru ? ZODIAC_RU : ZODIAC_ICON)[i]);

const CZODIAC_ICON = ["🐒", "🐓", "🐕", "🐖", "🐀", "🐂", "🐅", "🐇", "🐉", "🐍", "🐎", "🐐"];
const CZODIAC_RU = ["Обезьяна", "Петух", "Собака", "Свинья", "Крыса", "Бык", "Тигр", "Кролик", "Дракон", "Змея", "Лошадь", "Коза"];
const chineseZodiacName = (date, ru) => (ru ? CZODIAC_RU : CZODIAC_ICON)[date.getUTCFullYear() % 12];

const WD_RU = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
function wdLocale(t) {
    let iso = t.getUTCDay();
    const s = WD_RU[iso];
    if (iso === 0) iso = 7;
    const icon = String.fromCharCode(0x30 + iso) + "\uFE0F\u20E3";
    return [icon, s];
}

const hashTag = s => "#" + s.toLowerCase().replace(/ /g, "_");

const addYears = (t, i) => new Date(Date.UTC(t.getUTCFullYear() + i, t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), 0));

function legend(t) {
    const mMid = moonNew(t);
    const n0 = tithiInt(mMid);
    const p0 = phaseName(n0, false);
    const z0 = moonZodiacName(mMid, false);
    const [w0, wh] = wdLocale(t);
    const s0 = sunZodiacNames(t, false)[0];
    const v0 = chineseZodiacName(t, false);
    const t0 = n0 > 15 ? "☾" : "☽";
    return s0 + hashTag(sunZodiacNames(t, true)[0]) + "\n" +
        v0 + hashTag(chineseZodiacName(t, true)) + "\n" +
        w0 + hashTag(wh) + "\n" +
        z0 + hashTag(moonZodiacName(mMid, true)) + "_\n" +
        p0 + hashTag(phaseName(n0, true)) + "\n" +
        String((n0 - 1) % 15 + 1).padStart(2, "0") + (n0 > 15 ? "☾#" : "☽#") + tithiName(n0) + (n0 > 15 ? "_" : "");
}

function la(birth) {
    const mMid = moonNew(birth);
    const n0 = tithiInt(mMid);
    const p0 = phaseName(n0, false);
    const z0 = moonZodiacName(mMid, false);
    const [w0] = wdLocale(birth);
    const s0 = sunZodiacNames(birth, false)[0];
    const v0 = chineseZodiacName(birth, false);
    const sq = z0 === s0 ? "²" : "";
    const t0 = n0 > 15 ? "☾" : "☽";
    const yl = "г";
    const f = new Date().getFullYear() - birth.getUTCFullYear();
    const years = [legend(birth) + "\n#" + birth.getUTCFullYear() + yl + " " + v0 + w0 + z0 + sq + p0 + t0];
    let fc = 0;
    for (let i = 1; fc < 1; i++) {
        const bd = addYears(birth, i);
        const m = moonNew(addYears(birth, i));
        let c = 0;
        let [w] = wdLocale(bd);
        if (w0 === w) c++; else w = WIDE_SPACE;
        let p = WIDE_SPACE;
        let t = "";
        if (TITHI_PHASE[tithiInt(m) - 1] === TITHI_PHASE[n0 - 1]) { c++; p = p0; }
        if (tithiInt(m) === n0) { c++; t = t0; }
        let z = moonZodiacName(m, false);
        if (z0 === z) c++; else z = SPACE;
        let v = chineseZodiacName(bd, false);
        if (v0 === v) c++; else v = WIDE_SPACE;
        if (i >= f && c > 0 || c > 1 && i < 90) {
            years.push("#" + bd.getUTCFullYear() + yl + " " + v + w + z + p + t);
            if (i > f && c > 0) fc++;
        }
        if (i > 500) break;
    }
    return years;
}

const WED = {
    1: "ситцевая", 2: "бумажная", 3: "кожаная", 4: "льняная", 5: "деревянная",
    6: "чугунная", 7: "медная", 8: "жестяная", 9: "фаянсовая", 10: "оловянная",
    11: "стальная", 12: "никелевая", 13: "кружевная", 14: "агатовая", 15: "стеклянная",
    16: "бирюзовая", 17: "розовая", 18: "гранатовая", 19: "криптоновая", 20: "фарфоровая",
    21: "опаловая", 22: "бронзовая", 23: "берилловая", 24: "сатиновая", 25: "серебряная",
    30: "жемчужная", 35: "полотняная", 40: "рубиновая", 45: "сапфировая", 50: "золотая",
    55: "изумрудная", 60: "бриллиантовая", 65: "железная", 70: "благодатная", 75: "корональная",
    80: "дубовая"
};

function ageSuffix(n, d) {
    const age = mskToday()[0] - Number(d.slice(0, 4));
    if (age < 1) return "";
    return " " + age + (n.includes("+") && WED[age] ? " " + WED[age] : "");
}

const mskToday = () => {
    const t = new Date(Date.now() + TZ_MS);
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};

// ============================== ГОРОДА ==============================
const ZONE_EPOCHS=[["",0,"1941-09-20",-1,"1942-11-02",-2,"1943-03-29",-1,"1943-10-04",-2,"1943-11-06",0,"1990-07-01",-1,"1990-09-30",0,"1992-01-19",-1,"2011-10-30",-2,"2012-03-25",-1,"2012-10-28",-2,"2013-03-31",-1,"2013-10-27",-2,"2014-03-30",-1,"2015-03-29",0,"2015-10-25",-1,"2016-03-27",0,"2016-10-30",-1,"2017-03-26",0,"2017-10-29",-1,"2018-03-25",0,"2018-10-28",-1,"2019-03-31",0,"2019-10-27",-1,"2020-03-29",0,"2020-10-25",-1,"2021-03-28",0,"2021-10-31",-1,"2022-03-27",0,"2022-10-30",-1,"2023-03-26",0,"2023-10-29",-1,"2024-03-31",0,"2024-10-27",-1,"2025-03-30",0,"2025-10-26",-1,"2026-03-29",0,"2026-10-25",-1],["",0,"1941-11-01",-1,"1942-11-02",-2,"1943-03-29",-1,"1943-10-04",-2,"1944-04-03",-1,"1944-04-13",0,"1990-03-25",-1,"1990-07-01",-2,"1990-09-30",-1,"1991-09-29",0,"1992-01-19",-1,"1994-05-01",0,"1997-03-30",-1,"2011-10-30",-2,"2012-03-25",-1,"2012-10-28",-2,"2013-03-31",-1,"2013-10-27",-2,"2014-03-30",0],["",0,"1941-06-28",-1,"1942-11-02",-2,"1943-03-29",-1,"1943-10-04",-2,"1944-04-03",-1,"1944-07-03",0,"1990-03-25",-1,"1990-09-30",0,"1992-01-19",-1,"2014-10-26",0],["",-2,"1940-08-03",0,"1941-06-24",-1,"1942-11-02",-2,"1943-03-29",-1,"1943-10-04",-2,"1944-04-03",-1,"1944-08-01",0,"1989-03-26",-1,"1991-03-31",0,"1992-01-19",-1,"1998-03-29",-2,"1999-10-31",-1,"2000-03-26",-2,"2000-10-29",-1,"2001-03-25",-2,"2001-10-28",-1,"2002-03-31",-2,"2002-10-27",-1,"2011-10-30",-2,"2012-03-25",-1,"2012-10-28",-2,"2013-03-31",-1,"2013-10-27",-2,"2014-03-30",-1,"2015-03-29",0,"2015-10-25",-1,"2016-03-27",0,"2016-10-30",-1,"2017-03-26",0,"2017-10-29",-1,"2018-03-25",0,"2018-10-28",-1,"2019-03-31",0,"2019-10-27",-1,"2020-03-29",0,"2020-10-25",-1,"2021-03-28",0,"2021-10-31",-1,"2022-03-27",0,"2022-10-30",-1,"2023-03-26",0,"2023-10-29",-1,"2024-03-31",0,"2024-10-27",-1,"2025-03-30",0,"2025-10-26",-1,"2026-03-29",0,"2026-10-25",-1],["",-1,"1940-08-05",0,"1941-07-01",-1,"1942-11-02",-2,"1943-03-29",-1,"1943-10-04",-2,"1944-04-03",-1,"1944-10-02",-2,"1944-10-13",0,"1989-03-26",-1,"1991-03-31",0,"1992-01-19",-1,"1996-09-29",-2,"1996-10-27",-1,"2000-03-26",-2,"2000-10-29",-1,"2011-10-30",-2,"2012-03-25",-1,"2012-10-28",-2,"2013-03-31",-1,"2013-10-27",-2,"2014-03-30",-1,"2015-03-29",0,"2015-10-25",-1,"2016-03-27",0,"2016-10-30",-1,"2017-03-26",0,"2017-10-29",-1,"2018-03-25",0,"2018-10-28",-1,"2019-03-31",0,"2019-10-27",-1,"2020-03-29",0,"2020-10-25",-1,"2021-03-28",0,"2021-10-31",-1,"2022-03-27",0,"2022-10-30",-1,"2023-03-26",0,"2023-10-29",-1,"2024-03-31",0,"2024-10-27",-1,"2025-03-30",0,"2025-10-26",-1,"2026-03-29",0,"2026-10-25",-1],["",-1,"1940-08-06",0,"1941-09-15",-1,"1942-11-02",-2,"1943-03-29",-1,"1943-10-04",-2,"1944-04-03",-1,"1944-09-22",0,"1989-03-26",-1,"1991-03-31",0,"1992-01-19",-1,"2000-03-26",-2,"2000-10-29",-1,"2001-03-25",-2,"2001-10-28",-1,"2011-10-30",-2,"2012-03-25",-1,"2012-10-28",-2,"2013-03-31",-1,"2013-10-27",-2,"2014-03-30",-1,"2015-03-29",0,"2015-10-25",-1,"2016-03-27",0,"2016-10-30",-1,"2017-03-26",0,"2017-10-29",-1,"2018-03-25",0,"2018-10-28",-1,"2019-03-31",0,"2019-10-27",-1,"2020-03-29",0,"2020-10-25",-1,"2021-03-28",0,"2021-10-31",-1,"2022-03-27",0,"2022-10-30",-1,"2023-03-26",0,"2023-10-29",-1,"2024-03-31",0,"2024-10-27",-1,"2025-03-30",0,"2025-10-26",-1,"2026-03-29",0,"2026-10-25",-1],["",-2,"1940-04-01",-1,"1942-11-02",-2,"1943-03-29",-1,"1943-10-04",-2,"1944-04-03",-1,"1944-10-02",-2,"1945-04-02",-1,"1945-04-29",0,"1945-11-01",-1,"1946-04-07",0,"1989-03-26",-1,"1991-03-31",0,"1992-01-19",-1],["",1,"1988-03-27",0,"1991-03-31",1,"1991-09-29",2,"1992-01-19",1,"1992-03-29",0,"2018-10-28",1,"2020-12-27",0],["",1,"1989-03-26",0,"1991-03-31",1,"1991-09-29",2,"1992-01-19",1,"1992-03-29",0,"2016-03-27",1],["",1,"1989-03-26",0,"1991-03-31",1,"1991-09-29",2,"1992-01-19",1,"1992-03-29",0],["",1,"1989-03-26",0,"1991-09-29",1,"1991-10-20",2,"1992-01-19",1,"2010-03-28",0,"2014-10-26",1],["",1,"1988-03-27",0,"1991-03-31",1,"1991-09-29",2,"1992-01-19",1,"1992-03-29",0,"2016-12-04",1],["",1,"1989-03-26",0,"2016-03-27",1],["",2],["",3],["",4,"1993-05-23",3,"2016-07-24",4],["",4,"1995-05-28",3,"2016-03-27",4],["",4,"2002-05-01",3,"2016-05-29",4],["",4,"2010-03-28",3,"2014-10-26",4],["",4],["",5],["",6,"2014-10-26",5,"2016-03-27",6],["",6],["",7],["",6,"1945-08-25",8,"1981-09-30",7,"1981-10-01",8,"1982-09-30",7,"1982-10-01",8,"1983-09-30",7,"1983-10-01",8,"1997-03-30",7,"2016-03-27",8],["",8,"1981-09-30",7,"1981-10-01",8,"1982-09-30",7,"1982-10-01",8,"1983-09-30",7,"1983-10-01",8,"2014-10-26",7,"2016-04-24",8],["",9,"1981-03-31",10,"1981-04-01",9,"1981-09-30",8,"1981-10-01",9,"1982-03-31",10,"1982-04-01",9,"1982-09-30",8,"1982-10-01",9,"1983-03-31",10,"1983-04-01",9,"1983-09-30",8,"1983-10-01",9,"1984-03-31",10,"1984-04-01",9,"2010-03-28",8,"2014-10-26",9],["",10,"1981-03-31",11,"1981-04-01",10,"1981-09-30",9,"1981-10-01",10,"1982-04-01",9,"1982-09-30",8,"1982-10-01",9,"1983-03-31",10,"1983-04-01",9,"1983-09-30",8,"1983-10-01",9,"1984-03-31",10,"1984-04-01",9,"2010-03-28",8,"2014-10-26",9],["",3,"2005-03-27",2,"2005-10-30",3,"2006-03-26",2,"2006-10-29",3,"2007-03-25",2,"2007-10-28",3,"2008-03-30",2,"2008-10-26",3,"2009-03-29",2,"2009-10-25",3,"2010-03-28",2,"2010-10-31",3,"2011-03-27",2,"2014-10-26",3,"2024-03-01",2],["",2,"1981-10-01",3,"1982-04-01",2,"1991-09-29",3,"1992-03-29",2,"2004-10-31",3,"2005-03-27",2,"2005-10-30",3,"2006-03-26",2,"2006-10-29",3,"2007-03-25",2,"2007-10-28",3,"2008-03-30",2,"2008-10-26",3,"2009-03-29",2,"2009-10-25",3,"2010-03-28",2,"2010-10-31",3,"2011-03-27",2,"2014-10-26",3,"2018-12-21",2],["",2,"1981-10-01",3,"1982-04-01",2,"2005-03-27",1,"2005-10-30",2,"2006-03-26",1,"2006-10-29",2,"2007-03-25",1,"2007-10-28",2,"2008-03-30",1,"2008-10-26",2,"2009-03-29",1,"2009-10-25",2,"2010-03-28",1,"2010-10-31",2,"2011-03-27",1,"2014-10-26",2],["",2,"1981-04-01",1,"1981-10-01",3,"1982-04-01",2,"1999-03-28",1,"2004-10-31",2,"2005-03-27",1,"2005-10-30",2,"2006-03-26",1,"2006-10-29",2,"2007-03-25",1,"2007-10-28",2,"2008-03-30",1,"2008-10-26",2,"2009-03-29",1,"2009-10-25",2,"2010-03-28",1,"2010-10-31",2,"2011-03-27",1,"2014-10-26",2],["",2,"1981-04-01",1,"1981-10-01",3,"1982-04-01",2,"1994-09-25",1,"2004-10-31",2,"2005-03-27",1,"2005-10-30",2,"2006-03-26",1,"2006-10-29",2,"2007-03-25",1,"2007-10-28",2,"2008-03-30",1,"2008-10-26",2,"2009-03-29",1,"2009-10-25",2,"2010-03-28",1,"2010-10-31",2,"2011-03-27",1,"2014-10-26",2],["",3,"1992-01-19",2,"1992-03-29",1,"1992-09-27",2,"1993-03-28",1,"1993-09-26",2,"1994-03-27",1,"1994-09-25",2,"1995-03-26",1,"1995-09-24",2,"1996-03-31",1,"1996-10-27",2,"1997-03-30",1,"1997-10-26",2,"1998-03-29",1,"1998-10-25",2,"1999-03-28",1,"1999-10-31",2,"2000-03-26",1,"2000-10-29",2,"2001-03-25",1,"2001-10-28",2,"2002-03-31",1,"2002-10-27",2,"2003-03-30",1,"2003-10-26",2,"2004-03-28",1,"2004-10-31",2,"2005-03-27",1,"2005-10-30",2,"2006-03-26",1,"2006-10-29",2,"2007-03-25",1,"2007-10-28",2,"2008-03-30",1,"2008-10-26",2,"2009-03-29",1,"2009-10-25",2,"2010-03-28",1,"2010-10-31",2,"2011-03-27",1,"2014-10-26",2],["",2,"1992-03-29",1,"1992-09-27",2,"1993-03-28",1,"1993-09-26",2,"1994-03-27",1,"1994-09-25",2,"1995-03-26",1,"1995-09-24",2,"1996-03-31",1,"1996-10-27",2,"1997-03-30",1,"1997-10-26",2,"1998-03-29",1,"1998-10-25",2,"1999-03-28",1,"1999-10-31",2,"2000-03-26",1,"2000-10-29",2,"2001-03-25",1,"2001-10-28",2,"2002-03-31",1,"2002-10-27",2,"2003-03-30",1,"2003-10-26",2,"2004-03-28",1,"2004-10-31",2,"2005-03-27",1,"2005-10-30",2,"2006-03-26",1,"2006-10-29",2,"2007-03-25",1,"2007-10-28",2,"2008-03-30",1,"2008-10-26",2,"2009-03-29",1,"2009-10-25",2,"2010-03-28",1,"2010-10-31",2,"2011-03-27",1,"2014-10-26",2],["",3,"1991-09-09",2,"1991-09-29",3,"1992-01-19",2,"1992-03-29",1,"1992-09-27",2,"1993-03-28",1,"1993-09-26",2,"1994-03-27",1,"1994-09-25",2,"1995-03-26",1,"1995-09-24",2,"1996-03-31",1,"1996-10-27",2,"1997-03-30",1,"1997-10-26",2,"1998-03-29",1,"1998-10-25",2,"1999-03-28",1,"1999-10-31",2,"2000-03-26",1,"2000-10-29",2,"2001-03-25",1,"2001-10-28",2,"2002-03-31",1,"2002-10-27",2,"2003-03-30",1,"2003-10-26",2,"2004-03-28",1,"2004-10-31",2,"2005-03-27",1,"2005-10-30",2,"2006-03-26",1,"2006-10-29",2,"2007-03-25",1,"2007-10-28",2,"2008-03-30",1,"2008-10-26",2,"2009-03-29",1,"2009-10-25",2,"2010-03-28",1,"2010-10-31",2,"2011-03-27",1,"2014-10-26",2],["",3,"1991-08-31",2,"1991-09-29",3,"1992-01-19",2,"1992-03-29",1,"1992-04-12",2,"1993-03-28",1,"1993-04-11",2,"1994-03-27",1,"1994-04-10",2,"1995-03-26",1,"1995-04-09",2,"1996-03-31",1,"1996-04-07",2,"1996-09-29",1,"1996-10-27",2,"2005-10-30",3,"2006-03-26",2,"2006-10-29",3,"2007-03-25",2,"2007-10-28",3,"2008-03-30",2,"2008-10-26",3,"2009-03-29",2,"2009-10-25",3,"2010-03-28",2,"2010-10-31",3,"2011-03-27",2,"2014-10-26",3],["",0,"1957-03-01",1,"1992-01-19",0,"1992-09-27",1,"1993-03-28",0,"1993-09-26",1,"1994-03-27",0,"1994-09-25",1,"1995-03-26",0,"1995-09-24",1,"2011-10-30",0,"2012-03-25",1,"2012-10-28",0,"2013-03-31",1,"2013-10-27",0,"2014-03-30",1,"2015-03-29",2,"2015-10-25",1],["",0,"1957-03-01",1,"1992-01-19",0,"1994-09-25",1,"1996-10-27",2,"1997-03-30",1,"2004-06-27",0,"2005-10-30",1,"2006-03-26",0,"2006-10-29",1,"2007-03-25",0,"2007-10-28",1,"2008-03-30",0,"2008-10-26",1,"2009-03-29",0,"2009-10-25",1,"2010-03-28",0,"2010-10-31",1,"2011-03-27",0,"2014-10-26",1],["",0,"1957-03-01",1,"1992-01-19",0,"1995-09-24",1,"1996-03-31",0,"1996-10-27",1,"2011-10-30",0,"2014-10-26",1]];
const CITY_ZONE={"Киев":0,"Харьков":0,"Ровно":0,"Луцк":0,"Тернополь":0,"Хмельницкий":0,"Винница":0,"Житомир":0,"Черкассы":0,"Чернигов":0,"Сумы":0,"Полтава":0,"Черновцы":0,"Ужгород":0,"Мукачево":0,"Запорожье":0,"Днепр":0,"Кривой Рог":0,"Днепропетровск":0,"Никополь":0,"Симферополь":1,"Севастополь":1,"Керчь":1,"Феодосия":1,"Ялта":1,"Минск":2,"Гомель":2,"Брест":2,"Гродно":2,"Витебск":2,"Могилёв":2,"Бобруйск":2,"Вильнюс":3,"Каунас":3,"Клайпеда":3,"Шяуляй":3,"Рига":4,"Даугавпилс":4,"Лиепая":4,"Резекне":4,"Елгава":4,"Таллин":5,"Тарту":5,"Нарва":5,"Пярну":5,"Кохтла-Ярве":5,"Калининград":6,"Советск":6,"Балтийск":6,"Черняховск":6,"Волгоград":7,"Волжский":7,"Камышин":7,"Михайловка":7,"Астрахань":8,"Знаменск":8,"Киров":9,"Кирово-Чепецк":9,"Вятские Поляны":9,"Самара":10,"Тольятти":10,"Сызрань":10,"Новокуйбышевск":10,"Чапаевск":10,"Саратов":11,"Энгельс":11,"Балаково":11,"Балашов":11,"Ульяновск":12,"Димитровград":12,"Екатеринбург":13,"Челябинск":13,"Магнитогорск":13,"Тюмень":13,"Курган":13,"Пермь":13,"Уфа":13,"Стерлитамак":13,"Салават":13,"Ижевск":13,"Нижний Тагил":13,"Сургут":13,"Нижневартовск":13,"Ханты-Мансийск":13,"Надым":13,"Ноябрьск":13,"Омск":14,"Исилькуль":14,"Калачинск":14,"Новосибирск":15,"Бердск":15,"Искитим":15,"Карасук":15,"Барабинск":15,"Барнаул":16,"Бийск":16,"Рубцовск":16,"Алейск":16,"Славгород":16,"Томск":17,"Северск":17,"Стрежевой":17,"Асино":17,"Кемерово":18,"Новокузнецк":18,"Прокопьевск":18,"Междуреченск":18,"Белово":18,"Ленинск-Кузнецкий":18,"Красноярск":19,"Норильск":19,"Ачинск":19,"Канск":19,"Железногорск":19,"Лесосибирск":19,"Минусинск":19,"Кызыл":19,"Абакан":19,"Черногорск":19,"Саяногорск":19,"Шарыпово":19,"Иркутск":20,"Ангарск":20,"Братск":20,"Улан-Удэ":20,"Северобайкальск":20,"Усть-Илимск":20,"Шелехов":20,"Гусиноозёрск":20,"Кяхта":20,"Чита":21,"Краснокаменск":21,"Нерчинск":21,"Борзя":21,"Якутск":22,"Нерюнгри":22,"Алдан":22,"Покровск":22,"Ленск":22,"Владивосток":23,"Уссурийск":23,"Находка":23,"Артём":23,"Хабаровск":23,"Комсомольск-на-Амуре":23,"Амурск":23,"Советская Гавань":23,"Биробиджан":23,"Облучье":23,"Дальнереченск":23,"Спасск-Дальний":23,"Южно-Сахалинск":24,"Корсаков":24,"Холмск":24,"Оха":24,"Долинск":24,"Магадан":25,"Сусуман":25,"Сокол":25,"Ола":25,"Петропавловск-Камчатский":26,"Елизово":26,"Вилючинск":26,"Анадырь":27,"Певек":27,"Билибино":27,"Алматы":28,"Талдыкорган":28,"Усть-Каменогорск":28,"Семей":28,"Караганда":28,"Балхаш":28,"Жезказган":28,"Тараз":28,"Шымкент":28,"Каскелен":28,"Есик":28,"Кызылорда":29,"Байконур":29,"Аральск":29,"Актобе":30,"Уральск":30,"Кандыагаш":30,"Атырау":31,"Кульсары":31,"Актау":32,"Жанаозен":32,"Форт-Шевченко":32,"Ташкент":33,"Самарканд":33,"Бухара":33,"Фергана":33,"Андижан":33,"Наманган":33,"Коканд":33,"Нукус":33,"Карши":33,"Термез":33,"Джизак":33,"Гулистан":33,"Чирчик":33,"Алмалык":33,"Ангрен":33,"Навои":33,"Ашхабат":34,"Туркменабат":34,"Дашогуз":34,"Мары":34,"Балканабат":34,"Душанбе":35,"Худжанд":35,"Куляб":35,"Хорог":35,"Турсунзаде":35,"Бишкек":36,"Ош":36,"Джалал-Абад":36,"Каракол":36,"Токмок":36,"Узген":36,"Баку":37,"Сумгаит":37,"Гянджа":37,"Мингечевир":37,"Шеки":37,"Ленкорань":37,"Тбилиси":38,"Кутаиси":38,"Батуми":38,"Рустави":38,"Зугдиди":38,"Гори":38,"Поти":38,"Ахалцихе":38,"Ереван":39,"Гюмри":39,"Ванадзор":39,"Эчмиадзин":39,"Капан":39,"Раздан":39};
// Триггеры: "Костя 19630927", "Дедушка Костя 1963-09-27 14:30",
// "… 12:30 (МСК+2)", "… 12:30 (Пермь)", "… 12:30 UTC+5"
// Результат — запись в МСК: { n, d, h, m } как в приложении.

function cityDiffMin(city, d) {
    const ep = ZONE_EPOCHS[CITY_ZONE[city]];
    let diff = ep[1];
    for (let i = 2; i < ep.length; i += 2) if (d >= ep[i]) diff = ep[i + 1];
    return diff * 60;
}

const CITY_INDEX = (() => {
    const m = {};
    for (const c in CITY_ZONE) m[c.toLowerCase()] = c;
    return m;
})();

// "МСК+2", "UTC-3", "ГМТ+5" → минут от UTC; null если не сдвиг
function explicitZoneMinutes(s) {
    const m = s.toLowerCase().match(/^(мск|москв[а-яё]*|utc|gmt|гмт|гринвич|гринуич)\s*([+-])\s*(\d{1,2})$/i);
    if (!m) return null;
    const base = m[1].startsWith("мск") || m[1].startsWith("москв") ? 3 : 0;
    return (base + (m[2] === "+" ? 1 : -1) * Number(m[3])) * 60;
}

// 1: имя, 2-4: дата, 5-6: время, 7: зона в скобках, 8: зона без скобок
const TRIGGER_RE = /^(.+?)\s+(\d{4})[-./]?(\d{2})[-./]?(\d{2})(?:\s+(\d{1,2})(?:[:.\u0433]?(\d{2}))?)?\s*(?:\(\s*([^)]+?)\s*\)|\b((?:UTC|GMT|ГМТ|Гринвич|Гринуич|[Мм]оскв[а-яё]*|[Мм]ск)\s*[+-]\s*\d{1,2})\b)?\s*$/iu;

function parseTrigger(text) {
    const m = text.trim().match(TRIGGER_RE);
    if (!m) return null;
    const n = m[1].trim();
    const y = Number(m[2]), mo = Number(m[3]), dd = Number(m[4]);
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31) return { n, error: "некорректная дата: " + m[2] + "-" + m[3] + "-" + m[4] };
    const givenTime = m[5] !== undefined;
    let hh = 12, mm = 0;
    if (givenTime) {
        hh = Number(m[5]);
        mm = m[6] !== undefined ? Number(m[6]) : 0;
        if (hh > 23 || mm > 59) return { n, error: "некорректное время: " + m[5] + (m[6] || "") };
    }
    const d = y + "-" + String(mo).padStart(2, "0") + "-" + String(dd).padStart(2, "0");
    let zone = (m[7] || m[8] || "").trim();
    let diffMin = 3 * 60; // по умолчанию МСК
    let zoneLabel = "";
    if (zone) {
        const explicit = explicitZoneMinutes(zone);
        if (explicit !== null) {
            diffMin = explicit;
            zoneLabel = zone;
        } else if (CITY_INDEX[zone.toLowerCase()]) {
            diffMin = cityDiffMin(CITY_INDEX[zone.toLowerCase()], d);
            zoneLabel = CITY_INDEX[zone.toLowerCase()];
        } else {
            return { n, error: "не знаю места «" + zone + "» — укажите город из списка приложения или сдвиг вида МСК+2 / UTC+5" };
        }
    }
    const msk = new Date(Date.UTC(y, mo - 1, dd, hh, mm, 0) - diffMin * 60000);
    const pad = (x, l) => String(x).padStart(l, "0");
    // без времени и пояса — как в приложении: { n, d }, расчёт в полдень
    const rec = { n };
    if (givenTime || zone) {
        rec.d = msk.getUTCFullYear() + "-" + pad(msk.getUTCMonth() + 1, 2) + "-" + pad(msk.getUTCDate(), 2);
        rec.h = msk.getUTCHours();
        rec.m = msk.getUTCMinutes();
    } else {
        rec.d = d;
    }
    let note = "";
    if (zone) {
        note = zoneLabel + " " + pad(hh, 2) + ":" + pad(mm, 2) + " → МСК " + pad(rec.h, 2) + ":" + pad(rec.m, 2)
            + (rec.d !== d ? " " + rec.d : "");
    }
    return { rec, note };
}

// ============================== ВЫВОД ==============================

function jubileeText(rec, note) {
    const hasTime = rec.h !== undefined && rec.m !== undefined;
    const [y, mo, d] = rec.d.split("-").map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, rec.h !== undefined ? rec.h : 12, rec.m !== undefined ? rec.m : 0, 0));
    const head = rec.n + " " + rec.d + (hasTime ? " " + String(rec.h).padStart(2, "0") + ":" + String(rec.m).padStart(2, "0") : "")
        + ageSuffix(rec.n, rec.d)
        + (note ? "\n" + note : "");
    return head + "\n" + la(t).join("\n");
}

// ============================== STORE ==============================

const fs = require("fs");
const path = require("path");

// база рядом со скриптом; в сервисе (DynamicUser) путь задаёт LR_DB
const DB_FILE = process.env.LR_DB || path.join(__dirname, "db.json");
let db = { records: [] };

function loadDb() {
    try {
        const parsed = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        if (parsed && Array.isArray(parsed.records)) db = parsed;
    } catch (e) {
        // нет файла или повреждён — начинаем с пустой базы
    }
}

function saveDb() {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1) + "\n");
    fs.renameSync(tmp, DB_FILE);
}

// запись своя у каждого пира, ключ — имя+дата: повторный триггер с той же
// датой обновляет, с другой — отдельная запись (Георгий 1910 и Георгий 1963)
function upsertRecord(rec, peerId) {
    const same = db.records.find(r => r.peerId === peerId && r.n === rec.n && r.d === rec.d);
    if (same) Object.assign(same, rec, { peerId });
    else db.records.push(Object.assign({ peerId, lastSentYear: 0 }, rec));
    saveDb();
}

// ============================== CATCH UP ==============================
// Как в pinguin (messages.getHistory): после простоя догоняем сообщения,
// пришедшие пока бот не работал. Очерёдность — по db.lastSeen (unix время
// последнего обработанного сообщения), пиры — из сохранённых записей.

function markSeen(date) {
    const last = db.lastSeen || 0;
    if (date > last) {
        db.lastSeen = date;
        saveDb();
    }
}

async function catchUp(startAt) {
    const peers = [...new Set(db.records.map(r => r.peerId))];
    for (const peer of peers) {
        let items;
        try {
            const res = await vkApi("messages.getHistory", { peer_id: peer, count: 200 });
            items = res.items || [];
        } catch (e) {
            console.error("catchUp", peer, e.message);
            continue;
        }
        let n = 0;
        for (const tm of items) { // от новых к старым
            if (tm.out || tm.from_id < 0) continue;   // только чужие входящие
            if (tm.date <= (db.lastSeen || 0) || tm.date > startAt) continue;
            n++;
            try {
                await handleMessage(peer, String(tm.text || ""), tm.date, tm.id, tm.conversation_message_id);
            } catch (e) {
                console.error("catchUp", peer, tm.id, e.message);
            }
        }
        if (n) console.log("catchUp peer", peer, "replayed", n);
    }
}

// ============================== VK ==============================

const VK_API = "https://api.vk.com/method/";
const VK_VERSION = "5.199";

// необязательное ограничение: обслуживать только эту группу (число из club…)
const GROUP_ID = Number(process.env.VK_GROUP_ID || 0) || 0;

let token = process.env.VK_TOKEN || "";
if (!token) {
    try {
        const m = fs.readFileSync(path.join(__dirname, ".env"), "utf8").match(/^\s*VK_TOKEN\s*=\s*(\S+)\s*$/m);
        if (m) token = m[1];
    } catch (e) { /* .env не обязателен */ }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOG_RAW = !!process.env.LOG_VK; // сырые ответы VK API и Long Poll

async function vkApi(method, params) {
    const qs = new URLSearchParams(Object.assign({ access_token: token, v: VK_VERSION }, params));
    if (LOG_RAW) console.log(">> " + method, new URLSearchParams(qs).toString().replace(/access_token=[^&]+/, "access_token=…"));
    const res = await fetch(VK_API + method + "?" + qs, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(method + " HTTP " + res.status);
    const body = await res.json();
    if (LOG_RAW) console.log("<< " + method, JSON.stringify(body).slice(0, 800));
    if (body.error) throw new Error(method + " " + body.error.error_code + ": " + body.error.error_msg);
    return body.response;
}

// ответ на сообщение: reply_to по глобальному id (личка) либо forward по
// conversation_message_id (в чатах id приходит 0 — как в pinguin vk.go)
async function messagesSend(peerId, text, msgId, convMsgId) {
    const params = {
        peer_id: peerId,
        message: text,
        random_id: Date.now() % 2147483647
    };
    if (msgId > 0) params.reply_to = msgId;
    else if (convMsgId > 0) params.forward = JSON.stringify({
        peer_id: peerId, conversation_message_ids: [convMsgId], is_reply: true
    });
    return vkApi("messages.send", params);
}

let lp = null; // { url, key, ts }
let groupId = GROUP_ID;

async function longPollInit() {
    // как в pinguin (NewLongPollCommunity): группа из токена через groups.getById
    if (!groupId) {
        try {
            const r = await vkApi("groups.getById", {});
            const g = (r.groups && r.groups[0]) || (r.items && r.items[0]);
            if (g && g.id) {
                groupId = g.id;
                console.log("группа из токена:", groupId);
            }
        } catch (e) { /* укажем VK_GROUP_ID по ошибке ниже */ }
    }
    try {
        lp = await vkApi("groups.getLongPollServer", groupId ? { group_id: groupId } : {});
    } catch (e) {
        // ВК требует group_id (токен не привязан однозначно) — групповой токен
        // не позволяет узнать свои группы (groups.get недоступен), поэтому
        // просим указать группу явно
        if (/\bgroup_id\b/.test(e.message) && e.message.includes("100")) {
            throw new Error("задайте VK_GROUP_ID (число из club…, напр. VK_GROUP_ID=241064685)");
        } else throw e;
    }
    console.log("long poll ready", lp.server);
}

// один запрос long poll; обрабатывает пришедшие message_new
async function longPollStep() {
    const u = new URL(lp.server);
    u.searchParams.set("act", "a_check");
    u.searchParams.set("key", lp.key);
    u.searchParams.set("ts", lp.ts);
    u.searchParams.set("wait", "25");
    const res = await fetch(u, { signal: AbortSignal.timeout(35000) });
    const body = await res.json();
    if (LOG_RAW) console.log("<< poll ts=" + lp.ts, JSON.stringify(body).slice(0, 1000));
    if (process.env.LOG_UPDATES && body.failed) console.log("poll failed:", JSON.stringify(body));
    if (body.failed) {
        if (body.failed === 1 && body.ts) lp.ts = body.ts;
        else await longPollInit(); // 2/3 — смена key/server
        return;
    }
    lp.ts = body.ts;
    for (const upd of body.updates || []) {
        if (process.env.LOG_UPDATES) console.log("upd:", JSON.stringify(upd).slice(0, 500));
        if (upd.type !== "message_new" || !upd.object) continue;
        // фильтр по группе: обрабатывать только группу токена/GROUP_ID
        if (groupId && Number(upd.group_id) !== groupId) continue;
        const msg = upd.object.message || upd.object;
        if (!msg || !msg.text || msg.peer_id === undefined) continue;
        try {
            await handleMessage(msg.peer_id, String(msg.text), msg.date, msg.id, msg.conversation_message_id);
        } catch (e) {
            console.error("handle:", e.message);
        }
    }
}

async function handleMessage(peerId, text, date, msgId, convMsgId) {
    if (process.env.LOG_UPDATES) console.log("msg from", peerId, ":", text);
    if (date) markSeen(date);
    // триггеров может быть несколько — по одному на строку
    const lines = String(text).split(/\s*\n+\s*/).filter(Boolean);
    for (const line of lines) {
        const parsed = parseTrigger(line);
        if (!parsed) continue; // не триггер — молчим
        if (parsed.error) {
            await messagesSend(peerId, "💥 " + line + "\n" + parsed.error, msgId, convMsgId);
            continue;
        }
        upsertRecord(parsed.rec, peerId);
        await messagesSend(peerId, jubileeText(parsed.rec, parsed.note), msgId, convMsgId);
        console.log("record:", parsed.rec.n, parsed.rec.d, "peer", peerId);
    }
}

// ============================== ПЛАНИРОВЩИК ==============================
// Ежедневно в 09:00 МСК: записи с сегодняшней датой (МСК) получают список
// раз в год (lastSentYear).

function mskNowParts() {
    const t = new Date(Date.now() + TZ_MS);
    return {
        y: t.getUTCFullYear(),
        mo: t.getUTCMonth() + 1,
        d: t.getUTCDate(),
        h: t.getUTCHours(),
        min: t.getUTCMinutes()
    };
}

function msUntilNext9() {
    const n = mskNowParts();
    let wait = 9 * 3600000 - (n.h * 3600000 + n.min * 60000);
    if (wait <= 0) wait += 24 * 3600000;
    return wait;
}

async function dailyCheck() {
    const n = mskNowParts();
    const today = n.y + "-" + String(n.mo).padStart(2, "0") + "-" + String(n.d).padStart(2, "0");
    const mmdd = String(n.mo).padStart(2, "0") + String(n.d).padStart(2, "0");
    if (db.checkedDate === today) return;
    db.checkedDate = today;
    saveDb();
    for (const rec of db.records) {
        if (rec.d.slice(5).replace("-", "") !== mmdd) continue;
        if (rec.lastSentYear >= n.y) continue;
        const prev = rec.lastSentYear;
        rec.lastSentYear = n.y; // отметка до отправки, чтобы не задвоить
        saveDb();
        try {
            await messagesSend(rec.peerId, jubileeText(rec, ""));
            console.log("annual:", rec.n, rec.d, "peer", rec.peerId);
        } catch (e) {
            rec.lastSentYear = prev; // откат — повторим при следующем прогоне
            saveDb();
            console.error("annual send failed:", e.message);
        }
    }
}

function scheduleDaily() {
    setTimeout(async () => {
        try { await dailyCheck(); } catch (e) { console.error("daily:", e.message); }
        scheduleDaily();
    }, msUntilNext9());
}

// ============================== TEST / MAIN ==============================

async function main() {
    const args = process.argv.slice(2);
    if (args[0] === "probe") {
        // диагностика: диалоги, отправка теста, сырой long poll 2 варианта
        let noGroupOk = false;
        try {
            const r = await vkApi("groups.getLongPollServer", {});
            noGroupOk = true;
            console.log("без group_id сервер получен:", r.server);
        } catch (e) {
            console.log("без group_id:", e.message);
        }
        try {
            lp = await vkApi("groups.getLongPollServer", groupId ? { group_id: groupId } : {});
        } catch (e) {
            console.log("getLongPollServer:", e.message);
            lp = null;
        }
        try {
            const conv = await vkApi("messages.getConversations", { count: 5, extended: 0 });
            const items = conv.items || [];
            console.log("диалогов:", conv.count, items.map(i =>
                (i.conversation.peer && (i.conversation.peer.type + ":" + i.conversation.peer.id)) + " " +
                (i.last_message && JSON.stringify(i.last_message.text).slice(0, 40))).join("\n  "));
            const peer = items[0]?.conversation?.peer?.id;
            if (peer) {
                const s = await vkApi("messages.send", { peer_id: peer, message: "probe " + new Date().toISOString(), random_id: Date.now() % 2147483647 });
                console.log("messages.send в peer", peer, "→", JSON.stringify(s));
            }
        } catch (e) {
            console.log("сообщения:", e.message);
        }
        if (!lp) return;
        // по очереди: как vksdk и как новые клиенты (version=3)
        const variants = [["как vksdk", ""], ["version=3", "&version=3"]];
        let ts = lp.ts, vi = 0;
        const until = Date.now() + 120000;
        let t0 = 0;
        while (Date.now() < until) {
            const [label, extra] = variants[vi % variants.length];
            // каждый вариант ~60 c, затем смена
            if (Date.now() - (t0 || Date.now()) > 60000 && t0) { vi++; t0 = 0; }
            if (!t0) t0 = Date.now();
            const u = new URL(lp.server + "?act=a_check&key=" + encodeURIComponent(lp.key) +
                "&ts=" + encodeURIComponent(ts) + "&wait=10" + extra);
            let b;
            try {
                b = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json();
            } catch (e) {
                console.log(label, "poll error:", e.message);
                continue;
            }
            console.log("[" + label + "] poll:", JSON.stringify(b).slice(0, 600));
            if (b.ts) ts = b.ts;
            if (b.failed) { console.log("failed", b.failed); if (b.ts) ts = b.ts; }
        }
        return;
    }
    if (args[0] === "test") {
        const input = args.slice(1).join(" ") || "Костя 1963-09-27";
        for (const line of input.split(/\s*\n+\s*/).filter(Boolean)) {
            const parsed = parseTrigger(line);
            if (!parsed) { console.log(line, "— не похоже на триггер"); continue; }
            if (parsed.error) { console.log("💥 " + parsed.error); continue; }
            console.log("запись (МСК):", JSON.stringify(parsed.rec));
            if (parsed.note) console.log("примечание:", parsed.note);
            console.log("---");
            console.log(jubileeText(parsed.rec, parsed.note));
        }
        return;
    }
    if (!token) {
        console.error("нет токена: задайте VK_TOKEN (env или .env рядом с lunarreturns.js)");
        process.exit(1);
    }
    loadDb();
    await longPollInit();
    // догнать сообщения, накопившиеся за простой (как catchUp в pinguin)
    const startAt = Math.floor(Date.now() / 1000);
    if (!db.lastSeen) {
        db.lastSeen = startAt;
        saveDb();
    } else {
        try { await catchUp(startAt); } catch (e) { console.error("catchUp:", e.message); }
    }
    // стартовая суточная проверка: dailyCheck сам следит, что раз в сутки,
    // так что если процесс встал до 09:00 и поднялся после — догонит
    try { await dailyCheck(); } catch (e) { console.error("daily:", e.message); }
    scheduleDaily();
    let errors = 0;
    for (;;) {
        try {
            await longPollStep();
            errors = 0;
        } catch (e) {
            console.error("long poll:", e.message);
            if (++errors >= 10) {
                await longPollInit();
                errors = 0;
            }
            await sleep(5000);
        }
    }
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
