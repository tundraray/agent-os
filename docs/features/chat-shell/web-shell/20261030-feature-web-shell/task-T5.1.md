# Task T5.1: Переименование — меню «⋯» (SB-07), `ThreadTitleField` (SB-08), уведомление об ошибке

Metadata:
- Task type: frontend (apps/web)
- Phase: 5 — операции над беседой (шаги 7–8 DD)
- Dependencies: task-T4.2 → Deliverable: `thread-history-item.tsx`, `thread-history-list.tsx`; T4.3 (`lib/focus.ts`, фокус по клику)
- Provides: `ThreadTitleField`, меню «⋯» (пункт «Удалить» для T5.2), `data-shortcuts-blocked` поле для T6.2
- Size: Small (3 файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Переименование беседы на месте: `SidebarMenuAction` «⋯» с `DropdownMenu` («Переименовать», «Удалить»), поле `ThreadTitleField`, откат и уведомление при ошибке `PATCH` (откат — библиотека, уведомление — адаптер T1.1). AC-05.1–05.4, AC-01.6.

## Target Files
- [x] `apps/web/src/components/shell/thread-title-field.tsx` (new)
- [x] `apps/web/src/components/shell/thread-history-item.tsx`
- [x] `apps/web/src/components/shell/thread-history-item.test.tsx` (new)

## Investigation Targets
- UXRD 6.6, 6.7 (SB-07, SB-08), 7.4; DD «UI Action-API Contract Mapping»
- `apps/web/src/components/shell/thread-history-item.tsx` (T4.2/T4.3), `lib/focus.ts`, `ui/dropdown-menu.tsx`, `ui/input.tsx`
- `apps/web/src/lib/threads/thread-list-adapter.ts` (`rename`, `notify.renameFailed`)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ UI Action-API Contract Mapping) | derived-display | «любая ошибка → откат + «Не удалось переименовать беседу. Попробуйте ещё раз.»» | Y, если текст уведомления дословно совпадает |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Меню | `SidebarMenuAction` «⋯» (`aria-label="Действия с беседой «{название}»"`, `aria-haspopup="menu"`) + `DropdownMenu` «Переименовать», «Удалить» (пункт «Удалить» — `data-highlighted:bg-destructive data-highlighted:text-destructive-foreground`) | План T5.1 |
| Поле | `input aria-label="Название беседы" maxLength={200}`, `data-shortcuts-blocked`; Enter сохраняет обрезанное, Esc отменяет, пусто + Enter → `aria-invalid="true"` и «Введите название» без запроса | План T5.1 |
| Фокус | после сохранения/отмены — ссылка беседы | План T5.1 |
| Ошибка `PATCH` | откат библиотеки + уведомление из адаптера (не дублировать в UI) | План T5.1 |
| Диалог удаления | Не здесь — T5.2 | План |

## Investigation Notes
(Наблюдения по base-ui `DropdownMenu` + возврат фокуса.)
- base-ui `Menu`: «Переименовать» только помечает выбор (ref); поле открывается в `onOpenChangeComplete(false)`, а `finalFocus` возвращает `false` при выбранном переименовании — меню не тянет фокус на «⋯», которая на время редактирования не отрисована (UXRD 6.6 Disabled). Esc/клик вне меню — штатный возврат на «⋯».
- Фокус после сохранения/отмены: флаг + `useEffect` по `editing` → `a[data-thread-link]` этой строки (через ref `li`; ссылка рендерится через `render` тултипа).
- Поле: `autoFocus` + `select()` в `onFocus` (название выделено целиком); повторное завершение (blur после Enter/Esc при размонтировании) отсекается ref-флагом; Esc — `stopPropagation`, чтобы не закрыть шторку; Enter при IME-композиции игнорируется.
- То же название (после обрезки) → `onCancel`, `onRename` не вызывается (Failure Mode same-value); пусто + уход фокуса → отмена.
- Ошибка `PATCH`: адаптер T1.1 уже вызывает `notify.renameFailed` («Не удалось переименовать беседу. Попробуйте ещё раз.» — `shell-services.ts`, дословно) и пробрасывает ошибку; UI уведомление не дублирует. Reference Contract — `Y`.
- Мутации (записано): «пустое название отправляется» (убрана проверка `title === ''`) → краснеет «empty + Enter…»; «то же название отправляется» (убрано `title === initialTitle`) → краснеет «Enter on the unchanged title…». Код восстановлен.
- Блокер: `onRename` — обязательный prop (DD «Props презентационных компонентов»), его передаёт контейнер `ThreadHistoryList` (`thread-history-list.tsx`) и рендер в `thread-history-list.test.tsx` — оба вне Target Files T5.1 → эскалация `out_of_scope_file`.
- Решение оркестратора (вариант 1): Target Files T5.1 расширены на `thread-history-list.tsx` (в `renderItem`: `onRename` → `aui.threads.item({ id: entry.id }).rename(title)`; предложенный `.catch` не нужен: клиентский `rename` в `@assistant-ui/core` 0.3.32 типизирован `void` и сам ловит и логирует отказ — `store/runtime-clients/handle-runtime-action.js`, необработанного отказа нет; уведомление показывает адаптер, откат — библиотека) и `thread-history-list.test.tsx` (`onRename={vi.fn()}` в `renderView`). Других правок в этих файлах нет.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать Investigation Targets
- [x] C `thread-history-item.test.tsx`: Enter сохраняет обрезанное; Esc отменяет; пусто + Enter → `aria-invalid` и «Введите название» без `onRename`; `maxLength=200`; «Новая беседа» при `title: undefined`; тултип при обрезке
- [x] Запустить, увидеть падение

