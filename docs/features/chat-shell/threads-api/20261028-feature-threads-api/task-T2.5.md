# Task T2.5: «Сброс хвоста» и история без частей `error` — `ChatMessageRefSchema`, `ThreadsService.discardRepliesAfter`, проверка беседы в чате, `maskHistoryErrors` (гейт G3)

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 2, T2.5)
- Dependencies: T2.4 → Deliverable: красный кейс AC-14.6 и `partialTextThenErrorStep` в рабочем дереве, доказательства и хранимое состояние после ошибки модели (Investigation Notes `task-T2.4.md`, Notes плана «Проверка AC-14.6, гейт G3»); T2.3 → Deliverable: `maskToolErrorText`, `listMessages` с маскированием, `stream-error-text.ts`, `test/support/db.ts` (`countMessages`, `rawMessageContents`), гейт G пройден
- Provides: **Gate G3** (вместе с G разблокирует Phase 3 и Phase 4, включая T4.1); `ChatMessageRefSchema`/`ChatMessageRef`; `ThreadsService.discardRepliesAfter`; `getOwnedThread` в `ChatController.chat` и `ChatModule.imports: [ThreadsModule]` (перенесено из T5.1/T4.3); `maskHistoryErrors`; `threads.service.spec.ts` (T3.4 дополняет файл); записи Notes плана «Гейт G3 после «сброса хвоста»» и «Хранимое состояние после обрыва сети»
- Size: Large по числу файлов (9 файлов кода/тестов + Notes плана). Разбиение не допускается: красный кейс T2.4 и его исправление образуют **одну единицу коммита T2.4 + T2.5**, а изменения связаны цепочкой «контракт → mapper → сервис → контроллер → e2e». Внутри задачи шаги идут строго по порядку ниже, каждый проверяем отдельно
- Covers: AC-14.5 (b), AC-14.6; DD Element 8, Integration Point 2a; Certainty: medium («сброс хвоста» даёт ровно один ответ), low (хранимое состояние после обрыва сети)
- **Единица коммита: T2.4 + T2.5** — одна общая единица, готовая к коммиту (manual-стратегия) после зелёного гейта G3. Гейты качества единицы проверяются здесь
- Среда выполнения: Postgres на хост-порту **5433**; `apps/api/.env` — `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`; перед e2e — `pnpm db:up`

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)» **вместе с T2.4 (единица T2.4 + T2.5)**: все гейты качества пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
Серверная мера «сброс хвоста» (вариант (1), выбранный пользователем по итогам первого прогона T2.4; DD v1.8 делает её обязательной), удаление частей `error` из истории и перенос проверки беседы в чат.

