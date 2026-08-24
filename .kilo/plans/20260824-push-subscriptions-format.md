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

VAPID-пара генерируется ОДИН РАЗ на ноутбуке (до первого запуска workflow):
приватный ключ — в GitHub Secrets и в локальный `.vapid.env` (chmod 600,
в `.gitignore`) как резервная копия — секреты GitHub не читаются обратно,
другого способа сохранить нет. Публичный — в файл `vapid_public.txt` в репо.
`deploy.sh` вызывается только из workflow (триггер — только
`workflow_dispatch`).

### 1. Новый workflow `.github/workflows/deploy.yml`

- Триггер: `workflow_dispatch` (без push/nightly — S3-ключи ротируются
  при каждом запуске, лишние запуски ни к чему).
- `permissions: secrets: write` (`gh secret set` из rotate_key; коммитить
  workflow ничего не должен — VAPID-пара создаётся локально).
- `env: GH_TOKEN: ${{ github.token }}` — gh в CI аутентифицируется им,
  интерактивный `gh auth login` не нужен.
- Подготовка (один раз, с ноутбука) — отдельный скрипт `ci-prepare.sh`
  в корне репо (рядом с deploy.sh и vapid-keygen.sh; запускать только
  локально). РЕШЕНО: существующий `sa_key.json` утерян — он не нужен;
  деплой-ключ создаём заново от существующего SA `github-actions`
  (уже `editor` на каталог; отдельный SA не заводим). `editor` покрывает
  создание версий функций, триггеров и свои access-key, но НЕ даёт
  выдавать access-binding и чужие access-key.
  Скрипт (в стиле deploy.sh: `die/info`, проверки `yc`/`gh`; идемпотентный —
  add-access-binding с `|| true` при повторном запуске):
  1. Выдать SA `github-actions` недостающие роли на каталог:
     `serverless.functions.admin` (allow-unauthenticated-invoke,
     add-access-binding на функции) и `iam.serviceAccounts.accessKeyAdmin`
     (`yc iam access-key create --service-account-name lunarreturns-fn`
     в rotate_key).
  2. `yc iam key create --service-account-name github-actions` во временный
     файл (`$TMPDIR`, удалить в конце по trap).
   3. `gh secret set YC_SA_KEY -R abakum/LunarReturns` из временного файла;
     `gh secret set YC_FOLDER_ID --body "$(yc config get folder-id)"`.
   4. Самопроверка: от нового ключа выполнить dry-обращения —
      `yc iam access-key list --service-account-name lunarreturns-fn` и
      `yc serverless function get lunarreturns-presign` (полноценный
      `version create --dry-run` у yc может отсутствовать — тогда просто
      get); при ошибке IAM — подсказать, какая роль не выдана.
   5. Перед удалением временного файла вывести содержимое sa.json на экран
      (как `--show-private` в vapid-keygen.sh, но всегда) с напоминанием
      сохранить в менеджер паролей: секрет `YC_SA_KEY` из GitHub не
      читается обратно, а authorized keySA можно восстановить только
      пересозданием (`yc iam key create` + `gh secret set` заново —
      потери подписок нет, в отличие от VAPID).
  Примечание: если после первого прогона workflow окажется, что какая-то
  из ролей избыточна — удалить binding вручную (`yc resource-manager folder
  remove-access-binding ...`), скрипт не трогать.
  В workflow `YC_SA_KEY`/`YC_FOLDER_ID` пробрасываются в шаг через
  `env: YC_SA_KEY: ${{ secrets.YC_SA_KEY }}` и т.д., поэтому внутри шага
  доступны как обычные переменные окружения.
- Подготовка VAPID — отдельный скрипт `vapid-keygen.sh` в корне репо
  (рядом с deploy.sh; запускать только локально, один раз). Поведение:
  1. Идемпотентность: если `vapid_public.txt` уже есть или `gh secret list`
     содержит `VAPID_PRIVATE` — выйти с ошибкой (не перегенерировать
     случайно; для принудительной регенерации — флаг `--force` с явным
     предупреждением, что все подписки пропадут).
  2. Сгенерировать пару (openssl-рецепт п.2) во временном файле
     `$TMPDIR/.vapid.pem`, удалить его в конце (в т.ч. по trap).
  3. Записать `.vapid.env`: `export VAPID_PRIVATE=...` + `export VAPID_PUBLIC=...`,
     `chmod 600`; убедиться, что `.vapid.env` есть в `.gitignore`
     (добавить при отсутствии). Это единственная резервная копия приватного.
  4. `gh secret set VAPID_PRIVATE` (из переменной, не из файла, чтобы
     не оставлять копию на диске) и `gh secret set VAPID_PUBLIC`.
  5. Записать `vapid_public.txt`, закоммитить и запушить
     (`chore: add VAPID public key`).
  6. Вывести приватный ключ на экран один раз с напоминанием сохранить
     в менеджер паролей (опционально, по флагу `--show-private`,
     по умолчанию не показывать — он есть в `.vapid.env`).
  Скрипт переиспользует `die/info` и проверку зависимостей
  (`gh openssl python3 basenc`) в стиле deploy.sh.
- Шаги job:
  1. checkout.
  2. **ensure-vapid**: файл `vapid_public.txt` есть И секрет `VAPID_PRIVATE`
     есть (`gh secret list`) — иначе ошибка шага с подсказкой «сгенерируй
     локально по плану». Ничего не генерирует и не коммитит — генерация
     только локальная (см. подготовку выше); тогда права `contents: write`
     для workflow не нужны.
  3. **yc auth** (с `env: YC_SA_KEY/YC_FOLDER_ID` из `secrets`):
     `printf '%s' "$YC_SA_KEY" > /tmp/kilo/sa.json`;
     `yc config set service-account-key /tmp/kilo/sa.json`;
     `yc config set folder-id "$YC_FOLDER_ID"`.
  4. **deploy**: `VAPID_PUBLIC="$(cat vapid_public.txt)" VAPID_PRIVATE="${{ secrets.VAPID_PRIVATE }}" ./deploy.sh deploy`.

