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
- [x] `apps/api/src/threads/thread-cursor.ts` (new)
- [x] `apps/api/src/threads/thread-cursor.spec.ts` (new)
- [x] `apps/api/src/threads/threads.service.ts`
- [x] `apps/api/src/threads/threads.controller.ts`
- [x] `apps/api/test/threads.e2e-spec.ts`

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
**Наблюдения (Investigation Targets)**
- DD § thread-cursor.ts: `encodeThreadCursor`, `decodeThreadCursor` (400 `INVALID_CURSOR`), `selectThreadPage(input)` с `isAfter` на строгих `<`; § Data Contract `ThreadsService.list(userId, cursor?)`; flowchart: курсор проверяется до `listThreads`.
- `threads.service.ts`/`threads.controller.ts` (T2.2–T2.5): `getOwnedThread`, `get`, `listMessages`, `discardRepliesAfter` — не меняются. `toThreadSummary` (mapper) переиспользуется для проекции элементов страницы.
- `test/support/seed.ts`: id вида `${prefix}-t-${nnn}` (префикс `randomUUID()` на вызов), `descendingDates(count, newest, stepMs)`; e2e-литералы скелета (`'a-2'`, `'t-001'`) превращаются в производные от префикса (как в T3.4 плана).
- `ZodValidationPipe` → 400 `VALIDATION_FAILED`; `ThreadListQuerySchema.cursor` ≤ 512 → курсор 513 символов отклоняется в пайпе до декодирования.
- `HttpException` с опцией `{ errorCode }` уже даёт `errorCode` в теле (так работает `threadNotFound()`), поэтому `BadRequestException('Invalid cursor', { errorCode: 'INVALID_CURSOR' })` — ровно по DD.
- Похожих функций (курсор, keyset, сортировка списка бесед) в `apps/api/src` нет — дублирования нет.

**План подхода**
- `thread-cursor.ts` (чистые функции): `encodeThreadCursor` = `Buffer.from(JSON.stringify({ u, i })).toString('base64url')`; `decodeThreadCursor` = base64url → `JSON.parse` → строгая zod-схема `{ u: int, i: string ≥ 1 }`, любой сбой → `BadRequestException('Invalid cursor', { errorCode: 'INVALID_CURSOR' })`; `sortThreadsForList` — копия, порядок `(updatedAt ms DESC, id DESC)` с кодовым сравнением строк (то же сравнение, что в `isAfter`); `selectThreadPage({ sorted, cursor?, size = THREAD_PAGE_SIZE })` — `start` = первый элемент с `isAfter(t, cursor)`, `slice(start, start + size)`, `nextCursor` = есть элементы после страницы ? `encode(последний)` : `null`.
- `ThreadsService.list(userId, cursor?)`: декодирование курсора до обращения к хранилищу → `memory.listThreads({ filter: { resourceId: userId }, perPage: false, orderBy: { field: 'updatedAt', direction: 'DESC' } })` → `sortThreadsForList` → `selectThreadPage({ sorted, cursor, size: THREAD_PAGE_SIZE })` → `toThreadSummary`.
- `ThreadsController.list`: `@Get()` + `@Query(new ZodValidationPipe(ThreadListQuerySchema))`.

**Reference Contracts — Compliance Check (план → финал)**
| # | Contract | Plan | Final | Evidence |
|---|---|---|---|---|
| 1 | `THREAD_PAGE_SIZE = 20` | Y | Y | `size` по умолчанию и в `list` — `THREAD_PAGE_SIZE` из `@agent-os/contracts`; unit «120 → 6 страниц по 20» использует значение по умолчанию |
| 2 | порядок `(updatedAt ms DESC, id DESC)` | Y | Y | `sortThreadsForList`; unit same-value (равные `updatedAt` → id DESC); e2e AC-13.1 `[a-2, a-3, a-1]` |
| 3 | encode base64url(JSON `{u,i}`), `isAfter` строгий `<` | Y | Y | unit: декодирование base64url вручную даёт `{"u":…,"i":…}`; курсор на границе равенства не повторяет и не пропускает элемент (при `<=` тест падает) |
| 4 | литералы 119 / 79 / 19, `nextCursor: null` на стр. 6 | Y | Y | unit AC-13.2a в `thread-cursor.spec.ts` |
| 5 | 6 × 20, 120 уникальных, `nextCursor = null` | Y | Y | unit + e2e AC-13.2 |
| 6 | мусорный курсор → 400 `INVALID_CURSOR` | Y | Y | unit (таблица мусора) + e2e `rejects an unparsable cursor …` |
| 7 | поднятая во время обхода не возвращается | Y | Y | unit AC-13.2a (поднятый id отсутствует в страницах 3–6) |

**Ход TDD**: unit `thread-cursor.spec.ts` написан первым и упал (модуль `thread-cursor.js` отсутствовал); e2e наполнены после реализации маршрута. Итог гейтов: lint 0, tsc 0, prettier — новые/изменённые файлы чистые (8 предсуществующих файлов вне задачи не тронуты), unit 66/66, e2e 13 passed + 16 todo, build OK.

**Adjacent Case Sweep (boundary-change)**: равные `updatedAt` (порядок и курсор на границе), граница ровно 20 (стр. 6 из 120 → `null`), пустой список (`{ threads: [], nextCursor: null }`), курсор удалённой беседы (keyset продолжает со следующей позиции — покрыто AC-13.2a, где курсор стр. 2 не зависит от удаления), курсор 513 символов (пайп). Вне Target Files смежных случаев с тем же дефектом нет.

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
- [x] Unit + 3 e2e скелета + 1 доп. зелёные; `it.todo` этих кейсов закрыты
- [x] Каждый Compliance Check = `Y`, доказательства в Investigation Notes
- [x] lint/tsc/prettier/unit/e2e/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `threads.service.ts`/`threads.controller.ts` — последовательность T2.2 → T2.3 (`listMessages`) → T2.5 (`discardRepliesAfter`, `listMessages`) → T3.1 → T3.3 → T3.4 (не параллелить с ними). Методы T2.5 (`discardRepliesAfter`, вызов `maskHistoryErrors`) не менять.
- Scope boundary: `threads.module.ts`, `audit/**`, `chat/**`, `app.e2e-spec.ts` не меняются.
