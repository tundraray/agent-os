# Code System

## Source

| Source | Link | Covers |
|---|---|---|
| Выведено из кода | `packages/runtime`, `packages/db`, `packages/contracts`, `apps/api`, `apps/web`, прочитаны 2026-11-14 | функция сборки пакета, репозиторий над транзакцией, outbox, правила пакетов |
| Решения владельца | [agent-platform/prd.md](../features/agent-platform/prd.md), Constraints; [CLAUDE.md](../../CLAUDE.md), Code rules и Logging | слои `runtime ← agents ← workflows ← приложения`, общий пакет `common`, логирование |
| Определено здесь | [design-runtime.md](../features/agent-platform/design-runtime.md), [design-code-execution.md](../features/code-execution/design-code-execution.md), [design-identity.md](../features/enterprise-access/design-identity.md), [design-mcp-connect.md](../features/enterprise-access/design-mcp-connect.md), [design-access.md](../features/enterprise-access/design-access.md), [design-admin.md](../features/enterprise-access/design-admin.md), [design-library.md](../features/custom-agents/design-library.md), [design-runtime.md](../features/custom-agents/design-runtime.md), [design-web.md](../features/custom-agents/design-web.md), [design-feedback.md](../features/self-correction/design-feedback.md) | строка настроек и случаи оценок в модуле `feedback`; снимок записи на запуск; сторы оболочки веба; шаг задачи как единица durable-работы; слой исполнителя кода; граница аутентификации API; реестр MCP-серверов и аккаунты сотрудников в пакете `agents`; права, квоты и каталог моделей в `apps/api` за портом `AccessGate`; чистая функция решения; экраны в оболочке веба, общий клиент API веба и чтение данных при открытии экрана |
| [ADR-0001](../adr/ADR-0001-durable-runtime-owner.md), [ADR-0003](../adr/ADR-0003-drizzle-data-layer.md), [ADR-0004](../adr/ADR-0004-agent-framework-packages.md) | `docs/adr/` | владелец состояния задач, схема `app` и миграции, правила приватных пакетов |

## Style

Самый простой код, который делает работу, и одно место для каждой логики и каждого значения. Пакет — граница владения: он владеет своими таблицами и своей логикой и отдаёт их только через свою функцию сборки. Состояние живёт в Postgres, а не в памяти процесса, поэтому любой экземпляр сервера продолжает любую работу. Новая абстракция, опция или слой появляются, когда есть второе реальное использование. Прежде чем писать новое, ищем, что уже есть, и расширяем это.

## Layer Map

Таблица перечисляет слои сверху вниз.

| Layer | Holds | Lives in | May depend on |
|---|---|---|---|
| Приложения | HTTP, аутентификация, чтение окружения, сборка пакетов в модули Nest; экраны | `apps/api`, `apps/web` | любой пакет ниже; `apps/web` — только `contracts` и `common` |
| Workflows | запуск записи workflow (`start_workflow`), бриф, вид запуска | `packages/workflows` | agents и всё ниже |
| Agents | агент, его сессия, инструменты, обёртка вызова модели над Mastra; реестр MCP-серверов, аккаунты сотрудников и вызов MCP по HTTP | `packages/agents` | runtime, code-runner и всё ниже |
| Исполнитель кода | процесс на один скрипт с QuickJS внутри, мост с процессом API, пределы и убийство процесса; ничего не знает об агентах, таблиц нет | `packages/code-runner` | common |
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
| `common` | логгер | `createLogger`, приёмники и `createSecretMasker` — маскировка секретов логгера для текста вне лога | все |
| `identity` в `apps/api` | таблицы `identity_*`: сотрудники и их пароли, роли, провайдеры входа, запросы входа, сеансы, настройки входа; таблица `audit_events` модуля аудита | `SessionGuard` и `req.user` ([auth-boundary.md](./patterns/auth-boundary.md)), `IdentityDirectory` (`isActive`, `rolesOf`, `existing` — какие из названных ролей и сотрудников есть), `AuditLog`; репозитории `identity` вне модуля никто не импортирует | модули `apps/api`; пакеты получают только строку владельца ([design-identity.md](../features/enterprise-access/design-identity.md)) |
| `access` в `apps/api` | таблицы `access_*`: каталог моделей с ценами, права и запреты ролей и сотрудников с квотами | реализация порта `AccessGate` и хука `audit` для `createAgents`; операции администратора и `GET /api/access/models` | пакеты получают только порт: он отвечает, включён ли сотрудник, разрешён ли инструмент и вызов модели, с ценой и квотой; ни один пакет не читает таблицы `access_*` ([design-access.md](../features/enterprise-access/design-access.md), KD-1) |
| MCP в `agents` | таблицы `agent_mcp_*`: серверы реестра с их инструментами, личные учётные данные сотрудников (сотрудник, сервер, токен, тип токена) | операции `Agents.mcp`; пишущая операция возвращает «было» и «стало», и `apps/api` пишет по ним аудит после неё | `apps/api` (контроллеры реестра, подключения и возврата из OAuth); адрес возврата OAuth `apps/api` передаёт в операции подключения параметром; токен не выходит из пакета, кроме как в заголовке запроса к серверу ([design-mcp-connect.md](../features/enterprise-access/design-mcp-connect.md), KD-1) |
| `code-runner` | процесс исполнителя кода и его вход; процесс запускается только с флагами модели разрешений Node и читает только собранный вход пакета и QuickJS из каталогов, где ни одна ссылка не ведёт наружу | функция сборки `createCodeRunner` и операция `CodeRunner.run` | только `agents`; правила вызовов держит вызывающий, а не пакет ([design-code-execution.md](../features/code-execution/design-code-execution.md), KD-1, KD-2; [ADR-0011](../adr/ADR-0011-code-runner-quickjs-process.md)) |
| `library` в `apps/api` | таблицы `library_*`: записи библиотеки любого вида и адресаты их аудитории | маршруты `/api/library` и `/api/admin/library`; операции `LibraryService` для запуска записей и `saveOwn` для черновиков чата | пакеты получают записи только через порт, который реализует `LibraryService`; чтения маршрутов сотрудника и операций для запуска идут через одно условие видимости, маршруты панели — через условие панели, которое не находит личных записей ([design-library.md](../features/custom-agents/design-library.md), KD-1, KD-2) |
| `feedback` в `apps/api` | таблицы `feedback_*`: случаи — копии оценённых ответов чата с работой агентов над ними — и записи библиотеки, под которыми случай значится | маршруты `/api/threads/:threadId/turns/:turnSeq/rating` (через модуль чата) и `/api/admin/feedback`; операции `FeedbackService` для частей `eval` и `loop` | модуль чата и маршруты панели; случай не ссылается внешним ключом ни на беседу, ни на `runtime_*`, `agent_*`, `library_*` и переживает их удаление, а данные агентов получает только операциями `agents` и `runtime` ([design-feedback.md](../features/self-correction/design-feedback.md), KD-1, KD-4) |
| клиент API в `apps/web` | связь браузера с API: адрес, cookie, разбор ответов схемами `contracts`, обработчики 401 и 403 `ADMIN_REQUIRED` | ядро `apiRequest` в `lib/api` и модули областей (`lib/threads`, `lib/mcp`, `lib/access`, `lib/admin`, `lib/library`) ([web-api-client.md](./patterns/web-api-client.md)) | компоненты и хуки веба; ни один компонент не вызывает `fetch` к API сам |

