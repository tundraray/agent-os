# Граница аутентификации API

## Problem

Каждый маршрут API должен знать, чей это запрос, и отдавать сотруднику только его данные, а маршрут, о котором забыли, не должен открыться никому. Признак: новый контроллер в `apps/api` или новый обработчик, который читает или пишет данные сотрудника.

## Shape

- **Глобальная проверка сеанса** `SessionGuard` стоит на всём API. Она находит сеанс по cookie, проверяет срок и статус сотрудника и кладёт в `req.user` сотрудника: `id`, `email`, `name`, `isAdmin`, `sessionId`. Без сеанса ответ — 401 `AUTH_REQUIRED`. Изменяющий запрос с cookie проходит, только когда его `Origin` равен `FRONTEND_ORIGIN`.
- **Пометка `@Public()`** снимает проверку сеанса с маршрута. Такой маршрут защищает себя сам, как вход — одноразовым запросом входа. Маршрут без пометки закрыт.
- **Пометка `@AdminOnly()`** пускает только сотрудника с `isAdmin`; иначе 403 `ADMIN_REQUIRED` и запись аудита `access_denied`.
- **Обработчик** берёт владельца в первой строке (`const ownerId = req.user.id`) и передаёт строку вниз. Владельца из тела, параметров или заголовков он не берёт.
- **Поиск по владельцу**: сервис или пакет ищет объект по id вместе с владельцем, и чужой объект отвечает так же, как отсутствующий (`*_NOT_FOUND`, одно тело на оба случая).
- **Поиск по видимости** — для объектов, которыми делятся: вместо владельца стоит одно условие видимости в репозитории, и через него идёт каждое чтение. Невидимый объект отвечает так же, как отсутствующий; видимый, но чужой для правки — отдельным отказом. Пример — агенты каталога (условие `visibleTo` в `packages/db/src/repositories/agents.repository.ts`, [design-library.md](../../features/custom-agents/design-library.md), KD-2). Исключение — неизменная версия агента по id из входа задачи: видимость проверил старт ([immutable-versions.md](./immutable-versions.md)).
- Пакеты ниже `apps/api` о сеансе не знают: они получают строку владельца параметром.

Контракт — [design-identity.md](../../features/enterprise-access/design-identity.md#contract-definitions).

## Reference

- `apps/api/src/identity/session.guard.ts` — глобальная проверка и пометки
- `apps/api/src/chat/threads.controller.ts` — владелец в первой строке обработчика, поиск «чужое = нет»

## Not For

| Looks like | Use instead |
|---|---|
| вызов от другой системы с токеном (вебхук) | открытый маршрут `@Public()` со своей проверкой токена |
| право на MCP-инструмент или модель | одна проверка прав части `access`, а не пометка маршрута |
| работа агента в фоне без запроса | владелец из задачи runtime и порт `AccessGate`, а не `req.user` |

## Used In

- [design-identity.md](../../features/enterprise-access/design-identity.md) — KD-3, `SessionGuard`, `@Public()`, `@AdminOnly()`
- [design-chat.md](../../features/agent-platform/design-chat.md) — владелец в обработчиках бесед и агентов
- [design-mcp-connect.md](../../features/enterprise-access/design-mcp-connect.md) — подключение аккаунта и возврат из OAuth под сеансом без `@Public()`; реестр под `@AdminOnly()` (KD-6)
- [design-library.md](../../features/custom-agents/design-library.md) — поиск по видимости, `RECORD_READ_ONLY`, маршруты панели под `@AdminOnly()` (KD-2)
- [design-agents.md](../../features/data-model/design-agents.md) — видимость с агентами по умолчанию и без удалённых; поиск по имени от имени владельца, невидимое имя отвечает как несуществующее (KD-5, KD-7)
- [design-notepad.md](../../features/self-learning/design-notepad.md) — документы под маршрутами беседы с проверкой её владельца; чужая беседа отвечает как несуществующая (KD-7)
- [design-schedules.md](../../features/schedules-search-memory/design-schedules.md) — владелец расписания из `req.user`, чужое расписание отвечает 404 `SCHEDULE_NOT_FOUND`; беседа и агент тела проверяются от имени владельца
- [design-conversation-search.md](../../features/schedules-search-memory/design-conversation-search.md) — сотрудник поиска только из сеанса; чужое и удалённое отбрасывает сам запрос, курсор несёт только позицию (KD-4)
- [design-memory-hygiene.md](../../features/schedules-search-memory/design-memory-hygiene.md) — история, возврат и стирание записи проверяют право удаления: `LibraryService.memoryTarget` или сотрудник сеанса (KD-7)
