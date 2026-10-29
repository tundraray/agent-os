# Task T3.4: `PATCH /api/threads/:threadId` (rename под lock) + `threads.service.spec.ts` + e2e 15.x, 13.2a, 13.3

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 3, T3.4)
- Dependencies: T3.2 → Deliverable: `ThreadWriteLock`; T3.3 → Deliverable: `create`/`delete` маршруты и их e2e; T2.5 → Deliverable: `threads.service.spec.ts` (создан в T2.5 с таблицей `discardRepliesAfter`, фейковым `Memory` и тестовой обвязкой — T3.4 дополняет файл, не пересоздаёт)
- Provides: `ThreadsService.rename` (под `ThreadWriteLock`), `PATCH`-маршрут — для T4.3 (AC-17.2 нужен `PATCH`)
- Size: Medium (4 файла)
- Covers: AC-15.1, AC-15.2, AC-15.3, AC-13.2a (e2e), AC-13.3

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
`rename({ threadId, userId, title })` по фрагменту Design Doc: захват `ThreadWriteLock` по `threadId` → `getOwnedThread` → `updateThread`; ошибка `MastraError` категории `USER` (`isMastraUserError`) → 404 `THREAD_NOT_FOUND`; иначе перечитывание `getThreadById(...).catch(() => undefined)`: `null` → 404, прочее → выбрасывается исходная ошибка `updateThread`. Тело — `RenameThreadRequestSchema` через `ZodValidationPipe`. Все шесть маршрутов `/api/threads*` под `SessionGuard` (AC-13.3).

## Target Files
- [ ] `apps/api/src/threads/threads.service.ts`
- [ ] `apps/api/src/threads/threads.service.spec.ts` (файл существует с T2.5 — **дополняется** кейсами `rename`/`getOwnedThread`; кейсы `discardRepliesAfter` не менять и не дублировать)
- [ ] `apps/api/src/threads/threads.controller.ts`
- [ ] `apps/api/test/threads.e2e-spec.ts`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Data Contract rename, § Error Handling, § Element 3 Step 1, § Test Strategy `threads.service.spec.ts`, AC-13.3, AC-15.x)
- `apps/api/test/threads.e2e-spec.ts` (скелет: `AC-15.1`, `AC-15.2`, `AC-15.3`, `AC-13.2a`, `AC-13.3`)
- `apps/api/src/threads/threads.errors.ts`, `thread-write-lock.ts`, `thread-cursor.ts`, `threads.service.ts`, `threads.controller.ts`
- `apps/api/src/auth/session.guard.ts` (поведение в `NODE_ENV=production` без пользователя)
- `apps/api/test/support/*`

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Code Inspection Evidence, находка 7) | structure-order | `{"message":"Thread not found","error":"Not Found","statusCode":404,"errorCode":"THREAD_NOT_FOUND"}` | Y, если `PATCH` чужой/несуществующей беседы возвращает точно этот 404 |
| design-threads-api.md (§ Contract Definitions, `threads.ts`) | structure-order | `export const THREAD_TITLE_MAX_LENGTH = 200;` / `export const GENERATED_THREAD_TITLE_MAX_LENGTH = 80;` | Y, если 201-символьный заголовок отклоняется, 200 принимается (лимит из `THREAD_TITLE_MAX_LENGTH`) |
| design-threads-api.md (§ Test Strategy, `thread-cursor.spec.ts`) | state-lifecycle-negative | «поднятый id отсутствует в страницах 3–6; объединение страниц 1–6 равно 119 id (все 120, кроме поднятого; удалённый id присутствует только на странице 1, выданной до удаления) без повторов; страницы 3–6 содержат ровно 79 оставшихся id (позиции 41–120 исходного порядка без поднятого) и не содержат удалённый id; страница 6 содержит 19 элементов и `nextCursor: null`» | Y, если e2e `AC-13.2a` проверяет эти литералы на реальной БД |
| design-threads-api.md (§ Test Strategy, `threads.e2e-spec.ts` 13.2a) | state-lifecycle-negative | «следующий запрос первой страницы без `cursor` возвращает поднятую беседу первой» | Y, если e2e подтверждает, что свежая первая страница начинается с поднятой беседы |
| design-threads-api.md (§ Test Strategy, `threads.service.spec.ts`) | state-lifecycle-negative | «`updateThread` бросает `new Error('db down')`, а повторное `getThreadById` отклоняется (`new Error('re-read failed')`) → выброшен исходный объект ошибки `updateThread` (`toBe`), не 404 и не ошибка повторного чтения» | Y, если unit-тест проверяет через `toBe`, что выброшен исходный объект `new Error('db down')` |
| design-threads-api.md (§ Element 3 Step 1) | state-lifecycle-negative | «беседа, поднятая или созданная во время обхода, не возвращается в последующих страницах этого обхода (клиент получает её перечитыванием первой страницы)» | Y, если e2e `AC-13.2a` подтверждает это (unit-часть — T3.1) |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| id в e2e `AC-13.2a` | производные литералы от префикса `seed`: удалённая `${p}-t-005`, поднятая `${p}-t-085`; свежая первая страница начинается с `${p}-t-085` с title `'Поднятая'` | work plan T3.4 |
| Повторный `PATCH` тем же значением | 200, тот же `title` (same-value) | work plan, Failure Mode «same-value» |
| Перечитывание после ошибки `updateThread` | `.catch(() => undefined)`: ошибка перечитывания не подменяет исходную | work plan T3.4, Design Doc Data Contract rename |

