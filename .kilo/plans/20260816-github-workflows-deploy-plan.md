# План: автоопределение bootstrap/deploy в deploy.sh

## Контекст
Сейчас `deploy.sh` требует явный аргумент (`bootstrap | deploy`) и падает на `usage`. Обе команды идемпотентны по построению: `bootstrap` — надмножество `deploy` (бакет, CORS, СА, `function create` — всё под `|| true`), общая часть — ротация ключа + версия функции + smoke-тест + запись `FUNCTION_URL`.

Решение пользователя: скрипт должен сам определять, что запускать.

## Детектор
Функция существует ⇔ уже был bootstrap:
```sh
yc serverless function get --name "$FN_NAME" >/dev/null 2>&1
```
- код 0 → инфраструктура есть → `deploy`
- не 0 → первого развёртывания не было → `bootstrap`

Это надёжнее, чем проверка бакета/СА по отдельности, и достаточно: если функция существует, но нет, например, СА (вручную удалён) — bootstrap-ветка всё равно всё пересоздаст благодаря `|| true`. Обратное невозможно: `deploy` без функции падает на `version create`.

## Правка `deploy.sh` (минимальная)
Заменить финальный `case`:
```sh
main() {
  local action="${1:-auto}"
  if [ "$action" = "auto" ]; then
    if yc serverless function get --name "$FN_NAME" >/dev/null 2>&1; then
      action=deploy
    else
      action=bootstrap
    fi
    info "Auto-detected action: $action (function $FN_NAME $([ "$action" = deploy ] && echo exists || echo not found))"
  fi
  case "$action" in
    bootstrap) bootstrap ;;
    deploy) deploy ;;
    *) die "usage: $0 [bootstrap | deploy]" ;;
  esac
}
main "$@"
```
Смысл: без аргументов — авто; явный `bootstrap`/`deploy` — override (для принудительного полного прогона). Usage-сообщение обновить в комментарии шапки: `# Usage: ./deploy.sh [bootstrap | deploy]  (default: auto-detect)`.

## Проверка зависимостей/yc — уже сделано (прошлый план)
Установка yc без sudo, `gh auth login`, `yc init` только при отсутствии настройки — уже реализованы и не трогаются.

## Валидация
- `bash -n deploy.sh`.
- `./deploy.sh` без аргументов на текущей машине: yc-профиль настроен, функция ещё не создавалась → auto → `bootstrap` (выведет `Auto-detected action: bootstrap`).
- Повторный запуск → auto → `deploy`.
- `./deploy.sh deploy` / `./deploy.sh bootstrap` — работают как раньше.
- `./deploy.sh foo` → `usage:` с exit 1.

## Риски
- Вызов `yc serverless function get` требует живого профиля — к моменту `main` он уже проверен (`folder-id` + `yc init` выше по скрипту), риск нет.
- Если функция создана, но с ошибочной конфигурацией (чужая/битая), авто выберет `deploy` и не чинит бакет/СА. Лечится явным `./deploy.sh bootstrap` — документировать в README одним предложением.

## README (одна строка)
В разделе «Развёртывание скриптом» заменить первый запуск/`bootstrap` и `deploy` на: `./deploy.sh` сам выбирает `bootstrap` (функции ещё нет) или `deploy`; явный аргумент — принудительно.

## Out of scope
- Слияние bootstrap/deploy в одну функцию (не нужно: общий код уже в `deploy_version`/`rotate_key`).
