feat(bell): jubilee/bell notifications by new style for pre-1918 dates (VK + TG)

Даты ≤ 1918-01-31 хранятся по старому (юлианскому) стилю; оповещения —
по новому (григорианскому): сдвиг только на слое вывода и сортировки,
хранение и экспорт не тронуты (реэкспорт не пересдвигает даты).

## Отчёт

- `newStyleDate(iso)` (ВК lunarreturns.js рядом с julianToJdn; ТГ
  `lib/religion.js`, экспорт): полный ISO ≤ `OLD_STYLE_END` (1918-01-31)
  → `julianToJdn` → `jdnToGreg`; неполные (малые даты хранятся полным ISO,
  урезание несёт abt) и ≥ 1918-02-01 — без сдвига.
- Heads/lists print via `approxOut` with new-style date:
  - `jubileeText` (ВК ≡ `lib/text.js`): `Имя 1234~` вместо `1234-01-01`,
    точные `<новая дата>`, старая дата не показывается (по выбору);
    лунный расчёт `la(t)` — от сдвинутой даты.
  - 🔔: `focusListText`/`upcomingEvents` (ВК ≡ `lib/bot.js` `upcomingText`,
    `focusListText`): печать и круговая сортировка `bellKey` по новому
    ММ-ДД; kinLabel/фильтр примерных — по хранимой (фильтр примерных сохранён).
- Ежедневный пуш `dailyCheck` (ВК): матч по ММ-ДД сдвинутой даты
  (фильтрация в JS вместо SQL substr); sent-ключи — хранимые.
- Ответ-обработка: показанный текст (новый стиль/суффикс) резолвится
  обратно: `recordShownOf` (ВК ≡ `lib/bot.js`), reply-regex принимает
  урезанные/суффиксованные даты `(\d{4}(?:-\d{2}(?:-\d{2})?)?[?=<~]?)`;
  якоря правки/прививки берут хранимый ключ из найденной записи;
  реакция-поиск `findRecordByCmid` через recordShownOf.
- `approxOut`/`ABT_MARK` перенесены из `lib/bot.js` в `lib/text.js`
  (экспорт; избегаем цикла text↔bot).
- Тесты: `dev/sync-check.mjs` блок «старый стиль» (сдвиг 1663/1899/1918,
  год-only без сдвига, головы юбилеев, 🔔 полный/круговой, экспорт
  дословно, recordShownOf); ожидание wedding-abt — `1985~`.
  `node dev/sync-check.mjs` ✓; репл-прогоны ТГ (`dev/repl.mjs --fresh`:
  триггер→новый стиль, /bell, «/»-ответ на показанный текст) и ВК
  (`dev/vk-repl.mjs --fresh`: /bell1 по показанному ключу, /bell-чат,
  `!date 2026-07-24`+`!daily` → annual по новому стилю, на старую — тишина);
  `dev/tg-db.json` возвращён, dev-базы снесены.
