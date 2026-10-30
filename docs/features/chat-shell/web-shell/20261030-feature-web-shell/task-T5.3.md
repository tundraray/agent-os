# Task T5.3: Рабочая область (WS-01…WS-03), HD-04, временная свёртка сайдбара; интеграционный `shell.workspace`

Metadata:
- Task type: frontend (apps/web)
- Phase: 5
- Dependencies: task-T3.3 → Deliverable: `chat-header.tsx` (HD-04); по файлам `chat-shell.tsx` — после T5.2 (последовательность T4.2 → T5.3)
- Provides: `WorkspacePanel`; временная свёртка сайдбара без записи cookie
- Size: Small–Medium (4 файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны (**правило 10** — для `shell.workspace`).

## Implementation Content
Рабочая область: `ResizablePanelGroup` в `SidebarInset` (панель чата + `collapsible` панель), `workspaceOpen` × `useMediaQuery('(min-width: 1024px)')`, временная свёртка сайдбара (`setOpen(false, { persist: false })`), `Separator` с клавиатурой, возврат фокуса на HD-04. Наполняет `shell.workspace` (AC-11.3 + AC-11.1). AC-11.1–11.4; Element 4; S-10.

## Target Files
- [ ] `apps/web/src/components/shell/workspace-panel.tsx` (new)
- [ ] `apps/web/src/components/shell/chat-shell.tsx`
- [ ] `apps/web/src/components/shell/chat-header.tsx` (HD-04 обработчик)
- [ ] `apps/web/src/components/shell/shell.workspace.int.test.tsx`

## Investigation Targets
- `apps/web/node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts` (`collapsible`, `panelRef`, единицы `px`/`%`)
- `apps/web/src/components/ui/resizable.tsx`
- UXRD 6.13, 6.22 (WS-01…WS-03), 7.4; DD Element 4
- `apps/web/src/components/shell/shell.workspace.int.test.tsx` (перенесён и слит в T2.1)
- `ui/sidebar.tsx` (`setOpen(value, { persist })` из T3.1), `use-media-query.ts`

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Тема, шрифт, токены, сайдбар) | state-lifecycle-negative | «cookie `sidebar_state` (пишет shadcn при пользовательском переключении) читается сервером в layout группы → `SidebarProvider defaultOpen`»; «временное сворачивание (рабочая область) — `setOpen(false, { persist: false })`» | Y, если свёртка сайдбара ради рабочей области использует `persist: false` и не меняет cookie |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Раскладка | `ResizablePanelGroup`: панель чата + `collapsible` панель рабочей области (`collapsedSize={0}`, `minSize="360px"`, лента ≥ 480 px, открытие 40 %) | План T5.3 |
| Видимость | `workspaceOpen` (`useState`, по умолчанию `false`) × `useMediaQuery('(min-width: 1024px)')`; основная область < 840 px → `setOpen(false, { persist: false })` и разворачивание при закрытии | План T5.3 |
| Разметка | `aside aria-label="Рабочая область"`, шапка 56 px с «×»; `Separator` `aria-label="Изменить ширину рабочей области"`, ←/→ ±16 px, Shift ±64 px, Home/End | План T5.3 |
| Фокус | закрытие → фокус на HD-04; плейсхолдер | План T5.3 |
| I-тест | 1 тест (AC-11.3 + AC-11.1): после загрузки `complementary` «Рабочая область» нет, HD-04 `aria-expanded="false"`; клик HD-04 → панель, `"true"`; «×» → панели нет, фокус на HD-04; повторный клик HD-04 открывает, ещё клик закрывает — фокус на HD-04 | План T5.3 |
| S-10 не подтвердился | Условный рендер панели без анимации | Таблица S-1…S-11 |

## Investigation Notes
(Правило 10: Assert — `complementary` «Рабочая область» (T5.3), HD-04 `aria-expanded` (T3.3 + T5.3).)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets; сверить Assert (правило 10)
- [ ] I `shell.workspace.int.test.tsx` — 1 тест
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `workspace-panel.tsx`; правки `chat-shell.tsx`, `chat-header.tsx`; тест зелёный

### 3. Refactor Phase
- [ ] Упростить; интеграционные 8/10

## Quality Assurance Mechanisms
- Vitest + RTL, ESLint, `tsc`, `next build` — Type: `executable_check`
- Политика фокуса; reduced motion; WCAG 2.1 AA — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: I + гейты. Браузер (L1-1, T8.3): HD-04 → панель 40 %, лента ≥ 480 px при 1280; < 1024 px — нет кнопки и панели, при 1440 панель вернулась (S-10).
- **Success criteria**: I зелёный; интеграционные 8/10.
- **Failure response**: S-10 — условный рендер панели.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-11.3 + AC-11.1 — панель скрыта по умолчанию; фокус возвращается на HD-04
- **Claim**: панель закрыта после загрузки; клик HD-04 открывает; «×» закрывает с фокусом на HD-04; повтор HD-04 открывает/закрывает с фокусом на HD-04.
- **Primary failure mode**: закрытие «×» без переноса фокуса (фокус на `body`); `workspaceOpen` по умолчанию `true`.
- **Boundary to exercise**: интеграционный (ChatShell целиком).
- **State assertion**: закрыта → открыта (`aria-expanded="true"`) → закрыта (фокус на HD-04).
- **Mock boundary rationale**: `matchMedia`/`ResizeObserver` — полифилы; сеть — MSW.
- **Proven by**: `new: shell.workspace.int.test.tsx — AC-11.3 + AC-11.1`.
- **Residual**: AC-11.2/11.4 (ширина, клавиатура ручки, < 1024 px) — L1-1.

### Obligation: Failure Mode: shared-state dependency — временная свёртка сайдбара
- **Claim**: свёртка ради рабочей области не пишет cookie.
- **Primary failure mode**: `persist` по умолчанию `true` → cookie перезаписан.
- **Boundary to exercise**: L1 (cookie); код — `setOpen(false, { persist: false })`.
- **State assertion**: cookie `sidebar_state` до = после.
- **Mock boundary rationale**: none.
- **Proven by**: `existing/planned: L1-1 (T8.3)`; автотеста нет (cookie jsdom — вне бюджета).
- **Residual**: проверяется только в браузере.

## Completion Criteria
- [ ] I зелёный; интеграционные 8/10
- [ ] lint, tsc, build — 0 ошибок
- [ ] Мутации («×» без переноса фокуса; `workspaceOpen=true` по умолчанию) краснят I (записано)
- [ ] Reference Contract — `Y`; Resolved decisions применены

## Notes
- Impact scope: `chat-shell.tsx`, `chat-header.tsx` далее правит T6.2.
- Scope boundary: вне Target Files не менять.
