# Task T3.2: Меню пользователя и тема (SB-11, TM-01)

Metadata:
- Task type: frontend (apps/web)
- Phase: 3
- Dependencies: task-T3.1 → Deliverable: `app-sidebar.tsx`, `ThemeProvider` (T2.4)
- Provides: `UserMenu`, `DEV_USER`
- Size: Small (4 файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 только для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Блок пользователя и меню в сайдбаре: `DropdownMenu` (side `top`), аватар «DU», «dev-user» / «Режим разработки» из `DEV_USER`, `DropdownMenuRadioGroup` «Тема» (`light`/`dark`/`system`) через `useTheme()`; нет «Выйти»/«Настройки». AC-09.1, AC-09.4; AC-12.1 — тема.

## Target Files
- [x] `apps/web/src/components/shell/user-menu.tsx` (new)
- [x] `apps/web/src/lib/dev-user.ts` (new)
- [x] `apps/web/src/components/shell/user-menu.test.tsx` (new)
- [x] `apps/web/src/components/shell/app-sidebar.tsx` (подключение `UserMenu`)

## Investigation Targets
- UXRD 6.9 (SB-11, TM-01); DD «Тема, шрифт, токены»
- `apps/web/src/components/theme-provider.tsx` (T2.4), `ui/dropdown-menu.tsx`, `ui/avatar.tsx`
- `apps/web/src/components/shell/app-sidebar.tsx` (T3.1)

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Пункты меню | Только выбор темы и данные пользователя; «Выйти»/«Настройки» отсутствуют | План T3.2 |
| «Системная» тема | Класс `dark` по `matchMedia('(prefers-color-scheme: dark)')` | План T3.2 |

## Investigation Notes
- base-ui `Menu.RadioGroup` 1.9.0 рендерит `role="group"` и сам даёт `MenuGroupContext`: `DropdownMenuLabel` внутри него становится `aria-labelledby` группы → имя группы «Тема» без отдельного `DropdownMenuGroup`.
- `onValueChange` группы типизирован как `any` → значение проверяется гардом `isThemeValue` (`unknown` → `'light'|'dark'|'system'`), без `as`.
- `Menu.RadioItem` по умолчанию НЕ закрывает меню (`closeOnClick=false`); по UXRD 6.9 меню закрывается после выбора → `closeOnClick`. Фокус возвращается на триггер (проверено в тесте).
- Триггер — `DropdownMenuTrigger render={<SidebarMenuButton size="lg" tooltip=…/>}`: тултип «dev-user» виден только в полосе (логика `SidebarMenuButton`); в полосе меню открывается `side="right"`, ширина `min-w-56`; иначе `side="top"`, ширина = ширине блока (`--anchor-width`).
- Полифил `matchMedia` из `setup.ts` достаточен (next-themes слушает `change` через `addListener`); `setup.ts` не менялся.
- Мутация: `onValueChange` → no-op ⇒ тест темы красный (`expected true to be false`, строка 45); восстановлено.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать Investigation Targets
- [x] `user-menu.test.tsx` (внутри `ThemeProvider`): «Тёмная» → `document.documentElement.classList.contains('dark')`; «Системная» → класс по `matchMedia('(prefers-color-scheme: dark)')`; нет «Выйти»/«Настройки», есть «dev-user» (2 теста)
- [x] Запустить, увидеть падение

### 2. Green Phase
- [x] `dev-user.ts`, `user-menu.tsx`, подключение в `app-sidebar.tsx`; тесты зелёные

### 3. Refactor Phase
- [x] Упростить; тесты зелёные

## Quality Assurance Mechanisms
- Vitest + RTL, ESLint, `tsc` — Type: `executable_check`
- Только семантические токены; WCAG 2.1 AA — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: 2 теста + гейты.
- **Success criteria**: оба теста зелёные; lint/tsc — 0.
- **Failure response**: полифилы `matchMedia`/pointer — в `setup.ts` только через эскалацию (вне Target Files).
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-09.1 / AC-09.4 — выбор темы меняет класс `html`; нет лишних пунктов
- **Claim**: выбор «Тёмная»/«Системная» применяет тему; в меню нет «Выйти»/«Настройки».
- **Primary failure mode**: тема не применяется; в меню появляются несуществующие действия.
- **Boundary to exercise**: компонентный (ThemeProvider + DropdownMenu).
- **State assertion**: `html.dark` до → после выбора.
- **Mock boundary rationale**: `matchMedia` — полифил `setup.ts`.
- **Proven by**: `new: user-menu.test.tsx — тема и состав меню` (2 теста).
- **Residual**: FOUC — L1-8.

## Completion Criteria
- [x] 2 теста зелёные (содержательно)
- [x] lint, tsc — 0 ошибок
- [x] Proof obligation: тест краснеет, если выбор темы не меняет класс (мутация записана)

## Notes
- Impact scope: `app-sidebar.tsx` далее правят T4.2, T6.2.
- Scope boundary: вне Target Files не менять.
