feat(epub): add person name, birth date and kinship radius metadata

## План

- В общем генераторе EPUB взять полное имя и дату из ключа персоны, а подпись радиуса из `chart.cjs:rangeLevel()`. Сохранить имена файлов, XHTML, оглавление и отправку. Для древа без фокуса оставить один заголовок.
- Передать ключ и радиус из отдельных и пакетных экспортов TG/VK и генератора примера. Проверить извлечённый OPF, EPUBCheck и короткие офлайн-сценарии Telegram/VK.

## Отчёт

- В фокусном EPUB `main-title` содержит полное имя, `subtitle` — дату рождения, `dc:description` — радиус с подписью из `rangeLevel()`. В полном древе сохраняется только заголовок. Имена вложений и XHTML не изменились; PDF не менялся.
- `node dev/viewer-repl-check.mjs --metadata-only` проверил реальный OPF общего древа и радиусов 1/2 в изолированных REPL Telegram и VK. `node dev/sync-check.mjs` и `git diff --check` прошли. EPUBCheck 5.3.0: без ошибок, одно прежнее предупреждение `PKG-010` о пробелах в имени XHTML. Деплоя не было.
