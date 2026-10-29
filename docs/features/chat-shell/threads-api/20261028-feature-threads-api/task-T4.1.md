# Task T4.1: Агент заголовков, инструкции, `normalizeGeneratedTitle`, провайдер `THREAD_TITLE_AGENT`, `TITLE_MODEL`

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 4, T4.1)
- Dependencies: T2.1 (`ThreadsModule` существует); T3.2 (общий `threads.module.ts` — готова к коммиту строго после T3.2); T2.3 (гейт G), T2.5 (гейт G3) — оба пройдены (T2.4 — доказательства, входит в единицу T2.4 + T2.5)
- Provides: `createThreadTitleAgent`, `THREAD_TITLE_INSTRUCTIONS`, `normalizeGeneratedTitle`, провайдер `THREAD_TITLE_AGENT`, `TITLE_MODEL` — для T4.2, T4.3
- Parallel: T4.1 ‖ T3.1/T3.3–T3.5 после T3.2, **только когда гейты G (T2.3) и G3 (T2.5) пройдены**; Phase 4 не стартует до G и G3 (гейт обязателен и для параллельного запуска)
- Size: Small (4 файла)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
`createThreadTitleAgent(model)` — `id: 'thread-title'`, **не** регистрируется в `Mastra`, без памяти, инструментов и `providerOptions`; `THREAD_TITLE_INSTRUCTIONS` — дословно (Reference Contracts); `normalizeGeneratedTitle`; провайдер `THREAD_TITLE_AGENT` в `ThreadsModule`: `useFactory: (config) => createThreadTitleAgent(parseModelId(config.get('TITLE_MODEL') ?? config.get('ASSISTANT_MODEL')))`; `.env.example` — `TITLE_MODEL` с комментарием о быстрой модели. Фабрика не обращается к сети при создании.

## Target Files
- [x] `apps/api/src/threads/thread-title.agent.ts` (new)
- [x] `apps/api/src/threads/thread-title.agent.spec.ts` (new)
- [x] `apps/api/src/threads/threads.module.ts`
- [x] `apps/api/.env.example`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Title Agent, § Element 5, § Field Propagation Map — автозаголовок)
- `apps/api/src/mastra/models.ts` (`parseModelId`), `apps/api/src/mastra/models.spec.ts`
- `apps/api/src/mastra/agents/assistant.agent.ts` (как создаётся агент; не менять)
- `apps/api/src/threads/threads.module.ts` (после T3.2), `apps/api/.env.example`

## Gate (предусловие)
Гейты T2.3 и T2.5: G (T2.3; история эквивалентна стриму по правилу Output Comparison после маскирования) и G3 (T2.5; AC-14.6: после «сброса хвоста» перегенерация ответа, прерванного ошибкой модели или обрывом сети, оставляет один ответ; e2e AC-14.6, вариант «обрыв сети» и характеризация зелёные) пройдены — см. `task-T2.3.md`, `task-T2.4.md` (доказательства), `task-T2.5.md` и пункты «Повторный прогон гейта G» и «Проверка AC-14.6, гейт G3» в Notes плана. Прежний гейт G2 снят. Если G или G3 не пройден (стоп и эскалация, ожидается решение пользователя) — исполнитель **не начинает** задачу и возвращает оркестратору статус `blocked`.

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Title Agent) | derived-display | «Сформулируй короткий заголовок беседы по сообщению пользователя: до 6 слов и не длиннее 80 символов, на том же языке, что и сообщение. Не повторяй сообщение дословно. Без кавычек, двоеточий, эмодзи и точки в конце. Ответь только заголовком.» | Y, если `THREAD_TITLE_INSTRUCTIONS` равна этому тексту побайтно |
| design-threads-api.md (§ Field Propagation Map, автозаголовок) | derived-display | «удаление <think>…</think>, первая непустая строка, снятие обрамляющих кавычек «»\"'`, схлопывание пробелов, обрезка до 80 символов по границе символа, trim» | Y, если `normalizeGeneratedTitle` выполняет ровно эти шаги в этом порядке; обрезка 120 → 80 по границе символа |
| design-threads-api.md (§ Contract Definitions, `threads.ts`) | structure-order | `export const THREAD_TITLE_MAX_LENGTH = 200;` / `export const GENERATED_THREAD_TITLE_MAX_LENGTH = 80;` | Y, если лимит 80 берётся из `GENERATED_THREAD_TITLE_MAX_LENGTH` |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Модель заголовков | `TITLE_MODEL`, при отсутствии — `ASSISTANT_MODEL` (а при её отсутствии `parseModelId` → `DEFAULT_MODEL`) | work plan Failure Mode «missing config», Connection Map |
| Регистрация агента | не регистрируется в `Mastra`; `mastra.getAgent` его не видит | work plan T4.1 |

