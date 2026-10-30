# Task T3.1: `ChatShell` (SH-01), `AppSidebar` без списка, граница ошибок, cookie сайдбара, правки `ui/sidebar.tsx`, `useMediaQuery`

Metadata:
- Task type: frontend (apps/web); быстрая браузерная проверка F5 (AC-21.1) — оркестратор
- Phase: 3 — каркас оболочки (шаг 4 DD)
- Dependencies: task-T2.4 → Deliverable: токены/тема/`Toaster`; также T1.4 (`ui/sidebar.tsx`), T1.2 (`chat-shell.tsx`, `(chat)/layout.tsx`)
- Provides: раскладка SH-01, `AppSidebar`, `useMediaQuery`, `setOpen(value,{persist})` для T3.2, T3.3, T3.4, T5.3, T6.2
- Size: Medium (7 файлов)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 (`POSTGRES_PORT=5433 pnpm db:up`, `postgres://agent:agent@localhost:5433/agent_os`) — для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — читать `apps/web/node_modules/next/dist/docs/` (`cookies()`, layout).
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`. Prettier нет.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Заменить разметку спайка раскладкой SH-01: `SidebarProvider` с `defaultOpen` из cookie, `SidebarInset` как `main`, `AppSidebar` без списка (полоса/шторка), граница ошибок `app/error.tsx` (перенесено по DD v1.7), `useMediaQuery`, правки `ui/sidebar.tsx` (`setOpen(value, { persist })`, переход ширины). Механизм AC-07.1, AC-10.1–10.3, AC-21.1, Element 4; S-11 (компонентный тест).

## Target Files
- [x] `apps/web/src/components/shell/chat-shell.tsx`
- [x] `apps/web/src/components/shell/app-sidebar.tsx` (new)
- [x] `apps/web/src/app/error.tsx` (new; перенесено по DD v1.7, было `(chat)/error.tsx`)
- [x] `apps/web/src/app/(chat)/layout.tsx` (проверен: уже читает cookie по контракту — изменений не потребовалось)
- [x] `apps/web/src/hooks/use-media-query.ts` (new)
- [x] `apps/web/src/components/ui/sidebar.tsx`
- [x] `apps/web/src/components/shell/app-sidebar.test.tsx` (new)

## Investigation Targets
- `apps/web/node_modules/next/dist/docs/01-app/02-guides/preserving-ui-state.md`, `03-api-reference/03-file-conventions/dynamic-routes.md`
- DD «Тема, шрифт, токены» (сайдбар, шторка, `h-dvh`, safe-area), «Правки скопированных shadcn-компонентов», UXRD 6.2, 6.3, 6.10, 6.11, 8.2
- Текущие `chat-shell.tsx`, `ui/sidebar.tsx` (T1.4), `(chat)/layout.tsx` (T1.2)
- `apps/web/src/test/{setup,render-with-runtime}.ts(x)` (T2.1)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Тема, шрифт, токены, сайдбар) | state-lifecycle-negative | «cookie `sidebar_state` (пишет shadcn при пользовательском переключении) читается сервером в layout группы → `SidebarProvider defaultOpen`»; «временное сворачивание (рабочая область) — `setOpen(false, { persist: false })`» | Y, если layout читает `(await cookies()).get('sidebar_state')?.value !== 'false'`, а `setOpen(value, { persist: false })` не пишет cookie (по умолчанию `persist: true`) |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `ChatShell` | `SidebarProvider defaultOpen={defaultSidebarOpen}`, `SidebarInset` как `main`, корень `h-dvh`; эффект: `!isMobile && openMobile` → `setOpenMobile(false)`; skip link «Перейти к сообщению» первым в Tab; разметка спайка удаляется | План T3.1 |
| `AppSidebar` | `Sidebar collapsible="icon"` + `SidebarRail`; SB-02 марка; SB-03 «Новый чат» (полная/иконочная, `aria-keyshortcuts="Control+Shift+O Meta+Shift+O"`); в шторке «×» «Закрыть меню», шапка шторки `pt-[env(safe-area-inset-top)]`; `nav aria-label="История бесед"` — место для списка (T4.2); в полосе список не рендерится | План T3.1 |
| `ui/sidebar.tsx` | `setOpen(value, options?: { persist?: boolean })` (по умолчанию `persist: true`; `false` — без записи cookie); `transition-[width,left,right]` с `ease-(--ease-panel) duration-(--duration-panel) motion-reduce:transition-none` | План T3.1 |
| `app/error.tsx` (перенесено по DD v1.7) | `'use client'`: «Что-то пошло не так» + «Обновить страницу», `console.error` с `digest` | План T3.1 |
| `useMediaQuery(query)` | `useSyncExternalStore` над `matchMedia` | План T3.1 |
| Охрана `Ctrl/⌘+B` | Не здесь — T6.2 | План T6.2 |
| Свайп | Только L1-3 (T8.3) | План T3.1 |

## Investigation Notes
- Прочитано: Next docs `03-file-conventions/error.md` (props `error: unknown`, `retry`; `error.tsx` НЕ оборачивает `layout.tsx` своего сегмента — ошибки рендера самого `ChatShell` (он в `(chat)/layout.tsx`) ловит только корневая граница/`global-error`; `(chat)/error.tsx` ловит ошибки страниц группы — остаток для ревью DD), `02-guides/preserving-ui-state.md`; DD «Тема, шрифт, токены», «Правки скопированных shadcn-компонентов», «Доступность — реализация», Element 4; UXRD 6.2, 6.3, 6.10, 6.11, 8.2, 7.2/7.3 (порядок Tab).
- Reference Contract: `(chat)/layout.tsx` (T1.2) уже содержит `(await cookies()).get('sidebar_state')?.value !== 'false'` → `defaultSidebarOpen` → `SidebarProvider defaultOpen` — **Y**. `setOpen(value, { persist = true } = {})` в `ui/sidebar.tsx`: cookie пишется только при `persist !== false` — **Y**. Пользовательские переключения (`toggleSidebar`, `Ctrl/⌘+B`, `SidebarRail`) идут через `setOpen` без опций → cookie пишется.
- S-11 / AC-10.2: `Sidebar` получил необязательные пропсы `initialFocus` / `finalFocus` (типы `Drawer.Popup.Props[...]`, применяются только в мобильной ветке `Drawer.Popup`). `AppSidebar`: `initialFocus={newChatRef}` (кнопка «Новый чат» в шторке), `finalFocus` — функция, возвращающая элемент с атрибутом `data-shell-menu-button` (константа `MENU_BUTTON_ATTRIBUTE` из `app-sidebar.tsx`). **T3.3: кнопка «Меню» в `ChatHeader` обязана нести этот атрибут** (сейчас его ставит временная полоса HD-02 `SidebarToggleBar` в `chat-shell.tsx`, которую T3.3 заменяет шапкой).
- Найдено тестом: тултип `SidebarMenuButton` (невидимый в шторке) открывался по фокусу и перехватывал первый Esc — шторка не закрывалась с первого нажатия. В шторке тултипы не передаются (`tooltip={isMobile ? undefined : …}`).
- Тест открывает шторку `fireEvent.click` (без переноса фокуса — как касание в мобильном Safari), иначе возврат фокуса по умолчанию («ранее сфокусированный элемент») маскировал бы отсутствие `finalFocus`.
- Мутации (записаны): без `finalFocus` — тест красный на `expect(Меню).toHaveFocus()` (строка 33); без `initialFocus` — красный на фокусе «Новый чат» (строка 27); с тултипом в шторке — красный на закрытии по Esc. После восстановления — зелёный.
- «Новый чат» в шторке закрывает шторку (`setOpenMobile(false)`) и вызывает `newChat('button')`; фокус после нового чата по правилу указателя — `lib/focus.ts` (T4.3).
- Skip link «Перейти к сообщению» — первый элемент Tab, фокусирует `[data-shell-focus="composer"]`; атрибут композеру ставит T4.3 (до этого ссылка ничего не фокусирует).
- `useMediaQuery` создан для T5.3 (рабочая область); закрытие шторки при ≥ 768 px использует `isMobile` из `useSidebar` (тот же брейкпоинт, что у ветки `Sidebar`).
- Порядок провайдеров по DD (Component Hierarchy): `SidebarProvider` → `ChatRuntimeProvider`.
- Подсказка `Ctrl Shift O` справа на SB-03 и символ платформы в тултипах — T6.2.
- Свайп-закрытие — не проверяется здесь (L1-3, T8.3); `Drawer` сохранён.
- Доработка по DD v1.7 («Граница ошибок оболочки»): граница перенесена в корневой сегмент `apps/web/src/app/error.tsx` (внутри `app/layout.tsx` — тема/шрифты/`globals.css` действуют; снаружи `(chat)/layout.tsx` — ловит ошибки рендера `ChatShell`), `app/(chat)/error.tsx` удалён. UI без изменений («Что-то пошло не так», «Обновить страницу» → `window.location.reload()`); `console.error('chat shell: render failed', { digest })` — объект ошибки больше не передаётся, текст и стек не показываются и не логируются. Свой `global-error.tsx` не создавался (встроенный Next). Тест `apps/web/src/app/error.test.tsx`: ошибка с `digest` → заголовок и кнопка на месте, текста ошибки на экране нет, `console.error` вызван ровно один раз и только с `digest` (мутация «вернуть аргумент `error`» → красный на `toHaveBeenCalledWith`). Проверка в браузере (ошибка рендера в `ChatShell` в текущей теме, перезагрузка) — на L1.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать Investigation Targets
- [x] `app-sidebar.test.tsx` — 1 тест S-11: при мобильной ширине «Меню» открывает `role="dialog"` «История бесед», фокус на «Новый чат», Esc закрывает, фокус возвращается на «Меню» (AC-10.2 — механизм)
- [x] Запустить, увидеть падение

### 2. Green Phase
- [x] `useMediaQuery`, правки `ui/sidebar.tsx`, `AppSidebar`, `ChatShell`, `error.tsx`, `layout.tsx` (если требуется доработка прокидывания `defaultSidebarOpen`)
- [x] Тест зелёный

### 3. Refactor Phase
- [x] Упростить; убедиться, что тест не проходит по построению

### 4. Быстрая проверка (оркестратор, `dev`)
- [x] Свернуть сайдбар, F5 — полоса на первом кадре (AC-21.1)

## Quality Assurance Mechanisms
- Vitest + RTL — Type: `executable_check`; ESLint, `tsc`, `next build` — `executable_check`
- Движение — `surfaces.tsx`/`--ease-panel`; reduced motion — Type: `passive_constraint`
- Только семантические токены; WCAG 2.1 AA — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: тест S-11; гейты; в `dev`: свернуть сайдбар → F5.
- **Success criteria**: тест зелёный; 0 ошибок гейтов; полоса на первом кадре после F5.
- **Failure response**: S-11 — запасной путь `Sheet` + pointer-обработчик (если T1.4 его применила — адаптировать тест); эскалация при расхождении с cookie.
- **Verification level**: L2 (+ L1 быстрая проверка).

## Proof Obligations
### Obligation: AC-10.2 / S-11 — шторка (фокус и возврат фокуса)
- **Claim**: «Меню» открывает диалог «История бесед», фокус на «Новый чат», Esc закрывает, фокус возвращается на «Меню».
- **Primary failure mode**: `finalFocus` шторки не задан — фокус уходит на `body`.
- **Boundary to exercise**: компонентный (RTL, jsdom + base-ui).
- **State assertion**: закрыта → открыта (фокус внутри) → закрыта (фокус на «Меню»).
- **Mock boundary rationale**: `matchMedia` — полифил `setup.ts`; остальное реальное.
- **Proven by**: `new: app-sidebar.test.tsx — S-11 шторка` (ловит дефект потери фокуса, который не видит ни один другой тест).
- **Residual**: свайп-закрытие — L1-3.

### Obligation: AC-21.1 — cookie сайдбара (механизм)
- **Claim**: состояние сайдбара восстанавливается из cookie на сервере (первый кадр).
- **Primary failure mode**: `defaultOpen` игнорирует cookie; `persist:false` пишет cookie.
- **Boundary to exercise**: реальный браузер (dev) / L1-1.
- **State assertion**: свернуть → F5 → свёрнуто на первом кадре.
- **Mock boundary rationale**: none.
- **Proven by**: `existing/planned: L1-1 (T8.3)`; быстрая проверка в этой задаче. Нового автотеста нет (серверный `cookies()` в jsdom не воспроизводится).
- **Residual**: временное сворачивание — T5.3.

## Completion Criteria
- [x] Тест зелёный (содержательно)
- [x] lint, tsc, build — 0 ошибок
- [x] dev: свернуть сайдбар, F5 — полоса на первом кадре (быстрая проверка AC-21.1)
- [x] Proof obligation: без `finalFocus` тест краснеет (мутация записана в Notes)
- [x] Reference Contract — `Y`; Resolved decisions применены

## Notes
- Браузерная проверка оркестратора (2026-10-30, dev-сервер, desktop): сворачивание через «Боковая панель» пишет `sidebar_state=false`, F5 сохраняет полосу 48 px (`data-state=collapsed`); серверный HTML содержит `data-state="collapsed"` при Cookie `sidebar_state=false` и `"expanded"` при `true` — анимации раскрытия на первом кадре нет (AC-21.1 PASS).
- Из S-11 (T1.4, 2026-10-30), обязательные пункты:
  - Начальный фокус при открытии шторки — на «Новый чат» (AC-10.2): сейчас фокус попадает на сам элемент диалога; задать `initialFocus` у base-ui `Drawer` (в `ui/sidebar.tsx`), `finalFocus` — на «Меню».
  - Кнопка «×» «Закрыть меню» в шапке шторки (UXRD 761) отсутствует — добавить.
- Impact scope: `chat-shell.tsx`, `app-sidebar.tsx`, `ui/sidebar.tsx` правятся далее (см. «Пересечения файлов»).
- Scope boundary: `apps/web/src/components/ui/button.tsx` и прочие `ui/*` вне Target Files не менять.
