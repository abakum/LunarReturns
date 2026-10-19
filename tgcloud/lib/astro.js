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

function la(birth, detail = false) {
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
        if (i >= f && c > 0 || (detail ? c > 0 : c > 1) && i < 90) {
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

// полных лет между датами ISO (ГГГГ-ММ-ДД); для «на сегодня» см. ageSuffix
function fullYears(d1, d2) {
    const [y1, m1, dd1] = d1.split("-").map(Number);
    const [y2, m2, dd2] = d2.split("-").map(Number);
    let a = y2 - y1;
    if (m2 < m1 || (m2 === m1 && dd2 < dd1)) a--;
    return a;
}

function ageSuffix(n, d, dd) {
    const age = mskToday()[0] - Number(d.slice(0, 4));
    if (age < 1) return "";
    if (dd) return " " + age + " " + fullYears(d, dd); // умер/развод — тип годовщины не пишем
    return " " + age + (n.includes("+") && WED[age] ? " " + WED[age] : "");
}

const mskToday = () => {
    const t = new Date(Date.now() + TZ_MS);
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
};

export { TZ_MS, mskToday, moonNew, la, legend, ageSuffix };
