---
feature: model-providers
part: core
design: design-core.md
plan: 1 of 1
status: completed
temporary: true
---

# Work Plan: Провайдеры моделей — core

Created Date: 2026-11-20
Type: feature

## Snapshot

**Overview.** План переводит вызовы моделей с переменных окружения на провайдеров в базе. Порядок: контракты и база, затем пакет `agents` (реестр, адаптеры трёх видов, путь чата, старт), служба эмбеддингов, маршруты и посев в `apps/api`, опоры тестов и семь интеграционных проверок, один quality gate. Подход гибридный: снизу вверх по слоям (`contracts` → `db` → `common` → `agents` → `apps/api`), потому что каждый слой компилируется только против нижнего, а внутри `agents` — вертикально по пути вызова (реестр → адаптер → `ModelClient` → старт). Правило владельца: задачи пишут тесты, но не запускают их; коммитов нет; единственный gate — финальная фаза.

- **Не меняется**: права, квоты и журнал затрат (схема `runtime_model_calls`), повторы и учёт прерванной попытки, поток текста и остановка, шов `AgentTurnModelClient`; экраны панели и выбор модели (часть `web`). Веб получает только правки, без которых он не компилируется (Task 1.2).
- **Главный риск**: ключ, заданный во время работы, попадает в лог мимо маски. Память секретов строит Task 1.4, пополняют её Task 2.1 и Task 4.4, доказывает INT-2 (Task 5.4).
- **Открытые вопросы**: один, сборку не блокирует — `missingRights` и правило сохранения для записи с моделью `null` (Notes, пункт 6).
- **Design items no task covers**: нет.

## Implementation Phases

Каждая задача: реализация, тесты, которые она пишет (без запуска), и не больше одной проверки типов своего пакета. Перед проверкой типов собираются зависимости пакета (`pnpm turbo build --filter=<пакет>^...`): пакеты читают друг друга из `dist`. Этот фильтр не пересобирает сам пакет, а тесты `agents` и `workflows` импортируют `@agent-os/agents` и `@agent-os/agents/testing` из `dist`, поэтому проверка, которая читает свежий `agents`, собирает его явно (`--filter=@agent-os/workflows^...` собирает и `agents`). Пока пакет-зависимость не компилируется (таблица ниже), сборка через него не запускается, а файлы задачи в верхнем пакете проверяет первая задача, где сборка проходит. Коммитов нет, изменения копятся в рабочем дереве основной копии; worktree, stash и reset не используются. Задачи идут по одной: проверка одной задачи собирает `contracts` и `db`, которые правит другая.

**Когда пакет снова компилируется целиком.** Task 1.1 меняет общие контракты, и несколько пакетов временно не компилируются. До указанной задачи проверка звучит как «нет ошибок `tsc` в файлах этой задачи»; начиная с неё — «пакет без ошибок».

| Пакет | Чисто с задачи | Почему не раньше |
|---|---|---|
| `@agent-os/contracts` | 1.1 | — |
| `web` | 1.2 | id модели, каталог, `null` у модели записи |
| `@agent-os/db`, `@agent-os/common` | 1.3, 1.4 | — |
| `@agent-os/agents`, `@agent-os/workflows` | 2.5 | модель записи `null` читает снимок (Task 2.5) |
| `@agent-os/runtime` | 3.1 | — (меняется только константа) |
| `api` | 5.3 | каталог-объединение, `null` у модели записи, удалённые настройки; опоры `test/` (в `tsconfig` пакета) до Task 5.3 разбирают каталог старой схемой и зовут `builtinRecords(arg)`. Файлы `api` задач 1.4 и 2.4 впервые проверяются в Task 4.1 |

### Phase 1: Контракты, веб на новых контрактах, база, память секретов
**Purpose**: Положить все формы и причины в `packages/contracts`, сразу вернуть вебу компиляцию, создать таблицы и дать процессу общую память секретов.

#### Tasks

- [x] **Task 1.1: Контракты: id модели, провайдеры, каталог, модели по умолчанию, причины, `null` у модели записи** — covers DD KD-4, Contract Definitions (таблица «Где изменения ложатся в `packages/contracts/src`» целиком, `ModelProviderView`, `ModelProviderCheck`, `CatalogModel`, `ModelDefaults`, Error handling), DC-1, DC-2 (схема), DC-5 (причина), FR-01, FR-05, ADR-0018
  - `model-providers.ts` (new, по образцу `mcp.ts`): `ModelProviderNameSchema` (строчные латинские буквы, цифры, дефис, до 32, с буквы или цифры), `MODEL_PROVIDER_NAME_MAX_LENGTH = 32`, `MODEL_PROVIDER_API_KEY_MIN_LENGTH = 8`, `MODEL_PROVIDER_API_KEY_MAX_LENGTH = 512`, `ModelProviderKindSchema` (`anthropic`, `gemini`, `openai_compatible`), `ModelProviderViewSchema` (с `keyRequired`, `state`, `catalogModels`), `ModelProviderCheckSchema`, `CreateModelProviderBodySchema`, `UpdateModelProviderBodySchema` (`apiKey: null` — убрать ключ, `baseUrl: null` — адрес вида), `ModelProviderErrorCode`.
  - `access.ts`: `ModelIdSchema` — первая часть по `ModelProviderNameSchema`, после первой косой черты непустое имя без пробелов, косая черта в имени допустима; `modelProvider(id)`; `CatalogModelSchema` — своя схема ответа, объединение по `purpose` с `provider`; `CreateCatalogModelBodySchema` — объединение по `purpose`; `UpdateCatalogModelBodySchema` получает `inputUsdPerMTok` (строгий объект, хотя бы одно поле; назначение проверяет сервис); `ModelDefaultsSchema`, `UpdateModelDefaultsBodySchema`; `AccessErrorCode` + `MODEL_PROVIDER_INVALID`, `MODEL_DEFAULT_INVALID`; `ModelProviderInvalidReasonSchema`, `ModelDefaultInvalidReasonSchema`, `ModelDefaultInvalidErrorSchema` (несёт `model`); `GrantInvalidReasonSchema` + `embedding_model`; `MyModelSchema.unavailableReason` (обязательное, `ModelUnavailableReasonSchema` или `null`). `type CatalogModel` теперь от `CatalogModelSchema`, а не псевдоним тела.
  - `agents.ts`: `ToolRefusalReasonSchema` + `model_not_configured`, `provider_missing`, `provider_disabled`, `provider_key_missing`; `AgentFailureReasonSchema` + шесть `provider_*`. `threads.ts`: `StartRefusedErrorSchema.reason` берёт и эти четыре (`model` уже `nullable`). `library.ts`: `LibraryChoicesSchema.defaultModel`, модель агента, координатора и исполнителя — `ModelIdSchema.nullable()`.
  - Комментарий у `ModelIdSchema` про `AGENT_DEFAULT_MODEL` удаляется.
  - Target Files: `packages/contracts/src/model-providers.ts` (new), `packages/contracts/src/model-providers.spec.ts` (new), `packages/contracts/src/access.ts`, `packages/contracts/src/access.spec.ts`, `packages/contracts/src/agents.ts`, `packages/contracts/src/threads.ts`, `packages/contracts/src/library.ts`, `packages/contracts/src/index.ts`.
  - Не трогает: `identity.ts` (`ProviderView`, `CreateProviderBody` — провайдеры входа).
  - Dependencies: нет.
  - Тесты: `model-providers.spec.ts` — одна таблица: имя (`Google` и `-x` и 33 знака — нет, `local-2` — да), ключ 7 и 513 знаков — нет, 8 и 512 — да, `apiKey: null` в изменении — да (DC-1, DC-2). В таблице каталога `access.spec.ts` строки id заменяются: `anthropic/a/b` и `local/Qwen/Qwen3-32B` теперь верны, `Foo/x`, `x`, `a/` и `a/b c` — нет, `modelProvider('local/Qwen/Qwen3-32B')` — `local` (ADR-0018). Новых тестов сверх этих строк нет.
  - Проверка: `pnpm --filter @agent-os/contracts typecheck`. Ревьюер читает: каждая строка таблицы дизайна «Где изменения ложатся» есть в diff; ни одно имя не совпадает с именами `identity.ts`.

- [x] **Task 1.2: Веб компилируется на новых контрактах (без новой видимой работы)** — covers DD Contract Definitions «Для части `web`» (сторона потребителя, минимум), Sibling parts
  - Только правки, без которых `web` не компилируется или его нынешние тесты падают. Экраны провайдеров, моделей по умолчанию, пометки готовности, фильтр моделей чата и тексты новых отказов в чате — часть `web`.
  - `lib/agents/format.ts`: шесть записей `provider_*` в `NAMED_FAILURE_REASON` (слова причин — `uxrd.md` MC-9); `formatModel` принимает `null` и отдаёт подпись «модель по умолчанию».
  - `lib/admin/admin-api.ts`: `list`, `create`, `update` каталога разбирают ответ `CatalogModelSchema`; `CatalogModelListSchema` и комментарий «своей схемы нет» удаляются.
  - `components/admin/models/model-dialog.tsx`: `valuesOf` сужает по `purpose === 'chat'`; `bodyOf` для создания добавляет `purpose: 'chat'`.
  - `components/admin/models/catalog-section.tsx`: `toRow` сужает по `purpose`; у модели эмбеддингов ячейки цен — прочерк.
  - `components/library/agent-fields.tsx`: `EditorChoices.defaultModel: string | null`; `ModelField` и текстовые функции принимают `null`. `components/library/record-editor.tsx:339`: `?? undefined`.
  - `lib/admin/admin-texts.ts:48`: `modelIdFormat` — «ID — в виде <провайдер>/<имя>».
  - Тесты и фикстуры: `test/fixtures.ts` `catalogModel` разбирает `CatalogModelSchema` и ставит `purpose: 'chat'` и `provider`; `components/shell/enterprise-access-admin.int.test.tsx:343` передаёт `provider: modelProvider(body.id)`; `lib/access/access-texts.test.ts` и `components/account/models-section.test.tsx` — `unavailableReason: null`; `lib/admin/form-rules.test.ts:84-85` — строки под новую форму id и новый текст.
  - Target Files: `apps/web/src/lib/agents/format.ts`, `apps/web/src/lib/admin/admin-api.ts`, `apps/web/src/lib/admin/admin-texts.ts`, `apps/web/src/components/admin/models/model-dialog.tsx`, `apps/web/src/components/admin/models/catalog-section.tsx`, `apps/web/src/components/library/agent-fields.tsx`, `apps/web/src/components/library/record-editor.tsx`, `apps/web/src/test/fixtures.ts`, `apps/web/src/components/shell/enterprise-access-admin.int.test.tsx`, `apps/web/src/lib/access/access-texts.test.ts`, `apps/web/src/components/account/models-section.test.tsx`, `apps/web/src/lib/admin/form-rules.test.ts`. Если `tsc` назовёт ещё файл с той же причиной (`definition-view.tsx`, `executor-item.tsx`, `executor-panel.tsx`, `workflow-fields.tsx` компилируются, когда `formatModel` и `ModelField` принимают `null`), он входит в задачу той же правкой.
  - Не трогает: `components/shell/model-providers-web.int.test.tsx` (скелет части `web`), `lib/access/access-texts.ts`, `lib/library/library-errors.ts`, `tool-fallback.aui.tsx`, `grant-dialog.tsx`, `system-record-page.tsx`, `models-section.tsx` — они компилируются и остаются части `web`.
  - Dependencies: Task 1.1.
  - Проверка: `pnpm turbo build --filter=web^...`, затем `pnpm --filter web typecheck`. Ревьюер читает: нет новых экранов, текстов кроме MC-9 и `modelIdFormat`, нет копии правил `core` в вебе.

