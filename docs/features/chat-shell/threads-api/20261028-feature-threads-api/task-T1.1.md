# Task T1.1: Контракты `threads.ts`, re-export, сборка и `contracts.spec.ts`

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 1, T1.1)
- Dependencies: none (первая задача плана)
- Provides: `@agent-os/contracts` (dist) со схемами `threads.ts` — для T1.2, T1.3, T2.x и далее
- Size: Small (3 файла)
- Covers: AC-18.1, AC-18.3

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
Схемы и константы ровно по разделу «Contract Definitions» Design Doc: константы `THREAD_PAGE_SIZE`, `THREAD_TITLE_MAX_LENGTH`, `GENERATED_THREAD_TITLE_MAX_LENGTH`, `ThreadIdSchema`, `ThreadSummarySchema`, `ThreadListQuerySchema`, `ThreadListResponseSchema`, `RenameThreadRequestSchema`, `HistoryMessage*Schema`, `ThreadMessagesResponseSchema`, `ThreadsErrorCodeSchema`, `ApiErrorSchema`. В `packages/contracts/src/index.ts` добавляется ровно одна строка в конец: `export * from './threads.js';`. `ChatRequestSchema` не меняется.

## Target Files
- [x] `packages/contracts/src/threads.ts` (new)
- [x] `packages/contracts/src/index.ts` (одна строка в конец)
- [x] `apps/api/src/threads/contracts.spec.ts` (new)

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Contract Definitions, § Test Strategy / Unit)
- `packages/contracts/src/index.ts` (`ChatRequestSchema` — текущие фикстуры и поведение)
- `packages/contracts/package.json`, `packages/contracts/tsconfig.json` (ESM, dist, `.js`-суффиксы)
- `apps/api/vitest.config.ts` (где подхватываются `**/*.spec.ts`)

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Contract Definitions, `threads.ts`) | structure-order | `export const THREAD_PAGE_SIZE = 20;` | Y, если `threads.ts` содержит эту строку дословно |
| design-threads-api.md (§ Contract Definitions, `threads.ts`) | structure-order | `export const THREAD_TITLE_MAX_LENGTH = 200;` / `export const GENERATED_THREAD_TITLE_MAX_LENGTH = 80;` | Y, если обе константы объявлены с этими именами и значениями |
| design-threads-api.md (§ Contract Definitions) | structure-order | `export const ThreadsErrorCodeSchema = z.enum(['THREAD_NOT_FOUND', 'VALIDATION_FAILED', 'INVALID_CURSOR']);` | Y, если enum содержит ровно эти три кода в этом порядке |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Путь unit-теста контрактов | `apps/api/src/threads/contracts.spec.ts` (в Design Doc не указан) | work plan, Notes «Происхождение Target Files» |
| Порядок `.trim()` и `.max()` в `RenameThreadRequestSchema` | `.trim()` стоит до `.max()` (обрезка до проверки длины) | work plan T1.1, Proof obligations |

## Investigation Notes
- Наблюдения: `packages/contracts` — ESM (`"type": "module"`), `tsc` → `dist/`, `NodeNext` (re-export с суффиксом `.js`); `ChatRequestSchema` = `{ id?: string.min(1), threadId?: string.min(1), messages: unknown[] }`; `apps/api/vitest.config.ts` подхватывает `**/*.spec.ts` с `globals: true`, поэтому `src/threads/contracts.spec.ts` попадает в `pnpm --filter api test`; стиль спеков — как `src/mastra/models.spec.ts` (глобальные `describe/it/expect`). Зависимостей-deliverables нет (первая задача).
- План подхода: `threads.ts` переносится дословно из DD § Contract Definitions (включая `.trim()` до `.max()`); в `index.ts` в конец добавлена одна строка `export * from './threads.js';`, `ChatRequestSchema` не тронут; тест импортирует из `@agent-os/contracts` (dist).
- RED: до реализации 13 тестов новых схем падали (`undefined` экспорт), 6 тестов `ChatRequestSchema` проходили — подтверждение, что фикстуры чата фиксируют текущее поведение.
- Compliance Check (по финальной реализации):
  - `export const THREAD_PAGE_SIZE = 20;` — **Y** (`threads.ts:4`, дословно).
  - `THREAD_TITLE_MAX_LENGTH = 200` / `GENERATED_THREAD_TITLE_MAX_LENGTH = 80` — **Y** (`threads.ts:6`, `threads.ts:8`; тест `thread constants`).
  - `ThreadsErrorCodeSchema = z.enum(['THREAD_NOT_FOUND', 'VALIDATION_FAILED', 'INVALID_CURSOR'])` — **Y** (`threads.ts:64`, дословно; тест сверяет `.options` в этом порядке).
