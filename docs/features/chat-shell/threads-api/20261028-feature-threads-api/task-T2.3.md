# Task T2.3: EVP — маскирование ошибок, сравнение «живой стрим ↔ история» (гейт G)

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 2, T2.3)
- Dependencies: T2.2 → Deliverable: `GET /api/threads/:threadId/messages`, `ThreadsService.listMessages`
- Provides: Gate G (до T2.4 и Phase 3); `AGENT_ERROR_TEXT`, `toStreamErrorText`, `maskToolErrorText`; чтение сырого `mastra_messages` в `db.ts`; исход гейта G — оркестратору (в Notes плана его записывает T2.4, пункт «Повторный прогон гейта G»)
- Size: Medium (8 файлов; изменения продуктового кода точечные: `onError`, `listMessages`)
- Covers: AC-14.1, AC-14.5; Verification Strategy (б)
- Статус: выполнена (гейт G пройден; Investigation Notes и Evidence не меняются). Следующие задачи: T2.4 (доказательства AC-14.6, завершена) и T2.5 (гейт G3). **Переименование**: `maskToolErrorText` в `thread.mapper.ts` переименовывает в `maskHistoryErrors` и дополняет удалением частей `type === 'error'` задача T2.5 (`task-T2.5.md`); в этой задаче и её Evidence имя остаётся `maskToolErrorText`, как было на момент выполнения

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
Задача ранней точки проверки (EVP) после обновления плана (DD v1.7, PRD v1.4). Первый прогон выявил расхождение «стрим ↔ история» в `errorText` (см. Investigation Notes); решение — маскирование из единого модуля. Задача реализует его и проходит гейт G. Проверка AC-14.6 (гейт G3) и характеризационный кейс regenerate/edit вынесены в T2.4.

1. **Единый текст ошибки** — `apps/api/src/common/stream-error-text.ts`: `AGENT_ERROR_TEXT = 'Agent error'` и `toStreamErrorText(error: unknown): string` — `Error` со свойством `statusCode` → `Model provider error (<statusCode>)`, иначе `Agent error`; чистая функция без логирования и без `as`.
2. **`ChatController.chat` `onError`** — `this.logger.error(...)` с ошибкой как `unknown` (без `error as Error`) и `return toStreamErrorText(error)`; тексты для клиента не меняются; остальной контроллер не трогается (проверка беседы — T5.1, `onFinish` — T4.3).
3. **`maskToolErrorText(messages: HistoryMessage[]): HistoryMessage[]`** в `thread.mapper.ts` — чистая функция; для каждой части, у которой `type` начинается с `tool-` или равен `dynamic-tool`, а `state === 'output-error'`, возвращает копию с `errorText: AGENT_ERROR_TEXT`; прочие части и сообщения — без изменений.
4. **`ThreadsService.listMessages`** — порядок: проверка владельца → `recall` (`perPage: false`, `createdAt ASC`) → `toAISdkMessages(…, { version: 'v7' })` → `ThreadMessagesResponseSchema.parse` → `maskToolErrorText` (маскирование после разбора схемой, без `as`).
5. **Output Comparison (гейт G)** — e2e `AC-14.1/AC-14.5 (output comparison): history equals the live v7 stream under the Output Comparison rule`: `UIMessage` из SSE через `readUIMessageStream` сравнивается с `/messages` поле-за-полем после исключения только `step-start`, всех полей `providerMetadata`, поля `id` частей `reasoning` и поля `state` частей `text`; остальные поля — без исключений; `tool-failing.errorText` — `'Agent error'` в стриме и в истории; через `db.ts` в `mastra_messages` той же беседы — `'boom'` (сырой текст не утёк через историю).
6. **e2e `AC-14.1`** — литерал части `tool-failing` меняется с `errorText: 'boom'` на `errorText: 'Agent error'` (следствие маскирования); остальные утверждения T2.2 не меняются.

