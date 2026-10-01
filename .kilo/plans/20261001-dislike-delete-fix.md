# Фикс: реакция 👎 не удаляет событие («undefined undefined»)

## Диагноз

При реакции 👎 выводится «🗑 Событие удалено: undefined undefined», запись не удаляется.

Причина — не однострочный формат вывода (регекс `^(.+?)\s+(\d{4}-\d{2}-\d{2})` в `findRecordByCmid` корректно разбирает заголовок «Имя ГГГГ-ММ-ДД ЧЧ:ММ возраст свадьба» благодаря ленивому `.+?`).

Реальная причина: `findRecordByCmid` (lunarreturns.js:1055) — `async`-функция, но в обработчике 👎 (lunarreturns.js:1024) она вызывается **без `await`**:

```js
const rec = findRecordByCmid(peerId, cmid);   // Promise, а не запись
if (!rec) return;                             // Promise всегда truthy — не срабатывает
db.records = db.records.filter(r => r !== rec); // ничего не удаляет
await messagesSend(peerId, "🗑 Событие удалено: " + rec.n + " " + rec.d, ...); // undefined undefined
```

Ветка 👀 (lunarreturns.js:1038) уже вызывает с `await`, поэтому «детально» работает.

## Изменение

В `handleReaction` (ветка `o.reaction_id === 9`, lunarreturns.js:1024):

```js
const rec = await findRecordByCmid(peerId, cmid);
```

Одна строка — добавить `await`.

## Проверка

1. `node --check lunarreturns.js`
2. `node lunarreturns.js test "Свадьба 2001-06-05 12:30"` — убедиться, что вывод не затронут.
3. Вживую (нужен токен): отправить триггер, поставить 👎 на ответ бота — в логе `reaction 👎: удалено событие <Имя> <дата>`, в чат уходит «🗑 Событие удалено: Имя ГГГГ-ММ-ДД», запись исчезает из db.json; повторная 👎 после удаления — молча (запись не найдена).
