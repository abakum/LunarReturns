import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Независимые ожидаемые результаты эталонного ВК (до переноса, план A3 §1):
// заголовок выдачи поиска «Найдено N строк …» и обрезка целыми строками
// с дословными бюджетами вызывающих мест. Ожидания захардкожены вручную;
// фрозен-реплики циклов ВК (дословно до A3) сверяются с каноном flat.cjs.
const require = createRequire(import.meta.url);
const { searchHead, cutLines } = require('../tgcloud/lib/flat.cjs');
const NOT_FOR_GRAFT = "#not for cut and graft";

// ---- 1. Заголовок поиска: тексты дословно ВК (грамматика «строк» не меняется)
const H = n => n;
assert.equal(searchHead("/Андрей", H(100)), "Найдено 100 строк начинающихся с Андрей");
assert.equal(searchHead("/Иван 1954", H(1)), "Найдено 1 строк начинающихся с Иван 1954");
assert.equal(searchHead("/ Иван", H(7)), "Найдено 7 строк с подстрокой Иван");
assert.equal(searchHead("/ Иван  ", H(2)), "Найдено 2 строк с подстрокой Иван");
assert.equal(searchHead("/-Пётр", H(3)), "Найдено 3 строк начинающихся с Пётр");
assert.equal(searchHead("/--Иван", H(4)), "Найдено 4 строк начинающихся с Иван");
assert.equal(searchHead("/=", H(9)), "Найдено 9 строк с маркером «=»");
assert.equal(searchHead("/-", H(5)), "Найдено 5 строк с маркером «-»");
assert.equal(searchHead("/++", H(11)), "Найдено 11 строк с маркером «++»");
assert.equal(searchHead("/+", H(2)), "Найдено 2 строк с маркером «+»");
// серия маркеров — ОДИН знак и его повторы (\1*): «-=» — маркер «-»,
// дальше — запрос
assert.equal(searchHead("/-=", H(6)), "Найдено 6 строк начинающихся с =");
// кириллица и спецсимволы запроса дословно
assert.equal(searchHead("/Пётр I (1672)", H(1)), "Найдено 1 строк начинающихся с Пётр I (1672)");
// в ВК серия маркеров — один знак и повторы: «-=Иван» — маркер «-»,
// запрос «=Иван»
assert.equal(searchHead("/-=Иван", H(1)), "Найдено 1 строк начинающихся с =Иван");

// ---- 2. Фрозен-реплика заголовка ВК (дословно до A3) — сверяется с каноном
function searchHeadVK(q, hits) {
    const sub = /^\/\s/.test(q);
    const mark = (q.slice(1).match(/^([-+=])\1*/) || [""])[0];
    const needle = (sub ? q.slice(1) : q.slice(1 + mark.length)).trim();
    return "Найдено " + hits.length + " строк "
        + (needle ? (sub ? "с подстрокой " : "начинающихся с ") + needle
                  : "с маркером «" + mark + "»");
}
for (const q of ["/Андрей", "/ Иван", "/-", "/--", "/=", "/++", "/-Пётр", "/-=Иван",
    "/ Пётр I", "/x", "/ ", "/", "/-", "/=И", "/+ +", "/\tИван"]) {
    const hits = H(3);
    assert.equal(searchHead(q, hits), searchHeadVK(q, { length: hits }), "searchHead " + JSON.stringify(q));
}

// ---- 3. Обрезка целыми строками: захардкоженные ожидания бюджетов ВК.
// Первая строка — консервативный «+1» под соединитель (даже перед первой
// строкой накопления), суффикс ✂️/⏳ в бюджете не резервирован (как в ВК).
// Список событий (reserved=0, joinReserve=true):
assert.equal(cutLines("x".repeat(4000), 4000), "");                      // 0+0+1+4000 > 4000
assert.equal(cutLines("x".repeat(3999), 4000), "x".repeat(3999));        // 1+3999 = 4000 ≤ 4000
assert.equal(cutLines("a".repeat(3998) + "\nb", 4000),
    "a".repeat(3998) + "\nb");                                           // 3998+1+1 = 4000 ≤ 4000
assert.equal(cutLines("a".repeat(3998) + "\nbc", 4000),
    "a".repeat(3998));                                                   // 3998+1+2 > 4000
assert.equal(cutLines("", 4000), "");                                    // пустой текст
// границы накопления: «a\nbb» = 4 знака; третья строка: 4+1+3 = 8
assert.equal(cutLines("a\nbb\nccc", 8), "a\nbb\nccc");                   // 8 ≤ 8 — точно в границе
assert.equal(cutLines("a\nbb\nccc", 7), "a\nbb");                        // 8 > 7 — целая строка мимо
// кириллица и эмодзи — единицы String.length (эмодзи = 2)
assert.equal(cutLines("🔔🔔🔔\nxy", 8), "🔔🔔🔔");                        // 1+6 ≤ 8; 6+1+2 > 8
assert.equal(cutLines("Иван 1954-05-10 (Пермь)\nМария 1960", 40),
    "Иван 1954-05-10 (Пермь)\nМария 1960");                              // 22+1+11 = 34 ≤ 40
// Хвост после заголовка (reserved = head+1, joinReserve=false):
const head = "Заголовок"; // 9 знаков, reserved = 10
assert.equal(cutLines("x".repeat(3990) + "\nyy", 4000, 10, false),
    "x".repeat(3990));                                                   // 10+3990 = 4000; 10+3990+2 > 4000
