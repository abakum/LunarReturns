fix(vk): transliterate the compressed viewer filename

## План

- Использовать одну транслитерированную основу для имени архива и внутреннего HTML.
- Обновить REPL-проверку обоих имён и прогнать проверки TG/VK.

## Отчёт

- ВК отправляет `<viewerBase>.html.gz` с внутренним именем `<viewerBase>.html`. Имена GED и PDF не изменены.
- `node dev/viewer-repl-check.mjs`, `node dev/sync-check.mjs` и `git diff --check` прошли.
