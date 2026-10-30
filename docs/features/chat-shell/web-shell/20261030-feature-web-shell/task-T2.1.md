# Task T2.1: Vitest 4 + RTL + MSW 2 + jsdom 29, обвязка `src/test/`, перенос и слияние скелетов, `config.test.ts`

Metadata:
- Task type: frontend (apps/web) + перенос скелетов из `docs/`
- Phase: 2 — фундамент (шаг 2 DD)
- Dependencies: task-T1.4 (общие `package.json`, `pnpm-lock.yaml`; гейт G1 к этому моменту пройден; `ui/sonner.tsx` из T1.4)
- Provides: Vitest/RTL/MSW-обвязка (`src/test/*`), 7 перенесённых скелетов `*.int.test.tsx` (10 `it.todo`) для T3.4, T4.2, T4.3, T5.2, T5.3, T7.3; скрипты `test`, `test:watch`
- Size: Large по числу файлов (≈ 16: 2 манифеста, конфиг, 4 обвязки, 1 тест, 7 переносов + 7 удалений) — допустимо как единая единица «инфраструктура + перенос»; не разбивать (перенос и слияние скелетов неделимы с обвязкой)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- Postgres 5433 нужен только для L1; тесты T2.1 идут без API (AC-12.2). `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, `pnpm --filter web test`, `next build`. Перед прямым vitest — `pnpm --filter @agent-os/contracts build`, если `dist` старше `src`.
- Правила 1–10 из `_overview.md` обязательны.

## Implementation Content
Поднять тестовую инфраструктуру `apps/web` (FR-12, AC-12.2): Vitest 4 + RTL + MSW 2 + jsdom 29, полифилы jsdom, фикстуры, `renderWithRuntime`. Перенести 7 скелетов из `docs/features/chat-shell/web-shell/test-skeletons/` в `apps/web/src/components/shell/` с слиянием 14 → 10 `it.todo` (раздел плана «Решение по бюджету интеграционных тестов»); исходные файлы и каталог удалить. Добавить `config.test.ts`.

## Target Files
- [x] `apps/web/package.json`
- [x] `pnpm-lock.yaml`
- [x] `apps/web/vitest.config.ts` (new)
- [x] `apps/web/src/test/setup.ts` (new)
- [x] `apps/web/src/test/msw-server.ts` (new)
- [x] `apps/web/src/test/fixtures.ts` (new)
- [x] `apps/web/src/test/render-with-runtime.tsx` (new)
- [x] `apps/web/src/lib/config.test.ts` (new)
- [x] `apps/web/src/components/shell/shell.list.int.test.tsx` (new — перенос)
- [x] `apps/web/src/components/shell/shell.new-chat.int.test.tsx` (new — перенос)
- [x] `apps/web/src/components/shell/shell.open-thread.int.test.tsx` (new — перенос)
- [x] `apps/web/src/components/shell/shell.deleted-thread.int.test.tsx` (new — перенос)
- [x] `apps/web/src/components/shell/shell.message-error.int.test.tsx` (new — перенос)
- [x] `apps/web/src/components/shell/shell.delete-open-thread.int.test.tsx` (new — перенос)
- [x] `apps/web/src/components/shell/shell.workspace.int.test.tsx` (new — перенос)
- [x] `docs/features/chat-shell/web-shell/test-skeletons/*.int.test.tsx` (delete — 7 файлов, каталог удаляется)

## Investigation Targets
- DD «Инструменты и версии», абзац о `vitest.config.ts` и `setup.ts`
- `apps/api/vitest.config.ts` (та же линия Vitest 4 / Vite 8)
- Комментарии «Harness» в скелетах `docs/features/chat-shell/web-shell/test-skeletons/*.int.test.tsx` (текущее содержимое рабочего дерева, **включая неотслеживаемый** `shell.message-error.int.test.tsx` и изменённые файлы)
- `turbo.json`
- `apps/web/src/components/ui/sonner.tsx` (из T1.4)
- Раздел плана «Решение по бюджету интеграционных тестов»

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Test Strategy, `vitest.config.ts`) | state-lifecycle-negative | «в начале модуля `process.env.TZ = 'Europe/Berlin'`»; «`test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], include: ['src/**/*.test.{ts,tsx}'], env: { NEXT_PUBLIC_API_URL: 'http://api.test' } }`»; MSW «`onUnhandledRequest: 'error'`» | Y, если `vitest.config.ts` содержит перечисленное дословно, MSW-сервер создан с `onUnhandledRequest: 'error'` |
| design-web-shell.md (§ Contract Definitions, `lib/config.ts`) | state-lifecycle-negative | `z.url({ protocol: /^https?$/ }).safeParse(process.env.NEXT_PUBLIC_API_URL)`; при провале — `throw new Error('NEXT_PUBLIC_API_URL must be an absolute http(s) URL')`; `apiBaseUrl = parsed.data.replace(/\/+$/, '')` | Y, если `config.test.ts` покрывает: не задан, `'localhost:4000'`, `'ftp://x'` → исключение; `'http://api.test/'` → `apiBaseUrl === 'http://api.test'` |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Версии devDependencies | `vitest` `^4.1.12`, `vite` `^8.0.0`, `@vitejs/plugin-react` `^6.1.2`, `jsdom` `^29.1.1` (не 30.x: Node 24.11 < 24.15), `@testing-library/react` `^16.3.3`, `@testing-library/dom` `^10.4.2`, `@testing-library/jest-dom` `^7.0.1`, `@testing-library/user-event` `^14.6.8`, `msw` `^2.15.0` | План T2.1 |
| Скрипты | `"test": "vitest run"`, `"test:watch": "vitest"` | План T2.1 |
| Каталог интеграционных тестов | `apps/web/src/components/shell/` (правило «рядом с кодом»; `include` их подхватывает) | План, п. 3 закрытых вопросов |
| Слияния скелетов (14 → 10) | AC-11.1 → в тест AC-11.3 (`shell.workspace`); AC-03.3 → в тест AC-04.1 (`shell.new-chat`; фикстура: беседа с `updatedAt` сегодня 09:00); AC-01.5 «Повторить» → в тест AC-01.7 (`shell.list`); AC-04.3 → в первый тест AC-02.2 (`shell.open-thread`). Слитые `it.todo` удаляются, их Arrange/Act/Assert-комментарии переносятся в принимающий кейс | План, раздел бюджета |
| Лимит интеграционных тестов | 10 при расширенном лимите 5 — исключение, утверждено пользователем | План, п. 4 закрытых вопросов |
| `deferred()` | `deferred()` → `{ promise, resolve, reject }` — удержание ответа MSW; импортирует `shell.open-thread`, используют T3.4 и T4.2 | План T2.1 |
| `<Toaster />` | В `renderWithRuntime` рядом с `ChatShell` из `@/components/ui/sonner` — для тоста «Беседа удалена» в `shell.delete-open-thread` (T5.2) без правки `src/test/*` | План T2.1 |
| Наполнение `it.todo` | В T2.1 кейсы **не наполняются** (остаются `it.todo`); наполнение — в задачах-поставщиках (правило 10) | Правило выполнения 10 |

