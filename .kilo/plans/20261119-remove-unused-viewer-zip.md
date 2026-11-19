chore(viewer): remove the unused ZIP generator

## План

- Удалить `viewerZip`, её экспорт, ZIP-проверки и ссылку на неё в моке.
- Проверить, что действующие HTML-экспорты Telegram и ВК не изменились.

## Отчёт

- Удалены генератор ZIP, экспорт функции, ZIP-проверки с вызовом `unzip` и ссылка на генератор в REPL-моке. Ссылок на функцию в исполняемом коде не осталось.
- `npm run test:viewer`, `node dev/sync-check.mjs` и `git diff --check` прошли. Telegram по-прежнему экспортирует `.html`, ВК — `.html.gz`.
