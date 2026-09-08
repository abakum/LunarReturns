# Отчёт: пуш-бэкенд, VK API, CORS и ошибки фронта (LunarReturns, 08.09.2026)

## Контекст

Критический разбор `function/push.py` (двумя итерациями) + сверка с
официальной документацией VK и репозиториями VKCOM + доводка CORS бакета
и обработки ошибок на фронте. Затронуты: `LunarReturns/function/push.py`,
`LunarReturns/function/handler.py`, `LunarReturns/deploy.sh`,
`abakum.github.io/LunarReturns/index.html`.

## 1. push.py — исправления по критике (подтверждённые)

1. **Метод VK API**: `execute.push` (не существует) →
   `notifications.sendMessage`. Формат ответа по официальной доке:
   `response` — массив `{user_id, status, error: {code, description}}`;
   пер-пользовательские коды: 1 — уведомления отключены, 2/3 —
   часовой/суточный лимит, 4 — приложение не установлено.
2. **Подпись launch-параметров**: `_vk_sign_ok` автоопределяет алгоритм по
   длине подписи — 64 hex → HMAC-SHA256 по всем параметрам кроме `sign`
   (актуальная схема), иначе легаси MD5 по `vk_*` + секрет. Плюс свежесть
   `vk_ts` (`VK_TS_MAX_AGE`, по умолчанию 86400 c — не 300 c из критики:
   фронт берёт `location.search` на момент действия, приложение может
   быть открыто часами).
3. **Классы ошибок VK** (`_vk_send` возвращает маркеры):
   `ok` / `disabled` (коды 1, 4 — подписка удаляется) / `limit` (2, 3 —
   доставки нет, но `fails` не растёт, ставится `pending`) /
   `fatal: ...` (топ-уровневая ошибка API — токен/права/метод) /
   `error: ...`. При `fatal:` рассылка прекращается без подсчёта `fails`
   — битый токен больше не может вычистить базу за 7 запусков.
4. **Дедлайны вместо безлимитных циклов**: `_run_daily(deadline)` и
   `_run_daily_vk(deadline)`; handler раздаёт бюджеты `PUSH_WEB_BUDGET=6` /
   `PUSH_VK_BUDGET=22` (env-override; сумма ≤ таймаута функции 30 c;
   VK-бюджет больше из-за sleep 0.34 c + RTT). Ветки изолированы
   try/except.
5. **pending-механика в обеих ветках**: не влезшие в cap/дедлайн (и
   оборванные по fatal) помечаются `pending` и доотправляются следующим
   запуском независимо от даты; хвост размечается по факту обработки
   (`due[n:]`), а не по `len(due) > cap`; долги сортируются первыми
   (`due.sort(key=...)`).
6. **`_send_push`** ловит `URLError`/`OSError` → `-1` (сеть ≠ мёртвая
   подписка); **`_run_daily`** гвардит `endpoint` (нет KeyError/
   AttributeError при ручной правке JSON в S3), битый VAPID не мутирует
   список, 404/410 удаляют, прочие ошибки — `pending` на повтор.
7. **SSRF-гигиена**: `_clean_sub` принимает endpoint только с хостов из
   `PUSH_HOSTS` (FCM / Mozilla / Apple, env-override).
8. **`random_id`** детерминирован от `(uid, дата)` через SHA-256 —
   повторный запуск в тот же день не дублирует уведомление.
9. Прочее: `VK_ORIGIN_RE` на `\Z`; время через `zoneinfo("Europe/Moscow")`
   с фолбэком на UTC+3; `isBase64Encoded` обрабатывается в обоих
   хендлерах (handler.py тоже).

## 2. Сверка с VKCOM (GitHub)

- `@vkontakte/vk-bridge` (master): `VKWebAppSubscribePush` в типах нет
  даже сейчас → наш флоу `AllowNotifications`/`DenyNotifications` —
  официальный для модели «уведомления приложения»
  (`notifications.sendMessage`, коды 1/4).
- `send` не валидирует имя события (ни в 3.0.2, ни в master) — хак со
  `VKWebAppSetViewSettings` легитимен; `promisifySend` без таймаутов в
  обеих версиях.
- Вендор `vendor/vk-bridge.min.js` — официальный browser-билд 3.0.2;
  для используемого набора событий достаточен, апгрейд не требуется.

## 3. CORS бакета

- Браузер сам ходит в бакет по presigned GET/PUT — правило обязано
  пропускать origin мини-аппа ВК, не только abakum.github.io.
- Консоль: добавлены `https://prod-app54746591-*.pages-ac.vk-apps.ru` и
  `https://stage-app54746591-*.pages.vk-apps.ru` (GET, PUT, `*`, 3600).
- Код синхронизирован с `pages-ac`: `VK_ORIGIN_RE` (push.py) и
  `LR_ORIGIN_RE` (index.html) расширены до `pages(-ac)?\.vk-apps\.(ru|com)`.
- `deploy.sh` (bootstrap): CORS-правило дополнено теми же тремя origin —
  повторный bootstrap больше не затирает ручные правки из консоли.

## 4. Фронтенд: обработка ошибок бэкенда

- `cloudPresign`: при `!resp.ok` читает `{"error": ...}` из ответа
  (осмысленные «invalid token»/«uid not allowed» вместо «функция вернула
  403»); оба ранних выхода — `Promise.reject(new Error(...))` вместо
  голого `reject()` (обработчики `e.message` больше не падают
  TypeError'ом). То же чтение `error` добавлено в `pushApi`.

## Отклонённые пункты критики (проверено, не проблема)

- CORS push-функции: `_response` ставит `Access-Control-Allow-Origin: *`
  + `Allow-Headers: Content-Type` — VK-iframe проходит без эхо-оригина.
- SW и пустой payload: `sw.js` не читает `event.data` (имена из
  IndexedDB) — `data === null` не страшен.
- S3-гонка GET-modify-PUT — принята (низкий трафик).
- Web-push без счётчика fails (чистятся только 404/410) — осознанный
  компромисс.

## Проверки

- `py_compile` push.py/handler.py; смоук-тесты с подменёнными
  `urlopen`/`_load_subs`/`_vk_send`/`_vapid_auth`: маркеры `_vk_send`,
  детерминизм `random_id`, fatal-abort с pending-хвостом,
  disabled/limit/cap/долги-первыми, endpoint=None, дедлайн web-ветки,
  410/-1 — все пройдены.
- Regex `VK_ORIGIN_RE`/`LR_ORIGIN_RE`: матчат `pages` и `pages-ac`
  (ru/com), отклоняют чужие домены и `\n`.
- Синтаксис всех инлайн-скриптов index.html (`new Function`) — OK; голых
  `Promise.reject()` не осталось; `bash -n deploy.sh` — OK.
- Живые проверки после деплоя: префлайт из мини-аппа (CORS), реальная
  отправка VK-уведомления, поведение таймера по логам функции.

## Файлы

- `LunarReturns/function/push.py` — основная переработка.
- `LunarReturns/function/handler.py` — base64-тело ответа.
- `LunarReturns/deploy.sh` — CORS с origin'ами ВК.
- `LunarReturns/index.html` — `LR_ORIGIN_RE`, `cloudPresign`, `pushApi`.
