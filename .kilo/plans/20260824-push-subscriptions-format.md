# Push subscriptions: минимизация данных

Контекст: реализовано в 20260824 (см. abakum.github.io/.kilo/plans/20260824-birthday-push-plan.md).

## Формат push/subscriptions.json — уже минимален

```json
[{"endpoint": "https://...", "p256dh": "...", "auth": "...", "dates": ["12-10"]}]
```

- `dates` — только `MM-DD` без имён и без годов: страница шлёт `r.d.slice(5)`
  (index.html `dbDates()`), функция валидирует `^\d{2}-\d{2}$` (push.py).
- Года рождения в облако не попадают вообще — менять код не нужно.

## Что осталось сделать (деплой через GitHub Actions)

VAPID-ключи генерируются в workflow один раз: приватный — в GitHub Secrets,
публичный — в файле `vapid_public.txt` в репо (секреты не читаются обратно,
публичный ключ в репо позволяет восстанавливать пару). `deploy.sh` вызывается
только из workflow (триггер — только `workflow_dispatch`).

### 1. Новый workflow `.github/workflows/deploy.yml`

- Триггер: `workflow_dispatch` (без push/nightly — S3-ключи ротируются
  при каждом запуске, лишние запуски ни к чему).
- `permissions: contents: write, secrets: write` (commit публичного ключа,
  `gh secret set` из rotate_key и для VAPID).
- `env: GH_TOKEN: ${{ github.token }}` — gh в CI аутентифицируется им,
  интерактивный `gh auth login` не нужен.
- Подготовка (один раз). ВАЖНО: существующий `sa_key.json` есть на другой
  машине (из этого репо он удалён). Продолжить подготовку с той машины —
  сначала проверить, от какого SA создан ключ:
  ```
  jq -r .service_account_id sa_key.json
  yc iam service-account list   # сопоставить id с именем
  ```
  - Если SA уже имеет широкие права (например, admin/editor на каталог) —
    использовать существующий `sa_key.json` как есть, ничего не создавать.
  - Если ключ от `lunarreturns-fn` (только `storage.editor`) — создать
    отдельный SA-деплоер (ниже), иначе деплой из CI упадёт на создании
    версий функций/триггеров/IAM-ключей:
    ```
    yc iam service-account create lunarreturns-deployer
    yc resource-manager folder add-access-binding "$FOLDER_ID" \
      --role editor --service-account-name lunarreturns-deployer
    yc iam key create --service-account-name lunarreturns-deployer \
      --output /tmp/kilo/sa_deployer.json
    gh secret set YC_SA_KEY -R abakum/LunarReturns < /tmp/kilo/sa_deployer.json
    ```
  - В обоих случаях положить folder-id в секрет:
    ```
    gh secret set YC_FOLDER_ID -R abakum/LunarReturns --body "$(yc config get folder-id)"
    ```
  В workflow `YC_SA_KEY`/`YC_FOLDER_ID` пробрасываются в шаг через
  `env: YC_SA_KEY: ${{ secrets.YC_SA_KEY }}` и т.д., поэтому внутри шага
  доступны как обычные переменные окружения.
- Шаги job:
  1. checkout.
  2. **ensure-vapid**: если файла `vapid_public.txt` нет и `gh secret list`
     не содержит `VAPID_PRIVATE` — сгенерировать пару (openssl-рецепт ниже),
     `gh secret set VAPID_PRIVATE`, записать `vapid_public.txt`, закоммитить
     и запушить (`chore: add VAPID public key`). Если файл есть — использовать
     его; рассинхрон файла и секрета — ошибка шага (проверять оба условия).
  3. **yc auth** (с `env: YC_SA_KEY/YC_FOLDER_ID` из `secrets`):
     `printf '%s' "$YC_SA_KEY" > /tmp/kilo/sa.json`;
     `yc config set service-account-key /tmp/kilo/sa.json`;
     `yc config set folder-id "$YC_FOLDER_ID"`.
  4. **deploy**: `VAPID_PUBLIC="$(cat vapid_public.txt)" VAPID_PRIVATE="${{ secrets.VAPID_PRIVATE }}" ./deploy.sh deploy`.

### 2. Генерация пары (без node; проверено, работает)

- `openssl ecparam -name prime256v1 -genkey -noout -out .vapid.pem`
- приватный: скаляр 32 байта — hex-строки между `priv:` и `pub:` из
  `openssl ec -text -noout`, собрать в байты → base64url без padding
  (python3-однострочник);
- публичный: `openssl ec -pubout -outform DER | tail -c 65 | basenc --base64url | tr -d '='`
  (несжатая точка 65 байт → 88 символов);
- временный `.vapid.pem` удалить; в CI всё в $RUNNER_TEMP, в репо не попадает.

### 3. Правки deploy.sh

- При `CI=true` (или наличии `GH_TOKEN` + `YC_SA_KEY`) пропускать
  интерактивные `gh auth login` и `yc init`; в CI `yc` уже настроен шагом 3,
  `gh` — через `GH_TOKEN`.
- `ensure_vapid_keys` перед `deploy`/`bootstrap_push`: взять значения из
  экспортированных `VAPID_PRIVATE`/`VAPID_PUBLIC`; если не заданы — фолбэк
  на локальный `.vapid.env` (для запусков с ноутбука, source в подоболочке);
  локальную генерацию при отсутствии обоих источников НЕ делать — подсказать
  запустить workflow.
- Дополнить проверку зависимостей командами `openssl`, `python3`, `basenc`
  (нужны для генерации в workflow).
- Ротация VAPID запрещена: `rotate_key` по-прежнему только S3-ключи.

### 4. Локальные запуски (совместимость)

`./deploy.sh deploy` с ноутбука работает как раньше: `yc init`/`gh auth`
интерактивно, VAPID — из `.vapid.env` (chmod 600, в `.gitignore`) или
из экспортированных переменных. Bootstrap (создание bucket/SA) — тоже только
локально, workflow запускает только `deploy`.

### 5. Валидация

1. Первый запуск workflow: в Secrets появился `VAPID_PRIVATE`, в репо —
   `vapid_public.txt`, функции задеплоены, `PUSH_URL`/`PUSH_PUBLIC_KEY`
   вписаны в index.html (commit в abakum.github.io руками — deploy.sh только
   правит файл, как сейчас).
2. Повторный запуск: ключ не меняется (`vapid_public.txt` не перезаписывается,
   секрет не перезаписывается), S3-ключи ротируются.
3. `yc serverless function invoke lunarreturns-push` — подписка с сегодняшней
   `MM-DD` в dates получает уведомление; запись с истёкшей подпиской
   удаляется при 404/410.
4. Потеря секрета/файла: восстановить приватный невозможно — регенерация
   пары (шаг ensure-vapid заново), все подписки пропадут (задокументировать).

### Открытые вопросы

- От какого SA создан существующий `sa_key.json` (на другой машине) —
  выясняется первым шагом подготовки (см. п.1); от ответа зависит, нужен ли
  новый SA `lunarreturns-deployer`.
