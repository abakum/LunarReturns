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
публичный вызов) из `function/handler.py`. Вручную эти команды повторять
не нужно; URL функции скрипт сам вписывает в константу `FUNCTION_URL` в
`../abakum.github.io/LunarReturns/index.html` (commit/push того репо — вручную).

Переменные окружения функции (документация `function/handler.py`):

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | статический ключ сервисного аккаунта | — (обязательны) |
| `BUCKET` | имя бакета | `lunarreturns` |
| `ALLOWED_UIDS` | белый список UID через запятую (пусто — пускать всех) | `` |
| `EXPIRES` | срок жизни presigned URL, сек | `600` |

### 3. Проверка

1. Закоммитить страницу с заполненными константами, дождаться GitHub Pages.
2. Войти через Яндекс, добавить записи, проверить QR и копирование.
3. «Сохранить базу в облако», очистить localStorage (или другой браузер),
   «Загрузить базу из облака».

После каждого деплоя скрипт сам делает smoke-тест URL функции.

## Развёртывание скриптом

Всё, кроме приложения Яндекс ID (шаг 1), делает локальный `deploy.sh`
(нужны `gh`, `zip`, `curl`, `jq`; отсутствующий `yc` скрипт ставит сам в
`~/yandex-cloud` без sudo, а не настроенные `yc init` / `gh auth login`
запускает интерактивно):

- `./deploy.sh` — сам выбирает действие: `bootstrap`, если функции ещё нет
  (бакет с CORS (лимит 1 ГБ — бесплатный объём), СА `lunarreturns-fn`
  (`storage.editor`), функция и первая версия из `function/handler.py`),
  иначе `deploy` — новая версия функции. Явный аргумент (`./deploy.sh deploy`
  или `bootstrap`) принудителен; обе команды идемпотентны.

При каждом запуске скрипт ротирует static key СА: создаёт новый, кладёт его в
GitHub Secrets `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` (через локальный
`gh`, PAT не нужен), передаёт в env функции и удаляет старые ключи. Скрипт
также вписывает URL функции в константу `FUNCTION_URL` в
`../abakum.github.io/LunarReturns/index.html` (страница живёт в репо
abakum/abakum.github.io); commit и push того репо — вручную. Дополнительно
можно задать `ALLOWED_UIDS` и `EXPIRES` (по умолчанию `` и `600`).

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
ротирует S3-ключи. Локальный `./deploy.sh deploy` работает как раньше:
VAPID — из `.vapid.env` или экспортированных переменных, `yc init` /
`gh auth login` интерактивно.

