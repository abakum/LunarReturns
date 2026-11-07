# Общие модули обоих ботов: план (+ шаг 1 — kinship)

## Цель и нецель

- **Цель:** переиспользование общих модулей **обоими ботами** — одна реализация
  логики вместо дословных копий. Каждая правка — в одном месте.
- **Нецель:** сокращение числа стендов. `dev/sync-check.mjs`, `dev/repl.mjs`,
  `dev/vk-repl.mjs`, `dev/est-diag.mjs` остаются как есть: sync-check из
  «детектора рассинхрона копий» превращается в контракт-тест общего канона.
- **Канон — ВК** (`lunarreturns.js` в проде; ТГ-serverless в листе ожидания).
  При расхождении копий правится общий модуль по ВК-версии, ТГ подхватывает
  через реэкспорт. Исключение — платформенные различия (см. text.js).

## Архитектура

Канон общих модулей — **CommonJS в `tgcloud/lib/*.cjs`** (внутри tgcloud, чтобы
serverless-деплой ТГ `tgcloud push` не менялся вообще):

```
tgcloud/lib/kinship.cjs   ← канон: ВК require-ит, ТГ импортирует через шим
tgcloud/lib/kinship.js    ← ESM-шим: export { … } from './kinship.cjs'
lunarreturns.js           ← require('./tgcloud/lib/kinship.cjs') (+ cwd-фолбэк)
```

Почему CJS, а не ESM-канон:
1. sync-check после `require` TMP-копии lunarreturns.js сразу зовёт `__test.*`
   — нужен **синхронный** require; dynamic import асинхронен (биндинги ещё
   не заполнены), `require(esm)` — только Node ≥ 22.12/под флагом.
2. `.cjs` не зависит от `package.json`-type: в репо, в /var/lib/lunarreturns
   и в serverless-бандле семантика одна.
3. Именованные реэкспорты из CJS (`export { x } from './x.cjs'`) работают
   через cjs-module-lexer — `module.exports = { x, … }` распознаётся.

Пути в lunarreturns.js — по образцу поиска шрифта в `chartFont()`:
`__dirname/tgcloud/lib/<мод>.cjs` (репо-клон и /var/lib/lunarreturns — один
layout), затем `process.cwd()/tgcloud/lib/<мод>.cjs` (TMP-копии sync-check и
vk-repl запускаются из корня репо; chdir нигде не делается).

## Проверенное состояние копий (diff-fn, master cd59159)

| Модуль ТГ | Инлайн в ВК | Статус тел | Шаг |
|---|---|---|---|
| kinship.js (347) | 1258–1606 + fynny(1282) | идентичны (kinLabel — только `export`) | **1 — пример, сделан** |
| astro.js (196) | 20–203 | идентичны (moonNew, зодиаки, wdLocale…) | 2 |
| religion.js (277) | 204–501 | идентичны (все 25 функций) | 2 |
| parse.js (660) | 502–1119, 3175–3250 | идентичны (parseTrigger, parseGedcom, parseTree, dateTimeToMsk…) | 3 |
| chart.js (612) | 3595–4188 | идентичны (переставлены комментарии; заодно уходит fs-хак шрифта) | 4 |
| focus-набор в bot.js | 1120–1290, 2657, 2889 | идентичны (focusKeys…focusListKeys, famsByGenerations) — перенести в tree.cjs, bot.js реэкспортирует | 5 |
| text.js jubileeText | 1607–1652 | **расхождение платформенное**: ТГ — tg-spoiler/htmlEsc, ВК — plain. Не шарить; позже, если нужно — fmt-параметр | — |
| approxOut, text.js (54) | 932–987 | идентичны | 3 |
| importGedcom, gedcomText, chartFor, linkPairs, personRows… | DB/API-функции | волнy B — store-абстракция, отдельный план | — |

Проверка: `node scripts/diff-fn.mjs lunarreturns.js tgcloud/lib/<mod>.js <fn…>`
(скрипт-помощник; после шага 1 пути для kinship меняются на .cjs).

## Шаг 1 — kinship (этот коммит)

- `tgcloud/lib/kinship.cjs` — канон: `const fynny = 1; kinLabel, kinBlood,
  kinChain, fullSiblings, genLabel` дословно (тела из kinship.js/ВК — они
  идентичны), `module.exports = { … }`.
- `tgcloud/lib/kinship.js` — шим-реэкспорт (потребители не меняются:
  bot.js `{ kinLabel, fynny }`, chart.js `{ kinLabel }`).
- `lunarreturns.js`: инлайн-блок 1258–1606 удалён; после `"use strict"` —
  require канона с фолбэком по cwd (TMP-копии sync-check/vk-repl);
  наружу ВК нужны только `fynny` (focusKeys/focusListKeys) и `kinLabel`
  (focusListKeys, chartFor, focusListText) — они же в `module.exports.__test`.
- `lunarreturns-install.sh`: копия `tgcloud/lib/*.cjs` в
  `/var/lib/lunarreturns/tgcloud/lib/` (layout совпадает с репо — путь 1
  require попадает; строка про font-cyr.js остаётся до шага 4).

## Регресс (каждый шаг, без сокращений)

- `node dev/sync-check.mjs` — 30 триггеров, kinLabel-раздел, chartPdf и пр.
- `node dev/est-diag.mjs` — chartFor/focusListKeys (fynny).
- `node lunarreturns.js test "Дедушка Костя 1963-09-27 12:30 (Пермь)"` — смок.
- `dev/vk-repl.mjs` / `dev/repl.mjs` — вручную на живых сценариях.
- `git am` патча на чистый клон + повтор регресса там же.

## Риски

- cjs-module-lexer не распознает нестандартные экспорты → держать
  `module.exports = { идентификаторы }` (shorthand), без вычисляемых ключей.
- TMP-копии (sync-check/vk-repl) требуют cwd = корень репо — уже так для
  шрифта; зафиксировано комментарием у require.
- serverless ТГ: бандлится `tgcloud/` целиком — шим + .cjs едут вместе,
  деплой не меняется.
