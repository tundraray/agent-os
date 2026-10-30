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
- [x] `apps/web/src/lib/keyboard-shortcuts.ts` (new)
- [x] `apps/web/src/lib/keyboard-shortcuts.test.ts` (new)
- [x] `apps/web/src/hooks/use-global-shortcuts.ts` (new)
- [x] `apps/web/src/hooks/use-global-shortcuts.test.tsx` (new)
- [x] `apps/web/src/components/ui/sidebar.tsx` (охрана `Ctrl/⌘+B`)
- [x] `apps/web/src/components/shell/chat-shell.tsx` (подключение хука)
- [x] `apps/web/src/components/shell/app-sidebar.tsx`
- [x] `apps/web/src/components/shell/chat-header.tsx` (тултипы «⌘»/«Ctrl»)

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
- shadcn `SidebarProvider` вешал на `window` `keydown`: `event.key === "b"` + Ctrl/⌘ → `toggleSidebar()` без каких-либо условий (срабатывал и в SB-08, и при открытом меню/диалоге, и с Shift — перехватывая Ctrl+Shift+B браузера). Охрана поставлена в том же обработчике `ui/sidebar.tsx`: `matchShortcut(event) !== "toggle-sidebar" || isShortcutBlocked(event)` → выход. Константа `SIDEBAR_KEYBOARD_SHORTCUT` удалена.
- `Ctrl/⌘+B` сопоставляется по `event.code === 'KeyB'` (как `KeyO` для нового чата по DD), иначе в русской раскладке (`key === 'и'`) сочетание не работало бы; лишние модификаторы (Shift, Alt) — другое сочетание, остаётся браузеру («перехватываются только перечисленные сочетания», UXRD 7.3).
- Модальные слои: меню base-ui рендерит `role="menu"`, DLG-01 — `role="alertdialog"`; `Dialog` base-ui сам `aria-modal` не ставит — единственный `[role="dialog"][aria-modal="true"]` в оболочке — шторка (`ui/sidebar.tsx` задаёт атрибуты явно, плюс `data-slot="sidebar" data-mobile="true"`), по ним и делается исключение для `Ctrl/⌘+B`. Шторка + открытое в ней меню → `Ctrl/⌘+B` блокируется.
- `useGlobalShortcuts()` (без аргументов, как в DD) берёт `newChat` из `useShellActions()` и вызывает `newChat('shortcut')`; подключён компонентом `GlobalShortcuts` внутри `ChatRuntimeProvider` в `chat-shell.tsx`. В тесте граница `ShellActions` подменена `vi.mock('@/components/shell/shell-actions')` (шпион `newChat`).
- Символ платформы: `isApplePlatform({ platform, userAgentData })` — `userAgentData.platform`, иначе `navigator.platform`; `/mac|iphone|ipad|ipod/i` → «⌘». Хук `useShortcutLabel(shortcut)` (`useSyncExternalStore`, на сервере «Ctrl») — подписи «Ctrl+Shift+O»/«⌘+Shift+O», «Ctrl+B»/«⌘+B».
- Тултипы: SB-03 в полосе SB-12 — «Новый чат · Ctrl+Shift+O»; приглушённая подсказка «Ctrl Shift O» («⌘ Shift O») справа в полной кнопке SB-03 — только ≥ 1024 px с точным указателем (`aria-hidden`, имя кнопки не меняется); шапка — «Меню · Ctrl+B», «Боковая панель · Ctrl+B», «Новый чат · Ctrl+Shift+O» (тултип снизу).

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать Investigation Targets
- [x] U `keyboard-shortcuts.test.ts` — таблица блокировок (поле переименования, `alertdialog`, `menu`, модальный `dialog`, исключение `Ctrl+B` при шторке)
- [x] C `use-global-shortcuts.test.tsx` — 1 тест проводки
- [x] Запустить, увидеть падение

### 2. Green Phase
- [x] `keyboard-shortcuts.ts`, `use-global-shortcuts.ts`, охрана в `ui/sidebar.tsx`, подключение в `chat-shell.tsx`, тултипы в `app-sidebar.tsx` и `chat-header.tsx`; тесты зелёные

### 3. Refactor Phase
- [x] Упростить; тесты зелёные

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
- [x] Тесты зелёные (содержательно)
- [x] lint, tsc, build — 0 ошибок
- [x] Resolved decisions применены

## Notes
- Impact scope: `chat-shell.tsx`, `app-sidebar.tsx`, `chat-header.tsx`, `ui/sidebar.tsx` — последние правки.
- Scope boundary: вне Target Files не менять.