- `git diff packages/contracts/src/index.ts`: 1 insertion(+), строка `export * from './threads.js';`.
- Gate prettier: `contracts.spec.ts` чистый; `prettier --check` по `apps/api` падает на 14 существовавших до задачи файлах вне Target Files (строки > 80 символов, напр. `src/main.ts` `enableCors`), включая скелеты `test/*.e2e-spec.ts`. Не исправлялось (вне scope) — передано на этап quality-fixer.

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
- [x] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"` — Target Files чистые; 14 существующих файлов вне scope не проходят (см. Investigation Notes)
- [x] `pnpm --filter api test`
- [x] `pnpm --filter api test:e2e` (если задача затрагивает e2e или HTTP-поверхность) — N/A: задача не затрагивает e2e/HTTP
- [x] `pnpm --filter api build`

## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов, типовые ошибки — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext`, `.js`-суффиксы импортов — Enforces: строгие типы, без `as`-обхода — Config/Source: `apps/api/tsconfig.json`, `packages/contracts/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest unit / e2e (реальный Postgres) — Enforces: поведение и AC — Config/Source: `apps/api/vitest.config.ts`, `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- `nest build` — Enforces: сборка production-кода — Config/Source: `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json` — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`
- `tsc` contracts — Enforces: сборка `@agent-os/contracts` (ESM, dist) — Config/Source: `packages/contracts/package.json` — Type: `executable_check`
- AC-18.3: `ChatRequestSchema` неизменен — Enforces: обратная совместимость тела чата — Config/Source: `packages/contracts/src/index.ts` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: `pnpm --filter @agent-os/contracts build`, затем `pnpm --filter api exec vitest run src/threads/contracts.spec.ts`; `git diff packages/contracts/src/index.ts`.
- **Success criteria**: сборка без ошибок; `contracts.spec.ts` зелёный; diff `index.ts` — ровно одна добавленная строка `export * from './threads.js';`.
- **Failure response**: расхождение схем с Design Doc — править `threads.ts` по DD, не тест; изменение `ChatRequestSchema` недопустимо — эскалация.
- **Verification level**: L2 (тесты) + L3 (сборка).

## Proof Obligations
### Obligation: AC-18.1
- **Claim**: схемы контракта принимают и отклоняют ровно то, что описывает DD.
- **Primary failure mode**: `.trim()` после `.max()` (заголовок из 200 символов с пробелами по краям отклонён) либо `ChatRequestSchema` изменена.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: HTTP-поведение — T1.2 и далее.

Тесты (test-first): `RenameThreadRequestSchema` — `'   '`, `''`, 201 символ отклонены, 200 принят, пробелы по краям обрезаются; `RenameThreadRequestSchema.parse({ title: '  ' + 'a'.repeat(200) + '  ' })` успешен и `title.length === 200`; `ThreadSummarySchema` принимает `title: null`; `ChatRequestSchema` принимает/отклоняет те же фикстуры, что и раньше; `ThreadListResponseSchema` отклоняет 21 элемент.

### Obligation: AC-18.3
- **Claim**: `ChatRequestSchema` и `index.ts` не изменены, кроме одной строки re-export.
- **Primary failure mode**: правка `ChatRequestSchema`.
- **Boundary to exercise**: in-process unit (фикстуры) + `git diff`.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: `app.e2e-spec.ts` — T1.2, T5.1, T6.2.

## Completion Criteria
- [x] `pnpm --filter @agent-os/contracts build` OK
- [x] `contracts.spec.ts` зелёный, прогон содержательный (нет always-true, нет 0-match)
- [x] `git diff packages/contracts/src/index.ts` = одна добавленная строка
- [x] Каждый Compliance Check = `Y` по финальной реализации, доказательства в Investigation Notes
- [x] Gates (lint, tsc, prettier, unit, build) — ноль ошибок в Target Files (prettier: предсуществующие нарушения вне scope, см. Investigation Notes)
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: все последующие задачи импортируют `@agent-os/contracts`.
- Scope boundary: `ChatRequestSchema` и остальной `index.ts` не меняются; `apps/api/test/app.e2e-spec.ts` не меняется.