- [x] **Task 1.3: Таблицы `agent_model_providers`, `access_model_defaults`, назначение и размерность у `access_models`; миграция 0025** — covers DD KD-1, KD-4, KD-5, Data Model, Invariants 3 и 4 (база), DC-6 (база), ADR-0019
  - Pattern: [settings-row.md](../../../code-system/patterns/settings-row.md) (`access_model_defaults`), [write-only-secret.md](../../../code-system/patterns/write-only-secret.md) (столбец ключа как есть).
  - `agentModelProviders` по образцу `agentMcpServers`: `name` text PK; `kind` text, CHECK через `isOneOf(t.kind, ModelProviderKindSchema.options)`; `base_url` text null; `api_key` text null; `enabled` boolean default true; `created_at`, `updated_at`.
  - `accessModels` + `purpose` text not null default `'chat'`, CHECK через `isOneOf` по `chat`/`embedding`; `dimensions` integer null; CHECK: у `embedding` размерность от 1 до 4096 и нет цен длинного контекста, у `chat` размерности нет. Существующие строки становятся `chat` без переписывания.
  - `accessModelDefaults`: `id` boolean PK default true с CHECK `id`; `chat_model`, `embedding_model` — text null, внешний ключ на `access_models.id` с `ON DELETE SET NULL` (удаление модели снимает выбор, DC-6); `updated_at`, `updated_by` null.
  - Миграция: `pnpm --filter @agent-os/contracts build` (drizzle-kit читает `contracts` из `dist`), затем `pnpm db:generate`; в конец сгенерированного SQL дописывается `INSERT INTO "app"."access_model_defaults" ("id") VALUES (true);` — как строка `library_settings` в `0024_ancient_scarlet_witch.sql`. Миграция только добавляет, поэтому вопроса drizzle-kit «создана или переименована» нет.
  - Тест миграций: `APP_TABLES` + `access_model_defaults`, `agent_model_providers`; карта доменов CHECK + `agent_model_providers_kind_check: sorted(ModelProviderKindSchema.options)` и `access_models_purpose_check`.
  - Target Files: `packages/db/src/schema.ts`, `packages/db/migrations/0025_*.sql` (generated + INSERT), `packages/db/migrations/meta/_journal.json`, `packages/db/migrations/meta/0025_snapshot.json` (generated), `packages/db/test/migrations.e2e-spec.ts`.
  - Не запускать: `pnpm db:migrate` и любые e2e — миграцию на базу разработчика применяет только quality gate.
  - Dependencies: Task 1.1.
  - Проверка: `pnpm turbo build --filter=@agent-os/db^...`, затем `pnpm --filter @agent-os/db typecheck`. Ревьюер читает SQL: только `CREATE TABLE`, `ALTER TABLE … ADD COLUMN`, ограничения и одна вставка.

- [x] **Task 1.4: Память секретов процесса; маска Sentry** — covers DD KD-7 (маска), Contract «Внутри платформы» (`rememberSecret`), Invariant 2 (маска), Security Considerations (Sentry), FR-11 / AC-11.1 (половина Sentry)
  - Pattern: [logging.md](../../../code-system/patterns/logging.md).
  - `packages/common/src/logger.ts`: модульная память секретов — `rememberSecret(value)` кладёт значение, пустое и короче 8 знаков не кладёт; память только растёт. `createSecretMasker(secrets)` на каждом вызове скрывает и свой список, и всю память; `createLogger` получает это даром. Экспорт `rememberSecret` из `index.ts`.
  - Sentry: `beforeSend` в `apps/api/src/instrument.ts` выносится в функцию `maskSentryEvent` (`apps/api/src/logging/sentry-mask.ts`), которая прогоняет `exception.value` через `withoutQueryParamsText` и через `createSecretMasker([])`; `instrument.ts` её зовёт.
  - Target Files: `packages/common/src/logger.ts`, `packages/common/src/index.ts`, `apps/api/src/logging/sentry-mask.ts` (new), `apps/api/src/logging/sentry-mask.spec.ts` (new), `apps/api/src/instrument.ts`.
  - Dependencies: нет.
  - Тест: `sentry-mask.spec.ts` — одна таблица: ключ, запомненный после создания маски, и прежний ключ в тексте исключения заменены `[redacted]`; параметры запроса вырезаны, как раньше (AC-11.1, половина Sentry — её называет шапка скелета `apps/api`). Маску логгера доказывает INT-2.
  - Проверка: `pnpm --filter @agent-os/common typecheck`. Файлы `apps/api` этой задачи (`sentry-mask.ts`, `instrument.ts`) проверяет Task 4.1: до Phase 2 сборка зависимостей `api` падает на `agents`. Ревьюер читает: значение секрета нигде не логируется; память — один модульный `Set`.

#### Operational Verification Procedures

Выполняются после quality gate (правило владельца: проверок на концах фаз нет).

1. `pnpm db:migrate` на базе разработчика проходит; `psql … -c "\d app.agent_model_providers"` и `"\d app.access_model_defaults"` показывают таблицы; `SELECT * FROM app.access_model_defaults` — одна строка с пустыми моделями.
2. Строки `app.access_models` разработчика получили `purpose = 'chat'`, их права и квоты на месте.

### Phase 2: Пакет `agents` — реестр, адаптеры, путь чата, старт
**Purpose**: Сделать вызов модели независимым от вида: подключение провайдера из базы на каждом вызове, адаптер вида, причины сбоя значением, старт с моделью по умолчанию; удалить переменные окружения.

#### Tasks

- [x] **Task 2.1: Реестр `Agents.providers` и `providerReadiness`** — covers DD KD-1, KD-7 (пополнение памяти при чтении и записи), Terms «Готовность провайдера», Contract «Внутри платформы» (`Agents.providers`), Data Model, Invariants 1, 2, 5, DC-1, DC-2, AC-01.3 (правило удаления)
  - Pattern: [repository-over-transaction.md](../../../code-system/patterns/repository-over-transaction.md), [write-only-secret.md](../../../code-system/patterns/write-only-secret.md), [pure-decision.md](../../../code-system/patterns/pure-decision.md) (`providerReadiness`).
  - `provider-kinds.ts`: по виду — адрес по умолчанию (`https://api.anthropic.com/v1`, `https://generativelanguage.googleapis.com/v1beta`, `https://api.openai.com/v1`), `keyRequired` (`anthropic`, `gemini` — да; `openai_compatible` — нет), умеет ли эмбеддинги (`anthropic` — нет). Адаптеры Task 2.2 берут эти факты отсюда.
  - `provider-readiness.ts`: `providerReadiness(row | null)` — `missing`, `disabled`, `key_missing`, `ready`, в этом порядке, первое сработавшее.
  - `model-providers.repository.ts` по образцу `mcp-servers.repository.ts`: вставка (коллизия имени по первичному ключу → «имя занято»), правка, удаление, чтение по имени, список по имени.
  - `provider-registry.ts`: `list`, `get`, `create`, `update`, `remove({ name, catalogModels })` (при `catalogModels > 0` — отказ `MODEL_PROVIDER_HAS_MODELS` с `count`), `kindOf(name)`, `readiness(names)`, `connection(name)` (вид, адрес — заданный или вида, ключ — для `ModelClient` и эмбеддингов). Вид `ModelProviderView`: `apiKeySet`, `apiKeyLast4` (вычисляются при чтении), `effectiveBaseUrl`, `keyRequired`, `state`. Пишущая операция возвращает `{ view, before, after }`, где `apiKey` — `changed` при смене, иначе поля нет (`SECRET_MARK` реестра MCP). Каждое чтение строки с ключом и каждый принятый ключ сразу идут в `rememberSecret` — до любого лога.
  - Ошибки: `ModelProviderError` по образцу `McpError` с кодами `ModelProviderErrorCode`.
  - Лог каждой операции: имя, вид, какие поля изменились (без значений), исход, длительность.
  - `createAgents` отдаёт `providers: AgentsProviders`; `index.ts` экспортирует типы для `apps/api`.
  - Target Files: `packages/agents/src/providers/provider-kinds.ts`, `provider-readiness.ts`, `provider-readiness.spec.ts`, `model-providers.repository.ts`, `provider-registry.ts`, `model-provider-errors.ts` (все new, в `packages/agents/src/providers/`), `packages/agents/src/create-agents.ts`, `packages/agents/src/index.ts`.
  - Dependencies: Task 1.1, Task 1.3, Task 1.4.
  - Тест: `provider-readiness.spec.ts` — одна таблица `ready` / `missing` / `disabled` / `key_missing` по трём видам; выключенный без ключа — `disabled` (шапка скелета `agents`).
  - Проверка: нет ошибок `tsc` в файлах задачи (`pnpm turbo build --filter=@agent-os/agents^...`, затем `pnpm --filter @agent-os/agents typecheck`). Ревьюер читает: значение ключа не попадает ни в `view`, ни в `before`/`after`, ни в лог; `rememberSecret` стоит в чтении строки и в `create`/`update`.

- [x] **Task 2.2: Адаптеры трёх видов и проверка подключения; пакеты AI SDK** — covers DD KD-3, FR-15 / AC-15.1, DC-12, «Как разбирается ошибка провайдера» (признак инструментов), Risks «Gemini отклоняет схему инструмента MCP»
  - Сначала проверки риска (результаты — в Progress Tracking):
    1. Пакеты: `pnpm --filter @agent-os/agents add @ai-sdk/google@^4 @ai-sdk/openai-compatible@^3`; `pnpm why @ai-sdk/provider --filter @agent-os/agents` показывает одну мажорную версию 4 у всех трёх `@ai-sdk/*`. Иначе берутся версии на `@ai-sdk/provider` 4 явно.
    2. Чистка схем Gemini: прочитать, как `mastra-turn.ts` передаёт Mastra инструменты MCP (сырая JSON Schema), и где `@mastra/core` 1.83 зовёт слой `@mastra/schema-compat` (1.4.0) — `GoogleSchemaCompatLayer.shouldApply` смотрит `provider.includes('google')` или `gemini-` в id, а у модели `@ai-sdk/google` провайдер `google.generative-ai`. Если слой применяется к таким инструментам — адаптер ничего не делает. Если нет — адаптер Gemini сам прогоняет схемы через `GoogleSchemaCompatLayer`, а `@mastra/schema-compat` той же версии, что у `@mastra/core`, добавляется прямой зависимостью в этой задаче (резерв дизайна, Risks). Доказательство — INT-1 строка B на gate.
  - Адаптер (`ProviderAdapter`): `languageModel(connection, modelName)`, `cacheMark` (только Anthropic, `{ anthropic: { cacheControl: { type: 'ephemeral' } } }`), `embeddingModel` и параметры эмбеддинга (`inputType` → вид задачи Gemini; OpenAI-совместимый не передаёт; Anthropic — нет эмбеддингов), `toolsRejected(statusCode, body)` (Anthropic — сообщение начинается с `tools.`, Gemini — называет `function_declarations`, OpenAI-совместимый — `tools`), `checkRequest(connection)`. OpenAI-совместимый просит расход в потоке (`includeUsage`).
  - `provider-check.ts`: один запрос с сохранёнными адресом и ключом, таймаут 10 секунд; 2xx → `works`, 401/403 → `key_rejected`, иначе, сеть или таймаут → `unreachable`; `message` — статус и текст ответа до 500 знаков через `createSecretMasker([])`, `null` при `works`. Журнала и аудита нет. `Agents.providers.check(name)` зовёт его.
  - Target Files: `packages/agents/src/providers/adapters.ts`, `anthropic-adapter.ts`, `gemini-adapter.ts`, `openai-compatible-adapter.ts`, `adapters.spec.ts`, `provider-check.ts` (все new, в `packages/agents/src/providers/`), `packages/agents/src/providers/provider-registry.ts`, `packages/agents/package.json`, `pnpm-lock.yaml`.
  - Dependencies: Task 2.1.
  - Тест: `adapters.spec.ts` — одна таблица по видам: адрес по умолчанию, метка кеша только у Anthropic, параметры эмбеддинга (`inputType`), признак «инструменты не приняты» на записанном теле ошибки каждого вида, запрос проверки и отображение 200 / 401 / молчание → `works` / `key_rejected` / `unreachable` (AC-15.1, DC-12; таймаут — подставным коротким значением или поддельными таймерами).
  - Проверка: нет ошибок `tsc` в файлах задачи (`pnpm --filter @agent-os/agents typecheck`). Ревьюер читает: всё, что зависит от вида, — только в файлах адаптеров; заголовки запроса не логируются.

