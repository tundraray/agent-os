# Task T4.3: `onFinish` → `ThreadTitleService.schedule`, обвязка заголовков, e2e 17.x

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 4, T4.3)
- Dependencies: T4.2 → Deliverable: `ThreadTitleService`, `ThreadsModule` экспорты; T3.4 → Deliverable: `PATCH` (для AC-17.2); T2.5 → Deliverable: `ChatController` с `ThreadsService` в конструкторе (проверка беседы и «сброс хвоста»), `ChatModule.imports: [ThreadsModule]`, `chat-threads.e2e-spec.ts` с кейсами AC-14.6 и `partialTextThenErrorStep`/сценарием обрыва в `mockModels.ts`
- Provides: автозаголовок в чате; `createTestApp` всегда подменяет `THREAD_TITLE_AGENT` — для T5.1, T6.1
- Size: Medium (4 файла)
- Covers: AC-17.1, AC-17.2, AC-17.3

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
В `ChatController.onFinish` после строки `usage` — `this.titles.schedule({ threadId, resourceId: req.user.id })`; остальное в контроллере не меняется (проверка владельца и «сброс хвоста» — уже в T2.5). **`chat.module.ts` в этой задаче не правится**: `ChatModule.imports: [ThreadsModule]` добавлен в T2.5, `ThreadsModule` экспортирует `ThreadTitleService` с T4.2. Конструктор `ChatController` получает **только `ThreadTitleService`** (дополнительно к `ThreadsService` из T2.5); поле — `titles`. `createTestApp` **всегда** применяет `.overrideProvider(THREAD_TITLE_AGENT)` с mock-агентом, по умолчанию возвращающим `'Тестовый заголовок'`; параметр `titleModel` лишь меняет сценарий — так ни один e2e (в т. ч. T2.x, T3.x, T5.1, perf), отправляющий `POST /api/chat/assistant`, не вызывает сетевую модель заголовков. `mockModels.ts` — сценарии заголовков: по умолчанию фиксированный `'Тестовый заголовок'`; успех «План отпуска на Байкал»; ошибка; задержка с параметром мс; переключаемый. Подключение `schedule` и override входят в одну единицу, готовую к коммиту.

## Target Files
- [x] `apps/api/src/chat/chat.controller.ts` (только `onFinish` и конструктор — добавляется `ThreadTitleService`; `ThreadsService` и вызовы `getOwnedThread`/`discardRepliesAfter` из T2.5 не менять)
- [x] `apps/api/test/support/createTestApp.ts` (`titleModel`, `.overrideProvider(THREAD_TITLE_AGENT)` — всегда)
- [x] `apps/api/test/support/mockModels.ts` (сценарии заголовков)
- [x] `apps/api/test/chat-threads.e2e-spec.ts`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации. В `chat.controller.ts` меняются только `onFinish` и конструктор (только `ThreadTitleService`). `chat.module.ts` — вне списка (изменён в T2.5).

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Integration Point 3 / Integration Points List — автозаголовок, § Test Strategy `chat-threads.e2e-spec.ts`, § Integration Verification Points)
- `apps/api/test/chat-threads.e2e-spec.ts` (скелет: `AC-17.1`, `AC-17.2`, `AC-17.3`)
- `apps/api/src/chat/chat.controller.ts` (после T2.5: `ThreadsService`, `getOwnedThread`, `discardRepliesAfter`), `apps/api/src/chat/chat.module.ts` (только чтение: `imports: [ThreadsModule]` уже есть)
- `apps/api/src/threads/thread-title.service.ts`, `threads.module.ts`
- `apps/api/test/support/*` (T1.3)

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ AC-17.1) | derived-display | «не позднее 10 с записать заголовок длиной 1…80 символов без кавычек и переводов строк»; e2e: ««План отпуска на Байкал» в течение 10 с (опрос 100 мс)» | Y, если e2e опрашивает `GET /api/threads/:id` каждые 100 мс до 10 000 мс и получает «План отпуска на Байкал» |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Источник первого сообщения для повтора (AC-17.3) | второй запрос содержит в `body.messages` **только** новое сообщение; заголовок строится из первого сохранённого сообщения (`Memory`), не из `body.messages` | work plan T4.3 |
| Mock заголовков по умолчанию | `'Тестовый заголовок'` во всех e2e; сетевых вызовов модели нет | work plan T4.3 (I005) |
| Доп. e2e вне скелета | `manual rename while title generation is pending wins` | work plan T4.3, Notes |

