# LunarReturns

Страница <https://abakum.github.io/LunarReturns/> рассчитывает совпадения предстоящих
дней рождения с первым днём рождения (день недели, фаза луны, лунный и солнечный
знаки зодиака, восточный календарь) — как `la()` в
[mxbPi/LunarAnniversaries.go](https://github.com/abakum/mxbPi/blob/main/LunarAnniversaries.go).
JS-порт формул [abakum/MoonPhase](https://github.com/abakum/MoonPhase) и таблиц
[abakum/gozodiac](https://github.com/abakum/gozodiac) встроен в `index.html` и
проверен побайтовым совпадением с выводом Go.

Пары «Имя + День рождения» хранятся в localStorage браузера; их можно добавлять,
изменять, удалять, показывать как QR и вставлять из буфера обмена. Размер базы
ограничен ёмкостью QR версии 40 (L, byte) — 2953 байта UTF-8. После входа через
Яндекс база сохраняется/загружается в бакет Yandex Object Storage `lunarreturns`
по пути `users/{uid}/db.json`. Секреты хранятся только в переменных окружения
облачной функции; страница и репозиторий их не содержат. Данные не покидают РФ:
страница не грузит сторонних скриптов, все запросы идут к `*.yandexcloud.net`.

## Состав

- `index.html` — страница (весь расчёт инлайн, `qr/qrcode.js` локально).
- `qr/qrcode.js` — [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) v1.4.4 (MIT), vendored.
- `function/handler.py` — облачная функция Yandex Cloud Functions (Python, только stdlib):
  проверяет OAuth-токен через `https://login.yandex.ru/info` и выдаёт presigned URL
  (SigV4) на `GET`/`PUT` одного объекта `users/{uid}/db.json`. Подпись сверена
  побайтово с boto3 `generate_presigned_url`.

## Развёртывание

### 1. Приложение Яндекс ID

1. <https://oauth.yandex.ru/client/new> → создать приложение.
2. Платформа «Веб-сервисы», Redirect URI: `https://abakum.github.io/LunarReturns/`.
3. Доступы: «Яндекс ID» → «Идентификатор пользователя» (`login:id`).
4. Полученный Client ID вписать в константу `YANDEX_CLIENT_ID` в `index.html`.

### 2. Бакет Object Storage

Бакет `lunarreturns` (приватный). Правило CORS (S3 API → CORS):

```json
[{
  "AllowedMethods": ["GET", "PUT"],
  "AllowedOrigins": ["https://abakum.github.io"],
  "AllowedHeaders": ["*"],
  "MaxAgeSeconds": 3600
}]
```

### 3. Сервисный аккаунт и ключи

1. Создать сервисный аккаунт (например `lunarreturns-fn`) с ролью `storage.editor`.
2. Создать для него статический access key (консоль → Сервисные аккаунты → ключи).
3. Ключи пойдут в переменные окружения функции, в репозиторий не попадают.

### 4. Cloud Function

```sh
cd function
zip fn.zip handler.py
yc serverless function create --name lunarreturns-presign
yc serverless function version create \
  --name lunarreturns-presign --runtime python312 \
  --entrypoint handler.handler --memory 128m --execution-timeout 10s \
  --source-path fn.zip \
  --environment S3_ACCESS_KEY_ID=<id>,S3_SECRET_ACCESS_KEY=<secret>,BUCKET=lunarreturns
```

Включить публичный доступ (unauthenticated invocation) в консоли или:

```sh
yc serverless function allow-unauthenticated-invoke --name lunarreturns-presign
```

Полученный URL вида `https://functions.yandexcloud.net/<id>` вписать в константу
`FUNCTION_URL` в `index.html`.

Переменные окружения:

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | статический ключ сервисного аккаунта | — (обязательны) |
| `BUCKET` | имя бакета | `lunarreturns` |
| `ALLOWED_UIDS` | белый список UID через запятую (пусто — пускать всех) | `` |
| `EXPIRES` | срок жизни presigned URL, сек | `600` |

### 5. Проверка

1. Закоммитить страницу с заполненными константами, дождаться GitHub Pages.
2. Войти через Яндекс, добавить записи, проверить QR и копирование.
3. «Сохранить базу в облако», очистить localStorage (или другой браузер),
   «Загрузить базу из облака».
