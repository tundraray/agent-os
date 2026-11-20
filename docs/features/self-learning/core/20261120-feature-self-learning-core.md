---
feature: self-learning
part: core
design: design-core.md
plan: 1 of 1
status: draft
temporary: true
---

# Work Plan: Самообучение workflow — core

Created Date: 2026-11-20
Type: feature

## Snapshot

**Overview.** План строит серверную часть самообучения: флажок `selfLearning` у workflow, граф знаний и векторы в Postgres (pgvector), извлечение после конца запуска отдельной задачей, проход векторов, вектор вопроса сессии, блок знаний в системном тексте шага и маршруты графа и настроек. Порядок: образ базы с pgvector → контракты и вынужденные правки литералов → таблицы и миграция → чистые функции (`checkOperations`, похожие сущности, `selectKnowledge`) → транзакция у `tasks.create`, репозитории и хранилище векторов → флажок в снимке и строка запуска → извлечение и потребитель → проход векторов, вектор вопроса и блок в шаге → `Agents.knowledge` и маршруты `apps/api` → опоры тестов и двенадцать INT → один quality gate. Подход гибридный: снизу вверх по пакетам (`contracts` → `db` → `runtime` → `agents` → `apps/api`), потому что каждый пакет компилируется только против нижнего из `dist`; внутри `agents` — сначала чистые решения с их таблицами (их не нужно ни с чем соединять), затем пути, которые их зовут. Правило владельца: задачи пишут тесты, но не запускают их; коммитов нет; миграция и e2e — только в финальной фазе.

- **Не меняется**: права на инструменты и модели и их проверка; снимок запуска и правило «правка записи не трогает идущий запуск»; ход шагов, сжатие, подтверждения; журнал токенов (`runtime_model_calls`); `RunOrigin` и столбцы `agent_sessions`; служба эмбеддингов `model-providers`. Веб получает только правки литералов, без которых он не компилируется (Task 1.3); флажок в редакторе, экран знаний и настройки — часть `web`.
- **Главный риск**: неверное или подброшенное знание закрепляется и уходит во все запуски workflow. Защита строится в Task 2.1 (подтверждение только ссылкой на вызов этого запуска, маска секретов) и Task 6.3 (граф в конверте данных), доказывается INT-7 и INT-1, тесты проходят ревью.
- **Открытые вопросы**: сборку не блокируют; два решения владельца до gate — целевая база с `vector` и переключение контейнера разработчика (Notes, пункты 2 и 3).
- **Design items no task covers**: нет. AC-07.2 и половина AC-02.1/AC-02.3 не автоматизируются (шапка скелета, `provenAt: not automated`) — Owner Checklist.

## Implementation Phases

Каждая задача: реализация, тесты, которые она пишет (без запуска), и проверка типов своих файлов. Пакеты читают друг друга из `dist`: перед проверкой типов собираются зависимости (`pnpm turbo build --filter=<пакет>^...`). Этот фильтр не собирает сам пакет; тесты `agents` и `workflows` и пакет `api` читают `@agent-os/agents` из `dist`, поэтому проверка, которой нужен свежий `agents`, собирает его явно (`pnpm turbo build --filter=@agent-os/workflows^...` или `--filter=api^...`). Сборка (`tsconfig.build.json`) исключает `*.spec.ts`, проверка типов (`tsconfig.json`) включает `src` и `test`.

Коммитов нет, изменения копятся в рабочем дереве основной копии; worktree, stash и reset не используются. Задачи идут по одной. Ни одна задача не запускает тесты, `pnpm db:migrate`, `pnpm --filter * test:e2e` и `docker compose up`: глобальная подготовка e2e (`migrate.global-setup.ts`) применяет миграции к базе разработчика, а у неё до Task Q.1 нет расширения `vector`.

**Когда пакет снова компилируется целиком.** Task 1.2 делает `selfLearning` обязательным в выходном типе `WorkflowContent`, и литералы содержимого в тестах и в вебе перестают компилироваться до Task 1.3.

| Пакет | Чисто с задачи | Почему не раньше |
|---|---|---|
| `@agent-os/contracts` | 1.2 | — |
| `web`, `api`, `@agent-os/agents`, `@agent-os/workflows` | 1.3 | литералы `WorkflowContent` без `selfLearning` |
| `@agent-os/db` | 1.4 | — |
| `@agent-os/runtime` | 3.1 | — |
| `@agent-os/workflows` после `learning` | 4.1 (та же задача правит `runs.spec.ts`) | литерал снимка `executor` без `learning` |
| `@agent-os/agents` после новых файлов | каждая задача Phase 2–7 — «нет ошибок в файлах задачи»; пакет целиком — 7.1 | новые модули соединяются в `createAgents` только в Task 7.1 |
| `api` после новых маршрутов | 7.3 | `Agents.knowledge` появляется в Task 7.1 |

### Phase 1: База с pgvector, контракты, литералы, таблицы
**Purpose**: Подготовить окружение и все формы: образ Postgres с `vector`, контракт графа и настроек, флажок в содержимом workflow, семь таблиц и миграцию, которая без расширения не проходит.

#### Tasks

- [ ] **Task 1.1: Образ Postgres с pgvector в разработке и CI; порядок переключения базы разработчика** — covers DD KD-8 (образ), Risks «Целевой Postgres без расширения `vector`», Fact Disposition F16; шапка скелета, HARNESS GAP (a)
  - `infra/docker-compose.yml`: сервис `postgres` — образ `pgvector/pgvector` той же major-версии 16 и той же Debian, что у нынешнего контейнера. Сегодня `infra-postgres-1` — PostgreSQL 16.15 на Debian 13 (trixie), `datcollversion` баз — `2.41` (glibc trixie). Тег выбирается так, чтобы `docker run --rm <образ> cat /etc/os-release` показал trixie, а `postgres --version` — 16.x не ниже 16.15: `pgvector/pgvector:pg16`, если он на trixie, иначе вариант тега с суффиксом `-trixie`. Точный тег — без `latest`. Том `pgdata`, путь, переменные и `${POSTGRES_PORT:-5432}` не меняются.
  - `.github/workflows/ci.yml`: служба `postgres` задания `e2e-runtime` — тот же тег (в CI база чистая, совпадение glibc важно только для разработчика, но тег один).
  - Порядок переключения базы разработчика записывается в Notes, пункт 3, и выполняется только в Task Q.1, шаг 0. В этой задаче контейнер не пересоздаётся.
  - Если `README.md` называет образ `postgres:16` — та же замена. Архив, дизайны, планы и `.claude/` не трогаются.
  - Target Files: `infra/docker-compose.yml`, `.github/workflows/ci.yml`, `README.md` (только при упоминании образа).
  - Не трогает: `.github/workflows/docker.yml`, `apps/api/.env*`.
  - Dependencies: нет.
  - Проверка: `docker compose -f infra/docker-compose.yml config` разбирает файл (контейнеры не трогаются); `docker run --rm <тег> sh -c "cat /etc/os-release; postgres --version; ls /usr/share/postgresql/16/extension/vector.control"` — trixie, 16.x, файл есть. Итог — в Progress Tracking.

- [ ] **Task 1.2: Контракты: `knowledge.ts`, флажок `selfLearning`, `KNOWLEDGE_FORBIDDEN`** — covers DD KD-2 (поле), KD-7 (код 403), Contract Definitions «Для части `web`» (схемы, константы предела, `KnowledgeView`, `KnowledgeSelection`, `KnowledgeItem`, `LastExtraction`, `KnowledgeSettings`, Error handling), «Внутри платформы» (`WorkflowContent.selfLearning`), DC-1, DC-2 (запуск и сотрудник не отдаются)
  - `packages/contracts/src/knowledge.ts` (new, по образцу `model-providers.ts`): `KNOWLEDGE_LIMIT_TOKENS_MIN = 1000`, `KNOWLEDGE_LIMIT_TOKENS_MAX = 32000`, `KNOWLEDGE_LIMIT_TOKENS_DEFAULT = 8000`; `KnowledgeItemTypeSchema` (`entity`, `relation`), `KnowledgeItemKindSchema` (`fact`, `lesson`, `searched_nothing`), `KnowledgeItemStateSchema` (`active`, `outdated`, `lessons_off`), `KnowledgePlacementSchema` (`always`, `by_topic`, `does_not_fit`, nullable), `KnowledgeSelectionSchema` (объединение по `state`: `off` с `reason` `model_not_selected` / `provider_failed` и `model`, `preparing` с `pending`, `on`), `KnowledgeItemSchema` (объединение по `type`/`kind` с полями дизайна, `confirmations` от 1, `date` — ISO), `LastExtractionStatusSchema` (`done`, `skipped`, `failed`), `LastExtractionReasonSchema` (`stopped`, `owner_disabled`, `quota_exhausted`, `model_not_connected`, `model_not_allowed`, `no_models_allowed`, `model_error`, `invalid_answer`, `interrupted`), `LastExtractionSchema`, `KnowledgeCountsSchema`, `KnowledgeViewSchema`, `KnowledgeSettingsSchema`, `UpdateKnowledgeSettingsBodySchema` (строгий объект: `limitTokens` целое в границах, `lessonsEnabled` логическое). Ни у одного вида нет поля запуска или сотрудника.
  - `library.ts`: `WorkflowContentSchema` + `selfLearning: z.boolean().default(false)` (вне `superRefine`); `LibraryErrorCode` + `KNOWLEDGE_FORBIDDEN`.
  - `index.ts`: `export * from './knowledge.js'`.
  - `apps/api/src/library/library.errors.ts`: `ANSWERS` (`Record<LibraryErrorCode, …>`) + `KNOWLEDGE_FORBIDDEN` — 403, текст-константа; без этой строки `api` не компилируется.
  - Target Files: `packages/contracts/src/knowledge.ts` (new), `packages/contracts/src/knowledge.spec.ts` (new), `packages/contracts/src/library.ts`, `packages/contracts/src/index.ts`, `apps/api/src/library/library.errors.ts`.
  - Dependencies: нет.
  - Тест: `knowledge.spec.ts` — одна таблица `UpdateKnowledgeSettingsBodySchema`: `limitTokens` 999 и 32 001 и 8000.5 — нет, 1000 и 32 000 — да, лишнее поле — нет (граница 400 `VALIDATION_FAILED`; шапка скелета `apps/api`: «settings bounds are a contract-schema row»). Строку «старое содержимое без поля читается с `false`» не пишем: это поведение `zod` `.default` (CLAUDE.md, тесты не проверяют библиотеку).
  - Проверка: `pnpm --filter @agent-os/contracts typecheck`. Ревьюер читает: имена и значения совпадают с Reference Contract Values; в `KnowledgeItemSchema` нет `runId`, `ownerId`, `employee`.

- [ ] **Task 1.3: Вынужденные правки литералов `WorkflowContent` (веб, `api`, `agents`, `workflows`)** — covers DD KD-2 (поле с умолчанием), Constraints (PoC без миграции данных), Sibling parts (`web` получает только компиляцию)
  - `selfLearning: false` добавляется в каждый литерал, типизированный выходным типом `WorkflowContent`, `RecordBody`, `CreateRecordBody`, `WorkflowSnapshot` или `WorkflowDefinition`. Больше ничего не меняется.
  - Веб: `apps/web/src/components/library/workflow-fields.tsx` (`blankWorkflow`, строки 139–143), `apps/web/src/components/library/executor-panel.tsx` (объект `probe` около строки 56–62), `apps/web/src/lib/library/record-rules.test.ts` (строки 62–69). `apps/web/src/test/fixtures.ts` разбирает схемой — не меняется.
  - `api`: `apps/api/test/support/library.ts` (`workflowBody`, строка 61–76), `apps/api/test/enterprise-access-access.int.e2e-spec.ts` (`accessCheckWorkflow`, строка 204–230), `apps/api/src/library/copy-rules.spec.ts` (строка 43), `apps/api/src/library/save-rules.spec.ts` (строка 50). `builtin-records.ts` возвращает `unknown` и не меняется: встроенные записи остаются без флажка (Fact Disposition F1).
  - `agents`: `packages/agents/src/start/resolve-start.spec.ts` (90, 123), `packages/agents/src/start/snapshot-definition.spec.ts` (помощник `workflow()` 79–100, строки 126, 140, 154, 171), `packages/agents/src/tools/tool-registry.spec.ts` (89), `packages/agents/test/custom-agents-runtime.int.e2e-spec.ts` (около 350–360), `packages/agents/test/agent-platform-agents.int.e2e-spec.ts` (687–707).
  - `workflows`: `packages/workflows/src/runs.spec.ts` (43–49), `packages/workflows/src/start-workflow.spec.ts` (55), `packages/workflows/test/custom-agents-runtime.int.e2e-spec.ts` (117), `packages/workflows/test/agent-platform-workflows.int.e2e-spec.ts` (120, 133), `packages/workflows/test/support/workflowsHarness.ts` (`TestWorkflowContent`, 122).
  - Список собран чтением кода (поиск `finalExecutor:` и типов); если `tsc` назовёт ещё файл с той же причиной — он входит в задачу той же правкой.
  - Target Files: перечисленные выше.
  - Не трогает: `packages/contracts/src/library.spec.ts` (нетипизированный литерал разбирается схемой), `packages/agents/test/self-learning-core.int.e2e-spec.ts`, `apps/web/src/components/shell/self-learning-web.int.test.tsx` (скелеты).
  - Dependencies: Task 1.2.
  - Проверка: `pnpm turbo build --filter=api^... --filter=web^...`, затем `pnpm --filter web typecheck`, `pnpm --filter api typecheck`, `pnpm --filter @agent-os/agents typecheck`, `pnpm --filter @agent-os/workflows typecheck` — все без ошибок. Ревьюер читает: в diff только `selfLearning: false`.