- [x] **Task 2.3: `ModelClient` берёт подключение у реестра; причины сбоя значением; `completeText` на модели по умолчанию** — covers DD KD-2, C4 «вызов модели чата» шаги 2 и 5, «Как разбирается ошибка провайдера», Flow 1 (Failure handling), Contract `ModelClient.call`, `completeText`, `AccessGate.defaultChatModel`, `AccessGate.embedding` (порт), DC-3 (`completeText`), DC-10, DC-11, Invariant 6, AC-04.2, AC-09.2, AC-09.3, AC-09.4, AC-09.5
  - `access-gate.ts`: порт получает `defaultChatModel(): Promise<string | null>` и `embedding(ownerId | null)` → `allowed` (`model`, цена ввода, `dimensions`) или `refused` (`owner_disabled`, `model_not_configured`). `createAccessGateDouble` в `testing.ts` получает опции `defaultChatModel` и `embedding` с умолчаниями, при которых нынешние вызовы компилируются. Там же — двойник реестра `createProviderRegistryDouble` (`connection` и `readiness` отвечают «готов» для названных провайдеров, остальные — `missing`); его берут `model-client.spec.ts`, `access-gate.spec.ts`, `resolve-start.spec.ts` (это двойник реестра из Building-block Inventory).
  - `retry-policy.ts`: `classifyRejection(error, adapter)` → статус, `retryable` и причина по таблице дизайна: 401/403 — `provider_key_rejected`, без повтора; 400/422 с признаком адаптера — `provider_tools_rejected`, без повтора; 408, 429, 5xx, сеть, таймаут — повтор до двух, паузы 1 и 3 секунды, затем `provider_unavailable`; прочее — `model_error`. Тело ответа берётся из ошибки AI SDK.
  - `model-client.ts`: после вердикта `AccessGate` — `providers.connection(modelProvider(model))` и `providerReadiness`; не готов → `model_error` с причиной `provider_missing` / `provider_disabled` / `provider_key_missing` без запроса и без строки журнала (DC-10: не пишет `access_denied`). Подключение уходит шву в `AgentTurnCall`. `ModelError` получает `reason`. Лог отказа провайдера: `provider`, `reason`, `statusCode`, `responseBody` (через маску). Ответ без числа входных токенов — оценка, как прерванная попытка, `estimated: true` в логе (DC-11). `completeText` берёт модель из `access.defaultChatModel()`; `null` → отказ `ModelNotConfiguredError` с причиной `model_not_configured`. `ModelClientDeps.config` больше не несёт `defaultModel`.
  - `step/model-step.ts`, `step/compaction-step.ts`: причина сбоя — `reason` из `model_error` как есть; сообщение — модель, провайдер, причина, без тела ответа.
  - Target Files: `packages/agents/src/access-gate.ts`, `packages/agents/src/model/retry-policy.ts`, `packages/agents/src/model/retry-policy.spec.ts` (new), `packages/agents/src/model/model-client.ts`, `packages/agents/src/model/model-client.spec.ts`, `packages/agents/src/model/mastra-turn.ts` (только тип `AgentTurnCall` + подключение), `packages/agents/src/step/model-step.ts`, `packages/agents/src/step/compaction-step.ts`, `packages/agents/src/testing.ts`, `packages/agents/src/create-agents.ts` (проводка `providers` в `createModelClient`), `packages/agents/src/access-gate.spec.ts`.
  - Dependencies: Task 2.2.
  - Тесты: `retry-policy.spec.ts` (new) — одна таблица над `createModelClient` с двойником шва, бросающим ошибку формы `AI_APICallError`: статус и тело × число попыток × причина × строка журнала × `responseBody` в логе (AC-04.2, AC-09.3 — нет строки журнала, AC-09.5, признак инструментов каждого вида). Строки повтора в `model-client.spec.ts`, которые этот стол повторяет, удаляются; остальные строки правятся под новые зависимости (реестр — двойник с готовым провайдером).
  - Проверка: нет ошибок `tsc` в файлах задачи (`pnpm --filter @agent-os/agents typecheck`). Ревьюер читает: порядок «права → готовность → запрос»; отказ провайдера не зовёт `audit`; `not_started` по-прежнему только у отказа `AccessGate`.

- [x] **Task 2.4: Клиент хода над адаптерами; переменные окружения удалены** — covers DD KD-1 (удаление), KD-3, C4 шаг 3, FR-02 (удаление), Building-block `createMastraTurnClient` (extended), Contract «`createAgents` опции `secrets` не имеет»
  - `mastra-turn.ts`: `createMastraTurnClient()` без аргументов берёт адаптер по `call.connection.kind`, модель AI SDK и метку кеша; метка на системный блок и последнее сообщение — только если адаптер её дал. Удаляются `ResolveModel`, `createResolveModel`, `AnthropicSettings`, `ANTHROPIC_PREFIX`, `CACHE_MARK` (переехал в адаптер Anthropic) и их экспорт из `index.ts`.
  - `config.ts`: из схемы и `AgentsConfig` удаляются `AGENT_DEFAULT_MODEL`, `ANTHROPIC_API_KEY`, `AGENTS_ANTHROPIC_BASE_URL`, `MODEL_ID_PATTERN`, `secretValuesOf`. `create-agents.ts`: маска `run_code` — `createSecretMasker([])` (только память).
  - `apps/api`: `agents.module.ts` — `AGENT_TURN_CLIENT` = `createMastraTurnClient()`, логгер — `createAppLogger(process.env)`; `agents-settings.ts` — три имени из `AGENTS_VARIABLES` удаляются; `logging/app-logger.ts` — `ANTHROPIC_API_KEY` из `collectSecrets` удаляется. `.env.example` и README — три переменные и их описания удаляются, вместо них — «провайдеры и ключ задаются посевом `seed:access` или в панели».
  - Тестовые вызовы, которые ломает удаление (правило «каждый вызывающий в той же задаче»): `packages/agents/test/support/agentsHarness.ts:288` (логгер без `secretValuesOf`).
  - Target Files: `packages/agents/src/model/mastra-turn.ts`, `packages/agents/src/model/mastra-turn.spec.ts`, `packages/agents/src/config.ts`, `packages/agents/src/config.spec.ts`, `packages/agents/src/create-agents.ts`, `packages/agents/src/index.ts`, `packages/agents/test/support/agentsHarness.ts` (одна строка), `apps/api/src/agents/agents.module.ts`, `apps/api/src/agents/agents-settings.ts`, `apps/api/src/logging/app-logger.ts`, `apps/api/.env.example`, `apps/api/README.md`, `README.md`.
  - Не трогает: `packages/code-runner/test/executor-process.e2e-spec.ts:46` — `ANTHROPIC_API_KEY` там значение-приманка, по которому тест проверяет, что исполнитель не наследует окружение родителя; настройку он не читает.
  - Dependencies: Task 2.3.
  - Проверка: нет ошибок `tsc` в файлах задачи пакета `agents` (`pnpm --filter @agent-os/agents typecheck`); файлы `apps/api` этой задачи проверяет Task 4.1 (до неё `api` читает старый `dist` пакета `agents`). Ревьюер читает: `grep -rn "ANTHROPIC_API_KEY\|AGENTS_ANTHROPIC_BASE_URL\|AGENT_DEFAULT_MODEL\|createResolveModel\|secretValuesOf" apps packages --include=*.ts --include=*.example --include=*.md` находит только `executor-process.e2e-spec.ts`, комментарии скелетов и места Task 4.3 / Phase 5.

- [x] **Task 2.5: Старт: модель `null` → модель чата по умолчанию; готовность провайдера; четыре причины отказа** — covers DD KD-2 (старт), KD-5, Contract «Отказ старта», DC-3 (старт), DC-7, AC-02.1, AC-09.1, ADR-0017
  - Pattern: [run-snapshot.md](../../../code-system/patterns/run-snapshot.md), [pure-decision.md](../../../code-system/patterns/pure-decision.md).
  - `resolve-start.ts`: строя снимок, заменяет `null` в модели агента, координатора и каждого исполнителя на `access.defaultChatModel()`; нет модели по умолчанию, а заменять нужно — отказ `model_not_configured` с `model: null`. Затем, как сегодня, вердикт `access.model` у модели самой записи; затем `providerReadiness` её провайдера → отказ `provider_missing` / `provider_disabled` / `provider_key_missing` с моделью. Исполнители и форки берут модель из снимка, идущий запуск смену не видит.
  - `snapshot.ts`: `RunSnapshotSchema` держит модель агента, координатора и исполнителя как `ModelIdSchema` (не `nullable`): в снимке `null` уже заменён. `snapshot-definition.ts`: модель — строка, как сегодня.
  - `create-agents.ts`: реестр провайдеров входит в `startDeps` (`StartDeps` в `resolve-start.ts`), откуда его берут `agent-sessions` и `start_agent`. Спецификации берут двойник реестра из `testing.ts` (Task 2.3).
  - Отказ доходит до `AgentsError('START_REFUSED')` (`operations/agent-sessions.ts`) и до исхода `refused` инструментов `start_agent` (`tools/builtin/start-agent.ts`) и `start_workflow` (`packages/workflows/src/start-workflow.tool.ts`) с моделью в `refusalDetail`.
  - Аудит `access_denied` пишется только для отказа `AccessGate`, не для четырёх новых причин (DC-10).
  - Target Files: `packages/agents/src/start/resolve-start.ts`, `packages/agents/src/start/resolve-start.spec.ts`, `packages/agents/src/start/snapshot.ts`, `packages/agents/src/create-agents.ts`, `packages/agents/src/start/snapshot-definition.ts`, `packages/agents/src/start/snapshot-definition.spec.ts`, `packages/agents/src/operations/agent-sessions.ts`, `packages/agents/src/tools/builtin/start-agent.ts`, `packages/agents/src/errors.ts`, `packages/workflows/src/start-workflow.tool.ts`, `packages/workflows/src/start-workflow.spec.ts`.
  - Dependencies: Task 2.3.
  - Тестов новых нет: старт с отказами доказывает INT-4, модель по умолчанию в снимке — INT-7. Строки существующих spec правятся только чтобы компилироваться (двойник гейта отдаёт модель по умолчанию).
  - Проверка: `pnpm turbo build --filter=@agent-os/workflows^...` (собирает и `agents`), затем `pnpm --filter @agent-os/agents typecheck` и `pnpm --filter @agent-os/workflows typecheck` — оба пакета без ошибок. Ревьюер читает: замена `null` — только в построении снимка, ни на одном вызове модели.

#### Operational Verification Procedures

Выполняются после quality gate.

1. `pnpm why @ai-sdk/provider --filter @agent-os/agents` — одна мажорная версия 4.
2. Решение о чистке схем Gemini (Task 2.2, проверка 2) записано в Progress Tracking и совпадает с кодом адаптера.

### Phase 3: Служба эмбеддингов
**Purpose**: Дать функциям платформы векторы на модели эмбеддингов по умолчанию, с учётом на сотрудника или на платформу и отказом значением.

#### Tasks

