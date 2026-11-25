import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Независимые ожидаемые результаты эталонного ВК (до переноса, план A3 §1):
// заголовок выдачи поиска «Найдено N строк …» и обрезка целыми строками
// с дословными бюджетами вызывающих мест. Ожидания захардкожены вручную;
// фрозен-реплики циклов ВК (дословно до A3) сверяются с каноном flat.cjs.
const require = createRequire(import.meta.url);
const { searchHead, cutLines, flatSearch, parseSearchQuery } = require('../tgcloud/lib/flat.cjs');
{
    const flat = ['Мария Сидорова', 'Иван Сидоров', '-Иван Петров', 'Иван Петров', 'Мария Петрова', '/Петров',
        '|Петров', '!Петров', '$Петров'].join('\n');
    assert.deepEqual(flatSearch(flat, '/ Иван\n/ Петров\n Мария\n Сидорова\n/\n|'),
        ['Мария Сидорова', '-Иван Петров', 'Иван Петров']);
    assert.deepEqual(flatSearch(flat, '/Иван\nПетров\n!\n/'), ['Иван Сидоров', '-Иван Петров', 'Иван Петров']);
    assert.deepEqual(flatSearch(flat, '/Мария\n Иван\n!\n|'), ['Мария Сидорова', 'Мария Петрова', '/Петров', '|Петров', '!Петров', '$Петров']);
    assert.deepEqual(flatSearch(flat, '/Иван\n ИВАН\n$\n|'), ['Иван Сидоров', '-Иван Петров']);
    assert.deepEqual(flatSearch(flat, '/Никого\n Иван\n Петров\n$\n/\n|'), ['-Иван Петров', 'Иван Петров']);
    assert.deepEqual(flatSearch(flat, '//Петров\nНикого\n|\n|Петров\n|\n!Петров\n|\n$Петров\n|'),
        ['/Петров', '|Петров', '!Петров', '$Петров']);
    assert.deepEqual(flatSearch(flat, '/Никого\nДругой\n|\n/Петров\n|'), ['/Петров']);
    assert.deepEqual(flatSearch(flat, '/Никого\n /Петров\n|'), ['/Петров']);
    assert.deepEqual(flatSearch(flat, '/Иван\n А\n|'), ['Мария Сидорова', 'Иван Сидоров', '-Иван Петров', 'Иван Петров', 'Мария Петрова']);
    assert.deepEqual(parseSearchQuery('/Иван\r\n# пояснение\r\n Мария\r\n| #3 /fynny1\r\n').radii, [3]);
    for (const [query, line] of [['/Иван\n/\n|', 2], ['/Иван\nА', 2], ['/Иван\nМария', 2],
        ['/Иван\nМария\n|\n/', 4], ['/Иван\nМария\n|\n$', 4]]) {
        assert.throws(() => parseSearchQuery(query), new RegExp('строка ' + line + ':'));
    }
}
{
    const lines = ['-FOO', 'foo bar', 'prefix foo', 'foo$', '--foo', 'prefix foo ', 'other'];
    const flat = lines.join('\n');
    for (const [query, indices] of [
        ['/foo\n$', [0, 4]], ['/ foo\n$', [0, 2, 4]],
        ['/other\n|foo\n$', [0, 4, 6]], ['/other\n| foo\n$', [0, 2, 4, 6]],
        ['/ foo\n!foo\n$', [1, 2, 3, 5]], ['/ foo\n! foo\n$', [1, 3, 5]],
        ['/--foo\n$', [4]], ['/ foo$', [3]], ['/ foo #comment\n$', [5]],
        ['/ foo\n$\n/ prefix\n| foo$', [2, 3]],
        ['/foo\r\n# comment\r\n\r\n$ #3 /fynny1', [0, 4]],
    ]) assert.deepEqual(flatSearch(flat, query), indices.map(i => lines[i]), query);
    assert.deepEqual(parseSearchQuery('/foo\n$ #3 /fynny1').radii, [3]);
    for (const [query, line] of [['$', 1], ['/foo\n$\n$', 3], ['/foo\n$ text', 2], ['/foo\n$|bar', 2],
        ['/\n$', 2], ['/-\n$', 2], ['/#1\n$', 2]]) {
        assert.throws(() => parseSearchQuery(query), new RegExp('строка ' + line + ':'));
    }
}
const peters = '-Пётр I 1672-06-09\n-Пётр II 1715-10-23\n-Пётр Иванов 1980-01-01';
assert.deepEqual(flatSearch(peters, '/Пётр I #foo bar'), ['-Пётр I 1672-06-09']);
assert.equal(flatSearch(peters, '/Пётр I').length, 2);
assert.deepEqual(flatSearch(peters, '/Пётр #foo bar'), peters.split('\n'));
assert.deepEqual(flatSearch(peters, '/-Пётр I #comment'), ['-Пётр I 1672-06-09']);
assert.deepEqual(flatSearch(peters, '/ Пётр I #comment'), ['-Пётр I 1672-06-09']);
assert.deepEqual(flatSearch(peters, '/#comment'), []);
assert.deepEqual(flatSearch(peters, '/ #comment'), []);
assert.deepEqual(flatSearch(peters, '/'), []);
const queryLines = ['# introductory comment', '', '/ Пётр I #2', '|--Анна#12 /fynny1', '! II#plain', '  #0', ''];
const parsed = parseSearchQuery(queryLines.join('\r\n'));
assert.deepEqual(parsed.lines, queryLines);
assert.deepEqual(parsed.radii, [2, 9, 1]);
assert.deepEqual(parsed.conditions, [
    { op: '/', sub: true, mark: '', needle: 'пётр i ', comment: '2', line: 3, raw: queryLines[2], full: false },
    { op: '|', sub: false, mark: '--', needle: 'анна', comment: '12 /fynny1', line: 4, raw: queryLines[3], full: false },
    { op: '!', sub: true, mark: '', needle: 'ii', comment: 'plain', line: 5, raw: queryLines[4], full: false },
]);
assert.strictEqual(parseSearchQuery(parsed), parsed);
assert.deepEqual(flatSearch(peters, parseSearchQuery('/Пётр I #foo')), ['-Пётр I 1672-06-09']);
assert.deepEqual(parseSearchQuery('/Имя#2 extra\n|Другое#3 /fynny2\n!Иное#4 /fynny0 tail').radii, []);
assert.deepEqual(parseSearchQuery('/Имя#999999999999999999999999\n|Другое#00').radii, [9, 1]);

