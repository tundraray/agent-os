# Task T1.4: shadcn add семи компонентов, шторка на base-ui `Drawer` в `ui/sidebar.tsx`, русские подписи сайдбара — S-11

Metadata:
- Task type: frontend (apps/web) + шаг проверки S-11 выполняет **оркестратор** (браузер, 375 px, `[DevTools — user: touch emulation]`)
- Phase: 1 — S-11 из шага 4 DD; начинается **только после гейта G1**
- Dependencies: task-T1.3 (гейт G1 пройден — S-1 подтверждён); оболочка для монтирования — из task-T1.2 (`chat-shell.tsx`)
- Provides: `ui/{sidebar,sheet,dropdown-menu,alert-dialog,input,separator,sonner}.tsx`, `hooks/use-mobile.ts` для T2.1, T2.4, T3.1
- Size: Medium (много файлов от CLI + 1 правка вручную)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- Postgres 5433 (`POSTGRES_PORT=5433 pnpm db:up`, `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`); `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, test (с T2.1), `next build`. Prettier для `apps/web` нет.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Добавить компоненты shadcn (CLI) без перезаписи существующих, затем в `ui/sidebar.tsx` заменить мобильную ветку `Sheet` на base-ui `Drawer.Root swipeDirection="left"` и русифицировать подписи. Обернуть спайк в `SidebarProvider` + `Sidebar` в `chat-shell.tsx`. Механизм AC-10.2; UXRD 8.2; S-11.

## Target Files
- [x] `apps/web/src/components/ui/sidebar.tsx` (new, CLI → правка)
- [x] `apps/web/src/components/ui/sheet.tsx` (new, CLI)
- [x] `apps/web/src/components/ui/dropdown-menu.tsx` (new, CLI)
- [x] `apps/web/src/components/ui/alert-dialog.tsx` (new, CLI)
- [x] `apps/web/src/components/ui/input.tsx` (new, CLI)
- [x] `apps/web/src/components/ui/separator.tsx` (new, CLI)
- [x] `apps/web/src/components/ui/sonner.tsx` (new, CLI)
- [x] `apps/web/src/hooks/use-mobile.ts` (new, CLI)
- [x] `apps/web/package.json`
- [x] `pnpm-lock.yaml`
- [x] `apps/web/src/components/shell/chat-shell.tsx` (обернуть спайк в `SidebarProvider` + `Sidebar`)

`ui/button.tsx`, `ui/skeleton.tsx`, `ui/tooltip.tsx` — **не менять** (CLI их пропускает; проверка `git diff --stat` ниже).

## Investigation Targets
- `apps/web/components.json` (base-nova, `@base-ui/react`)
- `apps/web/node_modules/@base-ui/react/drawer/root/DrawerRoot.d.ts`
- DD «Тема, шрифт, токены» (абзац «Шторка: закрытие свайпом»), «Правки скопированных shadcn-компонентов»
- `apps/web/src/components/shell/chat-shell.tsx` (результат T1.2)

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Флаг `--yes` у `shadcn add` | Сначала `pnpm --filter web exec shadcn add --help`: если флаг есть — добавить `--yes`; `--overwrite` не использовать **никогда** | План T1.4 |
| Ожидаемый вывод CLI | «skipped» для существующих `button`, `skeleton`, `tooltip` | План T1.4 |
| Спецификаторы от CLI | `next-themes` → `^0.4.6`, `sonner` → `^2.0.8` | План T1.4 |
| Если `git diff --stat` по трём файлам не пуст | Восстановить из git (чтение/восстановление через разрешённую команду оркестратора, не `git checkout` исполнителем — эскалировать оркестратору) и записать в Notes | План, «Риски», правило запрета `git checkout` исполнителем |
| S-11 не подтвердился | Запасной путь: `Sheet` + `pointerdown/pointerup` (смещение влево ≥ 30 % ширины → `setOpenMobile(false)`); запись в Notes | Таблица Early Verification Point |
| Открытие шторки свайпом от края | Не добавлять | План T1.4 |

## Investigation Notes
- `shadcn add --help`: флаг `-y, --yes` есть → вызов `pnpm --filter web exec shadcn add sidebar sheet dropdown-menu alert-dialog input separator sonner --yes` (без `--overwrite`), один раз.
- Вывод CLI: «Created 8 files» — `ui/{dropdown-menu,input,separator,sonner,sheet,alert-dialog,sidebar}.tsx`, `hooks/use-mobile.ts`; «Skipped 3 files» — `ui/button.tsx`, `ui/skeleton.tsx`, `ui/tooltip.tsx`. `globals.css` CLI не тронул.
- `git diff --stat -- apps/web/src/components/ui` после CLI — пусто (три существующих файла не изменены).
- `package.json`: добавлен только `next-themes ^0.4.6`; `sonner ^2.0.8` уже был. `pnpm-lock.yaml`: `next-themes@0.4.6` + перенормализация ключей peer-снапшотов `eslint-import-resolver-typescript`/`eslint-plugin-import`/`eslint-module-utils` (версии те же, сокращённая запись pnpm). `ai` и `@assistant-ui/*` не менялись.
- `hooks/use-mobile.ts` от CLI не проходил lint (`react-hooks/set-state-in-effect`) → переписан на `useSyncExternalStore` (тот же контракт `useIsMobile(): boolean`, на сервере `false`).
- `ui/sidebar.tsx`: мобильная ветка — `Drawer.Root open={openMobile} onOpenChange={setOpenMobile} swipeDirection={side}` (`left`) → `Portal` → `Backdrop` (прозрачность следует за `--drawer-swipe-progress`) + `Viewport` (обработчики свайпа живут в нём) → `Popup` (`role="dialog" aria-modal="true" aria-label="История бесед"`, `w-(--sidebar-width)` = 18rem, `max-w-[85vw]`, `transform: translateX(var(--drawer-swipe-movement-x))`, вход/выход `-translate-x-full`). `Drawer.Content` не используется: в base-ui он отключает мышиный свайп по своей области (ради выделения текста). `Drawer.Title` не используется, чтобы имя давал `aria-label`. «Toggle Sidebar» → «Боковая панель» (sr-only триггера, `aria-label`/`title` рейла). Открытие свайпом от края (`Drawer.SwipeArea`) не добавлено.
- `chat-shell.tsx`: спайк обёрнут в `SidebarProvider defaultOpen={defaultSidebarOpen}` + `Sidebar`; кнопка «Меню» (`md:hidden`, `aria-haspopup="dialog"`, `toggleSidebar`) — в строке статуса.
- Гейты: eslint 0, `tsc --noEmit` 0, `next build` — успех.
- Проверка S-11 в браузере (оркестратор, 2026-10-30, chrome-devtools, 375×812, mobile, touch):
  - При 375 px сайдбар скрыт, показана кнопка «Меню» (`aria-haspopup="dialog"`) — подтверждено.
  - «Меню» открывает модальный диалог «История бесед»: ширина 288 px, `left: 0`; основное содержимое исключено из дерева доступности — подтверждено.
  - Ловушка фокуса: Shift+Tab из диалога → последняя ссылка, Tab → «Новый чат» (цикл) — подтверждено.
  - Esc закрывает, фокус возвращается на «Меню» — подтверждено.
  - Нажатие на подложку закрывает, фокус возвращается на «Меню» — подтверждено.
  - **НЕ ВЫПОЛНЕНО: закрытие свайпом влево.** Синтетические pointer-события и drag-инструмент DevTools не воспринимаются как свайп (недоверенный ввод / нативное перетаскивание ссылки). Пользователь решил проверить позже → перепроверить в **T8.3 L1-3** (`[DevTools — user]`). Решение: `Drawer` оставлен; запасной путь (`Sheet` + pointer-обработчик) не применялся.
  - Находки для T3.1 (внесены в `task-T3.1.md`): (1) AC-10.2 требует начальный фокус на «Новый чат» при открытии шторки — сейчас фокус попадает на сам элемент диалога (использовать `initialFocus` у `Drawer`); (2) кнопки «×» «Закрыть меню» в шапке шторки (UXRD 761) пока нет.
  - Гейты (quality-fixer, 2026-10-30; dev-сервер :3000 работал, `next build` не запускался — код не менялся с успешной сборки исполнителя): `eslint src` — 0, `tsc --noEmit` — 0; `git diff HEAD` по `ui/button.tsx`, `ui/skeleton.tsx`, `ui/tooltip.tsx` — пусто; `pnpm install --frozen-lockfile --offline --ignore-scripts` принят («Lockfile is up to date»), `pnpm-lock.yaml` не изменился.

## Implementation Steps
Тестов в задаче нет (компонентный тест шторки — T3.1).
### 1. Подготовка
- [x] Прочитать Investigation Targets; `pnpm --filter web exec shadcn add --help` — есть ли `--yes`

### 2. CLI
- [x] Один вызов `pnpm --filter web exec shadcn add sidebar sheet dropdown-menu alert-dialog input separator sonner [--yes]` **без** `--overwrite`, до любых правок `ui/*` (нужна сеть)
- [x] `git diff --stat apps/web/src/components/ui/button.tsx apps/web/src/components/ui/skeleton.tsx apps/web/src/components/ui/tooltip.tsx` — пусто; иначе эскалировать оркестратору для восстановления и записать в Notes

### 3. Правки
- [x] `ui/sidebar.tsx`: мобильную ветку `Sheet` заменить на `Drawer.Root swipeDirection="left"` с теми же классами панели (288 px, `max-w-[85vw]`); `role="dialog" aria-modal="true" aria-label="История бесед"`; русские `aria-label`/`title`/sr-only («Боковая панель» вместо «Toggle Sidebar»). Остальные правки `sidebar.tsx` — T3.1 и T6.2
- [x] `chat-shell.tsx`: обернуть спайк в `SidebarProvider` + `Sidebar`

### 4. Проверка S-11 (оркестратор; `pnpm --filter web dev`, 375 px)
- [x] Шторка открывается; `role="dialog"`; фокус внутри (ловушка); Esc закрывает; фокус возвращается на кнопку открытия (также подложка закрывает) — 375×812, 2026-10-30
- [ ] Свайп влево закрывает (`[DevTools — user: touch emulation]`) — не выполнено, перенесено в T8.3 L1-3
- [x] Не подтвердилось → запасной путь `Sheet` + `pointerdown/pointerup`; запись в Notes (не потребовался: `Drawer` оставлен, свайп проверит T8.3)

## Quality Assurance Mechanisms
- ESLint, `tsc`, `next build` — Type: `executable_check`
- Точные версии `@assistant-ui/*`, `assistant-stream`; `ai` не меняется — Type: `passive_constraint`
- Только семантические токены; WCAG 2.1 AA — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: lint/tsc/build; `git diff --stat` по трём файлам; проверка S-11 в браузере (375 px).
- **Success criteria**: 0 ошибок гейтов; три существующих `ui/*` не изменены; шторка соответствует критериям S-11.
- **Failure response**: S-11 — запасной путь `Sheet` + pointer-обработчик (≥ 30 % ширины) и запись в Notes; перезапись существующих `ui/*` — восстановить и записать.
- **Verification level**: L3 (гейты) + L1 (S-11 браузером).

## Proof Obligations
### Obligation: S-11 — base-ui `Drawer` в мобильной ветке (AC-10.2 — механизм)
- **Claim**: шторка открывается как `role="dialog"`, держит фокус, закрывается Esc/свайпом, возвращает фокус.
- **Primary failure mode**: `Drawer` несовместим — фокус уходит на `body`, свайп не закрывает.
- **Boundary to exercise**: реальный браузер (375 px); автоматический тест — `app-sidebar.test.tsx` в T3.1.
- **State assertion**: закрыта → «Меню» → открыта, фокус внутри → Esc → закрыта, фокус на кнопке.
- **Mock boundary rationale**: none.
- **Proven by**: `new (L1): проверка S-11 в T1.4`; `existing/planned: app-sidebar.test.tsx — S-11` (T3.1). Нового теста в T1.4 нет.
- **Residual**: свайп — только L1-3 (T8.3).

## Completion Criteria
- [x] Гейты lint, tsc, build — 0 ошибок
- [x] Три существующих `ui/*` не изменены (`git diff --stat` пуст)
- [x] Проверка S-11 записана в Notes (кроме свайпа — T8.3 L1-3)
- [x] Resolved decisions применены как записано

## Notes
- Impact scope: `package.json`/`pnpm-lock.yaml` далее правит T2.1; `ui/sidebar.tsx` — T3.1, T6.2; `chat-shell.tsx` — T3.1+.
- Scope boundary: `ui/button.tsx`, `ui/skeleton.tsx`, `ui/tooltip.tsx` — без изменений; `ui/button.tsx` правит только T2.4.
