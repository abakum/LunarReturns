feat(epub): use the person's birth date as the publication date

В фокусном EPUB оставить в `dc:title` имя, а дату рождения записать в `dc:date` для Publication Details. Не менять авторов, описание радиуса, `dcterms:modified`, имена файлов и PDF. Полное древо оставить без даты публикации. Проверить OPF в офлайн-экспортах TG/VK.

## Отчёт

В фокусном EPUB метаданные разделены: имя в `dc:title`, дата рождения в `dc:date`. У полного древа `dc:date` отсутствует; PDF не изменён. Прошли `node dev/viewer-repl-check.mjs --metadata-only` для TG/VK, `node dev/viewer-check.mjs`, `node dev/sync-check.mjs` и `git diff --check`. Деплой не выполнялся.
