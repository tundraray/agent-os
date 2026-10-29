# Task T3.3: `POST /api/threads`, `DELETE /api/threads/:threadId` + e2e

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 3, T3.3)
- Dependencies: T3.1 → Deliverable: `ThreadsService.list`, `GET /api/threads`, курсор (`thread-cursor.ts`)
- Provides: `ThreadsService.create/delete`, маршруты `POST`/`DELETE` — для T3.4 (rename-тесты опираются на создание/удаление)
- Size: Small (3 файла)
- Covers: Element 1; AC-16.1 (часть threads), AC-16.2, AC-16.3

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
`create` — `createThread({ resourceId, threadId: crypto.randomUUID() })`, ответ 201 `ThreadSummary` (`title: null`), тело запроса игнорируется (id клиента не используется); `delete` — `getOwnedThread` → `deleteThread`, `@HttpCode(204)` без тела; каскадное удаление сообщений в одной транзакции PG.

## Target Files
- [x] `apps/api/src/threads/threads.service.ts`
- [x] `apps/api/src/threads/threads.controller.ts`
- [x] `apps/api/test/threads.e2e-spec.ts`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Data Contract create/delete, § Contract Definitions, § Integration Point 1, § Error Handling)
- `apps/api/test/threads.e2e-spec.ts` (скелет: create, `AC-16.1/AC-16.3`, `AC-16.2`)
- `apps/api/test/support/db.ts` (`countMessages`), `apps/api/test/support/seed.ts`
- `apps/api/src/threads/threads.service.ts`, `threads.controller.ts` (T2.2, T3.1)

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Integration Points, Integration Point 1) | state-lifecycle-negative | «`SELECT count(*) FROM mastra_messages WHERE thread_id = $1` через клиент `pg` (прямая зависимость `apps/api`) на `DATABASE_URL` возвращает литерал `0`» | Y, если после `DELETE` e2e через `countMessages` получает `0` |
| design-threads-api.md (§ Code Inspection Evidence, находка 7) | structure-order | `{"message":"Thread not found","error":"Not Found","statusCode":404,"errorCode":"THREAD_NOT_FOUND"}` | Y, если повторный `DELETE` и `DELETE` чужой беседы дают точно этот 404 |
| design-threads-api.md (§ Contract Definitions) | structure-order | `POST /api/threads` → «201 `ThreadSummary`»; `DELETE /api/threads/:threadId` → «204 без тела» | Y, если статусы 201 и 204 (пустое тело) подтверждены в e2e |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| id новой беседы | генерирует сервер (`crypto.randomUUID()`); поле `id` в теле игнорируется | work plan T3.3, Failure Mode «no-op» |
| Повторный `DELETE` | 404 `THREAD_NOT_FOUND`, без изменений | work plan T3.3 |

## Investigation Notes
**Наблюдения (Investigation Targets)**
- DD § ThreadsService: `create(userId): Promise<ThreadSummary>`, `delete(threadId, userId): Promise<void>`; § ThreadsController: `create` (201), `remove` (`@HttpCode(204)`); § Data Contract delete: «беседа и её сообщения удалены одной транзакцией (PostgresStore.deleteThread)», 404 для нет/чужая/уже удалена.
- DD находка 5: `deleteThread` дважды — без ошибки, поэтому 404 повторного удаления даёт только `getOwnedThread`; `createThread` без `title` сохраняет `''` → `toThreadSummary` отдаёт `title: null`.
- `Memory.createThread({ resourceId, threadId?, title?, ... }): Promise<StorageThreadType>` (`@mastra/core` 1.80.0 `memory.d.ts`); `deleteThread(threadId): Promise<void>` — без `resourceId`, проверка владельца на вызывающем.
- `test/support/db.ts` — `countMessages(threadId)` через `pg`; `seed.ts` — id `${prefix}-t-nnn`, поэтому литералы скелета `'old-1'`/`'keep-1'` заменены на id из `seedThread` (как в T3.1).
- Похожих функций создания/удаления бесед в `apps/api/src` нет (только `cleanupUsers` в тестовой обвязке) — дублирования нет. `ThreadWriteLock` в delete контрактом DD не требуется (lock — для записи заголовка, T3.4).

**План подхода**
- `create`: `memory.createThread({ resourceId: userId, threadId: randomUUID() })` → `toThreadSummary`; контроллер `@Post()` без `@Body` — тело не читается.
- `delete`: `getOwnedThread(threadId, userId)` → `memory.deleteThread(threadId)`; контроллер `@Delete(':threadId') @HttpCode(204)` с `ZodValidationPipe(ThreadIdSchema)`.

**Compliance Checks (по финальной реализации)**
- Integration Point 1 (`count = 0`): **Y** — e2e AC-16.1/AC-16.3: `countMessages(threadId)` = `2` до и `0` после `DELETE`.
- Тело 404 (находка 7): **Y** — повторный `DELETE` (AC-16.3) и `DELETE` чужой / отсутствующей (AC-16.2) сравниваются `toEqual(NOT_FOUND_BODY)`, тела чужой и отсутствующей идентичны.
- 201 / 204 без тела: **Y** — e2e: `POST` → `201` + `ThreadSummarySchema`; `DELETE` → `204`, `res.text === ''`.