- [ ] **Task 1.4: Семь таблиц `agent_knowledge_*`, расширение `vector`, строка настроек; миграция 0026** — covers DD KD-1 (внешние ключи с каскадом на `library_records`), KD-5, KD-7 (строка настроек), KD-8 (таблица векторов, колонка без длины, расширение), Data Model целиком, Invariants 6, 7, 8, 11 (база), Runtime settings, F17
  - Pattern: [repository-over-transaction.md](../../../code-system/patterns/repository-over-transaction.md), [settings-row.md](../../../code-system/patterns/settings-row.md) (строка настроек).
  - `packages/db/src/schema.ts`, по образцу `agentMcpServers` и `librarySettings`:
    - `agentKnowledgeEntities`: `id` integer `generatedAlwaysAsIdentity` PK; `record_id` uuid not null → `library_records.id` `ON DELETE CASCADE`; `name`, `description` text; `confirmations` integer not null CHECK ≥ 1; `created_at`, `confirmed_at` timestamptz; `source_run_id`, `confirmed_by_run_id` uuid без внешнего ключа (беседу удаляют, запись графа остаётся); `outdated` boolean default false. Индекс по `record_id`.
    - `agentKnowledgeRelations`: те же общие поля; `kind` text CHECK через `isOneOf(t.kind, KnowledgeItemKindSchema.options)`; `from_entity_id`, `to_entity_id` integer null → `agent_knowledge_entities.id` `ON DELETE CASCADE`; `label`, `server`, `tool`, `question`, `hint`, `outcome` text null; CHECK формы: у `fact` оба конца и `label`, у `lesson` — `server`, `tool`, `question`, `hint`, `outcome`, у `searched_nothing` — `server`, `tool`, `question`; у не-`fact` концов нет.
    - `agentKnowledgeRuns`: `run_id` uuid PK → `agent_sessions.task_id` `ON DELETE CASCADE`; `record_id` uuid not null без внешнего ключа; `servers` jsonb (серверы команды); `extracted_up_to` timestamptz null (null — с начала); `extract_task_id` uuid null (раунд в работе); `last_extract_task_id` uuid null (Notes, пункт 6); `needs_round` boolean default false; итог раунда: `last_status` CHECK по `LastExtractionStatusSchema` null, `last_reason` CHECK по `LastExtractionReasonSchema` null, `last_added`, `last_confirmed`, `last_outdated` integer, `last_model` text, `last_at` timestamptz. Индекс по `record_id`.
    - `agentKnowledgeQuestions`: `task_id` uuid PK → `agent_sessions.task_id` `ON DELETE CASCADE`; `source` text not null (`task` или id сообщения); `model` text null; `vector` `real[]` null; `created_at`.
    - `agentKnowledgeEmbedding`: `record_id` uuid PK → `library_records.id` `ON DELETE CASCADE`; `pass_task_id` uuid null; `needs_pass` boolean default false; `payer_id` text null; `last_reason` text null; `last_model` text null; `last_at` timestamptz null.
    - `agentKnowledgeVectors`: `record_id` uuid → `library_records.id` `ON DELETE CASCADE`; `key` text (`e12`, `r7`); `key_kind` text CHECK по `KnowledgeItemTypeSchema`; `model` text; `vector` — свой `customType` `vector` без длины (встроенный `vector` drizzle-orm 0.45.4 требует длину); PK (`record_id`, `key`).
    - `agentKnowledgeSettings`: `id` boolean PK default true, CHECK `id`; `limit_tokens` integer default `KNOWLEDGE_LIMIT_TOKENS_DEFAULT`, CHECK в границах `KNOWLEDGE_LIMIT_TOKENS_MIN`…`MAX`; `lessons_enabled` boolean default true; `updated_at`, `updated_by` null.
  - Миграция: `pnpm --filter @agent-os/contracts build`, затем `pnpm db:generate`. В начало сгенерированного SQL — `CREATE EXTENSION IF NOT EXISTS vector;` (без расширения миграция падает, как требует KD-8), в конец — `INSERT INTO "app"."agent_knowledge_settings" ("id") VALUES (true);` (как строка `library_settings` в `0024_ancient_scarlet_witch.sql`). Исполнитель читает SQL: тип колонки — `vector` без кавычек схемы `app` (тип расширения живёт в `public`); если drizzle-kit написал иначе, правится объявление `customType`, а не SQL. Миграция только добавляет — вопроса «создана или переименована» нет.
  - Тест миграций `packages/db/test/migrations.e2e-spec.ts`: `APP_TABLES` + семь имён (список отсортирован); карта доменов CHECK + `agent_knowledge_relations_kind_check`, `agent_knowledge_runs_last_status_check`, `agent_knowledge_runs_last_reason_check`, `agent_knowledge_vectors_key_kind_check` по `.options` своих схем.
  - Target Files: `packages/db/src/schema.ts`, `packages/db/migrations/0026_*.sql` (generated + две строки), `packages/db/migrations/meta/_journal.json`, `packages/db/migrations/meta/0026_snapshot.json` (generated), `packages/db/test/migrations.e2e-spec.ts`.
  - Не запускать: `pnpm db:migrate`, любые e2e.
  - Dependencies: Task 1.2.
  - Проверка: `pnpm turbo build --filter=@agent-os/db^...`, затем `pnpm --filter @agent-os/db typecheck`; `pnpm --filter @agent-os/db exec drizzle-kit check`. Ревьюер читает SQL: одно `CREATE EXTENSION`, только `CREATE TABLE`, индексы, ограничения и одна вставка; каскады — ровно у ключей Data Model.

#### Operational Verification Procedures

Выполняются после quality gate (правило владельца: проверок на концах фаз нет), на базе разработчика, только чтение (`docker exec infra-postgres-1 psql -U agent -d agent_os -At -c "…"`).

1. `select extversion from pg_extension where extname='vector'` — одна строка.
2. `select limit_tokens, lessons_enabled from app.agent_knowledge_settings` — `8000|t`.
3. `select count(*) from information_schema.tables where table_schema='app' and table_name like 'agent_knowledge_%'` — 7.

### Phase 2: Чистые решения знаний
**Purpose**: Построить три функции, которые решают за код всё, что можно решить без базы: какие операции модели применить, какие сущности показать модели как похожие, что и в каком порядке идёт в промпт и на экран. Каждая — одна таблица unit-теста.

#### Tasks

- [ ] **Task 2.1: Операции модели и `checkOperations`** — covers DD KD-4 (код проверяет и применяет по id, сам не сливает), «Как применяются операции» целиком, Contract «Инструмент модели `record_knowledge`», Invariants 4 (правило), 5 (чтение заново — вход функции), FR-04, FR-05, FR-15, FR-16; AC-04.1, AC-04.2, AC-05.1, AC-16.1, AC-16.2, DC-6, DC-11 (правило)
  - Pattern: [pure-decision.md](../../../code-system/patterns/pure-decision.md).
  - `packages/agents/src/knowledge/operations.ts` (new): zod-схемы аргумента `record_knowledge` (`operations` до 50: `add_entity`, `add_relation` трёх видов, `confirm`, `mark_outdated`; `evidence` — непустой список `c…`; длины `name`, `label`, `question`, `outcome` до 200, `description`, `hint` до 500) и `choose_entities` (`choices`: `ref` и `id` или `null`); константы `KNOWLEDGE_OPERATIONS_MAX = 50`, длины. Схема принимает ответ «как есть» — лишние операции сверх 50 отрезает `checkOperations` с причиной `too_many`, а не схема.
  - `packages/agents/src/knowledge/check-operations.ts` (new): `checkOperations({ graph, calls, operations, mask, roundAt, runId })` → `{ apply, confirm, outdated, rejected: { op, reason }[] }`. Порядок решения — схема «Как checkOperations решает судьбу одной операции»: маска (`mask` — функция, вызывающий передаёт `createSecretMasker([])`) до длин и сравнения; id и ссылки; ссылка подходит к виду (факт — вызов `success`, урок — тот же сервер и инструмент, «искал — не нашёл» — тот же инструмент и `empty`); повтор id в ответе; точный повтор записи графа (имя сущности; вид, концы и текст связи после приведения регистра и пробелов) → подтверждение. Подтверждение: +1, дата раунда, запуск, снять «устарела»; тот же запуск подряд — без прибавки. `mark_outdated` ссылки не требует. Функция не читает базу и не логирует.
  - Target Files: `packages/agents/src/knowledge/operations.ts` (new), `packages/agents/src/knowledge/check-operations.ts` (new), `packages/agents/src/knowledge/check-operations.spec.ts` (new).
  - Не трогает: ничего вне `src/knowledge/`.
  - Dependencies: Task 1.3.
  - Тест: `check-operations.spec.ts` — одна таблица (шапка скелета): связь к `e…` сущности `billing-api` присоединена; `add_entity` ` Billing-API ` — подтверждение, второй сущности нет (AC-04.1); подтверждение урока со ссылкой на вызов `logs.search` — второе подтверждение и дата раунда (AC-16.1), без такого вызова — отклонено (AC-16.2); неизвестный id, повтор id, неверная форма — отклонены, остальные применены (DC-6); урок на вызов другого инструмента и «искал — не нашёл» на вызов не `empty` — отклонены (DC-11); 51-я операция — `too_many`; секрет из памяти процесса в описании — `[redacted]` (AC-05.1); тот же запуск подтверждает второй раз — число не растёт.
  - Проверка: нет ошибок `tsc` в файлах задачи (`pnpm --filter @agent-os/agents typecheck`, читаются только ошибки этих файлов). Ревьюер читает: нет слияния по похожести; каждая ветка отказа даёт причину.

- [ ] **Task 2.2: Похожие сущности: кандидаты и выбор модели** — covers DD KD-4 (второй абзац), Contract «Инструмент модели `choose_entities`», константы `SIMILAR_ENTITY_MIN_SCORE`, `SIMILAR_ENTITY_LIMIT`, FR-20; AC-20.1, DC-17 (правило)
  - Pattern: [pure-decision.md](../../../code-system/patterns/pure-decision.md).
  - `packages/agents/src/knowledge/similar-entities.ts` (new): `SIMILAR_ENTITY_MIN_SCORE = 0.8`, `SIMILAR_ENTITY_LIMIT = 3`; `similarCandidates(newEntities, pairsByRef)` — по каждой новой сущности ключи `e…` с близостью не ниже порога, не больше предела, по убыванию близости; пусто — третьего вызова нет. `applyChoices(operations, candidates, choices)` — выбранный id заменяет `ref` во всех операциях ответа, `add_entity` становится `confirm` с той же ссылкой; id не из кандидатов этой сущности отклоняется, сущность остаётся новой. Код ничего не сливает сам.
  - Target Files: `packages/agents/src/knowledge/similar-entities.ts` (new), `packages/agents/src/knowledge/similar-entities.spec.ts` (new).
  - Dependencies: Task 2.1 (типы операций).
  - Тест: `similar-entities.spec.ts` — одна таблица (шапка скелета): ниже порога и сверх предела — не кандидаты, только `entity`; нет кандидатов — третий вызов не нужен; выбор `billing-api` — `ref` заменён, `add_entity` стала `confirm` (одна сущность, второе подтверждение после `checkOperations`); «оставить» — операции как есть; id не из кандидатов — отклонён, сущность новая.
  - Проверка: нет ошибок `tsc` в файлах задачи.

