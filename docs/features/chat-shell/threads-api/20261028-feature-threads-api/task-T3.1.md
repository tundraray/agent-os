# Task T3.1: `thread-cursor.ts` + `ThreadsService.list` + `GET /api/threads` + e2e

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 3, T3.1)
- Dependencies: T2.3 (гейт G), T2.5 (гейт G3) — оба должны быть пройдены (T2.4 — доказательства, входят в единицу T2.4 + T2.5) → Deliverable: `ThreadsService` (с `discardRepliesAfter` и `maskHistoryErrors`-цепочкой `listMessages` из T2.5), `ThreadsController`, `test/support/*`
- Provides: `encodeThreadCursor`, `decodeThreadCursor`, `selectThreadPage`, `GET /api/threads` — для T3.3, T3.4
- Parallel: T3.1 ‖ T3.2 ‖ T3.5
- Size: Medium (5 файлов)
- Covers: AC-13.1, AC-13.2, AC-13.2a (unit)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
`listThreads({ filter: { resourceId }, perPage: false, orderBy: updatedAt DESC })` → сортировка `(updatedAt ms DESC, id DESC)` в JS → `selectThreadPage({ sorted, cursor, size })` (`size = THREAD_PAGE_SIZE`); query через `ZodValidationPipe(ThreadListQuerySchema)`; мусорный курсор → 400 `INVALID_CURSOR`. Формулировка AC-13.2a — Design Doc v1.3, Element 3 Step 1.

## Target Files
- [ ] `apps/api/src/threads/thread-cursor.ts` (new)
- [ ] `apps/api/src/threads/thread-cursor.spec.ts` (new)
- [ ] `apps/api/src/threads/threads.service.ts`
- [ ] `apps/api/src/threads/threads.controller.ts`
- [ ] `apps/api/test/threads.e2e-spec.ts`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Main Components `thread-cursor.ts`, § Element 3 Step 1, § Contract Definitions `GET /api/threads`, § Test Strategy `thread-cursor.spec.ts`)
- `apps/api/test/threads.e2e-spec.ts` (скелет: `AC-13.1`, `AC-13.2`, `rejects an unparsable cursor …`)
- `apps/api/src/threads/threads.service.ts`, `threads.controller.ts` (T2.2)
- `apps/api/test/support/seed.ts` (T1.3: 120 бесед, карта id)

## Change Category
`Change Category: boundary-change`

Новая граница пагинации: исполнитель проверяет смежные случаи — равные `updatedAt`, граница ровно 20, пустой список, курсор на границе равенства.

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Contract Definitions, `threads.ts`) | structure-order | `export const THREAD_PAGE_SIZE = 20;` | Y, если размер страницы берётся из `THREAD_PAGE_SIZE` (20) |
| design-threads-api.md (§ AC-13.1) | structure-order | «отсортированные по `updatedAt` по убыванию (при равенстве — по `id` по убыванию)» | Y, если порядок `(updatedAt ms DESC, id DESC)`, включая равные `updatedAt` |
| design-threads-api.md (§ thread-cursor.ts) | derived-display | «`encodeThreadCursor(t: { updatedAt: Date; id: string }): string` — base64url(`JSON.stringify({ u: t.updatedAt.getTime(), i: t.id })`)»; «`isAfter(t, c) = t.u < c.u \|\| (t.u === c.u && t.i < c.i)`» | Y, если кодирование и предикат `isAfter` реализованы ровно так (строгие `<`, не `<=`) |
| design-threads-api.md (§ Test Strategy, `thread-cursor.spec.ts`) | state-lifecycle-negative | «поднятый id отсутствует в страницах 3–6; объединение страниц 1–6 равно 119 id (все 120, кроме поднятого; удалённый id присутствует только на странице 1, выданной до удаления) без повторов; страницы 3–6 содержат ровно 79 оставшихся id (позиции 41–120 исходного порядка без поднятого) и не содержат удалённый id; страница 6 содержит 19 элементов и `nextCursor: null`» | Y, если unit-тест проверяет литералы 119 / 79 / 19 и `nextCursor: null` на странице 6 |
| design-threads-api.md (§ AC-13.2) | structure-order | «6 страниц по 20 бесед, объединение которых содержит все 120 `id` без повторов; на последней странице `nextCursor = null`» | Y, если e2e/unit подтверждают 6 страниц × 20, 120 уникальных id, `nextCursor = null` на последней |
| design-threads-api.md (§ thread-cursor.ts) | derived-display | «`BadRequestException('Invalid cursor', { errorCode: 'INVALID_CURSOR' })`» | Y, если мусорный курсор даёт 400 с `errorCode: 'INVALID_CURSOR'` |
| design-threads-api.md (§ Element 3 Step 1) | state-lifecycle-negative | «беседа, поднятая или созданная во время обхода, не возвращается в последующих страницах этого обхода (клиент получает её перечитыванием первой страницы)» | Y, если unit-тест подтверждает это поведение (e2e-часть — T3.4) |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Сортировка | в JS по `(updatedAt ms DESC, id DESC)`, микросекунды усечены до мс; явный вторичный ключ обязателен | work plan, Failure Mode «missing-sort-key ordering» |
| Курсор 513 символов | отклоняется в пайпе `ThreadListQuerySchema` (≤ 512) → 400 `VALIDATION_FAILED` до декодирования | work plan T3.1 (доп. e2e) |
| Пагинация | курсорная, не offset | Design Doc, Alternative 3 |

