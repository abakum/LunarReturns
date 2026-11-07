#!/usr/bin/env node
// dev/vk-reqlib-check.mjs — сверка деструктуризаций reqLib("...") в
// lunarreturns.js с экспортом канонов tgcloud/lib/<lib>.cjs.
//
// Зачем: у ВК канон подключается CJS-деструктуризацией, которая молча даёт
// undefined, если канон имя не экспортирует (ESM-шимы ТГ проверяются при
// загрузке модуля, ВК — нет). Первое проявление —падение sendGedArtifacts
// на переливе пачки: NOT_FOR_GRAFT пришла undefined и .toLowerCase() упал
// (2026-11-08, кнопка foc:tree r=3). Стенд ловит весь такой класс на этапе
// разработки: каждая деструктуризация reqLib в ВК-боте должна быть экспортом
// соответствующего канона.
//
// Запуск: node dev/vk-reqlib-check.mjs   (код возврата 1 — есть расхождения)

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const src = fs.readFileSync(path.join(ROOT, 'lunarreturns.js'), 'utf8');
// const { a, b, c } = reqLib("lib");  — в том числе многострочные списки
const re = /(?:const|let|var)\s*\{([^{}]*?)\}\s*=\s*reqLib\(\s*(["'])([^"']+)\2\s*\)/g;

let libs = 0, names = 0, bad = 0;
for (const m of src.matchAll(re)) {
    const lib = m[3];
    const mod = require(path.join(ROOT, 'tgcloud', 'lib', `${lib}.cjs`));
    libs++;
    for (const raw of m[1].split(',')) {
        const name = raw.trim().split(':')[0].trim(); // учёт { a: b }
        if (!name) continue;
        names++;
        if (!Object.prototype.hasOwnProperty.call(mod, name)) {
            console.log(`✗ reqLib("${lib}"): «${name}» не экспортируется tgcloud/lib/${lib}.cjs`);
            bad++;
        }
    }
}
console.log(bad
    ? `✗ ${bad} из ${names} имён (${libs} деструктуризаций reqLib) нет в экспорте канонов`
    : `✓ все ${names} имён из ${libs} деструктуризаций reqLib есть в экспорте канонов tgcloud/lib/*.cjs`);
process.exit(bad ? 1 : 0);