- [x] **Task 3.1: `Agents.embeddings`, шов `EmbeddingClient`, `PLATFORM_OWNER_ID`** — covers DD KD-6, C4 «эмбеддинги», Flow 2, Contract `Agents.embeddings.embed`, `Agents.embeddings.model`, `PLATFORM_OWNER_ID`, DC-8, DC-9, DC-11, Invariant 6, AC-06.3, AC-07.1–AC-07.5 (служба), AC-08.1–AC-08.3 (служба)
  - Pattern: [composition-root.md](../../../code-system/patterns/composition-root.md) (шов как опция `createAgents`).
  - Проверка риска первой: `pnpm --filter @agent-os/agents add ai@<версия, которую линкует @mastra/core 1.83>` (`pnpm why ai --filter @agent-os/agents`; в хранилище 7.0.148 и 7.0.155, `embedMany` подтверждён в 7.0.155); `embedMany` экспортирован. Если нет — `EmbeddingClient` зовёт `doEmbed` модели эмбеддингов пакета провайдера напрямую, без `ai` (резерв внутри шва, контракт не меняется). Результат — в Progress Tracking.
  - `packages/runtime`: `PLATFORM_OWNER_ID = 'platform'` в `token-ledger.ts` (или рядом) и экспорт из `index.ts`.
  - `embeddings/embedding-client.ts`: интерфейс шва (`embed({ connection, modelName, texts, inputType, dimensions, signal })` → векторы и число входных токенов или `null`) и настоящий клиент над адаптером вида; таймаут 30 секунд.
  - `embeddings/embeddings.ts`: `embed` — `access.embedding(ownerId)` → отказ значением `model_not_configured` / `owner_disabled` без запроса; подключение и `providerReadiness` → отказ причиной готовности; пачки по 100 по очереди, повторы и причины — `classifyRejection` (`provider_error` вместо `model_error`); после каждой пачки — строка журнала на `ownerId ?? PLATFORM_OWNER_ID` по цене ввода, нули в остальных ставках, оценка по байтам без числа токенов с `estimated` в логе; длина вектора ≠ `dimensions` → `dimension_mismatch` (строка этой пачки уже записана); вектор приводится к единичной длине; пустой список — ответ без запроса. Отказ по `signal` — единственный не значением. `model()` — модель и размерность без запроса. Логи начала, пачки и итога — по разделу «Логирование».
  - `createAgents` получает опцию `embeddingClient?` (по умолчанию настоящий) и отдаёт `embeddings`. `testing.ts`: `createScriptedEmbeddings()` — записывает каждый запрос (тексты, модель, ключ), отвечает векторами нужной длины и числом токенов, переключатели «без числа токенов» и «вектор другой длины».
  - Target Files: `packages/runtime/src/token-ledger.ts`, `packages/runtime/src/index.ts`, `packages/agents/src/embeddings/embedding-client.ts`, `packages/agents/src/embeddings/embeddings.ts`, `packages/agents/src/embeddings/embeddings.spec.ts` (все три new), `packages/agents/src/create-agents.ts`, `packages/agents/src/index.ts`, `packages/agents/src/testing.ts`, `packages/agents/package.json`, `pnpm-lock.yaml`.
  - Dependencies: Task 2.5.
  - Тест: `embeddings.spec.ts` — одна таблица над службой с двойником шва, двойником гейта и двойником журнала: порядок, длина, единичная длина (AC-07.1, DC-8); `model_not_configured` без запроса (AC-07.2); 503 после повторов → `provider_unavailable`, тело в логе (AC-07.3); `dimension_mismatch` со строкой журнала пачки (AC-07.4); сменённая модель по умолчанию — та, что вызвана (AC-06.3); 101 текст → две пачки, пустой список → нет запроса (DC-9); без числа токенов → оценка и `estimated` (DC-11).
  - Проверка: `pnpm turbo build --filter=@agent-os/agents^...`, затем `pnpm --filter @agent-os/agents typecheck`. Ревьюер читает: служба не бросает, кроме `signal`; права и квоты не читаются.

#### Operational Verification Procedures

Интеграционную проводку (журнал, месячный расход, квота) проверяет INT-5 на gate.

### Phase 4: `apps/api` — каталог, маршруты, библиотека и чат, посев
**Purpose**: Открыть маршруты провайдеров, каталога и моделей по умолчанию, перевести библиотеку и чат на модель по умолчанию из базы, научить посев провайдерам.

#### Tasks

- [x] **Task 4.1: `AccessService`: назначение моделей, правила каталога, модели по умолчанию, вопросы порта** — covers DD KD-4, KD-5, KD-6 (порт), Contract «Правила каталога», `PUT /api/admin/model-defaults`, `POST /api/admin/grants` (`embedding_model`), `GET /api/access/models` (сервис), `AccessGate.defaultChatModel`, `AccessGate.embedding`, `AccessGate.model` на эмбеддинг, Invariants 3, 4, DC-5, DC-6, AC-05.1, AC-05.2, AC-05.3, AC-06.2
  - Pattern: [pure-decision.md](../../../code-system/patterns/pure-decision.md) (`catalogue-rules.ts`), [settings-row.md](../../../code-system/patterns/settings-row.md) (модели по умолчанию, аудит в транзакции), [repository-over-transaction.md](../../../code-system/patterns/repository-over-transaction.md).
  - `catalogue-rules.ts` (new): добавление модели по факту `providerKind: ModelProviderKind | null` — `null` → `MODEL_PROVIDER_INVALID` `provider_unknown`, эмбеддинг у вида без эмбеддингов → `embeddings_not_supported`; выбор модели по умолчанию по строке каталога — нет → `model_unknown`, не того назначения → `not_chat` / `not_embedding`; изменение с полем другого назначения → `VALIDATION_FAILED`.
  - `models.repository.ts`: назначение и размерность; `countByProvider(name)`; строка `access_model_defaults` — чтение и запись. `access.service.ts`: `createModel(actor, body, providerKind)`, `updateModel` по назначению, `listModels` → `CatalogModel` с `provider`; `modelDefaults()` и `setModelDefaults(actor, body)` — аудит `admin_change` «было/стало» в транзакции записи, лог изменения; `defaultChatModel()`; `embedding(ownerId)` — включён ли сотрудник (если назван) и модель эмбеддингов по умолчанию с ценой ввода и размерностью, без прав и квот; `countModelsOfProvider(name)`; `myModels(ownerId, readiness)` — только модели чата и `unavailableReason` по готовности их провайдеров; `allowedModels` — только модели чата.
  - `model-verdict.ts`: модель эмбеддингов → `model_not_connected`. `grant-rules.ts`: право на модель эмбеддингов → `GRANT_INVALID` `embedding_model`. `access.errors.ts`: статусы и сообщения новых кодов.
  - Target Files: `apps/api/src/access/catalogue-rules.ts` (new), `apps/api/src/access/catalogue-rules.spec.ts` (new), `apps/api/src/access/models.repository.ts`, `apps/api/src/access/access.service.ts`, `apps/api/src/access/model-verdict.ts`, `apps/api/src/access/model-verdict.spec.ts`, `apps/api/src/access/grant-rules.ts`, `apps/api/src/access/grant-rules.spec.ts`, `apps/api/src/access/effective-access.ts`, `apps/api/src/access/access.errors.ts`.
  - Dependencies: Task 1.3, Task 2.3 (порт `AccessGate`).
  - Тесты — одна таблица правил каталога (шапка скелета `apps/api`): `catalogue-rules.spec.ts` — AC-05.1 (эмбеддинг к `gemini` принят), AC-05.2 (`embeddings_not_supported`), AC-05.3 (`provider_unknown`), AC-06.2 (`not_chat`, `not_embedding`, `model_unknown`); строка в `grant-rules.spec.ts` — `embedding_model` (DC-5); строка в `model-verdict.spec.ts` — эмбеддинг → `model_not_connected`.
  - Проверка: `pnpm turbo build --filter=api^...`, затем `pnpm --filter api typecheck` — нет ошибок `tsc` в файлах этой задачи и в файлах `apps/api` задач 1.4 и 2.4 (`logging/sentry-mask.ts`, `instrument.ts`, `agents/agents.module.ts`, `agents/agents-settings.ts`, `logging/app-logger.ts`). Ревьюер читает: модели эмбеддингов нет ни в «Мой доступ», ни в разрешённых; `embedding` не читает права.

- [x] **Task 4.2: Маршруты провайдеров, каталога, моделей по умолчанию и «Мой доступ»; шов эмбеддингов в Nest** — covers DD KD-1 (факты передаёт контроллер), Contract «Для части `web`» (все маршруты), Flow 3, Error handling, Security Considerations, AC-01.1, AC-01.3, AC-01.4, AC-01.5, AC-15.1 (маршрут), ADR-0019
  - Pattern: [auth-boundary.md](../../../code-system/patterns/auth-boundary.md), [port-module-split.md](../../../code-system/patterns/port-module-split.md), [write-only-secret.md](../../../code-system/patterns/write-only-secret.md).
  - `admin-model-providers.controller.ts` (new, `AgentsModule`, по образцу `AdminMcpServersController`, `@AdminOnly()`): `GET /`, `POST /`, `GET /:name`, `PATCH /:name`, `DELETE /:name` (число моделей — `AccessService.countModelsOfProvider`), `POST /:name/check`; `catalogModels` в каждом виде — от `AccessService`. Аудит `admin_change` на `model_provider` после операции (`recordProviderChange` по образцу `recordServerChange`); `apiKey: 'changed'` даёт `secret_changed`. Ошибки — `model-providers.errors.ts`: `MODEL_PROVIDER_NOT_FOUND` 404, `MODEL_PROVIDER_NAME_TAKEN` 409, `MODEL_PROVIDER_HAS_MODELS` 409 с `count`.
  - `admin-models.controller.ts`: при добавлении читает `agents.providers.kindOf(modelProvider(body.id))` и передаёт в `createModel`. `admin-model-defaults.controller.ts` (new, `AccessAdminModule`): `GET` и `PUT /api/admin/model-defaults`, `MODEL_DEFAULT_INVALID` 422 с `reason` и `model`.
  - `my-access.controller.ts` переезжает из `AccessModule` в `AccessAdminModule`: берёт `agents.providers.readiness(...)` и передаёт в `myModels`.
  - `agents.tokens.ts`: `EMBEDDING_CLIENT`; `agents.module.ts`: провайдер `EMBEDDING_CLIENT` (настоящий клиент) и опция `embeddingClient` в `createAgents`; контроллер провайдеров в `controllers`.
  - Target Files: `apps/api/src/agents/admin-model-providers.controller.ts` (new), `apps/api/src/agents/model-providers.errors.ts` (new), `apps/api/src/agents/agents.module.ts`, `apps/api/src/agents/agents.tokens.ts`, `apps/api/src/access/admin-models.controller.ts`, `apps/api/src/access/admin-model-defaults.controller.ts` (new), `apps/api/src/access/my-access.controller.ts`, `apps/api/src/access/access.module.ts`, `apps/api/src/access/access-admin.module.ts`.
  - Dependencies: Task 4.1, Task 3.1.
  - Тестов своих нет: маршруты проходят INT-2, INT-3, INT-6; проверка подключения — таблица адаптеров (Task 2.2).
  - Проверка: нет ошибок `tsc` в файлах задачи. Ревьюер читает: каждый новый контроллер под `@AdminOnly()`; `AccessModule` не импортирует `AgentsModule`; ни один ответ не несёт ключа.

