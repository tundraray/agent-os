# Модуль порта и модуль маршрутов

## Problem

Модуль `apps/api` реализует порт, который нужен `AgentsModule`, а его маршрутам нужны сервисы `AgentsModule` — например, реестр MCP-серверов. Один модуль не может и отдавать порт `AgentsModule`, и импортировать его: Nest падает на круговом импорте при старте. Признак: новый модуль нужен `AgentsModule` и сам хочет внедрить его сервисы.

## Shape

- **Модуль порта** (`AccessModule`, `LibraryModule`) держит сервис, который реализует порт, и экспортирует его. `AgentsModule` он не импортирует. `AgentsPortsModule` (`apps/api/src/agents/agents-ports.module.ts`) импортирует модуль порта и привязывает к этому сервису токен порта, а модуль пакета `agents` получает порты из него ([composition-root.md](./composition-root.md)).
- **Модуль маршрутов** (`AccessAdminModule`, `LibraryApiModule`) держит контроллеры и импортирует модуль порта и `AgentsModule`.
- **Факты, которые есть только у пакета `agents`** (серверы реестра, доступные сотруднику серверы, модель по умолчанию), контроллер получает от сервисов `agents` и передаёт в операцию сервиса входом. Сервис модуля порта сервисы `agents` не внедряет.
- Тот же вход операции сервиса даёт и пакет, который вызывает её через порт: он читает эти факты у себя.

## Reference

- `apps/api/src/access/access.module.ts` и `apps/api/src/access/access-admin.module.ts`

## Not For

| Looks like | Use instead |
|---|---|
| модулю нужны сервисы `AgentsModule`, но порта для него модуль не даёт | обычный импорт `AgentsModule` |
| сервису нужен другой сервис `apps/api` без цикла | обычный импорт модуля и внедрение через конструктор |

## Used In

- [design-access.md](../../features/enterprise-access/design-access.md) — `AccessModule` и `AccessAdminModule`
- [design-library.md](../../features/custom-agents/design-library.md) — `LibraryModule` и `LibraryApiModule` (KD-6)
- [design-runtime.md](../../features/custom-agents/design-runtime.md) — порт `RecordLibrary`, который реализует `LibraryService`