assert.equal(cutLines("x".repeat(3988) + "\nyy", 4000, 10, false),
    "x".repeat(3988) + "\nyy");                                          // 10+3988+2 = 4000 ≤ 4000 — без межстрочного «+1»
assert.equal(cutLines("x".repeat(3988) + "\nyy", 4000, 10, true),
    "x".repeat(3988));                                                   // с «+1» вторая не влезает
// Перелив поиска (reserved = NOT_FOR_GRAFT.length + 1 = 23):
assert.equal(cutLines("x".repeat(3976), 4000, NOT_FOR_GRAFT.length + 1),
    "x".repeat(3976));                                                   // 22+0+1+3976 = 4000 ≤ 4000
assert.equal(cutLines("x".repeat(3977), 4000, NOT_FOR_GRAFT.length + 1),
    "");                                                                 // 22+0+1+3977 > 4000
// Перелив пачки с головой (reserved = head+1+метка+1):
const markHead = "Иван 1954-05-10 1️⃣"; // длина с зоной-эмодзи не важна, reserved считается
const reserved = markHead.length + 1 + NOT_FOR_GRAFT.length + 1;
assert.equal(cutLines("abcd\n" + "y".repeat(4000), 4000, reserved),
    "abcd");                                                             // целая строка, вторая — длинная мимо

// ---- 4. Фрозен-реплики циклов ВК (дословно до A3) — сверяются с каноном
// на батарее случаев (пустой, одна длинная, граница, несколько строк,
// кириллица/эмодзи, размеры вместе с метками/суффиксами).
const LINES = [
    "",
    "одна",
    "x".repeat(5000),
    "x".repeat(3999),
    "a".repeat(3998) + "\nb",
    "a\nbb\nccc",
    "Иван 1954-05-10 (Пермь)\nМария 1960-01-01\n🔔 Иванов+Мария 1983-06-04",
    "🔔".repeat(2000),
    "Иван+Мария 1983-06-04 (Пермь) 1990-01-01 (Казань) ^примечание",
];
const listVK = text => { // bellN чат / 🔔 чата (lunarreturns.js:2713-2717, 3359-3363)
    let shownList = "";
    for (const l of (text || "").split("\n")) {
        if (shownList.length + 1 + l.length > 4000) break;
        shownList += (shownList ? "\n" : "") + l;
    }
    return shownList;
};
const searchVK = found => { // перелив поиска (lunarreturns.js:2842-2848)
    let inner = "";
    for (const l of found.split("\n")) {
        if (NOT_FOR_GRAFT.length + 1 + inner.length + 1 + l.length > 4000) break;
        inner += (inner ? "\n" : "") + l;
    }
    return inner;
};
const gedVK = (head, pack) => { // перелив пачки 🧬 (lunarreturns.js:1768-1778)
    const lines = pack.split("\n")
        .filter((l, i) => !(i === 0 && l.trim().toLowerCase().startsWith(NOT_FOR_GRAFT.toLowerCase())));
    let inner = "";
    for (const l of lines) {
        if (head.length + 1 + NOT_FOR_GRAFT.length + 1 + inner.length + 1 + l.length > 4000) break;
        inner += (inner ? "\n" : "") + l;
    }
    return inner;
};
const focFlatVK = (fh, pack) => { // перелив «-+=» фокуса (lunarreturns.js:3118-3124)
    let inner = "";
    for (const l of pack.split("\n")) {
        if (fh.length + 1 + NOT_FOR_GRAFT.length + 1 + inner.length + 1 + l.length > 4000) break;
        inner += (inner ? "\n" : "") + l;
    }
    return inner;
};
const focBellVK = (head, txt) => { // хвост списка фокуса (lunarreturns.js:3157-3163)
    let tail = "";
    for (const l of txt.slice(head.length + 1).split("\n")) {
        if (head.length + 1 + tail.length + l.length > 4000) break;
        tail += (tail ? "\n" : "") + l;
    }
    return tail;
};
for (const [i, text] of LINES.entries()) {
    assert.equal(cutLines(text, 4000), listVK(text), "list " + i);
    assert.equal(cutLines(text, 4000, NOT_FOR_GRAFT.length + 1), searchVK(text), "search " + i);
    for (const head of ["Заголовок", "Иван 1954-05-10 1️⃣", NOT_FOR_GRAFT]) {
        assert.equal(
            cutLines(text, 4000, head.length + 1 + NOT_FOR_GRAFT.length + 1),
            gedVK(head, text), "ged " + i);
        assert.equal(
            cutLines(text, 4000, head.length + 1),
            focFlatVK(head, text), "focflat " + i);
        assert.equal(
            cutLines(text, 4000, head.length + 1, false),
            focBellVK(head, head + "\n" + text), "focbell " + i);
    }
}
const nfgPack = NOT_FOR_GRAFT + "\n" + "a".repeat(3990) + "\nb";
assert.equal(cutLines(nfgPack.split("\n")
    .filter((l, i) => !(i === 0 && l.trim().toLowerCase().startsWith(NOT_FOR_GRAFT.toLowerCase())))
    .join("\n"), 4000, "Иван 1954".length + 1 + NOT_FOR_GRAFT.length + 1),
    gedVK("Иван 1954", nfgPack)); // первая строка пачки — метка, её не двоим
console.log("A3 flat expectations: OK");
