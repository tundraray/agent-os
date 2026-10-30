# Task T1.1: Клиент `threads-api`, адаптеры списка и истории, статус-стор, URL-функции, опросчик заголовка

Metadata:
- Task type: frontend (apps/web)
- Phase: 1 — спайк рантайма (шаг 1 DD)
- Dependencies: нет (prerequisite: `threads-api` реализован — план `completed`)
- Provides: модули `apps/web/src/lib/threads/*` и `lib/config.ts` для T1.2, T2.2, T2.3 и всех следующих задач
- Size: Medium+ (10 файлов, из них 2 манифеста; тестов нет — Vitest появляется в T2.1)
- Commit: manual — готово к коммиту (одна единица); executor не запускает `git add/commit/stash/checkout`; без attribution-строк

## Environment (каждая задача)
- Postgres на хост-порту 5433 (`POSTGRES_PORT=5433 pnpm db:up`, `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`); `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`.
- `ai`: `apps/api` — ровно `7.0.148`; `apps/web` — `^7.0.155` (решение пользователя). Не менять.
- Next.js 16.4.3 — перед кодом читать `apps/web/node_modules/next/dist/docs/` (`apps/web/AGENTS.md`).
- Гейты web: `pnpm --filter web lint`, `pnpm --filter web exec tsc --noEmit`, `pnpm --filter web test` (с T2.1), `pnpm --filter web build`. Prettier для `apps/web` нет.
- Правила выполнения 1–10 из `_overview.md` обязательны (особенно 8 — Target Files; 10 — наполнение `it.todo`).

## Implementation Content
Реализовать слой данных оболочки на стороне `apps/web` (KD-1: `useRemoteThreadListRuntime` + собственные адаптеры; Elements 1 и 5): типизированный клиент `/api/threads*` с zod-валидацией, адаптер списка, фабрику адаптера истории, `RetryGate`, статус-стор `ShellStatus`, опросчик автозаголовка, функции URL беседы и `syncUrlWithThread`. Реализует AC-01.7, AC-02.5, AC-04.1, AC-04.3, AC-20.1 (реализация; проверка — T1.3, T2.2, T2.3).

