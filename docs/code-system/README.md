# Code System

## Source

| Source | Link | Covers |
|---|---|---|
| Выведено из кода | `packages/runtime`, `packages/db`, `packages/contracts`, `apps/api`, `apps/web`, прочитаны 2026-11-14 | функция сборки пакета, репозиторий над транзакцией, outbox, правила пакетов |
| Решения владельца | [agent-platform/prd.md](../features/agent-platform/prd.md), Constraints; [CLAUDE.md](../../CLAUDE.md), Code rules и Logging | слои `runtime ← agents ← workflows ← приложения`, общий пакет `common`, логирование |
| Определено здесь | [design-runtime.md](../features/agent-platform/design-runtime.md) | шаг задачи как единица durable-работы |
| [ADR-0001](../adr/ADR-0001-durable-runtime-owner.md), [ADR-0003](../adr/ADR-0003-drizzle-data-layer.md), [ADR-0004](../adr/ADR-0004-agent-framework-packages.md) | `docs/adr/` | владелец состояния задач, схема `app` и миграции, правила приватных пакетов |

## Style

Самый простой код, который делает работу, и одно место для каждой логики и каждого значения. Пакет — граница владения: он владеет своими таблицами и своей логикой и отдаёт их только через свою функцию сборки. Состояние живёт в Postgres, а не в памяти процесса, поэтому любой экземпляр сервера продолжает любую работу. Новая абстракция, опция или слой появляются, когда есть второе реальное использование. Прежде чем писать новое, ищем, что уже есть, и расширяем это.

## Layer Map

Таблица перечисляет слои сверху вниз.

| Layer | Holds | Lives in | May depend on |
|---|---|---|---|
| Приложения | HTTP, аутентификация, чтение окружения, сборка пакетов в модули Nest; экраны | `apps/api`, `apps/web` | любой пакет ниже; `apps/web` — только `contracts` и `common` |
| Workflows | шаблоны, координатор, бриф | `packages/workflows` | agents и всё ниже |
| Agents | агент, его сессия, инструменты, обёртка вызова модели над Mastra | `packages/agents` | runtime и всё ниже |
| Runtime | задачи и их шаги, очередь сообщений, запросы решений, журнал событий, журнал токенов, восстановление | `packages/runtime` | db, contracts, common |
| Данные | пул `pg`, клиент Drizzle, модель схемы `app`, миграции | `packages/db` | contracts |
| Контракты | zod-схемы данных, пересекающих границу, и наборы значений для CHECK | `packages/contracts` | — |
| Общее | логгер и его приёмники | `packages/common` | — |

- **Dependency rule**: зависимость идёт только вниз и объявлена в `package.json`. Нижний слой никогда не импортирует верхний; цикл отвергает turbo, необъявленный импорт отмечает knip.
- **`common`** не зависит ни от одного пакета workspace и ни от одного SDK. Его используют все пакеты и оба приложения.
- **Mastra** объявляет только `agents`; `apps/api` его не импортирует. Пакеты `db`, `runtime`, `common` запрещают импорт `@mastra/*` в lint.
- Остальные правила пакетов — один вход `.`, закрытые подпути, отсутствие `@nestjs/*` в пакетах, настройки параметрами — действуют по [ADR-0004](../adr/ADR-0004-agent-framework-packages.md), Implementation Guidance.

## Module Boundaries

| Boundary | Owns | Exposed through | Crossed by |
|---|---|---|---|
| `runtime` | таблицы `runtime_*`: задачи, сообщения, запросы решений, события, журнал токенов | функция сборки `createRuntime` и порт обработчика шага | верхние пакеты и `apps/api`; чужой код не читает и не пишет таблицы `runtime_*` |
| `agents`, `workflows` | свои таблицы со своим префиксом | своя функция сборки | слой выше и `apps/api` |
| `db` | модель схемы `app` всех пакетов и историю миграций | пул, клиент, тип транзакции, функции миграций | все пакеты с таблицами |
| `common` | логгер | `createLogger` и приёмники | все |

Пакет пишет и читает только таблицы со своим префиксом. Данные другого пакета он получает через операции этого пакета. Транзакция пересекает границу только в одну сторону: runtime открывает транзакцию шага и даёт её обработчику верхнего слоя для его собственных записей.

## Index

| Pattern | Problem | Spec |
|---|---|---|
| Функция сборки пакета | как пакет без Nest получает настройки и порты и встраивается в `apps/api` | [patterns/composition-root.md](./patterns/composition-root.md) |
| Репозиторий над транзакцией | как пакет читает и пишет свои таблицы, в том числе внутри чужой транзакции | [patterns/repository-over-transaction.md](./patterns/repository-over-transaction.md) |
| Обработчик шага | как долгая работа переживает рестарт и продолжается на любом экземпляре | [patterns/step-handler.md](./patterns/step-handler.md) |
| Журнал событий с доставкой | как изменение становится видно потребителям и наблюдателям без потерь | [patterns/transactional-outbox.md](./patterns/transactional-outbox.md) |
| Логирование через `common` | как любой код пишет лог в консоль и Sentry, не утекая секретами | [patterns/logging.md](./patterns/logging.md) |
