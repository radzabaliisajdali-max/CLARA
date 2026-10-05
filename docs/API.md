# API CLARA V5

Префикс `/api/v1`, JSON UTF-8. UUID — идентификаторы. GTIN и деньги — строки, количества — целые. Даты ISO UTC; интерфейс показывает Москву. Номера документов — строки bigint.

## Авторизация и запросы

- `POST /auth/login` с `{login,password}` → `{user:{id,login,name,role},csrf}` и HttpOnly/SameSite=Strict cookie clara_session на 12 часов. 10 попыток/минуту/IP.
- `GET /auth/me` → user и csrf. `POST /auth/logout` отзывает сессию.
- Все изменения требуют `Origin`, равный APP_ORIGIN; кроме login также `X-CSRF-Token`. CORS закрыт.
- Изменения справочников, склада, импорта и пользователей требуют `Idempotency-Key` (16–100 букв/цифр/`_`/`-`; рекомендуется UUID). Повторять запрос после сетевой ошибки с прежними телом и ключом. Ключи изолированы по пользователю и не удаляются автоматически. Повтор возвращает прежний результат; другое тело/маршрут с прежним ключом → 409.
- Ошибки `{message}`: 400 поля, 401 вход, 403 права/CSRF, 404 запись, 409 конфликт/остаток, 429 частые попытки, 500 ошибка сервера. Успех 200.

## Товары

| Маршрут | Тело / результат |
|---|---|
| GET /products | Модели с числом вариантов |
| POST /products, PATCH /products/:id | `{article,name,material?}` |
| GET /variants | Варианты с моделью, себестоимостью и остатками |
| POST /products/:id/variants, PATCH /variants/:id | `{color,size,gtin,cost?:string\|null}` |
| GET /gtin/:gtin | Один вариант или 404 |

Уникальны артикул, GTIN, сочетание модель/цвет/размер. После движений цвет/размер/GTIN неизменяемы; себестоимость менять можно. Неизвестная себестоимость null, явно заданный ноль "0". Формат GTIN: 8, 12, 13 или 14 цифр; проверка ЧЗ отдельная.

## Склад

`GET /stock`: physical, reserved, available = physical − reserved, transit, wb, defect. `GET /movements`: документы с вариантами, автором, причиной и изменениями всех мест учёта. Пока списки полные; для больших объёмов потребуется пагинация.

`POST /receipts`, `/reservations`, `/releases`, `/adjustments`:

```json
{"lines":[{"variantId":"UUID","quantity":20}],"reference":"Начальная сверка","reason":"Инвентаризация","bucket":"physical","direction":"in"}
```

1–500 уникальных вариантов, quantity 1–1000000. Причина корректировки минимум 3 символа; reference необязателен. Только корректировка допускает bucket physical/transit/wb/defect и direction in/out. Для остальных операций оставлять physical/in по умолчанию. Приёмка увеличивает physical, резерв/снятие меняют reserved.

Ответ: документ `{id,number,kind,reason,reference,reverses_id,user_id,source,created_at}`.

- `POST /documents/:id/reverse` с `{reason}`: владелец, создаёт компенсацию. Повторная отмена другим ключом запрещена; компенсацию отменять нельзя.
- `GET /stock/reconciliation`: владелец, расхождения с историей, пустой массив — совпадение.
- `POST /stock/rebuild` с `{reason}`: владелец, восстанавливает агрегаты из движений под блокировкой, возвращает `{rebuilt}`, записывает аудит.
- Остатки блокируются в порядке variant_id. Проверяется неотрицательность и reserved ≤ physical. Документ, движения, остаток, аудит и результат идемпотентности фиксируются одной транзакцией.

## Пользователи, аудит, импорт

Только владелец:

- `GET /users`; `POST /users` с `{login,name,role,password}`. role owner/operator, пароль минимум 12 символов, хеш scrypt.
- `PATCH /users/:id` с `{active?,role?,password?}` отзывает сессии. Самоотключение/понижение владельца запрещено.
- `GET /audit`: последние 1000 записей before/after, автор, причина, источник. Полная история в БД и копии.
- `GET /import/legacy/preview`: строки `{index,article,name,material,status,note}`, status ready/exists/duplicate/invalid.
- `POST /import/legacy` с `{indices:[0,2]}`: только выбранные готовые модели, одной транзакцией. Варианты/остатки не импортируются.

Оператор читает товары/остатки/движения, редактирует товары, принимает товар, создаёт/снимает резерв, выгружает Excel. Корректировки, отмены, импорт, восстановление и пользователи доступны владельцу.

`GET /exports/products`, `/exports/stock`, `/exports/movements` возвращают настоящий XLSX. GTIN и денежные строки сохраняют точность; текст не становится формулами.

`GET /health` вне API доступен без входа и проверяет связь с БД.

## Производство

Все POST требуют стандартные cookie, CSRF и Idempotency-Key. Оператор может создавать производственные записи; отменять их может владелец.

- `GET/POST /production/plans`: `{variantId,quantity,dueDate,comment?}`. Дата `YYYY-MM-DD`, количества целые 1–1000000.
- `GET/POST /production/cuts`: `{planId,quantity,cutDate,fabricKg,responsible,reason?,comment?}`. fabricKg — положительная десятичная строка с точностью до 3 знаков. Причина нужна при суммарном превышении плана. GET включает `fabric_per_unit` и остатки по этапам.
- `GET/POST /production/workers`: `{name}`.
- `GET/POST /production/events`: `{cutId,fromStage,toStage,quantity,workerId?,operationDate,reason?}`. Переходы: cut→sewing, sewing→qc, qc→packing, qc→defect, packing→ready. workerId обязателен только для выдачи и сдачи пошива. Для брака обязательна причина.
- `POST /production/events/:id/reverse`: `{reason}`, только владелец. Проверяет остаток на этапе назначения. Компенсация не изменяет исходную запись. Связанные складские документы имеют kind=production и отменяются только этим маршрутом.
- `GET /exports/production`: XLSX партий кроя, расхода ткани и количеств по этапам.

Крои блокируются перед расчётом перехода; планы — перед проверкой суммарного кроя. Календарные даты не преобразуются в UTC timestamps. Время создания сохраняется отдельно. Идентичность варианта фиксируется с первого производственного плана.
