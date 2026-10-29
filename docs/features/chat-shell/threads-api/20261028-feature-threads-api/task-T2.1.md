# Task T2.1: `THREAD_MEMORY`, `threads.errors.ts`, `thread.mapper.ts`, `ThreadsModule` в `AppModule`

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 2, T2.1)
- Dependencies: T1.2 → Deliverable: `ZodValidationPipe`, `configureApp`; T1.3 → Deliverable: `apps/api/test/support/*`
- Provides: `THREAD_MEMORY` провайдер, `threadNotFound()`, `isMastraUserError()`, `toThreadSummary`, `ThreadsModule` — для T2.2 и далее
- Size: Medium (7 файлов)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
`THREAD_MEMORY` = `await mastra.getAgent('assistant').getMemory()` с проверкой `instanceof Memory` (иначе исключение при инициализации модуля — fail fast); константа `THREADS_MEMORY_AGENT_ID = 'assistant'`; `threadNotFound()` и `isMastraUserError()` по Design Doc; `toThreadSummary` (mapper). `ThreadsModule` создаётся и импортируется в `AppModule`. Фабрики провайдеров не обращаются к сети при создании (приложение без ключей провайдера должно подниматься в `app.e2e-spec.ts`).

## Target Files
- [x] `apps/api/src/threads/thread-memory.provider.ts` (new)
- [x] `apps/api/src/threads/thread-memory.provider.spec.ts` (new)
- [x] `apps/api/src/threads/threads.errors.ts` (new)
- [x] `apps/api/src/threads/thread.mapper.ts` (new)
- [x] `apps/api/src/threads/thread.mapper.spec.ts` (new)
- [x] `apps/api/src/threads/threads.module.ts` (new)
- [x] `apps/api/src/app.module.ts`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Main Components, § Error Handling, § Field Propagation Map, § Code Inspection Evidence находка 7, § Integration Point 5)
- `apps/api/src/app.module.ts`, `apps/api/src/mastra/mastra.module.ts`, `apps/api/src/mastra/mastra.provider.ts`, `apps/api/src/mastra/mastra.constants.ts` (токен `MASTRA`)
- `apps/api/src/mastra/agents/assistant.agent.ts` (агент `assistant`, его `Memory`)
- `apps/api/src/auth/session.guard.ts` (пригодится в T2.2; здесь читать для согласованности модуля)

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Code Inspection Evidence, находка 7) | structure-order | `{"message":"Thread not found","error":"Not Found","statusCode":404,"errorCode":"THREAD_NOT_FOUND"}` | Y, если `threadNotFound().getResponse()` глубоко равно этому объекту |
| design-threads-api.md (§ Field Propagation Map) | derived-display | «`'' → null; иначе как есть`» (`ThreadSummary.title`); даты — «`Date.toISOString()` — миллисекундная точность» | Y, если `toThreadSummary` отдаёт `title: null` для `''`, непустой title как есть, даты в ISO с `Z` и миллисекундами |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Неверный тип памяти агента | исключение при инициализации модуля (fail fast), без молчаливого fallback | work plan T2.1, Failure Mode «missing config» |
| Путь `thread-memory.provider.spec.ts` | выбран планом (в Design Doc не указан) | work plan, Notes «Происхождение Target Files» |