## Investigation Notes
- Observations: `ChatController` (after T2.5) has `ThreadsService` in the constructor, `getOwnedThread` before streaming and `discardRepliesAfter` for a resent user message; `onFinish` logged only the `usage` line. `ChatModule.imports: [ThreadsModule]` exists; `ThreadsModule` exports `ThreadTitleService` and provides `THREAD_TITLE_AGENT` via `threadTitleAgentProvider` (real Mastra `Agent`, model from `TITLE_MODEL`/`ASSISTANT_MODEL`). `ThreadTitleService` depends only on `generate(message, { abortSignal })` of the agent. Mastra `Agent.generate` calls `model.doGenerate` (methodType `generate`), so the title mock implements `doGenerate`. `POST /api/threads` (201) and `PATCH /api/threads/:id` exist (Phase 3).
- Planned approach: `onFinish` calls `this.titles.schedule({ threadId, resourceId: req.user.id })` right after the `usage` line; the constructor gains only `ThreadTitleService` (field `titles`). `mockModels.ts` gets `titleModel(scenario)` — a `MockLanguageModelV4` (`doGenerate`) recording each call's user prompt text, with scenarios `titleSuccess`, `titleError`, `titleDelayed(title, ms)` (honours the abort signal), default `DEFAULT_TEST_TITLE = 'Тестовый заголовок'`, switchable via `use()`. `createTestApp` always applies `.overrideProvider(THREAD_TITLE_AGENT).useValue(...)` with an `Agent` (`id: 'thread-title'`, `THREAD_TITLE_INSTRUCTIONS`) on that mock model — the production agent shape, so the real `Agent.generate` path is exercised; `titleModel` only changes the scenario and is returned on `TestApp`.
- Reference Contract (AC-17.1): e2e polls `GET /api/threads/:id` every 100 ms up to 10 000 ms (`pollUntil` / `awaitTitle`) and asserts the literal 'План отпуска на Байкал' — Compliance Check: **Y** (final implementation, `chat-threads.e2e-spec.ts` AC-17.1 green).
- RED evidence (before wiring `schedule`): AC-17.1, AC-17.3 and the rename race failed with `not reached within 10000 ms`; AC-17.2 passed (non-regression by nature: no call expected).
- GREEN evidence: `chat-threads.e2e-spec.ts` 7 passed / 3 todo; full `test:e2e` with `ANTHROPIC_API_KEY=` and `OPENAI_API_KEY=` emptied: 25 passed / 5 todo, `app.e2e-spec.ts` unchanged and green.
- AC-17.3: the warning is awaited by polling the `Logger.prototype.warn` spy (it is written only after the failed title call settled, so it implies the mock was called); the retry prompt is the call after the switch and contains only the first stored message.
- Rename race: the PATCH is sent as soon as the mock recorded the call (generation pending, 1 500 ms delay); `'Ручной'` is asserted at +2 s and +5 s after the PATCH; the mock was called exactly once.
- Adjacent sweep: not required (no `Change Category`). Out of scope, observed: `prettier --check` reports 7 pre-existing files outside Target Files (`src/audit/*`, `src/auth/session.guard.ts`, `src/mastra/*`) — unchanged by this task (no diff vs HEAD), left as is.

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

