# Порт LunarReturns в Telegram Serverless (tgcloud)

Цель: Telegram-бот на платформе [Telegram Serverless](https://core.telegram.org/bots/serverless)
на основе логики VK-бота `lunarreturns.js`. Локальная копия документации платформы:
`.kilo/plans/20261011-tgcloud-serverless-doc.md` (снять VPN не нужен).

РЕШЕНО: ежедневной рассылки 09:00 МСК НЕТ (на платформе нет планировщика,
снаружи код не вызвать) — вместо неё «по запросу»: `/today` показывает
поздравления и религиозный дайджест на сегодня (МСК). VK-бот не трогаем.

## Структура (в корне репо, рядом с lunarreturns.js)

```
tgcloud/
├─ schema.js               # таблицы SQLite
├─ handlers/
│  ├─ message.js           # /start, /today, триггеры «Имя ГГГГ-ММ-ДД [ЧЧ:ММ]»
│  └─ callback_query.js    # кнопки: удаления, детально, настройки религий
└─ lib/
   ├─ astro.js             # астро-расчёты (port из lunarreturns.js)
   ├─ religion.js          # религиозные дни, religiousDigest
   ├─ parse.js             # parseTrigger, явные зоны, города
   └─ text.js              # jubileeText, ageSuffix, wdLocale, legend, HELP
```

Плюс `package.json` (devDep `@tgcloud/cli`, scripts), `tgcloud.jsonc` — создаст
`npm create @tgcloud/bot .` (не перезаписывает существующие файлы).

## Перенос логики (копирование 1:1, без npm, только ESM-экспорты)

Из `lunarreturns.js` переносятся как есть (чистые функции, ничего от VK):

- `lib/astro.js`: строки 9–198 (moonNew, moonZodiacInt, sunZodiacInts, la,
  ageSuffix, wdLocale, legend).
- `lib/religion.js`: строки 200–448 (JDN-конверсии, Пасхи, еврейский/исламский/
  буддийский календари, relDays, religiousDigest, religiousYear; константы
  REL_ORDER). `TZ_MS` (МСК=3ч) — в astro.js, экспорт для остальных.
- `lib/parse.js`: строки 450–537 (cityDiffMin, explicitZoneMinutes, parseTrigger).
- `lib/text.js`: 540–557 (jubileeText) + HELP-текст (адаптировать под TG).

НЕ переносится: VK-слой (vkApi, long poll, peer_id/cmid, клавиатуры ВК,
catchUp, scheduleDaily/dailyCheck, loadDb/saveDb на fs), systemd-обвязка.

## schema.js

```js
import { table, integer, text, uniqueIndex } from 'sdk/db';

export const events = table('events', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  chatId:  integer('chat_id').notNull(),
  name:    text('name').notNull(),
  date:    text('date').notNull(),          // 'YYYY-MM-DD'
  hour:    integer('hour'),                 // null = без времени
  minute:  integer('minute'),
}, (t) => ({
  uq: uniqueIndex('uq_event').on(t.chatId, t.name, t.date),  // upsert-семантика
}));

export const settings = table('settings', {
  chatId: integer('chat_id').primaryKey(),
  orthodox: integer('orthodox').default(0),  // boolean()
  catholic:  integer('catholic').default(0),
  jewish:    integer('jewish').default(0),
  islamic:   integer('islamic').default(0),
  buddhist:  integer('buddhist').default(0),
});
```

Без FK (платформа запрещает). Уникальность (chatId,name,date) — upsert:
`onConflictDoUpdate({ target: [events.chatId, events.name, events.date], set: {...} })`
— как `upsertRecord` в VK-боте (повторный триггер обновляет время).

## handlers/message.js

Текст сообщения; всё в МСК (как в VK-боте):

1. `/start` или `/` → HELP + inline-клавиатура по роли: личка — религии
   (`relMarkup`), админ группы — [🗑, 🔔, ❌] (`ownerMarkup`), участник —
   [🔔, ❌] (`bellMarkup`); 🔔 — список записей.
2. `/today` → события этого чата с сегодняшним MM-DD: по каждому `jubileeText(rec)`
   (плюс религиозный дайджест `religiousDigest(settings)`, если включены).
   Аналог dailyCheck, но без lastSentYear/записи в БД.
3. Иначе — по строкам, как `handleMessage`: `parseTrigger(line)`; ошибка →
   «💥 строка\nошибка»; успех → upsert в events + ответ `jubileeText(rec)`
   с inline-кнопками [👎 удалить] [👀 детально] (callback_data
   `del1:<id>` / `det:<id>` — id строки events). Не-триггеры игнорируются.

## handlers/callback_query.js

- `rel:<key>` — первый тап: календарь религии на год (`religiousYear`); второй
  тап (заголовок сообщения совпадает) — toggle религии в settings (upsert
  строки настроек), `answerCallbackQuery` + `editMessageText` с календарём.
- `bell` — список записей чата (`upcomingText`, по MM-DD) в этом же сообщении,
  клавиатура сохраняется.
- `del` — подтверждение удаления всех событий со списком (по ГГГГ-ММ-ДД):
  `del:yes` — `db.delete(events).where(eq(events.chatId, chatId))`,
  «🗑 Удалено событий: N»; `del:no` — вернуть клавиатуру по роли
  (религии — только в личке).
- `del1:<id>` — мгновенное удаление одного события (как реакция 👎 VK),
  «🗑 Событие удалено».
- `det:<id>` — ответ `jubileeText(rec, '', true)` (detail) через `sendLong`.

Реакции 👎/👀 из VK перенесены кнопками под ответом бота: 👎 — удалить,
👀 — детально (reaction-апдейты боту в группах приходят не всегда).

## Подготовка и деплой (ручные шаги, один раз)

1. @BotFather: создать бота → Serverless → включить → CLI Access → токен.
2. `npm create @tgcloud/bot .` в корне репо (добавит tgcloud/, package.json,
   tgcloud.jsonc; существующие файлы не трогает; AGENTS.md/docs от шаблона
   не принимать, у репо свои правила).
3. `npx tgcloud login` (токен из п.1; хранится в .tgcloud/, добавить в .gitignore).
4. `npx tgcloud push` + `npx tgcloud migrate` (создаст events/settings).
5. Проверить `npx tgcloud webhook` — in sync с хендлерами.

Правки дальше: `push` (код) отдельно, `migrate` (схема) отдельно.

## Тесты без деплоя

- Чистая логика (lib/) не импортирует `sdk` → проверяется в Node:
  `node -e "import('./tgcloud/lib/parse.js').then(...)"` — сравнить вывод
  la()/parseTrigger() с lunarreturns.js на нескольких датах.
- `npx tgcloud run handlers/message '{ chat: { id: 1 }, text: "Ада Байрон 1815-12-10" }'`
  и аналогично для /today; callback — `run handlers/callback_query
  '{ id: "1", data: "del1:1", message: { chat: { id: 1 } } }'`.

## Валидация (живой бот)

1. /start → справка + клавиатура по роли; тогглы религий переключаются
   (первый тап — календарь на год).
2. «Имя ГГГГ-ММ-ДД» → юбилейный ответ с кнопками [👎] [👀]; повтор с другим
   временем — обновление (upsert), не дубль.
3. 🔔 — список записей по MM-DD; /today — сегодняшние события + дайджест.
4. 🗑 (в клавиатуре) → подтверждение со списком (по ГГГГ-ММ-ДД) → удаление;
   👎 под ответом — мгновенное удаление; 👀 — детальный ответ.
5. `npx tgcloud status` — чисто после деплоя.

## Вне объёма (порта)

- Ежедневная рассылка (нет планировщика; вернуться, когда Telegram добавит).
- Mini App, endpoints/, синхронизация событий с VK-ботом (базы раздельные).
- message_reaction (заменено кнопками).

Локальная отладка без облака (REPL с моком sdk) — отдельный план:
`.kilo/plans/20261012-tgdev-repl.md`.