- [ ] **Task 2.3: `selectKnowledge`, текст блока знаний и поля вида** — covers DD KD-6 (два прохода, общий порядок, размер записи, текст блока: правило вне конверта, строки в `envelope`, общий порядок строк), KD-5 («инструмента больше нет» при чтении, сервер `*`), Contract `KnowledgeView` (`selection`, `counts`, `items`, `state`, `placement`), Terms «Общий порядок», `KNOWLEDGE_BY_MEANING_SHARE`, Invariant 10 (вектор без записи не попадает), FR-06, FR-07, FR-15 (выключатель уроков), FR-17, FR-18 (запись без вектора — во второй проход); AC-04.3, AC-06.1, AC-06.2, AC-06.3, AC-15.3, AC-17.1, AC-18.1 (порядок), DC-9, DC-12
  - Pattern: [pure-decision.md](../../../code-system/patterns/pure-decision.md).
  - `packages/agents/src/knowledge/select-knowledge.ts` (new): `KNOWLEDGE_BY_MEANING_SHARE = 1 / 2`; `selectKnowledge({ items, settings, toolAlive, closeness })` → выбранные записи и размещение каждой. Устаревшие (помеченные или без живого инструмента) и уроки при выключенных уроках в отбор не идут; половина — `floor(limitTokens × share)`; первый проход — по убыванию близости, среди равных по id, пока следующая помещается в половину; второй — остаток предела в общем порядке до первой не поместившейся; ключ без записи отбрасывается. Размер записи — `tokensOfBytes(utf8Bytes(строка))` из `model/token-estimate.ts` (Notes, пункт 5). Здесь же — `knowledgeViewParts` для `Agents.knowledge.view`: `state` (`outdated` старше `lessons_off`), `placement` по правилу `KnowledgeItem`, `counts` по правилу дизайна, порядок `items` (`outdated` в конце, `lessons_off` среди `active`), `selection` по первому подходящему состоянию.
  - `packages/agents/src/knowledge/knowledge-text.ts` (new): строка записи (с id `e12`/`r7` — для входа извлечения, без id — для шага; размер записи в отборе считается по строке шага), постоянное правило блока вне конверта («это подсказка, где искать; каждое утверждение ответа подтверждай вызовом в этом запуске; не называй знание источником»), строки в `envelope('knowledge', …)` из `model/provider-messages.ts` в общем порядке; пустой выбор — `null` (блок не добавляется).
  - Справка по форме (не копировать): `D:\git\github\nookstead\server\apps\server\src\npc-service\memory\MemoryRetrieval.ts` — чистая функция и обрезка по бюджету токенов; не брать взвешенную сумму давности, важности и близости и экспоненциальное затухание: у нас половина по близости, остаток — общий порядок. `…\ai\SystemPromptBuilder.ts` (`buildMemorySection`) — заголовок и строки, пустой раздел не выводится, бюджет решает отбор, а не рендер; текст персонажа не брать.
  - Target Files: `packages/agents/src/knowledge/select-knowledge.ts` (new), `packages/agents/src/knowledge/select-knowledge.spec.ts` (new), `packages/agents/src/knowledge/knowledge-text.ts` (new).
  - Dependencies: Task 1.3.
  - Тест: `select-knowledge.spec.ts` — одна таблица UC-5 (шапка скелета): устаревшая связь и урок без инструмента — `outdated` и не в тексте (AC-04.3, AC-17.1); вернувшийся инструмент возвращает урок (DC-12); до половины — ближайшие, остаток — общий порядок, самая подтверждённая без вектора в тексте (AC-18.1); без пар — весь предел в общем порядке; меньший предел режет в том же порядке, первыми уходят наименее подтверждённые, среди равных — старшие (AC-06.1–AC-06.3); выключенные уроки — `lessons_off`, урок без инструмента остаётся `outdated` (AC-15.3); одинаковый вход — одинаковый текст байт в байт (DC-9); `placement` при `on`/`preparing`/`off` и `null`, когда помещаются все; `counts`; `selection` (`off` с `model_not_selected` и `provider_failed`, `preparing` с `pending`, `on`).
  - Проверка: нет ошибок `tsc` в файлах задачи. Ревьюер читает: строки блока в общем порядке, а не по близости; правило вне `envelope`, данные внутри.

#### Operational Verification Procedures

Unit-таблицы фазы — сами проверки; их прогон — quality gate (Task Q.1).

### Phase 3: Транзакция у `tasks.create`, репозитории, хранилище векторов
**Purpose**: Дать потребителю событий создание задачи в транзакции доставки и положить доступ к таблицам знаний и к векторам в одно место каждый.

#### Tasks

- [ ] **Task 3.1: `runtime.tasks.create(request, tx?)`** — covers DD KD-3 (необязательная транзакция), Contract «`runtime.tasks.create(request, tx?)`», Building-block `runtime.tasks.create` (extended), F5
  - Pattern: [transactional-outbox.md](../../../code-system/patterns/transactional-outbox.md) («Работа по событию»).
  - `packages/runtime/src/task-control.ts`: `create(request: CreateTask, tx?: RuntimeTx)`. С `tx` — тело нынешней транзакции (блокировка родителя, вставка, `task.created`) идёт в ней, без `retryingTransaction`; без `tx` — как сегодня. Повтор транзакции при `tx` — дело вызывающего (релей повторяет доставку). Вызовы без `tx` (`agent-sessions.ts:287`, тесты runtime) не меняются.
  - Target Files: `packages/runtime/src/task-control.ts`; `packages/runtime/src/index.ts`, только если тип `RuntimeTx` ещё не экспортирован.
  - Dependencies: нет.
  - Тест: нового нет — путь с `tx` доказывает INT-1 (задача извлечения появляется после события конца) и INT-3 (одна задача на запуск).
  - Проверка: `pnpm turbo build --filter=@agent-os/runtime^...`, затем `pnpm --filter @agent-os/runtime typecheck`. Ревьюер читает: при `tx` нет второй транзакции и нет повтора внутри.

- [ ] **Task 3.2: Репозитории знаний и очередь записей одного workflow** — covers DD KD-1 (код `agents` не трогает `library_*`), KD-3 (строка запуска: отметка, задача в работе, пометка, итог), KD-5, KD-6 (строка вопроса), KD-7 (настройки, «было» и «стало»), KD-8 (строка векторов workflow: проход, пометка, плательщик, итог), Data Model, Invariants 1, 2 (отметка только вперёд), 5, 8, 13
  - Pattern: [repository-over-transaction.md](../../../code-system/patterns/repository-over-transaction.md), [settings-row.md](../../../code-system/patterns/settings-row.md).
  - `packages/agents/src/knowledge/knowledge.repository.ts` (new): граф — чтение записей workflow, вставка сущностей и связей, подтверждение, пометка, удаление сущности (связи-факты уходят каскадом, функция возвращает число ушедших связей) и связи; `lockGraph(tx, recordId)` — `pg_advisory_xact_lock` по ключу от `recordId`. Его берут коммит раунда и удаление первым действием своей транзакции, после него граф читается заново (Invariant 5; Notes, пункт 7). Настройки — `readKnowledgeSettings`, `writeKnowledgeSettings` (возвращает «было» и «стало»).
  - `packages/agents/src/knowledge/knowledge-runs.repository.ts` (new): строка запуска — создать (из `ensureSession`), найти по `run_id`, по `extract_task_id`, по `last_extract_task_id`; поставить задачу; поставить «нужен ещё раунд»; итог раунда; сдвиг отметки `GREATEST` (только вперёд); последний итог по `record_id` (`lastExtraction`). Строка вопроса — прочитать, записать (`ON CONFLICT (task_id) DO UPDATE`). Строка векторов workflow — получить или создать, поставить проход, пометка «нужен ещё проход», плательщик, итог попытки (итог вопроса пишется, только когда отличается от записанного).
  - Справка по форме (не копировать): `D:\git\github\nookstead\server\apps\server\src\npc-service\memory\MemoryStream.ts` — запись строк drizzle после одного вызова модели; `console.*` и «удалить старые сверх лимита» не брать.
  - Target Files: `packages/agents/src/knowledge/knowledge.repository.ts` (new), `packages/agents/src/knowledge/knowledge-runs.repository.ts` (new).
  - Не трогает: таблицы `library_*`, `runtime_*` (только свои `agent_knowledge_*` и чтение `agent_sessions.owner_id` по `run_id`).
  - Dependencies: Task 1.4, Task 1.2.
  - Тест: нового нет — репозитории работают внутри INT-1–INT-12.
  - Проверка: `pnpm turbo build --filter=@agent-os/agents^...`, затем нет ошибок `tsc` в файлах задачи.

- [ ] **Task 3.3: Порт `KnowledgeVectorStore` и хранилище pgvector** — covers DD KD-8 (порт, четыре операции, фильтры, точный косинус без индекса, граф — источник правды), Contract `KnowledgeVectorStore`, Invariants 10, 11, FR-19; AC-19.1 (через хранилище)
  - `packages/agents/src/knowledge/vector-store.ts` (new): порт — `upsert(collection, items)`, `delete(collection, keys)`, `query(collection, vector, model, limit, kind?)`, `list(collection)`; коллекция — номер записи workflow; сбой базы — исключение.
  - `packages/agents/src/knowledge/pgvector-store.ts` (new): реализация на `agent_knowledge_vectors` своим запросом drizzle — `upsert` по PK заменяет вектор и модель; `query` — `1 - (vector <=> $q)` среди строк коллекции и модели, с `kind` — только этого вида, по убыванию близости, `LIMIT`; `list` — ключи, вид и модель. SQL наружу не уходит.
  - Target Files: `packages/agents/src/knowledge/vector-store.ts` (new), `packages/agents/src/knowledge/pgvector-store.ts` (new), `packages/agents/test/knowledge-vector-store.e2e-spec.ts` (new), `packages/agents/test/support/knowledge.ts` (new, только `withLibraryRow`).
  - Dependencies: Task 1.4.
  - Тест: `knowledge-vector-store.e2e-spec.ts` — одна таблица контракта порта на настоящем pgvector (шапка скелета: «one contract table against real pgvector»): `upsert` того же ключа заменяет вектор и модель, ключ один; `query` возвращает близость по косинусу и только векторы данной модели; с `kind` `entity` связей нет; `delete` неизвестного ключа — не ошибка; `list` — все ключи с моделью; коллекция другого workflow не видна. Нужна настоящая строка `library_records` (каскад) — помощник `withLibraryRow` создаётся здесь, в `packages/agents/test/support/knowledge.ts`, и его же берёт Task 8.1. Тест проходит ревью (хранилище и удаление).
  - Проверка: нет ошибок `tsc` в файлах задачи.

#### Operational Verification Procedures

Тест контракта хранилища — проверка фазы; его прогон — quality gate.

### Phase 4: Флажок в запуске
**Purpose**: Запуск берёт флажок при старте и держит до конца: координатор — из своего содержимого, исполнитель — из поля `learning`, строка запуска — при создании сессии координатора.

#### Tasks

- [ ] **Task 4.1: `learning` в снимке исполнителя; строка запуска в `ensureSession`** — covers DD KD-2 (снимок исполнителя, строка запуска в той же транзакции), Contract «Снимок исполнителя, поле `learning`», Terms «Сессия координатора», Invariant 7, FR-01; AC-01.2
  - Pattern: [run-snapshot.md](../../../code-system/patterns/run-snapshot.md).
  - `packages/agents/src/start/snapshot.ts`: схема снимка `executor` + `learning: z.object({ servers: ServersSchema }).nullable().default(null)` рядом с `origin`; старые снимки читаются с `null`. `RunOrigin` не меняется.
  - `packages/agents/src/start/snapshot-definition.ts`: `executorSnapshot(coordinator, name)` кладёт `learning`: `null`, когда `coordinator.content.selfLearning` ложно, иначе `servers` — объединение серверов всех исполнителей снимка координатора без повторов (`*` сохраняется как есть).
  - `packages/agents/src/store/sessions.repository.ts`: `ensureSession` в той же `tx`, только когда строка сессии создана (`RETURNING` дал строку), снимок — `workflow`, `origin.executor` — `null` и `content.selfLearning` — истина, создаёт строку запуска (`knowledge-runs.repository.ts`) с `record_id` из `origin.recordId` и `servers` команды. Так покрыты все три вызова `ensureSession`: охраняемая запись обработчика, `createAgent` и коммит `start_child`.
  - `packages/workflows/src/runs.spec.ts` (строка 166, литерал снимка `executor`): `learning: null` — иначе `workflows` не компилируется.
  - Target Files: `packages/agents/src/start/snapshot.ts`, `packages/agents/src/start/snapshot-definition.ts`, `packages/agents/src/store/sessions.repository.ts`, `packages/workflows/src/runs.spec.ts`; ещё литерал снимка `executor`, если `tsc` его назовёт.
  - Не трогает: `RunOriginSchema` (`packages/contracts/src/chat.ts`), столбцы `agent_sessions`.
  - Dependencies: Task 1.3, Task 3.2.
  - Тест: нового нет — INT-8 строки 2 и 3 (флажок выключен — блока и строки нет; выключен посреди запуска — идущий запуск держит блок).
  - Проверка: нет ошибок `tsc` в файлах задачи. Ревьюер читает: строка запуска пишется только у сессии координатора; снимок координатора не меняется.