- [x] **Task 4.3: Библиотека и чат на модели по умолчанию из базы** — covers DD KD-5, Contract `GET /api/library/choices`, «содержимое записи — модель может быть `null`», «Отказ старта» (HTTP), Flow 1 (заголовок без модели), DC-3, DC-7 (посев встроенных), FR-06
  - `library.service.ts`: `choices` и `copy` берут модель по умолчанию у `AccessService.defaultChatModel()` (может быть `null`); `ModelFacts.defaultModel` удаляется. `library.controller.ts`: `modelFacts` без `AGENTS_SETTINGS`. `copy-rules.ts`: шаг 2 правила замены пропускается при `null`. `record-content.ts`: `ContentPart.model: string | null`; `save-rules.ts` и `record-view.ts` читают модели только через `contentParts` и пропускают часть с `null` — по Notes, пункт 6.
  - `builtin-records.ts`: `builtinRecords()` без параметра — модель `null` у главного чата, `general-purpose` и исполнителей глубокого ресерча; координатор `deep-research` — `anthropic/claude-sonnet-5-5`. `builtin-records.seeder.ts`: без `AGENTS_SETTINGS`. `AgentsModule` больше не экспортирует `AGENTS_SETTINGS` (потребителей вне модуля нет).
  - Чат: `chat.errors.ts` отдаёт четыре новые причины в 409 `START_REFUSED` с `model`; `title.service.ts` на `ModelNotConfiguredError` пишет предупреждение с причиной и заголовок не ставит.
  - Target Files: `apps/api/src/library/library.service.ts`, `apps/api/src/library/library.controller.ts`, `apps/api/src/library/copy-rules.ts`, `apps/api/src/library/copy-rules.spec.ts`, `apps/api/src/library/record-content.ts`, `apps/api/src/library/save-rules.ts`, `apps/api/src/library/record-view.ts`, `apps/api/src/library/builtin-records.ts`, `apps/api/src/library/builtin-records.seeder.ts`, `apps/api/src/agents/agents.module.ts`, `apps/api/src/chat/chat.errors.ts`, `apps/api/src/chat/title.service.ts`.
  - Dependencies: Task 4.2, Task 2.5.
  - Тестов новых нет: `null` → модель по умолчанию доказывает INT-7, отказ первого сообщения — INT-4. Строки `copy-rules.spec.ts` правятся только под тип.
  - Проверка: нет ошибок `tsc` в файлах задачи. Ревьюер читает: `AGENTS_SETTINGS.defaultModel` нигде не читается.

- [x] **Task 4.4: Посев `seed:access`: провайдеры, модель эмбеддингов, модели по умолчанию; ключи со стандартного ввода** — covers DD FR-17, DC-13, KD-7 (путь стандартного ввода), AC-17.1, AC-17.2 (код; доказательство — ручной прогон)
  - Стандартный ввод — три строки: пароль администратора, ключ Anthropic, ключ Google; пустая строка — провайдер без ключа. Каждый ключ — в `rememberSecret` сразу после чтения, до первого лога. Ключи не берутся из аргументов.
  - Порядок через API: провайдеры `anthropic` (вид `anthropic`) и `google` (вид `gemini`) — 409 `MODEL_PROVIDER_NAME_TAKEN` пропускается, как `MODEL_ID_TAKEN` сегодня; модели Haiku и Sonnet (`purpose: 'chat'`) и `google/gemini-embedding-001` (`purpose: 'embedding'`, `dimensions: 768`, цена ввода — Notes, пункт 7); `PUT /api/admin/model-defaults` — чат `anthropic/claude-haiku-5-5`, эмбеддинги `google/gemini-embedding-001`; права, как сегодня (только модели чата).
  - Чтение трёх строк — в `common/admin-cli-client.ts` рядом с `readPassword` (`readLines(count)`), если `seed-mcp` и `super-admin` дальше читают пароль прежней функцией.
  - Target Files: `apps/api/src/access/seed-access-cli.ts`, `apps/api/src/common/admin-cli-client.ts`, `apps/api/README.md` (раздел посева).
  - Dependencies: Task 4.2, Task 4.3.
  - Проверка: `pnpm turbo build --filter=api^...`, затем `pnpm --filter api typecheck` — нет ошибок в `src/` (ошибки `test/` уходят в Task 5.3). Ревьюер читает: ни один лог и ни одно сообщение CLI не содержит ключа или его части.

#### Operational Verification Procedures

Выполняются после quality gate, на базе разработчика, против `http://localhost:4000`; каждый изменяющий запрос несёт cookie сеанса администратора и `Origin: http://localhost:3000`.

1. `pnpm --filter api start:dev` стартует без `ANTHROPIC_API_KEY` в окружении; Nest собирает модули без кругового импорта.
2. `printf '%s\n%s\n%s\n' "$PASS" "$ANTHROPIC_KEY" "" | pnpm --filter api seed:access` → провайдеры `anthropic` (ключ задан) и `google` (без ключа), три модели, модели по умолчанию выбраны; вывод не содержит ключа.
3. `GET /api/admin/model-providers` → `apiKeySet`, `apiKeyLast4`, `keyRequired`, `state` (`google` — `key_missing`); `POST /api/admin/model-providers/anthropic/check` → `works`.
4. Сообщение в чат отвечает (настоящая модель — один короткий запрос; платный шаг, только по просьбе владельца).

### Phase 5: Опоры тестов и интеграционные проверки
**Purpose**: Перевести три набора опор с переменных окружения на строки провайдеров и модели по умолчанию в базе и заполнить семь скелетов. Тесты пишутся, не запускаются: первый прогон — quality gate.

#### Tasks

- [x] **Task 5.1: Опоры `agents`, `workflows` и дочернего процесса `run_code` на строках провайдеров** — covers DD Test Strategy (harness), FR-02 (тесты)
  - `agentsHarness.ts`: модели опор переезжают на провайдера опор (`TEST_MODEL_DEFAULT = 'agents-harness/test-default'`, `TEST_MODEL_CHOSEN = 'agents-harness/test-chosen'`); опора при старте удаляет и заново вставляет строку `agents-harness` (вид `openai_compatible`, без ключа — готов) и удаляет её при закрытии; `AGENT_DEFAULT_MODEL` из `variables` уходит, модель по умолчанию отдаёт двойник гейта; опция `turnClient: 'real'` собирает `createMastraTurnClient()` (для INT-1); двойник эмбеддингов `createScriptedEmbeddings()` передаётся в `createAgents`.
  - То же в `packages/workflows/test/support/workflowsHarness.ts` (`HAIKU_MODEL = 'workflows-harness/claude-haiku-5-5'`, строка `workflows-harness`) и в `packages/agents/test/support/codeRunChild.ts` / `codeRunChildMain.ts` (`CHILD_MODEL` на провайдере опор; строку вставляет родительская опора до старта дочернего процесса), `packages/agents/test/verify/code-run.verify.ts`.
  - Литералы `anthropic/…`, которые эти e2e сравнивают с моделью опор, правятся на константы опор: `packages/agents/test/agent-platform-agents.int.e2e-spec.ts`, `packages/agents/test/custom-agents-runtime.int.e2e-spec.ts`, `packages/workflows/src/runs.spec.ts`, `packages/workflows/src/start-workflow.spec.ts` — только где значение идёт через `ModelClient` или старт; модели вне каталога остаются.
  - Target Files: `packages/agents/test/support/agentsHarness.ts`, `packages/agents/test/support/codeRunChild.ts`, `packages/agents/test/support/codeRunChildMain.ts`, `packages/agents/test/verify/code-run.verify.ts`, `packages/agents/test/agent-platform-agents.int.e2e-spec.ts`, `packages/agents/test/custom-agents-runtime.int.e2e-spec.ts`, `packages/workflows/test/support/workflowsHarness.ts`, `packages/workflows/src/runs.spec.ts`, `packages/workflows/src/start-workflow.spec.ts`.
  - Dependencies: Task 2.5, Task 3.1.
  - Проверка: `pnpm --filter @agent-os/agents typecheck`, `pnpm --filter @agent-os/workflows typecheck`. Ревьюер читает: `grep -rn "AGENT_DEFAULT_MODEL\|ANTHROPIC_API_KEY" packages/agents/test packages/workflows/test` пуст; ни одна опора не создаёт провайдера с именем `anthropic` в базе разработчика.

- [x] **Task 5.2: Поддельный провайдер трёх форматов и INT-1** — covers DD Test Strategy UC-1, UC-2, DC-4, AC-01.2, AC-02.2, AC-03.1, AC-03.2, AC-03.3, AC-04.1 (половина запроса), AC-05.4, AC-10.1
  - `packages/agents/test/support/fake-provider.ts` (new): локальный HTTP-сервер на формат — Anthropic `messages` SSE, Gemini `streamGenerateContent` SSE, OpenAI `chat/completions` SSE с `usage` в потоке; отвечает сценарием с текстом частями, одним вызовом инструмента и расходом «10 000 входных, из них 8 000 из кеша»; записывает URL, заголовок ключа и тело каждого запроса; умеет держать поток открытым (строка остановки); закрывается в `afterAll`.
  - INT-1 заполняет `packages/agents/test/model-providers-core.int.e2e-spec.ts` по строкам A–E скелета: опора `turnClient: 'real'`; три провайдера с уникальными именами на тест — вида `anthropic`, `gemini` и `openai_compatible` (`mp-a-<run>`, `mp-g-<run>`, `mp-l-<run>`), `baseUrl` каждого — адрес подделки; инструмент MCP фикстуры со схемой, где есть `$schema`, `additionalProperties`, `$ref`, `$defs` и `const`; двойник гейта отдаёт цену каждой модели. Строка D меняет ключ через `Agents.providers.update` между вызовами. Провайдера с именем `anthropic` тест не заводит: в базе разработчика он может быть настоящим (Notes, пункт 10).
  - Если подделка формата окажется слишком дорогой, резерв из шапки скелета — моковые модели AI SDK под адаптерами; тогда в задаче записывается, что строки B (DC-4) и C, D (адрес и ключ) не доказаны, и это идёт в Progress Tracking и в отчёт владельцу.
  - Target Files: `packages/agents/test/support/fake-provider.ts` (new), `packages/agents/test/model-providers-core.int.e2e-spec.ts`, `packages/agents/test/support/agentsHarness.ts` (опция `turnClient: 'real'`, если не сделана в Task 5.1).
  - Dependencies: Task 5.1.
  - AC-03.1, AC-03.2, AC-03.3, AC-01.2, AC-02.2, AC-05.4, AC-10.1 (проводка) → INT-1; AC-04.1 → INT-1 (запрос) + ручная проверка.
  - Проверка: `pnpm --filter @agent-os/agents typecheck`. Ревью тестов: да (опора, остановка).

- [x] **Task 5.3: Опоры `apps/api`: провайдер прогона, модели по умолчанию в базе, двойник эмбеддингов** — covers DD Test Strategy (harness), FR-02 (тесты)
  - `createTestApp`: опция `defaultModel` и `setEnv` для `AGENT_DEFAULT_MODEL` удаляются; новая опция `embeddings?: ScriptedEmbeddings` подменяет `EMBEDDING_CLIENT` (по умолчанию — свежий двойник, сети нет).
  - `support/access.ts`: `runProvider()` — `run-t<runId>`; `runModel(base)` — `<runProvider>/<base>-t<runId>`; `useRunModels(app, admin, { chat, embedding? })` — заводит провайдера прогона (вид `anthropic`, ключ прогона от 8 знаков; 409 — уже есть), добавляет модели и ставит их моделями по умолчанию; возвращает восстановление, которое возвращает прежние модели по умолчанию, если они ещё в каталоге, иначе `null`. `addModel` шлёт `purpose`.
  - `support/library.ts`: `catalogueModels` разбирает `CatalogModelSchema`; восстановление `pointBuiltinsAt` возвращает и прежнее `null`; `builtinRecords('anthropic/builtin-record-ids')` (`:199`) — `builtinRecords()`. То же в `custom-agents-runtime.int.e2e-spec.ts:164` (`builtinRecords(DEFAULT_MODEL)`).
  - `support/access.ts` `addModel` разбирает ответ `CatalogModelSchema`.
  - `support/migrate.global-setup.ts`: уборка прогона удаляет модели `run-t<runId>/%` и провайдера `run-t<runId>`.
  - Каждый файл, который передавал `defaultModel`, переходит на `useRunModels` (в `beforeAll`, восстановление в `afterAll` до `removeRunRows`): `agent-platform-chat.int.e2e-spec.ts`, `custom-agents-library.int.e2e-spec.ts`, `custom-agents-runtime.int.e2e-spec.ts`, `enterprise-access-access.int.e2e-spec.ts`, `enterprise-access-identity.int.e2e-spec.ts`, `enterprise-access-mcp-connect.int.e2e-spec.ts`, а также `test/verify/access-check.verify.ts`, `chat-listing.verify.ts`, `code-run-load.verify.ts` (они в `tsconfig` пакета).
  - Target Files: `apps/api/test/support/createTestApp.ts`, `apps/api/test/support/access.ts`, `apps/api/test/support/library.ts`, `apps/api/test/support/migrate.global-setup.ts`, девять файлов списка выше.
  - Dependencies: Task 4.4, Task 3.1.
  - Проверка: `pnpm turbo build --filter=api^...`, затем `pnpm --filter api typecheck` — первая проверка всего пакета `api` без ошибок. Ревью тестов: да (опора всех наборов `apps/api`). Ревьюер читает: каждый `beforeAll` с `useRunModels` имеет восстановление в `afterAll`; CI-база без посева получает модели и провайдера из самого набора.

