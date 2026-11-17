# Модуль порта и модуль маршрутов

## Problem

Модуль `apps/api` реализует порт, который `AgentsModule` передаёт в функцию сборки пакета, а его маршрутам нужны операции `Agents` — например, реестр MCP-серверов. Один модуль не может и отдавать порт `AgentsModule`, и импортировать его: Nest падает на круговом импорте при старте. Признак: новый модуль нужен `AgentsModule` и сам хочет `AGENTS`.

## Shape

- **Модуль порта** (`AccessModule`, `LibraryModule`) держит сервис, репозиторий и реализацию порта и экспортирует сервис. `AgentsModule` он не импортирует.
- **Модуль маршрутов** (`AccessAdminModule`, `LibraryApiModule`) держит контроллеры и импортирует модуль порта и `AgentsModule`.
- Факты, которые есть только у `Agents` (серверы реестра, доступные сотруднику серверы, модель по умолчанию), контроллер читает сам и передаёт в операцию сервиса входом. Сервис не держит ссылку на `Agents`.
- Тот же вход операции сервиса даёт и пакет, который вызывает её через порт: он читает эти факты в своём пакете.

## Reference

- `apps/api/src/access/access.module.ts` и `apps/api/src/access/access-admin.module.ts`

## Not For

| Looks like | Use instead |
|---|---|
| модулю нужен `AGENTS`, но порт `AgentsModule` он не даёт | обычный импорт `AgentsModule` в один модуль |
| сервису нужен другой сервис `apps/api` без цикла | обычный импорт модуля и внедрение через конструктор |

## Used In

- [design-access.md](../../features/enterprise-access/design-access.md) — `AccessModule` и `AccessAdminModule`
- [design-library.md](../../features/custom-agents/design-library.md) — `LibraryModule` и `LibraryApiModule` (KD-6)
- [design-runtime.md](../../features/custom-agents/design-runtime.md) — порт `RecordLibrary`, который реализует `LibraryService`