#### Operational Verification Procedures

Проверки фазы — INT-8 (Task 8.4) на gate.

### Phase 5: Извлечение после конца запуска
**Purpose**: Конец запуска ставит одну задачу извлечения; раунд читает новые вызовы, зовёт модель, проверяет операции и пишет граф в коммите; стоп и повторный конец ведут строку запуска по KD-3.

#### Tasks

- [ ] **Task 5.1: Вход извлечения** — covers DD Contract «Вход извлечения» целиком (константы `EXTRACTION_RESULT_BYTES` = 2 000, `EXTRACTION_ARGS_BYTES` = 500, `EXTRACTION_INPUT_BYTES` = 48 000), KD-3 (вызовы после отметки и не позже момента чтения), Invariant 3, F6, F12; NFR-01 (вход — только закончившиеся вызовы)
  - `packages/agents/src/knowledge/extraction-input.ts` (new): по `runtime.tasks.listTree(rootId, ownerId)` и `descendantsOf(tree, runId)` (`src/tools/builtin/list-agents.ts`) — задачи поддерева координатора и сам координатор; из `agent_tool_calls` — только MCP (`server` задан) с исходами `success`, `empty`, `tool_error` и `finished_at` в (`extracted_up_to`, `readAt`]; из `agent_code_calls` — те же правила, без результата, только строки последней попытки (`attempt`) каждого `run_code`, иначе перезапущенный скрипт даёт вызов дважды (Invariant 3). Вызовы — по времени конца; номера `c1…` по порядку; результат обрезан до 2 000 байт, аргументы — до 500; после 48 000 байт — только инструмент, аргументы и исход. Возвращает текст входа в `envelope`, карту `c…` → `{ server, tool, outcome }` для `checkOperations` и счётчики для лога (вызовов, байт, обрезано).
  - Target Files: `packages/agents/src/knowledge/extraction-input.ts` (new).
  - Dependencies: Task 3.2.
  - Тест: нового нет — фильтр исходов и «только новые вызовы» доказывают INT-3 строка A и INT-1.
  - Проверка: нет ошибок `tsc` в файлах задачи.

- [ ] **Task 5.2: Обработчик `knowledge.extract` — раунд извлечения** — covers DD KD-3 (раунд, пометка — продолжить задачу, без пометки — снять номер и завершить; стоп во время раунда — отметка не назад), KD-4 целиком (модель координатора из `agent_sessions.model`, один инструмент, вторая попытка, похожие сущности, не больше трёх вызовов), Flow 1 (Outcome и весь Failure handling), Contract «Задача `knowledge.extract`», Logging «Раунд», Invariants 1, 2, 3, 4, 5; FR-03, FR-04, FR-05, FR-08, FR-20; AC-03.1, AC-03.4, AC-04.2, AC-04.4, AC-08.1–AC-08.3, AC-20.1, DC-3, DC-5, DC-7, DC-8, DC-13, DC-17, NFR-02
  - Pattern: [step-handler.md](../../../code-system/patterns/step-handler.md) (вызовы модели и эмбеддингов вне транзакции, запись — в `commit`).
  - `packages/agents/src/knowledge/extract.handler.ts` (new): `createKnowledgeExtractHandler(deps)` → `TaskHandler` типа `knowledge.extract`, вход `{ runId, rootId }`. Шаг:
    1. Читает строку запуска, сессию координатора (`model`, `owner_id`), граф, настройки, реестр MCP; `readAt` — время чтения. Нет строки запуска или сессии координатора (беседу удалили) — `complete` без записей. Нет новых вызовов — модель не зовётся, итог «готово» с нулями (DC-5).
    2. Отбор графа — `selectKnowledge` без пар близости (общий порядок во весь предел, строки с `e…`/`r…`).
    3. `ModelClient.call` с `instructions` — правило извлечения (что записывать, личные данные не записывать, ссылаться на вызовы `c…`, искать существующее по id), `tools: [record_knowledge]`, `streamsText: false`, `ownerId` — запускающий, `taskId` и `rootId` — задача извлечения, `agentName: 'knowledge-extract'`. `not_started` → «пропущено» с причиной отказа (вызова нет); `model_error` любой причины, в том числе `provider_*` → «сбой: `model_error`», точная причина в лог (DC-13); нет вызова `record_knowledge` или аргументы не прошли схему → вторая попытка с текстом ошибки, снова плохо → «сбой: `invalid_answer`» (DC-7).
    4. Новые сущности ответа → `Agents.embeddings.embed` (`document`, запускающий, эта задача) текстов после маски → `store.query(…, SIMILAR_ENTITY_LIMIT, 'entity')` → `similarCandidates`; есть кандидаты → третий вызов с `choose_entities` → `applyChoices`. Недоступные эмбеддинги, сбой `query`, негодный ответ — операции как есть, причина в лог (DC-17).
    5. `commit`: `lockGraph`; граф читается заново; `checkOperations` с маской `createSecretMasker([])`; запись графа — в точке сохранения (`tx.transaction`), нарушение внешнего ключа на удалённую запись `library_records` отменяет только её, в лог — `record_deleted` (DC-8); итог и отметка `GREATEST(readAt)` в строке запуска; `last_extract_task_id` — эта задача; пометка «нужен ещё раунд» стоит → `continue` и пометка снимается, иначе `extract_task_id` снимается и `complete`. `fail` шаг не возвращает.
  - Логирование — дочерний логгер с `taskId`, `runId`, `recordId`, `ownerId`, `model`: число вызовов и байт входа и сколько обрезано, записей графа и токенов блока, `modelCallId` и номер попытки, точная причина `model_error`, новые сущности, кандидаты с близостью и выбор, операции после маски, отклонённые с причиной, итог, сдвиг отметки, `durationMs`; ошибка — целиком в `error`. Результаты инструментов и тексты эмбеддингов — только размеры.
  - Справка по форме (не копировать): `…\nookstead\server\apps\server\src\npc-service\memory\MemoryStream.ts` — загрузка, один вызов модели с таймаутом, пропуск при пустом ответе, запись; не брать свободный текст вместо разобранных схемой операций, оценку важности и «эмбеддинг без ожидания».
  - Target Files: `packages/agents/src/knowledge/extract.handler.ts` (new).
  - Не трогает: `model/model-client.ts` (Notes, пункт 4).
  - Dependencies: Task 2.1, Task 2.2, Task 2.3, Task 3.2, Task 3.3, Task 5.1.
  - Тест: нового нет — INT-1, INT-3, INT-4, INT-5, INT-6, INT-7.
  - Проверка: нет ошибок `tsc` в файлах задачи. Ревьюер читает: вызовов модели в раунде не больше трёх; ни одной записи графа вне `commit`; отметка не уходит назад.

- [ ] **Task 5.3: Потребитель `agents.knowledge-trigger`** — covers DD KD-3 (создание задачи в транзакции доставки, пометка, `task.stopped` — состояние и отметка, `task.failed` задачи извлечения — `interrupted` и новая задача при пометке), KD-8 (на `task.completed` извлечения — проход векторов или пометка «нужен ещё проход», плательщик — запускающий), C3 «извлечение после конца запуска», State Transitions (строка запуска), Logging «Потребитель», Invariants 1, 2, 13; FR-03; AC-01.1, AC-03.1, AC-03.2, AC-03.3, DC-3, DC-4, NFR-01
  - Pattern: [transactional-outbox.md](../../../code-system/patterns/transactional-outbox.md).
  - `packages/agents/src/knowledge/knowledge-trigger.ts` (new): чистая `triggerDecision(event, runRow, embeddingRow)` → `create_extract` / `mark_round` / `stopped` / `interrupted` (+ новая задача при пометке) / `queue_embed` / `mark_pass` / `release_pass` (+ новый проход при пометке) / `ignore`; и потребитель `createKnowledgeTrigger(deps)` — имя `agents.knowledge-trigger`, типы `task.completed`, `task.failed`, `task.stopped`, версия `RUNTIME_EVENT_SCHEMA_VERSION`. Задача события находится по своим таблицам, без чтения `runtime_tasks` (Notes, пункт 6): координатор — строка запуска по `run_id`; задача извлечения — по `extract_task_id` (сбой) или `last_extract_task_id` (конец); проход векторов — по `pass_task_id`. Строки нет (не учится, или беседу удалили вместе с сессией) — `ignore`.
    - Конец или сбой координатора: задачи в работе нет — `runtime.tasks.create({ type: 'knowledge.extract', ownerId: <owner_id сессии>, input: { runId, rootId: event.rootId } }, tx)` и номер в строку; есть — только «нужен ещё раунд».
    - `task.stopped` координатора: «пропущено: `stopped`» и отметка `GREATEST(event.createdAt)`; задачу не ставит.
    - `task.failed` извлечения: номер снят, «сбой: `interrupted`», при пометке — новая задача.
    - `task.completed` извлечения: строка векторов workflow; прохода нет — задача `knowledge.embed` (`ownerId: PLATFORM_OWNER_ID`, вход `{ recordId }`) и плательщик — владелец извлечения; есть — «нужен ещё проход» и плательщик.
    - `task.failed` прохода векторов: номер снят, при пометке — новый проход (Notes, пункт 8).
  - Логирование: `runId`, `rootId`, `recordId`, `ownerId`, тип события, решение (с номером созданной задачи), `durationMs`.
  - Target Files: `packages/agents/src/knowledge/knowledge-trigger.ts` (new), `packages/agents/src/knowledge/knowledge-trigger.spec.ts` (new).
  - Dependencies: Task 3.1, Task 3.2.
  - Тест: `knowledge-trigger.spec.ts` — одна таблица `triggerDecision` (шапка скелета, `provenAt` «one consumer decision… left to its unit table»): конец координатора без задачи — создать; во время раунда — пометка; стоп — `stopped`; сбой извлечения без пометки — `interrupted`, с пометкой — `interrupted` и новая задача; конец извлечения без прохода — поставить проход, во время прохода — пометка; сбой прохода с пометкой — новый проход; событие чужой задачи — `ignore`. Проводку доказывают INT-1–INT-3. Тест проходит ревью (потребитель, «одна задача на конец»).
  - Проверка: нет ошибок `tsc` в файлах задачи. Ревьюер читает: никаких внешних вызовов в `handle`; задача создаётся только с `tx` доставки.

#### Operational Verification Procedures

Выполняются после gate, только чтение базы разработчика:

1. `select status, count(*) from app.runtime_tasks where type in ('knowledge.extract','knowledge.embed') group by 1` — ни одной задачи не в конечном состоянии.
2. `select status, count(*) from app.runtime_event_deliveries where consumer='agents.knowledge-trigger' group by 1` — нет `needs_attention`.

### Phase 6: Векторы — проход, вопрос сессии, блок в шаге
**Purpose**: Записи получают векторы отдельной задачей, вопрос сессии — один вектор на вопрос, а шаг модели и шаг сжатия — один и тот же блок знаний, отобранный под вопрос.

#### Tasks

- [ ] **Task 6.1: Обработчик `knowledge.embed` — проход векторов** — covers DD KD-8 (проход, пачка, текст записи для вектора, правило расхода, смена модели), Flow 4 (Outcome, Failure handling), Contract «Задача `knowledge.embed`», Logging «Проход векторов», Invariants 10, 11, 13; FR-08 (расход), FR-18, FR-19; AC-08.1, AC-18.4, AC-19.1, DC-16
  - Pattern: [step-handler.md](../../../code-system/patterns/step-handler.md).
  - `packages/agents/src/embeddings/embeddings.ts`: `EMBEDDING_BATCH_SIZE` (100) экспортируется; проход берёт его, второй константы `EMBED_BATCH_ITEMS` нет (Notes, пункт 5).
  - `packages/agents/src/knowledge/embed.handler.ts` (new): `createKnowledgeEmbedHandler(deps)` → тип `knowledge.embed`, вход `{ recordId }`. Шаг: `Agents.embeddings.model()` — `model_not_configured` → итог, `complete`. Иначе `list` коллекции против графа; до `EMBEDDING_BATCH_SIZE` записей без вектора текущей модели; тексты (сущность — имя и описание; факт — начало, связь, конец; урок — инструмент, вид вопроса, подсказка; «искал — не нашёл» — инструмент и вид вопроса; всё после маски); записи без вектора — один вызов `embed` с `ownerId` = плательщик строки (null → платформа), записи с вектором старой модели — отдельный вызов с `ownerId: null`; `taskId` — эта задача; `upsert` векторов и `delete` ключей без записи графа через порт (вне транзакции графа). `commit`: любой ответ `unavailable` — итог попытки в строке векторов (`provider_*`, `provider_error`, `dimension_mismatch` — причина; `owner_disabled` — только лог, итог не меняется), `pass_task_id` и плательщик сняты, `complete`: записи ждут следующего прохода (Flow 4), повторов внутри задачи нет. Пачка посчитана и записи без вектора остались — `continue`; иначе пометка «нужен ещё проход» → `continue` и снять пометку, без неё — снять `pass_task_id` и плательщика и `complete`. `fail` не возвращает.
  - Логирование: `taskId`, `recordId`, на кого расход, модель, сколько без вектора, сколько со старой моделью, посчитано, удалено лишних, итог или точная причина, `durationMs`; тексты не логируются.
  - Target Files: `packages/agents/src/embeddings/embeddings.ts`, `packages/agents/src/knowledge/embed.handler.ts` (new).
  - Dependencies: Task 3.2, Task 3.3.
  - Тест: нового нет — INT-11 (пересчёт на платформу, новые записи на запускающего), INT-12 (проход на запускающего), INT-5 строка B и INT-8 строка 4 (векторы удалённых ключей уходят).
  - Проверка: нет ошибок `tsc` в файлах задачи. Ревьюер читает: два вызова `embed` с разными `ownerId`; сбой эмбеддингов не валит задачу.