## Investigation Notes
(Заполняется исполнителем до реализации: план подхода и результат каждого Compliance Check.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать все Investigation Targets, записать наблюдения в Investigation Notes
- [ ] Просмотреть deliverables зависимостей (см. Metadata)
- [ ] Сверить контракты (Reference Contracts) с Design Doc, записать план подхода в Investigation Notes
- [ ] Открыть существующий `threads.service.spec.ts` (T2.5): использовать его фейковый `Memory` и структуру, добавить `describe` для `rename`/`getOwnedThread`
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
- Одна точка проверки владельца (`getOwnedThread`) до `updateThread` — Enforces: нет IDOR — Config/Source: DD «Security Considerations» — Type: `passive_constraint`
- Тело 404 только через `threadNotFound()` — Enforces: неразличимость — Config/Source: `apps/api/src/threads/threads.errors.ts` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: unit `threads.service.spec.ts` (фейковый `Memory`) + e2e на реальном Postgres; полный параллельный прогон `pnpm --filter api test:e2e` (подтверждение глобальной уникальности id из T1.3).
- **Success criteria**: unit — `MastraError` категории `USER` → 404; прочая ошибка при существующей беседе → та же ошибка; перечитывание → `null` → 404; `new Error('db down')` + перечитывание отклонено `new Error('re-read failed')` → выброшен исходный объект (`toBe`); `getOwnedThread` при `null` → `NotFoundException` с телом `threadNotFound().getResponse()`; повторный `rename` тем же значением → тот же `title`. e2e (5) — `AC-15.1: saves the trimmed title …`; `AC-15.2: missing, empty, whitespace-only and 201-char titles are rejected …`; `AC-15.3: PATCH of a foreign or missing thread …`; `AC-13.2a: deleting a page-1 thread and raising a page-5 thread between pages 2 and 3 yields 119 unique ids …`; `AC-13.3: every /api/threads* route answers 401 when NODE_ENV=production`.
- **Failure response**: сбой 13.3 на любом маршруте — добавить guard, не исключать маршрут из теста.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-13.2a (e2e)
- **Claim**: удаление беседы страницы 1 и подъём беседы страницы 5 между страницами 2 и 3 дают 119 уникальных id; поднятая не повторяется; свежая первая страница начинается с поднятой.
- **Primary failure mode**: повторная выдача поднятой беседы или пропуск любой из 79 оставшихся.
- **Boundary to exercise**: HTTP → реальный Postgres (`PATCH` как «подъём» через обновление `updatedAt`).
- **State assertion**: обход страниц 1–2 → `DELETE ${p}-t-005`, `PATCH ${p}-t-085` → страницы 3–6 → литералы 119 / 79 / 19.
- **Mock boundary rationale**: none.
- **Residual**: нет.

### Obligation: AC-15.1 / AC-15.2 / AC-15.3
- **Claim**: заголовок сохраняется обрезанным; пустой/пробельный/201-символьный/отсутствующий отклоняется 400 `VALIDATION_FAILED` без изменения беседы; чужая/несуществующая → 404.
- **Primary failure mode**: принят заголовок в 201 символ либо беседа изменена после 400.
- **Boundary to exercise**: HTTP.
- **State assertion**: после каждого 400 `GET /api/threads/:id` возвращает прежний `title`.
- **Mock boundary rationale**: none.
- **Residual**: гонка с автозаголовком — T4.2, T4.3.

### Obligation: AC-13.3
- **Claim**: все шесть маршрутов `/api/threads*` отвечают 401 в production без аутентификации.
- **Primary failure mode**: хотя бы один маршрут без `SessionGuard`.
- **Boundary to exercise**: HTTP при `NODE_ENV=production`.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: нет.

### Obligation: Failure Mode: unavailable boundary (rename)
- **Claim**: при ошибке хранилища выбрасывается исходная ошибка, а не 404 и не ошибка перечитывания.
- **Primary failure mode**: ошибка перечитывания подменяет исходную; любая ошибка превращается в 404.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: фейковый `Memory` — I/O-граница.
- **Residual**: нет.

## Completion Criteria
- [ ] Unit + 5 e2e зелёные; `it.todo` этих кейсов закрыты (после этой задачи в `threads.e2e-spec.ts` 14/14)
- [ ] Параллельный полный прогон `pnpm --filter api test:e2e` без коллизий id
- [ ] Каждый Compliance Check = `Y`, доказательства в Investigation Notes
- [ ] lint/tsc/prettier/unit/e2e/build — ноль ошибок
- [ ] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `threads.service.ts`/`threads.controller.ts` — последняя в цепочке T2.2 → T2.3 → T2.5 → T3.1 → T3.3 → T3.4; `threads.service.spec.ts` — T2.5 (создание) → T3.4 (дополнение).
- Scope boundary: `threads.module.ts`, `chat/**`, `audit/**`, `app.e2e-spec.ts` не меняются.
