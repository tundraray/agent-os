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
- [ ] `apps/web/src/components/ui/sidebar.tsx` (new, CLI → правка)
- [ ] `apps/web/src/components/ui/sheet.tsx` (new, CLI)
- [ ] `apps/web/src/components/ui/dropdown-menu.tsx` (new, CLI)
- [ ] `apps/web/src/components/ui/alert-dialog.tsx` (new, CLI)
- [ ] `apps/web/src/components/ui/input.tsx` (new, CLI)
- [ ] `apps/web/src/components/ui/separator.tsx` (new, CLI)
- [ ] `apps/web/src/components/ui/sonner.tsx` (new, CLI)
- [ ] `apps/web/src/hooks/use-mobile.ts` (new, CLI)
- [ ] `apps/web/package.json`
- [ ] `pnpm-lock.yaml`
- [ ] `apps/web/src/components/shell/chat-shell.tsx` (обернуть спайк в `SidebarProvider` + `Sidebar`)

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
(Вывод `shadcn add`, результат `git diff --stat`, результат проверки S-11.)

## Implementation Steps
Тестов в задаче нет (компонентный тест шторки — T3.1).
### 1. Подготовка
- [ ] Прочитать Investigation Targets; `pnpm --filter web exec shadcn add --help` — есть ли `--yes`

### 2. CLI
- [ ] Один вызов `pnpm --filter web exec shadcn add sidebar sheet dropdown-menu alert-dialog input separator sonner [--yes]` **без** `--overwrite`, до любых правок `ui/*` (нужна сеть)
- [ ] `git diff --stat apps/web/src/components/ui/button.tsx apps/web/src/components/ui/skeleton.tsx apps/web/src/components/ui/tooltip.tsx` — пусто; иначе эскалировать оркестратору для восстановления и записать в Notes

### 3. Правки
- [ ] `ui/sidebar.tsx`: мобильную ветку `Sheet` заменить на `Drawer.Root swipeDirection="left"` с теми же классами панели (288 px, `max-w-[85vw]`); `role="dialog" aria-modal="true" aria-label="История бесед"`; русские `aria-label`/`title`/sr-only («Боковая панель» вместо «Toggle Sidebar»). Остальные правки `sidebar.tsx` — T3.1 и T6.2
- [ ] `chat-shell.tsx`: обернуть спайк в `SidebarProvider` + `Sidebar`

### 4. Проверка S-11 (оркестратор; `pnpm --filter web dev`, 375 px)
- [ ] Шторка открывается; `role="dialog"`; фокус внутри (ловушка); Esc закрывает; свайп влево закрывает (`[DevTools — user: touch emulation]`); фокус возвращается на кнопку открытия
- [ ] Не подтвердилось → запасной путь `Sheet` + `pointerdown/pointerup`; запись в Notes

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
- [ ] Гейты lint, tsc, build — 0 ошибок
- [ ] Три существующих `ui/*` не изменены (`git diff --stat` пуст)
- [ ] Проверка S-11 записана в Notes
- [ ] Resolved decisions применены как записано

## Notes
- Impact scope: `package.json`/`pnpm-lock.yaml` далее правит T2.1; `ui/sidebar.tsx` — T3.1, T6.2; `chat-shell.tsx` — T3.1+.
- Scope boundary: `ui/button.tsx`, `ui/skeleton.tsx`, `ui/tooltip.tsx` — без изменений; `ui/button.tsx` правит только T2.4.