## Target Files
- [x] `apps/web/package.json`
- [x] `pnpm-lock.yaml`
- [x] `apps/web/src/lib/config.ts` (new, только `apiBaseUrl`)
- [x] `apps/web/src/lib/threads/threads-api-error.ts` (new)
- [x] `apps/web/src/lib/threads/threads-api-client.ts` (new)
- [x] `apps/web/src/lib/threads/retry-gate.ts` (new)
- [x] `apps/web/src/lib/threads/shell-status-store.ts` (new)
- [x] `apps/web/src/lib/threads/thread-list-adapter.ts` (new)
- [x] `apps/web/src/lib/threads/thread-history-adapter.ts` (new)
- [x] `apps/web/src/lib/threads/title-poller.ts` (new)
- [x] `apps/web/src/lib/threads/route-thread-id.ts` (new)
- [x] `apps/web/src/lib/threads/url-sync.ts` (new)

Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-web-shell.md` — «Contract Definitions» (код клиентов, адаптеров, `RetryGate`, `route-thread-id`, `config`), «Data Contract», «Field Propagation Map»
- `packages/contracts/src/threads.ts`
- `apps/web/node_modules/@assistant-ui/core` — `runtimes/remote-thread-list/types.d.ts:37-140`, `adapters/thread-history.d.ts`
- `@assistant-ui/ai-sdk` — `runtime/useExternalHistory.js`
- `assistant-stream` — `createAssistantStream`
- `ai` — `safeValidateUIMessages`

## Reference Contracts

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-web-shell.md (§ Маршрутизация и синхронизация URL) | derived-display | «`threadPath(id) = `/chat/${encodeURIComponent(id)}`` (`lib/threads/route-thread-id.ts`) используется везде, где путь строится или сравнивается»; «`parseRouteThreadId(threadPath(id)) === id` для любого id из `ThreadIdSchema`»; «некорректная %-последовательность → сырой сегмент» | Y, если путь беседы строится только через `threadPath`, а `/chat/%E0` разбирается в сырой сегмент без исключения |
| design-web-shell.md (§ Маршрутизация и синхронизация URL) | state-lifecycle-negative | «`remoteId` задан и `location.pathname !== threadPath(remoteId)` → `window.history.replaceState(null, '', threadPath(remoteId))`»; «`remoteId === undefined` и путь начинается с `/chat/` → `router.replace('/')`» | Y, если `syncUrlWithThread` вызывает ровно `replaceState(null,'',threadPath(id))` / `router.replace('/')` и ничего при совпадении пути |
| design-web-shell.md (§ Fact Disposition, `contract:RemoteThreadMetadata-vs-ThreadSummary`) | derived-display | «`toRemoteMetadata`: `{ status: 'regular', remoteId: id, title: title ?? undefined, lastMessageAt: new Date(updatedAt) }`; `list({after})` → `?cursor=after`, `nextCursor: null` → `undefined`; `archive` отклоняется (UI архивирования нет), `generateTitle` — опросчик FR-20; `DELETE` 404 = успех (AC-16.3)» | Y, если маппинг и курсор совпадают дословно, `archive` отклоняет, `DELETE` 404 = успех |
| design-web-shell.md (§ Data Contract, TitlePoll stream) | state-lifecycle-negative | «нет ответа ассистента в messages → поток закрыт сразу, запросов нет; не более 1 запроса в 1 000 мс, не дольше 15 000 мс; ShellStatus.titleWaiting[remoteId] = true только во время опроса»; `TITLE_POLL_INTERVAL_MS = 1_000`, `TITLE_POLL_WINDOW_MS = 15_000` | Y, если константы и условия остановки совпадают |
| design-web-shell.md (§ Minimal Surface, Element 1) | state-lifecycle-negative | «Инвариант: стор не дублирует данные рантайма (список, заголовки, сообщения, `isRunning`, текущая беседа).» | Y, если состояние стора — ровно `history`, `loadMoreFailed`, `titleWaiting`, `activityAt` + сеттеры |
| design-web-shell.md (§ State Transitions and Invariants) | state-lifecycle-negative | «Беседа создаётся на сервере только при первой отправке (initialize); «Новый чат» сетевых запросов не делает»; «В тело чата не уходит клиентский id: body.id = remoteId из POST /api/threads»; «Элемент списка не перемещается при переименовании и приходе автозаголовка до перезагрузки списка» | Y, если сетевой вызов создания беседы происходит только в `initialize` адаптера списка |
| design-web-shell.md (§ Contract Definitions, `lib/config.ts`) | state-lifecycle-negative | `z.url({ protocol: /^https?$/ }).safeParse(process.env.NEXT_PUBLIC_API_URL)`; при провале — `throw new Error('NEXT_PUBLIC_API_URL must be an absolute http(s) URL')`; `apiBaseUrl = parsed.data.replace(/\/+$/, '')` | Y, если `config.ts` читает литерал `process.env.NEXT_PUBLIC_API_URL` и ведёт себя как указано (в T1.1 экспортируется только `apiBaseUrl`) |

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| Спецификатор `ai` в `apps/web` | Остаётся `^7.0.155`; точную фиксацию (шаг 2 DD) не делать | Открытые вопросы плана п. 2 (решение пользователя) |
| `sonner` | Добавляется прямой зависимостью `^2.0.8` уже здесь (нужен `notify` в T1.2) | План T1.1 |
| Тесты | Не писать: модули получают характеризационные тесты в T2.2/T2.3 | План T1.1, правило 7 |

## Investigation Notes
(Реализация по фрагментам DD дословно по поведению; наблюдения дописывать здесь.)

**Наблюдения по типам библиотек (2026-10-30)**
- `RemoteThreadListAdapter` (`@assistant-ui/core` 0.3.32, `runtimes/remote-thread-list/types.d.ts`): обязательные `list`, `rename`, `archive`, `delete`, `initialize`, `generateTitle(remoteId, messages): Promise<AssistantStream>`, `fetch`; `RemoteThreadMetadata` не реэкспортируется из `@assistant-ui/react` — выводится как `Awaited<ReturnType<RemoteThreadListAdapter['fetch']>>` (как в DD).
- `ThreadHistoryAdapter.withFormat<TMessage, TStorageFormat>(fa): GenericThreadHistoryAdapter<TMessage>` — обобщённый; `useExternalHistory` вызывает `withFormat` в `useMemo` и `load()` один раз на монтирование. Сужение `TMessage → UIMessage` сделано одним `as unknown as` в `narrowRepository` (`thread-history-adapter.ts:48`) после проверки `fa.format === 'ai-sdk/v6'` — это «единственное сужение» из DD; других приведений нет.
- `createAssistantStream(cb)` закрывает поток, когда `cb` завершается; пустой `cb` = немедленное закрытие.
- `HistoryStatus` в DD описан в `resolve-main-view.ts` (не в Target Files T1.1); тип объявлен и экспортирован из `shell-status-store.ts` — `resolve-main-view.ts` (позже) импортирует его оттуда.
- `ShellStatus` получил сеттер `setTitleWaiting` (нужен опросчику; DD: «`titleWaiting[remoteId] = true` только во время опроса»). `forgetThread(remoteId)` удаляет `history`, `titleWaiting` и `activityAt` по ключу `remoteId`; `activityAt` ключуется id элемента — у бесед из списка он совпадает с `remoteId`, у созданной в этой вкладке — нет (остаток безвреден: элемент удалён из рантайма). Проверить в T2.2/T8.1.
- Логи: `describeThreadsError` (`threads-api-error.ts`) даёт `{ kind, status }`; `console.error` — список (`nextPage`), переименование, удаление (кроме 404), история; `console.warn` — опрос заголовка. Текст сообщений/заголовков в логи не попадает.
- `CHAT_PATH_PREFIX` экспортируется из `route-thread-id.ts` для проверки префикса в `url-sync.ts` (одна константа).
- Форматирование: в `apps/web` нет Prettier; новые файлы приведены к стилю `src/hooks`/`src/utils` (двойные кавычки, `;`) разовым запуском `prettier --no-config` (конфиг не добавлялся).
- Зависимости: `pnpm why -r ai` — `apps/api` 7.0.148, `apps/web` 7.0.155; `sonner` 2.0.8 установлен.

**Reference Contracts — оценка по финальной реализации**
| Contract | Eval | Evidence |
|---|---|---|
| `threadPath` / `parseRouteThreadId` | Y | `route-thread-id.ts:4-5` (`/chat/${encodeURIComponent(id)}`), `:12-16` (некорректная %-последовательность → сырой сегмент); `url-sync.ts:19-20` строит и сравнивает путь только через `threadPath`. Смоук (node, strip-types): round-trip для `abc`, `a b/ц?%#`, 255×`x` — true; `/chat/%E0` → `%E0` без исключения |
| `syncUrlWithThread` | Y | `url-sync.ts:20` — `replaceState(null, "", threadPath(remoteId))` только при несовпадении пути; `:23` — `router.replace("/")` при `remoteId === undefined` и пути `/chat/…`; при совпадении — ничего. Смоук: `[["replace",null,"","/chat/t%201"],["router","/"]]` для 4 случаев |
| `toRemoteMetadata`, курсор, `archive`, `DELETE` 404 | Y | `thread-list-adapter.ts:25-30` (дословный маппинг), `:46` (`nextCursor ?? undefined`), `threads-api-client.ts:61` (`?cursor=${encodeURIComponent(after)}`), `thread-list-adapter.ts:96` (`archive` reject), `:84` (404 → успех, затем `forget` + `notify.deleted()`) |
| TitlePoll | Y | `title-poller.ts:8,10` (константы 1_000 / 15_000), `:38-39` (нет ответа ассистента → поток закрыт, запросов нет), `:61-63` (следующий запрос не раньше `startedAt + 1000`, не после окна), `:44,66` (`titleWaiting` true только на время опроса, снимается в `finally`), `:55` (`not_found` → стоп), `:56` (прочие ошибки → `console.warn`, продолжить) |
| `ShellStatus` инвариант | Y | `shell-status-store.ts:9-23` — состояние ровно `history`, `loadMoreFailed`, `titleWaiting`, `activityAt` + сеттеры; данных рантайма нет |
| Создание беседы только в `initialize` | Y | `createThread` вызывается только в `thread-list-adapter.ts:58`; `history[id] = 'ready'` (`:61`) до `return { remoteId }` |
| `lib/config.ts` | Y | `config.ts:5` (литерал `process.env.NEXT_PUBLIC_API_URL`, `z.url({ protocol: /^https?$/ })`), `:8` (текст ошибки), `:12` (срез `/` в конце); экспортируется только `apiBaseUrl` |

