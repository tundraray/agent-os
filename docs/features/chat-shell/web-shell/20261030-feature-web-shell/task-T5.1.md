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
- [ ] `apps/web/src/components/shell/thread-title-field.tsx` (new)
- [ ] `apps/web/src/components/shell/thread-history-item.tsx`
- [ ] `apps/web/src/components/shell/thread-history-item.test.tsx` (new)

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

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets
- [ ] C `thread-history-item.test.tsx`: Enter сохраняет обрезанное; Esc отменяет; пусто + Enter → `aria-invalid` и «Введите название» без `onRename`; `maxLength=200`; «Новая беседа» при `title: undefined`; тултип при обрезке
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `thread-title-field.tsx`, правки `thread-history-item.tsx`; тесты зелёные

### 3. Refactor Phase
- [ ] Упростить; тесты зелёные

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
- [ ] Тесты зелёные (содержательно)
- [ ] lint, tsc — 0 ошибок
- [ ] Мутация «пустое название отправляется» краснит тест (записано)
- [ ] Reference Contract — `Y`

## Notes
- Impact scope: `thread-history-item.tsx` далее правит T5.2.
- Scope boundary: вне Target Files не менять.
