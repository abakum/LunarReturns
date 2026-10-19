# AGENTS.md

Orientation for AI coding assistants (and humans) working in this project.
This file is auto-loaded by Claude Code, Cursor, and similar tools — keep it short
and true. For the full SDK reference (db, Bot API, fetch), see
[docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).

## What this project is

**LunarReturns** — лунно-солнечные юбилеи дней рождения. Один репозиторий,
несколько независимых частей:

1. **Web-страница/PWA** — живёт в отдельном репо `../abakum.github.io`
   (`LunarReturns/index.html`, весь расчёт инлайн). Сюда не входит.
2. **VK-бот** — `lunarreturns.js` (один файл, CJS, ноль зависимостей,
   Node ≥ 18, long poll VK API, локальный `db.json`, systemd-сервис
   `lunarreturns.service`). Запуск: `VK_TOKEN=... node lunarreturns.js`;
   проверка логики без токена: `node lunarreturns.js test "Имя 1963-09-27 12:30 (Пермь)"`.
3. **Облачные функции Yandex Cloud** — `function/handler.py` (presigned URL
   для S3) и `function/push.py` (web-push уведомления); деплой — `./deploy.sh`
   локально или GitHub Actions (`.github/workflows/deploy.yml`); подготовка
   секретов — `./ci-prepare.sh` / `./vapid-keygen.sh` (см. README.md).
4. **Telegram-бот** — `tgcloud/` на платформе [Telegram Serverless]:
   JavaScript-модули (схема БД, общая библиотека, обработчики апдейтов);
   платформа исполняет их в V8-изоляте. CLI `tgcloud` синхронизирует проект
   с облаком бота — как `wrangler`/`vercel` + `drizzle-kit`. См. ниже.

**Важно:** чистая логика расчётов (astro, религиозные дни, разбор триггеров,
связи/семьи/гедком, тексты) существует в двух копиях: инлайн в `lunarreturns.js`
(VK) и в `tgcloud/lib/` (Telegram, извлечена дословно). Меняя формулы — правь
**обе** копии; ВК-эталон, ТГ подтягивается (кроме осознанных платформенных
разниц: 👎-реакция в ВК vs кнопки в ТГ).

**Требование синхронности и тестирования:**
1. `node dev/sync-check.mjs` — исполняет обе копии на одинаковых сценариях
   (parse, гедком, связи/семьи, каскад) и сравнивает дословно; обязан проходить
   после любых правок логики — это приёмочный тест синхронности.
2. `node dev/repl.mjs` (см. шапку файла) — ручная отладка интерфейсного слоя
   ТГ-бота без облака; сценарии с триггерами, reply-связями и кнопками
   прогонять здесь.
3. `node lunarreturns.js test "..."` — быстрая проверка ВК-логики без токена.
Пуш в облако только после 1–2: `npx tgcloud status` → `push` → `migrate`
(если менялась `schema.js`; деплой БД не трогает).

[Telegram Serverless]: https://core.telegram.org/bots/serverless

## Планы и отчёты о работе (обязательно)

После реализации задачи записывай документы в `.kilo/plans/`:

- Именование: `YYYYMMDD-slug.md` — дата начала работы, латинский kebab-case
  slug (шаблон см. по соседним файлам этого каталога; вешай суффикс `-plan` /
  `-report` при необходимости различить).
- Если плана в каталоге ещё нет — записать **и план, и отчёт** одним файлом.
- Если план уже есть — **дополнять его отчётом** в тот же файл, а не создавать новый.

## Layout

Всё, что исполняет платформа Telegram, живёт в папке **`tgcloud/`**. Остальной
корень — VK-бот, функции YC, скрипты деплоя, документация (см. таблицу выше
и README.md).