- [ ] **Task 6.2: Вектор вопроса сессии в `AgentStepHandler`** — covers DD KD-6 (третий абзац: вектор вопроса до выбора шага, охраняемой записью, строка и при отказе), Flow 2 (Failure handling строк 1 и 3), Contract «Строка вопроса», Logging «Вектор вопроса», Invariant 12; FR-18; AC-18.2, AC-18.3, DC-14
  - Pattern: [step-handler.md](../../../code-system/patterns/step-handler.md).
  - `packages/agents/src/knowledge/question-vector.ts` (new): `questionToEmbed(session, snapshot, ctx.messages, storedRow)` — сессия учится (координатор — `content.selfLearning`, исполнитель — `learning` не `null`); строки вопроса нет → вопрос — `task` сессии (`source: 'task'`); у координатора в `ctx.messages` есть `user_message` новее записанного источника → текст последнего такого сообщения (`source` — его `messageId`); иначе — ничего. `embedQuestion(...)` → `Agents.embeddings.embed({ texts: [вопрос], inputType: 'query', ownerId: <владелец сессии>, taskId: ctx.taskId })`; отказ — строка с пустым вектором и `model` из ответа; итог (причина или пусто) пишется в строку векторов workflow, только когда отличается.
  - `packages/agents/src/step/agent-step.handler.ts`: после `sessionOf` и до выбора шага — чтение строки вопроса (только у учащейся сессии), при необходимости вызов эмбеддингов вне транзакции и запись строки охраняемой записью `ctx.guard` (как `ensureSession`); `fenced` — тот же путь «abandoned without writes». У сессий, которые не учатся, — ни одного лишнего чтения и вызова. `AgentStepHandlerDeps` + `embeddings`, `knowledge` (репозиторий).
  - Логирование: `taskId`, `recordId`, `ownerId`, откуда вопрос, модель, итог или причина `unavailable` с `message`, `durationMs`; текст вопроса не логируется.
  - Target Files: `packages/agents/src/knowledge/question-vector.ts` (new), `packages/agents/src/step/agent-step.handler.ts`.
  - Dependencies: Task 3.2, Task 4.1.
  - Тест: нового нет — INT-12 (один вызов на сессию и на сообщение), INT-10 (отказ — одна попытка на сессию).
  - Проверка: нет ошибок `tsc` в файлах задачи (`create-agents.ts` передаёт новые зависимости в Task 7.1; до неё ошибка вызова в `create-agents.ts` ожидаема и не чинится здесь).

- [ ] **Task 6.3: Блок знаний в шаге модели и шаге сжатия** — covers DD KD-6 (блок — живые данные рядом со снимком, один текст в обоих шагах, граф читается на каждом шаге), KD-5 (живой инструмент по реестру и серверам команды, `*`), C3 «шаг запуска с графом» (`knowledgeBlock` только у учащегося запуска; хранилище — только при векторе вопроса), Flow 2 (Outcome, Failure handling строк 2, 4, 5), Logging «Шаг запуска», «Хранилище»; FR-06, FR-07, FR-17; AC-01.2, AC-07.1, AC-07.3, AC-09.2, AC-18.1, AC-19.1
  - Pattern: [run-snapshot.md](../../../code-system/patterns/run-snapshot.md).
  - `packages/agents/src/knowledge/knowledge-block.ts` (new): `knowledgeBlock(deps, { snapshot, taskId, logger })` → текст или `null`. Не учится — `null` без чтений. Иначе: граф, настройки, реестр (`findServers` + `storedMcpTools` из `src/mcp/`, для `*` — `listServers`; серверы — у координатора серверы исполнителей его `WorkflowContent`, у исполнителя `learning.servers`; `*` — любой сервер реестра), строка вопроса; вектор есть → `store.query(record, vector, model, <число записей>)` (сбой — предупреждение в лог, отбор без пар); `selectKnowledge` → `knowledge-text.ts`. Чтение графа упало — исключение, шаг падает тем же путём, что при сбое чтения истории.
  - `packages/agents/src/step/model-step.ts` и `packages/agents/src/step/compaction-step.ts`: `instructions` = `definition.prompt`, а при блоке — `definition.prompt` + пустая строка + блок; одна функция `withKnowledge(prompt, block)` в `knowledge-block.ts`, оба шага зовут её одинаково (Notes, пункт 4). Без блока текст байт в байт прежний.
  - Логирование: `taskId`, `recordId`, есть ли вектор вопроса, записей по близости, в общем порядке и не поместилось, токенов блока.
  - Target Files: `packages/agents/src/knowledge/knowledge-block.ts` (new), `packages/agents/src/step/model-step.ts`, `packages/agents/src/step/compaction-step.ts`.
  - Не трогает: `model/model-client.ts`, `model/mastra-turn.ts`, `model/provider-messages.ts`.
  - Dependencies: Task 2.3, Task 3.3, Task 4.1, Task 6.2.
  - Тест: нового нет — INT-8 (оба шага, свежее чтение, удаление, флажок), INT-1 (блок в конверте у координатора и исполнителя).
  - Проверка: нет ошибок `tsc` в файлах задачи. Ревьюер читает: шаг сжатия получает тот же `instructions`, что шаг модели; у неучащейся сессии нет новых чтений.

#### Operational Verification Procedures

Проверки фазы — INT-8, INT-10–INT-12 на gate.

### Phase 7: `Agents.knowledge`, сборка `createAgents`, маршруты `apps/api`
**Purpose**: Соединить всё в корне композиции, открыть граф и настройки маршрутами с правилом доступа и аудитом, закрыть черновик из чата от флажка.

#### Tasks

- [ ] **Task 7.1: `Agents.knowledge` и сборка в `createAgents`** — covers DD KD-1 (операции `Agents.knowledge`), KD-7 (настройки: «было» и «стало»), KD-8 (удаление ставит проход в своей транзакции), Contract `Agents.knowledge`, C3 «экран знаний» (`view` без вызова провайдера), Flow 3 (Outcome, Failure handling), Building-block `Agents.knowledge` (composition-root), Invariants 5, 7, 10; FR-02, FR-09 (операции); AC-09.2, DC-10 (204 при повторе — `deleted: false`)
  - Pattern: [composition-root.md](../../../code-system/patterns/composition-root.md).
  - `packages/agents/src/knowledge/knowledge.ts` (new): `createAgentsKnowledge(deps)` → `view({ recordId, selfLearning, servers })` (граф, настройки, живость инструментов по `servers` из входа, `Agents.embeddings.model()`, `list` коллекции, строка векторов, последний итог раунда → `knowledgeViewParts` → `KnowledgeView`, без вызова провайдера; `items[].date` — ISO); `deleteEntity({ recordId, entityId })` → `{ deleted, relations }` и `deleteRelation({ recordId, relationId })` → `{ deleted }` — в одной транзакции: `lockGraph`, удаление, при удалённом — проход векторов: прохода нет — `runtime.tasks.create(…, tx)` и `payer_id = null` (проход только от удалений платит платформа, KD-8); проход идёт — только пометка «нужен ещё проход», плательщик не меняется; `settings()`, `updateSettings({ actorId, limitTokens, lessonsEnabled })` → `{ before, after }`.
  - `packages/agents/src/create-agents.ts`: `Agents.knowledge`; хранилище `createPgvectorStore(database)`; `runtime.handlers.register` для `knowledge.extract` и `knowledge.embed`; `runtime.eventConsumers.register(createKnowledgeTrigger(...))` рядом с `agents.stop-children-on-failure`; новые зависимости `AgentStepHandler`, `modelStep`, `compactionStep`. Новых опций `AgentsOptions` и переменных окружения нет.
  - `packages/agents/src/index.ts`: тип `AgentsKnowledge` и типы входа и ответа его операций.
  - Target Files: `packages/agents/src/knowledge/knowledge.ts` (new), `packages/agents/src/create-agents.ts`, `packages/agents/src/index.ts`.
  - Dependencies: Task 5.2, Task 5.3, Task 6.1, Task 6.2, Task 6.3.
  - Тест: нового нет — INT-9 (маршруты), INT-8 (удаление → следующий шаг), INT-10, INT-11 (вид).
  - Проверка: `pnpm turbo build --filter=@agent-os/workflows^...` (собирает `agents`), затем `pnpm --filter @agent-os/agents typecheck` и `pnpm --filter @agent-os/workflows typecheck` — пакеты целиком без ошибок.

- [ ] **Task 7.2: Правило доступа к графу, память секретов логгера, черновик из чата** — covers DD KD-7 (правило доступа, 404 и 403), Contract `LibraryService.knowledgeTarget`, «Маскировка секретов» (`createAppLogger` кладёт свой список), «`WorkflowContent.selfLearning`» (`draft_record`), Building-block `LibraryService.knowledgeTarget`, `createAppLogger`, `createDraftRecordTool`, Invariant 9; FR-05, FR-09; AC-09.1, AC-09.3, DC-10 (404/403)
  - Pattern: [auth-boundary.md](../../../code-system/patterns/auth-boundary.md), [logging.md](../../../code-system/patterns/logging.md).
  - `apps/api/src/library/library.service.ts`: `knowledgeTarget(actor, recordId)` → `{ selfLearning, servers }` последней версии (серверы всех исполнителей без повторов). Порядок — на чтениях, которые сами 404 не бросают (те, на которых стоят `visibleOr404` и `panelOr404`; `visibleOr404` бросает 404 раньше проверки панели): запись видна сотруднику и он автор — открыт; иначе `actor.isAdmin` и запись в панели (предикат `inPanel` из `library.repository.ts`) — открыт; запись не видна ни там, ни там, или это агент — `RECORD_NOT_FOUND`; видна, но права нет — `KNOWLEDGE_FORBIDDEN`. id не UUID — 404 без чтения, как сегодня.
  - `apps/api/src/logging/app-logger.ts`: `createAppLogger` зовёт `rememberSecret` для каждого значения `collectSecrets(env)` до создания логгера — маска извлечения (`createSecretMasker([])`) скрывает то же, что логгер.
  - `apps/api/src/chat/draft-record.tool.ts`: в `prepare` после разбора содержимого у workflow `selfLearning` заменяется — у черновика правки значением `record.content.selfLearning` правимой версии из `library.resolve`, у новой записи — `false`, что бы ни прислала модель. Текст `DESCRIPTION` поле не называет.
  - Target Files: `apps/api/src/library/library.service.ts`, `apps/api/src/logging/app-logger.ts`, `apps/api/src/chat/draft-record.tool.ts`.
  - Не трогает: `record-view.ts`, `library.repository.ts` (кроме экспорта предиката, если `panelOr404` его не покрывает).
  - Dependencies: Task 1.3, Task 7.1 (проверка собирает `agents`).
  - Тест: нового нет — правило доступа доказывает INT-9 (строки 1–4, одно доказательство; шапка скелета `apps/api`). Invariant 9 автоматическим тестом не покрыт: правило владельца — только тесты скелета и названные unit-таблицы; ревьюер читает обе ветки `prepare` (Notes, пункт 9).
  - Проверка: `pnpm turbo build --filter=api^...`, затем нет ошибок `tsc` в файлах задачи (`pnpm --filter api typecheck`).