- [x] **Task 5.4: INT-2, INT-3, INT-6 — ключ, права администратора, удаление** — covers DD Test Strategy UC-E1, UC-E2, UC-E7 (интеграционная часть), Flow 3, Invariants 1, 2, 4, 5, NFR-01
  - Файл `apps/api/test/model-providers-core.int.e2e-spec.ts`, одна `createTestApp({ captureLog: true })` на файл; сотрудники, роли, провайдеры (`mp-<run>`) и модели — свои у каждого случая; `afterAll` удаляет строки прогона и возвращает модели по умолчанию.
  - INT-2: строки 1–4 скелета; строка 4 вставляет строку провайдера прямо в базу и читает её вызовом реестра (`app.agents.providers.get`), затем пишет лог. AC-01.1, AC-01.5, AC-11.1, AC-11.2, NFR-01 → INT-2.
  - INT-3: таблица маршрутов скелета; после записей — чтение администратором без изменений; проверка подключения не послала запроса. AC-01.4 → INT-3.
  - INT-6: строки 1–3 скелета. AC-01.3 → INT-6; DC-6 → INT-6.
  - Ответы разбираются схемами `ModelProviderViewSchema`, `CatalogModelSchema`, `ModelDefaultsSchema`, `ApiErrorSchema` (в скелете — прежние имена `ProviderView`).
  - Target Files: `apps/api/test/model-providers-core.int.e2e-spec.ts`, при нужде `apps/api/test/support/model-providers.ts` (new: `createModelProvider`, `providerRoutes`).
  - Dependencies: Task 5.3.
  - Проверка: `pnpm --filter api typecheck`. Ревью тестов: да (секреты).

- [x] **Task 5.5: INT-4, INT-5, INT-7 — отказы провайдера, эмбеддинги, модель записи `null`** — covers DD Test Strategy UC-3, UC-4, UC-E3, UC-E5 (`owner_disabled`), UC-E6, Flow 1 и Flow 2 (проводка), KD-5, KD-6, DC-3, DC-7, DC-9, DC-10
  - INT-4: строки 1–4 скелета. Строка 3 иначе, чем в скелете: защёлка скриптовой модели стоит в ответе, то есть после проверки готовности (`testing.ts:245`), поэтому держится ответ ПЕРВОГО вызова, который просит следующий вызов модели. Пока он держится, администратор выключает провайдера (потом — `apiKey: null`); после отпускания второй вызов отклоняется до шва с `provider_disabled` (`provider_key_missing`), запись скриптовой модели показывает ровно один вызов. AC-02.1, AC-09.1, AC-09.2, AC-09.4 → INT-4.
  - INT-5: строки A–C скелета через `app.agents.embeddings.embed` и двойник `createTestApp({ embeddings })`; месячный расход Ани и второго сотрудника (строки A и C) — `GET /api/spend` (`ledger.monthSpend` суммирует все строки сотрудника; «Мой доступ» показывает только модели чата); расход против квоты Sonnet — `spendOf` или `GET /api/access/models`. AC-07.5, AC-08.1, AC-08.2, AC-08.3 → INT-5; AC-07.1 → INT-5 (проводка) + unit.
  - INT-7: строки 1–3 скелета; исполнитель workflow, стартующий после смены, требует `workers: true` (как `custom-agents-runtime`). Строка 3 берёт модель новой записи из `GET /api/library/choices`, как редактор веба. AC-06.1 → INT-7; DC-7 → INT-7.
  - Target Files: `apps/api/test/model-providers-core.int.e2e-spec.ts`.
  - Dependencies: Task 5.4 (тот же файл).
  - Проверка: `pnpm --filter api typecheck`. Ревью тестов: да (защёлки, конкурентность).

#### Operational Verification Procedures

Интеграционные тесты этой фазы — сами проверки точек стыка; их прогон — quality gate финальной фазы.

### Final Phase: Quality Assurance (Required)
**Purpose**: Один quality gate части, аудит тестов и сверка с дизайном.

#### Tasks
- [x] Quality gate после последней задачи: `pnpm check` (lint, typecheck, build, unit-тесты всех пакетов и `web`, `knip`), `pnpm --filter @agent-os/db exec drizzle-kit check`, затем на поднятой базе `pnpm db:migrate` и e2e в порядке CI: `pnpm --filter @agent-os/code-runner test:e2e`, `pnpm --filter @agent-os/db test:e2e`, `pnpm --filter @agent-os/runtime test:e2e`, `pnpm --filter @agent-os/agents test:e2e`, `pnpm --filter @agent-os/workflows test:e2e`, `pnpm --filter api test:e2e`. Падения исправляются, gate повторяется.
- [x] Аудит тестов части (`test-auditor`): семь INT и unit-таблицы шапок скелетов, ничего сверх них; строки `model-client.spec.ts`, повторённые `retry-policy.spec.ts`, удалены.
- [x] Каждый AC FR-01–FR-11, FR-15 доказан тестом по `acProof` скелета `packages/agents/test/model-providers-core.int.e2e-spec.ts` и проходит.
- [x] После gate `git status` и `pnpm db:migrate` оставили базу разработчика без строк прогона: `SELECT name FROM app.agent_model_providers` — только провайдеры владельца; `SELECT * FROM app.access_model_defaults` — значения, которые стояли до прогона.
- [x] Операционные проверки Phase 1, 2, 4 выполнены; результаты — в Progress Tracking.

#### Operational Verification Procedures

1. Процедуры Phase 1, Phase 2 и Phase 4 по порядку.
2. Поиск полного значения ключа Anthropic разработчика в выводе `seed:access` и в логе `start:dev` находит ноль строк.

## Verification Strategy

- **Correctness definition and method**: вызов модели любого вида идёт одним путём с подключением из базы на момент вызова; ключ не выходит ни в ответ, ни в аудит, ни в лог; отказ провайдера — названная причина значением, не отказ прав. Правила и разбор ошибок — unit-таблицами у кода; запрос, поток, расход и остановка трёх видов — INT-1 на поддельном провайдере; проводка прав, аудита, журнала и моделей по умолчанию — INT-2–INT-7 на настоящем `AppModule` и Postgres.
- **Early verification point**: INT-2 (Task 5.4) — главный риск части; его первый прогон — quality gate. Если он падает на строке 3 или 4, исправляется память секретов (Task 1.4) или её пополнение в реестре (Task 2.1), а не тест.
- **Proof obligations** (из строк «Catches» скелетов):
  - INT-1: адаптер теряет раздел кеша в расходе; Gemini получает ключевые слова схемы, которые отклоняет; запрос OpenAI-совместимого уходит не на сохранённый `baseUrl`; ключ или адрес закэширован при старте; остановка работает только у Anthropic.
  - INT-2: ключ в ответе или аудите; маска с неизменным списком не знает ключа, заданного или заменённого на ходу; заменённый ключ снова виден; ключ, прочитанный из базы другим экземпляром, маска не видела.
  - INT-3: новый контроллер без `@AdminOnly`.
  - INT-4: старт доходит до вызова, который нельзя сделать; запуск продолжает звать выключенного провайдера; отказ провайдера записан как `access_denied`.
  - INT-5: эмбеддинги отклонены без права; расход против квоты модели чата; расход ни на кого или на чужого; отключённый сотрудник тратит деньги; расход платформы виден в чьём-то месяце.
  - INT-6: провайдер удалён из-под моделей; модель по умолчанию указывает на удалённую модель; выбор снят слишком поздно.
  - INT-7: `null` разрешается на каждом вызове, а не при старте; `null` не разрешается никогда; встроенные записи держат старую модель.

## Risks and Countermeasures

- **Risk**: Ключ, заданный во время работы, попадает в лог мимо маски.
  - **Impact**: Высокое: утечка ключа (NFR-01).
  - **Countermeasure**: Одна память секретов в `common` (Task 1.4); пополнение при каждом чтении и записи ключа (Task 2.1) и при чтении со стандартного ввода (Task 4.4); маска Sentry (Task 1.4); INT-2 строки 3 и 4.
- **Risk**: Gemini отклоняет схему инструмента MCP.
  - **Impact**: Запуски на части серверов падают.
  - **Countermeasure**: Проверка пути Mastra в Task 2.2 до кода адаптера; резерв — адаптер Gemini сам зовёт `GoogleSchemaCompatLayer`; INT-1 строка B на gate; остаток — `provider_tools_rejected`; ручная проверка на настоящем Gemini.
- **Risk**: Пакеты AI SDK разных спецификаций или `ai` без `embedMany`.
  - **Impact**: Сборка или эмбеддинги не работают.
  - **Countermeasure**: `pnpm why` в Task 2.2 и Task 3.1 до кода; резерв `doEmbed` внутри шва (Task 3.1).
- **Risk**: Модели по умолчанию — одна строка на базу; e2e пишут в базу разработчика.
  - **Impact**: После тестов чат разработчика указывает на удалённую модель прогона или на «не выбрана».
  - **Countermeasure**: `useRunModels` с восстановлением в `afterAll` каждого набора; `fileParallelism: false` в обоих конфигах e2e; проверка в финальной фазе (Task 5.3).
- **Risk**: Опоры создают провайдера `anthropic` с поддельным ключом в базе разработчика.
  - **Impact**: Посев разработчика пропускает провайдера (409), и чат не работает.
  - **Countermeasure**: Провайдеры опор и прогона называются `agents-harness`, `workflows-harness`, `run-t<runId>`, `mp-<run>` (Task 5.1, Task 5.3).
- **Risk**: CI запускает e2e на чистой базе без посева.
  - **Impact**: Наборы без своей модели по умолчанию падают только в CI.
  - **Countermeasure**: Каждый набор сам заводит провайдера, модели и модели по умолчанию (Task 5.3).
- **Risk**: Тесты пишутся без прогона до quality gate.
  - **Impact**: Ошибки всплывают разом в конце.
  - **Countermeasure**: Проверка типов в каждой задаче; ревью тестов Task 5.2–5.5.

## Notes

