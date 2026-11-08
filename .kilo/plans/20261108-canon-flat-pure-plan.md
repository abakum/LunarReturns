# Волна A2: чистые функции плоского древа → tgcloud/lib/flat.cjs

refactor(shared): wave A2 — pure flat-tree and util functions into tgcloud/lib/flat.cjs

## Цель

Дописать в общий канон оставшиеся **чистые** (без DB/API) функции, дословно
идентичные в обеих копиях: тела прошли `node scripts/diff-fn.mjs
lunarreturns.js tgcloud/lib/bot.js …` (= по всем восьми). Волна B (DB/API-
функции) по-прежнему не трогается — там нужны store-абстракции.

| Функция | ВК (lunarreturns.js) | ТГ (bot.js) |
|---|---|---|
| flatTreeText | 1666 | 1535 |
| subsetBranch | 1591 | 1460 |
| flatSearch | 1842 | 1710 |
| flatHitPerson | 1875 | 1743 |
| flatHitKey | 1893 | 1761 |
| datePlusYears | 1124 | 1977 |
| treeReport | 761 | 2378 |
| rootOf | 692 | 666 |

## Архитектура

- `tgcloud/lib/flat.cjs` — новый канон-модуль, тела дословно, экспорт
  shorthand-объектом `{ flatTreeText, subsetBranch, flatSearch,
  flatHitPerson, flatHitKey, datePlusYears, treeReport, rootOf }`
  (оговорка cjs-module-lexer). Внутренняя зависимость: `approxOut` —
  `require('./text.cjs')`; собственных внешних зависимостей больше нет
  (NOT_FOR_GRAFT остаётся в parse.cjs/bot.js — плоские функции метку
  не используют).
- **Шим не создаётся** (по образцу tree.cjs): bot.js импортирует canon
  напрямую `import { … } from './flat.cjs'`; handlers продолжают брать
  `flatSearch/flatHitKey/treeReport` из bot.js — для этого bot.js
  реэкспортирует эти имена (`export { … } from './flat.cjs'`); handlers
  не трогаем.
- ВК: `const { flatTreeText, subsetBranch, flatSearch, flatHitPerson,
  flatHitKey, datePlusYears, treeReport, rootOf } = reqLib("flat")` в
  шапке рядом с остальными; локальные копии удалены; `module.exports.__test`
  продолжают отдавать те же имена (теперь из канона).
- Урок 2a991d4 (NOT_FOR_GRAFT undefined): после правки —
  `node dev/vk-reqlib-check.mjs` (ловит весь класс «имя destructured из
  reqLib, но не экспортировано каноном»), держим
  `module.exports = { идентификаторы }` без вычисляемых ключей.
- scripts/diff-fn.mjs восстановлен (план 20261107 на него ссылался, файл
  потерялся) — постоянный помощник проверки тел.

## Регресс (обязателен)

1. `node dev/vk-reqlib-check.mjs` — все имена reqLib-деструктуризаций есть
   в экспорт канонов.
2. `node scripts/diff-fn.mjs tgcloud/lib/flat.cjs tgcloud/lib/bot.js …` —
   канон и ТГ-копия дословно (ВК-копии функций уже нет).
3. `node dev/sync-check.mjs` — 30/30 (плоское древо до колокольчика 🔔 там
   прогоняется).
4. `node dev/est-diag.mjs`, `node lunarreturns.js test "Дедушка Костя
   1963-09-27 12:30 (Пермь)"`.
5. `node dev/repl.mjs --fresh` — ТГ-сценарии: поиск «/Имя» (flatSearch →
   фокус), тап «-+=» ветви (branchFlatText — subsetBranch/flatTreeText),
   древо пачкой (gedcomText — не вошёл, но рядом), treeReport по правке
   среза. `node dev/vk-repl.mjs --fresh` — зеркально в ВК.
   После прогонов вернуть `git checkout -- dev/tg-db.json` при изменениях.

## Риски

- cjs-module-lexer: shorthand-экспорт — обязателен (см. план 20261107).
- flatHitKey зависит от `approxOut` (канон text.cjs) — оставить вызов
  канонной функции, не копировать.
- flatTreeText/subsetBranch читают только persons/fams ({ key, name, sex,
  d, dd, h, m, … }) — DB-полей нет, перенос дословный.