- [ ] **Task 7.3: Маршруты графа и настроек, модуль `KnowledgeApiModule`** — covers DD KD-7 (один маршрут для библиотеки и панели, аудит без текста, настройки под `@AdminOnly()` с `admin_change`), Contract «Для части `web`» (пять маршрутов, ответы, ошибки, 204 при повторе), C3 «экран знаний», Flow 3, Logging «Маршруты», Security Considerations (Authentication & Authorization, Sensitive Data Handling — аудит); FR-09, FR-12 (сервер); AC-09.1, AC-09.2, AC-09.3, DC-2, DC-10
  - Pattern: [port-module-split.md](../../../code-system/patterns/port-module-split.md), [auth-boundary.md](../../../code-system/patterns/auth-boundary.md).
  - `apps/api/src/knowledge/knowledge.controller.ts` (new): `GET /api/library/:id/knowledge` → `knowledgeTarget` → `agents.knowledge.view` → `KnowledgeView`; `DELETE …/knowledge/entities/:entityId` и `…/relations/:relationId` → `knowledgeTarget` → удаление → 204; при `deleted` — `auditLog.record(null, { kind: 'knowledge_delete', actor, objectType: 'library_record', objectId: recordId, after: { type, id }, outcome: 'ok' })` без текста записи; повтор — 204 без аудита. `entityId`/`relationId`, который не целое больше нуля, отвечает 204 без удаления, как уже удалённая запись (такой записи нет; Contract: «204, в том числе когда сущности уже нет»). Сотрудник — `req.user` (`AuthedRequest`).
  - `apps/api/src/knowledge/admin-knowledge-settings.controller.ts` (new): `@Controller('admin/knowledge') @AdminOnly()`; `GET settings` → `KnowledgeSettings`; `PUT settings` с `ZodValidationPipe(UpdateKnowledgeSettingsBodySchema)` → `updateSettings` → аудит `admin_change`, `objectType: 'knowledge_settings'`, `before`, `after` (как `admin-model-providers.controller.ts`).
  - `apps/api/src/knowledge/knowledge-api.module.ts` (new): импортирует `LibraryModule`, `AgentsModule`, `AuditModule`; контроллеры выше. `apps/api/src/app.module.ts` импортирует его рядом с `LibraryApiModule`.
  - Логирование: сотрудник, `recordId`, действие, итог (`ok`, 404, 403), id удалённой записи без текста, `durationMs`; настройки — «было» и «стало».
  - Target Files: `apps/api/src/knowledge/knowledge.controller.ts` (new), `apps/api/src/knowledge/admin-knowledge-settings.controller.ts` (new), `apps/api/src/knowledge/knowledge-api.module.ts` (new), `apps/api/src/app.module.ts`.
  - Dependencies: Task 7.1, Task 7.2.
  - Тест: нового нет — INT-9. 401 и `ADMIN_REQUIRED` новых маршрутов берёт обход маршрутов `enterprise-access-identity` INT-1 сам (маршруты читаются из роутера).
  - Проверка: `pnpm turbo build --filter=api^...`, затем `pnpm --filter api typecheck` — пакет целиком без ошибок. Ревьюер читает: правило доступа только в `knowledgeTarget`; аудит не держит текст.

#### Operational Verification Procedures

Выполняются после gate:

1. `grep -rn "console\." packages/agents/src/knowledge apps/api/src/knowledge` — пусто.
2. `grep -rnE "logger\.[a-z]+\([^)]*(description|hint|resultText|result_text|texts|question)" packages/agents/src/knowledge apps/api/src/knowledge` — ни один вызов не передаёт текст записи, результата инструмента или вопроса.

### Phase 8: Опоры тестов и интеграционные тесты
**Purpose**: Закрыть пробелы опор, названные шапками скелетов, и заполнить двенадцать случаев скелетов. Тесты пишутся, но не запускаются.

#### Tasks

- [ ] **Task 8.1: Опоры `agents` для знаний** — covers шапка скелета `packages/agents`, HARNESS GAP (a)–(d) и опоры v1.0 (реальная строка `library_records`, чтение через `Agents.knowledge.view`, конец/стоп/продолжение координатора, защёлка на вызове извлечения)
  - `packages/agents/src/testing.ts`: `RecordedModelCall` + `instructions` (системный текст вызова; сегодня его нет — Notes, пункт 10); `createScriptedEmbeddings` + изменяемое свойство `vectorOf: ((text) => number[]) | null` — при заданном вектор берётся из него (близость «по теме» задаётся текстом), иначе нынешнее правило; `createAccessGateDouble` — изменяемый вердикт `embedding` (модель A → B, «не выбрана»).
  - `packages/agents/test/support/agentsHarness.ts`: опция и поле `embeddings` (тот же `ScriptedEmbeddings`, который получает `createAgents`) и `embeddingVerdict` (изменяемый, по умолчанию `model_not_configured`); модели эмбеддингов на провайдере `agents-harness` (вид `openai_compatible` эмбеддинги отдаёт — `PROVIDER_KINDS`).
  - `packages/agents/test/support/knowledge.ts` (создан в Task 3.3 с `withLibraryRow` — строка `app.library_records` с id записи двойника, удаляется после теста, каскад уносит граф и векторы): `seedGraph(db, recordId, items, vectors?)` — строки графа и векторов прямо в таблицы; `runEmbedPass(harness, recordId)` — ждёт конца задачи `knowledge.embed` записи; `knowledgeView(harness, recordId)`; `embeddingLedgerRows(db, { ownerId, taskId })` — строки `runtime_model_calls` эмбеддингов по владельцу и задаче; `extractTasksOf(db, runId)`; защёлка вызова извлечения — ответ скрипта по ключу `{ agent: 'knowledge-extract' }` с `latch`.
  - Конец, стоп и продолжение координатора — через `harness.sessions` (`stop`, `send` завершённому агенту); новых обёрток не нужно.
  - Target Files: `packages/agents/src/testing.ts`, `packages/agents/test/support/agentsHarness.ts`, `packages/agents/test/support/knowledge.ts`.
  - Не трогает: `packages/agents/test/support/fake-provider.ts`, `codeRunChild*.ts`.
  - Dependencies: Task 7.1.
  - Проверка: `pnpm turbo build --filter=@agent-os/workflows^...`, затем `pnpm --filter @agent-os/agents typecheck` и `pnpm --filter @agent-os/workflows typecheck`. Опоры проходят ревью тестов (harness).

- [ ] **Task 8.2: INT-1, INT-2, INT-3 — извлечение после конца, стоп, повторный конец** — covers DD Test Strategy UC-1, UC-4, UC-E1; AC-01.1, AC-03.1, AC-07.3, AC-08.1 (половина извлечения), AC-08.3, AC-15.1, AC-15.2, NFR-01 → INT-1; AC-03.2, DC-3 → INT-2; AC-03.3, DC-4, DC-5 → INT-3
  - Файл: `packages/agents/test/self-learning-core.int.e2e-spec.ts` — `it.todo` INT-1, INT-2, INT-3 заменяются тестами по строкам скелета. Вызов извлечения скрипта — по ключу `{ agent: 'knowledge-extract' }`; «модель A после смены на B» — правка записи двойника после старта, вызов извлечения в `script.calls` с моделью A; «расход запускающего вырос» — `ledgerRowsOf` по владельцу.
  - Target Files: `packages/agents/test/self-learning-core.int.e2e-spec.ts`.
  - Dependencies: Task 8.1.
  - Проверка: `pnpm --filter @agent-os/agents typecheck`. Тест проходит ревью (потребитель, «одна задача на конец»).

- [ ] **Task 8.3: INT-4, INT-5, INT-6, INT-7 — конкурентность, удаление, отказ модели, операции** — covers UC-E6, UC-N1 → INT-4 (AC-04.4, NFR-02); UC-E5, UC-E9 (строка workflow) → INT-5 (AC-04.2 удалённая запись, AC-02.3 удаление, AC-19.1 половина workflow, DC-8, DC-16); UC-E2, UC-E3, UC-E4 → INT-6 (AC-03.4, AC-08.2, DC-7, DC-13); UC-6 (проводка) → INT-7 (AC-04.2, AC-16.2, AC-05.1)
  - Тот же файл: INT-4 строка B — второй экземпляр с `zombie` и `expireLease` (приём INT-3 строки E `agent-platform-agents.int.e2e-spec.ts`); INT-6 строка A — `ownerModelRefusals` / квота; строка B — `modelError(503)` скрипта; INT-7 — секрет через `rememberSecret` прогона.
  - Target Files: `packages/agents/test/self-learning-core.int.e2e-spec.ts`.
  - Dependencies: Task 8.2 (тот же файл).
  - Проверка: `pnpm --filter @agent-os/agents typecheck`. Тесты INT-4 и INT-5 проходят ревью (конкурентность, удаление).

- [ ] **Task 8.4: INT-8, INT-10, INT-11, INT-12 — блок в шаге, эмбеддинги** — covers UC-2, UC-7, UC-E9 (строка сущности) → INT-8 (AC-01.2, AC-02.2, AC-07.1, AC-07.3, AC-09.2, AC-18.1 проводка, AC-19.1 половина сущности); UC-E7 → INT-10 (AC-18.3); UC-E8 → INT-11 (AC-18.4, AC-08.1 пересчёт на платформу); UC-9 → INT-12 (AC-18.2, AC-08.1 эмбеддинги на запускающего, DC-14)
  - Тот же файл. Системный текст — `script.calls[].instructions`; близость — `embeddings.vectorOf`; модель A → B — `embeddingVerdict`; 5xx — `embeddings.failure`; предел — `KNOWLEDGE_LIMIT_TOKENS_MIN` через `Agents.knowledge.updateSettings` с восстановлением прежних настроек в `afterAll` (настройки — одна строка на базу разработчика).
  - Target Files: `packages/agents/test/self-learning-core.int.e2e-spec.ts`.
  - Dependencies: Task 8.3 (тот же файл).
  - Проверка: `pnpm --filter @agent-os/agents typecheck`. INT-11 и INT-12 проходят ревью (расход).

- [ ] **Task 8.5: INT-9 — доступ к графу через API** — covers UC-8; AC-09.1, AC-09.2 (маршрут удаления), AC-09.3, DC-2, DC-10 → INT-9
  - `apps/api/test/support/knowledge.ts` (new): `seedKnowledge(pool, recordId, …)` — сущности, связь-факт, урок с заполненными столбцами запуска; чтение аудита — `auditOfRecord` из `support/library.ts` (отдаёт `after`; `auditOf` из `access.ts` его не отдаёт). Модель эмбеддингов по умолчанию на время файла — `null` через `PUT /api/admin/model-defaults`, прежняя восстанавливается в `afterAll` (строка 1 ждёт `model_not_selected`).
  - `apps/api/test/self-learning-core.int.e2e-spec.ts`: `it.todo` INT-9 заменяется таблицей из пяти строк скелета. Модель эмбеддингов не выбирается; модель не зовётся.
  - Target Files: `apps/api/test/support/knowledge.ts` (new), `apps/api/test/self-learning-core.int.e2e-spec.ts`.
  - Dependencies: Task 7.3.
  - Проверка: `pnpm turbo build --filter=api^...`, затем `pnpm --filter api typecheck`.

#### Operational Verification Procedures

Интеграционные тесты фазы — сами проверки точек стыка; их прогон — quality gate.

### Final Phase: Quality Assurance (Required)
**Purpose**: Переключить базу разработчика на образ с pgvector, пройти один quality gate части, ревью тестов риск-задач, аудит и проверки фаз.

#### Tasks

- [ ] **Task Q.1: Quality gate**
  0. База разработчика (порядок — Notes, пункт 3): резервная копия вне репозитория, счёт строк, пересоздание контейнера с новым образом на том же томе, проверка версии, сопоставлений и расширения. Итог — в Progress Tracking.
  1. Каждая команда отдельно (`pnpm check` одной командой останавливается на первой упавшей задаче): `pnpm turbo lint --continue`, `pnpm turbo typecheck --continue`, `pnpm turbo build --continue`, `pnpm turbo test --continue`, `pnpm knip`.
  2. `pnpm db:generate` не меняет `packages/db/migrations`; `pnpm --filter @agent-os/db exec drizzle-kit check`.
  3. В порядке CI: `pnpm turbo build --filter=api...`, `pnpm --filter @agent-os/code-runner test:e2e`, `pnpm --filter api db:migrate` (миграция 0026 — впервые здесь), `pnpm --filter @agent-os/db test:e2e`, `pnpm --filter @agent-os/runtime test:e2e`, `pnpm --filter @agent-os/agents test:e2e`, `pnpm --filter @agent-os/workflows test:e2e`, `pnpm --filter api test:e2e`.
  - Падения исправляются, gate повторяется целиком, начиная с шага 1.
