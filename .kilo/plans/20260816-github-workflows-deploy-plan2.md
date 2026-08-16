# План: диагностика и исправление «S3 вернул 400» при сохранении БД

## Контекст
Страница `../abakum.github.io/LunarReturns/index.html` (cloudPut, строки 596-607) делает PUT по presigned URL от функции; `resp.ok=false` → «Ошибка сохранения: S3 вернул 400». S3 отвечает реальным HTTP 400 (запрос доходит, это не CORS-блок).

## Уже проверено (read-only, сегодня)
- Env последней версии функции (`d4eq3ouso6r881kbkl38`, $latest) содержит ключ `YCAJEmjJ1…`, который существует (`ajeonb3l3m5047usmoin`) — креды живые.
- Локальный тест `handler._presign("GET", …)` теми же кредами → **HTTP 404 NoSuchKey** (подпись иcreds валидны, SigV4 корректен).
- Бакет: без шифрования, versioning disabled, max_size 1 ГБ, CORS (GET/PUT, origin abakum.github.io, headers *).
- Вывод: проблема специфична для PUT-запроса из браузера; GET-подпись работает.

## Гипотезы (проверить по порядку, решит шаг 1)
1. Какой-то заголовок/особенность браузерного PUT (Content-Type, Origin, HTTP/2) вызывает 400 — тело `Error/Code` назовёт причину.
2. Баг в самом PUT-presign (например, Yandex требует для PUT подписанный `content-length`/другое) — README говорит о побайтовой сверке с boto3 для generate_presigned_url, но браузерный PUT-флоу, возможно, впервые протестирован end-to-end.

## Шаги реализации

### 1. Репродукция с телом ошибки (диагностический объект, потом удалить)
Env функции уже извлекаем так (секрет не печатать в лог):
```sh
export PATH="$PATH:$HOME/yandex-cloud/bin"
eval "$(yc serverless function version get d4eq3ouso6r881kbkl38 --format json \
  | jq -r '.environment | to_entries[] | "export \(.key)=\(.value)"')"
```
Сгенерировать presigned PUT локально (как для GET выше) на ключ `diag/db.json` и прогнать матрицу curl, сохраняя тела ответов:
```sh
# a) минимум
curl -sS -o err_a -w '%{http_code}\n' -X PUT -d 'test' "$URL"
# b) как браузер: Content-Type + Origin
curl -sS -o err_b -w '%{http_code}\n' -X PUT -H 'Content-Type: application/json' \
  -H 'Origin: https://abakum.github.io' -d '{"x":1}' "$URL"
# c) принудительный HTTP/2 (браузер использует h2)
curl -sS -o err_c -w '%{http_code}\n' --http2 -X PUT -H 'Content-Type: application/json' \
  -H 'Origin: https://abakum.github.io' -d '{"x":1}' "$URL"
```
Разобрать `Error/Code` в телах (например, `InvalidArgument`, `InvalidRequest`, `SignatureDoesNotMatch` и т.п.).

### 2. Исправление по результату
- Если все варианты curl проходят (2xx): проблема на стороне страницы/браузера → в `cloudPut`/`cloudPresign` страницы добавить вывод тела ошибки (см. шаг 3) и повторить сохранение руками; при необходимости сравнить фактический URL (страница могла получить url с другим env/версией — проверить, что браузер вызывает $latest).
- Если воспроизводится (400 + Code): править `function/handler.py::_presign` сообразно коду ошибки (например, добавить в canonical request заголовки `content-type` при PUT, или использовать хэш payload вместо UNSIGNED-PAYLOAD). Сверить с boto3 `generate_presigned_url(ClientMethod='put_object', Params={'Bucket':…,'Key':…,'ContentType':…})` побайтово.
- После правки: `./deploy.sh` (авто-deploy новой версии) и повторный PUT-тест из шага 1 до зелёного.

### 3. Улучшение диагностики страницы (репо abakum.github.io)
В `cloudPut`/`cloudGet` (index.html:604, 611) включать тело ошибки S3:
```js
if (!resp.ok) throw new Error("S3 вернул " + resp.status + ": " + (await resp.text()).slice(0, 200));
```
(страница на русском — сообщение оставляем по-русски; только не забыть, что cloudPut строит ошибку из не-await контекста — аккуратно с then-цепочкой).

### 4. Очистка
Удалить `diag/db.json` из бакета (curl DELETE по presigned или через `yc`/консоль — s3cmd не настроен; можно сгенерировать DELETE-presign тем же handler-кодом).

### 5. Финальная проверка
- Повторить «Сохранить базу в облако» и «Загрузить базу из облака» на странице (нужен логин через Яндекс) — оба проходят.
- `yc iam access-key list` — один ключ; `gh secret list` — S3_* свежие.

## Риски
- Секрет функции виден через `yc … version get` — в команды/лог не печатать его значение (использовать eval в переменные окружения, без echo).
- PUT тестовых объектов в чужом по смыслу ключе — используем только `diag/db.json` и удаляем.

## Out of scope
- Изменение UX страницы, кроме текста ошибки.
- Ротация/хранение ключей (уже работает).
