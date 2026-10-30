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
- [x] Только исправления по находкам (тестовые файлы — по решению оркестратора об отчёте test-auditor, см. Investigation Notes) (файлы определяются находкой; любое исправление вне изменённых ранее файлов — записать в Notes и согласовать с оркестратором); иначе изменений нет

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
Результаты команд и ревью — в Notes плана, Phase 8 (T8.1). Кратко: все гейты 0; `pnpm build` целиком не запускался (`nest build` с `deleteOutDir` удалил бы `apps/api/dist` работающего API на :4000) — заменён на `pnpm build --filter=web...` + `tsc -p tsconfig.build.json --noEmit` для api; Element 1 — Y; атрибуция чистая.

Orchestrator decision on the T8.1 test-budget audit (verbatim):
> APPLY:
> 1. Confirmed duplicates: in thread-history-list.test.tsx (describe 'ThreadHistoryItem — title') delete 'a truncated title shows the full title in a tooltip on hover' and 'a thread without a title reads «Новая беседа»' (covered in thread-history-item.test.tsx); MOVE 'a title that fits shows no tooltip' into thread-history-item.test.tsx.
> 2. Drops: delete-thread-dialog 'Esc is «Отмена»' (base-ui default behaviour — but FIRST confirm the Esc→focus-back-to-«⋯» behaviour is asserted elsewhere; if this test is the only proof of focus return on Esc, keep it and say so); retry-gate 'drop after release leaves the already resolved waiter resolved' (cannot fail); thread-list-adapter 'archive is rejected' (asserts a stub).
> 3. Lossless table merges: message-actions clipboard pair, tool-fallback-error pair, markdown-policy cases, AC-06.3 pair; chat-header 'pending…' into 'text…' as a table row; three group-threads-by-date tests (empty list, sorting, no sort keys) into one table; message-error case 3 Space row may stay as a table row (cheap, AC-08.5a keyboard).
> KEEP: the coarse row of shell.delete-open-thread (only case that catches a hard-coded composer.focus()); app-sidebar.test.tsx, thread-activity-tracker.test.tsx and the i18n 'new chat and the conversation menus' case (full-stack component tests, each with a unique defect) — record them in the plan's budget section as full-stack component tests beyond the 10 integration exception, with their unique defects, for the user's attention.
> ALSO: fix the plan's defect table — the 'AC-04.1 + AC-03.3' integration test does not catch 'new-thread lifting not wired' (a new thread with no lastMessageAt lands first anyway, group-threads-by-date.ts:35); that defect is caught by thread-activity-tracker.test.tsx. Update the outdated '10 it.todo in 7 files' header comment in the 7 shell.*.int.test.tsx files to reflect they are filled. Record that the full `pnpm build` substitute (pnpm build --filter=web... + api tsc -p tsconfig.build.json --noEmit) is accepted because nest build deleteOutDir would delete the running API's dist; the full build runs when the stand is stopped.

