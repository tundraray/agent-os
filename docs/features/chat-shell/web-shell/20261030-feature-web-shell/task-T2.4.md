# Task T2.4: Тема без FOUC, шрифт с кириллицей, токены контраста и движения, `Toaster`, кнопка

Metadata:
- Task type: frontend (apps/web); браузерная проверка в `dev` — оркестратор
- Phase: 2 (шаг 3 DD)
- Dependencies: task-T1.4 → Deliverable: `ui/sonner.tsx`, `next-themes` в `package.json`
- Provides: `ThemeProvider`, токены (`--ring`, `--destructive-foreground`, размеры, движение), шрифт, `Toaster` для Phase 3+
- Size: Small–Medium (5 файлов)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000` (build падает без него); Postgres 5433 нужен только для L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — читать `apps/web/node_modules/next/dist/docs/` (см. Investigation Targets).
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`. Prettier нет.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Тема без вспышки (next-themes), шрифт Geist с кириллицей (UXQ-3), токены контраста и движения, `Toaster`, непрозрачное кольцо и сплошной `destructive` у кнопки (Element 3). Механизм AC-09.1–09.3; UXRD 7.6; IP4, IP5.

## Target Files
- [x] `apps/web/src/components/theme-provider.tsx` (new)
- [x] `apps/web/src/app/layout.tsx`
- [x] `apps/web/src/app/globals.css`
- [x] `apps/web/src/components/ui/button.tsx`
- [x] `apps/web/src/components/ui/sonner.tsx`

## Investigation Targets
- `apps/web/node_modules/next/dist/docs/01-app/02-guides/preventing-flash-before-hydration.md` («Understanding suppressHydrationWarning», `InlineScript`)
- DD «Тема, шрифт, токены», фрагмент `theme-provider.tsx`
- `next-themes` 0.4.6 `dist/index.mjs`
- Текущие `apps/web/src/app/layout.tsx`, `globals.css`, `ui/button.tsx`, `ui/sonner.tsx`

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Тема, шрифт, токены) | derived-display | «светлые `--ring`, `--sidebar-ring` → `oklch(0.556 0 0)`; `* { @apply border-border outline-ring; }`; `--destructive-foreground` (светлая `oklch(0.985 0 0)`, тёмная `oklch(0.145 0 0)` = `--background`) + `--color-destructive-foreground`; размеры `--thread-max-width: 48rem`, `--header-height: 3.5rem`; движение `--ease-panel: cubic-bezier(0.32, 0.72, 0, 1)`, `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`, `--duration-fast: 150ms`, `--duration-panel: 200ms`» | Y, если `globals.css` содержит перечисленные токены дословно |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `layout.tsx` | `<html lang="ru" suppressHydrationWarning>`; `Geist`/`Geist_Mono` с `subsets: ['latin', 'cyrillic']`; `ThemeProvider` первым в `<body>` (`attribute="class"`, `defaultTheme="system"`, `enableSystem`, `enableColorScheme`, `disableTransitionOnChange`); `TooltipProvider`; `Toaster`; inline-скрипт theme-color (`MutationObserver` на `html.class`); `export const viewport` (`viewportFit: 'cover'`, `interactiveWidget: 'resizes-content'`); `<link rel="preconnect" href={apiBaseUrl} crossOrigin="use-credentials">`; `metadata` `title: 'Agent OS'`, `description: 'Рабочее пространство Agent OS'` | План T2.4 |
| `globals.css` | + `@theme inline { --font-sans: var(--font-geist-sans); --font-heading: var(--font-geist-sans); }` | План T2.4 |
| `button.tsx` | `focus-visible:ring-3 focus-visible:ring-ring`; `destructive` → `bg-destructive text-destructive-foreground` | План T2.4 |
| `ui/sonner.tsx` | `position="bottom-right"`, `closeButton` | План T2.4 |
| Тесты | Нет: компонентный тест темы — T3.2 (`user-menu.test.tsx`); FOUC, шрифт, контраст — L1-8 (T8.3) | План T2.4 |
| `theme-provider.tsx` | `scriptProps` по `typeof window` (фрагмент DD) | План T2.4 |