## Implementation Steps
Тестов в задаче нет (Vitest — T2.1); красная фаза заменяется типовой проверкой.
### 1. Подготовка
- [x] Прочитать все Investigation Targets, записать наблюдения (формы типов `RemoteThreadListAdapter`, `ThreadHistoryAdapter`)
- [x] Свериться с `packages/contracts/src/threads.ts` (схемы `ThreadSummary`, `ThreadListResponse`, `ThreadMessagesResponse`, `ApiError`, `ThreadIdSchema`)

### 2. Реализация
- [x] `package.json`: прямые зависимости `zod` `^4.6.7`, `assistant-stream` `0.3.55`, `sonner` `^2.0.8`; `@assistant-ui/react` `0.15.32`, `@assistant-ui/ai-sdk` `0.0.16`, `@assistant-ui/react-markdown` `0.14.24` — **точные (без `^`)**; `ai` не трогать; `pnpm install`
- [x] `config.ts` — `apiBaseUrl` по Reference Contracts
- [x] `threads-api-error.ts` — `ThreadsApiError { kind: 'not_found' | 'invalid_response' | 'http' | 'network'; status? }`
- [x] `threads-api-client.ts` — `credentials: 'include'`, `encodeURIComponent`, `treatBadRequestAsNotFound` для `getThread`/`getThreadMessages`, пустой `messages` → `[]` без `safeValidateUIMessages`; невалидное → `invalid_response`; 404 (и 400 на `:threadId`) → `not_found`; reject `fetch` → `network`
- [x] `retry-gate.ts` — `createRetryGate` (`release`, `drop`, ожидание на `remoteId`)
- [x] `shell-status-store.ts` — vanilla zustand: `history[remoteId]`, `loadMoreFailed`, `titleWaiting[remoteId]`, `activityAt[itemId]`, `setHistory`, `setLoadMoreFailed`, `bumpActivity`, `forgetThread`
- [x] `thread-list-adapter.ts` — `createThreadListAdapter` (все обязательные методы; `archive` отклоняет; `DELETE` 404 = успех + `notify.deleted()`; `initialize` ставит `history[id] = 'ready'` до возврата `remoteId`; `loadMoreFailed` для `list({after})`)
- [x] `thread-history-adapter.ts` — `createHistoryAdapterFactory` (кэш `WeakMap` по клиенту `aui`, цикл `loadFor`, `withFormat` только `ai-sdk/v6`, `append` — no-op, `retry`/`forget`)
- [x] `title-poller.ts` — `createTitlePollStream` (`TITLE_POLL_INTERVAL_MS`, `TITLE_POLL_WINDOW_MS`)
- [x] `route-thread-id.ts` — `threadPath`, `parseRouteThreadId`; `url-sync.ts` — `syncUrlWithThread({ remoteId, location, history, router })`
- [x] Логи — `console.error`/`console.warn` с `{ remoteId, kind, status }`, без текста сообщений и заголовков; без молчаливых fallback