## Target Files
- [x] `apps/api/src/common/stream-error-text.ts` (new)
- [x] `apps/api/src/common/stream-error-text.spec.ts` (new)
- [x] `apps/api/src/chat/chat.controller.ts` (только `onError`)
- [x] `apps/api/src/threads/thread.mapper.ts`
- [x] `apps/api/src/threads/thread.mapper.spec.ts`
- [x] `apps/api/src/threads/threads.service.ts` (только `listMessages`)
- [x] `apps/api/test/support/db.ts` (чтение сырого содержимого `mastra_messages` беседы)
- [x] `apps/api/test/threads.e2e-spec.ts`

(Отметка `[x]` — файл, затронутый первым прогоном EVP; остальные — новая работа.)

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации. В `chat.controller.ts` меняется только `onError`; в `threads.service.ts` — только `listMessages`. `apps/api/test/chat-threads.e2e-spec.ts`, `apps/api/test/support/mockModels.ts` и файл плана — не Target Files T2.3 (они у T2.4).

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Main Components / Общий текст ошибки стрима, `maskToolErrorText`; § Output Comparison; § Early Verification Point; § AC-14.5; § Решения по итогам ранней точки проверки)
- `apps/api/src/chat/chat.controller.ts` (`onError` в `toAISdkStream`/`createUIMessageStreamResponse`)
- `apps/api/src/threads/thread.mapper.ts`, `apps/api/src/threads/threads.service.ts` (T2.1–T2.2)
- `apps/api/test/threads.e2e-spec.ts` (кейсы EVP первого прогона), `apps/api/test/support/*` (T1.3)

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|

| design-threads-api.md (§ Общий текст ошибки стрима) | derived-display | «`AGENT_ERROR_TEXT = 'Agent error'`; `toStreamErrorText(error: unknown): string` — `Error` со свойством `statusCode` → `Model provider error (<statusCode>)`, иначе `Agent error`. Чистая функция без логирования и без `as`.» | Y, если модуль экспортирует ровно эти имена, функция чистая, без `as` |
| design-threads-api.md (§ Test Strategy, `stream-error-text.spec.ts`) | derived-display | «`new Error('boom')` → `'Agent error'`; ошибка со `statusCode: 529` → `'Model provider error (529)'`; не-`Error` значение (`'x'`) → `'Agent error'`.» | Y, если одна таблица из трёх строк с этими литералами |
| design-threads-api.md (§ `maskToolErrorText`) | derived-display | «`maskToolErrorText(messages: HistoryMessage[]): HistoryMessage[]` — чистая функция; для каждой части, у которой `type` начинается с `tool-` или равен `dynamic-tool`, а `state === 'output-error'`, возвращает копию с `errorText: AGENT_ERROR_TEXT`; остальные части и сообщения — без изменений.» | Y, если маскируются обе формы частей и только в `output-error` |
| design-threads-api.md (§ Test Strategy, `thread.mapper.spec.ts`) | derived-display | «`maskToolErrorText` (AC-14.5): часть `tool-failing` `output-error` с `errorText: 'boom'` → `'Agent error'`; часть `dynamic-tool` `output-error` → `'Agent error'`; `tool-getWeather` `output-available` и части `text`/`reasoning` возвращаются без изменений (`toEqual` с литералами).» | Y, если кейсы используют `toEqual` с литералами |
| design-threads-api.md (§ ThreadsService, `listMessages`) | structure-order | «проверка владельца → `recall` (`perPage: false`, `createdAt ASC`) → `toAISdkMessages(…, { version: 'v7' })` → `ThreadMessagesResponseSchema.parse` → `maskToolErrorText`.» | Y, если порядок вызовов в коде совпадает |
| design-threads-api.md (§ Test Strategy, `threads.e2e-spec.ts` AC-14.1) | derived-display | «`tool-failing` (`output-error`, `errorText: 'Agent error'`)» | Y, если литерал e2e AC-14.1 (T2.2) заменён с `'boom'` на `'Agent error'` |
| design-threads-api.md (§ Output Comparison) | structure-order | Expected output fields: «`errorText` должен совпадать (`'Agent error'` с обеих сторон).»; Diff method: «поле-за-полем JSON после исключения частей `step-start`, всех полей `providerMetadata`, поля `id` частей `reasoning` и поля `state` частей `text`; остальные поля — без исключений.» | Y, если исключены ровно перечисленные элементы и ничего сверх |
| design-threads-api.md (§ Test Strategy, AC-14.1 / AC-14.5) | state-lifecycle-negative | «`tool-failing.errorText` в обоих — `'Agent error'`, а в `mastra_messages` той же беседы хранится `'boom'` (сырой текст не утёк через историю).» | Y, если e2e читает `mastra_messages` через `db.ts` и видит `'boom'` |

