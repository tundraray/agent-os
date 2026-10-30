# Task T8.1: Итоговые гейты, проверка AC, аудит тестов

Metadata:
- Task type: frontend (apps/web) — гейты и ревью; код меняется только при находках
- Phase: 8 — Quality Assurance (шаг 11 DD)
- Dependencies: task-T7.1, T7.2, T7.3, T7.4, T7.5 (все предыдущие фазы завершены)
- Provides: зелёные итоговые гейты и заполненная таблица «Проверка AC» (часть T8.1) для T8.3
- Size: Small (изменений нет, кроме исправлений по находкам)
- Commit: manual — единица коммита возникает только при исправлениях; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 (`POSTGRES_PORT=5433 pnpm db:up`, `postgres://agent:agent@localhost:5433/agent_os`) для turbo-тестов, которым нужен `apps/api`.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Прогнать все итоговые гейты, проверить версии и отсутствие остатков прототипа, проверить бюджет тестов и инвариант Element 1 (код-ревью `ShellStatus`), заполнить таблицу AC. Migration Strategy DD: слияние в `main` вместе с `threads-api` — проверка ветки и атрибуции.

## Target Files
- [ ] Только исправления по находкам (файлы определяются находкой; любое исправление вне изменённых ранее файлов — записать в Notes и согласовать с оркестратором); иначе изменений нет

## Investigation Targets
- `apps/web/src/lib/threads/shell-status-store.ts`
- `apps/web/package.json`, корневой `package.json`, `turbo.json`
- `apps/web/src/**/*.test.{ts,tsx}` (бюджет тестов)
- `git log main..HEAD` (чтение)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Minimal Surface, Element 1) | state-lifecycle-negative | «Инвариант: стор не дублирует данные рантайма (список, заголовки, сообщения, `isRunning`, текущая беседа).» | Y, если состояние `ShellStatus` — ровно `history`, `loadMoreFailed`, `titleWaiting`, `activityAt` и их сеттеры |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Сомнение в бюджете тестов | Запустить `test-auditor` (только отчёт) | План T8.1 |
| Спецификатор `ai` | Проверка `pnpm why -r ai` — отступление от DD закрыто решением пользователя | Открытые вопросы плана п. 2 |
| Просмотр `git log main..HEAD` | Только чтение (не `git checkout`/`stash`) | Стратегия manual |

## Investigation Notes
(Результаты команд и ревью записать здесь и в Notes плана.)

## Implementation Steps
### 1. Гейты (все — 0 ошибок)
- [ ] `pnpm --filter web lint`; `pnpm --filter web exec tsc --noEmit`; `pnpm --filter web test`; `pnpm --filter web build`; `pnpm build`; `pnpm test` (turbo)
- [ ] `it.todo`/`it.skip` в `apps/web/src` — 0 (поиск)
- [ ] `pnpm why -r ai` — `apps/web` 7.0.155, `apps/api` 7.0.148
- [ ] Версии `@assistant-ui/*`, `assistant-stream` — точные (без `^`)
- [ ] Поиск `components/assistant` и `app/page.tsx` — пуст

### 2. Ревью
- [ ] Бюджет тестов (Test Selection): 10 интеграционных, ни один тест не дублирует дефект другого (при сомнении — `test-auditor`)
- [ ] Инвариант Element 1 (`shell-status-store.ts`) — по Reference Contract
- [ ] Атрибуция: `git log main..HEAD` без `Co-Authored-By`/`Claude`

### 3. Таблица «Проверка AC»
- [ ] Заполнить колонку «Результат» (таблица ниже; L1-часть дополняет T8.3)

#### Проверка AC

