test(vk): try a Deflate ZIP alongside the gzip viewer

## План

- Отправить в VK вместе с прежним `.html.gz` пробный `.html.zip`: единственная запись `.html`, метод Deflate. Использовать уже проверенный сборщик ZIP. Не менять Telegram и EPUB.
- В офлайн REPL сравнить HTML из обоих архивов побайтово, проверить метод хранения и независимость отправки от отказа ZIP. Живой тест отдельно.

## Отчёт

- Офлайн REPL VK подтвердил `.html.zip` с одним `.html` (Deflate), идентичным содержимому `.html.gz`. При отказе ZIP остальные вложения, включая gzip, сохраняются. REPL Telegram, `node --check lunarreturns.js` и `git diff --check` прошли. Приём ZIP живым VK ещё не проверен.
- Пользователь подтвердил живую отправку обоих вариантов: `.html.zip` с Deflate и `.html.gz`. Оба заменены одним `.epub` по отдельному плану `20261120-epub-viewer-attachments.md`, а не из-за отказа загрузки.