## Decisions and Unresolved Items
Resolved decisions:

| Item | Decision | Source / Rule |
|---|---|---|
| Arrange бесед | `seed`, не `POST /api/threads` (маршрут появляется в T3.3) | work plan T2.3, Notes «Отклонения Arrange» |
| Расхождение `errorText` стрим ↔ история | маскируется в истории из единого модуля `stream-error-text.ts`; `onError` чата использует тот же модуль | DD «Решения по итогам ранней точки проверки», AC-14.5 |
| `reasoning.id`, `text.state` | исключены правилом Output Comparison (Mastra не хранит id части; `state: "done"` выставляет `readUIMessageStream`) | DD § Output Comparison |

Blocking unresolved items — гейт (исход определяется результатом тестов этой задачи):

| Item | Required Input | Escalation Condition |
|---|---|---|
| **Gate G (до T2.4 и Phase 3)**: история эквивалентна стриму под правилом Output Comparison? | e2e сравнения «стрим ↔ история» после маскирования | Остаётся расхождение вне правила Output Comparison или потеря содержимого — **СТОП**: эскалация пользователю как изменение PRD (Failure response EVP); вернуть оркестратору `escalation_needed`; собственный конвертер не писать, T2.4 и Phase 3 не начинать. Красный кейс остаётся в рабочем дереве красным (не `it.skip`/`it.todo`) до решения пользователя; задача не готова к коммиту. Сравнение зелёное — G пройден. |

## Investigation Notes
(Сохранено без изменений — записи первого прогона EVP; ниже добавлены записи для обновлённого плана.)

- Live-сторона: SSE-тело `POST /api/chat/assistant` (`res.text`) → `parseJsonEventStream({ schema: uiMessageChunkSchema })` → `readUIMessageStream` (всё из `ai` 7.0.148), берётся последний снимок `UIMessage`. История: последнее сообщение `GET /messages`.
- Нормализация по Output Comparison DD (первый прогон): `id`, `role`, `parts` без `step-start`, рекурсивно удалены все поля `providerMetadata`; сравнение `toEqual` (поля со значением `undefined` игнорируются); дополнительно литеральная последовательность типов `reasoning, tool-getWeather, tool-failing, text`.
- Наблюдение (сырой SSE): `tool-output-error` для `call-failing-1` несёт `errorText: "Agent error"` — это `onError` из `toAISdkStream` в `chat.controller.ts`; в `mastra_messages` хранится `toolInvocation.errorText: "boom"`, `toAISdkMessages` отдаёт `"boom"`. Хранимая часть `reasoning` не содержит `id`; `text` в истории без `state` (в стриме `state: "done"` выставляет `readUIMessageStream` на `text-end`).
- Характеризация: тела запросов повторяют AI SDK transport (клиентский `id` у user-сообщения, `trigger`, `messageId`; лишние поля срезает `ValidationPipe({ whitelist: true })`); список `[role, texts[]]` (text-части раздельно, чтобы склейка была видна) + `countMessages` из `test/support/db.ts`.
- Reference Contracts (первый прогон): отдельной строки не было; критерий «сравнение со SSE расходится только в `step-start`/`providerMetadata`» НЕ был выполнен (Gate G эскалирован), характеризация зафиксирована (Gate G2 — open question).
- **Evidence первого прогона EVP (2026-10-28; `ai` 7.0.148, `@mastra/ai-sdk` 1.11.2, `@mastra/core` 1.80.0)**:
  - Gate G не пройден по старому правилу: расхождения в трёх полях — (1) `tool-failing.errorText`: стрим `"Agent error"`, история `"boom"`; (2) `reasoning.id`: в стриме `"reasoning-1"`, в истории нет; (3) `text.state`: в стриме `"done"`, в истории нет. Совпадают: `id` сообщения, `role`, порядок типов, тексты, `toolCallId`, `state`, `input`, `output`. Потерь содержимого `text`/`reasoning`/`tool output` нет.
  - Характеризация: (a) regenerate (`messages = [тот же user 'Вопрос']`) → `[['user', ['Вопрос']], ['assistant', ['Ответ 1', 'Ответ 2']]]`, строк в `mastra_messages` 2; (b) edit (`messages = [новый user 'Вопрос (изменён)']`) → `[['user', ['Вопрос']], ['assistant', ['Ответ 1', 'Ответ 2']], ['user', ['Вопрос (изменён)']], ['assistant', ['Ответ 3']]]`, строк 4. Ограничение: история показывает все сохранённые реплики, включая отброшенные ветки.