Пакет пишет и читает только таблицы со своим префиксом. Данные другого пакета он получает через операции этого пакета. Транзакция пересекает границу только в одну сторону: runtime открывает транзакцию шага и даёт её обработчику верхнего слоя для его собственных записей. Между модулями `apps/api` транзакция переходит только из модуля чата, под замком его строки — черновика или беседы. Модуль чата передаёт её в `LibraryService.saveOwn`, и запись с её аудитом пишется в точке сохранения внутри неё: так черновик сохраняется не больше одного раза и не остаётся ждать рядом с уже сохранённой записью ([design-library.md](../features/custom-agents/design-library.md), KD-8). Он же передаёт её в `FeedbackService.rate` и `unrate`: замок строки беседы не даёт удалению беседы прийти посреди копии ответа ([design-feedback.md](../features/self-correction/design-feedback.md), KD-1).

## Index

| Pattern | Problem | Spec |
|---|---|---|
| Функция сборки пакета | как пакет без Nest получает настройки и порты и встраивается в `apps/api` | [patterns/composition-root.md](./patterns/composition-root.md) |
| Репозиторий над транзакцией | как пакет читает и пишет свои таблицы, в том числе внутри чужой транзакции | [patterns/repository-over-transaction.md](./patterns/repository-over-transaction.md) |
| Обработчик шага | как долгая работа переживает рестарт и продолжается на любом экземпляре | [patterns/step-handler.md](./patterns/step-handler.md) |
| Журнал событий с доставкой | как изменение становится видно потребителям и наблюдателям без потерь | [patterns/transactional-outbox.md](./patterns/transactional-outbox.md) |
| Логирование через `common` | как любой код пишет лог в консоль и Sentry, не утекая секретами | [patterns/logging.md](./patterns/logging.md) |
| Граница аутентификации API | как маршрут узнаёт сотрудника и не открывается по забывчивости | [patterns/auth-boundary.md](./patterns/auth-boundary.md) |
| Чистая функция решения | где живёт правило, которое по данным решает «можно ли» или «какой статус» | [patterns/pure-decision.md](./patterns/pure-decision.md) |
| Экран в оболочке по адресу | как новый экран веба встаёт в оболочку чата, не перезапуская её | [patterns/shell-route.md](./patterns/shell-route.md) |
| Клиент API веба | как код веба зовёт API и получает разобранный ответ или типизированную ошибку | [patterns/web-api-client.md](./patterns/web-api-client.md) |
| Чтение при открытии | как экран веба читает свои данные, показывает загрузку и ошибку и перечитывает их после изменения | [patterns/read-on-open.md](./patterns/read-on-open.md) |
| Модуль порта и модуль маршрутов | как модуль `apps/api` отдаёт порт `AgentsModule` и при этом зовёт `Agents` из своих маршрутов | [patterns/port-module-split.md](./patterns/port-module-split.md) |
| Снимок запуска | как идущая работа не замечает правки и удаления записи, с которой стартовала | [patterns/run-snapshot.md](./patterns/run-snapshot.md) |
| Стор оболочки | как значение, которое кладёт один экран веба, видят другие экраны оболочки после перехода | [patterns/shell-store.md](./patterns/shell-store.md) |
| Строка настроек | где живёт настройка, которую администратор меняет в панели, и как её смена попадает в аудит | [patterns/settings-row.md](./patterns/settings-row.md) |
