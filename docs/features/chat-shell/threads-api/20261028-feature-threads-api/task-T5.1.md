# Task T5.1: e2e проверки беседы в `POST /api/chat/:agentId` (код проверки — в T2.5) + мутационная проверка

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 5, T5.1)
- Dependencies: T4.3 → Deliverable: `ChatController` с `ThreadTitleService`, общий `chat-threads.e2e-spec.ts`; **T2.5 → Deliverable: код проверки беседы в `ChatController.chat` (`getOwnedThread` до «сброса хвоста» и `agent.stream`), `ChatModule.imports: [ThreadsModule]`, смена поведения чата 500 → 404**; **T3.3 → Deliverable: `DELETE /api/threads/:threadId` (Arrange AC-16.1)**; **T3.1 → Deliverable: `GET /api/threads` (проверка, что удалённая беседа не воскресла в списке)**
- Provides: e2e-доказательство смены поведения чата (404 вместо воскрешения/500) и мутационная проверка — для T6.1, T6.2
- Size: Small (1 файл; production-код не меняется)
- Covers: AC-16.1 (вариант «404»), AC-18.3
- Позиция: **последняя задача реализации** (шаг 8 DD, только e2e); смена поведения чата (прототип `apps/web/src/components/assistant.tsx` получает 404 на каждую отправку до `web-shell`) наступила уже в T2.5 (принято решением пользователя; слияние в `main` — вместе с `web-shell`)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
**Production-код в этой задаче не меняется.** Проверка беседы уже добавлена в T2.5 в порядке «агент → наличие id → `getOwnedThread` → разбор последнего сообщения и `discardRepliesAfter` → `agent.stream`». Задача пишет три e2e (наполняет `it.todo` скелета) и один раз проверяет их мутацией. Чужая и удалённая/неизвестная беседа → 404 `THREAD_NOT_FOUND` до начала SSE, без создания беседы.

**Предусловие**: перед e2e убедиться (чтением `chat.controller.ts`), что `ChatController.chat` содержит `getOwnedThread` до `agent.stream`. Если его нет — **эскалация** оркестратору (`escalation_needed`), а не правка кода вне Target Files.

**Мутационная проверка (один раз, после того как 3 e2e зелёные)**: (1) сохранить копию `apps/api/src/chat/chat.controller.ts` в каталог scratchpad и записать её sha256; (2) временно удалить вызов `getOwnedThread` в `ChatController.chat`; (3) запустить 3 e2e — кейсы `AC-16.1` и `foreign thread and unknown client id …` должны покраснеть (404 → иное), результат записать в Investigation Notes; (4) восстановить файл из копии и проверить, что sha256 совпадает с исходным; (5) повторно запустить 3 e2e — зелёные. Без `git stash`/`git checkout`/`git reset`.

## Target Files
- [x] `apps/api/test/chat-threads.e2e-spec.ts`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации. `apps/api/src/chat/chat.controller.ts` меняется **только временно** в мутационной проверке и обязан быть восстановлен байт-в-байт (итоговое состояние = состоянию до мутации). `apps/api/test/app.e2e-spec.ts` не меняется (`git diff --exit-code` пуст).

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Integration Point 1 (чат), § Interface Change Matrix, AC-16.1, § Error Handling)
- `apps/api/src/chat/chat.controller.ts` (после T4.3; порядок проверок «агент → id → `getOwnedThread` → «сброс хвоста» → стрим» — добавлен в T2.5; только читать)
- `docs/features/chat-shell/threads-api/20261028-feature-threads-api/task-T2.5.md` (что именно добавлено в чат)
- `apps/api/test/chat-threads.e2e-spec.ts` (скелет: `AC-16.1`, `own thread`, `foreign thread and unknown client id`)
- `apps/api/src/threads/threads.service.ts` (`getOwnedThread`)
- `apps/api/test/app.e2e-spec.ts` (читать, не менять)

## Change Category
`Change Category: state-change, boundary-change`

Смена поведения публичного маршрута: исполнитель проверяет смежные пути — неизвестный агент (404 как раньше), отсутствующий id (400 как раньше), чужая беседа (раньше 500), клиентский id без беседы.

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ AC-16.1) | state-lifecycle-negative | «**и отвечать 404 `THREAD_NOT_FOUND` на `POST /api/chat/:agentId` с этим `id`**, не создавая беседу» | Y, если после `POST /api/chat/assistant` с id удалённой беседы статус 404 `THREAD_NOT_FOUND` до SSE, а `getThreadById` остаётся `null` |
| design-threads-api.md (§ Code Inspection Evidence, находка 7) | structure-order | `{"message":"Thread not found","error":"Not Found","statusCode":404,"errorCode":"THREAD_NOT_FOUND"}` | Y, если тело 404 для чужой и для неизвестной беседы равно этому литералу |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Порядок проверок | агент → наличие id → беседа (`getOwnedThread`) → «сброс хвоста» → стрим (код — T2.5) | work plan T2.5, T5.1 |
| Код проверки беседы | добавлен в T2.5 вместе со «сбросом хвоста»; T5.1 — только e2e и мутационная проверка | work plan, «Отклонение от порядка DD» |
| Единая точка проверки владельца | `ThreadsService.getOwnedThread`, без дублирования логики в контроллере | work plan, Quality Assurance Mechanisms |
| Гонка удаления между `getOwnedThread` и `agent.stream` | принято Design Doc как риск без задачи | work plan, Design-to-Plan Traceability |

