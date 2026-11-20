fix(viewer): allow up to 10000 people without a GEDCOM size limit

## План

- В общем HTML/EPUB-просмотрщике оставить только порог 10 000 записей INDI. PDF и отбор по радиусу не менять.
- Проверить открытие 10 000 записей, отказ на 10 001 и открытие GEDCOM больше 8 МиБ. Пересобрать бандл и прогнать браузерные и офлайн-проверки экспорта TG/VK.

## Отчёт

- Новый предел в общем бандле — 10 000 INDI; проверка размера GEDCOM удалена. Chromium подтвердил оба граничных случая и открытие GEDCOM больше 8 МиБ.
- Прошли `node dev/viewer-check.mjs`, `node dev/viewer-repl-check.mjs`, `node dev/sync-check.mjs` и `git diff --check`. Деплой не выполнялся.