## Investigation Notes
- Наблюдения: `parseModelId` (`mastra/models.ts`) — пустое/`undefined` → `DEFAULT_MODEL`, без провайдера → исключение. `assistant.agent.ts` создаёт `Agent` с `model`-строкой роутера Mastra; разрешение модели ленивое (без сети и без ключа при создании — проверено `agent.getModel()` в unit без `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`). `ThreadsModule` после T3.2: `threadMemoryProvider`, `ThreadWriteLock`, `ThreadsService`. `GENERATED_THREAD_TITLE_MAX_LENGTH = 80` экспортируется из `@agent-os/contracts`.
- План: `thread-title.agent.ts` содержит токен `THREAD_TITLE_AGENT` (Symbol, по образцу `THREAD_MEMORY`), `THREAD_TITLE_INSTRUCTIONS`, `createThreadTitleAgent(model)` (`id: 'thread-title'`, только `instructions` и `model`), `normalizeGeneratedTitle`, `createThreadTitleAgentFromConfig(config)` и `threadTitleAgentProvider` (`inject: [ConfigService]`, `useFactory: createThreadTitleAgentFromConfig`). Агент нигде не передаётся в `new Mastra(...)` (`mastra.provider.ts` не менялся), поэтому `mastra.getAgent('thread-title')` его не видит. Токен не экспортируется из модуля: потребитель (`ThreadTitleService`, T4.2) — в том же модуле; `overrideProvider` в T4.3 работает и для неэкспортированных провайдеров.
- Reference Contract 1 (инструкции): **Y** — строка скопирована из § Title Agent, совпадает побайтно.
- Reference Contract 2 (нормализация): **Y** — шаги в порядке DD: удаление `<think>…</think>` (нежадно, все блоки) → первая непустая строка (строки trim) → снятие обрамляющих кавычек `«»"'\`` (ведущие и замыкающие) → схлопывание пробельных серий в один пробел → обрезка до 80 по кодовым точкам (`Array.from`, суррогатная пара не разрезается) → trim. Тест «120 → 80» и «surrogate pair» зелёные; мутационные проверки (без `Array.from`, без финального trim, без удаления `<think>`, без `TITLE_MODEL`) дают красные тесты.
- Reference Contract 3 (лимит): **Y** — 80 берётся из `GENERATED_THREAD_TITLE_MAX_LENGTH`.
- Решение «по границе символа»: символ = кодовая точка Unicode (заголовок ≤ 80 кодовых точек; в UTF-16 может быть длиннее 80, но ≤ 160 < `THREAD_TITLE_MAX_LENGTH` 200).
- Residual для ревью: провайдер использует `??` дословно по DD, поэтому `TITLE_MODEL=` (пустая строка) даёт `DEFAULT_MODEL`, а не `ASSISTANT_MODEL`. В `.env.example` переменная оставлена закомментированной с пояснением «не оставлять пустой».

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [x] Прочитать все Investigation Targets, записать наблюдения в Investigation Notes
- [x] Просмотреть deliverables зависимостей (см. Metadata)
- [x] Сверить контракты (Reference Contracts) с Design Doc, записать план подхода в Investigation Notes
- [x] Написать падающие тесты (unit — test-first; e2e — наполнить `it.todo` скелета по его комментариям Arrange/Act/Assert, ожидаемые значения — литералы, пустые заглушки запрещены)
- [x] Запустить тесты и убедиться, что они падают по правильной причине (см. Proof Obligations)

