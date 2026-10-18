# Синхронизация ВК ↔ ТГ: гедком-время, каскад fams, adopted-карта

Контекст: два последних коммита (474d0a1, 9bef458) добавили гедком-дерево в оба
бота, но ТГ-версия отстала от ВК в четырёх местах. Синхронизируем **ТГ к ВК**
(ВК — эталон). Осознанная платформенная разница (👎-реакция в ВК vs кнопка
`dell:` в ТГ) — вне скоупа.

## 1. parseGedcom: ветка `2 TIME` — `tgcloud/lib/parse.js`

Дословно перенести из `lunarreturns.js:647-650` в `parseGedcom`
(tgcloud/lib/parse.js, после ветки `DATE`):

```js
} else if (lvl === 2 && tag === "TIME" && /^\d{1,2}:\d{2}/.test(val)) {
    if (curTag === "BIRT" && cur.birt) cur.birt.time = val.slice(0, 5);
    else if (curTag === "DEAT" && cur.deat) cur.deat.time = val.slice(0, 5);
}
```

## 2. parseTrigger: исходное время `srcH/srcM` — `tgcloud/lib/parse.js`

Сверить дословно с `lunarreturns.js`:
- строка ~545: `const src = givenTime ? { srcH: hh, srcM: mm } : {};` →
  `Object.assign(rec, src)` (исходное местное время — для гедкома `2 TIME`);
- строка ~564 (хвост смерти): `if (s.rec.srcH !== undefined) { rec.dsrcH = …; rec.dsrcM = …; }`.
Сейчас parse.js не возвращает src-полей вовсе — перенести из ВК-копии.

## 3. Схема: 4 колонки времени — `tgcloud/schema.js` + миграция

В `events` добавить (имена как в ВК-записи):

```js
srcH: integer('src_h'), srcM: integer('src_m'),       // исходное время рождения
dsrcH: integer('dsrc_h'), dsrcM: integer('dsrc_m'),   // время смерти
```

После правки: `npx tgcloud push` покажет диф, применить через
**`npx tgcloud migrate`** (деплой БД не трогает — миграция отдельный шаг).

## 4. upsertEvent — `tgcloud/lib/bot.js`

- В `vals` добавить `srcH: rec.srcH ?? null, srcM: rec.srcM ?? null,
  dsrcH: rec.dsrcH ?? null, dsrcM: rec.dsrcM ?? null`.
- В `onConflictDoUpdate.set` — те же четыре поля.

## 5. importGedcom — `tgcloud/lib/bot.js`

Перенести из ВК (`lunarreturns.js:881-899`): при импорте INDI
- `ind.birt.time` → `srcH/srcM` (split ":" → Number);
- `ind.deat.time` → `dsrcH/dsrcM`;
передавать их в `upsertEvent` (включая свадебную запись «Имя+Имя» — ВК для неё
dsrc-поля тоже хранит через `dd`-хвост, время развода в ВК пишется: сверить и
при наличии `deat.time` у пары — передать `dsrcH/dsrcM`).

## 6. gedcomText — `tgcloud/lib/bot.js`

- После `"2 DATE " + gdate(r.date)` (BIRT): `if (r.srcH !== null && r.srcH !== undefined)
  out.push("2 TIME " + pad(r.srcH) + ":" + pad(r.srcM))` — формат как
  `lunarreturns.js:1004`.
- После DEAT DATE — то же из `dsrcH/dsrcM` (`lunarreturns.js:1007`).
- Убрать избыточное `&& !r.name.includes("+")` у DEAT (recs уже фильтрует "+")
  — косметика до паритета с ВК.
- **adopted-карта**: строить из ВСЕХ связей чата, а не отфильтрованных `lk`
  (паритет с ВК `lunarreturns.js:1000`):
  `const adopted = new Map((await chatLinks(chatId)).filter(l => l.adopted).map(l => [l.child, true]));`

## 7. refreshFams — общий хелпер — `tgcloud/lib/bot.js` + `handlers/callback_query.js`

Экспортировать из lib/bot.js асинхронный аналог `refreshFams`
(`lunarreturns.js:826-836`):

```js
export async function refreshFams(chatId) {
    const famRows = await chatFams(chatId);
    const linksLeft = await chatLinks(chatId);
    for (const f of famRows) {
        const children = JSON.parse(f.children)
            .filter(c => linksLeft.some(l => l.famId === f.id && l.child === c));
        if (!children.length) await db.delete(fams).where(eq(fams.id, f.id)).run();
        else if (children.length !== JSON.parse(f.children).length)
            await db.update(fams).set({ children: JSON.stringify(children) }).where(eq(fams.id, f.id)).run();
    }
    const famIds = new Set((await chatFams(chatId)).map(f => f.id));
    for (const l of linksLeft)
        if (l.famId !== null && !famIds.has(l.famId))
            await db.update(links).set({ famId: null }).where(eq(links.id, l.id)).run();
}
```