- **Что изменилось в плане и как это учтено**: (1) расхождения (2) и (3) теперь исключены правилом Output Comparison, расхождение (1) снимается маскированием → ожидается, что повторный прогон гейта G зелёный; любое иное расхождение — стоп; (2) Gate G2 снят, характеризационный кейс остаётся без правок; (3) добавлен гейт G3 (AC-14.6) с остановкой всей реализации при провале.
- План подхода: порядок — unit `stream-error-text.spec.ts` и `thread.mapper.spec.ts` (Red) → модуль, `maskToolErrorText`, `onError`, `listMessages` (Green) → правка литерала AC-14.1 и правила сравнения (`db.ts`: сырой `mastra_messages`) → e2e сравнения; результат каждого Compliance Check — сюда. Шаги AC-14.6 и характеризации regenerate/edit — в `task-T2.4.md`.
- **Повторный прогон (2026-10-29, DD v1.7)** — план подхода и Compliance Check по итоговому коду:
  - `stream-error-text.ts`: экспортирует ровно `AGENT_ERROR_TEXT` и `toStreamErrorText`; чистая, без логирования и `as` → **Y**. `stream-error-text.spec.ts`: одна `it.each`-таблица из трёх строк (`new Error('boom')` → `'Agent error'`, `statusCode: 529` → `'Model provider error (529)'`, `'x'` → `'Agent error'`) → **Y**.
  - `maskToolErrorText` (`thread.mapper.ts`): маскирует части `tool-*` и `dynamic-tool` только в `output-error`, копией (`{ ...part, errorText }`), прочее — без изменений → **Y**. Unit-кейсы на `toEqual` с литералами (`tool-failing`, `dynamic-tool` → `'Agent error'`; `tool-getWeather` `output-available`, `text`, `reasoning`, user-сообщение — без изменений) → **Y**.
  - `listMessages`: `getOwnedThread` → `recall(perPage:false, createdAt ASC)` → `toAISdkMessages(v7)` → `ThreadMessagesResponseSchema.parse` → `maskToolErrorText` → **Y**. `onError`: `logger.error(..., error)` с `unknown`, `return toStreamErrorText(error)` → тексты клиента не изменились.
  - e2e AC-14.1: литерал `errorText: 'Agent error'` → **Y**. Сравнение: `comparable()` исключает ровно `step-start`, все `providerMetadata` (рекурсивно), `reasoning.id`, `text.state`; остальные поля — `toEqual` → **Y**. `tool-failing.errorText` = `'Agent error'` в стриме и истории; `rawMessageContents` (`db.ts`) содержит `"errorText":"boom"`; тело `/messages` не содержит `boom` → **Y**.
  - **Gate G: пройден** — e2e сравнения зелёный. Мутационная проверка: без `maskToolErrorText` в `listMessages` падают AC-14.1 и сравнение (код восстановлен).
  - Окружение: порт 5432 занят контейнером `timescaledb` другого проекта (пароль `agent` не подходит); `infra-postgres-1` поднят с `POSTGRES_PORT=5433`, e2e запущены с `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os` (env имеет приоритет над `apps/api/.env`). `.env` и compose не менялись.

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать все Investigation Targets, записать наблюдения в Investigation Notes (первый прогон)
- [x] Просмотреть deliverables зависимостей (см. Metadata)
- [x] Сверить контракты (Reference Contracts) с Design Doc, записать план подхода в Investigation Notes (первый прогон)
- [x] Написать падающее e2e первого прогона: сравнение «стрим ↔ история» (Gate G красный по старому правилу)
- [x] Перечитать обновлённые Investigation Targets (DD v1.7: Общий текст ошибки стрима, `maskToolErrorText`, Output Comparison), дополнить план подхода
- [x] Unit (test-first): `stream-error-text.spec.ts` — одна таблица из трёх строк; `thread.mapper.spec.ts` — кейсы `maskToolErrorText` (`tool-failing` и `dynamic-tool` → `'Agent error'`; `tool-getWeather` `output-available`, `text`, `reasoning` — без изменений, `toEqual` с литералами); убедиться, что падают
- [x] e2e `threads.e2e-spec.ts`: литерал `tool-failing` в `AC-14.1` меняется с `errorText: 'boom'` на `errorText: 'Agent error'`; сравнение переименовать в `AC-14.1/AC-14.5 (output comparison): history equals the live v7 stream under the Output Comparison rule`, правило — исключены `step-start`, `providerMetadata`, `reasoning.id`, `text.state`; добавить проверку `'boom'` в `mastra_messages` через `db.ts`; убедиться, что падают