| AC | Проверка | Задача | Результат |
|---|---|---|---|
| AC-01.1 | U `group-threads-by-date`, C | T4.1, T4.2 | [ ] |
| AC-01.2 | C, L1-1 | T4.2, T8.3 | [ ] |
| AC-01.3 / 01.4 | C | T4.2 | [ ] |
| AC-01.5 / 01.7 | C, I `shell.list` | T4.2 | [ ] |
| AC-01.6 | C | T4.2, T5.1 | [ ] |
| AC-02.1 / 02.3 / 02.4 | U, L1-4 | T2.2, T8.3 | [ ] |
| AC-02.2 | U, I `shell.open-thread` (прямая ссылка; F5) | T3.4, T4.2 | [ ] |
| AC-02.5 | U, C, I `shell.open-thread` | T2.2, T3.4, T4.2 | [ ] |
| AC-02.6 / 03.4 | S-1, L1-6 (без автотеста) | T1.3, T8.3 | [ ] |
| AC-03.1 | U, C, L1-1, L1-3 | T4.3, T8.3 | [ ] |
| AC-03.2 / 03.3 / 04.1 | I `shell.new-chat`, U, L1-1 | T2.3, T4.3, T8.3 | [ ] |
| AC-04.2 / 04.4 | S-2, L1-5 | T1.3, T8.3 | [ ] |
| AC-04.3 | U, I, L1-7 | T2.2, T3.4, T8.3 | [ ] |
| AC-05.1…05.3 | C, L1-2 | T5.1, T8.3 | [ ] |
| AC-05.4 | U, S-6 (L1-2) | T2.2, T8.3 | [ ] |
| AC-06.1 / 06.3 | C, L1-2 | T5.2, T8.3 | [ ] |
| AC-06.2 | I `shell.delete-open-thread`, L1-2 | T5.2, T8.3 | [ ] |
| AC-06.4 | L1-7 | T8.3 | [ ] |
| AC-07.1…07.3 | C `chat-header`, L1-1 | T3.3, T8.3 | [ ] |
| AC-08.1 / 08.3 / 08.4 | L1-1, L1-4, L1-6 | T8.3 | [ ] |
| AC-08.2 | C, L1-1 | T4.3, T8.3 | [ ] |
| AC-08.5 / 08.5a / 08.5c / 08.5d | C `message-error`, L1-10 | T7.3, T8.3 | [ ] |
| AC-08.5b | I `shell.message-error`, L1-10 | T7.3, T8.3 | [ ] |
| AC-08.5e | C, I `shell.deleted-thread`, L1-7 | T7.3, T8.3 | [ ] |
| AC-08.6 | C `message-actions`, L1-10 | T7.2, T8.3 | [ ] |
| AC-14.5 (клиент) | C `tool-fallback-error`, L1-10 | T7.4, T8.3 | [ ] |
| AC-14.6 (клиентская сторона) | L1-10 | T8.3 | [ ] |
| AC-09.1…09.4 | C `user-menu`, L1-8 | T3.2, T8.3 | [ ] |
| AC-10.1…10.4 | C (S-11), L1-3 | T3.1, T8.3 | [ ] |
| AC-11.1 / 11.3 | I `shell.workspace`, L1-1 | T5.3, T8.3 | [ ] |
| AC-11.2 / 11.4 | L1-1 | T8.3 | [ ] |
| AC-12.1 / 12.2 | `pnpm --filter web test` ≥ 8 тестов в 4 областях, без API | T2.1–T4.2, T8.1 | [ ] |
| AC-19.1 | U, C, браузер (сид страниц) | T4.1, T6.1, T8.3 | [ ] |
| AC-20.1 | U, L1-1 | T2.3, T8.3 | [ ] |
| AC-21.1 | L1-1 | T8.3 | [ ] |
| AC-22.1 / 22.2 | U, C, L1-9 | T4.2, T6.2, T8.3 | [ ] |
| Метрики № 7, № 10 (`threads-api` T6.3) | T6.3-b, T6.3-a | T8.4 | [ ] |

## Quality Assurance Mechanisms
- ESLint, `tsc`, Vitest, `next build`, turbo `test` → `^build` — Type: `executable_check`
- Точные версии; `ai` не меняется — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: перечисленные команды и ревью.
- **Success criteria**: все гейты — 0 ошибок; инвариант Element 1 проверен; таблица заполнена (AC, закрываемые только L1, остаются `[ ]` до T8.3).
- **Failure response**: находки — исправить минимально и повторить гейты; находки, требующие изменения плана, — эскалация оркестратору.
- **Verification level**: L2/L3.

## Proof Obligations
### Obligation: Element 1 — `ShellStatus` не дублирует данные рантайма
- **Claim**: состояние стора — ровно `history`, `loadMoreFailed`, `titleWaiting`, `activityAt` + сеттеры.
- **Primary failure mode**: в стор попали список, заголовки, сообщения, `isRunning` или текущая беседа (двойной источник истины).
- **Boundary to exercise**: код-ревью (не тест — инвариант структуры; Test Selection запрещает тест формы типа).
- **State assertion**: N/A.
- **Mock boundary rationale**: N/A.
- **Proven by**: `existing/review: код-ревью shell-status-store.ts` (тест не пишется).
- **Residual**: нет.

## Completion Criteria
- [ ] Все гейты — 0 ошибок
- [ ] Инвариант Element 1 проверен ревью
- [ ] Таблица «Проверка AC» заполнена (по T8.1-части)
- [ ] Результаты в Notes плана
- [ ] `git log main..HEAD` без `Co-Authored-By`/`Claude`

## Notes
- Impact scope: вся `apps/web`.
- Scope boundary: `apps/api`, `packages/contracts` — не менять.