### 3. Refactor
- [x] Убрать дублирование, проверить отсутствие `any` (внешние данные — `unknown` + zod)

## Quality Assurance Mechanisms
- ESLint `eslint-config-next` — Enforces: правила Next/React/TS — Config: `apps/web/eslint.config.mjs` — Type: `executable_check`
- TypeScript `strict`, `noEmit` — Enforces: типы без `any` — Config: `apps/web/tsconfig.json` — Type: `executable_check`
- Точные версии `@assistant-ui/*`, `assistant-stream`; `ai` не меняется — Config: `apps/web/package.json`, `pnpm-lock.yaml` — Type: `passive_constraint`
- Интеграция с `unstable_` API изолирована в `lib/threads/*` — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: `pnpm --filter web exec tsc --noEmit`, `pnpm --filter web lint`, `pnpm why -r ai`, проверка `package.json`.
- **Success criteria**: 0 ошибок tsc/lint; `apps/web` `ai` 7.0.155, `apps/api` 7.0.148; версии `@assistant-ui/*` и `assistant-stream` без `^`.
- **Failure response**: исправить типы/зависимости; при несовместимости `unstable_` API — эскалация (не подменять дизайн).
- **Verification level**: L3 (сборка/типы); поведение подтверждают T1.3 (L1) и T2.2/T2.3 (L2).

## Proof Obligations
### Obligation: Failure Mode: shared-state dependency / unavailable boundary (AC-01.7, AC-02.5, AC-04.3 — реализация)
- **Claim**: клиент и адаптеры классифицируют ошибки (`not_found`/`invalid_response`/`http`/`network`) и пишут статусы истории в `ShellStatus`.
- **Primary failure mode**: ошибка списка/истории глотается библиотекой; 400 на `:threadId` не трактуется как 404; `initialize` ставит `ready` после возврата.
- **Boundary to exercise**: in-process unit (MSW) — в T2.2/T2.3.
- **State assertion**: N/A в этой задаче.
- **Mock boundary rationale**: сеть — MSW (в T2.2).
- **Proven by**: `existing/planned: threads-api-client.test.ts`, `thread-list-adapter.test.ts`, `thread-history-adapter.test.ts`, `retry-gate.test.ts` (T2.2); `route-thread-id.test.ts`, `url-sync.test.ts`, `title-poller.test.ts` (T2.3); реальное поведение — T1.3. Новых тестов в T1.1 нет.
- **Residual**: до T2.1 модули не покрыты тестами; L1-подтверждение — T1.3.

## Completion Criteria
- [x] `pnpm --filter web exec tsc --noEmit` и `pnpm --filter web lint` — 0 ошибок
- [x] `pnpm why -r ai` — `apps/web` 7.0.155, `apps/api` 7.0.148
- [x] версии `@assistant-ui/*` и `assistant-stream` в `package.json` без `^`
- [x] Каждый Reference Contract оценён `Y` по финальной реализации, доказательства (файл:строка) записаны в Investigation Notes
- [x] Все Resolved decisions применены как записано

## Notes
- Impact scope: все последующие задачи используют `lib/threads/*`.
- Scope boundary: `apps/api`, `packages/contracts`, `apps/web/src/utils/href.ts` не менять; `ai` в `package.json` не менять.
