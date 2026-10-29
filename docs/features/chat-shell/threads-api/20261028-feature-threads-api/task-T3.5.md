# Task T3.5: `AuditInterceptor` — `threadId` из маршрута + `audit.interceptor.spec.ts`

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 3, T3.5)
- Dependencies: T2.3 (гейт G), T2.5 (гейт G3) — оба должны быть пройдены (T2.4 — доказательства, входят в единицу T2.4 + T2.5)
- Provides: аудит `/api/threads/:threadId` с id из маршрута — для T6.2 (итоговый прогон)
- Parallel: T3.5 ‖ T3.1–T3.4 (файлов не пересекает)
- Size: Small (2 файла)
- Covers: Integration Point 3

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
В `AuditInterceptor`: `threadId: params.threadId ?? (params.agentId ? body.threadId ?? body.id : undefined)`; одна запись на запрос сохраняется. Для `POST /api/threads` с телом `{ id: 'x' }` `threadId` остаётся `undefined`.

## Target Files
- [x] `apps/api/src/audit/audit.interceptor.ts`
- [x] `apps/api/src/audit/audit.interceptor.spec.ts` (new)

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации. `apps/api/src/audit/audit.service.ts` не меняется.

## Investigation Targets
- `apps/api/src/audit/audit.interceptor.ts` (текущее выражение `threadId`)
- `apps/api/src/audit/audit.service.ts`, `apps/api/src/audit/audit.module.ts` (читать, не менять)
- `docs/features/chat-shell/design-threads-api.md` (§ Interface Change Matrix, § Integration Point 3)

## Change Category
`Change Category: state-change, boundary-change`

Исполнитель проверяет смежные пути: все маршруты с `params.agentId` и без него, наличие/отсутствие `req.user`.

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Interface Change Matrix) | derived-display | `params.threadId ?? (params.agentId ? body.threadId ?? body.id : undefined)` | Y, если `threadId` аудита вычисляется ровно этим выражением (тело `{ id }` не подменяет id маршрута) |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Запись без `req.user` | `record` не вызывается (как раньше) | work plan T3.5 |

## Investigation Notes
- Наблюдения (до реализации): `audit.interceptor.ts` писал `threadId: body.threadId ?? body.id` для всех маршрутов, тело приводилось `as { threadId?; id? }`. `audit.service.ts`/`audit.module.ts` — только чтение (глобальный `APP_INTERCEPTOR`). Маршруты с перехватчиком: `POST /api/chat/:agentId` (`params.agentId`), `GET /api/threads` (без параметров), `GET /api/threads/:threadId`, `GET /api/threads/:threadId/messages`; будущие `POST /api/threads`, `PATCH`/`DELETE /api/threads/:threadId` подпадают под то же выражение.
- Зависимости: T2.3/T2.5 отмечены выполненными в плане; deliverables перехватчика не затрагивают.
- План подхода (Reference Contract): `threadId = asString(params.threadId) ?? (agentId ? bodyThreadId(body) : undefined)`, где `bodyThreadId` = `body.threadId ?? body.id` с сужением `unknown` через `typeof`/`in` (убран `as`-каст); `asString` отбрасывает не-строки, чтобы не нарушать `AuditEvent.threadId: string`. Одна запись `record` на запрос; без `req.user` — `record` не вызывается.
- Compliance Check: **Y** — итоговая реализация вычисляет ровно `params.threadId ?? (params.agentId ? body.threadId ?? body.id : undefined)`; доказательство — `audit.interceptor.spec.ts` (6 кейсов): `/threads/:threadId` с телом `{ id, threadId }` → `'t-route'`; `/threads/:threadId/messages` → `'t-route'`; `/chat/:agentId` `{ threadId, id }` → `'t-chat'`, `{ id }` → `'t-chat-id'`; `POST /api/threads` `{ id: 'x' }` → `undefined`; без `req.user` → `record` не вызван. RED: 3 кейса падали на старом выражении (`'x'`/тело вместо маршрута).
- Adjacent Case Sweep: маршруты с/без `params.agentId` и с/без `req.user` покрыты таблицей; не-строковый `params`/body id → `undefined` (сужение типа). Остаток вне scope: фактическая запись `audit_events.thread_id` — T6.2.
- `audit.service.ts` не изменён (`git diff --exit-code` пуст).

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
- **Verification method**: unit `audit.interceptor.spec.ts` (test-first).
- **Success criteria**: `/threads/:threadId` — записан id маршрута, тело `{ id }` его не подменяет; `/chat/:agentId` — `body.threadId ?? body.id` (как раньше); `POST /api/threads` с телом `{ id: 'x' }` — `threadId` `undefined`; без `req.user` — `record` не вызван; `audit.service.ts` не изменён.
- **Failure response**: расхождение с выражением Design Doc — править реализацию.
- **Verification level**: L2.

## Proof Obligations
### Obligation: Integration Point 3 (аудит)
- **Claim**: id беседы в аудите берётся из маршрута для `/threads/:threadId` и из тела — только для `/chat/:agentId`.
- **Primary failure mode**: тело запроса подменяет id маршрута (клиент пишет аудит чужой беседы); `POST /api/threads` пишет клиентский `id`.
- **Boundary to exercise**: in-process unit (перехватчик с фейковым `AuditService`).
- **State assertion**: N/A.
- **Mock boundary rationale**: `AuditService` мокается — внешняя запись в БД аудита.
- **Residual**: фактическая запись в `audit_events` проверяется итоговым прогоном (T6.2).

### Obligation: Failure Mode: no-op (аудит `POST /api/threads` без `threadId`)
- **Claim**: при отсутствии `threadId` запись создаётся без него.
- **Primary failure mode**: `threadId` = `'x'` из тела.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: как выше.
- **Residual**: нет.

## Completion Criteria
- [x] Unit зелёный, прогон содержательный
- [x] `audit.service.ts` не изменён (`git diff --exit-code apps/api/src/audit/audit.service.ts` пуст)
- [x] Compliance Check = `Y`, доказательство в Investigation Notes
- [x] lint/tsc/prettier/unit/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: аудит всех маршрутов с `AuditInterceptor`.
- Scope boundary: `audit.service.ts`, `audit.module.ts` не меняются.
