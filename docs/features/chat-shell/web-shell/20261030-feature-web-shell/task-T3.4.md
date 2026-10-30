# Task T3.4: `MainView` + `resolveMainView`, `ThreadNotice` (TH-06, TH-07), лента 48rem, скелетон, заголовок приветствия и подпись композера; интеграционный `shell.open-thread` (AC-02.2 + AC-04.3)

Metadata:
- Task type: frontend (apps/web)
- Phase: 3
- Dependencies: task-T3.1, task-T3.3 → Deliverable: `chat-shell.tsx`, `chat-header.tsx`; task-T2.1 → Deliverable: обвязка `src/test/*` и перенесённый `shell.open-thread.int.test.tsx`
- Provides: `resolveMainView`, `MainView`, `ThreadNotice` (варианты `not-found`/`load-error`), `ThreadHistorySkeleton`; строки «Чем могу помочь?», «Сообщение» для T4.2
- Size: Medium (8 файлов)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; Postgres 5433 для dev/L1.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`.
- Правила 1–10 из `_overview.md` обязательны (**правило 10** — для `shell.open-thread`).

## Implementation Content
Определитель вида основной области (`resolveMainView`), `MainView`, уведомления TH-06/TH-07, скелетон истории (TH-05), лента 48rem, русские строки заголовка приветствия, подписи и placeholder композера. Наполняет первый кейс `shell.open-thread` (AC-02.2 прямая ссылка + AC-04.3). AC-02.2, AC-04.3; AC-02.5, AC-04.2 — механизм.

## Target Files
- [ ] `apps/web/src/lib/threads/resolve-main-view.ts` (new)
- [ ] `apps/web/src/lib/threads/resolve-main-view.test.ts` (new)
- [ ] `apps/web/src/components/shell/main-view.tsx` (new)
- [ ] `apps/web/src/components/shell/thread-notice.tsx` (new)
- [ ] `apps/web/src/components/shell/thread-notice.test.tsx` (new)
- [ ] `apps/web/src/components/assistant-ui/elements/thread.aui.tsx` (`--thread-max-width: 48rem`, `export ThreadHistorySkeleton`, заголовок приветствия, подпись и placeholder композера)
- [ ] `apps/web/src/components/shell/chat-shell.tsx` (подключение `MainView`)
- [ ] `apps/web/src/components/shell/shell.open-thread.int.test.tsx`

## Investigation Targets
- DD «Contract Definitions» (`resolve-main-view.ts`), State × Display Matrix, UXRD 6.1, 6.14–6.19
- `apps/web/src/components/shell/shell.open-thread.int.test.tsx` (перенесён в T2.1; комментарии Arrange/Act/Assert)
- `apps/web/src/test/{fixtures,render-with-runtime}.ts(x)` (`deferred()`)
- `apps/web/src/components/assistant-ui/elements/thread.aui.tsx`, `lib/threads/shell-status-store.ts`

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Contract Definitions, `resolve-main-view.ts`) | derived-display | «1) switchError?.threadId === routeThreadId → not_found ? not-found : load-error/switch 2) routeThreadId !== undefined && mainRemoteId !== routeThreadId → switching (скелетон, не приветствие — AC-02.2) 3) historyStatus === 'not_found' → not-found; 'load_failed' → load-error/history 4) routeThreadId !== undefined && (historyStatus === undefined \|\| historyStatus === 'loading') → switching 5) иначе thread { deleted: historyStatus === 'deleted' }» | Y, если `resolveMainView` применяет правила 1–5 в указанном порядке и таблица U-тестов покрывает все ветви |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `MainView` | → `Thread` (`autoFocus={false}`), `ThreadNotice` или `ThreadHistorySkeleton` | План T3.4 |
| `ThreadHistorySkeleton` | `role="status"` с именем «Загружаем беседу…», появление через 150 мс | План T3.4 |
| `ThreadNotice` | варианты `not-found` / `load-error` (`h1 tabIndex={-1}`, фокус при монтировании, «Повторить» → `retrySwitch`/`retryHistory`, «Новый чат»); вариант `deleted` — T7.3 | План T3.4 |
| `thread.aui.tsx` строки | «Чем могу помочь?» вместо `How can I help you today?`; композер `aria-label="Сообщение"` вместо `Message input`; placeholder «Спросите что-нибудь…» вместо `Send a message...` цветом `text-muted-foreground` без прозрачности (UXRD TH-04) | План T3.4 |
| Не здесь | Подсказки 2×2, прочие тексты приветствия, фокус-политика — T4.3; кейсы F5 и AC-02.5 `shell.open-thread` — T4.2 (утверждают ссылку сайдбара «Отчёт», которой ещё нет) | План, правило 10 |
| Наполнение I-кейса | Только первый тест файла (AC-02.2 + AC-04.3): скелетон «Загружаем беседу…» при удержанном `GET /api/threads/x`, приветствия «Чем могу помочь?» нет; затем 404 → «Беседа не найдена», фокус на `h1`, поля «Сообщение» нет. Остальные два `it.todo` файла остаются `it.todo` | План T3.4 |

## Investigation Notes
(Правило 10: перечислить каждую строку и элемент из Assert первого кейса и отметить, что они поставляются T3.4 или более ранней задачей: «Загружаем беседу…», «Чем могу помочь?», «Беседа не найдена», `h1` с фокусом, «Сообщение».)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать Investigation Targets; сверить Assert I-кейса по правилу 10
- [ ] U `resolve-main-view.test.ts` — все ветви таблицы, включая правило 4: `{ routeThreadId: 'x', mainRemoteId: 'x', historyStatus: undefined }` и `'loading'` → `switching`; `'ready'` → `thread`; `{ routeThreadId: undefined, historyStatus: undefined }` → `thread`
- [ ] C `thread-notice.test.tsx` — тексты TH-06/TH-07, фокус на заголовке (E-8 — строка добавляется в T7.3)
- [ ] I `shell.open-thread.int.test.tsx` — 1 тест из трёх (AC-02.2 + AC-04.3)
- [ ] Запустить, увидеть падение

### 2. Green Phase
- [ ] `resolve-main-view.ts`, `main-view.tsx`, `thread-notice.tsx`, правки `thread.aui.tsx`, подключение в `chat-shell.tsx`; тесты зелёные

### 3. Refactor Phase
- [ ] Упростить; интеграционные 1/10

## Quality Assurance Mechanisms
- Vitest + RTL + MSW, ESLint, `tsc`, `next build` — Type: `executable_check`
- Обёртки assistant-ui — `*.aui.tsx`; оболочка — `components/shell/*.tsx` — Type: `passive_constraint`
- Стиль: файлы приложения — одинарные кавычки и `;`; `thread.aui.tsx` — стиль файла — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: U, C, I + гейты. Браузерная проверка `/chat/does-not-exist` → «Беседа не найдена» (вкладка — после T4.3).
- **Success criteria**: U, C, I зелёные; интеграционные 1/10; утверждения о «Чем могу помочь?» и «Сообщение» проверяют строки, которые есть в рендере.
- **Failure response**: кейс требует строки более поздней задачи — не наполнять, эскалация (перенос через `update` плана).
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-02.2 — скелетон, а не приветствие, при прямой ссылке
- **Claim**: при удержанном `GET /api/threads/x` показывается «Загружаем беседу…», приветствия «Чем могу помочь?» нет.
- **Primary failure mode**: правило 2 удалено (`switching` → `thread`): мелькает приветствие.
- **Boundary to exercise**: интеграционный (ChatRuntimeProvider + MainView + MSW с `deferred()`).
- **State assertion**: до разрешения — скелетон, нет приветствия; после 404 — «Беседа не найдена».
- **Mock boundary rationale**: сеть — MSW; `next/navigation` — мок.
- **Proven by**: `new: shell.open-thread.int.test.tsx — AC-02.2 + AC-04.3` (первый тест; ловит гонку отображения, которую не видит U-тест).
- **Residual**: F5-гонка — T4.2.

### Obligation: AC-04.3 — `switchError` доходит до TH-06
- **Claim**: 404 → «Беседа не найдена», фокус на `h1`, поля «Сообщение» нет.
- **Primary failure mode**: `switchError` не доходит до `ThreadNotice`.
- **Boundary to exercise**: интеграционный.
- **State assertion**: скелетон → «Беседа не найдена», `document.activeElement` — `h1`.
- **Mock boundary rationale**: сеть — MSW.
- **Proven by**: `new: shell.open-thread.int.test.tsx — AC-04.3 (тот же тест)`.
- **Residual**: классификация 404 — unit T2.2.

### Obligation: Правило 4 `resolveMainView`
- **Claim**: `routeThreadId` задан, `mainRemoteId` совпадает, `historyStatus` `undefined`/`loading` → `switching`.
- **Primary failure mode**: правило 4 удалено.
- **Boundary to exercise**: in-process unit (таблица).
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Proven by**: `new: resolve-main-view.test.ts — строки правила 4`.
- **Residual**: нет.

## Completion Criteria
- [ ] U, C, I зелёные; интеграционные 1/10; прогон содержательный
- [ ] Утверждения о «Чем могу помочь?» и «Сообщение» проверяют строки, которые есть в рендере (правило 10)
- [ ] lint, tsc, build — 0 ошибок
- [ ] Каждый Proof Obligation: мутация (правило 2/4 удалено; `switchError` отрезан) краснит тест — записана в Notes
- [ ] Reference Contract — `Y`; Resolved decisions применены

## Notes
- Impact scope: `thread.aui.tsx` далее правят T4.3, T7.2, T7.3, T7.5; `thread-notice.tsx` — T7.3; `main-view.tsx` — T4.3, T7.3.
- Scope boundary: второй и третий `it.todo` файла `shell.open-thread` не трогать.
- Из T2.4: `thread.aui.tsx:230` локально задаёт `["--thread-max-width" as string]: "44rem"` и перекрывает глобальный токен `--thread-max-width: 48rem` из `globals.css` (UXRD 11.2) — убрать локальное значение, чтобы колонка ленты брала токен.