### 2. Генерация пары (внутри `vapid-keygen.sh`; без node; проверено, работает)

- `openssl ecparam -name prime256v1 -genkey -noout -out .vapid.pem`
- приватный: скаляр 32 байта — hex-строки между `priv:` и `pub:` из
  `openssl ec -text -noout`, собрать в байты → base64url без padding
  (python3-однострочник);
- публичный: `openssl ec -pubout -outform DER | tail -c 65 | basenc --base64url | tr -d '='`
  (несжатая точка 65 байт → 88 символов);
- временный `.vapid.pem` удалить; всё делается на ноутбуке, в репо
  попадает только `vapid_public.txt`.

### 3. Правки deploy.sh

- При `CI=true` (или наличии `GH_TOKEN` + `YC_SA_KEY`) пропускать
  интерактивные `gh auth login` и `yc init`; в CI `yc` уже настроен шагом 3,
  `gh` — через `GH_TOKEN`.
- `ensure_vapid_keys` перед `deploy`/`bootstrap_push`: взять значения из
  экспортированных `VAPID_PRIVATE`/`VAPID_PUBLIC`; если не заданы — фолбэк
  на локальный `.vapid.env` (для запусков с ноутбука, source в подоболочке);
  локальную генерацию при отсутствии обоих источников НЕ делать — подсказать
  рецепт (п.2) и что `.vapid.env` уже должен существовать как бэкап.
- Проверки зависимостей: `openssl`/`python3`/`basenc` нужны только для
  локальной генерации (п.2), в проверку deploy.sh не добавлять.
- Ротация VAPID запрещена: `rotate_key` по-прежнему только S3-ключи.

### 4. Локальные запуски (совместимость)

`./deploy.sh deploy` с ноутбука работает как раньше: `yc init`/`gh auth`
интерактивно, VAPID — из `.vapid.env` (chmod 600, в `.gitignore`) или
из экспортированных переменных. Bootstrap (создание bucket/SA) — тоже только
локально, workflow запускает только `deploy`.

### 5. Валидация

1. До первого запуска: локально созданы `VAPID_PRIVATE` (секрет + `.vapid.env`
   с chmod 600) и `vapid_public.txt` в репо; секрет и файл совпадают
   (публичный выводится из того же `.vapid.pem`).
2. Первый запуск workflow: ensure-vapid проходит, функции задеплоены,
   `PUSH_URL`/`PUSH_PUBLIC_KEY` вписаны в index.html (commit в
   abakum.github.io руками — deploy.sh только правит файл, как сейчас).
3. Повторный запуск: VAPID не меняется (шаг ничего не пишет), S3-ключи
   ротируются.
4. `yc serverless function invoke lunarreturns-push` — подписка с сегодняшней
   `MM-DD` в dates получает уведомление; запись с истёкшей подпиской
   удаляется при 404/410.
5. Потеря секрета GitHub: восстановить из `.vapid.env`
   (`gh secret set VAPID_PRIVATE < <(grep VAPID_PRIVATE .vapid.env | cut -d= -f2-)`)
   — подписки сохраняются. Потеря и `.vapid.env` — регенерация пары,
   все подписки пропадут (задокументировать в README).

### Валидация подготовки

Самопроверка встроена в `ci-prepare.sh` (шаг 4): падать из-за нехватки
ролей надо в скрипте, а не в CI. Дополнительно перед первым запуском
workflow можно прогнать с ноутбука полный `./deploy.sh deploy` под
профилем с новым ключом (`yc config profile create deploy-test` и т.п.,
профиль потом удалить) — но это опционально, достаточно шага 4.

### 6. README: дописать раздел «## Развёртывание скриптом»

Раздел уже существует (deploy.sh, ротация static key) — дополнить в конце:

- `./ci-prepare.sh` (один раз, локально): выдаёт SA `github-actions` роли
  `serverless.functions.admin` + `iam.serviceAccounts.accessKeyAdmin`,
  создаёт authorized key и кладёт в GitHub Secrets `YC_SA_KEY` /
  `YC_FOLDER_ID`. Скрипт печатает sa.json на экран — сохранить в менеджер
  паролей (секрет из GitHub не читается; потеря лечится повторным запуском
  без потери подписок).
- `./vapid-keygen.sh` (один раз, локально): генерирует VAPID-пару,
  `VAPID_PRIVATE`/`VAPID_PUBLIC` в GitHub Secrets, `.vapid.env` (chmod 600,
  не в git — единственная резервная копия приватного; потеря = потеря всех
  подписок), `vapid_public.txt` коммитится. `--force` — регенерация.
- `.github/workflows/deploy.yml` (Actions → Deploy → Run workflow):
  `workflow_dispatch`, деплоит обе функции через `deploy.sh deploy`,
  ротирует S3-ключи. Локальный `./deploy.sh deploy` по-прежнему работает:
  VAPID — из `.vapid.env`, `yc init`/`gh auth login` интерактивно.

### Открытые вопросы

Нет: SA для деплоя выбран (`github-actions`); подготовка — `ci-prepare.sh`,
VAPID — `vapid-keygen.sh` с бэкапом в `.vapid.env`.
