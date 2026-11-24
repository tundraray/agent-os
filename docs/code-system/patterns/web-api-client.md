# Клиент API веба

## Problem

Код веба зовёт API: читает список, сохраняет форму, удаляет запись. Признак: любое место в `apps/web`, которому нужен ответ сервера. Если каждый такой кусок пишет свой `fetch`, обход обработчика 401, потеря кода ошибки и неразобранные ответы появляются по одному на модуль.

## Shape

- **Ядро запроса `apiRequest`** в `lib/api` — единственное место, где веб вызывает `fetch` к API. Оно зовёт путь `/api/...` без адреса, то есть на адресе самого веба, а сервер Next пересылает такие запросы в API ([design-web-image.md](../../features/web-image/design-web-image.md), KD-1, KD-2). Ядро шлёт cookie сеанса, методы `GET`, `POST`, `PUT`, `PATCH`, `DELETE` и тело JSON, разбирает ответ zod-схемой, которую передал вызывающий, и бросает `ApiRequestError`. Поток событий `lib/live` и переходы вкладки тоже берут путь без адреса.
- **`ApiRequestError`** — вид (`not_found`, `http`, `invalid_response`, `network`), статус, `code` из `errorCode` тела, `reason` и `message` тела. Тело ошибки разбирается `ApiErrorSchema` из `@agent-os/contracts`.
- **Общие обработчики** в ядре: ответ 401 — переход на вход ([design-identity.md](../../features/enterprise-access/design-identity.md), C3 · web); ответ 403 `ADMIN_REQUIRED` — сброс `isAdmin` в значении `CurrentUser`. Вызывающий их не повторяет.
- **Модули области** — наборы функций поверх ядра: `threadsApiClient` в `lib/threads`, `lib/mcp`, `lib/access`, `adminApi` в `lib/admin`. Функция — одна операция API: путь, метод, вход и схема ответа из `@agent-os/contracts`. Сегменты пути из данных (имя, id с `/`) кодируются `encodeURIComponent`.
- **Не запрос к API** — байты картинки, которые `components/image.tsx` копирует в буфер обмена, он читает обычным `fetch` по адресу картинки, без ядра.
- **Переход вместо запроса** — операция, которая отвечает 302 к чужому серверу (подключение аккаунта OAuth), не вызывается `fetch`: модуль отдаёт адрес, и вкладка уходит на него.
- **Лог** пишет то место, где ошибка окончательно обработана, через `src/lib/logger.ts` и `describeApiError`: метод, путь, статус, код, причина. Тела запросов и ответов в лог не попадают ([logging.md](./logging.md)).

## Reference

- `apps/web/src/lib/api/api-request.ts` — ядро; `apps/web/src/lib/threads/threads-api-client.ts` — модуль области

## Not For

| Looks like | Use instead |
|---|---|
| живые обновления: статусы агентов, лента | поток событий `GET /api/events` и хранилище `lib/live` |
| запрос из сервера Next | его нет: сервер Next только пересылает `/api` из браузера в API и сам данных у API не запрашивает; данные читает браузер |
| текст ошибки для человека | функция области, которая переводит `code` и `reason` в текст UXRD, например `describeAdminError` |

## Used In

- [design-admin.md](../../features/enterprise-access/design-admin.md) — KD-3: ядро `apiRequest`, `adminApi`
- [design-web.md](../../features/custom-agents/design-web.md) — `libraryApi`, `adminApi.library`, `describeLibraryError`
- [design-web-image.md](../../features/web-image/design-web-image.md) — KD-2: путь `/api` без адреса, пересылка сервером Next
- [design-web.md](../../features/i18n/design-web.md) — функции областей берут текст отказа из каталога по коду и причине ([Отказы сервера](../../features/i18n/design-web.md#отказы-сервера))