### 2. Green Phase
- [x] Добавить минимальную реализацию
- [x] Запустить только добавленные тесты, убедиться, что они проходят

### 3. Refactor Phase
- [x] Улучшить код, не меняя поведения
- [x] Повторно запустить добавленные тесты

### 4. Gates (все — ноль ошибок; перед vitest после правки `packages/contracts` — `pnpm --filter @agent-os/contracts build`; перед e2e — `pnpm db:up` и `apps/api/.env` с `DATABASE_URL`)
- [x] `pnpm --filter api lint`
- [x] `pnpm --filter api exec tsc --noEmit -p tsconfig.json`
- [x] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`
- [x] `pnpm --filter api test`
- [x] `pnpm --filter api test:e2e` (если задача затрагивает e2e или HTTP-поверхность)
- [x] `pnpm --filter api build`

## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов, типовые ошибки — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext`, `.js`-суффиксы импортов — Enforces: строгие типы, без `as`-обхода — Config/Source: `apps/api/tsconfig.json`, `packages/contracts/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest unit / e2e (реальный Postgres) — Enforces: поведение и AC — Config/Source: `apps/api/vitest.config.ts`, `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- `nest build` — Enforces: сборка production-кода — Config/Source: `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json` — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: unit `thread-title.agent.spec.ts`; `pnpm db:up` и `pnpm --filter api test:e2e -- app.e2e-spec` (приложение без ключей провайдера).
- **Success criteria**: нормализация — кавычки «» и `"`, `<think>`-блоки, многострочный ответ, 120 символов → 80 (по границе символа), только пробелы → `''`; фабрика — без `TITLE_MODEL` берётся `ASSISTANT_MODEL`; агент не попадает в `mastra.getAgent`; `app.e2e-spec.ts` проходит без правок.
- **Failure response**: фабрика требует сеть/ключ при создании — исправить фабрику (ленивая модель), не `app.e2e-spec.ts`.
- **Verification level**: L2.

## Proof Obligations
### Obligation: Failure Mode: missing config (TITLE_MODEL)
- **Claim**: без `TITLE_MODEL` используется `ASSISTANT_MODEL`; приложение без ключей поднимается.
- **Primary failure mode**: исключение при отсутствии `TITLE_MODEL`; обращение к сети при старте.
- **Boundary to exercise**: in-process unit + `app.e2e-spec.ts`.
- **State assertion**: N/A.
- **Mock boundary rationale**: `ConfigService` подменяется значениями.
- **Residual**: реальная модель — T6.3.

### Obligation: Field Propagation (normalizeGeneratedTitle) / Failure Mode: empty input
- **Claim**: любой ответ модели приводится к заголовку 1…80 символов без кавычек и переводов строк либо к `''`.
- **Primary failure mode**: заголовок с `<think>`, кавычками, переводом строки или длиннее 80 символов; пробельный ответ записывается как заголовок.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: качество языка — T6.3.

## Completion Criteria
- [x] Unit зелёный, прогон содержательный
- [x] `app.e2e-spec.ts` (без ключей провайдера) проходит без правок
- [x] Каждый Compliance Check = `Y`, доказательства в Investigation Notes
- [x] lint/tsc/prettier/unit/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия), строго после T3.2 и пройденных гейтов G (T2.3) и G3 (T2.5); `git commit` не выполнялся

## Notes
- Impact scope: `threads.module.ts` (последовательность T2.1 → T2.2 → T3.2 → T4.1 → T4.2).
- Scope boundary: `chat/**`, `mastra/**`, `app.e2e-spec.ts` не меняются.
