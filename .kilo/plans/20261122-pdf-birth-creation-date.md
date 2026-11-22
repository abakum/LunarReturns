feat(pdf): use the person's birth date as the document creation date

В `/Info` фокусного PDF записать имя в `/Title`, а дату рождения в `/CreationDate` как `D:YYYYMMDD`, без выдуманного времени и часового пояса. Не менять EPUB, авторов, тему, имена файлов, график и даты аннотаций. Полное древо оставить без `/CreationDate`. Проверить в офлайн-экспортах TG/VK.

## Отчёт

Дата рождения записывается в `/CreationDate`, в `/Title` остаётся только имя. На офлайн-экспортах TG/VK проверены точное значение в PDF, чтение через `pdfinfo`, отсутствие поля в полном древе и неизменность EPUB. Прошли `node dev/viewer-repl-check.mjs --metadata-only`, `node dev/sync-check.mjs` и `git diff --check`. Деплой не выполнялся.