## Investigation Notes
(Таблица соответствия 14 → 10 `it.todo` с именами итоговых кейсов; результат `pnpm --filter web test`.)

**Таблица 14 → 10** (каталог `apps/web/src/components/shell/`):

| Файл | Исходные `it.todo` | Итоговый кейс |
|---|---|---|
| `shell.list` | AC-01.7; AC-01.5 «Повторить» | 1. `AC-01.7 + AC-01.5: invalid list payload shows the sidebar error while the composer still sends a new chat; «Повторить» re-requests page 1 and renders the list` |
| `shell.new-chat` | AC-03.2 | 2. `AC-03.2: «Новый чат» then leaving without sending creates no thread and no list item` |
| `shell.new-chat` | AC-04.1; AC-03.3 | 3. `AC-04.1 + AC-03.3: first send creates the thread, streams with its id, replaces URL with /chat/t-1 and shows it first in «Сегодня», active, as «Новая беседа»` (фикстура `old`: `updatedAt` 08:00Z = 09:00 Europe/Berlin, `now` 12:00) |
| `shell.open-thread` | AC-02.2 (первый); AC-04.3 | 4. `AC-02.2 + AC-04.3: a direct link shows the feed skeleton, not the welcome, while the thread is resolving; a 404 then shows «Беседа не найдена» with focus on its h1` (тот же `deferred` на `GET /api/threads/x`, разрешается 404; обработчика `/messages` нет — запрос туда валит тест) |
| `shell.open-thread` | AC-02.2 (F5) | 5. `AC-02.2 (F5): the welcome never appears when the list resolves after the history` |
| `shell.open-thread` | AC-02.5 | 6. `AC-02.5: invalid history shows «Не удалось загрузить беседу»; «Повторить» loads the messages` |
| `shell.deleted-thread` | AC-08.5e | 7. без изменений |
| `shell.message-error` | AC-08.5b | 8. без изменений |
| `shell.delete-open-thread` | AC-06.2 | 9. без изменений |
| `shell.workspace` | AC-11.3; AC-11.1 | 10. `AC-11.3 + AC-11.1: the workspace is hidden on load; closing it by «×» or by the header button hides it and leaves focus on the header button` (Assert 1 — после загрузки, до первого клика) |