1. **contracts** (`packages/contracts/src/threads.ts`): `ChatMessageRefSchema` — `z.looseObject`: `id` — непустая строка, `role` — строка, прочие поля допускаются; `type ChatMessageRef = z.infer<typeof ChatMessageRefSchema>`. `ChatRequestSchema` и `index.ts` не меняются (re-export `threads.js` уже есть). Собственного теста нет: объявление схемы поведения не добавляет.
2. **`thread.mapper.ts`**: `maskToolErrorText` → `maskHistoryErrors` (та же сигнатура `(messages: HistoryMessage[]) => HistoryMessage[]`): маскирование `errorText` частей `tool-*`/`dynamic-tool` в `output-error` — как в T2.3; части `type === 'error'` удаляются; сообщение остаётся, даже если `parts` пуст. Потребители (найдены поиском по репозиторию): `threads.service.ts`, `thread.mapper.spec.ts`; после правки в `apps/api/src` и `apps/api/test` нет ни одной ссылки на `maskToolErrorText`.
3. **`ThreadsService.listMessages`**: `… → ThreadMessagesResponseSchema.parse → maskHistoryErrors`.
4. **`ThreadsService.discardRepliesAfter(input: DiscardRepliesInput): Promise<void>`** (`DiscardRepliesInput = { threadId; userId; userMessageId }` — внутренний тип `threads.service.ts`): `recall({ threadId, resourceId: userId, perPage: 20, page: 0, orderBy: { field: 'createdAt', direction: 'DESC' }, includeTotal: false })` — 20 самых новых сообщений, возвращаются от старых к новым; самое новое сообщение пользователя — последнее `user` списка, хвост — всё после него; `deleteMessages(<id хвоста>)` только если `id` = `userMessageId`, хвост не пуст и каждый элемент хвоста — `assistant`; иначе ничего. Ошибки `recall`/`deleteMessages` не перехватываются (500 до SSE). В `deleteMessages` уходят только `id` из `recall`, не из тела запроса (IDOR).
5. **`ChatController.chat`**: конструктор получает `ThreadsService`; порядок «агент → наличие id → беседа → сброс хвоста → стрим»: после `BadRequestException` — `await this.threads.getOwnedThread(threadId, req.user.id)`; затем последний элемент `body.messages` разбирается `ChatMessageRefSchema.safeParse` (без `as`); успех и `role === 'user'` → `await this.threads.discardRepliesAfter({ threadId, userId: req.user.id, userMessageId })`; пустой массив, неразобранный элемент или иная роль → вызова нет. Стриминг, `onError`, отмена (`res.on('close')`), лог `usage` не меняются. Это **отклонение от порядка DD** (проверка беседы перенесена из T5.1; e2e остаются в T5.1).
6. **`chat.module.ts`**: `imports: [ThreadsModule]` (перенесено из T4.3; `ThreadsModule` уже экспортирует `ThreadsService`).
7. **`mockModels.ts`**: сценарий «часть текста, поток не завершается до отмены» (`'Частичный'`, затем поток остаётся открытым). Сценарий слушает `abortSignal` вызова модели: при срабатывании закрывает свой поток или завершает его ошибкой и разрешает промис, который ждёт тест (детерминированный сигнал того, что сервер передал обрыв модели; тест не остаётся с открытыми дескрипторами).
8. **Unit (test-first)**: `threads.service.spec.ts` (new, фейковый `Memory`) — одна таблица `discardRepliesAfter` из 6 строк в порядке «от старых к новым» + литерал аргументов `recall`; `thread.mapper.spec.ts` — `describe` переименован в `maskHistoryErrors`, два новых кейса (ответ `text 'Частичный'` + `{ type: 'error', error: { name: 'Error', message: 'mock stream failure' } }` → те же `id`/`role`, части — только `text 'Частичный'`; ответ из одной части `error` → тот же `id`, `parts: []`); кейсы T2.3 не меняются.
9. **e2e** (`chat-threads.e2e-spec.ts`): (а) кейс AC-14.6 из T2.4 — литерал шага 2 и проверка 2 строк **без изменений**; в шаг 1 добавляются утверждения: типы частей ответа ассистента в `/messages` равны `['text']`; `safeValidateUIMessages` для `/messages` успешен; сериализованное тело `/messages` не содержит `'mock stream failure'`; кейс становится зелёным; (б) **новый кейс** `AC-14.6 (network drop): regenerating a reply cut off by a client disconnect leaves exactly one assistant reply after the user message` — Arrange: новая беседа через `seed`; mock-модель: первый вызов `'Частичный'` и поток не завершается (сценарий п. 7), второй — `'Ответ 2'`. Act 1: отправка `'Вопрос'`; клиент обрывает HTTP-запрос после чанка `text-delta 'Частичный'`; тест ждёт промис отмены сценария — детерминированный сигнал, что сервер передал обрыв модели; если промис не разрешился в пределах таймаута теста — кейс красный, это **стоп и эскалация по гейту G3**. Затем опрос `countMessages`, пока значение не остаётся неизменным не менее 1 000 мс (максимум 5 000 мс). Хранимое состояние после обрыва — литералы `/messages` и число строк — **записывается в Notes плана до Act 2** (характеризация). Act 2: та же перегенерация, что в основном кейсе. Assert: `/messages` равно `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, строк 2; (в) характеризация `characterizes /messages after a regenerate-style and an edit-style resend`: ветка перегенерации → `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, строк 2 (проверка «тот же `id`, что у первого ответа» удаляется); ветка правки → `[['user', ['Вопрос']], ['assistant', ['Ответ 2']], ['user', ['Вопрос (изменён)']], ['assistant', ['Ответ 3']]]`, строк 4.
10. **Бюджет тестов**: вариант «обрыв сети» — дополнительный e2e; ловит дефект, который не видят ни unit, ни кейс ошибки модели: хранимое состояние после отмены стрима по `res.on('close')` (ответ записан позже повторной отправки или не записан), с которым «сброс хвоста» не справляется. Отдельного теста на `ChatMessageRefSchema` нет: объявление схемы поведения не добавляет. Ветки контроллера (пустой массив, неразобранный элемент, роль не `user`) своего теста не имеют: ошибочная ветка ничего не удалит, потому что `discardRepliesAfter` удаляет только когда `id` совпадает с `id` самого нового хранимого сообщения пользователя (строки 3–6 unit-таблицы). Правило не доказывается дважды: логика удаления — unit; e2e доказывают только запись Mastra в Postgres и проводку.