// Sequential operations always match against original occurrences, then retain original order.
const composed = ['-Иван Петров 1980', '=Анна Сидорова 1982', '--Иван Сидоров 2000',
    '-Пётр Петров 1970', '-Иван Петров 1980', '+2000-01-01', 'Literal & | ! ( )'];
const compositionFlat = composed.join('\r\n');
assert.deepEqual(flatSearch(compositionFlat, '/ Иван\n/ Петров'), [composed[0], composed[4]]);
assert.deepEqual(flatSearch(compositionFlat, '/ Иван\n/ Петров\n| Сидоров'), composed.slice(0, 3).concat(composed[4]));
assert.deepEqual(flatSearch(compositionFlat, '/ Петров\n| Сидоров\n!Иван'), [composed[1], composed[3]]);
assert.deepEqual(flatSearch(compositionFlat, '/Иван\n|Иван\n|Анна'), composed.slice(0, 3).concat(composed[4]));
assert.deepEqual(flatSearch(compositionFlat, '/Пётр\n!Пётр\n|Иван'), [composed[0], composed[2], composed[4]]);
assert.deepEqual(flatSearch(compositionFlat, '/Иван\n|-\n!--'), [composed[0], composed[3], composed[4]]);
assert.deepEqual(flatSearch(compositionFlat, '/+\n|='), [composed[1], composed[5]]);
assert.deepEqual(flatSearch(compositionFlat, '/ & | ! ( )'), [composed[6]]);
assert.deepEqual(flatSearch(compositionFlat, '#ignore\r\n\r\n/Иван\r\n #again\r\n! Сидоров'), [composed[0], composed[4]]);
assert.deepEqual(flatSearch(peters, '/Пётр I #2\n|Пётр II #3'), peters.split('\n').slice(0, 2));
assert.deepEqual(flatSearch(peters, '/Пётр I  #2\n|Пётр II #3'), [peters.split('\n')[1]]);