### 2. Green Phase
- [x] `stream-error-text.ts`: `AGENT_ERROR_TEXT`, `toStreamErrorText`
- [x] `ChatController.chat` `onError`: `logger.error` с `unknown` + `return toStreamErrorText(error)`
- [x] `maskToolErrorText` в `thread.mapper.ts`; `listMessages`: `parse` → `maskToolErrorText`
- [x] Запустить только добавленные тесты, убедиться, что они проходят; **гейт G** — e2e сравнения зелёный; при красном — СТОП (см. Decisions), не править продукт ради прохождения и не менять тест на `it.skip`/`it.todo`
- [x] Передать исход гейта G оркестратору (запись в Notes плана — в T2.4)

### 3. Refactor Phase
- [x] Улучшить код, не меняя поведения
- [x] Повторно запустить добавленные тесты

### 4. Gates (все — ноль ошибок; перед vitest после правки `packages/contracts` — `pnpm --filter @agent-os/contracts build`; перед e2e — `pnpm db:up` и `apps/api/.env` с `DATABASE_URL`)
- [x] `pnpm --filter api lint` (первый прогон; повторить после изменений)
- [x] `pnpm --filter api exec tsc --noEmit -p tsconfig.json` (первый прогон; повторить)
- [x] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`
- [x] `pnpm --filter api test` (первый прогон; повторить)
- [x] `pnpm --filter api test:e2e` (включая `app.e2e-spec.ts` без правок)
- [x] `pnpm --filter api build` (первый прогон; повторить)

## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов, типовые ошибки — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext`, `.js`-суффиксы импортов — Enforces: строгие типы, без `as`-обхода (в т. ч. в `onError` и `listMessages`) — Config/Source: `apps/api/tsconfig.json`, `packages/contracts/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest unit / e2e (реальный Postgres) — Enforces: поведение и AC — Config/Source: `apps/api/vitest.config.ts`, `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- `nest build` — Enforces: сборка production-кода — Config/Source: `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json` — Type: `executable_check`
- Единый модуль `stream-error-text.ts` — Enforces: тексты ошибок стрима и истории не расходятся при будущей правке одного пути — Config/Source: DD «Risks», e2e сравнения — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: e2e на реальном Postgres с mock-моделью ассистента (reasoning + успешный и падающий инструмент); сборка `UIMessage` из SSE через `readUIMessageStream`; сравнение с `/messages` по правилу Output Comparison.
- **Success criteria (EVP)**: ответ проходит `ThreadMessagesResponseSchema` и `safeValidateUIMessages`; части совпадают с литералами; чужой и несуществующий id дают одинаковый 404; сравнение со SSE-стримом совпадает полностью по правилу Output Comparison, `errorText` — `'Agent error'` с обеих сторон, в `mastra_messages` — `'boom'` (**гейт G**).
- **Failure response (G)**: потеря данных или расхождение вне правила Output Comparison — остановиться, зафиксировать и вынести пользователю как изменение PRD; собственный конвертер не писать без согласования.
- **Verification level**: L2.