Заменить им дублированную обрезку fams в ДВУХ местах callback_query.js:
- `del1:` (удаление события, ~строка 130-145) — после удаления связей персоны;
- `dell:` (удаление связи, ~строка 219-228).
Ключевое отличие от текущего кода: сброс **висячих `links.famId`** удалённых
семей (сейчас остаются), как `l.fam = undefined` в ВК.

## 8. Автопроверка синхронности копий — `dev/sync-check.mjs` (вместо ВК-REPL)

Отдельный REPL для ВК-бота не делаем: чистая логика — дословные копии, их
тестируем через существующий `dev/repl.mjs`; ВК-транспорт (реакции, cmid,
messages.edit) остаётся на ручную проверку в живом боте. Вместо этого —
тревога против молчаливого дрейфа копий:

- `dev/sync-check.mjs`: извлекает исходник зеркалируемых функций из
  `lunarreturns.js` и `tgcloud/lib/{parse,bot}.js` (по имени функции — от
  `function NAME(` / `export async function NAME(` до парной закрывающей
  скобки, простой скобко-счётчик), нормализует оба текста и сравнивает.
  Нормализация: выравнивание имён полей записей (`d`↔`date`, `n`↔`name`,
  `dd`↔`deathDate`, `p`/`c`↔`parent`/`child`, `peerId`↔`chatId`,
  `link.p`↔`link.parent`, `link.c`↔`link.child`, `link.fam`↔`link.famId`,
  `f.marr.d`↔`f.marrD`, `f.marr.plac`↔`f.marrPlac`, `f.div.d`↔`f.divD`,
  `f.div.plac`↔`f.divPlac`, `rec.sex` одинаково), удаление `export `, `await`,
  пробелов/комментариев; кавычки `'`↔`"` к одному виду.
- Список функций для сверки (пополняемый вверху скрипта):
  `parseTrigger`, `parseDateGroups`, `parseGedcom`, `gdateToISO`,
  `pairRecords`, `ensureFam`, `ensureFamSingle`, `confirmPair`, `linkText`,
  `gedcomText`, `importGedcom` + чисто-астрономические (`la`, религиозные
  дни — если извлекаются тем же способом).
- Расхождения, которые нормализация не убирает законно (async/await БД vs
  синхронный db), — в список допустимых отличков (ignore-list) с комментарием;
  всё прочее — exit 1 с diff.
- Выход 0/1 — можно повесить в CI позже; в рамках плана запуск вручную.

## Что НЕ меняем

- ВК-REPL — не делаем (решено): логику тестируем через `dev/repl.mjs`,
  дрейф ловит `dev/sync-check.mjs`.

## Что НЕ меняем

- 👎-реакция (ВК) vs кнопка `dell:` (ТГ) — платформенная разница.
- Хранение `pairCand` (объекты в db.json vs JSON-строка в колонке) — деталь
  хранения, логика идентична.
- ВК-бот (`lunarreturns.js`) — не трогаем, он эталон.

## Проверка

0. `node dev/sync-check.mjs` — до правок ТГ он должен **падать** на
   parseGedcom (нет TIME), importGedcom, gedcomText, adopted; после правок
   пп.1-7 — проходить (это и есть приёмочный тест синхронизации).
1. `node -e "import('./tgcloud/lib/parse.js')"` — синтаксис (или REPL).
2. REPL `dev/repl.mjs` (sdk-mock): импорт гедкома с `2 TIME` под BIRT и DEAT →
   `/gedcom` → в выводе должны быть `2 TIME` у обеих дат; сравнить с выводом
   ВК на том же входе (кусками вручную — ВК-вывод через
   `node lunarreturns.js test "…"` не покрывает гедком, поэтому сверка глазами
   или mini-скриптом).
3. REPL: создать событие с временем и городом → `2 TIME` = исходное время
   (не МСК).
4. REPL: цепочка родитель→ребёнок, подтвердить свадьбу, затем 👎/`del1` на
   событие родителя → семья удаляется, у оставшихся связей `famId = null`;
   `dell` на связь → то же.
5. `npx tgcloud status` → `npx tgcloud push` → `npx tgcloud migrate`
   (4 новые колонки events), затем smoke-тест вживую или
   `npx tgcloud run handlers/message '...'`.
