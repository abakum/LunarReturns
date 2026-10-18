# Приём .ged-файла дропом в чат: вопрос «Да / Нет»

Гедкомы большие — вставить текстом не получается. При дропе `.ged`-документа в чат оба бота
спрашивают кнопками «Да / Нет», добавить ли файл в базу. Режима «заменить» нет: при желании
админ сначала чистит базу кнопкой 🗑 (уже есть), затем дропает файл.

Права: в группе обе кнопки — только тому, кто дропнул файл; в личке ограничений не нужно
(собеседник и есть dropper).

Общая семантика (одинакова в VK и TG):
- «✅ Да» — текущий `importGedcom` (слияние: upsert персон + дедуп связей), без изменений.
- «❌ Нет» — разово скрыть вопрос («Файл не добавлен»); следующий дроп спросит снова.
- Кнопки живут на сообщении-вопросе; после любого действия оно редактируется (editOrigin/editText),
  клавиатура снимается.
- Сообщение-вопрос при дропе: «🧬 Файл <имя>.ged: персон X, связей Y, свадеб Z. Добавить в список событий?»
  с кнопками «✅ Да» / «❌ Нет» (числа — из прогонки `parseGedcom` при дропе; файл сразу валидируется).
- Если файл не разобрался (`parseGedcom` → null): «💥 Не удалось разобрать файл .ged» (без кнопок).
- Кодировка UTF-8 (через TextDecoder в TG; VK — response.text()). ANSEL/CP1251 — вне рамок.
- Несколько `.ged` в одном сообщении — берём первый. При наличии `.ged`-документа текст/caption
  на триггеры не разбираем (документ приоритетен).

## VK-бот (`lunarreturns.js`)

1. В `longPollStep` (message_new, ~строка 1422) до отбрасывания безымянных сообщений:
   если `msg.attachments` содержит `{type:"doc", doc:{ext:"ged"|title *.ged, url}}` — обработать дроп
   (сообщение может быть без текста). Если doc без `url` — сообщение об ошибке.
2. Новый helper `handleGedDrop(peerId, doc, msgId, convMsgId, fromId)`:
   - `fetch(doc.url)` → текст, `parseGedcom`;
   - pending хранить в памяти: `Map peerId → {text, fromId, ts}` (перезапись последним дропом;
     истечение через час — проверять при нажатии);
   - `messagesSend` с inline-клавиатурой: `{c:"ged:add"}` «✅ Да», `{c:"ged:ign"}` «❌ Нет»
     (по образцу кнопки 🗑, `mk()`, payload `{c:...}`).
3. `handleEvent` (строка ~1600): новая ветка `ged:add` / `ged:ign`:
   - в группе (peerId ≥ 2000000000) только dropper (`pending.fromId === o.user_id`),
     иначе снекбар «только отправивший файл»; в личке проверки нет;
   - add → `importGedcom(peerId, parseGedcom(pending.text))` + `editOrigin` с отчётом
     («🧬 Гедком импортирован: персон X, связей Y, свадеб Z»);
   - ign → `editOrigin("Файл не добавлен")` с пустой клавиатурой;
   - после любого действия — удалить pending. Нет pending / истёк — снекбар
     «файл не найден — перешлите .ged заново».

## TG-бот (`tgcloud/`)

1. `tgcloud/schema.js` — новая таблица (stateless: текст файла живёт в БД до нажатия кнопки):
   ```js
   export const gedDrops = table('ged_drops', {
     chatId: integer('chat_id').primaryKey(),
     fromId: integer('from_id').notNull(),
     fileName: text('file_name').notNull(),
     content: text('content').notNull(),   // сырой текст .ged (UTF-8)
     ts: integer('ts').notNull(),          // epoch ms; при нажатии старше 1 ч — «файл не найден»
   });
   ```
   → после push обязателен `npx tgcloud migrate`.
2. `tgcloud/handlers/message.js`:
   - не выходить при пустом тексте, если есть `message.document`;
   - `document.file_name` заканчивается на `.ged` (без учёта регистра): скачать
     `api.getFileContent(document.file_id)` (лимит 20 МБ, BotApiError → сообщение об ошибке),
     декодировать `TextDecoder('utf-8').decode(bytes)`, `parseGedcom`;
   - валиден → upsert строки `gedDrops` (chatId — PK, последний дроп выигрывает) и `api.sendMessage`
     с вопросом и `inline_keyboard`: callback_data `gedadd` / `gedign`
     (метки «✅ Да» / «❌ Нет»); невалиден — сообщение об ошибке;
   - `.ged`-документ обрабатывается до разбора триггеров; прочий текст сообщения игнорируется.
3. `tgcloud/handlers/callback_query.js` — ветки `gedadd` / `gedign`:
   - строка `gedDrops` по chatId; нет/истекла (1 ч) → `answer("файл не найден — перешлите .ged заново")`;
   - в группе только dropper (`row.fromId === cq.from.id`), иначе `answer("только отправивший файл")`;
     в личке chatAdmin/dropper-барьер не нужен;
   - add → `importGedcom(chatId, parseGedcom(row.content))` + `editText` отчёт
     («🧬 Гедком импортирован: …»);
   - ign → `editText("Файл не добавлен", undefined)`;
   - удалить строку `gedDrops` после действия.

## Синхронность и проверка

- Чистая логика (`parseGedcom`, `importGedcom`) не меняется: `node dev/sync-check.mjs` обязан проходить.
- `node dev/repl.mjs`: при необходимости доработать мок (`dev/sdk-mock`): доставка
  `message.document` + `api.getFileContent`. Сценарии прогнать:
  дроп → вопрос → «Да» (импорт); «Нет» чужим участником; повторный дроп (последний выигрывает);
  нажатие после «протухания» строки; `.ged`-мусор → «💥 …».
- VK: `node lunarreturns.js test "Имя 1963-09-27 12:30 (Пермь)"` — регресс не должен упасть
  (дроп-ветка в transport-слое, тест её не задевает).

## Развёртывание

VK — рестарт сервиса `lunarreturns.service`. TG — `npx tgcloud status` → `push` → `migrate` (новая таблица).

## Вне рамок

Режим «заменить» (админ чистит базу 🗑 сам); ANSEL/CP1251-кодировки; импорт нескольких `.ged`
из одного сообщения; автоскрытие вопроса по таймеру; изменение поведения текстового гедкома
(остаётся как есть — сразу импорт).