- [ ] **Task Q.2: Ревью тестов и аудит** — `integration-test-reviewer` по Task 3.3, Task 5.3, Task 8.1–8.4 (хранилище и удаление, потребитель, опоры, конкурентность, расход); один `test-auditor` по тестам части; исправления — до повторного Task Q.1.
- [ ] **Task Q.3: Процедуры фаз** — Operational Verification Procedures Phase 1, 5, 7 по порядку; итог в Progress Tracking.
- [ ] Каждый AC FR-01–FR-09, FR-15–FR-20 доказан по `acProof` шапки `packages/agents/test/self-learning-core.int.e2e-spec.ts` (INT или unit-таблица) и проходит; не автоматизированные — в Owner Checklist.
- [ ] Тесты в бюджете части: двенадцать INT скелетов; unit-таблицы `check-operations.spec.ts`, `similar-entities.spec.ts`, `select-knowledge.spec.ts`, `knowledge-trigger.spec.ts`, `knowledge.spec.ts` (`contracts`); контракт порта `knowledge-vector-store.e2e-spec.ts`. Ничего сверх.

#### Operational Verification Procedures

1. Task Q.1 зелёный: все команды шагов 1–3 без ошибок.
2. Процедуры Phase 1, 5, 7 (Task Q.3) дали ожидаемый результат.
3. После gate в базе разработчика нет строк прогона: `select count(*) from app.agent_knowledge_entities` и то же для `app.agent_knowledge_vectors` — столько же, сколько до gate (0, пока владелец не включал самообучение); настройки знаний — `8000|t`; `select embedding_model from app.access_model_defaults` — значение до gate.

## Verification Strategy

- **Correctness definition and method**: учащийся запуск после конца даёт ровно одну задачу извлечения; раунд читает только новые вызовы своего поддерева, зовёт модель координатора не больше трёх раз, применяет только проверенные операции без секретов и пишет граф атомарно; шаг получает граф, свежий на момент шага, в конверте данных, не больше предела, отобранный под вопрос; векторы считаются вне шагов и пишутся на того, кто платит по KD-8; граф видят и чистят только автор и администратор при workflow в панели. Решения — unit-таблицами у чистых функций; хранилище — таблицей контракта на настоящем pgvector; проводка, конкурентность, рестарт, удаление и расход — INT-1–INT-12 на настоящем Postgres.
- **Early verification point**: первый прогон — quality gate. Первыми смотрятся `check-operations.spec.ts` и INT-7 (главный риск), затем INT-3 и INT-4 (одна задача на конец, конкурентность). Если падает INT-4 строка A, исправляется порядок блокировки и повторного чтения в `commit` раунда (Task 5.2), а не тест.
- **Output comparison**: у workflow без флажка системный текст шага байт в байт прежний (INT-8 строка 2); нынешние e2e `agents`, `workflows`, `api` проходят без изменений, кроме литералов Task 1.3.
- **Proof obligations** (строки «Catches» скелетов):
  - INT-1: извлечение на автора или ни на кого, на модели после смены, раньше конца запуска; граф, который следующий запуск не получает или получает вне конверта.
  - INT-2: вызовы остановленного отрезка в графе после продолжения; поздний раунд двигает отметку назад.
  - INT-3: две задачи извлечения одного запуска; повторное извлечение первых вызовов; вызов модели при конце без новых вызовов.
  - INT-4: потерянная запись или дубликат сущности двух коммитов; неатомарный коммит после рестарта.
  - INT-5: нарушение ключа валит шаг или паркует доставку; граф-сирота; векторы удалённого workflow.
  - INT-6: отказанный вызов тратит токены; неудачный раунд двигает отметку; причина провайдера вне списка контракта; третий вызов после негодного ответа.
  - INT-7: одна плохая операция губит ответ; повтор строки графа подтверждает себя; секрет в графе.
  - INT-8: сжатие без блока; граф, закэшированный на старте; блок у неучащегося workflow; первый проход игнорирует хранимый вектор; удалённая запись найдена по оставшемуся вектору.
  - INT-9: граф читает или чистит тот, кто может только запускать; администратор видит личный workflow; аудит хранит текст.
  - INT-10: сбой эмбеддингов валит запуск; сбойный вызов на каждом шаге; пустой блок вместо общего порядка; вид обещает `by_topic`.
  - INT-11: сравнение векторов разных моделей; запуск ждёт пересчёта; записи навсегда на старой модели; пересчёт на сотрудника.
  - INT-12: вектор вопроса на каждом шаге; новое сообщение оставляет старую тему; расход эмбеддингов ни на кого или не на того.

## Risks and Countermeasures

- **Risk**: База разработчика теряет данные или индексы при смене образа.
  - **Impact**: Высокое: потеря рабочей базы владельца.
  - **Countermeasure**: Та же major-версия и тот же Debian (glibc 2.41, `datcollversion` совпадает), тот же том; `pg_dump` вне репозитория и счёт строк до и после (Task Q.1 шаг 0, Notes пункт 3); проверка тега в Task 1.1.
- **Risk**: Неверное или подброшенное знание закрепляется.
  - **Impact**: Высокое: ложные подсказки во всех запусках workflow.
  - **Countermeasure**: Ссылка на вызов этого запуска и проверка вида вызова (Task 2.1), конверт данных и правило проверки (Task 2.3, Task 6.3), удаление автором (Task 7.3); INT-7, INT-1; ревью тестов.
- **Risk**: Секрет попадает в граф или лог.
  - **Impact**: Высокое: секрет в общем графе и у провайдера эмбеддингов.
  - **Countermeasure**: Маска до проверки длин (Task 2.1), список логгера в памяти секретов (Task 7.2), тексты не логируются (Task 5.2, 6.1, 6.2; OVP Phase 7); INT-7.
- **Risk**: Два коммита одного workflow или коммит и удаление идут вперемешку.
  - **Impact**: Дубликаты сущностей, потерянные подтверждения.
  - **Countermeasure**: `lockGraph` первым действием обеих транзакций и повторное чтение графа после него (Task 3.2, 5.2, 7.1); INT-4 строка A.
- **Risk**: Потребитель создаёт задачу вне транзакции доставки или две задачи на один конец.
  - **Impact**: Двойное извлечение и двойной расход.
  - **Countermeasure**: `tasks.create(request, tx)` (Task 3.1), строка запуска держит номер (Task 5.3); `knowledge-trigger.spec.ts`, INT-3.
- **Risk**: Скриптовые векторы по длине текста не дают близости «по смыслу».
  - **Impact**: INT-8, INT-11, INT-12 проверяли бы случайный порядок.
  - **Countermeasure**: `vectorOf` у двойника (Task 8.1).
- **Risk**: e2e пишут в базу разработчика: настройки знаний — одна строка, модели по умолчанию — одна строка.
  - **Impact**: После тестов предел или модель эмбеддингов разработчика другие.
  - **Countermeasure**: Восстановление настроек и `useRunModels` с восстановлением в `afterAll` (Task 8.4, 8.5); OVP финальной фазы.
- **Risk**: CI запускает e2e на чистой базе.
  - **Impact**: Тест, опирающийся на строки разработчика, падает только в CI.
  - **Countermeasure**: Каждый тест сам создаёт запись `library_records`, сотрудников, модели (Task 8.1, 8.5).
- **Risk**: Тесты пишутся без прогона до gate.
  - **Impact**: Ошибки всплывают разом в конце.
  - **Countermeasure**: Проверка типов в каждой задаче; ревью тестов риск-задач (Task Q.2).

## Notes

1. **Правила владельца.** Задача пишет тесты, но не запускает их; внутри задачи — проверка типов и чтение. Коммитов нет, worktree, stash и reset нет, задачи идут по одной. Единственный gate — Task Q.1; `pnpm db:migrate`, любые e2e и `docker compose up` до него не запускаются. Ревью тестов — только Task 3.3, 5.3, 8.1–8.4; один аудит в Task Q.2. Логирование — только через обёртку `common` с идентификаторами; новых переменных окружения нет; код, который теряет последнего вызывающего, удаляется в той же задаче.
2. **Решение владельца до gate: целевая база.** KD-8 и Risks дизайна: база без расширения `vector` не проходит миграцию 0026, и `api` не стартует. Образы разработки и CI меняет Task 1.1; любую другую базу, где поднимается `api`, владелец проверяет сам (`select * from pg_available_extensions where name='vector'`).
3. **Переключение базы разработчика (Task Q.1, шаг 0).** Контейнер `infra-postgres-1` (проект compose `infra`, том `infra_pgdata`, порт 5433 через `POSTGRES_PORT=5433`, PostgreSQL 16.15 на Debian trixie). Порядок: (1) `docker exec infra-postgres-1 pg_dump -U agent -d agent_os -Fc -f /tmp/agent_os.dump` и `docker cp infra-postgres-1:/tmp/agent_os.dump <папка вне репозитория>`; размер файла больше нуля; (2) счёт строк каждой таблицы `app` в файл; (3) `POSTGRES_PORT=5433 docker compose -f infra/docker-compose.yml up -d postgres` — compose пересоздаёт контейнер с новым образом на том же томе; (4) `select version()` — 16.x, `select datname, datcollversion, pg_database_collation_actual_version(oid) from pg_database where datname <> 'template0'` — версии совпадают (у `template0` версии нет), `select name from pg_available_extensions where name='vector'` — одна строка; (5) счёт строк совпадает с шагом 2. Расхождение версий сопоставлений или строк — стоп, возврат на `postgres:16` тем же томом и сообщение владельцу. Миграция 0026 применяется только шагом 3 gate.
4. **Где строится системный текст (дизайн расходится с кодом).** Дизайн пишет, что шаг модели и шаг сжатия строят системный текст. В коде оба передают `definition.prompt` как `instructions`, а `ModelClient.call` (`model-client.ts:472`) дописывает `DATA_PREAMBLE` и `CODE_RULE`. План кладёт блок в `instructions` одной функцией `withKnowledge` в обоих шагах (Task 6.3) — один текст в обоих вызовах, как требует KD-6; `ModelClient` и `mastra-turn.ts` не меняются. Следствие: вызов извлечения тоже получает `CODE_RULE` о `run_code`, которого у него нет. Рекомендуемое и принятое: оставить — инструкция раунда велит вызвать только `record_knowledge`, а негодный ответ уже даёт вторую попытку. Если владелец решит иначе, `ModelClient.call` дописывает `CODE_RULE` только при `run_code` среди инструментов (одна строка, Task 5.2).
5. **Константы, которых в коде нет там, где пишет дизайн.** `BYTES_PER_TOKEN` не экспортируется из `model-client.ts`: оценка — `utf8Bytes` и `tokensOfBytes` из `model/token-estimate.ts` (те же 4 байта на токен). `EMBED_BATCH_ITEMS` — это `EMBEDDING_BATCH_SIZE` службы (100, сегодня не экспортирован): Task 6.1 экспортирует его, второй константы нет.
6. **Как потребитель узнаёт задачу события.** В событии нет владельца и типа задачи, а `agents` не читает `runtime_tasks`. Потребитель ищет задачу по своим строкам: координатор — по `agent_knowledge_runs.run_id`, сбой извлечения — по `extract_task_id`, конец извлечения — по `last_extract_task_id` (столбец сверх Data Model, пишет коммит раунда), проход векторов — по `agent_knowledge_embedding.pass_task_id`. Владелец — `agent_sessions.owner_id` сессии координатора.
7. **Очередь записей одного workflow (Invariant 5).** Дизайн требует, чтобы коммиты извлечения и удаления одного workflow шли по очереди, но механизм не называет. План: `pg_advisory_xact_lock` по ключу от `recordId` первым действием транзакции и чтение графа после него. Строки, которую можно было бы запереть до первой записи графа, у workflow нет, а `library_records` код `agents` не читает (KD-1).
8. **Сбой задачи прохода векторов.** Дизайн описывает сбой задачи извлечения (`interrupted`), но не прохода векторов: без ветки строка навсегда держала бы `pass_task_id`, и проходов больше не было бы. Task 5.3 снимает номер и при пометке ставит новый проход — так же, как для извлечения.
9. **Invariant 9 без своего теста.** Правило «черновик из чата не меняет флажок» строит Task 7.2; правило владельца ограничивает тесты скелетами и названными таблицами, а в скелетах строки черновика нет (UC-2 дизайна её называет, скелет — нет). Ревьюер читает обе ветки `prepare`; если владелец захочет тест — одна строка в INT-9 или unit-таблица `draft-record.tool`.
10. **Опоры, которых нет сегодня.** Скриптовая модель не записывает системный текст вызова агента, опора `agents` не отдаёт двойник эмбеддингов наружу и не задаёт вердикт `embedding`, а скриптовые векторы зависят только от длины текста. Всё это добавляет Task 8.1; шапка скелета называет пробелы (a)–(d) и строку `library_records`.
11. **Сессия создаётся в трёх местах.** `ensureSession` — единственная вставка в `agent_sessions`, но её зовут охраняемая запись обработчика, `createAgent` и коммит `start_child`; сессия бывает создана до первого шага. Поэтому строка запуска пишется внутри `ensureSession` (Task 4.1), а «первый шаг сессии» для вектора вопроса — это отсутствие строки вопроса (Task 6.2).
12. **Стоп и удаление беседы.** `stopTree` даёт `task.stopped` каждой задаче дерева; потребитель реагирует только на задачи со строкой запуска. Удаление беседы останавливает и удаляет дерево: строка запуска может уйти каскадом раньше доставки — тогда `ignore`.
13. **Справка из другого репозитория.** `D:\git\github\nookstead\server` — только чтение, ничего не импортируется и не копируется; названные файлы показывают форму (Task 2.3, 3.2, 5.2).
14. **Поиск по коду.** Пути и символы проверены четырьмя проходами `code-explorer` и чтением; потребители найдены текстовым поиском и прочитаны (LSP `findReferences` в этом репозитории видит только ссылки внутри файла).