Итог — исполнение решения (2026-10-30, Fix Mode): (1) из `thread-history-list.test.tsx` удалён describe «ThreadHistoryItem — title» (2 дубля), «a title that fits shows no tooltip on hover» перенесён в `thread-history-item.test.tsx` (те же заглушки `scrollWidth`/`clientWidth` 120/200, то же утверждение); (2) «Esc is «Отмена»» удалён: проверка показала, что он **не** утверждал возврат фокуса на «⋯» (только закрытие и отсутствие `onConfirm`), то есть не был доказательством возврата фокуса по Esc; возврат фокуса через `finalFocus` доказывает ««Отмена» closes without confirming and returns focus to «⋯»», а возврат именно по Esc автотестом нигде не утверждается — остаётся за L1-2 (T8.3); удалены `retry-gate` «drop after release…» и `thread-list-adapter` «archive is rejected»; (3) табличные слияния `it.each` (каждая строка — отдельный случай; утверждения не ослаблены, часть строк получила утверждения соседа): `message-actions` буфер обмена (2 строки), `tool-fallback-error` incomplete/error (2 строки; строка без значения ошибки теперь также проверяет отсутствие `alert`), `markdown-policy` (`linkPolicy` — 13 строк, `isRenderableImageSrc` — 5 строк), AC-06.3 (2 строки; строка «последняя ссылка» теперь также проверяет имя диалога и `onDelete` ровно один раз с `{id, title}`), `chat-header` text/pending (строка pending теперь также проверяет `tabindex=-1` и `data-shell-focus`), `group-threads-by-date` «ordering» (пустой список, сортировка, без ключей — 3 строки); `message-error` случай 3 уже был `it.each` — без изменений; строка `coarse` `shell.delete-open-thread` сохранена; (4) заголовки 7 файлов `shell.*.int.test.tsx`: «10 tests in 7 files, all implemented — no it.todo left». `thread-list-adapter.test.ts` хранился в репозитории с CRLF — при правке переведён в LF. Счёт тестов: до — 264 случая в 38 файлах (рабочее дерево на момент правок; запись T8.1 выше — 262, разница — два случая в `app-sidebar.test.tsx`, изменённом параллельно), после — 259 (−5: 2 дубля, 3 удаления; перенос и табличные слияния счёт не меняют). Гейты после правок: eslint — 0; `tsc --noEmit` — 0; `vitest run` ×2 — 38 файлов, 259 passed, без нестабильности (предыдущая пара прогонов дала 2 падения в `app-sidebar.test.tsx` во время параллельной правки `app-sidebar.tsx`/теста в 16:53–16:54, которых T8.1 не касалась; после её завершения — зелёный); `next build` — успешно; CR в изменённых файлах — 0; `as` (кроме `as const`) — 0. Полный `pnpm build` заменён на `pnpm build --filter=web...` + `tsc -p tsconfig.build.json --noEmit` для api — замена принята оркестратором (`nest build` с `deleteOutDir` удалил бы `dist` работающего API на :4000); полный `pnpm build` — когда стенд остановлен.

## Implementation Steps
### 1. Гейты (все — 0 ошибок)
- [x] `pnpm --filter web lint`; `pnpm --filter web exec tsc --noEmit`; `pnpm --filter web test`; `pnpm --filter web build`; `pnpm build`; `pnpm test` (turbo)
- [x] `it.todo`/`it.skip` в `apps/web/src` — 0 (поиск)
- [x] `pnpm why -r ai` — `apps/web` 7.0.155, `apps/api` 7.0.148
- [x] Версии `@assistant-ui/*`, `assistant-stream` — точные (без `^`)
- [x] Поиск `components/assistant` и `app/page.tsx` — пуст

### 2. Ревью
- [x] Бюджет тестов (Test Selection): 10 интеграционных подтверждено; отчёт test-auditor исполнен по решению оркестратора (Investigation Notes): 2 дубля удалены, 1 тест перенесён, 3 удалены, 6 табличных слияний; 3 полностековых компонентных теста сохранены и записаны в раздел бюджета плана
- [x] Инвариант Element 1 (`shell-status-store.ts`) — по Reference Contract
- [x] Атрибуция: `git log main..HEAD` без `Co-Authored-By`/`Claude`

### 3. Таблица «Проверка AC»
- [x] Заполнить колонку «Результат» (таблица ниже; L1-часть дополняет T8.3)

#### Проверка AC

