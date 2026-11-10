fix(bot): show bell loading icon for radius buttons

## План

Унифицировать индикатор списка для цифр радиуса и 🔔 в TG/VK: `N-триггер\n🔔⏳`. Обновить зеркальную проверку всех радиусов и прогнать REPL/sync-check.

## Отчёт

Реализовано в обоих ботах. Проверки всех радиусов и повторного 🔔 в a3-repl-check ожидают одинаковое 🔔⏳. Успешно выполнены `node dev/a3-repl-check.mjs`, `node dev/sync-check.mjs`, `git diff --check`. Логи `/tmp/lr-a3-repl-k3MsX7`. Деплой и коммит не выполнялись.
