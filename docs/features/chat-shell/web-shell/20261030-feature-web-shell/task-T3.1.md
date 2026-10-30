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
Заменить разметку спайка раскладкой SH-01: `SidebarProvider` с `defaultOpen` из cookie, `SidebarInset` как `main`, `AppSidebar` без списка (полоса/шторка), граница ошибок `(chat)/error.tsx`, `useMediaQuery`, правки `ui/sidebar.tsx` (`setOpen(value, { persist })`, переход ширины). Механизм AC-07.1, AC-10.1–10.3, AC-21.1, Element 4; S-11 (компонентный тест).

## Target Files
- [ ] `apps/web/src/components/shell/chat-shell.tsx`
- [ ] `apps/web/src/components/shell/app-sidebar.tsx` (new)
- [ ] `apps/web/src/app/(chat)/error.tsx` (new)
- [ ] `apps/web/src/app/(chat)/layout.tsx`
- [ ] `apps/web/src/hooks/use-media-query.ts` (new)
- [ ] `apps/web/src/components/ui/sidebar.tsx`
- [ ] `apps/web/src/components/shell/app-sidebar.test.tsx` (new)

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
| `(chat)/error.tsx` | `'use client'`: «Что-то пошло не так» + «Обновить страницу», `console.error` с `digest` | План T3.1 |
| `useMediaQuery(query)` | `useSyncExternalStore` над `matchMedia` | План T3.1 |
| Охрана `Ctrl/⌘+B` | Не здесь — T6.2 | План T6.2 |
| Свайп | Только L1-3 (T8.3) | План T3.1 |

## Investigation Notes
(Планируемый подход, прочитанные доки, детали `finalFocus` для S-11.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets
- [ ] `app-sidebar.test.tsx` — 1 тест S-11: при мобильной ширине «Меню» открывает `role="dialog"` «История бесед», фокус на «Новый чат», Esc закрывает, фокус возвращается на «Меню» (AC-10.2 — механизм)
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `useMediaQuery`, правки `ui/sidebar.tsx`, `AppSidebar`, `ChatShell`, `error.tsx`, `layout.tsx` (если требуется доработка прокидывания `defaultSidebarOpen`)
- [ ] Тест зелёный

### 3. Refactor Phase
- [ ] Упростить; убедиться, что тест не проходит по построению

### 4. Быстрая проверка (оркестратор, `dev`)
- [ ] Свернуть сайдбар, F5 — полоса на первом кадре (AC-21.1)

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
- [ ] Тест зелёный (содержательно)
- [ ] lint, tsc, build — 0 ошибок
- [ ] dev: свернуть сайдбар, F5 — полоса на первом кадре (быстрая проверка AC-21.1)
- [ ] Proof obligation: без `finalFocus` тест краснеет (мутация записана в Notes)
- [ ] Reference Contract — `Y`; Resolved decisions применены

## Notes
- Impact scope: `chat-shell.tsx`, `app-sidebar.tsx`, `ui/sidebar.tsx` правятся далее (см. «Пересечения файлов»).
- Scope boundary: `apps/web/src/components/ui/button.tsx` и прочие `ui/*` вне Target Files не менять.