## Investigation Notes
- Наблюдения: `MASTRA` (Symbol) экспортируется глобальным `MastraModule`; агент `assistant` создаётся с `new Memory({ options: { lastMessages: 20 } })` (хранилище наследуется от `PostgresStore` Mastra). `Agent.getMemory()` в `@mastra/core` 1.80.0 возвращает `Promise<MastraMemory | undefined>`; `Mastra.getAgent` бросает на неизвестном id. `StorageThreadType` (`@mastra/core/memory`): `title?: string`, даты `Date`. `MastraError`/`ErrorCategory` — `@mastra/core/error`. `SessionGuard` — глобальный `AuthModule`, в T2.1 не нужен.
- Подход: `resolveThreadMemory(mastra: AgentMemorySource)` (узкий структурный интерфейс; реальный `Mastra` присваивается ему — проверяется компилятором в `useFactory: (mastra: Mastra) => resolveThreadMemory(mastra)`), `instanceof Memory` иначе `throw Error` — фабрика без сети (только `getMemory()` статической памяти). `ThreadsModule` экспортирует `THREAD_MEMORY`; `AppModule` импортирует `ThreadsModule`.
- Размещение теста `threadNotFound`/`isMastraUserError`: отдельного spec для `threads.errors.ts` в Target Files нет — кейсы помещены в `thread.mapper.spec.ts` (describe-блоки `threadNotFound`, `isMastraUserError`), чтобы не выходить за File Scope.
- Reference Contract 1 (тело 404): Y — `thread.mapper.spec.ts` › `threadNotFound` проверяет `getResponse()` `toEqual` литералу `{message:'Thread not found',error:'Not Found',statusCode:404,errorCode:'THREAD_NOT_FOUND'}` (зелёный).
- Reference Contract 2 (mapper): Y — `''` → `null` (и отсутствующий title → `null`), непустой title как есть (включая пробелы), даты `'2026-10-28T09:15:30.123Z'` / `'2026-10-28T10:00:00.007Z'`; `resourceId`/`metadata` не попадают в ответ (`toEqual` на точный объект).
- Fail fast: unit — `undefined` и чужой объект памяти → reject с сообщением; реальная `Memory` → тот же экземпляр. `app.e2e-spec.ts` зелёный без правок (реальный `Mastra` проходит проверку `instanceof Memory` при `app.init()`).

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
- Тело 404 строится только `threadNotFound()` — Enforces: неразличимость чужой/отсутствующей беседы — Config/Source: `apps/api/src/threads/threads.errors.ts` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: unit (mapper, provider, `threadNotFound`); `pnpm db:up` и `pnpm --filter api test:e2e -- app.e2e-spec` (приложение с новым `ThreadsModule` поднимается без ключей провайдера).
- **Success criteria**: unit зелёный; `app.e2e-spec.ts` зелёный без правок; lint/tsc/build без ошибок.
- **Failure response**: `AppModule` не поднимается — фабрика провайдера не должна трогать сеть; исправить фабрику, не `app.e2e-spec.ts`.
- **Verification level**: L2.

## Proof Obligations
### Obligation: Failure Mode: missing config (память агента)
- **Claim**: агент без `Memory` приводит к исключению при инициализации.
- **Primary failure mode**: проверка `instanceof Memory` отсутствует, ошибка проявляется только при первом запросе.
- **Boundary to exercise**: in-process unit (фейковый агент).
- **State assertion**: N/A.
- **Mock boundary rationale**: фейковый `Mastra`/агент — нет сети и БД.
- **Residual**: реальная память — e2e T2.2.

### Obligation: Field Propagation (mapper)
- **Claim**: `''` → `null`, непустой title как есть, даты — ISO с `Z`.
- **Primary failure mode**: `''` уходит клиенту как пустая строка; даты без миллисекунд/без `Z`.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: HTTP-форма — T2.2.

### Obligation: 404 body
- **Claim**: `threadNotFound().getResponse()` равен литералу тела 404.
- **Primary failure mode**: тело строится в нескольких местах и различается для чужой/отсутствующей беседы.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: HTTP — T2.2, T3.3, T3.4, T5.1.

## Completion Criteria
- [x] Unit зелёный, прогон содержательный
- [x] `AppModule` поднимается в `app.e2e-spec.ts` без правок
- [x] lint/tsc/prettier/build — ноль ошибок
- [x] Каждый Compliance Check = `Y`, доказательства в Investigation Notes
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `app.module.ts` (загрузка всего приложения).
- Scope boundary: `apps/api/test/app.e2e-spec.ts`, `apps/api/src/mastra/**`, `apps/api/src/chat/**` не меняются.