## Investigation Notes
- Предусловие (T2.5): `apps/api/src/chat/chat.controller.ts:54` — `await this.threads.getOwnedThread(threadId, req.user.id)` стоит после проверки агента (404) и наличия id (400), до разбора последнего сообщения/`discardRepliesAfter` (стр. 59–66) и `agent.stream` (стр. 74). Эскалация не нужна.
- `ThreadsService.getOwnedThread` (`threads.service.ts:51`) → `memory.getThreadById({ threadId, resourceId })`, `null` → `threadNotFound()` (`threads.errors.ts`, единственный источник тела 404).
- План: три `it.todo` наполнены по Arrange/Act/Assert скелета; в `startAppWith` наружу отдаётся mock-модель ассистента (`assistant`), чтобы проверять `doStreamCalls` (0 новых вызовов при 404); вспомогательные `listedThreadIds` (`ThreadListResponseSchema`) и `threadHistory`; литерал `NOT_FOUND_BODY` как в `threads.e2e-spec.ts`. Беседы создаются `POST /api/threads`, удаление — `DELETE` (204).
- Adjacent sweep (state-change, boundary-change): неизвестный агент (404) и отсутствующий id (400) проверяются до `getOwnedThread` — порядок в коде не изменён, покрытие — `app.e2e-spec.ts` (зелёный, без правок). Чужая беседа (было 500) и клиентский id без беседы — кейс `foreign thread and unknown client id …`. Удалённая беседа — кейс AC-16.1. Остатков вне Target Files нет.
- Reference Contract «AC-16.1» (state-lifecycle-negative): **Y** — после `DELETE` → `POST /api/chat/assistant` статус 404, `content-type` `application/json` (не SSE), тело = литерал, `getThreadById` → `null`, в `GET /api/threads` id отсутствует, `doStreamCalls` не вырос.
- Reference Contract «находка 7» (structure-order): **Y** — тела 404 для чужой и неизвестной беседы `toEqual({ message: 'Thread not found', error: 'Not Found', statusCode: 404, errorCode: 'THREAD_NOT_FOUND' })`.
- Мутационная проверка (2026-10-29, один раз): копия `D:\Temp\claude\D--git-github-ai-agent-os\9bee0586-b376-4f97-b39b-7eb4cd59a0ce\scratchpad\chat.controller.ts.orig`; sha256 до мутации `6aae49bad1bee035cd7c8949ce7d2bb3357045b157fcfa92c19e0d63c992d901`; удалена строка `await this.threads.getOwnedThread(threadId, req.user.id);` (sha256 мутанта `516af321b2c2a4ad4032232ae9c18c3d48876f4457b5ce4855dcbf200f7e2953`). Результат: `AC-16.1 …` × (`expected 500 to be 404`), `foreign thread and unknown client id …` × (`expected 500 to be 404`), `own thread …` ✓ — 2 failed | 1 passed. Файл восстановлен копированием из scratchpad; sha256 после восстановления `6aae49bad1bee035cd7c8949ce7d2bb3357045b157fcfa92c19e0d63c992d901` (совпадает); повторный прогон — 3 passed. `git stash`/`checkout`/`reset` не использовались.
- Гейты: lint 0, tsc 0, unit 118/118, e2e 28 passed + 2 todo (`threads.perf.e2e-spec.ts`, скелет perf, вне T5.1), build OK, `git diff --exit-code apps/api/test/app.e2e-spec.ts` пуст. `prettier --check`: Target File чист; предупреждения только у 7 файлов вне Target Files без диффа к HEAD (`src/audit/*`, `src/auth/session.guard.ts`, `src/mastra/*`) — как в T4.3, оставлены как есть.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать все Investigation Targets, записать наблюдения в Investigation Notes
- [x] Просмотреть deliverables зависимостей (см. Metadata)
- [x] Сверить контракты (Reference Contracts) с Design Doc, записать план подхода в Investigation Notes
- [x] Убедиться, что `ChatController.chat` содержит `getOwnedThread` до `agent.stream` (T2.5); при отсутствии — эскалация
- [x] Написать e2e (наполнить `it.todo` скелета по его комментариям Arrange/Act/Assert, ожидаемые значения — литералы, пустые заглушки запрещены). Production-код уже есть (T2.5), поэтому кейсы сразу зелёные — «красное» доказывается мутацией ниже

### 2. Green Phase
- [x] Запустить 3 добавленных e2e, убедиться, что они зелёные
- [x] **Мутационная проверка (один раз)**: удалить вызов `getOwnedThread` в `ChatController.chat` (копия и sha256 сохранены) → кейсы `AC-16.1` и `foreign thread and unknown client id …` краснеют; результат записать в Investigation Notes
- [x] Восстановить `chat.controller.ts` из копии, сверить sha256, повторно запустить 3 e2e — зелёные

