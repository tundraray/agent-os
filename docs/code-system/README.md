# Code System

## Source

| Source | Link | Covers |
|---|---|---|
| Выведено из кода | `packages/runtime`, `packages/db`, `packages/contracts`, `apps/api`, `apps/web`, прочитаны 2026-11-14 | функция сборки пакета, репозиторий над транзакцией, outbox, правила пакетов |
| Решения владельца | [agent-platform/prd.md](../features/agent-platform/prd.md), Constraints; [CLAUDE.md](../../CLAUDE.md), Code rules и Logging | слои `runtime ← agents ← workflows ← приложения`, общий пакет `common`, логирование |
| Определено здесь | [design-runtime.md](../features/agent-platform/design-runtime.md), [design-code-execution.md](../features/code-execution/design-code-execution.md), [design-identity.md](../features/enterprise-access/design-identity.md), [design-mcp-connect.md](../features/enterprise-access/design-mcp-connect.md), [design-access.md](../features/enterprise-access/design-access.md) | шаг задачи как единица durable-работы; слой исполнителя кода; граница аутентификации API и запечатанные секреты; реестр MCP-серверов и аккаунты сотрудников в пакете `agents`; права, квоты и каталог моделей в `apps/api` за портом `AccessGate`; чистая функция решения |
| [ADR-0001](../adr/ADR-0001-durable-runtime-owner.md), [ADR-0003](../adr/ADR-0003-drizzle-data-layer.md), [ADR-0004](../adr/ADR-0004-agent-framework-packages.md) | `docs/adr/` | владелец состояния задач, схема `app` и миграции, правила приватных пакетов |

## Style

Самый простой код, который делает работу, и одно место для каждой логики и каждого значения. Пакет — граница владения: он владеет своими таблицами и своей логикой и отдаёт их только через свою функцию сборки. Состояние живёт в Postgres, а не в памяти процесса, поэтому любой экземпляр сервера продолжает любую работу. Новая абстракция, опция или слой появляются, когда есть второе реальное использование. Прежде чем писать новое, ищем, что уже есть, и расширяем это.

## Layer Map

Таблица перечисляет слои сверху вниз.

| Layer | Holds | Lives in | May depend on |
|---|---|---|---|
| Приложения | HTTP, аутентификация, чтение окружения, сборка пакетов в модули Nest; экраны | `apps/api`, `apps/web` | любой пакет ниже; `apps/web` — только `contracts` и `common` |
| Workflows | шаблоны, координатор, бриф | `packages/workflows` | agents и всё ниже |
| Agents | агент, его сессия, инструменты, обёртка вызова модели над Mastra; реестр MCP-серверов, аккаунты сотрудников и вызов MCP по HTTP | `packages/agents` | runtime, code-runner и всё ниже |
| Исполнитель кода | процесс на один скрипт с QuickJS внутри, мост с процессом API, пределы и убийство процесса; ничего не знает об агентах, таблиц нет | `packages/code-runner` | common |
| Runtime | задачи и их шаги, очередь сообщений, запросы решений, журнал событий, журнал токенов, восстановление | `packages/runtime` | db, contracts, common |
| Данные | пул `pg`, клиент Drizzle, модель схемы `app`, миграции | `packages/db` | contracts |
| Контракты | zod-схемы данных, пересекающих границу, и наборы значений для CHECK | `packages/contracts` | — |
| Общее | логгер и его приёмники; `SecretBox` для запечатанных секретов | `packages/common` | — |

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
| `common` | логгер; шифрование секретов | `createLogger`, приёмники и `createSecretMasker` — маскировка секретов логгера для текста вне лога; `SecretBox` ([sealed-secret.md](./patterns/sealed-secret.md)) | все |
| `identity` в `apps/api` | таблицы `identity_*`: сотрудники, группы IdP, роли, подключения входа, запросы входа, сеансы; таблица `audit_events` модуля аудита | `SessionGuard` и `req.user` ([auth-boundary.md](./patterns/auth-boundary.md)), `IdentityDirectory`, `AuditLog` | модули `apps/api`; пакеты получают только строку владельца ([design-identity.md](../features/enterprise-access/design-identity.md)) |
| `access` в `apps/api` | таблицы `access_*`: каталог моделей с ценами, права и запреты ролей и сотрудников с квотами, настройки части | реализация порта `AccessGate` и хука `audit` для `createAgents`; операции администратора и `GET /api/access/models` | пакеты получают только порт: он отвечает, включён ли сотрудник, разрешён ли инструмент и вызов модели, с ценой и квотой; ни один пакет не читает таблицы `access_*` ([design-access.md](../features/enterprise-access/design-access.md), KD-1) |
| MCP в `agents` | таблицы `agent_mcp_*`: серверы реестра с их инструментами, запечатанные токены сотрудников, запросы подключения | операции `Agents.mcp`; запись принимает хук `onChange(tx, change)`, через который `apps/api` пишет аудит в той же транзакции | `apps/api` (контроллеры реестра, подключения и возврата из OAuth); `SecretBox` и адрес возврата приходят параметрами `createAgents`; токен не выходит из пакета, кроме как в заголовке запроса к серверу ([design-mcp-connect.md](../features/enterprise-access/design-mcp-connect.md), KD-1) |
| `code-runner` | процесс исполнителя кода и его вход; процесс запускается только с флагами модели разрешений Node и читает только собранный вход пакета и QuickJS из каталогов, где ни одна ссылка не ведёт наружу | функция сборки `createCodeRunner` и операция `CodeRunner.run` | только `agents`; правила вызовов держит вызывающий, а не пакет ([design-code-execution.md](../features/code-execution/design-code-execution.md), KD-1, KD-2; [ADR-0011](../adr/ADR-0011-code-runner-quickjs-process.md)) |

Пакет пишет и читает только таблицы со своим префиксом. Данные другого пакета он получает через операции этого пакета. Транзакция пересекает границу только в одну сторону: runtime открывает транзакцию шага и даёт её обработчику верхнего слоя для его собственных записей.

## Index

| Pattern | Problem | Spec |
|---|---|---|
| Функция сборки пакета | как пакет без Nest получает настройки и порты и встраивается в `apps/api` | [patterns/composition-root.md](./patterns/composition-root.md) |
| Репозиторий над транзакцией | как пакет читает и пишет свои таблицы, в том числе внутри чужой транзакции | [patterns/repository-over-transaction.md](./patterns/repository-over-transaction.md) |
| Обработчик шага | как долгая работа переживает рестарт и продолжается на любом экземпляре | [patterns/step-handler.md](./patterns/step-handler.md) |
| Журнал событий с доставкой | как изменение становится видно потребителям и наблюдателям без потерь | [patterns/transactional-outbox.md](./patterns/transactional-outbox.md) |
| Логирование через `common` | как любой код пишет лог в консоль и Sentry, не утекая секретами | [patterns/logging.md](./patterns/logging.md) |
| Граница аутентификации API | как маршрут узнаёт сотрудника и не открывается по забывчивости | [patterns/auth-boundary.md](./patterns/auth-boundary.md) |
| Запечатанный секрет | как хранить в базе секрет, дающий доступ к чужой системе | [patterns/sealed-secret.md](./patterns/sealed-secret.md) |
| Чистая функция решения | где живёт правило, которое по данным решает «можно ли» или «какой статус» | [patterns/pure-decision.md](./patterns/pure-decision.md) |