## Investigation Notes
(Заполняется исполнителем до реализации: план подхода и результат каждого Compliance Check.)

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
- Фильтр `resourceId` в запросе списка — Enforces: нет утечки бесед пользователя B — Config/Source: DD «Security Considerations» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: unit `thread-cursor.spec.ts` (test-first) + e2e `threads.e2e-spec.ts` на реальном Postgres с двумя `x-user-id`.
- **Success criteria**: unit — encode/decode; мусор → 400 `INVALID_CURSOR`; 120 элементов → 6 страниц, 120 уникальных id; граница ровно 20 на 6-й странице → `nextCursor: null`; AC-13.2a литералы 119 / 79 / 19; равные `updatedAt` — порядок по `id` DESC и курсор на границе равенства без дублей; пустой список → `{ threads: [], nextCursor: null }`. e2e (3 из скелета + 1 доп.) — `AC-13.1: returns only the caller's 3 threads ordered by updatedAt DESC`; `AC-13.2: 120 threads are returned as 6 pages of 20 …`; `rejects an unparsable cursor with 400 INVALID_CURSOR`; доп. — `GET /api/threads?cursor=<513 символов>` → 400, `errorCode: 'VALIDATION_FAILED'`.
- **Failure response**: дубли/пропуски при подъёме/удалении — признак offset-логики или `<=` в `isAfter`; исправить реализацию, не ослаблять тест.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-13.1 / AC-13.2
- **Claim**: список изолирован по владельцу, упорядочен и выдаётся 6 страницами по 20 без повторов.
- **Primary failure mode**: offset-пагинация (дубль/пропуск при подъёме/удалении); `isAfter` с `<=`; утечка бесед пользователя B.
- **Boundary to exercise**: HTTP → реальный Postgres; unit на чистых функциях курсора.
- **State assertion**: 120 засеянных бесед → обход 6 страниц → объединение id = 120 уникальных; пользователь B не видит бесед A.
- **Mock boundary rationale**: модель не участвует; хранилище реальное.
- **Residual**: e2e-версия AC-13.2a — T3.4.

### Obligation: AC-13.2a (unit)
- **Claim**: удаление и подъём беседы во время обхода не создают дублей и не возвращают поднятую беседу в последующих страницах.
- **Primary failure mode**: курсор по смещению либо повторная выдача поднятой беседы.
- **Boundary to exercise**: in-process unit (`selectThreadPage`).
- **State assertion**: страницы 1–2 → удаление id со страницы 1 и подъём id со страницы 5 → страницы 3–6 содержат ровно 79 оставшихся id, страница 6 — 19 элементов, `nextCursor: null`; объединение — 119.
- **Mock boundary rationale**: none.
- **Residual**: e2e на реальной БД — T3.4.

### Obligation: Failure Mode: same-value / empty input / invalid option
- **Claim**: равные `updatedAt`, пустой список и мусорный/слишком длинный курсор обработаны.
- **Primary failure mode**: нестабильный порядок при равенстве; 500 на мусоре.
- **Boundary to exercise**: unit + HTTP.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: нет.

## Completion Criteria
- [ ] Unit + 3 e2e скелета + 1 доп. зелёные; `it.todo` этих кейсов закрыты
- [ ] Каждый Compliance Check = `Y`, доказательства в Investigation Notes
- [ ] lint/tsc/prettier/unit/e2e/build — ноль ошибок
- [ ] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `threads.service.ts`/`threads.controller.ts` — последовательность T2.2 → T2.3 (`listMessages`) → T2.5 (`discardRepliesAfter`, `listMessages`) → T3.1 → T3.3 → T3.4 (не параллелить с ними). Методы T2.5 (`discardRepliesAfter`, вызов `maskHistoryErrors`) не менять.
- Scope boundary: `threads.module.ts`, `audit/**`, `chat/**`, `app.e2e-spec.ts` не меняются.