| Path                  | What it is                                                        |
|-----------------------|-------------------------------------------------------------------|
| `lunarreturns.js`     | VK-бот: логика + транспорт VK, `db.json` рядом (gitignored).      |
| `function/`           | Функции Yandex Cloud (Python): `handler.py`, `push.py`.            |
| `deploy.sh`           | Деплой YC-функций (bootstrap/deploy, ротация ключей, таймер).      |
| `tgcloud/schema.js`   | Схема БД Telegram-бота — таблицы как **именованные экспорты**. Один файл. |
| `tgcloud/lib/`        | Общие модули TG-бота. Подпапки разрешены (`lib/internal/util.js`). |
| `tgcloud/lib/*.js`    | **Копии** чистой логики из `lunarreturns.js` — держать синхронно. |
| `tgcloud/handlers/`   | Обработчики апдейтов TG, **один уровень**. Имена = типам апдейтов Bot API (`message`, `callback_query`, …). |
| `tgcloud/endpoints/`  | Функции для Mini App (`POST /api/<name>`), **один уровень**.       |
| `tgcloud.jsonc`       | Конфиг проекта TG-бота (static-хостинг Mini App).                  |
| `docs/`               | Справочники SDK (`tgcloud-sdk.md`) и платформы (`tgcloud-serverless.md`, локальная копия — VPN не нужен). Не деплоятся. |
| `.tgcloud/`           | Состояние CLI (токен, снапшот). **Не редактировать** — gitignored. |

Only `.js` files under `tgcloud/` (`schema.js`, `lib/`, `handlers/`, `endpoints/`) are deployed
as code, plus — when `tgcloud.jsonc` names one — the front-end's build folder as
the Mini App's static files. Everything else (Markdown, config, `.tgcloud/`, the
front-end's sources) is local-only. Module names are relative to `tgcloud/`: the
file `tgcloud/handlers/message.js` is the module `handlers/message`.

## Mini App front-end

В этом репо front-end'а нет (страница живёт в `../abakum.github.io`); секция —
на случай, если появится.

If the project root holds a front-end (Vite, React, Vue, …), its **build output**
is deployed next to the bot and served as the Mini App at
`https://app<app_id>.tgcloud.ai/` — `push` prints the exact URL.

- `tgcloud.jsonc` → `{ "static": { "source": "dist" } }` — `source` names the
  build folder; the other keys of the `static` object are the serving config
  (e.g. `"spa": true` serves `index.html` for unknown extension-less paths —
  client-side routing; `immutable`, `headers`, `redirects`). `tgcloud init` writes
  the file when it recognizes the front-end; after that it's a normal project
  file. JSON with comments and trailing commas (a project may use a strict-JSON
  `tgcloud.json` instead — never both). `"static": "dist"` is accepted as a
  shorthand for `{ "source": "dist" }`.
  `"static": false` removes the deployed site on the next push.
- **Build before you push.** `push` uploads the folder as it is on disk; it never
  runs the build. `npm run deploy` (build + push) is the safe default.
- The front-end is ordinary browser code with npm packages — none of the
  `tgcloud/` module rules apply to it, and `tgcloud/` modules can't import it.
  It talks to the bot's code only through **endpoints** (below).
- The site is served from the host root, so the bundler's default `base` (`/`)
  is right. Don't add `X-Frame-Options` or a restrictive `frame-ancestors`:
  Telegram Web opens Mini Apps in an iframe.

## Endpoints — the Mini App's server side

`tgcloud/endpoints/<name>.js` is called by the Mini App as `POST /api/<name>` on
the same host as the static site. Use it for anything the front-end can't do
itself: the database, the Bot API, secrets.

- `export default async function (input, ctx)` — `input` is the JSON body (an
  object); the return value goes back as JSON.
- `ctx.initData` is the Mini App's init data **verified by the platform** (same
  shape as `Telegram.WebApp.initDataUnsafe`): `ctx.initData.user` is the caller.
  There is no `ctx.user`. Invalid init data → `401`, the endpoint never runs.
- Refuse with `throw new EndpointError('Out of stock', { code: 'OUT_OF_STOCK' })`
  (`import { EndpointError } from 'sdk'`) → `400`, the Mini App gets
  `description` + `parameters`. Any other exception → generic `500`; never
  rely on its message reaching the client.
- Front-end call: `Telegram.WebApp.Serverless.call('<name>', input, (err, result) => …)`
  from the official `telegram-web-app.js` — it sends the init data; `err` has
  `message` (description), `type` (`'ENDPOINT_ERROR'` for your `EndpointError`)
  and `parameters`. Don't hand-roll `fetch` + init data.