Слитые `it.todo` удалены; их Arrange/Act/Assert и строки ROI / Fails when перенесены в принимающий кейс. Во всех семи файлах заголовок: «Harness (src/test/)», строка бюджета «10 it.todo in 7 files», комментарий импортов «added when the case is filled». В `shell.list` (кейс 1) второй ответ `GET /api/threads` содержит и созданную отправкой `t-new` (сервер её уже знает), добавлен обработчик опроса заголовка `GET /api/threads/t-new` — как в AC-04.1 (строгий режим MSW). Исходный каталог `docs/.../test-skeletons/` удалён (`rm -r`).

**Обвязка (`src/test/*`) — API для задач-поставщиков:**
- `renderWithRuntime({ pathname, pointer?='fine', width?=1280, colorScheme?='light', media?={}, defaultSidebarOpen?=true })` → `RenderResult & { router, setPathname }`. Монтирует `<ChatShell defaultSidebarOpen>{null}</ChatShell>` (внутри — `ChatRuntimeProvider`, как в `(chat)/layout`) и рядом `<Toaster />` из `@/components/ui/sonner`. `router` — шпионы `back/forward/refresh/push/replace/prefetch` (новые на каждый рендер); `setPathname` оборачивает смену в `act`. `vi.mock('next/navigation')` (с `importOriginal`) подменяет только `usePathname` (`useSyncExternalStore`) и `useRouter`.
- `setup.ts`: jest-dom; `matchMedia` — управляемые `pointer`, `hover`, `prefers-color-scheme`, `min/max-width` (по `width`, он же `window.innerWidth`), точные запросы `media` в приоритете, неизвестная фича → `false`; живые `MediaQueryList` шлют `change` при смене через экспортируемый `setTestMedia(...)`; `ResizeObserver` / `IntersectionObserver` — no-op; `PointerEvent` у jsdom 29 свой — setup проверяет его наличие (fail-fast) вместо мёртвого полифила; `scrollIntoView`, `has/set/releasePointerCapture` — no-op. После каждого теста: RTL `cleanup()` (globals выключены → авто-cleanup не регистрируется), `server.resetHandlers()`, `vi.restoreAllMocks()` (снимает `vi.spyOn`, напр. `history.replaceState`), сброс медиа к умолчаниям. MSW: `server.listen({ onUnhandledRequest: 'error' })` в `beforeAll`, `close` в `afterAll`; `msw-server.ts` — `setupServer()` без обработчиков (каждый тест объявляет свои).
- `fixtures.ts`: `threadSummary({ id, ... })` (`ThreadSummarySchema.parse`; по умолчанию `title 'Беседа'`, даты 2026-10-28T10:00Z), `threadList(threads, nextCursor = null)` (`ThreadListResponseSchema.parse`), `historyMessages(n | [{ role, text }])` (`ThreadMessagesResponseSchema.parse`; ids `m1…`), `assistantTextChunks(text, messageId = 'm-reply')` (start / text-start / text-delta / text-end / finish), `sseFromChunks(chunks)` → `HttpResponse` SSE v7 (`data: <json>` на чанк + `data: [DONE]`, заголовки как `UI_MESSAGE_STREAM_HEADERS` в `ai`), `deferred<T = void>()` → `{ promise, resolve, reject }`.
- Проверка обвязки временным тестом (удалён): `renderWithRuntime({ pathname: '/chat/a', pointer: 'coarse' })` с реальным рантаймом — `deferred` удержал `GET /api/threads`; история «Вопрос/Ответ» отрисована; ссылка беседы в сайдбаре; отправка через композер → SSE «Готово.» отрисован; «Новый чат» → `router.push('/')`; порядок запросов `GET /api/threads`, `GET /api/threads/a`, `GET /api/threads/a/messages`, `POST /api/chat/assistant`; медиа сбрасываются между тестами; `setup.ts` исполняется один раз на файл, хотя обвязка импортирует из него `setTestMedia`.
- Наблюдения для следующих задач: (1) `next/link` в Vitest — pages-вариант без роутера: клик по ссылке не вызывает `router.push`; тест сам вызывает `setPathname` (так и написано в скелетах). (2) `ChatShell` спайка рендерит собственный `<Toaster />` из `sonner` — пока он не удалён (T2.4/T3.1), в `renderWithRuntime` два тостера и тост дублируется; `shell.delete-open-thread` (T5.2) наполняется позже. (3) Vite 8 предупреждает про `configLoader: 'native'` (ESM-синтаксис в `vitest.config.ts` без `"type": "module"`) — только предупреждение; имя файла задано DD, `type` пакета не меняется.

