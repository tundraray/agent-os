# Task T4.2: Список бесед — `ThreadHistoryList` + `ThreadHistoryListView`, `ThreadHistoryItem` (отображение), `ThreadActivityTracker`, ↑/↓/Home/End; интеграционные `shell.list` и `shell.open-thread` (F5, AC-02.5)

Metadata:
- Task type: frontend (apps/web)
- Phase: 4
- Dependencies: task-T4.1 → Deliverable: `group-threads-by-date.ts`, `use-now.ts`; task-T3.4 → Deliverable: `MainView`, `ThreadNotice`, заголовок приветствия «Чем могу помочь?», подпись «Сообщение», `shell.open-thread.int.test.tsx` (первый кейс); T3.1 позади
- Provides: список бесед в сайдбаре, `ThreadActivityTracker`, `thread-history-item.tsx` для T4.3, T5.1, T5.2, T6.1
- Size: Medium (8 файлов)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000` (в тестах `http://api.test`); Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны (**правило 10** — для двух I-файлов).

## Implementation Content
Сайдбар по датам: контейнер `ThreadHistoryList` и вид `ThreadHistoryListView`, элемент `ThreadHistoryItem` (ссылка, `aria-current`, тултип, «Новая беседа» + `ShimmerLabel`), `ThreadActivityTracker`, навигация ↑/↓/Home/End. Наполняет `shell.list` (AC-01.7 + AC-01.5) и два оставшихся кейса `shell.open-thread` (F5, AC-02.5). AC-01.1–01.7, AC-02.2 (F5), AC-02.5, AC-03.3 (механизм), AC-22.2; AC-12.1 — состояния сайдбара; Open Questions DD п. 2.

## Target Files
- [ ] `apps/web/src/components/shell/thread-history-list.tsx` (new)
- [ ] `apps/web/src/components/shell/thread-history-item.tsx` (new)
- [ ] `apps/web/src/components/shell/thread-activity-tracker.tsx` (new)
- [ ] `apps/web/src/components/shell/thread-history-list.test.tsx` (new)
- [ ] `apps/web/src/components/shell/app-sidebar.tsx` (подключение)
- [ ] `apps/web/src/components/shell/chat-shell.tsx` (монтирование `ThreadActivityTracker`)
- [ ] `apps/web/src/components/shell/shell.list.int.test.tsx`
- [ ] `apps/web/src/components/shell/shell.open-thread.int.test.tsx` (кейсы F5 и AC-02.5)

