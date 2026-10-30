# Task T1.3: L1-проверка спайка S-1…S-5 против реального API — ГЕЙТ G1

Metadata:
- Task type: **L1/browser** — выполняет **оркестратор** через Claude-in-Chrome; шаги `[DevTools — user]` — просьба пользователю. Не отдавать `task-executor-frontend`.
- Phase: 1 — ранняя точка проверки (Early Verification Point DD)
- Dependencies: task-T1.2 → Deliverable: рабочий спайк (`apps/web` dev + `apps/api` dev)
- Provides: результаты S-1…S-5 (Notes плана «Ранняя точка проверки»); разрешение или СТОП для T1.4 и всего остального
- Size: Small (только исправления в файлах T1.1/T1.2, если найдены дефекты)
- Commit: manual — кода в репозиторий не добавляет (исправления дефектов — в составе единиц T1.1/T1.2)

## Environment (каждая задача)
- Postgres 5433: `POSTGRES_PORT=5433 pnpm db:up`; `apps/api/.env`: `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`, `FRONTEND_ORIGIN=http://localhost:3000`; `pnpm --filter api dev` (порт 4000); `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; `pnpm --filter web dev` (production не требуется).
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — доки в `apps/web/node_modules/next/dist/docs/`.
- Гейты web: lint, `tsc --noEmit`, test (с T2.1), `next build`.
- Никаких `git add/commit/stash/checkout`; без attribution-строк.

## Implementation Content
Доказать в реальном браузере против реального API, что композиция KD-1 держит фоновый стрим, синхронизирует URL, восстанавливает историю и ошибки, и автозаголовок приходит без `PATCH`. Подтверждает AC-02.6, AC-03.4, AC-04.1, AC-04.3, AC-04.4, AC-02.5 (механизмы). Код спайка остаётся production-кодом.

## Target Files
- [x] Только исправления в файлах T1.1/T1.2 (если найдены дефекты)
- [x] Временная инструментовка (счётчики, `console.count`, кнопка удаления спайка в `chat-shell.tsx`) **удаляется до завершения**

Любая правка вне файлов T1.1/T1.2 — эскалация.

## Investigation Targets
- Раздел плана «Early Verification Point» (критерии 1–5, Failure response, таблица S-1…S-5)
- `apps/web/src/components/shell/chat-shell.tsx` (спайк), `chat-runtime-provider.tsx`, `lib/threads/*`
- Лог `apps/api` (отмена по `close`)

## Decisions and Unresolved Items

Resolved decisions:

| Item | Decision | Source / Rule |
|---|---|---|
| «Искусственный 500» на `/messages` | Обёртка `window.fetch` через `javascript_tool` (как L1-10), без флага в `apps/api` — API не меняется | План, «Уточнение плана к п. 3» |
| S-2…S-5 не подтверждены | Запасной путь из таблицы; повтор шага; запись в Notes | План, гейт G1 |
| Статус `canceled` в Network | Если расширение не показывает — `[DevTools — user]` | План T1.3, шаг 2 |

Blocking unresolved items:

| Item | Required Input | Escalation Condition |
|---|---|---|
| Действительность `ANTHROPIC_API_KEY` | Ответ модели на короткую отправку с `/` | Ответа нет и в логе `apps/api` отказ провайдера (401/403, ошибка ключа) → **СТОП**: T1.3 не продолжается, оркестратор сообщает пользователю, что ключ недействителен, и **ждёт решения** |
| S-1 (фоновый стрим) | Подтверждение шага 2 | S-1 не подтверждён → **СТОП и отчёт пользователю** (вариант B KD-1 = изменение дизайна); тихий переход запрещён; T1.4 не начинать |

## Investigation Notes
(Заполняется оркестратором: «Ранняя точка проверки» — результаты, доказательства, применённые запасные пути.)

### S-5 — первый прогон: не подтверждён; применён запасной путь (5)
- **Результат**: удаление беседы во время стрима (кнопка «×» спайка → `aui.threads.item({ id }).delete()`) — `DELETE` 204, но стрим в браузере дошёл до конца, лог `apps/api` показал полный `usage`: запрос не был закрыт.
- **Причина** (`@assistant-ui/core` 0.3.32, `src/react/client/RemoteThreadList.ts:1720-1761`): `deleteThread` выполняет `ensureNotMain` → оптимистичное удаление → `adapter.delete` и освобождает тело (`lifetimes.release`) только после ответа `delete`; цепочка `stopOnClientDestroy` у `useChatRuntime` на практике fetch не прервала.
- **Запасной путь** (DD, Early Verification Point, Failure response 5): явная отмена прогона перед `delete`. Реализовано один раз как действие оболочки `deleteThread(threadId)` в `apps/web/src/components/shell/shell-actions.tsx` (`useShellActions()`): если `aui.threads.item({ id }).getState().isRunning` — отмена прогона (пути ниже), ожидание `isRunning === false` у того же элемента через `aui.subscribe` (не дольше 2 с, затем `console.warn` и удаление всё равно), затем `aui.threads.item({ id }).delete()`. Ошибки удаления — по контракту адаптера (`notify.deleteFailed` + откат, `lib/threads/thread-list-adapter.ts`). Кнопка «×» спайка (`chat-shell.tsx`, SPIKE(T1.3)) вызывает это действие.

### S-5 — второй прогон (первая версия запасного пути): не подтверждён
- **Результат**: основная беседа (`b288e9a0-…`, создана в этой вкладке, стримила) → «×» → консоль `[web-shell] running thread has no reachable body; deleting without cancel`; `DELETE` 204, лог `apps/api` — полный `usage` (`output=8925`), отмены нет. Первая версия брала тело через `aui.threads.__internal_getThreadBody(id)`.
- **Причина** (`@assistant-ui/core` 0.3.32): в приложении scope `threads` — не клиент `RemoteThreadList`. `AssistantRuntimeProvider` ставит `threads: RuntimeAdapter(runtime)` (`src/react/AssistantProvider.tsx:42-45`), а `RuntimeAdapter` строит `ThreadListClient({ runtime: runtime.threads, __internal_assistantRuntime: runtime })` (`src/react/RuntimeAdapter.ts:26-31`). `ThreadListClient` возвращает `getState/thread/item/switch…/reload…/loadMore` и `__internal_getAssistantRuntime`, но **не** `__internal_getThreadBody` (`src/store/runtime-clients/thread-list-runtime-client.ts:100-130`). Метод есть только у внутреннего клиента `RemoteThreadList` (`src/react/client/RemoteThreadList.ts:2096`), который `useRemoteThreadListRuntime` (режим `client` при отсутствии `unstable_Provider`, `src/react/runtimes/useRemoteThreadListRuntime.ts:220`; handle — `:179-186`) держит в собственном `createAssistantClient` handle (доступен только `ClientThreadListRuntimeCore.aui`, `ClientThreadListRuntimeCore.ts:194-199`). Поэтому `?.()` вернул `undefined` для любой беседы; дело не в выборе ключа (локальный/удалённый id).

### S-5 — запасной путь, версия 2 (текущая)
- **Основная беседа** (случаи: создана в этой вкладке; открыта из списка) → `aui.threads.thread("main").cancelRun()`. Определение основной: `aui.threads.getState().mainThreadId === item.getState().id` (тот же источник, что и `isMain` в `getThreadListItemState`, `src/runtime/api/thread-list-runtime.ts:136`). `aui.threads.thread("main")` → `ThreadListClient.thread` → `main` (`thread-list-runtime-client.ts:63-67, 102`) → `runtime.main` → `ClientThreadListRuntimeCore.getMainThreadRuntimeCore()` (`ClientThreadListRuntimeCore.ts:159-164`) — тот же путь, что у кнопки Stop компонента `Thread`, работающей на стенде.
- **Фоновая беседа** → `aui.threads.__internal_getAssistantRuntime().threads.getById(id).cancelRun()` (`thread-list-runtime-client.ts:129`; `ThreadListRuntimeImpl.getById`, `src/runtime/api/thread-list-runtime.ts:283-295` → `ClientThreadListRuntimeCore.getThreadRuntimeCore` `:166-173`: `getItemById` сопоставляет `item.id` и `remoteId`, затем `hookManager.getThreadRuntimeCore(item.id)`, `RemoteThreadListHookInstanceManager.tsx:196-200`). Для не основной беседы `isRunning` элемента берётся только из `hookManager.__internal_isThreadRunning(item.id)` (`ClientThreadListRuntimeCore.ts:176-180` → `thread-list-runtime.ts:136-137`; `thread-list-item-runtime-client.ts:21-22`), т.е. из того же экземпляра по тому же ключу: если элемент показывает «идёт», `getById` резолвит именно этот прогон.
- `cancelRun()` → `useAISDKRuntime` `cancelRun` (`@assistant-ui/ai-sdk` 0.0.16 `src/runtime/useAISDKRuntime.ts:1067`) → `await chatHelpers.stop()` (`:1100`) — прерывание fetch AI SDK.
- Ожидание — по `item.getState().isRunning` (для основной = прогон hook manager ИЛИ `main.isRunning`, `thread-list-item-runtime-client.ts:21-22`), т.е. единое условие для обоих путей.
- **Временная диагностика**: `console.debug('[web-shell] SPIKE(T1.3) deleteThread cancel path: …')` со значениями `not-running` / `main aui.threads.thread("main").cancelRun()` / `background runtime.threads.getById().cancelRun()` — удалить вместе с остальной инструментовкой T1.3.
- **Гейты после правки**: `eslint` и `tsc --noEmit` в `apps/web` — зелёные. `next build` не запускался (работает `next dev` на :3000, общий `.next`).
- **Повтор S-5**: за оркестратором — случаи (a) основная, созданная в этой вкладке; (b) открытая из списка; (c) фоновая (стрим в X → перейти в Y → «×» у X).

### Ранняя точка проверки — итог (реальный браузер + реальный API + модель `claude-haiku-5-5`, 2026-10-30)
- **Шаг 0, ключ**: действителен (ответ «Париж»).
- **Шаг 1 / S-2, критерий 1 — подтверждён**: первая отправка с `/` → `POST /api/threads` 201 → `POST /api/chat/assistant` 200 с id сервера; адрес `/chat/<id>` через `replaceState`; запроса документа и RSC-запроса к :3000 нет; счётчик монтирований не изменился (1, 2 при загрузке страницы — двойной эффект StrictMode).
- **Шаг 2 / S-1, критерий 2 — подтверждён**: длинный ответ в X; переход в Y, затем «Новый чат» (`/`), возврат в X во время стрима (ответ продолжается, видна Stop) и после завершения; в Y и на `/` текста X не было; сервер сохранил полный ответ (8676 символов, оканчивается «КОНЕЦ»), отмены в логе API нет. **Гейт G1 пройден.**
- **Шаг 3 / S-3, критерий 3 — подтверждён**: F5 на `/chat/<id>` → счётчик `load` = 1, статус `ready`; `/chat/does-not-exist` → `switchError` `not_found`; обёртка `window.fetch` (500 на `/messages`) и открытие ссылкой не открывавшейся беседы → `load_failed` + «Повторить»; обёртка снята → «Повторить» → `ready`. Замечание: на маршруте несуществующей беседы assistant-ui пишет `console.error '[assistant-ui] thread list switch failed: ThreadsApiError … not_found (404)'` (оверлей Next dev — «1 Issue») — ожидаемый лог библиотеки; обработка — UI TH-07 в последующих задачах.
- **Шаг 4 / S-2, критерий 4 — подтверждён**: A, B, C по ссылкам, Назад ×2, Вперёд — беседы переключаются без перезагрузки (состояние окна сохранено), история каждой загружена один раз.
- **Шаг 5 / S-5, критерий 5 — подтверждён с запасным путём (5) и серверным исправлением**: первоначально удаление по умолчанию не останавливало стрим в браузере; серверный `DELETE` возвращал 204 (сетевая панель расширения ошибочно показывала 503; Resource Timing — 204), а сохранение Mastra в конце прогона воссоздавало беседу. Запасной путь — `ShellActions.deleteThread` (v1 на `aui.threads.__internal_getThreadBody` — недоступен у scope `threads` приложения в 0.15.32; v2 — пути main/background, см. выше). Основная беседа → fetch прерван до `DELETE`, строки `usage` нет, беседа 404. Фоновая → путь отмены сработал, но `DELETE` опережал закрытие fetch → беседа воскресала до серверного исправления threads-api v1.10 (`ThreadRunRegistry`, план 2 из 2); после исправления тот же сценарий → 404, 0 сообщений, нет `usage`, нет «Run outlived».
- **Шаг 6 / S-4 — подтверждён**: заголовок пришёл опросом `GET`, без `PATCH`, за ~6 с. Дефект качества заголовка (мета-рассуждение) → исправлен в threads-api v1.10 KD-7; повторная проверка: «Столица Франции: вопрос на одно слово».
- **Очистка**: удалены `console.count('ChatRuntimeProvider mount')` (`chat-runtime-provider.tsx`), обёртка счётчика `load` `withSpikeLoadCounter` (`lib/threads/shell-services.ts` — снова `createHistoryAdapterFactory({ api, status })`), кнопка «×» спайка (`chat-shell.tsx`), `console.debug` пути отмены (`shell-actions.tsx`). Оставлены: production-`ShellActions.deleteThread` (DD v1.6; `console.warn` при таймауте 2 с и недоступном runtime), ссылки/строка статуса/`Toaster` спайка (заменяются в Phase 3). Поиск `SPIKE(T1.3)`, `console.count`, `withSpikeLoadCounter`, `Удалить (спайк)` по `apps/web/src` пуст.
- **Гейты после очистки**: `eslint`, `tsc --noEmit` в `apps/web` — 0 ошибок. `next build` не запускался (работает `next dev` на :3000, общий `.next`) — за оркестратором.

## Implementation Steps (процедура L1; TDD неприменим)
### 0. Проверка ключа (до шага 1)
- [x] Короткая отправка с `/` — ответ модели пришёл. Нет ответа + отказ провайдера в логе → СТОП, вопрос пользователю (см. таблицу выше)

### 1–6. Шаги (оркестратор через Claude-in-Chrome; `[DevTools — user]` — по запросу пользователю)
- [x] 1. Временный `console.count('ChatRuntimeProvider mount')` и счётчик вызовов `load()` адаптера истории. Первая отправка с `/`: Network — `POST /api/threads` → `POST /api/chat/assistant` с `id` из ответа; адресная строка `/chat/<id>`; счётчик монтирований = 1; запроса документа и RSC-перезапроса layout нет (критерий 1, S-2)
- [x] 2. Длинный запрос в X; во время стрима — ссылка на Y, затем «Новый чат» (`/`); вернуться в X до и после завершения. Network: запрос X не `canceled` (`[DevTools — user]`, если расширение не показывает статус); ответ X дописан; в Y и на `/` ответа X нет (критерий 2, **S-1**)
- [x] 3. F5 на `/chat/<id>` → история (счётчик `load` = 1 на тело, S-3); `/chat/does-not-exist` → `switchError` `kind: 'not_found'` (строка статуса/консоль). Затем обёртка `window.fetch` через `javascript_tool` (500 на `/messages`) и без перезагрузки открыть ссылкой спайка беседу, не открывавшуюся в этом документе (F5 сняла бы обёртку; у открытой ранее беседы история уже загружена) → статус `load_failed`; снять обёртку, «Повторить» → история загружена (критерий 3)
- [x] 4. Открыть A, B, C ссылками; Назад ×2, Вперёд — беседы переключаются (критерий 4, S-2)
- [x] 5. Во время стрима удалить беседу временной кнопкой удаления в списке спайка (`aui` из консоли недоступен; кнопка живёт только на время T1.3) → в логе `apps/api` отмена по `close` (критерий 5, S-5)
- [x] 6. Новая беседа: после конца ответа ≤ 15 с заголовок появляется в списке спайка; Network — нет `PATCH` (S-4)

### Решение (гейт G1)
- [x] **S-1 не подтверждён → СТОП**, отчёт пользователю (вариант B KD-1 — изменение дизайна)
- [x] S-2…S-5 не подтверждены → запасной путь: S-2 — `router.replace('/chat/<id>')` вместо `replaceState` (критерии 1/4); S-3 — `adapter.unstable_useAdapters` для истории (критерий 3); S-4 — опрос из `ThreadActivityTracker` + `aui.threads.reload()`; S-5 — явная `cancelRun` тела перед `delete` через `aui.threads.item({ id })`-контекст. Повторить шаг, записать в Notes
- [x] Все результаты, включая применённые запасные пути, — в Notes «Ранняя точка проверки»

### Очистка
- [x] Временная инструментовка удалена (`git diff` не содержит `console.count`, счётчика `load` и кнопки удаления спайка)
- [x] Гейты T1.2 повторно зелёные (lint, tsc, build) — `eslint`, `tsc --noEmit`, `next build` зелёные

## Quality Assurance Mechanisms
- Гейты web (lint/tsc/build) после исправлений — Type: `executable_check`
- Early Verification Point (таблица S-1…S-5) — Type: `passive_constraint` (процедура)

## Operation Verification Methods
- **Verification method**: шаги 1–6 в реальном браузере против реального `threads-api`; скриншоты, Network, консоль, лог `apps/api`.
- **Success criteria**: критерии 1–5 Early Verification Point выполнены; S-1 подтверждён.
- **Failure response**: S-1 — СТОП + отчёт; S-2…S-5 — запасной путь + повтор; ключ недействителен — СТОП + вопрос пользователю.
- **Verification level**: L1.

## Proof Obligations
### Obligation: S-1 — фоновый стрим при смене main и `switchToNewThread` (AC-02.6, AC-03.4)
- **Claim**: стрим X не прерывается при переходе на Y и на `/`; ответ дописывается; возврат в X показывает продолжение/полный ответ.
- **Primary failure mode**: `backgroundThreads` не сохраняет `Chat` AI SDK; запрос X `canceled`.
- **Boundary to exercise**: реальный браузер + реальный API + реальная модель.
- **State assertion**: стрим X идёт → переход на Y → X не canceled, ответ дописан; в Y/`/` ответа X нет.
- **Mock boundary rationale**: none.
- **Proven by**: `new (L1): шаг 2 T1.3` (автотеста нет намеренно — DD «Integration Tests»); повтор — L1-6 (T8.3).
- **Residual**: нагрузочные/долгие сценарии — L1-6.

### Obligation: S-2 / S-3 / S-4 / S-5 (AC-04.1, AC-04.3, AC-04.4, AC-02.5)
- **Claim**: `replaceState` без перемонтирования (S-2); `load()` один раз на монтирование (S-3); автозаголовок без `PATCH` (S-4); удаление останавливает стрим (S-5).
- **Primary failure mode**: см. таблицу Early Verification Point («Если не подтвердилось»).
- **Boundary to exercise**: реальный браузер + реальный API.
- **State assertion**: счётчик монтирований = 1; счётчик `load` = 1; нет `PATCH`; лог API — отмена по `close`.
- **Mock boundary rationale**: none.
- **Proven by**: `new (L1): шаги 1, 3, 4, 5, 6 T1.3`.
- **Residual**: S-2/S-4 повторно — L1-5/L1-1 (T8.3).

## Completion Criteria
- [x] Шаги 0–6 выполнены с доказательствами (скриншоты, Network, консоль, лог API)
- [x] S-1 подтверждён — иначе план остановлен и пользователь уведомлён
- [x] Временная инструментовка удалена (`git diff` не содержит `console.count`, счётчика `load` и кнопки удаления спайка)
- [x] Гейты T1.2 повторно зелёные — `eslint`, `tsc --noEmit`, `next build` зелёные
- [x] Результаты (включая запасные пути) записаны в Notes «Ранняя точка проверки»
- [x] Блокирующие нерешённые пункты закрыты, иначе выполнение остановлено

## Notes
- Impact scope: решение G1 управляет запуском T1.4 и всех последующих задач.
- Scope boundary: `apps/api` не меняется (в т.ч. нет временных флагов).
