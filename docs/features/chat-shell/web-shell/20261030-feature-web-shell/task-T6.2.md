# Task T6.2: Горячие клавиши — `isShortcutBlocked`, `Ctrl/⌘+Shift+O`, `Ctrl/⌘+B` с охраной, символ платформы в тултипах

Metadata:
- Task type: frontend (apps/web)
- Phase: 6 — Should (FR-22)
- Dependencies: task-T5.1 → Deliverable: поле переименования с `data-shortcuts-blocked`; по файлам (`chat-shell.tsx`, `chat-header.tsx`) — после T5.3
- Provides: `isShortcutBlocked`, `useGlobalShortcuts`
- Size: Medium (8 файлов)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Глобальные сочетания: `Ctrl/⌘+Shift+O` («Новый чат»), `Ctrl/⌘+B` (сайдбар) с охраной от срабатывания в полях/диалогах/меню, символ платформы («⌘»/«Ctrl») в тултипах. AC-22.1.

## Target Files
- [ ] `apps/web/src/lib/keyboard-shortcuts.ts` (new)
- [ ] `apps/web/src/lib/keyboard-shortcuts.test.ts` (new)
- [ ] `apps/web/src/hooks/use-global-shortcuts.ts` (new)
- [ ] `apps/web/src/hooks/use-global-shortcuts.test.tsx` (new)
- [ ] `apps/web/src/components/ui/sidebar.tsx` (охрана `Ctrl/⌘+B`)
- [ ] `apps/web/src/components/shell/chat-shell.tsx` (подключение хука)
- [ ] `apps/web/src/components/shell/app-sidebar.tsx`
- [ ] `apps/web/src/components/shell/chat-header.tsx` (тултипы «⌘»/«Ctrl»)

## Investigation Targets
- DD «Клавиатура» (`isShortcutBlocked`, `Ctrl/⌘+Shift+O`, `Ctrl/⌘+B`); UXRD 7.3
- `apps/web/src/components/ui/sidebar.tsx` (встроенный обработчик `Ctrl/⌘+B` shadcn), `shell-actions.tsx` (`newChat`)

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `isShortcutBlocked(event)` | `true` внутри `[data-shortcuts-blocked]` или при открытом `[role="alertdialog"]`, `[role="menu"]`, `[role="dialog"][aria-modal="true"]` | План T6.2 |
| `Ctrl/⌘+B` | исключение: открытая шторка закрывается | План T6.2 |
| `Ctrl/⌘+Shift+O` | `event.code === 'KeyO'` | План T6.2 |
| Символ платформы | `navigator.platform`/`userAgentData` → «⌘» на macOS, иначе «Ctrl» | План T6.2 |
| Тесты | U — таблица блокировок; C — 1 тест проводки хука (`Ctrl+Shift+O` вызывает `newChat` и `preventDefault`, внутри `[data-shortcuts-blocked]` — нет) | План T6.2 |

## Investigation Notes
(Как shadcn перехватывает `Ctrl/⌘+B`; где ставить охрану.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets
- [ ] U `keyboard-shortcuts.test.ts` — таблица блокировок (поле переименования, `alertdialog`, `menu`, модальный `dialog`, исключение `Ctrl+B` при шторке)
- [ ] C `use-global-shortcuts.test.tsx` — 1 тест проводки
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `keyboard-shortcuts.ts`, `use-global-shortcuts.ts`, охрана в `ui/sidebar.tsx`, подключение в `chat-shell.tsx`, тултипы в `app-sidebar.tsx` и `chat-header.tsx`; тесты зелёные

### 3. Refactor Phase
- [ ] Упростить; тесты зелёные

## Quality Assurance Mechanisms
- Vitest + RTL, ESLint, `tsc`, `next build` — Type: `executable_check`
- Test Selection (таблица вместо множества тестов) — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: U и C + гейты. Браузер (L1-9, T8.3): `Ctrl+Shift+O` из композера, `Ctrl+B`; в поле переименования и в открытом меню сочетания не срабатывают.
- **Success criteria**: тесты зелёные; lint/tsc/build — 0.
- **Failure response**: конфликт с обработчиком shadcn — править только в `ui/sidebar.tsx` (в Target Files).
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-22.1 — сочетания не срабатывают во вводе и модальных слоях
- **Claim**: `isShortcutBlocked` возвращает `true` в поле переименования и при открытых alertdialog/menu/модальном dialog; исключение для `Ctrl+B` при шторке.
- **Primary failure mode**: сочетание срабатывает в поле переименования / открытом диалоге.
- **Boundary to exercise**: in-process unit (таблица).
- **State assertion**: N/A.
- **Mock boundary rationale**: DOM-события синтетические.
- **Proven by**: `new: keyboard-shortcuts.test.ts — таблица блокировок`.
- **Residual**: реальное поведение — L1-9.

### Obligation: AC-22.1 — проводка `Ctrl+Shift+O` → `newChat`
- **Claim**: хук вызывает `newChat` и `preventDefault`; внутри `[data-shortcuts-blocked]` — нет.
- **Primary failure mode**: хук не подключён к `isShortcutBlocked` или к `newChat`.
- **Boundary to exercise**: компонентный.
- **State assertion**: вызовы `newChat`/`preventDefault`.
- **Mock boundary rationale**: `newChat` — шпион (граница `ShellActions`).
- **Proven by**: `new: use-global-shortcuts.test.tsx` (1 тест проводки; правило блокировки — только в U).
- **Residual**: нет.

## Completion Criteria
- [ ] Тесты зелёные (содержательно)
- [ ] lint, tsc, build — 0 ошибок
- [ ] Resolved decisions применены

## Notes
- Impact scope: `chat-shell.tsx`, `app-sidebar.tsx`, `chat-header.tsx`, `ui/sidebar.tsx` — последние правки.
- Scope boundary: вне Target Files не менять.