## Progress Tracking

| Пункт | Задача | Результат |
|---|---|---|
| Тег образа pgvector: Debian, версия PostgreSQL, `vector.control` | Task 1.1 | |
| База разработчика: путь копии, счёт строк до и после, версии сопоставлений, расширение доступно | Task Q.1, шаг 0 | |
| Итог gate: команды, число повторов, что исправлено | Task Q.1 | |
| Вердикты ревью тестов и аудита | Task Q.2 | |
| Итоги процедур Phase 1, 5, 7 | Task Q.3 | |

## Owner Checklist (manual, not tasks)

- [ ] AC-07.2: ответ запуска с графом не называет граф источником и подтверждает знание вызовом — по критериям успеха PRD на настоящей модели.
- [ ] AC-02.1, копия в AC-02.3: новая версия workflow получает тот же граф, копия — пустой (граф привязан к номеру записи по построению).
- [ ] Порог `SIMILAR_ENTITY_MIN_SCORE` = 0.8 на первых настоящих извлечениях: лишние третьи вызовы или дубликаты сущностей (Risks дизайна).
- [ ] Целевая база с расширением `vector` (Notes, пункт 2).

## Appendix: Traceability

### Reference Contract Values

| Design Doc (§ Section) | Contract Type | Required Observable Value (verbatim) | Covered By Task(s) |
|---|---|---|---|
| design-core.md (§ Для части `web`) | constants | Там же константы предела `KNOWLEDGE_LIMIT_TOKENS_MIN` = 1 000, `KNOWLEDGE_LIMIT_TOKENS_MAX` = 32 000 и `KNOWLEDGE_LIMIT_TOKENS_DEFAULT` = 8 000; умолчание столбца `limit_tokens` берётся из `KNOWLEDGE_LIMIT_TOKENS_DEFAULT`, как `RECORD_MAX_TURNS_DEFAULT` у `library_settings`. | Task 1.2, Task 1.4 |
| design-core.md (§ Для части `web`) | error | `KNOWLEDGE_FORBIDDEN` — 403, новый член `LibraryErrorCode` в `packages/contracts/src/library.ts`. | Task 1.2, Task 7.2 |
| design-core.md (§ Для части `web`) | http | **`GET /api/library/:id/knowledge`** — граф workflow для экрана знаний. Возвращает `KnowledgeView`. 404 `RECORD_NOT_FOUND`, когда записи нет, она не видна сотруднику ни в библиотеке, ни в панели, или это агент; 403 `KNOWLEDGE_FORBIDDEN`, когда workflow виден, но сотрудник не автор и не администратор при workflow в панели. | Task 7.2, Task 7.3, Task 8.5 |
| design-core.md (§ Для части `web`) | http | **`DELETE /api/library/:id/knowledge/entities/:entityId`** — удаляет сущность и все связи-факты с ней. 204, в том числе когда сущности уже нет. Те же 404 и 403. Аудит `knowledge_delete` — только когда что-то удалено. | Task 7.1, Task 7.3, Task 8.5 |
| design-core.md (§ Для части `web`) | http | **`PUT /api/admin/knowledge/settings`** — под `@AdminOnly()`, тело `limitTokens` и `lessonsEnabled`. Возвращает `KnowledgeSettings`. 400 `VALIDATION_FAILED`, когда значение вне границ; ничего не меняется. Аудит `admin_change` по объекту `knowledge_settings`. | Task 1.2, Task 7.3 |
| design-core.md (§ Внутри платформы) | state-lifecycle-negative | Модель его не задаёт: `prepare` инструмента `draft_record` (`createDraftRecordTool`) после разбора содержимого ставит в черновик правки значение правимой версии записи из `LibraryService.resolve`, а в черновик новой записи — `false`, что бы ни прислала модель. | Task 7.2 |
| design-core.md (§ Внутри платформы) | signature | **`runtime.tasks.create(request, tx?)`** — с транзакцией пишет задачу и `task.created` в ней и не повторяет транзакцию сам; без неё работает как сегодня. | Task 3.1 |
| design-core.md (§ Внутри платформы) | task | **Задача `knowledge.extract`** — корневая, владелец — запускающий; вход: `runId` (номер задачи координатора) и `rootId` (корень беседы). Шаг всегда завершает задачу сам и пишет итог в строку запуска; `fail` он не возвращает. | Task 5.2, Task 5.3 |
| design-core.md (§ Внутри платформы) | task | Вход — `recordId`. Шаг берёт до `EMBED_BATCH_ITEMS` = 100 записей — столько служба эмбеддингов шлёт одним запросом — и завершает задачу сам, `fail` не возвращает. | Task 6.1 |
| design-core.md (§ Внутри платформы) | constants | **Константы отбора и похожих сущностей** в `agents`: `KNOWLEDGE_BY_MEANING_SHARE` = 1/2; `SIMILAR_ENTITY_MIN_SCORE` = 0.8 — порог близости, его подбирают по первым извлечениям; `SIMILAR_ENTITY_LIMIT` = 3. | Task 2.2, Task 2.3 |
| design-core.md (§ Внутри платформы) | schema | Длины: `name`, `label`, `question`, `outcome` — до 200 знаков, `description` и `hint` — до 500. | Task 2.1 |
| design-core.md (§ Внутри платформы) | constants | Результат вызова — `result_text`, обрезанный до `EXTRACTION_RESULT_BYTES` = 2 000 байт; аргументы — до `EXTRACTION_ARGS_BYTES` = 500 байт. | Task 5.1 |
| design-core.md (§ Внутри платформы) | constants | Весь вход — до `EXTRACTION_INPUT_BYTES` = 48 000 байт. | Task 5.1 |
| design-core.md (§ KD-8) | charging | Записи пачки, у которых вектора не было, идут одним вызовом на запускающего, чьё извлечение поставило проход, а если проход ставили только удаления — на платформу. Записи с вектором старой модели идут отдельным вызовом с `ownerId` `null`, поэтому пересчёт после смены модели не пишется на сотрудников (FR-08). | Task 6.1, Task 8.4 |

### Failure Mode Checklist

| Category | Applies | Covering task |
|---|---|---|
| Concurrency (два коммита, коммит и удаление) | да | Task 3.2, Task 5.2, Task 7.1; INT-4 |
| Restart / at-least-once (рестарт посреди раунда, доставка повторяется) | да | Task 3.1, Task 5.2, Task 5.3; INT-4 строка B |
| Deletion mid-flight (workflow удалён во время раунда, беседа удалена) | да | Task 1.4 (каскад), Task 5.2 (точка сохранения), Task 5.3 (`ignore`); INT-5 |
| External provider failure (модель, эмбеддинги) | да | Task 5.2, Task 6.1, Task 6.2; INT-6, INT-10 |
| Authorization (граф, настройки, права на модель) | да | Task 7.2, Task 7.3, Task 5.2; INT-9, INT-6 |
| Secrets / sensitive data | да | Task 2.1, Task 7.2, Task 7.3 (аудит без текста); INT-7, INT-9 |
| Prompt injection | да | Task 2.3, Task 6.3 (конверт и правило); INT-1, INT-8 |
| Cost runaway | да | Task 5.2 (не больше трёх вызовов), Task 6.2 (вектор раз на вопрос), Task 6.1 (плательщик); INT-6, INT-12, INT-11 |
| Environment / migration | да | Task 1.1, Task 1.4, Task Q.1 шаг 0 |

### ADR Bindings

| ADR | Binding in this plan |
|---|---|
| ADR-0001 | Извлечение и проход векторов — задачи runtime, шаги с `commit` (Task 5.2, 6.1) |
| ADR-0003 | Таблицы и миграция только drizzle, вперёд (Task 1.4) |
| ADR-0004 | Двойники только своего контракта в `./testing` (Task 8.1); опоры фикстур — в `test/support` |
| ADR-0012, ADR-0015 | Таблица пакета ссылается на `library_records` — сознательное отступление KD-1; код `agents` не читает `library_*` (Task 3.2) |
| ADR-0014 | Таблицы в `agents`, маршруты и аудит в `apps/api` (Task 7.1, 7.3) |
| ADR-0016 | Видимость и панель — правила библиотеки (`knowledgeTarget`, Task 7.2) |
| ADR-0017 | Флажок и `learning` берутся из снимка, правка записи не трогает идущий запуск (Task 4.1) |
| ADR-0018, ADR-0019 | Модель извлечения — id из снимка сессии; эмбеддинги — служба `model-providers` (Task 5.2, 6.1) |

### Connection Map

| Boundary | Producer | Consumer | Wire format | Contract | Proven by | Tasks |
|---|---|---|---|---|---|---|
| Конец запуска → задача извлечения | `packages/runtime/src/step-commit.ts` (`task.completed`/`failed`/`stopped`) | `packages/agents/src/knowledge/knowledge-trigger.ts` | событие outbox, `taskId`, `rootId` | `EventConsumer`, `tasks.create(request, tx)` | INT-1–INT-3, `knowledge-trigger.spec.ts` | Task 3.1, 5.3 |
| Строка запуска | `packages/agents/src/store/sessions.repository.ts` (`ensureSession`) | `knowledge-trigger.ts`, `extract.handler.ts` | строка `agent_knowledge_runs` | Data Model | INT-1, INT-8 | Task 4.1, 5.2 |
| Граф → шаг | `knowledge.repository.ts` | `knowledge-block.ts` → `model-step.ts`, `compaction-step.ts` | `instructions` модели | `selectKnowledge`, `envelope` | INT-8, INT-1 | Task 2.3, 6.3 |
| Вектор вопроса | `agent-step.handler.ts` | `knowledge-block.ts` | строка `agent_knowledge_questions` | Contract «Строка вопроса» | INT-12, INT-10 | Task 6.2, 6.3 |
| Хранилище векторов | `embed.handler.ts` (`upsert`/`delete`) | `knowledge-block.ts`, `extract.handler.ts`, `knowledge.ts` (`query`/`list`) | порт `KnowledgeVectorStore` | Contract `KnowledgeVectorStore` | `knowledge-vector-store.e2e-spec.ts`, INT-5, INT-8, INT-11 | Task 3.3, 6.1 |
| Служба эмбеддингов (`model-providers`, построена) | `packages/agents/src/embeddings/embeddings.ts` | `question-vector.ts`, `embed.handler.ts`, `extract.handler.ts` | `embed` → `vectors` / `unavailable` | `EmbedRequest`, `EmbedResult` | INT-10–INT-12 | Task 5.2, 6.1, 6.2 |
| `Agents.knowledge` → маршруты | `packages/agents/src/knowledge/knowledge.ts` | `apps/api/src/knowledge/knowledge.controller.ts`, `admin-knowledge-settings.controller.ts` | вызов в процессе | `view`, `deleteEntity`, `deleteRelation`, `settings`, `updateSettings` | INT-9 | Task 7.1, 7.3 |
| Маршруты → часть `web` | `apps/api/src/knowledge/*.controller.ts` | `apps/web` (часть `web`, ещё не построена) | JSON `KnowledgeView`, `KnowledgeSettings`; 404 `RECORD_NOT_FOUND`, 403 `KNOWLEDGE_FORBIDDEN` | `KnowledgeViewSchema`, `KnowledgeSettingsSchema` | INT-9 | Task 1.2, 7.3 |
| Флажок в содержимом | `packages/contracts/src/library.ts` | библиотека `apps/api`, снимок `agents`, веб (часть `web`) | JSON `WorkflowContent.selfLearning` | `WorkflowContentSchema` | INT-8 | Task 1.2, 1.3, 4.1 |

## Update History

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-11-20 | Initial version; по проверке черновика: строка `ANSWERS` в Task 1.2, `runs.spec.ts` в Task 4.1, проход векторов завершается на `unavailable`, проход от удалений платит платформа, правило доступа на не бросающих чтениях, последняя попытка `run_code`, удалённая беседа в раунде |