## Proof Obligations
### Obligation: Verification Strategy (б) — Output Comparison и AC-14.5
- **Claim**: история, возвращаемая `/messages`, эквивалентна живому стриму v7 по типам и содержимому частей `text`, `reasoning`, `tool-*`, включая замаскированный `errorText`; сырой текст ошибки не раскрывается.
- **Primary failure mode**: `stream-error-text.spec.ts` обязан упасть, если ошибка без `statusCode` даёт не `'Agent error'`; кейсы mapper — если маскируется часть не в `output-error` или пропущен `dynamic-tool`; e2e сравнения — если `listMessages` не маскирует (`'boom'` в истории), если `onError` и история расходятся в тексте, или если сравнение исключает поля сверх правила.
- **Boundary to exercise**: HTTP: SSE `POST /api/chat/assistant` против `GET /api/threads/:id/messages`; unit `stream-error-text.spec.ts`, `thread.mapper.spec.ts`; чтение `mastra_messages` через `db.ts`.
- **State assertion**: в `mastra_messages` той же беседы `toolInvocation.errorText` = `'boom'`, в стриме и истории — `'Agent error'`.
- **Mock boundary rationale**: мокается только модель.
- **Residual**: элементы `loss_risk: low`, зафиксированные Design Doc.

## Completion Criteria
- [x] Unit `stream-error-text.spec.ts` и `thread.mapper.spec.ts` зелёные
- [x] e2e AC-14.1 (литерал `'Agent error'`) и сравнение со стримом (Gate G) зелёные; `it.todo` этих кейсов закрыты
- [x] Исход гейта G передан оркестратору (в Notes плана записывается в T2.4); при красном — стоп и эскалация (`escalation_needed`, T2.4 и Phase 3 не начаты, красный кейс не заглушён)
- [x] `app.e2e-spec.ts` проходит без правок
- [x] lint/tsc/prettier/unit/e2e/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: G пройден; Phase 3 и Phase 4 (включая T4.1) открываются только после T2.3 (G) и T2.5 (G3). Переименование `maskToolErrorText` → `maskHistoryErrors` и удаление частей `error` — в T2.5; потребители имени (`threads.service.ts`, `thread.mapper.spec.ts`) правятся там.
- Scope boundary: продуктовый код меняется только в `common/stream-error-text.ts`, `onError` в `chat.controller.ts`, `maskToolErrorText` в `thread.mapper.ts` и `listMessages` в `threads.service.ts`; прочий код контроллера (проверка беседы — T5.1, `onFinish` — T4.3) и `apps/api/test/app.e2e-spec.ts` не меняются. Файл плана T2.3 не правит (Notes ведёт T2.4).