1. **Правила владельца.** Задача пишет тесты, но не запускает их; внутри задачи — не больше одной проверки типов пакета (сборка зависимостей перед ней — подготовка). Коммитов нет, worktree, stash и reset не используются. Единственный gate — финальная фаза. Ревью тестов — только Task 5.2, 5.3, 5.4, 5.5 (опоры, остановка, секреты, конкурентность); один аудит тестов части в финальной фазе.
2. **Работа строится на текущем дереве.** Изменения `custom-agents` закоммичены (`5fce875`); в дереве только скелеты тестов. Задачи не переписывают и не форматируют файлы вне своих Target Files.
3. **Веб в этой части** получает только Task 1.2. Видимая работа — тексты новых отказов в чате (`access-texts.ts`, `library-errors.ts`, `tool-fallback.aui.tsx`), фильтр моделей чата в выборе (`grant-dialog.tsx`, `system-record-page.tsx`), пометки готовности (`models-section.tsx`, `ModelField`), экраны провайдеров и моделей по умолчанию — часть `web`; до неё эти места показывают общий текст.
4. **Имена из скелетов.** Скелеты написаны по дизайну 1.0: `ProviderView` и `ProviderCheck` в них — это `ModelProviderView` и `ModelProviderCheck` дизайна 1.2. Где комментарий скелета расходится с текстом задачи, верен текст задачи.
5. **`retry-policy.spec.ts` сегодня нет** — шапка скелета называет его; Task 2.3 его создаёт, а повторяющиеся строки `model-client.spec.ts` удаляет.
6. **Открытый вопрос (не блокирует).** Дизайн не говорит, как правило сохранения записи (`model_not_allowed`) и `missingRights` смотрят на модель `null`. Рекомендуемое, и по нему идёт Task 4.3: `null` не проверяется и не помечается — старт проверяет модель по умолчанию (`resolveStart`, Task 2.5), и отказ виден там. Если владелец решит иначе, меняется только Task 4.3.
7. **Цена модели эмбеддингов в посеве** дизайн не называет. Task 4.4 ставит 0,15 USD за миллион входных токенов — цену `gemini-embedding-001` из прайса Google; владелец сверяет её в ручном прогоне.
8. **Провайдер прогона в `apps/api`** — вид `anthropic` с ключом прогона: скриптовая модель запрос не шлёт, а проверка готовности над швом проходит по-настоящему.
9. **knip.** Новые экспорты `contracts`, `common`, `runtime`, `agents` идут через вход пакета; `@ai-sdk/google`, `@ai-sdk/openai-compatible` объявляются в Task 2.2, `ai` — в Task 3.1, `@mastra/schema-compat` — только если взят резерв Task 2.2. Неиспользуемый после Task 4.3 экспорт `AGENTS_SETTINGS` удаляется.
10. **AC-05.4 в INT-1.** Скелет просит в строке A id `anthropic/…`. E2e пишут в базу разработчика, где провайдер `anthropic` после посева настоящий, поэтому строка A идёт на провайдере вида `anthropic` с именем прогона. Что уже записанный id `anthropic/…` работает без правок, держат две вещи: строка `anthropic/claude-haiku-5-5` в таблице id `access.spec.ts` (Task 1.1) и отсутствие любых проверок префикса на пути вызова (Task 2.4, grep). Если владельцу нужна строка A буквально, тест заводит `anthropic` только при его отсутствии и удаляет его после себя.
11. **Поиск по коду.** Пути и потребители проверены тремя проходами `code-explorer` (Grep и чтение файлов; LSP не использовался, поэтому списки потребителей — текстовые, прочитанные).
12. **Итог quality gate (2026-11-20).** Gate зелёный: unit-тесты всех пакетов, `web` (59 файлов, 543 теста), e2e `code-runner` 22, `db` 3, `runtime` 28, `agents` 44, `workflows` 7, `api` 49, `drizzle-kit check`, миграция 0025, `knip`. Что стоит знать:
    - `pnpm check` одной командой останавливается на первой упавшей задаче turbo, поэтому `knip` и тесты `web` запускались отдельно.
    - Таймауты vitest в `apps/web` подняты с 20 до 60 секунд: четыре интеграционных теста `custom-agents` веба не укладывались в 20 секунд при параллельной нагрузке.
    - Вызов модели, который сообщает ноль входных токенов, записывается оценкой (DC-11); из-за этого в одном тесте `enterprise-access` поменялись точные суммы.
    - Аудит тестов: «слегка раздуто, но строками, а не файлами»; ничего не удалено.
    - Owner Checklist (ручные проверки владельца) остаётся открытым.

## Progress Tracking

| Пункт | Задача | Результат |
|---|---|---|
| Версии `@ai-sdk/*` на `@ai-sdk/provider` 4 (`pnpm why`) | Task 2.2 | Да: `@ai-sdk/anthropic` 4.0.82, `@ai-sdk/google` 4.0.99, `@ai-sdk/openai-compatible` 3.0.71 (точные версии) — все на одной копии `@ai-sdk/provider` 4.0.29 / `provider-utils` 5.0.62 |
| Чистка схем Gemini: слой Mastra применяется / резерв в адаптере | Task 2.2 | Слой Mastra применяется: `listAssignedTools` передаёт модель агента в `makeCoreTool`, `CoreToolBuilder.build` оборачивает сырую JSON Schema и зовёт `GoogleSchemaCompatLayer` (провайдер модели `google.generative-ai`), который убирает `$schema`, `additionalProperties`, `$ref`/`$defs` и переводит `const` в `enum`. Адаптер Gemini ничего не делает, `@mastra/schema-compat` не добавлен. Доказательство на проводе — INT-1 строка B |
| Версия `ai`, `embedMany` есть / резерв `doEmbed` | Task 3.1 | Резерв `doEmbed`. `@mastra/core` 1.83 линкует `ai` 7.0.155 (в lock единственная версия; 7.0.148 — только лишняя папка хранилища). `embedMany` есть в обеих, но 7.0.155 стоит на `@ai-sdk/provider` 4.0.34 / `provider-utils` 5.0.70, 7.0.148 — на 4.0.31 / 5.0.65; общей копии 4.0.29 с пакетами провайдеров нет ни у одной. `ai` не добавлен, `package.json` и `pnpm-lock.yaml` не менялись: `EmbeddingClient` зовёт `doEmbed` модели адаптера, повторы — службы. Gemini получает размерность каталога как `providerOptions.google.outputDimensionality` |
| Резерв моковых моделей в INT-1 взят? Какие строки не доказаны | Task 5.2 | Нет: сетевая подделка трёх форматов (`fake-provider.ts`), строки A–E все заполнены. Инструмент с `$ref`/`$defs`/`const` — `get_trace` фикстуры за прокси в спеке, переписывающим только `tools/list` (в фикстуре таких схем нет) |
| Операционные проверки Phase 1, 2, 4 | Final | Phase 1: миграция 0025 применена, `drizzle-kit check` чист; в базе разработчика обе таблицы есть, `access_model_defaults` — одна строка с пустыми моделями, обе строки `access_models` — `chat`.<br>Phase 2: `@ai-sdk/anthropic`, `@ai-sdk/google` и `@ai-sdk/openai-compatible` стоят на одной копии `@ai-sdk/provider` 4.0.29 (у `ai` своя 4.0.35, у Mastra внутри — 2.x и 3.x); решение по схемам Gemini — строка Task 2.2, совпадает с адаптером.<br>Phase 4: маршруты провайдеров, каталога и моделей по умолчанию прошли e2e `api` (49), `AppModule` стартует без `ANTHROPIC_API_KEY`; `start:dev` и `seed:access` на базе разработчика не запускались — провайдеров там нет, модели по умолчанию пусты, поэтому чат разработчика до посева отвечает `model_not_configured` (Owner Checklist, AC-17). |

## Owner Checklist (manual, not tasks)

- [ ] AC-04.1 на настоящем Gemini: агент на модели Gemini с тестовыми MCP-серверами и Sentry вызывает инструмент и получает результат (PRD, Assumptions).
- [ ] AC-17.1, AC-17.2, DC-13: посев на чистой базе с первым администратором — чат отвечает без панели; ключей нет в выводе и в логе.
- [ ] NFR-02 (UC-N1): время до первого токена на модели Anthropic до фичи и после — разница не больше 50 мс.
- [ ] Цена `gemini-embedding-001` в каталоге совпадает с прайсом Google (Notes, пункт 7).

## Appendix: Traceability

### Reference Contract Values

| Design Doc (§ Section) | Contract Type | Required Observable Value (verbatim) | Covered By Task(s) |
|---|---|---|---|
| design-core.md (§ FR-01) | exact-value | Имя — строчные латинские буквы, цифры и дефис, до 32 символов, с буквы или цифры; ключ — от 8 до 512 символов. Иначе ответ 400 `VALIDATION_FAILED`, и ничего не меняется (DC-1). | Task 1.1 |
| design-core.md (§ FR-01) | exact-value | `apiKey: null` в изменении убирает ключ; ни один маршрут провайдеров не отдаёт значение ключа (DC-2). | Task 1.1, Task 2.1, Task 4.2 |
| design-core.md (§ FR-02) | state-lifecycle-negative | Пока модель чата по умолчанию не выбрана, первое сообщение беседы получает 409 `START_REFUSED` с причиной `model_not_configured`, а заголовок беседы не создаётся, и причина есть в логе (DC-3). | Task 2.5, Task 4.3 |
| design-core.md (§ FR-04) | exact-value | Запрос к Gemini несёт схемы инструментов без ключевых слов, которые Gemini не принимает: `$schema`, `additionalProperties`, `$ref` и `$defs`; `const` уходит как `enum` (DC-4). | Task 2.2, Task 5.2 |
| design-core.md (§ FR-05) | exact-value | Право на модель эмбеддингов отклоняется ответом 422 `GRANT_INVALID` с причиной `embedding_model`; моделей эмбеддингов нет в «Мой доступ» (DC-5). | Task 4.1 |
| design-core.md (§ FR-05) | state-lifecycle-negative | Удаление модели, выбранной по умолчанию, снимает этот выбор: модели по умолчанию этого назначения больше нет, пока администратор не выберет другую (DC-6). | Task 1.3, Task 5.4 |
| design-core.md (§ FR-06) | state-lifecycle-negative | Встроенная запись с моделью `null` стартует на модели чата по умолчанию на момент старта; запуск, который уже идёт, смену не замечает (DC-7). | Task 2.5, Task 4.3, Task 5.5 |
| design-core.md (§ FR-07) | exact-value | Каждый вектор ответа имеет единичную длину (DC-8). | Task 3.1 |
| design-core.md (§ FR-07) | exact-value | Больше 100 текстов служба отправляет несколькими запросами, по строке журнала на запрос; пустой список даёт ответ без запроса к провайдеру (DC-9). | Task 3.1 |
| design-core.md (§ FR-09) | state-lifecycle-negative | Отказ провайдера не пишет запись `access_denied` в аудит (DC-10). | Task 2.3, Task 2.5 |
| design-core.md (§ FR-10) | exact-value | Ответ провайдера без числа входных токенов записывается оценкой, как прерванная попытка, с пометкой `estimated` в логе (DC-11). | Task 2.3, Task 3.1 |
| design-core.md (§ FR-15) | exact-value | Проверка не пишет ни журнала затрат, ни аудита; ответа нет за 10 секунд — результат «адрес недоступен» (DC-12). | Task 2.2 |
| design-core.md (§ FR-17) | structure-order | Стандартный ввод `seed:access` — три строки: пароль администратора, ключ Anthropic, ключ Google; пустая строка — провайдер без ключа (DC-13). | Task 4.4 |
| design-core.md (§ Как разбирается ошибка провайдера) | exact-value | 401 или 403 · нет · `provider_key_rejected` / 400 или 422, тело ошибки — об инструментах (признак адаптера вида) · нет · `provider_tools_rejected` / 408, 429, 5xx, обрыв сети, таймаут запроса · до двух, паузы 1 и 3 секунды, как сегодня · `provider_unavailable` / любой другой статус · нет · `model_error` у чата, `provider_error` у эмбеддингов | Task 2.3, Task 3.1 |
| design-core.md (§ Как разбирается ошибка провайдера) | exact-value | у Anthropic сообщение ошибки начинается с `tools.`, у Gemini оно называет `function_declarations`, у OpenAI-совместимого — `tools` | Task 2.2 |
| design-core.md (§ Terms) | structure-order | `providerReadiness` проверяет условия в этом порядке и отдаёт первое сработавшее, поэтому выключенный провайдер без ключа — `disabled`. | Task 2.1 |
| design-core.md (§ ModelProviderView) | exact-value | `effectiveBaseUrl` — адрес, на который уходят запросы: заданный или адрес вида по умолчанию (`https://api.anthropic.com/v1`, `https://generativelanguage.googleapis.com/v1beta`, `https://api.openai.com/v1`). | Task 2.1 |
| design-core.md (§ ModelProviderView) | exact-value | `keyRequired` — нужен ли виду ключ: `true` у `anthropic` и `gemini`, `false` у `openai_compatible`. | Task 1.1, Task 2.1 |
| design-core.md (§ ModelProviderCheck) | exact-value | `result` — `works`, `key_rejected` или `unreachable`. `message` — статус и текст ответа провайдера до 500 символов, через маску секретов; `null` при `works`. | Task 1.1, Task 2.2 |
| design-core.md (§ CatalogModel) | exact-value | `purpose: 'embedding'` — `inputUsdPerMTok` и `dimensions` (целое от 1 до 4096). | Task 1.1, Task 1.3 |
| design-core.md (§ Для части web) | exact-value | `GET /api/access/models` («Мой доступ») — только модели чата; каждая получает `unavailableReason`: `null`, если провайдер готов, иначе `provider_missing`, `provider_disabled` или `provider_key_missing`. | Task 1.1, Task 4.1, Task 4.2 |
| design-core.md (§ Для части web) | exact-value | `PUT /api/admin/model-defaults` … Модели нет в каталоге или она не своего назначения — 422 `MODEL_DEFAULT_INVALID` с причиной `model_unknown`, `not_chat` или `not_embedding` и отклонённым id в `model` (AC-06.2). | Task 1.1, Task 4.1, Task 4.2 |
| design-core.md (§ Для части web) | exact-value | добавление модели к несуществующему провайдеру — 422 `MODEL_PROVIDER_INVALID` с причиной `provider_unknown` (AC-05.3); модель эмбеддингов к провайдеру вида Anthropic — та же ошибка с причиной `embeddings_not_supported` (AC-05.2). | Task 4.1 |
| design-core.md (§ Error handling) | exact-value | `MODEL_PROVIDER_NOT_FOUND` — 404 · `MODEL_PROVIDER_NAME_TAKEN` — 409 при добавлении · `MODEL_PROVIDER_HAS_MODELS` — 409 при удалении, с `count` · `MODEL_PROVIDER_INVALID` — 422 · `MODEL_DEFAULT_INVALID` — 422 | Task 1.1, Task 4.2 |
| design-core.md (§ Для части web, Отказ старта) | exact-value | 409 `START_REFUSED` получает причины `model_not_configured`, `provider_missing`, `provider_disabled`, `provider_key_missing` с полем `model`; у `model_not_configured` оно `null` | Task 1.1, Task 2.5, Task 4.3 |
| design-core.md (§ Для части web, Сбой агента) | exact-value | `failureReason` получает `provider_missing`, `provider_disabled`, `provider_key_missing`, `provider_key_rejected`, `provider_unavailable`, `provider_tools_rejected`; `model_error` остаётся для прочих ошибок провайдера. | Task 1.1, Task 2.3 |
| design-core.md (§ Agents.embeddings.embed) | exact-value | Причины `reason`: `model_not_configured`, `owner_disabled`, `provider_missing`, `provider_disabled`, `provider_key_missing`, `provider_key_rejected`, `provider_unavailable`, `provider_error`, `dimension_mismatch`. | Task 3.1 |
| design-core.md (§ Agents.embeddings.embed) | exact-value | до 100 текстов в одном запросе к провайдеру — длинный список служба делит сама и шлёт пачки по очереди; таймаут запроса 30 секунд; повторы — как у чата. | Task 3.1 |
| design-core.md (§ PLATFORM_OWNER_ID) | exact-value | `PLATFORM_OWNER_ID` в `@agent-os/runtime` — владелец `platform` строк журнала без сотрудника. | Task 3.1 |
| design-core.md (§ KD-7) | exact-value | Ключ короче 8 символов не принимается, потому что маска по значению работает с 8. | Task 1.1, Task 1.4 |

