# Task T1.2: `ChatRuntimeProvider`, `ShellServices`, маршруты группы `(chat)`, минимальная оболочка спайка

Metadata:
- Task type: frontend (apps/web)
- Phase: 1 — спайк рантайма
- Dependencies: task-T1.1 → Deliverable: `apps/web/src/lib/threads/*`, `apps/web/src/lib/config.ts`
- Provides: `ChatRuntimeProvider`, `ShellActionsProvider`, маршруты `(chat)`, `chat-shell.tsx` (версия спайка) для T1.3 (L1-проверка)
- Size: Medium (8 новых/изменённых + 2 удаляемых файла)
- Commit: manual — готово к коммиту; executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- Postgres на хост-порту 5433 (`POSTGRES_PORT=5433 pnpm db:up`, `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`); `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; API — `pnpm --filter api dev` (порт 4000).
- `ai`: `apps/api` — `7.0.148` точно; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — читать `apps/web/node_modules/next/dist/docs/` до кода (`apps/web/AGENTS.md`).
- Гейты web: lint, `tsc --noEmit`, test (с T2.1), `next build`. Prettier для `apps/web` нет.
- Правила выполнения 1–10 из `_overview.md` обязательны.

## Implementation Content
Собрать рантайм KD-1 в клиентском режиме и маршруты: `ChatRuntimeProvider` (`useRemoteThreadListRuntime`, controlled `threadId` из `usePathname`, `onThreadIdChange` → `syncUrlWithThread`), `ShellServices`, `ShellActionsProvider`, серверный `(chat)/layout.tsx` (Suspense + `cookies()`), страницы-заглушки `null`, минимальная разметка спайка в `chat-shell.tsx` (заменяется в Phase 3). Удалить прототип `app/page.tsx` и `components/assistant.tsx`. Реализует (механизм) AC-03.2, AC-04.1; IP1, IP6.

## Target Files
- [x] `apps/web/src/lib/threads/shell-services.ts` (new)
- [x] `apps/web/src/components/shell/chat-runtime-provider.tsx` (new)
- [x] `apps/web/src/components/shell/shell-actions.tsx` (new)
- [x] `apps/web/src/components/shell/chat-shell.tsx` (new, версия спайка)
- [x] `apps/web/src/components/shell/shell-fallback.tsx` (new)
- [x] `apps/web/src/app/(chat)/layout.tsx` (new)
- [x] `apps/web/src/app/(chat)/page.tsx` (new → `null`)
- [x] `apps/web/src/app/(chat)/chat/[threadId]/page.tsx` (new → `null`)
- [x] `apps/web/src/app/page.tsx` (delete)
- [x] `apps/web/src/components/assistant.tsx` (delete)

## Investigation Targets
- `apps/web/node_modules/next/dist/docs/01-app/02-guides/single-page-applications.md`, `02-guides/preserving-ui-state.md`, `03-api-reference/03-file-conventions/dynamic-routes.md`
- DD «Композиция рантайма и владение состоянием», «Маршрутизация и синхронизация URL», фрагмент `chat-runtime-provider.tsx`
- Удаляемый `apps/web/src/components/assistant.tsx` — перенести `api`, `credentials: 'include'`, `sendAutomaticallyWhen`
- `@assistant-ui/ai-sdk` — `transport/AssistantChatTransport.js:35-62`
- Результаты T1.1: `apps/web/src/lib/threads/*`

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Маршрутизация и синхронизация URL) | state-lifecycle-negative | «`remoteId` задан и `location.pathname !== threadPath(remoteId)` → `window.history.replaceState(null, '', threadPath(remoteId))`»; «`remoteId === undefined` и путь начинается с `/chat/` → `router.replace('/')`» | Y, если `onThreadIdChange` провайдера вызывает `syncUrlWithThread` и больше ничего не навигирует |
| design-web-shell.md (§ State Transitions and Invariants) | state-lifecycle-negative | «В тело чата не уходит клиентский id: body.id = remoteId из POST /api/threads» | Y, если транспорт не подставляет клиентский id |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `handleChatError` в спайке | Только `console.error` с контекстом; классификация E-8 — T7.3 | План T1.2 |
| Рабочая область прототипа | Временно исчезает, возвращается в T5.3 | План T1.2 |
| `ASSISTANT_AGENT_ID` | константа `'assistant'` | План T1.2 |
| `notify` | тонкая обёртка над `toast` из `sonner`: `renameFailed`, `deleted`, `deleteFailed` | План T1.2 |

## Investigation Notes
- **Next 16.4.3** (`single-page-applications.md`): `window.history.replaceState` интегрирован с роутером и синхронизирует `usePathname` — поэтому `threadId` берётся из `usePathname()`, а не `useParams`. `preserving-ui-state.md`: при `cacheComponents: true` страницы скрываются `<Activity>`; весь UI в layout группы, страницы `null`. `dynamic-routes.md`: без `generateStaticParams` доступ к `params` требует Suspense — страницы `params` не читают. `cookies()` вызывается только внутри `<Suspense fallback={<ShellFallback />}>` (иначе build под Cache Components падает). `next build`: `/` и `/chat/[threadId]` — Partial Prerender (◐).
- **Перенос из `assistant.tsx`**: `api` → `${apiBaseUrl}/api/chat/${ASSISTANT_AGENT_ID}` (вместо сырого `process.env`), `credentials: 'include'`, `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls`.
- **`AssistantChatTransport.js:35-62`**: `id` тела = `(await threadListItem.initialize())?.remoteId ?? options.id`; `initialize()` списка возвращает `{ remoteId: thread.id }` из `POST /api/threads` — клиентский id в тело не уходит. Транспорт клонируется на каждое тело (`__internal_clone`).
- **`useShellStatus(selector)`** (DD «Композиция рантайма»: «Как читается — `useShellStatus(selector)`»; в T1.1 хука нет) экспортируется из `shell-actions.tsx`: `ShellActionsProvider` дополнительно кладёт `services.status` в отдельный контекст; хук — `useStore` из `zustand`. Интерфейс `ShellActions` не расширен.
- **`newChat(source)`**: `NewChatSource = 'button' | 'shortcut' | 'notice'`; в T1.2 — `pathname !== '/'` → `router.push('/')`; фокус-политика — T4.3 (может уточнить тип `source`). `retrySwitch(threadId)` → `aui.threads.switchToThread(threadId)`; `retryHistory(remoteId)` → `services.history.retry(remoteId)`.
- **`auiConfig`** = `AuiConfig({})` (подсказки `WELCOME_SUGGESTIONS` — T4.3). `notify` — `toast`/`toast.error` из `sonner` с текстами DD («Не удалось переименовать беседу. Попробуйте ещё раз.», «Беседа удалена», «Не удалось удалить беседу. Попробуйте ещё раз.»). `handleChatError` — `console.error('[web-shell] chat request failed', { remoteId, name, statusCode })`, без тела ответа и текста.
- **Временная инструментовка для T1.3 (помечена `SPIKE(T1.3)`, удаляется в T1.3)**: `console.count('ChatRuntimeProvider mount')` в `chat-runtime-provider.tsx`; счётчик `load()` — обёртка `withSpikeLoadCounter` в `shell-services.ts` (`console.count('[spike] history load <remoteId>')`, свой `WeakMap` по `aui` — идентичность адаптера для тела сохраняется); кнопка «×» удаления в списке `chat-shell.tsx` (`aui.threads.item({ id }).delete()`). Также спайковый `<Toaster />` из `sonner` в `chat-shell.tsx` (корневой Toaster — позже; разметка спайка заменяется в Phase 3). В dev React StrictMode эффект монтирования отрабатывает дважды при первой загрузке документа — критерий S-2: счётчик не растёт при навигации.
- **Поиск `components/assistant`**: литеральная подстрока совпадает с `components/assistant-ui/...` (существующие обёртки); импортов удалённого модуля (`components/assistant'`) нет — `grep -rnE "components/assistant['\"]" apps/web/src` пуст.
- **Reference Contracts (по финальной реализации)**: (1) `onThreadIdChange` провайдера вызывает только `syncUrlWithThread({ remoteId, location: window.location, history: window.history, router })`; других навигаций в провайдере нет → **Y**. (2) Транспорт — `AssistantChatTransport` без собственного `prepareSendMessagesRequest`/`body.id`; `id` = `remoteId` из `initialize()` (`POST /api/threads`) → **Y**.
- **Resolved decisions**: `handleChatError` — только `console.error` ✔; рабочая область прототипа удалена вместе с `app/page.tsx` ✔; `ASSISTANT_AGENT_ID = 'assistant'` ✔; `notify` над `sonner` ✔.
- **Окружение**: `apps/api/.env` содержит `DATABASE_URL` на 5432; `ConfigModule.forRoot` не перекрывает уже заданные переменные процесса — для стенда задавать `DATABASE_URL=...:5433/...` в окружении команды запуска API (файл не менялся — вне Target Files).
- **Проверка**: `tsc --noEmit` 0, `eslint` 0, `next build` ✓; `next dev`: `GET /` 200, `GET /chat/abc` 200, `GET /chat/does-not-exist` 200, ошибок в логе сервера нет (браузерная консоль — T1.3).

## Implementation Steps
Тестов нет (Vitest — T2.1).
### 1. Подготовка
- [x] Прочитать Next-доки (правило 1) и Investigation Targets; записать наблюдения
- [x] Прочитать `components/assistant.tsx` до удаления, перенести `api`, `credentials: 'include'`, `sendAutomaticallyWhen`

### 2. Реализация
- [x] `createShellServices()` — `apiClient`, `status`, `listAdapter`, `history` (фабрика), `transport` (`AssistantChatTransport`, `api: \`${apiBaseUrl}/api/chat/assistant\``, `credentials: 'include'`), `notify`, `auiConfig`, `handleChatError` (спайк: `console.error` с контекстом)
- [x] `ChatRuntimeProvider` по фрагменту DD: `useState(createShellServices)`, `runtimeHook` вызывает только `useAui()` и `useChatRuntime()`, controlled `threadId = parseRouteThreadId(usePathname())`, `onThreadIdChange` → `syncUrlWithThread`
- [x] `ShellActionsProvider`: `newChat(source)`, `retryHistory(remoteId)`, `retrySwitch(threadId)`; `useShellActions()` вне провайдера бросает ошибку
- [x] `(chat)/layout.tsx` — серверный: `<Suspense fallback={<ShellFallback />}>` + внутренний async-компонент, читающий `(await cookies()).get('sidebar_state')?.value !== 'false'`; страницы возвращают `null`, `params` не читают
- [x] `chat-shell.tsx` спайка: список ссылок из `useAuiState(s => s.threads.threadItems)` через `next/link` + `threadPath`, строка статуса истории из `ShellStatus` с «Повторить» (`retryHistory`), «Новый чат», `Thread`
- [x] Удалить `app/page.tsx` и `components/assistant.tsx`

### 3. Refactor
- [x] Проверить, что поиск `components/assistant` по `apps/web/src` пуст

## Quality Assurance Mechanisms
- ESLint, `tsc` (strict), `next build` — Type: `executable_check` (build падает без `NEXT_PUBLIC_API_URL`)
- Интеграция с `unstable_` API изолирована в `lib/threads/*` и `chat-runtime-provider.tsx` — Type: `passive_constraint`
- Обёртки assistant-ui — `*.aui.tsx`; оболочка — `components/shell/*.tsx` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: lint, tsc, `pnpm --filter web build` (с `.env.local`); `pnpm --filter web dev` — открыть `/` и `/chat/<id>` (curl/запрос страниц), консоль без ошибок кроме ожидаемых.
- **Success criteria**: 0 ошибок гейтов; в дереве нет `app/page.tsx` и `components/assistant.tsx`; поиск `components/assistant` по `apps/web/src` пуст.
- **Failure response**: исправить; при невозможности собрать `Suspense`+`cookies()` под Next 16.4.3 — эскалация со ссылкой на документ Next.
- **Verification level**: L3; поведение в браузере — T1.3 (L1).

## Proof Obligations
### Obligation: AC-04.1 / AC-03.2 — механизм (проверка в T1.3, I-тест в T4.3)
- **Claim**: первая отправка создаёт беседу и синхронизирует URL без перемонтирования провайдера.
- **Primary failure mode**: `ChatRuntimeProvider` перемонтируется при навигации; клиентский id уходит в тело чата.
- **Boundary to exercise**: реальный браузер + реальный API (T1.3); I-тест `shell.new-chat` (T4.3).
- **State assertion**: на `/` → отправка → `/chat/<id>`, счётчик монтирований 1 (T1.3).
- **Mock boundary rationale**: none в T1.3.
- **Proven by**: `existing/planned: shell.new-chat.int.test.tsx — AC-04.1 + AC-03.3` (T4.3); L1 — T1.3. Новых тестов в T1.2 нет (нет Vitest).
- **Residual**: до T1.3 поведение не подтверждено.

## Completion Criteria
- [x] Гейты lint, tsc, `pnpm --filter web build` (с `.env.local`) — 0 ошибок
- [x] `pnpm --filter web dev` открывает `/` и `/chat/<id>` без ошибок в консоли (кроме ожидаемых)
- [x] В дереве нет `app/page.tsx` и `components/assistant.tsx`; поиск `components/assistant` по `apps/web/src` пуст
- [x] Reference Contracts — `Y` по финальной реализации, доказательства в Investigation Notes
- [x] Все Resolved decisions применены

## Notes
- Impact scope: `chat-shell.tsx` и `chat-runtime-provider.tsx` правятся далее в T1.4, T3.1, T3.3, T3.4, T4.2, T4.3, T5.3, T6.2.
- Scope boundary: `apps/web/AGENTS.md` блок не удалять; `apps/api` и `packages/contracts` не менять.