**Версии (установлено):** vitest 4.1.12, vite 8.3.5 (pnpm записал спецификатор `^8.3.5`, возвращён к `^8.0.0` по DD), @vitejs/plugin-react 6.1.2, jsdom 29.1.1, @testing-library/react 16.3.3, dom 10.4.2, jest-dom 7.0.1, user-event 14.6.8, msw 2.15.0. `pnpm why -r ai`: `apps/web` 7.0.155, `apps/api` 7.0.148 — без изменений.

**Reference Contracts:** (1) `vitest.config.ts` — `process.env.TZ = 'Europe/Berlin'` в начале модуля, `plugins: [react()]`, `resolve: { tsconfigPaths: true }`, `test` дословно; MSW — `onUnhandledRequest: 'error'` в `server.listen` (setup.ts) → **Y**. (2) `config.test.ts` — не задан / `'localhost:4000'` / `'ftp://x'` → исключение с текстом контракта; `'http://api.test/'` → `'http://api.test'` (плюс строка `'https://api.example.com//'`) → **Y**. Две таблицы `it.each` (бросает / значение) вместо одной смешанной — без ветвлений внутри теста.

**Proof obligation (мутации `lib/config.ts`; файл восстановлен, `git diff` пуст):** убран срез хвостовых `/` → 2 кейса красные (`'http://api.test/'`, `'https://api.example.com//'`); `z.url({ protocol: /^https?$/ })` → `z.url()` → 2 кейса красные (`'localhost:4000'`, `'ftp://x'`). Red-фаза: до установки `pnpm exec vitest` → «Command "vitest" not found».

**Результаты гейтов:** `pnpm --filter web test` — 1 файл passed, 7 skipped; 5 passed | 10 todo (15). `pnpm test` (turbo, корень) — `web:test` тот же итог (`api:test` 138 passed). `pnpm --filter web lint` — 0; `pnpm --filter web exec tsc --noEmit` — 0; `pnpm --filter web build` — успешно.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать Investigation Targets, зафиксировать содержимое 7 скелетов рабочего дерева
- [x] Написать `config.test.ts` (`vi.stubEnv` + `vi.resetModules()`; одна табличная проверка по Reference Contracts) — падает до настройки Vitest/пока `config.ts` не соответствует
- [x] Запустить и увидеть падение (нет конфигурации)