### Failure Mode Checklist

| Category | Where it applies | Covered By Task(s) |
|---|---|---|
| no-op | пустой список текстов — ответ без запроса; удаление провайдера с моделями — отказ без изменений | Task 3.1, Task 2.1, Task 5.4 (INT-6) |
| empty input | `apiKey: null` убирает ключ; пустая строка ключа в посеве — провайдер без ключа | Task 1.1, Task 4.4 |
| invalid option | вид провайдера, назначение модели, модель не своего назначения по умолчанию, право на эмбеддинг | Task 1.1, Task 4.1 |
| missing config | модель чата или эмбеддингов не выбрана; провайдер не заведён, выключен, без ключа | Task 2.3, Task 2.5, Task 3.1, Task 5.5 (INT-4, INT-5) |
| external failure | 401/403, инструменты не приняты, 5xx и сеть после повторов, молчание при проверке | Task 2.2, Task 2.3 |
| shared-state dependency | одна строка моделей по умолчанию и e2e в базе разработчика; CI без посева | Task 5.3 |
| secret exposure | ключ в ответе, аудите, логе, Sentry, выводе посева | Task 1.4, Task 2.1, Task 4.2, Task 4.4, Task 5.4 (INT-2) |
| mid-run change | смена модели по умолчанию и выключение провайдера во время запуска | Task 2.3, Task 2.5, Task 5.5 (INT-4, INT-7) |

### ADR Bindings

| ADR | Source Section | Axis | Binding Decision | Covered By Task(s) |
|---|---|---|---|---|
| docs/adr/ADR-0018-model-id-provider-prefix.md | Implementation Guidance | contract_schema | Форму id проверяет `ModelIdSchema` в `contracts`, провайдера достаёт `modelProvider` там же | Task 1.1 |
| docs/adr/ADR-0018-model-id-provider-prefix.md | Implementation Guidance | persistence | Id хранится текстом во всех таблицах; на реестр провайдеров он не ссылается внешним ключом | Task 1.3 |
| docs/adr/ADR-0019-model-provider-registry-in-agents.md | Implementation Guidance | placement | `agent_model_providers` читает и пишет только пакет `agents`; `apps/api` зовёт `Agents.providers` | Task 2.1, Task 4.2 |
| docs/adr/ADR-0019-model-provider-registry-in-agents.md | Implementation Guidance | security | Пишущая операция возвращает «было» и «стало», где ключ — `changed`, а не значение; ключ, прочитанный или принятый, сразу попадает в память секретов логгера (`rememberSecret`) | Task 2.1, Task 4.2 |
| docs/adr/ADR-0019-model-provider-registry-in-agents.md | Decision | data_flow | `ModelClient` на каждом вызове читает строку провайдера по первой части id модели, без кэша | Task 2.3 |
| docs/adr/ADR-0015-access-gate-and-model-catalogue.md | Decision | placement | Каталог, права, квоты и модели по умолчанию — в `access`; агенты читают их через порт `AccessGate` | Task 2.3, Task 4.1 |
| docs/adr/ADR-0014-mcp-registry-owned-by-agents.md | Decision | dependency_direction | Реестр с секретом — в пакете `agents`, аудит после операции пишет `apps/api` | Task 2.1, Task 4.2 |
| docs/adr/ADR-0017-run-snapshots-from-library.md | Decision | data_flow | Модель запуска фиксируется в снимке при старте | Task 2.5 |
| docs/adr/ADR-0003-drizzle-data-layer.md | Decision | persistence | Таблицы в схеме `app`, изменение — новой миграцией drizzle | Task 1.3 |
| docs/adr/ADR-0004-agent-framework-packages.md | Decision | dependency_direction | Пакеты не импортируют `apps/api`; двойники — только в `./testing` пакета | Task 3.1, Task 5.1 |

### Connection Map

| Boundary | Owner (left side) | Owner (right side) | Serialized Format | Consumer Parse Rule | Expected Signal | Covered By Task(s) |
|---|---|---|---|---|---|---|
| HTTP `/api/admin/model-providers`, `/api/admin/models`, `/api/admin/model-defaults` → веб | `apps/api/src/agents/admin-model-providers.controller.ts`, `apps/api/src/access/admin-models.controller.ts`, `admin-model-defaults.controller.ts` | `apps/web` (часть `web`, `adminApi.modelProviders`, `adminApi.models`, `adminApi.modelDefaults`) | JSON по схемам `model-providers.ts`, `access.ts` | `ModelProviderViewSchema`, `ModelProviderCheckSchema`, `CatalogModelSchema`, `ModelDefaultsSchema` | INT-2, INT-3, INT-6 разбирают тела схемами | Task 1.1, Task 4.2, Task 5.4 |
| HTTP `GET /api/access/models`, `GET /api/library/choices` → веб | `apps/api/src/access/my-access.controller.ts`, `apps/api/src/library/library.controller.ts` | `apps/web` | JSON | `MyModelsSchema` (`unavailableReason`), `LibraryChoicesSchema` (`defaultModel` может быть `null`) | веб компилируется (Task 1.2); INT-5, INT-7 | Task 1.2, Task 4.2, Task 4.3 |
| Причины отказа старта и сбоя → веб | `packages/agents/src/start/resolve-start.ts`, `model-step.ts`; `apps/api/src/chat/chat.errors.ts` | `apps/web/src/lib/agents/format.ts` (сейчас), тексты — часть `web` | JSON `reason`, `model` | `StartRefusedErrorSchema`, `AgentFailureReasonSchema`, `ToolRefusalReasonSchema` | INT-4 | Task 1.1, Task 1.2, Task 2.5 |
| `Agents.providers` → контроллеры `apps/api` | `packages/agents/src/providers/provider-registry.ts` | `apps/api/src/agents/admin-model-providers.controller.ts`, `admin-models.controller.ts`, `my-access.controller.ts` | — (вызов в процессе) | `{ view, before, after }`; `kindOf` → вид или `null`; `readiness(names)` | INT-2, INT-6 | Task 2.1, Task 4.2 |
| Порт `AccessGate` (`defaultChatModel`, `embedding`) | `apps/api/src/access/access.service.ts` | `packages/agents/src/model/model-client.ts`, `start/resolve-start.ts`, `embeddings/embeddings.ts` | — | вердикт значением | INT-4, INT-5, INT-7 | Task 2.3, Task 4.1 |
| `Agents.embeddings`, `PLATFORM_OWNER_ID`, `rememberSecret`, причины `provider_*` → фича `self-learning` (часть `core`, по её дизайну) | `packages/agents/src/embeddings/embeddings.ts`, `packages/runtime`, `packages/common/src/logger.ts` | `packages/agents` (самообучение, ещё не построено) | — | `vectors` / `unavailable` с `reason` | `embeddings.spec.ts`, INT-5 | Task 1.4, Task 3.1 |
| `access_models` → `access_model_defaults` (FK `ON DELETE SET NULL`) | `packages/db/src/schema.ts` | `apps/api/src/access/models.repository.ts` | — | `null` — «не выбрана» | INT-6 строка 2 | Task 1.3, Task 5.4 |
| `ModelProviderKindSchema`, назначение → CHECK базы | `packages/contracts/src/model-providers.ts`, `access.ts` | `packages/db/src/schema.ts` | значения перечисления | `isOneOf` | карта доменов CHECK теста миграций | Task 1.1, Task 1.3 |
| Шов `EmbeddingClient` → Nest и опоры | `packages/agents/src/embeddings/embedding-client.ts` | `apps/api/src/agents/agents.module.ts` (`EMBEDDING_CLIENT`), `apps/api/test/support/createTestApp.ts`, `agentsHarness.ts` | — | `createScriptedEmbeddings()` | INT-5 | Task 3.1, Task 4.2, Task 5.1, Task 5.3 |

## Update History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-11-20 | Initial version; по проверке черновика: выполнимые проверки типов (сборка `agents` через `workflows`, `api` чист с Task 5.3), `snapshot.ts`, `startDeps`, двойник реестра, `record-content.ts`, расход INT-5 через `GET /api/spend`, защёлка INT-4 на первом вызове |
| 1.1 | 2026-11-20 | Final Phase отмечена по итогу quality gate; Progress Tracking «Операционные проверки», Notes пункт 12; статус completed |