## Investigation Targets
- DD «Main Components» (`ThreadHistoryList`, `ThreadHistoryItem`, `ThreadActivityTracker`), State × Display Matrix (SB-09), UXRD 6.4, 6.5, 7.2, 7.3
- `apps/web/src/components/shell/shell.list.int.test.tsx`, `shell.open-thread.int.test.tsx` (перенесены в T2.1; комментарии Arrange/Act/Assert)
- `apps/web/src/lib/threads/{group-threads-by-date,route-thread-id,shell-status-store,resolve-main-view}.ts`
- `apps/web/src/components/surfaces.tsx` (`ShimmerLabel`, `pressable`)

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Contract Definitions, `group-threads-by-date.ts`) | structure-order | `today: 'Сегодня', yesterday: 'Вчера', previous7: 'Предыдущие 7 дней', previous30: 'Предыдущие 30 дней', older: 'Старше'`; группы по `activityAt` DESC, пустые группы не возвращаются | Y, если вид рендерит группы в указанном порядке под `h2` с этими метками |
| design-web-shell.md (§ State × Display Matrix) | derived-display | SB-09: «`role="status"` «Загружаем беседы…»», «Пока нет бесед» / «Начните новый чат — он появится здесь.», «Не удалось загрузить беседы» + «Повторить» → `threads.reload()`; SB-10: «`role="status"` «Загружаем ещё беседы…»», «Не удалось загрузить ещё беседы» + «Повторить» → `loadMore()» | Y, если тексты и роли SB-09 совпадают; SB-10 — в T6.1 |
| design-web-shell.md (§ State Transitions and Invariants) | state-lifecycle-negative | «Элемент списка не перемещается при переименовании и приходе автозаголовка до перезагрузки списка» | Y, если порядок элементов меняется только по `activityAt`/перезагрузке списка |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Контейнер | `useAuiState` → `threadItems` (`status === 'regular'`), `isLoading`, `loadError`, `hasMore`, `isLoadingMore`, `mainThreadId`; `ShellStatus` → `activityAt`, `loadMoreFailed`, `titleWaiting`; `useNow()`; «Повторить» SB-09 → `threads.reload()`; при возврате во вкладку `reload()` только если загружена одна страница, иначе — только пересчёт групп | План T4.2 (Open Questions п. 2) |
| Вид | Loading `role="status"`, Error-текст в `role="alert"`, «Повторить» вне `alert`; группы `h2` (через `render` у `SidebarGroupLabel`) + `ul` | План T4.2 |
| Элемент | `li > SidebarMenuButton render={<Link href={threadPath(remoteId)} data-thread-link …/>}`, `aria-current="page"` у активной; обрезка в одну строку + тултип (500 мс или фокус); «Новая беседа» + `ShimmerLabel` при `isRunning \|\| titleWaiting`; в hover/active/открытом меню — только `text-sidebar-accent-foreground`; фокус по клику добавляет T4.3 вместе с `lib/focus.ts` | План T4.2 |
| `ThreadActivityTracker` | фронт `isRunning` false→true → `status.bumpActivity(id, Date.now())` | План T4.2 |
| Клавиатура | ↑/↓/Home/End — `onKeyDown` контейнера по `a[data-thread-link]` через границы групп, `preventDefault()`; Tab-порядок не меняется | План T4.2 |
| Наполнение I-кейсов | `shell.list` — 1 тест (AC-01.7 + AC-01.5); `shell.open-thread` — 2 оставшихся (F5; AC-02.5). Каждая строка/элемент Assert (в т.ч. отрицательные утверждения) сверяется с поставкой T4.2 и ранее до наполнения | Правило 10 |

## Investigation Notes
(Правило 10: таблица «строка/элемент Assert → кто поставляет» для `shell.list`, F5, AC-02.5: ссылка «Отчёт» с `aria-current="page"` (T4.2), «Чем могу помочь?» (T3.4), «Сообщение» (T3.4), «Не удалось загрузить беседу» (T3.4/T4.2 — уточнить по TH-07), «Повторить» (T3.4/T4.2).)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets; сверить Assert I-кейсов (правило 10)
- [ ] C `thread-history-list.test.tsx` — Loading, Empty, Error (`getByRole('alert')` «Не удалось загрузить беседы», «Повторить» вызывает `onRetry`), Ready (`h2`, ссылки, `aria-current="page"`) — 4 теста AC-12.1; ↑/↓/Home/End между группами (AC-22.2); тултип при обрезке (AC-01.6)
- [ ] I `shell.list.int.test.tsx` — 1 тест (AC-01.7 + AC-01.5): невалидный ответ списка → SB-09 Error в `alert`, композер «Сообщение» (T3.4) отправляет новый чат; «Повторить» → второй `GET /api/threads` без `cursor` → список
- [ ] I `shell.open-thread.int.test.tsx` — 2 теста: AC-02.2 F5 (список отвечает после истории, `MutationObserver` — «Чем могу помочь?» не появлялся, ссылка сайдбара «Отчёт» с `aria-current="page"`); AC-02.5 (невалидная история → «Не удалось загрузить беседу», ссылка «Отчёт» в сайдбаре на месте, «Повторить» → сообщения)
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `thread-history-list.tsx` (контейнер + вид), `thread-history-item.tsx`, `thread-activity-tracker.tsx`; подключение в `app-sidebar.tsx`, монтирование трекера в `chat-shell.tsx`; тесты зелёные

### 3. Refactor Phase
- [ ] Разделение контейнер/вид; интеграционные 4/10

## Quality Assurance Mechanisms
- Vitest + RTL + MSW, ESLint, `tsc`, `next build` — Type: `executable_check`
- Контраст: в hover/active/открытом меню — только `text-sidebar-accent-foreground` (UXRD 7.6) — Type: `passive_constraint`
- Движение/нажатия — `surfaces.tsx` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: C и I + гейты; в `dev` ссылки списка кликабельны (первичный просмотр).
- **Success criteria**: C и I зелёные; интеграционные 4/10; lint, tsc, build — 0.
- **Failure response**: кейс требует элемента более поздней задачи — не наполнять, эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-01.7 + AC-01.5 — ошибка списка не ломает композер; «Повторить» перезагружает
- **Claim**: невалидный ответ списка → SB-09 Error в `alert`, композер работает; «Повторить» → второй `GET /api/threads` без `cursor`.
- **Primary failure mode**: библиотека глотает ошибку списка / невалидный ответ ломает композер; «Повторить» — no-op.
- **Boundary to exercise**: интеграционный (рантайм + MSW).
- **State assertion**: Error → клик «Повторить» → список.
- **Mock boundary rationale**: сеть — MSW.
- **Proven by**: `new: shell.list.int.test.tsx — AC-01.7 + AC-01.5`.
- **Residual**: вид кнопки и вызов `onRetry` — C `thread-history-list.test.tsx`.

### Obligation: AC-02.2 F5 — приветствие не мелькает, пока список отвечает после истории
- **Claim**: при F5 список отвечает после истории, «Чем могу помочь?» не появляется; ссылка «Отчёт» `aria-current="page"`.
- **Primary failure mode**: правило 4 `resolveMainView` удалено — мелькает приветствие.
- **Boundary to exercise**: интеграционный с `MutationObserver`.
- **State assertion**: приветствие ни разу не в DOM; ссылка активна.
- **Mock boundary rationale**: сеть — MSW (`deferred`).
- **Proven by**: `new: shell.open-thread.int.test.tsx — AC-02.2 F5`.
- **Residual**: нет.

### Obligation: AC-02.5 — ошибка истории видна, «Повторить» освобождает `RetryGate`
- **Claim**: невалидная история → «Не удалось загрузить беседу», ссылка «Отчёт» на месте, «Повторить» → сообщения.
- **Primary failure mode**: `retryHistory` не вызывает `retry`.
- **Boundary to exercise**: интеграционный.
- **State assertion**: `load_failed` → клик → сообщения отображены.
- **Mock boundary rationale**: сеть — MSW.
- **Proven by**: `new: shell.open-thread.int.test.tsx — AC-02.5`.
- **Residual**: нет.

### Obligation: AC-01.1–01.6 / AC-22.2 — вид списка и клавиатура
- **Claim**: состояния Loading/Empty/Error/Ready; `aria-current="page"`; ↑/↓/Home/End; тултип при обрезке.
- **Primary failure mode**: `aria-current="true"` вместо `"page"`; «Повторить» не вызывает `onRetry`.
- **Boundary to exercise**: компонентный (по props вида).
- **State assertion**: N/A.
- **Mock boundary rationale**: презентационный вид без рантайма.
- **Proven by**: `new: thread-history-list.test.tsx` (4 + навигация + тултип).
- **Residual**: SB-10 — T6.1; фокус после удаления — T5.2.

## Completion Criteria
- [ ] C и I зелёные; интеграционные 4/10
- [ ] lint, tsc, build — 0 ошибок
- [ ] Мутации (`Повторить` no-op → краснеет `shell.list`; `aria-current="true"` → краснеет C; правило 4 удалено → краснеет F5; `retryHistory` без `retry` → краснеет AC-02.5) записаны в Notes
- [ ] Reference Contracts — `Y`; Resolved decisions применены

## Notes
- Impact scope: `thread-history-item.tsx` далее правят T4.3, T5.1, T5.2; `thread-history-list.tsx` — T5.2, T6.1; `app-sidebar.tsx` — T6.2; `chat-shell.tsx` — T5.3, T6.2.
- Scope boundary: вне Target Files не менять; SB-10 в T6.1; фокус по клику — T4.3.