// Only an initial empty slash with exact legacy R1-R9 syntax means full list.
for (const q of ['/#1', '/ #9', '/#6 /fynny0', '/ #6 /fynny1']) {
    assert.equal(parseSearchQuery(q).conditions[0].full, true);
    assert.deepEqual(flatSearch(peters, q), []);
    assert.deepEqual(flatSearch(peters, q, true), peters.split('\n'));
    assert.deepEqual(flatSearch(peters, q + '\n! II', true), [peters.split('\n')[0], peters.split('\n')[2]]);
}
for (const q of ['/#0', '/#10', '/#01', '/#comment', '/ #comment', '/#6 extra']) {
    assert.equal(parseSearchQuery(q).conditions[0].full, false);
    assert.deepEqual(flatSearch(peters, q, true), []);
}
assert.deepEqual(parseSearchQuery('\n#comment\n  #2\n').conditions, []);
assert.deepEqual(flatSearch(peters, '\n#comment\n'), []);
for (const [q, line] of [
    ['|Иван', 1], ['!Иван', 1], [' #comment\ntext', 2], ['/Иван\n text', 2],
    ['/Иван\n/', 2], ['/Иван\n| #2', 2], ['/Иван\n!#3', 2],
    ['/#comment\n/Иван', 1], ['/\n/Иван', 1], ['/#1\n/#2', 2],
    ['/Иван\n\n#comment\n/#2', 4], ['/Иван\n/start\ninvalid', 3],
]) assert.throws(() => parseSearchQuery(q), error => error instanceof Error
    && error.message.startsWith('Ошибка поискового запроса: строка ' + line + ': '), q);

// Prefix duplicate suppression happens after composition, never before filters.
const duplicateFlat = 'Иван 1980\n--Иван 1980\nИван 1980\n=Анна 1981';
assert.deepEqual(flatSearch(duplicateFlat, '/Иван'), ['--Иван 1980']);
assert.deepEqual(flatSearch(duplicateFlat, '/Иван\n!--'), ['Иван 1980', 'Иван 1980']);
assert.deepEqual(flatSearch(duplicateFlat, '/Иван\n| Иван'), duplicateFlat.split('\n').slice(0, 3));
assert.deepEqual(flatSearch(duplicateFlat, '/ Иван\n/Иван'), duplicateFlat.split('\n').slice(0, 3));
assert.deepEqual(flatSearch(duplicateFlat, '/Иван\n|='), ['--Иван 1980', '=Анна 1981']);
assert.deepEqual(flatSearch(duplicateFlat, '/#2\n/Иван', true), duplicateFlat.split('\n').slice(0, 3));
assert.equal(searchHead('/Пётр I #foo bar', 1), 'Найдено 1 строк начинающихся с Пётр I');
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
for (const length of [3999, 4000, 4001]) {
    const source = "я".repeat(length);
    assert.ok(cutLines(source, 4000, 0, false).length <= 4000);
}
assert.equal(cutLines("я".repeat(4000), 4000, 0, false).length, 4000);
assert.equal(cutLines("я".repeat(4001), 4000, 0, false), "");
assert.ok(cutLines("я\n".repeat(3000), 4000, 10, false).length + 10 <= 4000);
assert.equal(cutLines("x".repeat(3990) + "\nyy", 4000, 10, false),
    "x".repeat(3990));                                                   // 10+3990 = 4000; 10+3990+2 > 4000
assert.equal(cutLines("x".repeat(3988) + "\nyy", 4000, 10, false),
    "x".repeat(3988)); // Межстрочный перевод тоже входит в бюджет.
assert.equal(cutLines("x".repeat(3987) + "\nyy", 4000, 10, false),
    "x".repeat(3987) + "\nyy");
assert.equal(cutLines("x".repeat(3988) + "\nyy", 4000, 10, true),
    "x".repeat(3988));                                                   // с «+1» вторая не влезает
// Перелив поиска (reserved = NOT_FOR_GRAFT.length + 1 = 23):
assert.equal(cutLines("x".repeat(3976), 4000, NOT_FOR_GRAFT.length + 1),
    "x".repeat(3976));                                                   // 22+0+1+3976 = 4000 ≤ 4000
assert.equal(cutLines("x".repeat(3977), 4000, NOT_FOR_GRAFT.length + 1),
    "");                                                                 // 22+0+1+3977 > 4000
// Перелив росписи с головой (reserved = head+1+метка+1):
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
const gedVK = (head, pack) => { // перелив росписи радиуса 🧬 (lunarreturns.js:1768-1778)
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
        if (head.length + 1 + tail.length + (tail ? 1 : 0) + l.length > 4000) break;
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
    gedVK("Иван 1954", nfgPack)); // первая строка росписи — метка, её не двоим
console.log("A3 flat expectations: OK");
