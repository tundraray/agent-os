# Task T2.2: `ThreadsService.getOwnedThread/get/listMessages`, `GET /api/threads/:threadId`, `GET /api/threads/:threadId/messages` + e2e

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 2, T2.2)
- Dependencies: T2.1 → Deliverable: `THREAD_MEMORY`, `threadNotFound()`, `toThreadSummary`, `ThreadsModule`
- Provides: `ThreadsService.getOwnedThread` (единая точка проверки владельца; используется T3.x, T5.1), `ThreadsController` — для T2.3 и далее
- Size: Medium (4 файла)
- Covers: AC-14.1, AC-14.2, AC-14.3 (ранняя точка проверки, часть 1)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
`@Controller('threads') @UseGuards(SessionGuard)`; `@Param('threadId', new ZodValidationPipe(ThreadIdSchema))`; `ThreadsService.getOwnedThread(threadId, userId)` — `getThreadById`, `null` или чужой `resourceId` → `NotFoundException` с телом `threadNotFound().getResponse()`; `get` (карточка); `listMessages` — `recall({ threadId, resourceId, perPage: false, orderBy: { field: 'createdAt', direction: 'ASC' } })` → `toAISdkMessages(messages, { version: 'v7' })`, присваивание `ThreadMessagesResponse` без `as` (иначе `ThreadMessagesResponseSchema.parse`).

## Target Files
- [x] `apps/api/src/threads/threads.service.ts` (new)
- [x] `apps/api/src/threads/threads.controller.ts` (new)
- [x] `apps/api/src/threads/threads.module.ts`
- [x] `apps/api/test/threads.e2e-spec.ts`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Main Components `ThreadsService`, § Contract Definitions GET-маршруты, § Output Comparison, § Integration Point 2)
- `apps/api/test/threads.e2e-spec.ts` (скелет: `AC-14.1`, `AC-14.2/AC-14.3` — комментарии Arrange/Act/Assert)
- `apps/api/test/support/*` (T1.3: `createTestApp`, `seed`, `mockModels`, `db`)
- `apps/api/src/threads/*` (T2.1: provider, errors, mapper)
- `apps/api/src/auth/session.guard.ts` (`req.user.id`, заголовок `x-user-id`)
- `apps/api/src/chat/chat.controller.ts` (как чат сохраняет сообщения; читать, не менять)

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Code Inspection Evidence, находка 7) | structure-order | `{"message":"Thread not found","error":"Not Found","statusCode":404,"errorCode":"THREAD_NOT_FOUND"}` | Y, если тело 404 для чужой и для несуществующей беседы побайтно одинаково и равно этому литералу |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Arrange: как создаётся беседа в e2e | `seed` (`Memory.saveThread` с `randomUUID()`), отправка — через `POST /api/chat/assistant` с этим id; `POST /api/threads` появится только в T3.3 | work plan T2.2, Notes «Отклонения Arrange» |
| Id бесед в e2e | производные от `prefix` `seed` (`${prefix}-t-${nnn}`), не голые `'t-001'` | work plan, Notes «Отклонения Arrange» |
| Присваивание результата `toAISdkMessages` | без `as`; при несовпадении типов — `ThreadMessagesResponseSchema.parse` | work plan, Риски (I008) |