### 3. Refactor Phase
- [x] Улучшить тестовый код, не меняя поведения
- [x] Повторно запустить добавленные тесты

### 4. Gates (все — ноль ошибок; перед vitest после правки `packages/contracts` — `pnpm --filter @agent-os/contracts build`; перед e2e — `pnpm db:up` и `apps/api/.env` с `DATABASE_URL`)
- [x] `pnpm --filter api lint`
- [x] `pnpm --filter api exec tsc --noEmit -p tsconfig.json`
- [x] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`
- [x] `pnpm --filter api test`
- [x] `pnpm --filter api test:e2e` (полный прогон; Postgres на хост-порту 5433, `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`)
- [x] `pnpm --filter api build`

## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов, типовые ошибки — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext`, `.js`-суффиксы импортов — Enforces: строгие типы, без `as`-обхода — Config/Source: `apps/api/tsconfig.json`, `packages/contracts/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest unit / e2e (реальный Postgres) — Enforces: поведение и AC — Config/Source: `apps/api/vitest.config.ts`, `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- `nest build` — Enforces: сборка production-кода — Config/Source: `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json` — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`
- AC-18.3: `app.e2e-spec.ts` без правок — Enforces: обратная совместимость тела чата — Config/Source: `apps/api/test/app.e2e-spec.ts` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: e2e на реальном Postgres; плюс `git diff --exit-code apps/api/test/app.e2e-spec.ts`.
- **Success criteria**: 3 e2e зелёные — `AC-16.1: chat into a deleted thread answers 404 THREAD_NOT_FOUND before streaming and does not recreate it`; `own thread: 200 SSE and both messages are persisted`; `foreign thread and unknown client id both answer 404 THREAD_NOT_FOUND and nothing is written`; `app.e2e-spec.ts` зелёный. Операционно (Integration Point 2 DD): создать беседу `POST /api/threads`, отправить сообщение через mock-модель с reasoning и инструментами, получить историю — `safeValidateUIMessages` успешен, части совпадают с литералами; `DELETE` беседы → `POST /api/chat/assistant` с её id → 404 `THREAD_NOT_FOUND` до SSE, `getThreadById` → `null`, беседы нет в списке; чужая беседа → 404 (раньше 500).
- **Failure response**: e2e красные без мутации — проверка владельца стоит после начала стрима или Mastra неявно создаёт тред: это дефект T2.5, **эскалация** оркестратору (код вне Target Files не править).
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-16.1 (чат)
- **Claim**: чат в удалённую беседу отвечает 404 до стрима и не воскрешает беседу.
- **Primary failure mode**: Mastra неявно создаёт тред (`getThreadById` → не `null` после запроса).
- **Boundary to exercise**: HTTP → реальный Postgres.
- **State assertion**: до: беседа удалена → `POST /api/chat/assistant` → 404; после: `getThreadById` = `null`, в списке нет.
- **Mock boundary rationale**: мокается только модель.
- **Residual**: нет.
- **Мутация**: без вызова `getOwnedThread` в `ChatController.chat` кейс краснеет (проверено один раз, см. Investigation Notes).

### Obligation: Чужая беседа / клиентский id
- **Claim**: чужая беседа и неизвестный клиентский id дают одинаковый 404, ничего не записывается.
- **Primary failure mode**: статус 500 (старое поведение) либо сообщение записано в чужую беседу.
- **Boundary to exercise**: HTTP с двумя `x-user-id`.
- **State assertion**: `countMessages` чужой беседы до = после.
- **Mock boundary rationale**: как выше.
- **Residual**: нет.
- **Мутация**: без `getOwnedThread` кейс краснеет (проверено один раз).

### Obligation: AC-18.3
- **Claim**: тело чата и `app.e2e-spec.ts` не изменены.
- **Primary failure mode**: правка `ChatRequestSchema`/`app.e2e-spec.ts` ради прохождения.
- **Boundary to exercise**: `app.e2e-spec.ts` + `git diff`.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: итоговая проверка — T6.2.

## Completion Criteria
- [x] 3 e2e зелёные; `it.todo` этих кейсов закрыты (`chat-threads.e2e-spec.ts` 7/7), `app.e2e-spec.ts` зелёный и не изменён
- [x] Мутационная проверка выполнена один раз (оба кейса 404 краснеют без `getOwnedThread`), `chat.controller.ts` восстановлен (sha256 совпадает), результат в Investigation Notes
- [x] Каждый Compliance Check = `Y`, доказательства в Investigation Notes
- [x] lint/tsc/prettier/unit/e2e/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия) на `feature/chat-shell` (в `main` — только вместе с `web-shell`); `git commit` не выполнялся

## Notes
- Impact scope: `POST /api/chat/:agentId` — все клиенты чата (в т. ч. прототип `apps/web/src/components/assistant.tsx`).
- Scope boundary: production-код не меняется (`chat.controller.ts` — только временная мутация с восстановлением); `apps/web/**` не меняется; `app.e2e-spec.ts` не меняется.
