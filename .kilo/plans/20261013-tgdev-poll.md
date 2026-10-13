# dev/poll.mjs — long-poll драйвер TG-бота локально (один db.json)

РЕАЛИЗОВАНО (2026-10-13).

Цель: отладка `tgcloud/handlers/*` на **реальном Telegram** без облака —
long poll (`getUpdates`) через тестового бота. Продолжение планов
`20261011-tgcloud-port.md` и `20261012-tgdev-repl.md`.

РЕШЕНО: хранилище одно — `dev/db.json` — для REPL и poll; VK-бот
(`db.json` в корне) и облако tgcloud (SQLite платформы) не трогаем.
РЕШЕНО (унификация с VK-ботом): **формат** dev/db.json — как у VK
(`records` с полями `peerId/n/d/h/m`, `settings` — объект по peerId);
файл отдельный, не общий с VK. Токен — как у VK-бота: env `TG_TOKEN`
или корневой `.env` (тот же gitignored файл, отдельная строка от VK_TOKEN).

## Сделано

### 1. dev/sdk-mock/db.js — файл и VK-формат полей

- `DB_FILE = process.env.LR_DEV_DB || 'dev/db.json'` (env переименован с
  `LR_MOCK_DB`).
- Сериализация в формате VK-бота (маппинг на границе persistence,
  схема `schema.js` и билдер не меняются):
  - `events` → `records`: `{peerId: chatId, n: name, d: date}` +
    `h`/`m` только если время задано + служебное `id` (сохраняем:
    кнопки `del1:<id>` остаются валидны между запусками).
  - `settings` → объект `{"<peerId>": {orth, islam, bud, cath, jud}}`.
  - `lastSeen` не пишем (catch-up — VK-специфика).
- Загрузка — обратное преобразование, толерантное к отсутствию полей;
  id без монотонности добираются max+1.
- `.gitignore`: `dev/mock-db.json` → `dev/db.json`; старый
  `dev/mock-db.json` не мигрировался (тестовые данные).

### 2. dev/sdk-mock/index.js — api в двух режимах

Токен читается в момент вызова (`process.env.TG_TOKEN`):

- **TG_TOKEN не задан** (REPL) — Proxy → `__tgdev.onApi`;
  `getChatMember` → статус из `__tgdev.role`.
- **TG_TOKEN задан** (poll) — реальные вызовы Bot API:
  `POST https://api.telegram.org/bot<TG_TOKEN>/<method>`, body JSON,
  `globalThis.fetch` (не мокнутый экспорт!) c `AbortSignal.timeout(30000)`;
  `{ok:true,result}` → `result`; `{ok:false}` → `BotApiError` с
  `.code/.description`. Универсальный POST покрывает все методы
  (`editMessageText` с `parse_mode: 'HTML'` проходит насквозь).

### 3. dev/poll.mjs — драйвер

- Токен: env `TG_TOKEN` или корневой `.env`
  (`^\s*TG_TOKEN\s*=\s*(\S+)\s*$`, приём lunarreturns.js:798);
  выставляется в `process.env` ДО импорта хендлеров (sdk-mock уходит
  в реальный режим).
- Цикл: `getUpdates(offset, timeout=25,
  allowed_updates=["message","callback_query"])`; `offset = update_id+1`;
  сетевые ошибки — лог + 3с пауза. Маршрутизация: `update.message` →
  `handlers/message.js`, `update.callback_query` →
  `handlers/callback_query.js`. Хендлеры импортируются после установки
  мока в `node_modules/sdk`. Ctrl-C — выход.
- Без токена — понятный отказ (exit 1). Заголовок печатает префикс
  токена и путь БД.

### 4. Попутные фиксы (найдены при прогоне REPL / реальным пользователем)

- `tgcloud/handlers/callback_query.js`: `editMessageText` в `det`-ветке
  шёл без `parse_mode: 'HTML'` — спойлер отображался тегами; `editText`
  принимает parseMode, `det` шлёт `'HTML'`.
- `tgcloud/handlers/message.js`: команда в группе приходит как
  `/start@botname` — парсинг `/команда` до `@`.
- Группа и обычные (не-командные) триггеры требуют **отключённого
  privacy mode** у тестового бота (BotFather → /setprivacy → Disable)
  или прав админа — это настройка Telegram, не код.

## Совместное использование dev/db.json

- REPL (`node dev/repl.mjs`) без `TG_TOKEN` — оффлайн, та же база.
- События/настройки из REPL видны poll-боту и наоборот (файл один;
  одновременный запуск возможен, мутации не лочатся — для отладки
  достаточно).

## Валидация

Прогнано оффлайн (REPL, `--private`/`--admin`/дефолт-участник):
VK-формат db.json (запись без времени не содержит h/m; перезапуск читает),
/start-клавиатуры по ролям ([🗑,🔔,религии,❌] / [🗑,🔔,❌] / [🔔,❌]),
триггер+upsert, 👎 удаление правкой, 👀 тоггл подробно/сжато,
календарь религии + тоггл, 🔔 список, del-all с подтверждением,
устаревший список 🔔 стирается («Событий нет» правкой),
команды с @упоминанием.

Жживой прогон: `node dev/poll.mjs` с токеном тестового бота —
личка: /start-клавиатура, триггер → ответ HTML-спойлерами с 👎/👀,
👎 правка «🗑 Событие удалено…», 👀 тоггл, 🔔, религия-календарь,
🗑-флоу; группа: клавиатуры по ролям, 🗑 участником → «только владелец»;
выключенный VPN — драйвер логирует и продолжает.

## Вне объёма

- Синхронизация dev/db.json с облаком tgcloud (невозможно: SQLite платформы).
- Унификация с db.json VK-бота (отклонена).
- Лок http-вызовов REPL-режима (уже есть через onApi).