## Investigation Notes
- **Наблюдения (Investigation Targets)**: `THREAD_MEMORY` (T2.1) отдаёт `Memory` агента `assistant`; `threadNotFound()` — единственный источник тела 404; `toThreadSummary` — проекция карточки. `SessionGuard` кладёт `req.user.id` из `x-user-id`. `ChatController` (не менялся) пишет в Memory через `agent.stream({ memory: { thread, resource: req.user.id } })` — засеянная `seed` беседа принимает сообщения от владельца. Обвязка `test/support` (T1.3): `createTestApp({ assistantModel })`, `seed` с `prefix = randomUUID()`, `cleanupUsers`, `MockLanguageModelV4` (DD v1.4, `ai` 7.0.148).
- **План подхода**: `ThreadsService.getOwnedThread` = `getThreadById({ threadId, resourceId: userId })`, `null` → `throw threadNotFound()`; `get` = `toThreadSummary(getOwnedThread)`; `listMessages` = `getOwnedThread` → `recall({ perPage: false, orderBy createdAt ASC })` → `toAISdkMessages(…, { version: 'v7' })`. Контроллер `@Controller('threads') @UseGuards(SessionGuard)`, `@Param('threadId', new ZodValidationPipe(ThreadIdSchema))`. `ThreadsModule` регистрирует контроллер и сервис, экспортирует `ThreadsService` (для T5.1).
- **I008 (присваивание без `as`)**: прямое присваивание `V7UIMessage[]` типу `ThreadMessagesResponse` не проходит `tsc` (TS2322: у `UIMessage` нет индексной сигнатуры `looseObject`), поэтому применён запасной путь DD — `ThreadMessagesResponseSchema.parse` на границе. `as` нет.
- **Reference Contract — Compliance Check: Y.** e2e `AC-14.2/AC-14.3` проверяет `ApiErrorSchema.parse(body)` `toEqual` литералу `{ message: 'Thread not found', error: 'Not Found', statusCode: 404, errorCode: 'THREAD_NOT_FOUND' }` для всех четырёх ответов и побайтное равенство `res.text` чужой и несуществующей беседы на обоих маршрутах — зелёный.
- **Arrange-адаптация**: беседы создаются `seed` (id `${prefix}-t-001`), заголовок `'Секрет A'` задаётся через `seed` вместо `PATCH` (T3.4); обмены — `POST /api/chat/assistant`. Глобальная уникальность id подтверждена: e2e-файлы (`threads.e2e-spec.ts` + `app.e2e-spec.ts`) прошли параллельно на общем Postgres.
- **Mutation-проверки (Proof Obligations)**: `perPage: 5` вместо `false` → AC-14.1 падает (`length 5, expected 12`). `direction: 'DESC'` → AC-14.1 **не** падает: `toAISdkMessages`/`MessageList` сам упорядочивает по `createdAt`, порядок ответа обеспечен и конвертером. Остаток: 12 сообщений < `lastMessages: 20`, поэтому ограничение ровно 20 этим кейсом не обнаруживается (явный `perPage: false` в коде; лимит 100 сообщений проверит perf-кейс AC-14.4).
- **Литералы tool-частей**: `tool-failing` — `errorText: 'boom'` (сообщение исходной ошибки инструмента), `tool-getWeather` — `output: { city: 'Казань', temperatureC: 21, conditions: 'sunny' }`.

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
- [x] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"` (файлы задачи чистые; 9 предсуществующих нарушений в незатронутых файлах `audit/`, `auth/session.guard.ts`, `chat/chat.controller.ts`, `mastra/` — вне скоупа)
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
- Одна точка проверки владельца (`ThreadsService.getOwnedThread`) до `recall` — Enforces: нет IDOR — Config/Source: DD «Security Considerations» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: e2e на реальном Postgres (`pnpm db:up`): засеять беседу, отправить через `POST /api/chat/assistant` сообщение mock-модели с reasoning и двумя инструментами; `GET /api/threads/:id/messages`; тот же запрос от другого `x-user-id` и для несуществующего id.
- **Success criteria**: ответ проходит `ThreadMessagesResponseSchema` и `safeValidateUIMessages`; части совпадают с литералами: `reasoning` (`state: "done"`), `tool-getWeather` (`output-available`, `output`), `tool-failing` (`output-error`, `errorText`); 12 сообщений в порядке `createdAt` ASC; чужая и несуществующая → одинаковое тело 404 `THREAD_NOT_FOUND`.
- **Failure response**: потеря данных, видимых в стриме, — стоп и эскалация как изменение PRD (не писать собственный конвертер без согласования); иное расхождение — исправить реализацию.
- **Verification level**: L2 (e2e) + L1 на уровне API.

## Proof Obligations
### Obligation: AC-14.1
- **Claim**: `/messages` возвращает все 12 сообщений из 6 обменов oldest-first, включая `reasoning` и `tool-*`, валидные по `safeValidateUIMessages`.
- **Primary failure mode**: ограничение `lastMessages` (20) вместо `perPage: false`; потеря `reasoning`/`tool-*`; нарушение порядка.
- **Boundary to exercise**: HTTP → `ThreadsService` → реальный Postgres/Mastra Memory.
- **State assertion**: засеянная беседа + чат-обмены → `GET /messages` → 12 сообщений в порядке создания.
- **Mock boundary rationale**: мокается только модель ассистента (`MockLanguageModelV3`); хранилище реальное.
- **Residual**: сравнение со SSE-стримом — T2.3.

### Obligation: AC-14.2 / AC-14.3
- **Claim**: чужая и несуществующая беседа дают одинаковый 404 на `GET /api/threads/:id` и `/messages`.
- **Primary failure mode**: разные тела 404 (раскрытие существования) или 200/500 для чужой.
- **Boundary to exercise**: HTTP с двумя `x-user-id`.
- **State assertion**: беседа пользователя A → запрос пользователя B → 404, беседа A не изменена.
- **Mock boundary rationale**: none.
- **Residual**: остальные маршруты — T3.x.

### Obligation: Failure Mode: empty input
- **Claim**: беседа без сообщений возвращает `{ messages: [] }` (дополнительный e2e вне скелета).
- **Primary failure mode**: 404/500 для пустой, но существующей беседы.
- **Boundary to exercise**: HTTP.
- **State assertion**: только что засеянная беседа без сообщений → `{ messages: [] }`.
- **Mock boundary rationale**: none.
- **Residual**: нет.

## Completion Criteria
- [x] 2 кейса скелета (`AC-14.1`, `AC-14.2/AC-14.3`) + 1 дополнительный (empty input) зелёные на реальном Postgres; в скелете нет оставшихся `it.todo` для этих кейсов
- [x] `safeValidateUIMessages` успешен; ответы проверены `ThreadMessagesResponseSchema`, `ApiErrorSchema`
- [x] Глобальная уникальность id бесед (`prefix`) подтверждена первым e2e
- [x] Compliance Check = `Y`, доказательство в Investigation Notes
- [x] lint/tsc/prettier/unit/e2e/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `threads.module.ts` (общий с T3.2, T4.1, T4.2 — менять только строго в порядке плана).
- Scope boundary: `apps/api/src/chat/**`, `apps/api/test/app.e2e-spec.ts`, `audit/**` не меняются.
