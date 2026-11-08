#!/usr/bin/env node
// scripts/diff-fn.mjs — сверка тел функций в двух файлах дословно.
// Восстановлено после волны A (план .kilo/plans/20261107-shared-modules-plan.md
// ссылался на этот скрипт; файл потерялся). Помощник при переносе функций в
// канон tgcloud/lib/*.cjs: переносить можно функ-цию, тела которой совпали.
//
// Запуск: node scripts/diff-fn.mjs <fileA> <fileB> <fn>…

import fs from 'node:fs';

const [fileA, fileB, ...names] = process.argv.slice(2);
if (!fileA || !fileB || !names.length) {
    console.log('usage: node scripts/diff-fn.mjs <fileA> <fileB> <fn>…');
    process.exit(2);
}

// тело функции: от «function name» или «export [async] function name»
// до парной закрывающей скобки (скобки внутри не считаются по текст-хаку —
// счёт {…}); проверка дословная, включая комментарии и пустые строки
function bodyOf(src, name) {
    const re = new RegExp(`^(?:export )?(?:async )?function ${name}\\b`, 'm');
    const m = src.match(re);
    if (!m) return null;
    const start = src.indexOf('{', m.index);
    let depth = 0, i = start;
    do {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
    } while (depth && ++i < src.length);
    if (depth) throw new Error(`${name}: дисбаланс скобок`);
    // сравниваем тело без декларативного префикса: export/async — капота
    // сигнатуры, не логики (params в проверке остаются)
    return src.slice(m.index, i + 1)
        .replace(/^(export )?(async )?function \w+/, 'function ' + name);
}

let bad = 0;
for (const name of names) {
    const a = bodyOf(fs.readFileSync(fileA, 'utf8'), name);
    const b = bodyOf(fs.readFileSync(fileB, 'utf8'), name);
    if (a == null && b == null) { console.log(`? ${name}: нет ни в одном`); bad++; }
    else if (a == null) { console.log(`? ${name}: нет в ${fileA}`); bad++; }
    else if (b == null) { console.log(`? ${name}: нет в ${fileB}`); bad++; }
    else if (a === b) console.log(`= ${name}`);
    else {
        console.log(`≠ ${name}`);
        bad++;
    }
}
process.exit(bad ? 1 : 0);