**Ход TDD**: реализация и e2e написаны в одном шаге; способность тестов падать подтверждена мутациями (файл затем восстановлен): `threadId` = клиентское значение → падает create-тест (UUID-regex); `delete` без `getOwnedThread` → падают AC-16.1/16.3 (повторный `DELETE` 204 вместо 404) и AC-16.2 (204 вместо 404). Гейты: lint 0, tsc 0, prettier — файлы задачи чистые (7 предсуществующих файлов вне задачи — `audit.module.ts`, `audit.service.ts`, `session.guard.ts`, `assistant.agent.ts`, `mastra.lifecycle.ts`, `models.spec.ts`, `models.ts` — не тронуты), unit 78/78, e2e 16 passed + 13 todo, build OK.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать все Investigation Targets, записать наблюдения в Investigation Notes
- [x] Просмотреть deliverables зависимостей (см. Metadata)
- [x] Сверить контракты (Reference Contracts) с Design Doc, записать план подхода в Investigation Notes
- [x] Написать падающие тесты (unit — test-first; e2e — наполнить `it.todo` скелета по его комментариям Arrange/Act/Assert, ожидаемые значения — литералы, пустые заглушки запрещены)
- [x] Запустить тесты и убедиться, что они падают по правильной причине (см. Proof Obligations)

### 2. Green Phase
- [x] Добавить минимальную реализацию
- [x] Запустить только добавленные тесты, убедиться, что они проходят

### 3. Refactor Phase
- [x] Улучшить код, не меняя поведения
- [x] Повторно запустить добавленные тесты

### 4. Gates (все — ноль ошибок; перед vitest после правки `packages/contracts` — `pnpm --filter @agent-os/contracts build`; перед e2e — `pnpm db:up` и `apps/api/.env` с `DATABASE_URL`)
- [x] `pnpm --filter api lint`
- [x] `pnpm --filter api exec tsc --noEmit -p tsconfig.json`
- [x] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`
- [x] `pnpm --filter api test`
- [x] `pnpm --filter api test:e2e` (если задача затрагивает e2e или HTTP-поверхность)
- [x] `pnpm --filter api build`

## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов, типовые ошибки — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext`, `.js`-суффиксы импортов — Enforces: строгие типы, без `as`-обхода — Config/Source: `apps/api/tsconfig.json`, `packages/contracts/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest unit / e2e (реальный Postgres) — Enforces: поведение и AC — Config/Source: `apps/api/vitest.config.ts`, `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- `nest build` — Enforces: сборка production-кода — Config/Source: `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json` — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`
- Одна точка проверки владельца (`getOwnedThread`) до `deleteThread` — Enforces: нет IDOR — Config/Source: DD «Security Considerations» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: e2e на реальном Postgres с двумя `x-user-id` и прямым `SELECT count(*)` через клиент `pg`.
- **Success criteria**: 3 e2e зелёные — `creates a thread with a server UUID and title null that is listed first` (с телом `{ id: 'x' }`); `AC-16.1/AC-16.3: deleted thread disappears …` (`countMessages(threadId)` = `0`, повторный `DELETE` → 404); `AC-16.2: DELETE of a foreign thread answers 404 and the thread and its messages remain`.
- **Failure response**: осиротевшие сообщения (`count` ≠ 0) — проверить использование `deleteThread` Mastra (каскад), не чистить вручную в обход.
- **Verification level**: L2.

## Proof Obligations
### Obligation: Element 1 (create) / Failure Mode: no-op
- **Claim**: `POST /api/threads` создаёт беседу с серверным UUID и `title: null`; id клиента игнорируется; беседа первой в списке.
- **Primary failure mode**: принят id клиента (`'x'`).
- **Boundary to exercise**: HTTP → Postgres.
- **State assertion**: до: нет беседы → после: `GET /api/threads` первой отдаёт созданную, `id` ≠ `'x'`.
- **Mock boundary rationale**: none.
- **Residual**: нет.

### Obligation: AC-16.1 / AC-16.3 (threads)
- **Claim**: удалённая беседа исчезает из списка, её сообщения удалены каскадно, повторное удаление даёт 404.
- **Primary failure mode**: сообщения осиротели (`count` ≠ 0); повторное удаление даёт 500 или 204.
- **Boundary to exercise**: HTTP + прямой SQL.
- **State assertion**: до: N сообщений → после `DELETE` (204): `countMessages = 0`, беседы нет в списке; повторный `DELETE` → 404.
- **Mock boundary rationale**: none.
- **Residual**: часть AC-16.1 про `POST /api/chat` — T5.1.

### Obligation: AC-16.2
- **Claim**: чужая беседа не удаляется, ответ 404.
- **Primary failure mode**: 204/500 для чужой, либо чужая беседа удалена.
- **Boundary to exercise**: HTTP с двумя `x-user-id`.
- **State assertion**: беседа A + сообщения → `DELETE` от B → 404; беседа A и её сообщения на месте.
- **Mock boundary rationale**: none.
- **Residual**: нет.

## Completion Criteria
- [x] 3 e2e зелёные; `it.todo` этих кейсов закрыты
- [x] Каждый Compliance Check = `Y`, доказательства в Investigation Notes
- [x] lint/tsc/prettier/unit/e2e/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `threads.service.ts`/`threads.controller.ts` — последовательность T2.2 → T3.1 → T3.3 → T3.4.
- Scope boundary: `threads.module.ts`, `chat/**`, `audit/**`, `app.e2e-spec.ts` не меняются.