- Names: letters, digits, `_`, not starting with a digit (`getProfile`).
  Scaffold with `npx tgcloud add endpoints/<name>`; test with
  `npx tgcloud run endpoints/<name> '{}' --ctx '{ initData: { user: { id: 1 } } }'`.

## Module system — the rules that bite

- **Import project modules by relative path WITH the `.js` extension; import
  the SDK by name.** (from `tgcloud/handlers/message.js`:)
  - ✅ `import { users } from '../schema.js'`
  - ✅ `import { addItem } from '../lib/cart.js'`
  - ✅ `import { db, api, fetch } from 'sdk'` / `import { eq, sql } from 'sdk/db'`
  - ❌ `import { users } from '../schema'` → a relative import must end in `.js`
  - ❌ `import x from '../../src/x.js'` → nothing outside `tgcloud/` is reachable
  - A module's *name* is its path inside `tgcloud/` without `.js` (`lib/cart`);
    `tgcloud run` takes it, and `from 'lib/cart'` (no extension) also resolves —
    but write relative imports.
- **No filesystem, no npm packages** at runtime. Only `sdk` (and its submodules
  like `sdk/db`) and your own project modules exist.
- A handler module's `export default` is what the platform invokes, with the
  update's **payload** as the first argument — for `handlers/message` that's the
  `Message` (i.e. `update.message`), for `handlers/callback_query` the
  `CallbackQuery`, and so on. The full `Update` (with `update_id`) is on the
  second argument: `ctx.update`. An endpoint's `export default` gets
  `(input, ctx)` — see *Endpoints* above.

## Platform SDK (`import … from 'sdk'`)

- **`db`** — the database (query builder + schema DSL). Full API: [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md).
- **`api`** — the Telegram Bot API. `api.<method>({...})` (e.g. `api.sendMessage`,
  `api.getMe`) returns the **unwrapped** result and **throws `BotApiError`** on
  failure (`import { BotApiError } from 'sdk'`; it has `.code`/`.description`/`.parameters`).
- **`fetch`** — outbound HTTP, web-`fetch`-like (`res.status/ok`, `res.json()`,
  `res.text()`, streaming via `for await`, redirects followed).
- **`EndpointError`** — the one way an endpoint refuses a call (see *Endpoints*).

## Database — the rules that bite

Full API in [docs/tgcloud-sdk.md](docs/tgcloud-sdk.md). The non-obvious parts:

- **Every DB call is async — always `await`.** `.all()`, `.get()`, `.values()`,
  `.run()`, `db.$count()` and the raw `db.run/all/get` all return Promises.
- **No foreign keys.** `.references()` and `foreignKey()` **throw at declaration**
  — the runtime runs with FKs off, so they'd be silently inert. Enforce integrity
  in application code (delete children before parents, etc.).
- **Drops happen only via `.deprecated('reason')`** on a column/table/index.
  Deleting the declaration does *not* drop anything.
- **Type changes aren't automatic** — do them by hand with `db.run(...)`.

## Deploy & migrate workflow — Telegram-бот

**Deploying never touches the database.** Schema sync is a separate, explicit step.

The CLI is installed globally (`tgcloud`), but `npx tgcloud <command>` works the
same; `npm run deploy` = `tgcloud push`:

```
npx tgcloud status     # what changed locally vs the cloud
npx tgcloud push       # deploy modules (and the static build) to the cloud
npx tgcloud migrate    # apply tgcloud/schema.js changes to the database (interactive)
npx tgcloud run <module> [args]   # execute a handler or endpoint server-side
npx tgcloud pull       # bring the local project in line with the cloud
npx tgcloud login      # link this project to a bot
npx tgcloud webhook    # show the bot's webhook and whether it matches your handlers
```

After you change `tgcloud/schema.js`, `push` reports what the DB *would* change but applies
nothing — run `npx tgcloud migrate` to actually apply it.

The platform manages the bot's webhook for you, derived from your deployed
`handlers/*`, and refreshes it on `push`. If it ever drifts — e.g. someone called
`setWebhook` with the raw bot token — `npx tgcloud webhook` shows the mismatch and
`npx tgcloud webhook sync` repairs it.