## Operation Verification Methods
- **Verification method**: e2e на реальном Postgres (3 из скелета + 1 доп.); повторный полный прогон `pnpm --filter api test:e2e` в окружении без ключей провайдеров.
- **Success criteria**: `AC-17.1: an untitled thread gets the generated title within 10 s from the first user message`; `AC-17.2: a manually titled thread keeps its title and the title model is not called`; `AC-17.3: a failing title model leaves title null and logs a warning; the next reply retries from the first stored message`; доп. `manual rename while title generation is pending wins` — Arrange: сценарий заголовка «задержка 1 500 мс» (возвращает `'Сгенерированный'`), беседа без заголовка через `seed`; Act: `POST /api/chat/assistant`, дождаться конца стрима, пока генерация ожидает — `PATCH /api/threads/:id { title: 'Ручной' }` (200), дождаться истечения задержки; Assert: `GET /api/threads/:id` возвращает `title: 'Ручной'` через +2 с и через +5 с после `PATCH`. Лог предупреждения содержит `Title generation failed thread=<id> reason=` и не содержит текста сообщения. `app.e2e-spec.ts` проходит без правок; ни один тест не делает сетевого вызова модели.
- **Failure response**: ошибка заголовка ломает стрим чата — недопустимо, исправить изоляцию ошибок; не ослаблять тест.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-17.1
- **Claim**: безымянная беседа получает сгенерированный заголовок в пределах 10 с после ответа.
- **Primary failure mode**: `schedule` не вызывается в `onFinish`; заголовок не записывается.
- **Boundary to exercise**: HTTP (чат → фоновая запись → `GET /api/threads/:id`) на реальном Postgres.
- **State assertion**: до: `title: null` → после стрима: «План отпуска на Байкал» ≤ 10 с.
- **Mock boundary rationale**: мокаются модели ассистента и заголовков; хранилище реальное.
- **Residual**: качество реальной модели — T6.3.

### Obligation: AC-17.2
- **Claim**: вручную заданное имя не перезаписывается, модель заголовков не вызывается.
- **Primary failure mode**: перезапись непустого title.
- **Boundary to exercise**: HTTP.
- **State assertion**: беседа с ручным title → чат-ответ → title прежний; счётчик вызовов mock-модели заголовков = 0.
- **Mock boundary rationale**: как выше.
- **Residual**: нет.

### Obligation: AC-17.3
- **Claim**: падающая модель заголовков не ломает чат; title остаётся `null`; следующий ответ повторяет генерацию с первого сохранённого сообщения.
- **Primary failure mode**: источник — `body.messages`; ошибка заголовка ломает стрим; повтор не запускается.
- **Boundary to exercise**: HTTP.
- **State assertion**: после первой попытки `title: null` + `warn`; второй запрос (только новое сообщение) → заголовок записан.
- **Mock boundary rationale**: как выше.
- **Residual**: нет.

### Obligation: AC-17.2 + Integration Verification Points (гонка на реальной БД)
- **Claim**: ручной `PATCH` во время ожидающей генерации побеждает.
- **Primary failure mode**: фоновая запись не перепроверяет `title === ''` под `ThreadWriteLock` (заголовок станет `'Сгенерированный'`).
- **Boundary to exercise**: HTTP + реальная БД, задержка модели 1 500 мс.
- **State assertion**: `'Ручной'` на +2 с и +5 с после `PATCH`.
- **Mock boundary rationale**: как выше.
- **Residual**: нет.

### Obligation: Failure Mode: shared-state dependency / unavailable boundary
- **Claim**: override `THREAD_TITLE_AGENT` всегда применён; изоляция e2e по `resourceId`.
- **Primary failure mode**: сетевой вызов модели в любом e2e.
- **Boundary to exercise**: полный прогон `test:e2e` без ключей провайдеров.
- **State assertion**: N/A.
- **Mock boundary rationale**: заменяются `MASTRA` и `THREAD_TITLE_AGENT`.
- **Residual**: нет.

## Completion Criteria
- [x] 3 e2e скелета + 1 доп. зелёные; `it.todo` этих кейсов закрыты (`chat-threads.e2e-spec.ts` 4/7)
- [x] `app.e2e-spec.ts` проходит без правок
- [x] Повторный полный прогон `pnpm --filter api test:e2e` зелёный, сетевых вызовов модели нет (без ключей провайдеров)
- [x] Каждый Compliance Check = `Y`, доказательства в Investigation Notes
- [x] lint/tsc/prettier/unit/e2e/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `chat.controller.ts` (T2.3 `onError` → T2.5 → T4.3 `onFinish`; T5.1 production-код не меняет), `createTestApp.ts`/`mockModels.ts` (общие для всех e2e; `mockModels.ts` до этого правили T1.3, T2.4, T2.5), `chat-threads.e2e-spec.ts` (T2.4 → T2.5 → T4.3 → T5.1).
- Scope boundary: `chat.module.ts` не меняется; в `chat.controller.ts` не меняются проверка владельца и «сброс хвоста» (T2.5), стриминг, `onError`, отмена, лог `usage`; `app.e2e-spec.ts` не меняется.