## Investigation Notes
- `preventing-flash-before-hydration.md`: inline-скрипт в root layout допустим (пример темы в доке — `<script dangerouslySetInnerHTML>` в `<head>` серверного layout); приём `InlineScript` (`text/javascript` на сервере / `text/plain` на клиенте + `suppressHydrationWarning`) применён в `theme-provider.tsx` по фрагменту DD.
- `next-themes` 0.4.6 `dist/index.mjs`: `scriptProps` прокидывается в `createElement("script", {...scriptProps, suppressHydrationWarning: true, …})` — подтверждено.
- Сборка (`.next/server/app/index.html`): `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">` (умолчания Next сохраняются), `<link rel="preconnect" href="http://localhost:4000" crossorigin="use-credentials">`, `<script type="text/javascript">` next-themes — первый элемент `<body>`; в CSS есть `@font-face` Geist с `unicode-range` кириллицы (`U+400-45F…`), `font-family: Geist, Geist Fallback`.
- Reference Contract: Y — все токены дословно в `globals.css` (`--ring`/`--sidebar-ring` светлые `oklch(0.556 0 0)`, `* { @apply border-border outline-ring; }`, `--destructive-foreground` светлая/тёмная + `--color-destructive-foreground`, размеры и движение в `:root`).
- `--ease-out` в `:root` (вне слоя) переопределяет одноимённую переменную Tailwind → утилита `ease-out` использует кривую UXRD 11.2 (`cubic-bezier(0.23, 1, 0.32, 1)`) — соответствует назначению токена.
- `ui/sonner.tsx`: CSS-переменные тоста перенесены из `style={… as React.CSSProperties}` в классы Tailwind с `!` (стили sonner `[data-sonner-toaster][data-sonner-theme=…]` специфичнее класса), тема — через type guard вместо `as`; `position="bottom-right"`, `closeButton` стоят до `{...props}` (место вызова может переопределить).
- `button.tsx` `destructive`: сплошной `bg-destructive text-destructive-foreground hover:bg-destructive/90`; переопределения кольца `ring-destructive/20` убраны — у варианта действует общее непрозрачное `ring-ring`.
- Target Files расширены оркестратором на `apps/web/src/components/shell/chat-shell.tsx` ровно для одной правки: удалены спайковые `import { Toaster } from 'sonner';` и комментарий SPIKE + `<Toaster position="bottom-center" />`. Теперь ровно один `Toaster` в `RootLayout` и один в `renderWithRuntime` (ChatShell своего не рендерит).
- `thread.aui.tsx:230` локально задаёт `--thread-max-width: 44rem` и перекрывает токен 48rem — передано в Notes `task-T3.4.md` (T3.4 владеет `thread.aui.tsx`).

## Implementation Steps
Новых тестов нет (см. Decisions).
### 1. Подготовка
- [x] Прочитать `preventing-flash-before-hydration.md` и остальные Investigation Targets

### 2. Реализация
- [x] `theme-provider.tsx`, `layout.tsx`, `globals.css`, `button.tsx`, `ui/sonner.tsx` по Decisions и Reference Contracts

### 3. Refactor
- [x] Только семантические токены; никаких жёстких цветов в новых правилах

### 4. Проверка (оркестратор, `pnpm --filter web dev`)
- [x] `localStorage.theme = 'dark'` + F5 → класс `dark` на `html`; в консоли нет предупреждений о `<script>` и гидратации
- [x] `document.fonts.check('14px Geist', 'Жё')` → `true`
- [ ] No-FOUC на production-сборке — не выполнено (`next start` не смог занять :3000, занят dev-сервером) → T8.3 L1-8

## Quality Assurance Mechanisms
- ESLint, `tsc`, `next build` — Type: `executable_check`
- Только семантические токены; WCAG 2.1 AA — Config: `apps/web/src/app/globals.css` — Type: `passive_constraint`
- Стиль файлов: `ui/*` — как генерирует CLI; файлы приложения — одинарные кавычки и `;` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: lint/tsc/build; в `dev` — тема после F5, консоль, `document.fonts.check`.
- **Success criteria**: 0 ошибок гейтов; класс `dark` на `html` после F5 при `localStorage.theme='dark'`; нет предупреждений гидратации; `document.fonts.check('14px Geist','Жё') === true`.
- **Failure response**: корректировать `scriptProps`/порядок провайдеров по доке Next; эскалация при несовместимости с `cacheComponents`.
- **Verification level**: L3 + быстрая браузерная проверка (полный L1-8 — T8.3).

## Proof Obligations
### Obligation: AC-09.2 — тема без вспышки (механизм)
- **Claim**: первый кадр уже в сохранённой теме.
- **Primary failure mode**: inline-скрипт темы не выполняется до гидратации (FOUC) или рвёт гидратацию.
- **Boundary to exercise**: реальный браузер (`dev`/`start`).
- **State assertion**: `localStorage.theme='dark'` + F5 → `html.dark` на первом кадре.
- **Mock boundary rationale**: none.
- **Proven by**: `existing/planned: L1-8 (T8.3)`; компонентный тест смены темы — `user-menu.test.tsx` (T3.2). Нового теста в T2.4 нет (конфигурация/декларации не тестируются — Test Selection).
- **Residual**: контраст — L1-8.

## Completion Criteria
- [x] lint, tsc, build — 0 ошибок
- [x] `dev`: `localStorage.theme = 'dark'` + F5 → класс `dark` на `html`; в консоли нет предупреждений о `<script>` и гидратации
- [x] `document.fonts.check('14px Geist', 'Жё')` → `true`
- [x] Reference Contract (`globals.css`) — `Y`; Resolved decisions применены

## Browser Verification Results (оркестратор, dev-сервер, Chrome, 2026-10-30)
- `localStorage.theme='dark'` + reload: `html.dark`, `color-scheme: dark`, `--background` = `lab(2.75% 0 0)`, meta `theme-color` равен `--background`.
- `'light'`: светлая тема, `theme-color` = `lab(100% 0 0)`.
- Переключение класса `dark` обновляет `theme-color` (MutationObserver работает).
- Ключ `theme` удалён: system (ОС светлая) → светлая тема.
- `document.fonts.check('14px Geist', 'Жё') === true`; `body` font-family `Geist, "Geist Fallback"`.
- `html lang=ru`; ровно один регион sonner `Toaster`; в консоли нет предупреждений о `<script>` и гидратации.
- Не выполнено: no-FOUC на production-сборке (`next start` не смог занять :3000, порт держит dev-сервер) → отложено в T8.3 L1-8 (production build).

## Notes
- Impact scope: `app/layout.tsx` ещё раз проверяется в T7.5 (только строки); `ui/button.tsx` — только здесь.
- Scope boundary: остальные `ui/*` не менять.
