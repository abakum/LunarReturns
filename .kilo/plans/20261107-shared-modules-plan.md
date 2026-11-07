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
| kinship.js (347) | 1258–1606 + fynny(1282) | идентичны (kinLabel — только `export`) | **1 — сделан** |
| astro.js (196) | 20–203 | идентичны (36 деклараций, diff тел) | **2a — сделан** |
| religion.js (277) | 204–501 | идентичны (40 деклараций, diff тел) | **2b — сделан** |
| parse.js (660) | 502–1119, 3175–3250 | идентичны (diff тел; + withGraftMark из ВК в канон) | **3 — сделан** |
| chart.js (612) | 3595–4188 | идентичны (комментарии — ВК-версии; fs-хак шрифта удалён) | **4 — сделан** |
| focus-набор в bot.js | 1120–1290, 2657, 2889 | идентичны (отличия — комментарии, взяты ВК) | **5 — сделан (tree.cjs)** |
| text.js jubileeText | 1607–1652 | **расхождение платформенное**: ТГ — tg-spoiler/htmlEsc, ВК — plain. Не шарить; позже, если нужно — fmt-параметр | — |
| approxOut, text.js (54) | 932–987 | идентичны | **2c — сделан (text.cjs)** |
| importGedcom, gedcomText, chartFor, linkPairs, personRows… | DB/API-функции | волна B — store-абстракция, отдельный план | — |

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

## Отчёт: волна A завершена (шаги 2–5)

Серия поверх шага 1 (kinship): reqLib-загрузчик → astro (2a) → religion (2b) →
text/approxOut (2c) → parse (3) → chart+font-cyr (4) → tree/focus-набор (5).

- общий канон: `tgcloud/lib/{kinship,astro,religion,text,parse,chart,font-cyr,tree}.cjs`;
  ТГ потребляет через ESM-шимы `*.js` (bot.js реэкспортирует фокус-набор из
  tree.cjs), ВК — `reqLib()` в lunarreturns.js; handlers/endpoints не тронуты
- lunarreturns.js: 6384 → 4096 строк (дословные дубли логики ушли все);
  bot.js: 2559 → 2391
- lunarreturns-install.sh: копирует `tgcloud/lib/*.cjs` (шрифт включён);
  плоская копия font-cyr.js не нужна — fs-хак chartFont удалён, шрифт берётся
  require'ом; dev/font-subset.mjs пишет сразу .cjs-канон
- канон=ВК: тела сверялись диффом перед каждым шагом; расхождения — только
  комментарии (chartModel, focusKeys/focusGraphDist — взяты ВК-версии, в ТГ-
  копии CHART_MAX-комментарий стоял на хвосте rangeLevel — перенесён);
  chartFont — осознанная замена (fs-поиск → require FONT_B64); withGraftMark
  (ВК-only) переехал в parse.cjs с экспортом; jubileeText остался
  платформенным (ТГ: tg-spoiler, ВК: plain)
- регресс каждого шага: `node dev/sync-check.mjs` (30/30), `node dev/est-diag.mjs`,
  `node lunarreturns.js test "Дедушка Костя 1963-09-27 12:30 (Пермь)"`;
  ESM-шимы проверялись импортом (cjs-module-lexer распознаёт shorthand-экспорт)
- волна B (DB/API-функции: importGedcom, gedcomText, chartFor, linkPairs,
  personRows, applyTree, cutAndGraft…) — отдельный план под store-абстракцию:
  у копий разные сигнатуры (peerId/SQLite vs chatId/sdk-db), механический
  перенос не подходит
