# LunarReturns

Страница <https://abakum.github.io/LunarReturns/> рассчитывает совпадения
дней рождения с первым днём рождения — как `la()` в
[mxbPi/LunarAnniversaries.go](https://github.com/abakum/mxbPi/blob/main/LunarAnniversaries.go).
JS-порт формул [abakum/MoonPhase](https://github.com/abakum/MoonPhase) и таблиц
[abakum/gozodiac](https://github.com/abakum/gozodiac) встроен в `index.html` и
проверен побайтовым совпадением с выводом Go.

Пары «Имя + День рождения» хранятся в localStorage браузера; их можно добавлять,
изменять, удалять, показывать как QR и вставлять из буфера обмена. Размер базы
ограничен ёмкостью QR версии 40 (L, byte) — 2953 байта UTF-8. После входа через
Яндекс базу можно сохраняеть/загружать в бакет Yandex Object Storage `lunarreturns`
по пути `users/{uid}/db.json`. Если база пуста и Яндекс знает день рождения пользователя то вместо записи "Ада" будет запись "Я".
Секреты хранятся только в переменных окружения
облачной функции; страница и репозиторий их не содержат. Данные не покидают РФ:
страница не грузит сторонних скриптов, все запросы идут к `*.yandexcloud.net`.

## Состав

- `../abakum.github.io/LunarReturns/index.html` — страница (весь расчёт инлайн, `qr/qrcode.js` локально).
- `../abakum.github.io/LunarReturns/qr/qrcode.js` — [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) v1.4.4 (MIT), vendored.
- `function/handler.py` — облачная функция Yandex Cloud Functions (Python, только stdlib):
  проверяет OAuth-токен через `https://login.yandex.ru/info` и выдаёт presigned URL
  (SigV4) на `GET`/`PUT` одного объекта `users/{uid}/db.json`. Подпись сверена
  побайтово с boto3 `generate_presigned_url`.

## Развёртывание

### 1. Приложение Яндекс ID (единственный полностью ручной шаг)

1. <https://oauth.yandex.ru/client/new> → создать приложение.
2. Платформа «Веб-сервисы», Redirect URI: `https://abakum.github.io/LunarReturns/`.
3. Доступы: «Яндекс ID» → «Идентификатор пользователя» (`login:id`).
4. Полученный Client ID вписать в константу `YANDEX_CLIENT_ID` в `index.html`.

### 2. Всё остальное — `./deploy.sh` (см. ниже)

Скрипт создаёт и поддерживает: бакет `lunarreturns` (приватный, CORS
`GET`/`PUT` с origin `https://abakum.github.io`, лимит 1 ГБ — бесплатный
объём), сервисный аккаунт `lunarreturns-fn` (`storage.editor`) со static key,
функцию `lunarreturns-presign` (python312, `handler.handler`, 128MB / 10s,
публичный вызов) из `function/handler.py`, функцию `lunarreturns-push`
(`push.handler`, 128MB / 30s) из `function/push.py` и таймер
`lunarreturns-push-timer` (ежедневно 06:00 UTC = 09:00 МСК). Вручную эти
команды повторять не нужно; URL функций скрипт сам вписывает в константы
`FUNCTION_URL`/`PUSH_URL`/`PUSH_PUBLIC_KEY` в
`../abakum.github.io/LunarReturns/index.html` (в CI коммитит и пушит
автоматически; локально — вручную).

Переменные окружения функции (документация `function/handler.py`):

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | статический ключ сервисного аккаунта | — (обязательны) |
| `BUCKET` | имя бакета | `lunarreturns` |
| `ALLOWED_UIDS` | белый список UID через запятую (пусто — пускать всех) | `` |
| `EXPIRES` | срок жизни presigned URL, сек | `600` |

Переменные окружения push-функции (документация `function/push.py`):
`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`/`BUCKET` — как выше,
`VAPID_PRIVATE`/`VAPID_PUBLIC` — VAPID-пара (обязательны; создаются
`vapid-keygen.sh`), `VAPID_SUBJECT` — необязательный `mailto:`.
`VK_APP_SECRET` (защищённый ключ мини-аппа 54746591 — проверка `sign`
launch-параметров) и `VK_SERVICE_TOKEN` (сервисный ключ — отправка
уведомлений `execute.push`) — опциональны; без них ВК-действия
(`vk_subscribe`/`vk_unsubscribe`, ежедневная отправка) отключены.
Задаются как GitHub Secrets (`gh secret set VK_APP_SECRET -R abakum/LunarReturns`
и `VK_SERVICE_TOKEN`) или локально экспортом перед `./deploy.sh deploy`.
ВК-подписки хранятся отдельным ключом `push/vk_subs.json` того же бакета
(`[{vk_user_id, dates}]`, даты — обезличенные MM-DD, без ПДн).

### 3. Проверка

1. Закоммитить страницу с заполненными константами (при деплое из CI —
   не требуется, workflow пушит сам), дождаться GitHub Pages.
2. Войти через Яндекс, добавить записи, проверить QR и копирование.
3. «Сохранить базу в облако», очистить localStorage (или другой браузер),
   «Загрузить базу из облака».
4. ВК-пуши (после шага «Секреты ВК»): деплой функции → деплой мини-аппа
   из репо страницы → в мини-аппе 🔔 → разрешение → добавить запись с
   сегодняшней датой → проверить `push/vk_subs.json` в бакете → дождаться
   таймера 09:00 МСК (или `yc serverless function invoke lunarreturns-push`)
   → по пушу открыть приложение — автотап покажет сегодняшнюю запись.

После каждого деплоя скрипт сам делает smoke-тест URL функции.

## Развёртывание скриптом

Всё, кроме приложения Яндекс ID (шаг 1), делает локальный `deploy.sh`
(нужны `gh`, `zip`, `curl`, `jq`; отсутствующий `yc` скрипт ставит сам в
`~/yandex-cloud` без sudo, а не настроенные `yc init` / `gh auth login`
запускает интерактивно):

- `./deploy.sh` — сам выбирает действие: `bootstrap`, если функции ещё нет
  (бакет с CORS (лимит 1 ГБ — бесплатный объём), СА `lunarreturns-fn`
  (`storage.editor`), функция и первая версия из `function/handler.py`),
  иначе `deploy` — новая версия обеих функций (push-функция создаётся
  автоматически при первом `deploy`). Явный аргумент (`./deploy.sh deploy`
  или `bootstrap`) принудителен; обе команды идемпотентны. Для деплоя
  push-функции нужны VAPID-ключи — локально из `.vapid.env`
  (см. `vapid-keygen.sh` ниже); без них и без `.vapid.env` скрипт
  завершается с подсказкой.

При каждом запуске скрипт ротирует static key СА: создаёт новый, кладёт его в
GitHub Secrets `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (через локальный
`gh`, PAT не нужен), передаёт в env функции и удаляет старые ключи (env
функций в логах CI скрывается). Скрипт также вписывает URL функций в
константы `FUNCTION_URL`/`PUSH_URL`/`PUSH_PUBLIC_KEY` в
`../abakum.github.io/LunarReturns/index.html` (страница живёт в репо
abakum/abakum.github.io): из CI — коммитит и пушит сам, локально — commit
и push вручную. Дополнительно можно задать `ALLOWED_UIDS` и `EXPIRES`
(по умолчанию `` и `600`).

### Подготовка секретов ВК-пушей (один раз, локально)

Для ВК-нативных уведомлений мини-аппа 54746591 нужны два ключа из панели
разработчика ВК (<https://dev.vk.com> → ваше приложение → «Разработка» →
«Ключи доступа»):

- **Защищённый ключ** → `VK_APP_SECRET` — серверная проверка `sign`
  launch-параметров (единственный барьер против подделки `vk_subscribe`,
  URL функции публичен).
- **Сервисный ключ** → `VK_SERVICE_TOKEN` — отправка уведомлений
  (`execute.push`).

Сохранить их в GitHub Secrets репозитория функции:

```bash
gh secret set VK_APP_SECRET   -R abakum/LunarReturns   # вставить защищённый ключ
gh secret set VK_SERVICE_TOKEN -R abakum/LunarReturns  # вставить сервисный ключ
```

Либо интерактивно (скрытый ввод, существующие секреты не трогает, пустой
ввод — отложить): `./ci-prepare.sh` спросит оба ключа тем же блоком, что
`GH_PAT`. Секреты не ротируются (в отличие от S3-ключей) и читаются только
при создании версии функции. Локальный деплой: экспортировать те же
переменные перед `./deploy.sh deploy`. Без них деплой проходит с
предупреждением, но ВК-действия функции отвечают 500 «not configured».

После деплоя проверить: `curl -d '{"action":"vk_subscribe"}' <PUSH_URL>`
→ 500/403 (не «action must be …»), т.е. vk_-ветка активна.

### Подготовка деплоя через GitHub Actions (один раз, локально)

- PAT для ротации секретов из CI: `GITHUB_TOKEN` не умеет управлять
  секретами репозитория, поэтому `ci-prepare.sh` попросит один раз
  вставить PAT с правом `repo` (создать: <https://github.com/settings/tokens>)
  и сохранит его в секрет `GH_PAT`.
- `./ci-prepare.sh` — выдаёт СА `github-actions` роли
  `serverless.functions.admin` + `iam.serviceAccounts.accessKeyAdmin`,
  создаёт authorized key и кладёт в GitHub Secrets `YC_SA_KEY` /
  `YC_FOLDER_ID`. Идемпотентен. Печатает sa.json на экран — сохраните его
  в менеджер паролей: секрет из GitHub не читается обратно. Потеря ключа
  лечится повторным запуском скрипта (подписки не страдают).
- `./vapid-keygen.sh` — генерирует VAPID-пару для push-уведомлений:
  `VAPID_PRIVATE`/`VAPID_PUBLIC` в GitHub Secrets, `.vapid.env`
  (chmod 600, не в git) — ЕДИНСТВЕННАЯ резервная копия приватного ключа
  (её потеря = потеря всех push-подписок), публичный ключ коммитится
  в `vapid_public.txt`. `--force` — принудительная регенерация
  (все подписки пропадут), `--show-private` — напечатать приватный ключ.

### Деплой из CI

Workflow `.github/workflows/deploy.yml` (Actions → Deploy → Run workflow):
по `workflow_dispatch` деплоит обе функции через `deploy.sh deploy`,
ротирует S3-ключи, обновляет константы в index.html и пушит репо страницы
(для этого workflow чекаутит `abakum/abakum.github.io` с `GH_PAT`).
Локальный `./deploy.sh deploy` работает как раньше:
VAPID — из `.vapid.env` или экспортированных переменных, `yc init` /
`gh auth login` интерактивно.

