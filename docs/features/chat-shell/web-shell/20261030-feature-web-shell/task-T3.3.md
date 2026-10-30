# Task T3.3: Шапка — `ChatHeader` (контейнер) + `ChatHeaderView`

Metadata:
- Task type: frontend (apps/web)
- Phase: 3
- Dependencies: task-T3.1 → Deliverable: `chat-shell.tsx`, `ui/sidebar.tsx` (`SidebarProvider`)
- Provides: `ChatHeader`/`ChatHeaderView` (HD-01…HD-05), `data-shell-focus="page-title"`, кнопка HD-04 для T3.4, T5.3
- Size: Small (3 файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Шапка: HD-02 («Меню» на мобильном, «Боковая панель» на десктопе), HD-03 заголовок `h1` по `HeaderTitle` (hidden/loading/text/pending), HD-04 «Рабочая область» (обработчик — T5.3), HD-05 «Новый чат» на мобильном; граница снизу по `data-scrolled`. Контейнер читает рантайм (`mainThreadId`, `threadItems`, `isRunning`) и `ShellStatus.titleWaiting`. AC-07.1–07.3; AC-12.1 — шапка; Element 6.

## Target Files
- [ ] `apps/web/src/components/shell/chat-header.tsx` (new)
- [ ] `apps/web/src/components/shell/chat-header.test.tsx` (new)
- [ ] `apps/web/src/components/shell/chat-shell.tsx` (подключение)

## Investigation Targets
- UXRD 6.10, 6.13, 6.25 (HD-01…HD-05, UX-07); DD Element 6 (контейнер / вид), State × Display Matrix
- `apps/web/src/components/shell/chat-shell.tsx`, `app-sidebar.tsx` (T3.1)
- `apps/web/src/lib/threads/shell-status-store.ts` (T1.1)

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| HD-02 | `md:hidden` «Меню» (`aria-haspopup="dialog"`) и `hidden md:inline-flex` «Боковая панель» (`aria-expanded`, `aria-controls`, `aria-keyshortcuts="Control+B Meta+B"`) | План T3.3 |
| HD-03 | `h1 tabIndex={-1}` `data-shell-focus="page-title"`; `hidden` → sr-only «Новый чат», `loading` → скелетон 160×16, `text` + `pending` → «Новая беседа» в `ShimmerLabel` | План T3.3 |
| HD-04 | `hidden lg:inline-flex` «Рабочая область» (`aria-expanded`); панель — T5.3 | План T3.3 |
| HD-05 | `md:hidden` | План T3.3 |
| Граница | снизу по `data-scrolled` | План T3.3 |
| Горячие клавиши и тултипы платформы | Не здесь — T6.2 | План |

## Investigation Notes
(Детали подписки на рантайм.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets
- [ ] `chat-header.test.tsx` (кейсы — строки таблицы `HeaderTitle`): `text` → `h1` с названием; `pending` → «Новая беседа»; `hidden` → sr-only «Новый чат»; `loading` → скелетон; кнопка рабочей области `aria-expanded` (4 теста AC-12.1)
- [ ] AC-07.1: внутри `SidebarProvider defaultOpen` + `Sidebar collapsible="icon"`, `(min-width: 768px)` = true: «Боковая панель» `aria-expanded="true"` → клик → `"false"`, у сайдбара `data-state="collapsed"`, `data-collapsible="icon"`
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `ChatHeaderView` + контейнер `ChatHeader`; подключение в `chat-shell.tsx`; тесты зелёные

### 3. Refactor Phase
- [ ] Разделение контейнер/вид; тесты зелёные

## Quality Assurance Mechanisms
- Vitest + RTL, ESLint, `tsc` — Type: `executable_check`
- ARIA по таблице UXRD 7.2; движение — `surfaces.tsx` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: тесты + гейты.
- **Success criteria**: 4 + AC-07.1 тест зелёные; lint/tsc — 0.
- **Failure response**: расхождение с UXRD — эскалация (не менять строки молча).
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-07.1 — переключение сайдбара
- **Claim**: «Боковая панель» меняет `aria-expanded` и `data-state` сайдбара.
- **Primary failure mode**: `aria-expanded` не синхронизирован с состоянием сайдбара.
- **Boundary to exercise**: компонентный (SidebarProvider + Sidebar).
- **State assertion**: `true`/`expanded` → клик → `false`/`collapsed`, `data-collapsible="icon"`.
- **Mock boundary rationale**: `matchMedia` — полифил.
- **Proven by**: `new: chat-header.test.tsx — AC-07.1`.
- **Residual**: клавиатурные сочетания — T6.2.

### Obligation: AC-07.2 / AC-07.3 — заголовок по состоянию (`HeaderTitle`)
- **Claim**: заголовок отражает состояние: text / pending / hidden / loading.
- **Primary failure mode**: `pending` показывает пусто/старый заголовок; `loading` без скелетона.
- **Boundary to exercise**: компонентный по props `ChatHeaderView`.
- **State assertion**: N/A (по props).
- **Mock boundary rationale**: презентационный вид тестируется по props.
- **Proven by**: `new: chat-header.test.tsx — HeaderTitle (4 кейса)`.
- **Residual**: обновление заголовка живьём — L1-1.

## Completion Criteria
- [ ] Тесты зелёные (содержательно)
- [ ] lint, tsc — 0 ошибок
- [ ] Proof obligations: тест AC-07.1 краснеет при рассинхроне `aria-expanded` (мутация записана)

## Notes
- Impact scope: `chat-header.tsx` далее правят T5.3, T6.2.
- Scope boundary: вне Target Files не менять.