### 2. Green Phase
- [x] `thread-title-field.tsx`, правки `thread-history-item.tsx`; тесты зелёные

### 3. Refactor Phase
- [x] Упростить; тесты зелёные

## Quality Assurance Mechanisms
- Vitest + RTL, ESLint, `tsc` — Type: `executable_check`
- Политика фокуса; WCAG 2.1 AA — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: C-тесты + гейты. Браузер (позже, L1-2): «Отчёт Q3» + Enter, Esc, пусто + Enter (нет `PATCH`), F5 — сохранено; S-6 — `PATCH` 500 через обёртку `fetch` → откат и уведомление.
- **Success criteria**: тесты зелёные; lint/tsc — 0.
- **Failure response**: S-6 — повторный `fetch` метаданных.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-05.1–05.3 — сохранение, отмена, пустое название
- **Claim**: Enter сохраняет обрезанное название, Esc отменяет, пустое — ошибка без запроса.
- **Primary failure mode**: пустое название отправляется на сервер; Esc сохраняет.
- **Boundary to exercise**: компонентный (по props `onRename`).
- **State assertion**: значение поля/вызов `onRename` до → после.
- **Mock boundary rationale**: `onRename` — шпион; сеть не затрагивается.
- **Proven by**: `new: thread-history-item.test.tsx` (кейсы выше).
- **Residual**: откат при ошибке `PATCH` — unit T2.2 + L1-2.

### Obligation: Failure Mode: same-value / empty input
- **Claim**: переименование тем же названием; пустое название не уходит.
- **Primary failure mode**: лишний `PATCH` с тем же значением / пустым.
- **Boundary to exercise**: компонентный.
- **State assertion**: N/A.
- **Mock boundary rationale**: шпион `onRename`.
- **Proven by**: `new: thread-history-item.test.tsx — пустое/то же`.
- **Residual**: нет.

## Completion Criteria
- [x] Тесты зелёные (содержательно)
- [x] lint, tsc — 0 ошибок
- [x] Мутация «пустое название отправляется» краснит тест (записано)
- [x] Reference Contract — `Y`

## Notes
- Impact scope: `thread-history-item.tsx` далее правит T5.2.
- Scope boundary: вне Target Files не менять.
- Проверка ошибки `PATCH`: `aui.threads.item({id}).rename()` в `@assistant-ui/core` 0.3.32 идёт через `handleRuntimeAction`, который вешает `.catch` с `console.error` на возвращённый промис (возвращает `Promise<void>`, не `void`); необработанного отклонения нет.
- Дефект браузерной проверки (2026-10-30): после «Переименовать» поле получало фокус через ~1065 мс (открытие шло через `onOpenChangeComplete`, ожидающий конец exit-анимации popup). Исправлено: `setEditing(true)` в `onClick` пункта, `onOpenChangeComplete`/`finalFocus`/`renameChosen` удалены; строка заменяется полем сразу и уносит меню. Тест «focuses the field promptly even while the menu popup runs a long exit animation» (эмуляция `getAnimations` на 1 с, лимит 300 мс) краснит прежний код и зелен на новом.
- Браузер (оркестратор, Chrome, dev): пусто + Enter → `aria-invalid` и «Введите название», без PATCH; валидное название → один PATCH 200, название обновлено в сайдбаре/шапке/вкладке, фокус на ссылке строки; PATCH 500 → откат и toast «Не удалось переименовать беседу. Попробуйте ещё раз.».
