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
- [ ] `apps/api/src/audit/audit.interceptor.ts`
- [ ] `apps/api/src/audit/audit.interceptor.spec.ts` (new)

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
(Заполняется исполнителем до реализации: план подхода и результат Compliance Check.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать все Investigation Targets, записать наблюдения в Investigation Notes
- [ ] Просмотреть deliverables зависимостей (см. Metadata)
- [ ] Сверить контракты (Reference Contracts) с Design Doc, записать план подхода в Investigation Notes
- [ ] Написать падающие тесты (unit — test-first; e2e — наполнить `it.todo` скелета по его комментариям Arrange/Act/Assert, ожидаемые значения — литералы, пустые заглушки запрещены)
- [ ] Запустить тесты и убедиться, что они падают по правильной причине (см. Proof Obligations)

### 2. Green Phase
- [ ] Добавить минимальную реализацию
- [ ] Запустить только добавленные тесты, убедиться, что они проходят

### 3. Refactor Phase
- [ ] Улучшить код, не меняя поведения
- [ ] Повторно запустить добавленные тесты

### 4. Gates (все — ноль ошибок; перед vitest после правки `packages/contracts` — `pnpm --filter @agent-os/contracts build`; перед e2e — `pnpm db:up` и `apps/api/.env` с `DATABASE_URL`)
- [ ] `pnpm --filter api lint`
- [ ] `pnpm --filter api exec tsc --noEmit -p tsconfig.json`
- [ ] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`
- [ ] `pnpm --filter api test`
- [ ] `pnpm --filter api test:e2e` (если задача затрагивает e2e или HTTP-поверхность)
- [ ] `pnpm --filter api build`

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
- [ ] Unit зелёный, прогон содержательный
- [ ] `audit.service.ts` не изменён (`git diff --exit-code apps/api/src/audit/audit.service.ts` пуст)
- [ ] Compliance Check = `Y`, доказательство в Investigation Notes
- [ ] lint/tsc/prettier/unit/build — ноль ошибок
- [ ] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: аудит всех маршрутов с `AuditInterceptor`.
- Scope boundary: `audit.service.ts`, `audit.module.ts` не меняются.