## Target Files
- [x] `packages/contracts/src/threads.ts` (`ChatMessageRefSchema`, тип `ChatMessageRef`)
- [x] `apps/api/src/threads/thread.mapper.ts` (`maskToolErrorText` → `maskHistoryErrors`, удаление частей `error`)
- [x] `apps/api/src/threads/thread.mapper.spec.ts`
- [x] `apps/api/src/threads/threads.service.ts` (`discardRepliesAfter`, `listMessages`)
- [x] `apps/api/src/threads/threads.service.spec.ts` (new)
- [x] `apps/api/src/chat/chat.controller.ts` (конструктор, участок между проверкой `threadId` и `agent.stream`)
- [x] `apps/api/src/chat/chat.module.ts` (`imports: [ThreadsModule]`)
- [x] `apps/api/test/support/mockModels.ts` (сценарий «часть текста, поток не завершается»)
- [x] `apps/api/test/chat-threads.e2e-spec.ts`
- [x] `docs/features/chat-shell/threads-api/20261028-feature-threads-api.md` (только пункты Notes «Гейт G3 после «сброса хвоста»» и «Хранимое состояние после обрыва сети»)

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации. В `chat.controller.ts` не меняются стриминг, `onError`, отмена и лог `usage` (`onFinish` — T4.3); `apps/api/test/app.e2e-spec.ts`, `ChatRequestSchema` и `packages/contracts/src/index.ts` не меняются. В файле плана правятся только два указанных пункта Notes. Если нужна правка файла вне списка (например, `createTestApp.ts`) — эскалация.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` v1.8 (§ Element 8; § ThreadsService `discardRepliesAfter`; § Data Contract `discardRepliesAfter`; § Contract Definitions `ChatMessageRefSchema`; § `maskHistoryErrors`; § AC-14.5 (b); § AC-14.6; § Test Strategy AC-14.6 и `threads.service.spec.ts`; § Integration Point 2a; § Error Handling; § Verification (Certainty); § Контракт для `web-shell` п. 6)
- `docs/features/chat-shell/threads-api/20261028-feature-threads-api/task-T2.4.md` (Investigation Notes: литералы шага 1 и склейки шага 2; сырой `content` строки ассистента)
- `docs/features/chat-shell/threads-api/20261028-feature-threads-api/task-T2.3.md` (Investigation Notes: литералы характеризации (a), (b) первого прогона; `maskToolErrorText`)
- `apps/api/src/chat/chat.controller.ts` (место вставки: после `BadRequestException`, до `res.on('close')`/`agent.stream`)
- `apps/api/src/threads/threads.service.ts`, `thread.mapper.ts`, `thread.mapper.spec.ts`, `threads.module.ts`
- `apps/api/test/chat-threads.e2e-spec.ts` (кейс AC-14.6 и характеризация), `apps/api/test/support/*` (`mockModels.ts`, `createTestApp.ts`, `db.ts`)
- `@mastra/memory` `Memory.recall`/`deleteMessages` (установленная версия): порядок возвращаемых сообщений при `orderBy createdAt DESC` — «от старых к новым», транзакционность удаления

## Change Category
`Change Category: state-change, contract-change, boundary-change`

Смена поведения публичного маршрута `POST /api/chat/:agentId` (чужая/неизвестная беседа: 500 → 404; повторная отправка того же сообщения пользователя удаляет хранимый ответ) и формата истории (части `error` не возвращаются). Исполнитель проверяет смежные пути: обычная отправка и правка ничего не удаляют (AC-14.1, 12 сообщений, остаётся зелёным); неизвестный агент (404 как раньше); отсутствующий id (400 как раньше); `app.e2e-spec.ts` без правок.

## Reference Contracts
Значения дословно из Design Doc v1.8 (копия Reference Contract Values плана).

| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ `maskHistoryErrors`) | derived-display | «`maskHistoryErrors(messages: HistoryMessage[]): HistoryMessage[]` — чистая функция, единственное место, где история освобождается от сырого текста ошибок (AC-14.5)»: «часть, у которой `type` начинается с `tool-` или равен `dynamic-tool`, а `state === 'output-error'`, → копия с `errorText: AGENT_ERROR_TEXT`»; «часть с `type === 'error'` (ошибка модели посреди стрима) → удаляется»; «остальные части и сообщения — без изменений; сообщение не удаляется, даже если `parts` стал пустым.» | Y, если `maskHistoryErrors` — чистая функция с той же сигнатурой, что у `maskToolErrorText`; части `tool-*`/`dynamic-tool` в `output-error` получают `AGENT_ERROR_TEXT`, части `type === 'error'` удалены, сообщение с пустым `parts` остаётся |
| design-threads-api.md (§ Test Strategy, `thread.mapper.spec.ts`) | derived-display | «`maskHistoryErrors` (AC-14.5): часть `tool-failing` `output-error` с `errorText: 'boom'` → `'Agent error'`; часть `dynamic-tool` `output-error` → `'Agent error'`; ответ с частями `text 'Частичный'` и `{ type: 'error', error: { name: 'Error', message: 'mock stream failure' } }` → те же `id` и `role`, части — только `text 'Частичный'`; ответ из одной части `error` → тот же `id`, `parts: []`; `tool-getWeather` `output-available` и части `text`/`reasoning` возвращаются без изменений (`toEqual` с литералами).» | Y, если в `thread.mapper.spec.ts` есть кейсы T2.3 (без изменений) и два новых (`text 'Частичный'` + `error` → только `text`; одна часть `error` → `parts: []`), все — `toEqual` с литералами |
| design-threads-api.md (§ ThreadsService, `listMessages`) | structure-order | «проверка владельца → `recall` (`perPage: false`, `createdAt ASC`) → `toAISdkMessages(…, { version: 'v7' })` → `ThreadMessagesResponseSchema.parse` → `maskHistoryErrors`.» | Y, если `listMessages` вызывает шаги ровно в этом порядке, без `as`; в `apps/api/src` и `apps/api/test` нет ссылок на `maskToolErrorText` |
| design-threads-api.md (§ AC-14.5) | state-lifecycle-negative | «(b) **If** ответ модели завершился ошибкой, **then** the system shall не возвращать часть `error`, а сообщение ассистента вернуть только с частями, сохранёнными до ошибки. Исходный текст ошибки инструмента или модели в ответ не попадает.» | Y, если unit mapper и шаг 1 e2e AC-14.6 подтверждают: части `error` нет, сырого `'mock stream failure'` в теле `/messages` нет |
| design-threads-api.md (§ Contract Definitions, `ChatMessageRefSchema`) | structure-order | «`ChatMessageRefSchema` (`packages/contracts/src/threads.ts`, тип `ChatMessageRef`) — структурная ссылка на элемент `body.messages`, `z.looseObject`»; поля: «`id` \| строка \| непустая»; «`role` \| строка \| обязательна \| Мера применяется только к `'user'`»; «прочие поля \| любые \| допускаются» | Y, если `ChatMessageRefSchema` — `z.looseObject`, `id` — непустая строка, `role` — строка, тип `ChatMessageRef = z.infer<…>`; `ChatRequestSchema` и `index.ts` не изменены |
| design-threads-api.md (§ ThreadsService, `discardRepliesAfter`) | state-lifecycle-negative | «`ChatController` разбирает последний элемент `body.messages` схемой `ChatMessageRefSchema` (`safeParse`, без `as`). Не разобран, `role` не `'user'` или массив пуст — метод не вызывается, отправка обычная.»; «Хвост удаляется (`Memory.deleteMessages` с `id` хвоста) только когда одновременно: `id` этого сообщения равен `userMessageId`; хвост не пуст; каждое сообщение хвоста имеет роль `assistant`. Иначе ничего не удаляется.»; «Ошибка `recall` или `deleteMessages` пробрасывается: чат отвечает 500 до начала стрима, удаление транзакционное (находка 15).» | Y, если `ChatController` разбирает последний элемент `body.messages` через `safeParse` (без `as`), вызывает `discardRepliesAfter` только для `role === 'user'`, а метод удаляет хвост только при трёх условиях одновременно; ошибки не перехватываются |
| design-threads-api.md (§ Data Contract `discardRepliesAfter`) | structure-order | «recall (perPage 20, page 0, createdAt DESC, includeTotal false) возвращает 20 самых новых сообщений беседы, упорядоченных от старых к новым; самое новое сообщение пользователя — последнее сообщение user в этом списке, хвост — все сообщения после него»; «удаляются только id, полученные recall этой беседы с resourceId = userId; id из тела запроса в deleteMessages не передаётся» | Y, если unit проверяет литерал аргументов `recall` и что в `deleteMessages` уходят только `id` из ответа `recall` |
| design-threads-api.md (§ Test Strategy, `threads.service.spec.ts`) | state-lifecycle-negative | «`discardRepliesAfter` (AC-14.6, таблица случаев; фейковый `recall` отдаёт сообщения от старых к новым, как установленный Mastra): `[user u1, assistant a1]` и `userMessageId: 'u1'` → `deleteMessages(['a1'])`; `[user u1, assistant a1, assistant a2]` и `'u1'` → `deleteMessages(['a1', 'a2'])`; `[user u1, assistant a1]` и `'u-new'` (обычная отправка) → не вызван; `[user u0, assistant a0, user u1]` и `'u1'` (ответа нет) → не вызван; `[user u0, assistant a0, user u1, assistant a1]` и `'u0'` (не самое новое) → не вызван; ни одного `user` среди 20 → не вызван. `recall` вызван с `{ threadId: 't-1', resourceId: 'u-1', perPage: 20, page: 0, orderBy: { field: 'createdAt', direction: 'DESC' }, includeTotal: false }`.» | Y, если `threads.service.spec.ts` содержит одну таблицу из 6 строк (сообщения от старых к новым) и литерал аргументов `recall` |
| design-threads-api.md (§ Error Handling) | state-lifecycle-negative | «Ошибка `recall`/`deleteMessages` при «сбросе хвоста» \| `ThreadsService.discardRepliesAfter` \| Пробрасывается → штатный 500 до начала стрима; транзакция не оставляет частично удалённый хвост»; «Беседа удалена между `getOwnedThread` и `recall` «сброса хвоста» \| `Memory.recall` (обычный `Error`) \| 500 до начала стрима» | Y, если вокруг `recall`/`deleteMessages` в `discardRepliesAfter` нет `try/catch`, а вызов в чате стоит до начала SSE (ошибка → штатный 500) |
| design-threads-api.md (§ Test Strategy, AC-14.6) | state-lifecycle-negative | «mock-модель первым ответом выдаёт часть текста `'Частичный'` и затем ошибку стрима, вторым — `'Ответ 2'`. Шаг 1: отправка `'Вопрос'` (`trigger: 'submit-message'`) → SSE содержит чанк `error` с `'Agent error'`; `/messages` = `[['user', ['Вопрос']], ['assistant', ['Частичный']]]`, `id` ответа равен `messageId` чанка SSE `start`, строк в `mastra_messages` — 2 (хранимое состояние «частичное», контракт `web-shell` п. 6); типы частей ответа ассистента равны литералу `['text']` (сырые части находки 14 без удалённой части `error`); `safeValidateUIMessages` для `/messages` успешен; сериализованное тело `/messages` не содержит `'mock stream failure'` (AC-14.5). Шаг 2: отправка с `trigger: 'regenerate-message'`, `messageId` = id ответа из шага 1, `messages = [то же сообщение 'Вопрос']` → `/messages` равно литералу `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, строк в `mastra_messages` — 2. Вариант «обрыв сети» (новая беседа): mock-модель выдаёт `'Частичный'` и не завершает поток, клиент обрывает SSE, затем та же перегенерация → тот же литерал шага 2, строк 2. Приёмка — литерал шага 2.» | Y, если e2e выполняет шаг 1 (литералы, id ответа = `messageId` SSE `start`, типы частей `['text']`, `safeValidateUIMessages`, нет `'mock stream failure'`, 2 строки), шаг 2 (неизменный литерал, 2 строки) и вариант «обрыв сети» (литералы после обрыва записаны, затем тот же литерал шага 2, 2 строки) |
| design-threads-api.md (§ AC-14.6) | state-lifecycle-negative | «(повторная отправка того же сообщения пользователя — тот же `id`, без последнего ответа ассистента; поля `trigger` и `messageId` сервер не читает), the system shall вернуть в `GET /api/threads/:threadId/messages` после этого сообщения пользователя ровно одно сообщение ассистента, содержащее только текст перегенерированного ответа; сообщение пользователя не дублируется, текст неудавшейся попытки не возвращается и не хранится.» | Y, если после перегенерации в `/messages` ровно одно сообщение ассистента с текстом `'Ответ 2'`, нет `'Частичный'`, user не продублирован |
| design-threads-api.md (§ Test Strategy, `chat-threads.e2e-spec.ts`, перегенерация и правка) | state-lifecycle-negative | «перегенерация (то же сообщение `'Вопрос'`) → `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, строк 2; затем правка (новое сообщение `'Вопрос (изменён)'`) → `[['user', ['Вопрос']], ['assistant', ['Ответ 2']], ['user', ['Вопрос (изменён)']], ['assistant', ['Ответ 3']]]`, строк 4.» | Y, если характеризационный кейс содержит новые литералы ветки перегенерации (2 строки) и ветки правки (4 строки), проверка «тот же `id`, что у первого ответа» удалена |
| design-threads-api.md (§ Integration Points, Integration Point 2a) | state-lifecycle-negative | «e2e AC-14.6 (Test Strategy): после ошибки модели и перегенерации история — `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, строк `mastra_messages` 2.» | Y, если e2e AC-14.6 зелёный с литералом и 2 строками `mastra_messages` |
| design-threads-api.md (§ Verification, Certainty) | state-lifecycle-negative | Обрыв сети: «e2e AC-14.6, вариант «обрыв сети», на шаге 8»; если не подтвердилось — «Стоп и эскалация пользователю с литералами `/messages` и числом строк `mastra_messages` после обрыва и после перегенерации» | Y, если вариант «обрыв сети» зелёный; иначе — СТОП и эскалация (см. Decisions and Unresolved Items) |

## Decisions and Unresolved Items
Resolved decisions:

| Item | Decision | Source / Rule |
|---|---|---|
| Вариант по итогам первого прогона AC-14.6 | (1) оставить действие с исправлением хранения — серверная мера «сброс хвоста»; DD v1.8 делает её обязательной | Notes плана «Решение по гейту G3» |
| Gate G2 (перегенерация и правка обычного ответа) | снят: `web-shell` скрывает правку, переключение веток и перегенерацию обычных ответов; характеризационный кейс остаётся с новыми литералами | PRD Won't Have, `design-web-shell.md` |
| Место проверки беседы в чате | `getOwnedThread` в `ChatController.chat` добавляется здесь (отклонение от порядка DD: шаг 8 → T2.5); e2e AC-16.1 — T5.1 | work plan, «Отклонение от порядка DD» |
| Arrange бесед | `seed`, не `POST /api/threads` (маршрут появляется в T3.3) | work plan, Notes «Отклонения Arrange» |
| Признак «повторная отправка» | совпадение `id` последнего сообщения пользователя тела с самым новым `user` в хранилище; поля `trigger` и `messageId` сервер не читает | DD § AC-14.6 |
| Тест `ChatMessageRefSchema` и ветки «не `user`» | не пишется (объявление схемы; ветки покрыты unit-таблицей) | Test Selection, work plan |

Blocking unresolved items — гейт G3 (исход определяется результатом тестов этой задачи):

| Item | Required Input | Escalation Condition |
|---|---|---|
| **Gate G3 (до Phase 3 и T4.1, стоп всей реализации)** | e2e AC-14.6 (неизменный литерал шага 2 + новые утверждения шага 1), вариант «обрыв сети», характеризация с новыми литералами | Все три зелёные → G3 пройден. **СТОП и эскалация** пользователю (через оркестратора), если: (а0) промис отмены сценария «обрыв сети» не разрешился в пределах таймаута теста — сервер не передал обрыв модели, кейс красный; (а) вариант «обрыв сети» показывает хранимое состояние, которое «сброс хвоста» не обрабатывает — например, частичный ответ записан **после** повторной отправки, нет сообщения пользователя, лишние строки `mastra_messages`; (б) после реализации AC-14.6 остаётся красным. Доказательства при эскалации: литералы `/messages` и число строк `mastra_messages` **после обрыва (или ошибки) и после перегенерации**. Красный кейс остаётся красным (не `it.skip`/`it.todo`), продукт не «подгоняется» ради прохождения; единица T2.4 + T2.5 не готова к коммиту до решения пользователя. |

**Обрыв сети — формулировка стопа.** Если после обрыва SSE клиентом хранимое состояние оказывается иным, чем у ошибки модели, и «сброс хвоста» (удаление хвоста `assistant` после самого нового `user` с тем же `id`) его не обрабатывает, — **остановить реализацию**, не расширять меру («иное состояние, которое «сброс хвоста» не обрабатывает» — не повод дописывать обработку в этой задаче), записать литералы `/messages` и число строк после обрыва и после перегенерации в Notes плана («Хранимое состояние после обрыва сети») и вернуть оркестратору `escalation_needed`: Phase 3 и Phase 4 не начаты.

## Investigation Notes
(Заполняется исполнителем до и во время реализации. Доказательства первого прогона AC-14.6 — в `task-T2.4.md`; литералы характеризации первого прогона — в `task-T2.3.md`; здесь — план подхода, результат каждого Compliance Check, версии пакетов, литералы после обрыва сети.)

- **Исходное состояние (2026-10-29)**: гейт G (T2.3) пройден; красный кейс AC-14.6 и `partialTextThenErrorStep` присутствуют (T2.4). Версии: `ai` 7.0.148 (не менялась), `@mastra/memory` 1.39.1, `@mastra/core` 1.80.0, `@mastra/ai-sdk` 1.11.2; Postgres `localhost:5433` (`DATABASE_URL` передан через окружение, `apps/api/.env` не менялся).
- **`@mastra/memory` 1.39.1**: `recall` с явным `orderBy` вызывает `memoryStore.listMessages({ perPage, page, orderBy, includeTotal })` и пропускает результат через `MessageList(...).get.all.db()`; DD v1.8 (находка 15) и оркестратор подтверждают порядок результата «от старых к новым» — самое новое сообщение `user` — последнее `user` списка (`findLastIndex`). `deleteMessages(input: MessageDeleteInput)` — `string[]` или объекты с `id`; передаётся `string[]` из `recall`.
- **План подхода**: contracts → unit test-first (`threads.service.spec.ts` на настоящем `Memory` с `vi.spyOn(recall/deleteMessages)` — без `as`; `thread.mapper.spec.ts` — переименование + 2 кейса) → `maskHistoryErrors` (`filter` частей `error`, затем маскирование tool-частей) → `discardRepliesAfter` (без `try/catch`) → `ChatController.chat` (`getOwnedThread` → `ChatMessageRefSchema.safeParse(body.messages.at(-1))` → `discardRepliesAfter` при `role === 'user'`; стриминг/`onError`/отмена/`usage` не тронуты) → `ChatModule.imports: [ThreadsModule]` → `mockModels.ts` `partialTextUntilAbortStep` (поток ошибается `abortSignal.reason` по `abort` и разрешает `aborted`; `AssistantStep` расширен функцией от опций вызова) → e2e.
- **Red**: unit — 10 падений (`maskHistoryErrors is not a function`, `discardRepliesAfter` отсутствует); мутация «сброс хвоста» выключен (условие `role === 'MUTANT'`) — все три e2e (AC-14.6, «обрыв сети», характеризация) красные; мутация «часть `error` не удаляется» — шаг 1 AC-14.6 красный: `expected [ 'text', 'error' ] to deeply equal [ 'text' ]`. Обе мутации откачены.
- **Хранимое состояние после обрыва сети** (3 прогона подряд, одинаково): промис `aborted` разрешился (сервер передал обрыв модели через `res.on('close')` → `abortSignal`); `countMessages` устоялся на **2**; `/messages` — `[['user', ['Вопрос']], ['assistant', ['Частичный']]]`, типы частей ответа — `['text']`; сообщение пользователя сохранено (клиентский id); сырой `content` ответа — `{"format":2,"parts":[{"type":"text","text":"Частичный",...}],"content":"Частичный"}` (части `error` нет). Состояние того же класса, что после ошибки модели — «сброс хвоста» его обрабатывает. После перегенерации — `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, строк **2**.
- **Гейт G3: пройден** — AC-14.6 (неизменный литерал шага 2 + утверждения шага 1), «обрыв сети», характеризация (регенерация → 2 строки, правка → 4 строки) зелёные; полный `test:e2e` — 9 passed / 19 todo, включая AC-14.1 (12 сообщений), сравнение со стримом и `app.e2e-spec.ts` без правок.
- **Compliance Checks (финальная реализация)**: `maskHistoryErrors` — Y (чистая, та же сигнатура, tool `output-error` → `AGENT_ERROR_TEXT`, `error` удаляется, пустой `parts` остаётся); `thread.mapper.spec.ts` — Y (кейсы T2.3 без изменений + 2 новых, `toEqual` с литералами); `listMessages` — Y (владелец → `recall` ASC → `toAISdkMessages` v7 → `parse` → `maskHistoryErrors`; ссылок на `maskToolErrorText` в `src`/`test` нет); AC-14.5 (b) — Y; `ChatMessageRefSchema` — Y (`z.looseObject`, `id` непустая, `role` строка; `ChatRequestSchema`/`index.ts` не менялись); `discardRepliesAfter` в контроллере и правило трёх условий — Y; Data Contract (литерал `recall`, в `deleteMessages` только `id` из `recall`) — Y; `threads.service.spec.ts` 6 строк + литерал `recall` — Y; Error Handling (нет `try/catch`, вызов до SSE) — Y; AC-14.6 Test Strategy, AC-14.6, характеризация, Integration Point 2a, Verification (Certainty) — Y.
- **Adjacent Case Sweep**: обычная отправка (новый id) — не удаляет (AC-14.1, 12 сообщений, зелёный; строка 3 unit); правка — не удаляет (характеризация, 4 строки); неизвестный агент — 404 и отсутствующий id — 400 до проверки беседы (`app.e2e-spec.ts` зелёный без правок). Остаток для ревью: чужая/неизвестная беседа в чате теперь 404 вместо 500 — e2e AC-16.1 и «thread ownership on chat» остаются `it.todo` до T5.1.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать все Investigation Targets; убедиться, что гейт G (T2.3) пройден, красный кейс AC-14.6 и `partialTextThenErrorStep` присутствуют (T2.4); записать наблюдения в Investigation Notes
- [x] Проверить по документации/типам установленного `@mastra/memory`: порядок результата `recall` при `createdAt DESC` (от старых к новым), сигнатура `deleteMessages`; результат записать в Investigation Notes
- [x] Сверить контракты (Reference Contracts) с Design Doc v1.8, записать план подхода в Investigation Notes
- [x] contracts: добавить `ChatMessageRefSchema`/`ChatMessageRef`; `pnpm --filter @agent-os/contracts build`
- [x] Unit (test-first): `threads.service.spec.ts` — таблица `discardRepliesAfter` (6 строк) + литерал аргументов `recall`; `thread.mapper.spec.ts` — `describe` переименован, два новых кейса; убедиться, что падают по правильной причине (метод/функция отсутствует либо часть `error` не удаляется)
- [x] e2e: добавить утверждения шага 1 в кейс AC-14.6; добавить кейс «обрыв сети» и сценарий mock-модели «поток не завершается до отмены» (промис отмены по `abortSignal`); обновить литералы характеризации; убедиться, что кейсы красные по правильной причине (склейка / сырая часть `error`)

### 2. Green Phase
- [x] `maskToolErrorText` → `maskHistoryErrors` (+ удаление частей `error`), обновить потребителей; `listMessages`: `parse` → `maskHistoryErrors`
- [x] `ThreadsService.discardRepliesAfter`; `ChatController.chat`: `ThreadsService` в конструкторе, `getOwnedThread`, разбор `ChatMessageRefSchema.safeParse`, вызов `discardRepliesAfter`; `chat.module.ts`: `imports: [ThreadsModule]`
- [x] Запустить добавленные unit и e2e AC-14.6, «обрыв сети», характеризацию; записать литералы `/messages` и число строк после обрыва (до Act 2) и после перегенерации в Investigation Notes; промис отмены сценария не разрешился — кейс красный, СТОП и эскалация по G3
- [x] **Гейт G3** — три e2e зелёные; при красном или при состоянии, которое «сброс хвоста» не обрабатывает, — СТОП (см. Decisions), не расширять меру и не заглушать тест
- [x] Записать в Notes плана «Гейт G3 после «сброса хвоста»» (исход) и «Хранимое состояние после обрыва сети» (литералы `/messages` и строк `mastra_messages` после обрыва и после перегенерации; сообщение пользователя сохранено / нет)

### 3. Refactor Phase
- [x] Улучшить код, не меняя поведения (`threads.service.ts` — функции ≤ 50 строк, без `as`)
- [x] Повторно запустить добавленные тесты

### 4. Gates единицы T2.4 + T2.5 (все — ноль ошибок; перед vitest после правки `packages/contracts` — `pnpm --filter @agent-os/contracts build`; перед e2e — `pnpm db:up` и `apps/api/.env` с `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`)
- [x] `pnpm --filter @agent-os/contracts build`; `git diff main -- packages/contracts/src/index.ts` — по-прежнему одна строка; `ChatRequestSchema` не изменена
- [x] `pnpm --filter api lint`
- [x] `pnpm --filter api exec tsc --noEmit -p tsconfig.json`
- [x] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`
- [x] `pnpm --filter api test` (unit: `threads.service.spec.ts`, `thread.mapper.spec.ts`, прочие)
- [x] `pnpm --filter api test:e2e` (полный: AC-14.1 с 12 сообщениями, сравнение со стримом, AC-14.6, «обрыв сети», характеризация; `app.e2e-spec.ts` без правок)
- [x] `pnpm --filter api build`
- [x] Поиск по `apps/api/src` и `apps/api/test`: ссылок на `maskToolErrorText` нет

## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext`, `.js`-суффиксы импортов — Enforces: строгие типы, `safeParse` без `as` — Config/Source: `apps/api/tsconfig.json`, `packages/contracts/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest unit / e2e (реальный Postgres) — Enforces: поведение и AC — Config/Source: `apps/api/vitest.config.ts`, `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- `nest build` — Enforces: сборка production-кода — Config/Source: `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json` — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`
- AC-18.3: `app.e2e-spec.ts`, `ChatRequestSchema`, `index.ts` не меняются — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: unit (фейковый `Memory`) + e2e на реальном Postgres с mock-моделью; для AC-14.6 — два `POST /api/chat/assistant` в ту же беседу (`submit-message`, затем `regenerate-message`) + `GET /messages` + число строк `mastra_messages`; для «обрыва сети» — обрыв HTTP-запроса клиентом после `text-delta 'Частичный'`, ожидание промиса отмены сценария (разрешается по `abortSignal` вызова модели), опрос `countMessages` до неизменного значения не менее 1 000 мс (максимум 5 000 мс), запись состояния после обрыва в Notes, затем та же перегенерация.
- **Success criteria**: после шага 2 `/messages` равно `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, 2 строки — и после ошибки модели, и после обрыва сети (**гейт G3**); шаг 1 AC-14.6: типы частей `['text']`, `safeValidateUIMessages` успешен, в теле нет `'mock stream failure'`; характеризация с новыми литералами (регенерация — 2 строки, правка — 4 строки); AC-14.1 (12 сообщений) зелёный.
- **Failure response (G3)**: стоп реализации, эскалация с литералами `/messages` и числом строк `mastra_messages` после обрыва/ошибки и после перегенерации (см. Decisions).
- **Verification level**: L2.

## Proof Obligations
Тест обязан упасть, если (источник — Proof obligations плана):

### Obligation: `discardRepliesAfter` (unit-таблица)
- **Claim**: хвост удаляется ровно в случае повторной отправки самого нового сообщения пользователя; во всех остальных строках `deleteMessages` не вызывается.
- **Primary failure mode**: удаление при несовпадении `id`; удаление хвоста с сообщением `user`; удаление после не самого нового сообщения пользователя; список читается как «от новых к старым» (строки идут от старых к новым); в `deleteMessages` уходит `id` из тела.
- **Boundary to exercise**: in-process unit с фейковым `Memory`.
- **State assertion**: 6 строк таблицы + литерал аргументов `recall`.
- **Mock boundary rationale**: мокается `Memory` (внешний I/O).
- **Residual**: запись Mastra в Postgres — e2e AC-14.6.

### Obligation: `maskHistoryErrors` (AC-14.5 (b))
- **Claim**: часть `error` удаляется, остальное сохраняется.
- **Primary failure mode**: часть `error` маскируется вместо удаления; сообщение с пустым `parts` выбрасывается.
- **Boundary to exercise**: in-process unit (`toEqual` с литералами).
- **State assertion**: те же `id`/`role`; части — только `text 'Частичный'`; одна часть `error` → `parts: []`.
- **Mock boundary rationale**: none.
- **Residual**: e2e AC-14.6 шаг 1.

### Obligation: AC-14.6 (Certainty: medium) и AC-14.5 (b) через HTTP
- **Claim**: после ошибки модели и перегенерации остаётся ровно одно сообщение ассистента `'Ответ 2'`; история не содержит части `error` и сырого текста.
- **Primary failure mode**: остаётся `'Частичный'`; ответы склеены; есть часть `error` (`safeValidateUIMessages` падает) или сырой `'mock stream failure'` в теле.
- **Boundary to exercise**: HTTP + `GET /messages` + число строк `mastra_messages`.
- **State assertion**: шаг 1 и шаг 2 по Reference Contracts.
- **Mock boundary rationale**: мокается только модель.
- **Residual**: нет.

### Obligation: AC-14.6, вариант «обрыв сети» (Certainty: low)
- **Claim**: хранимое состояние после обрыва SSE того же класса, что после ошибки модели; «сброс хвоста» даёт один ответ.
- **Primary failure mode**: после перегенерации два ответа или склейка; частичный ответ записан после повторной отправки; нет сообщения пользователя; сервер не передаёт обрыв клиента модели (промис отмены сценария не разрешается).
- **Boundary to exercise**: HTTP, отмена по `res.on('close')`, промис отмены сценария (`abortSignal` модели), опрос `countMessages` до неизменного значения ≥ 1 000 мс.
- **State assertion**: литералы после обрыва записаны в Notes до Act 2; после перегенерации — `[['user', ['Вопрос']], ['assistant', ['Ответ 2']]]`, 2 строки.
- **Mock boundary rationale**: мокается только модель (поток не завершается).
- **Residual**: иное состояние — стоп и эскалация.

### Obligation: сервер передаёт обрыв клиента модели
- **Claim**: при обрыве SSE клиентом сервер передаёт отмену в вызов модели (`abortSignal` срабатывает).
- **Primary failure mode**: отмена по `res.on('close')` не доходит до модели; поток модели остаётся открытым.
- **Boundary to exercise**: HTTP + промис отмены сценария `mockModels.ts`.
- **State assertion**: промис разрешился в пределах таймаута теста; иначе кейс красный — стоп и эскалация по G3.
- **Mock boundary rationale**: мокается только модель.
- **Residual**: нет.

### Obligation: характеризация перегенерации и правки обычного ответа
- **Claim**: «сброс хвоста» срабатывает на обычный ответ при перегенерации; правка ничего не удаляет.
- **Primary failure mode**: «сброс хвоста» не срабатывает при перегенерации обычного ответа; ветка правки что-то удаляет (не 4 строки).
- **Boundary to exercise**: HTTP.
- **State assertion**: новые литералы (перегенерация — 2 строки; правка — 4 сообщения, 4 строки).
- **Mock boundary rationale**: мокается только модель.
- **Residual**: скрытие действий — в `web-shell`.

### Obligation: обычная отправка не удаляет сообщения
- **Claim**: e2e AC-14.1 (12 сообщений из 6 обменов) остаётся зелёным.
- **Primary failure mode**: обычная отправка удаляет хранимые сообщения.
- **Boundary to exercise**: существующий e2e AC-14.1.
- **State assertion**: 12 сообщений в порядке «от старых к новым».
- **Mock boundary rationale**: как в T2.2.
- **Residual**: нет.

## Completion Criteria
- [x] `pnpm --filter @agent-os/contracts build` OK; `git diff main -- packages/contracts/src/index.ts` — по-прежнему одна строка, `ChatRequestSchema` не изменена
- [x] Unit `threads.service.spec.ts` и `thread.mapper.spec.ts` зелёные
- [x] e2e AC-14.6 зелёный с неизменным литералом шага 2 и новыми утверждениями шага 1
- [x] Вариант «обрыв сети» зелёный; хранимое состояние после обрыва записано в Notes плана
- [x] Характеризационный кейс зелёный с новыми литералами
- [x] Полный `pnpm --filter api test:e2e` зелёный, в том числе AC-14.1 (12 сообщений) и сравнение со стримом
- [x] `app.e2e-spec.ts` проходит без правок
- [x] В `apps/api/src` и `apps/api/test` не осталось ссылок на `maskToolErrorText`
- [x] Исход гейта G3 записан в Notes плана («Гейт G3 после «сброса хвоста»»); при красном исходе — стоп и эскалация (`escalation_needed`, Phase 3 не начата, красный кейс не заглушён)
- [x] lint/tsc/prettier/unit/e2e/build — ноль ошибок
- [x] Единица T2.4 + T2.5 готова к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: открывает Phase 3 и Phase 4 (включая T4.1) только при пройденных G (T2.3) и G3 (T2.5). Файлы, общие с другими задачами и идущие строго по порядку: `threads.service.ts` (T2.3 → T2.5 → T3.1), `thread.mapper.ts`/`.spec.ts` (T2.3 → T2.5), `chat.controller.ts` (T2.3 `onError` → T2.5 → T4.3 `onFinish`), `mockModels.ts` и `chat-threads.e2e-spec.ts` (T2.4 → T2.5 → T4.3 → T5.1), `threads.service.spec.ts` (T2.5 создаёт → T3.4 дополняет).
- Scope boundary: стриминг, `onError`, отмена и лог `usage` в контроллере не меняются; `onFinish` и `ThreadTitleService` — T4.3; e2e AC-16.1 — T5.1; `apps/api/test/app.e2e-spec.ts`, `ChatRequestSchema`, `index.ts` не меняются.
- Передача оркестратору: исход G3 и хранимое состояние после обрыва сети — для закрытия оставшихся вопросов в DD «Контракт для `web-shell`», п. 6 (через `technical-designer`) при расхождении.