### 2. Green Phase
- [x] devDependencies и скрипты; `pnpm install`
- [x] `vitest.config.ts` — дословно по Reference Contracts (плагин React)
- [x] `setup.ts` — `@testing-library/jest-dom/vitest`; полифилы `matchMedia` (управляемые `pointer`, `prefers-color-scheme`, ширина), `ResizeObserver`, `IntersectionObserver`, `PointerEvent`, `Element.prototype.scrollIntoView`; `resetHandlers` после каждого теста; MSW `setupServer` в `msw-server.ts` с `onUnhandledRequest: 'error'`
- [x] `fixtures.ts` — `threadSummary(...)`, `threadList(...)`, `historyMessages(...)`, `sseFromChunks(...)` (SSE v7); фикстуры проходят схемы `@agent-os/contracts`; `deferred()`
- [x] `render-with-runtime.tsx` — `renderWithRuntime({ pathname, pointer, ... })`: `vi.mock('next/navigation')` с управляемым `pathname` и шпионом `router` (`push`, `replace`), монтирует `ChatRuntimeProvider` + `ChatShell` и рядом `<Toaster />`
- [x] Перенос 7 скелетов в `apps/web/src/components/shell/` со слияниями; удалить исходники и каталог `test-skeletons/`

### 3. Refactor Phase
- [x] Упростить обвязку; убедиться, что 10 `it.todo` учтены как todo, ни одного пустого заглушенного кейса

## Quality Assurance Mechanisms
- Vitest 4 + RTL + MSW — Enforces: U/C/I без запущенного API (AC-12.2) — Config: `apps/web/vitest.config.ts`, `apps/web/src/test/setup.ts` — Type: `executable_check`
- turbo `test` → `^build` — Enforces: тесты web видят собранный `@agent-os/contracts` — Config: `turbo.json` — Type: `executable_check`
- ESLint, `tsc`, `next build` — Type: `executable_check`

## Operation Verification Methods
- **Verification method**: `pnpm --filter web test`; `pnpm test` из корня (turbo); `ls apps/web/src/components/shell`; проверка отсутствия каталога `test-skeletons`.
- **Success criteria**: `config.test.ts` зелёный; 10 `it.todo` учтены как todo; turbo `pnpm test` выполняет тесты `apps/web`; в `apps/web/src/components/shell/` 7 файлов `*.int.test.tsx`; в `docs/.../test-skeletons/` файлов нет.
- **Failure response**: полифилы jsdom/base-ui — расширить `setup.ts`; несовместимость версий — эскалация.
- **Verification level**: L2.

## Proof Obligations
### Obligation: Failure Mode: missing config (FR-12 / AC-12.2)
- **Claim**: `lib/config.ts` бросает исключение при отсутствующем/неабсолютном/не-http(s) `NEXT_PUBLIC_API_URL`; срезает хвостовые `/`.
- **Primary failure mode**: убран срез `/` в конце или проверка протокола.
- **Boundary to exercise**: in-process unit (динамический импорт модуля).
- **State assertion**: N/A.
- **Mock boundary rationale**: env через `vi.stubEnv`; ничего больше не мокается.
- **Proven by**: `new: apps/web/src/lib/config.test.ts — таблица значений env` (ловит дефект «срез / или протокол пропущен», который не видит другой тест).
- **Residual**: `next build` падает без переменной (проверяется гейтом build).

## Completion Criteria
- [x] `pnpm --filter web test` — `config.test.ts` зелёный, 10 `it.todo` учтены как todo; прогон содержательный (не 0 тестов)
- [x] `pnpm test` из корня (turbo) выполняет тесты `apps/web`
- [x] В `apps/web/src/components/shell/` 7 файлов `*.int.test.tsx`, в `docs/.../test-skeletons/` файлов нет
- [x] lint, tsc, build — 0 ошибок
- [x] Proof obligation: `config.test.ts` краснеет при удалении среза `/` или проверки протокола (мутация записана в Notes)
- [x] Reference Contracts — `Y`; Resolved decisions применены

## Notes
- Impact scope: `src/test/*` используют все тестовые задачи; правка `src/test/*` позже — только через эскалацию.
- Scope boundary: скелеты не наполнять; `apps/api` не менять.