| AC | Проверка | Задача | Результат |
|---|---|---|---|
| AC-01.1 | U `group-threads-by-date`, C | T4.1, T4.2 | [x] авто: `group-threads-by-date.test.ts` («AC-01.1: … four labelled groups»), `thread-history-list.test.tsx` (Ready: h2 по порядку) |
| AC-01.2 | C, L1-1 | T4.2, T8.3 | [ ] авто ✓ `thread-history-list.test.tsx` (Ready: `aria-current` только у активной); L1-1 → T8.3 |
| AC-01.3 / 01.4 | C | T4.2 | [x] авто: `thread-history-list.test.tsx` (Loading «Загружаем беседы…», Empty «Пока нет бесед») |
| AC-01.5 / 01.7 | C, I `shell.list` | T4.2 | [x] авто: `thread-history-list.test.tsx` (Error + «Повторить»), `shell.list.int.test.tsx` (AC-01.7 + AC-01.5), `threads-api-client.test.ts` (классификация `invalid_response`) |
| AC-01.6 | C | T4.2, T5.1 | [x] авто: `thread-history-item.test.tsx` (тултип усечённого названия, влезающее название — без тултипа, «Новая беседа») |
| AC-02.1 / 02.3 / 02.4 | U, L1-4 | T2.2, T8.3 | [ ] авто ✓ `thread-history-adapter.test.ts` (линейная цепочка parentId/headId); 02.3 — только L1-4 → T8.3 |
| AC-02.2 | U, I `shell.open-thread` (прямая ссылка; F5) | T3.4, T4.2 | [x] авто: `resolve-main-view.test.ts`, `shell.open-thread.int.test.tsx` («AC-02.2 + AC-04.3», «AC-02.2 (F5)») |
| AC-02.5 | U, C, I `shell.open-thread` | T2.2, T3.4, T4.2 | [x] авто: `thread-history-adapter.test.ts` (500 → `load_failed`, retry), `thread-notice.test.tsx` (load-error), `shell.open-thread.int.test.tsx` («AC-02.5») |
| AC-02.6 / 03.4 | S-1, L1-6 (без автотеста) | T1.3, T8.3 | [ ] S-1 подтверждён в T1.3 (гейт G1); L1-6 → T8.3 (без автотеста по DD) |
| AC-03.1 | U, C, L1-1, L1-3 | T4.3, T8.3 | [ ] авто ✓ `focus.test.ts` (правило указателя), `shell.delete-open-thread.int.test.tsx` (фокус по типу указателя); L1-1, L1-3 → T8.3 |
| AC-03.2 / 03.3 / 04.1 | I `shell.new-chat`, U, L1-1 | T2.3, T4.3, T8.3 | [ ] авто ✓ `shell.new-chat.int.test.tsx` (AC-03.2; AC-04.1 + AC-03.3), `url-sync.test.ts`, `thread-activity-tracker.test.tsx`; L1-1 → T8.3 |
| AC-04.2 / 04.4 | S-2, L1-5 | T1.3, T8.3 | [ ] S-2 подтверждён в T1.3; L1-5 → T8.3 (только L1) |
| AC-04.3 | U, I, L1-7 | T2.2, T3.4, T8.3 | [ ] авто ✓ `thread-history-adapter.test.ts` (404 → `not_found`), `thread-notice.test.tsx` (not-found, фокус на h1), `shell.open-thread.int.test.tsx`; L1-7 → T8.3 |
| AC-05.1…05.3 | C, L1-2 | T5.1, T8.3 | [ ] авто ✓ `thread-history-item.test.tsx` (SB-08: Enter/Esc/пусто/без изменений/blur/200 символов); L1-2 → T8.3 (в dev проверено оркестратором, Phase 5) |
| AC-05.4 | U, S-6 (L1-2) | T2.2, T8.3 | [ ] авто ✓ `thread-list-adapter.test.ts` (PATCH 500 → `renameFailed` + отказ для отката); S-6 / L1-2 → T8.3 |
| AC-06.1 / 06.3 | C, L1-2 | T5.2, T8.3 | [ ] авто ✓ `delete-thread-dialog.test.tsx` (DLG-01), `thread-history-list.test.tsx` (удаление не открытой, фокус на соседнюю); L1-2 → T8.3 |
| AC-06.2 | I `shell.delete-open-thread`, L1-2 | T5.2, T8.3 | [ ] авто ✓ `shell.delete-open-thread.int.test.tsx`; L1-2 → T8.3 |
| AC-06.4 | L1-7 | T8.3 | [ ] только L1-7 → T8.3 |
| AC-07.1…07.3 | C `chat-header`, L1-1 | T3.3, T8.3 | [ ] авто ✓ `chat-header.test.tsx` (HD-02, HD-03 по `HeaderTitle`); L1-1 → T8.3 |
| AC-08.1 / 08.3 / 08.4 | L1-1, L1-4, L1-6 | T8.3 | [ ] только L1 → T8.3 |
| AC-08.2 | C, L1-1 | T4.3, T8.3 | [ ] авто ✓ `thread-welcome.test.tsx`; L1-1 → T8.3 |
| AC-08.5 / 08.5a / 08.5c / 08.5d | C `message-error`, L1-10 | T7.3, T8.3 | [ ] авто ✓ `message-error.test.tsx` (случаи 1–5; 08.5d — только C); L1-10 → T8.3 (L1-10 B (a) в dev — PASS, Phase 7) |
| AC-08.5b | I `shell.message-error`, L1-10 | T7.3, T8.3 | [ ] авто ✓ `shell.message-error.int.test.tsx`; L1-10 → T8.3 |
| AC-08.5e | C, I `shell.deleted-thread`, L1-7 | T7.3, T8.3 | [ ] авто ✓ `message-error.test.tsx` (случай 6), `thread-notice.test.tsx` (deleted), `shell.deleted-thread.int.test.tsx`, `shell-services.test.ts`; L1-7 → T8.3 (в dev — PASS, Phase 7) |
| AC-08.6 | C `message-actions`, L1-10 | T7.2, T8.3 | [ ] авто ✓ `message-actions.test.tsx`; L1-10 → T8.3 |
| AC-14.5 (клиент) | C `tool-fallback-error`, L1-10 | T7.4, T8.3 | [ ] авто ✓ `tool-fallback-error.test.tsx`; L1-10 → T8.3 |
| AC-14.6 (клиентская сторона) | L1-10 | T8.3 | [ ] только L1-10 → T8.3 (серверная часть — владелец `threads-api`) |
| AC-09.1…09.4 | C `user-menu`, L1-8 | T3.2, T8.3 | [ ] авто ✓ `user-menu.test.tsx` (09.1, 09.3 «Системная», 09.4); 09.2 (FOUC) — только L1-8 → T8.3 |
| AC-10.1…10.4 | C (S-11), L1-3 | T3.1, T8.3 | [ ] авто ✓ `app-sidebar.test.tsx` (10.2); 10.1, 10.3, 10.4 и свайп S-11 — только L1-3 → T8.3 |
| AC-11.1 / 11.3 | I `shell.workspace`, L1-1 | T5.3, T8.3 | [ ] авто ✓ `shell.workspace.int.test.tsx`; L1-1 → T8.3 |
| AC-11.2 / 11.4 | L1-1 | T8.3 | [ ] только L1-1 → T8.3 (в dev проверено оркестратором, Phase 5) |
| AC-12.1 / 12.2 | `pnpm --filter web test` ≥ 8 тестов в 4 областях, без API | T2.1–T4.2, T8.1 | [x] T8.1: `vitest run` — 38 файлов, 259 passed (после аудита тестов), 0 todo/skip; сеть — только MSW (`http://api.test`), API не нужен |
| AC-19.1 | U, C, браузер (сид страниц) | T4.1, T6.1, T8.3 | [ ] авто ✓ `group-threads-by-date.test.ts` («AC-19.1: … monotonic»), `thread-history-list.test.tsx` (SB-10), `thread-list-adapter.test.ts` (`loadMoreFailed`); браузер с сидом страниц → T8.3 |
| AC-20.1 | U, L1-1 | T2.3, T8.3 | [ ] авто ✓ `title-poller.test.ts`; L1-1 → T8.3 |
| AC-21.1 | L1-1 | T8.3 | [ ] только L1-1 → T8.3 (в dev — PASS, Phase 3) |
| AC-22.1 / 22.2 | U, C, L1-9 | T4.2, T6.2, T8.3 | [ ] авто ✓ `keyboard-shortcuts.test.ts`, `use-global-shortcuts.test.tsx`, `thread-history-list.test.tsx` (↑/↓, Home/End); L1-9 → T8.3 |
| Метрики № 7, № 10 (`threads-api` T6.3) | T6.3-b, T6.3-a | T8.4 | [ ] → T8.4 |

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
- [x] Все гейты — 0 ошибок
- [x] Инвариант Element 1 проверен ревью
- [x] Таблица «Проверка AC» заполнена (по T8.1-части)
- [x] Результаты в Notes плана
- [x] `git log main..HEAD` без `Co-Authored-By`/`Claude`

## Notes
- Impact scope: вся `apps/web`.
- Scope boundary: `apps/api`, `packages/contracts` — не менять.
