# Task T1.3: Тестовая обвязка `apps/api/test/support/`

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 1, T1.3)
- Dependencies: T1.1 → Deliverable: `@agent-os/contracts` dist; T1.2 → Deliverable: `configureApp` (`apps/api/src/app.setup.ts`)
- Provides: `createTestApp`, `mockModels`, `seed`, `db` — prerequisite всех e2e (T2.2 и далее)
- Parallel: может разрабатываться параллельно с T1.2; готова к коммиту только после T1.2 (подключает `configureApp`)
- Size: Medium (4 файла обвязки + манифест и lockfile для пина версии `ai`)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
- `createTestApp({ assistantModel })`: `Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MASTRA).useFactory(...)` — тестовый `Mastra` с агентом `id: 'assistant'`, инструментами `getWeather` (успех) и `failing` (бросает `'boom'`), `Memory({ options: { lastMessages: 20 } })`, `PostgresStore` из `DATABASE_URL`, модель `MockLanguageModelV4` (`ai/test`); `configureApp(app)`; запросы на `/api/...`. Параметр `titleModel` и override `THREAD_TITLE_AGENT` добавляются в T4.3.
- `mockModels.ts`: сценарии ассистента — текст; reasoning + 2 инструмента (один бросает); ошибка модели; очередь ответов для многоходовых бесед.
- `seed.ts`: N бесед с заданными `updatedAt` и M сообщений format 2 через `Memory.saveThread`/`saveMessages`; id бесед — `${prefix}-t-${nnn}` (`nnn` — номер с ведущими нулями, `001`…), `prefix = randomUUID()` генерируется заново на каждый тест; `seed` возвращает карту id (номер → id); `newUser()` = `'e2e-' + randomUUID()`; очистка бесед по `resourceId`.
- `db.ts`: клиент `pg` на `DATABASE_URL`; `countMessages(threadId)` → `SELECT count(*) FROM mastra_messages WHERE thread_id = $1`.

## Target Files
- [x] `apps/api/test/support/createTestApp.ts` (new)
- [x] `apps/api/test/support/mockModels.ts` (new)
- [x] `apps/api/test/support/seed.ts` (new)
- [x] `apps/api/test/support/db.ts` (new)
- [x] `apps/api/package.json` (modify: `ai` закреплён на точной версии `7.0.148`, без каретки)
- [x] `pnpm-lock.yaml` (modify: только через `pnpm`, вручную не править)

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации. Правка `apps/api/package.json` ограничена зависимостью `ai`; `apps/web` не меняется (остаётся `^7.0.155`). Если `pg` и его типы не объявлены в `apps/api/package.json`, это эскалация (файл вне Target Files), а не самовольная правка.

## Investigation Targets
- `apps/api/test/app.e2e-spec.ts` (существующий способ подъёма приложения; не менять)
- `apps/api/src/mastra/mastra.provider.ts`, `apps/api/src/mastra/mastra.constants.ts` (токен `MASTRA`, фабрика)
- `apps/api/src/mastra/agents/assistant.agent.ts` (агент, память)
- `apps/api/src/app.module.ts`, `apps/api/src/app.setup.ts` (после T1.2)
- `docs/features/chat-shell/design-threads-api.md` (§ Test Strategy / обвязка, § Test Boundaries — Mock Boundary Decisions, Data Layer Testing Strategy)
- Скелеты: `apps/api/test/threads.e2e-spec.ts`, `apps/api/test/chat-threads.e2e-spec.ts` (какие сценарии и литералы нужны обвязке)

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Integration Points, Integration Point 1) | state-lifecycle-negative | «`SELECT count(*) FROM mastra_messages WHERE thread_id = $1` через клиент `pg` (прямая зависимость `apps/api`) на `DATABASE_URL` возвращает литерал `0`» | Y, если `countMessages` выполняет именно этот SQL через `pg` на `DATABASE_URL` и возвращает значение, сравнимое с литералом `0` (`count` приходит строкой — приведение после запроса) |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Формат id бесед в `seed` | `${prefix}-t-${nnn}`, `prefix = randomUUID()` на каждый тест — глобальная уникальность PK `mastra_threads.id` при параллельных e2e-файлах | work plan T1.3, Failure Mode «shared-state dependency» |
| Что возвращает `seed` | карту id (номер → id); тесты сравнивают с производными литералами (`${p}-t-085`, `${p}-t-005`) | work plan T1.3, Notes «Отклонения Arrange» |
| Хранилище в тестовом `Mastra` | `PostgresStore` на том же `DATABASE_URL` (как production) | work plan, Риски |

## Investigation Notes
- Наблюдения: `MASTRA` — `Symbol` в `mastra.constants.ts`, фабрика в `mastra.provider.ts` (`PostgresStore` на `DATABASE_URL` через `ConfigService`); агент `assistant` берёт хранилище из `Mastra`. `configureApp` (T1.2) уже есть в `src/app.setup.ts`. `pg`/`@types/pg` объявлены в `apps/api/package.json`; `zod` объявлен (T1.2).
- `Memory`, переданная агенту, получает хранилище только через `agent.getMemory()` после регистрации в `Mastra` → `createTestApp` возвращает `memory` из `mastra.getAgent('assistant').getMemory()` с проверкой `instanceof Memory` (fail fast).
- `PostgresStore.saveMessages` сдвигает `updatedAt` треда на `now()`; `saveThread` — upsert → `seed` после `saveMessages` повторно сохраняет тред с заданным `updatedAt`.
- Подход Reference Contract: `countMessages` выполняет литерально `SELECT count(*) FROM mastra_messages WHERE thread_id = $1` через `pg.Pool` на `DATABASE_URL` (env или `apps/api/.env`) и возвращает `Number(count)`. Compliance Check = **Y** (смоук: после `deleteThread` → `0`, 4 засеянных сообщения → `4`).
- Смоук (временный spec, удалён): `seed` дважды → разные `prefix`, id `${prefix}-t-001`; `updatedAt` сохранён литерально; `POST /api/chat/assistant` с `reasoningWithToolsSteps` → 200, в `mastra_messages` `reasoning`, `tool-invocation` `state: "result"` (getWeather) и `state: "output-error", errorText: "boom"` (failing), текст финального шага.
- **Блокер (эскалация)**: `tsc --noEmit` — `MockLanguageModelV3` (`ai/test`, `@ai-sdk/provider` 4.0.34) не присваивается типу `model` агента Mastra 1.80.0 (встроенные типы `@ai-sdk/provider-v6`: `JSONValue` без `Readonly`; `MockLanguageModelV4` — несовместим по `finishReason 'interrupted'`). В рантайме работает. Без `as`-приведения не решается.
- **Решение пользователя (2026-10-28, эскалация T1.3)**: `ai` в `apps/api` закрепить на точной `7.0.148` (без каретки), lockfile обновить через `pnpm`; `apps/web` остаётся `^7.0.155`; обвязка переходит с `MockLanguageModelV3` на `MockLanguageModelV4` из `ai/test` (зонд подтвердил: типизируется с `ai` 7.0.148); `as`-приведения запрещены. Design Doc `design-threads-api.md` обновляется до v1.4.
- Возобновление (2026-10-28): `pnpm --filter api add --save-exact ai@7.0.148` при уже существующей зависимости оставлял каретку (pnpm 10.9.0) — выполнено `pnpm --filter api remove ai` + `pnpm --filter api add --save-exact ai@7.0.148`; итог `"ai": "7.0.148"`, lockfile `specifier: 7.0.148`, `apps/web/package.json` без изменений, `pnpm why -r ai`: api 7.0.148, web 7.0.155. Обвязка переведена на `MockLanguageModelV4` (типы `StreamStep`/`StreamPart`/`FinishReason` выводятся из `MockLanguageModelV4['doStream']`), `tsc --noEmit` — 0 ошибок, `as`-приведений нет.
- Смоук после перехода на V4 (временный spec, удалён): два `seed` → разные `prefix`, `${prefix}-t-001` у обоих, id не совпадают; `updatedAt` сохранён литерально; `countMessages` → `4`, после `deleteThread` → `0` (Reference Contract = **Y**); `POST /api/chat/assistant` с `reasoningWithToolsSteps` → 200, в `mastra_messages` reasoning, результат `getWeather`, `boom` от `failing`, финальный текст.

## Implementation Steps
Обвязка не имеет собственных e2e-кейсов: функциональная проверка — первым e2e в T2.2 (`createTestApp`, `seed`, `mockModels`) и в T3.3 (`countMessages`).
- [x] Прочитать Investigation Targets, записать наблюдения
- [x] Реализовать `db.ts`, `seed.ts`, `mockModels.ts`, `createTestApp.ts` (достаточно для T2.2)
- [x] Закрепить `ai` в `apps/api`: `pnpm --filter api add ai@7.0.148 --save-exact`; убедиться, что в `apps/api/package.json` версия `"7.0.148"` без `^`, а `pnpm-lock.yaml` обновлён pnpm-ом; `apps/web/package.json` не изменён
- [x] Перевести `mockModels.ts` и `createTestApp.ts` на `MockLanguageModelV4` из `ai/test`: производные типы `StreamStep`/`StreamPart`/`FinishReason` брать из V4 (выводить из типов модели, не объявлять вручную), `finish` в сценариях — формы `finish({ unified, raw })`; без `as`-приведений
- [x] Убедиться, что два вызова `seed` с одинаковыми номерами в разных тестах дают непересекающиеся id (полная проверка — T2.2 и параллельный прогон `test:e2e` в T3.4)
- [x] Gates: `pnpm --filter api lint`, `pnpm --filter api exec tsc --noEmit -p tsconfig.json`, `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`, `pnpm --filter api build`; `pnpm db:up` и `pnpm --filter api test:e2e -- app.e2e-spec` (обвязка не ломает существующий e2e); дополнительно гейты пина `ai` — см. Completion Criteria

## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов, типовые ошибки — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext`, `.js`-суффиксы импортов — Enforces: строгие типы, без `as`-обхода — Config/Source: `apps/api/tsconfig.json`, `packages/contracts/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest unit / e2e (реальный Postgres) — Enforces: поведение и AC — Config/Source: `apps/api/vitest.config.ts`, `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- `nest build` — Enforces: сборка production-кода — Config/Source: `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json` — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: `tsc --noEmit` и oxlint по `test/`; `app.e2e-spec.ts` зелёный и не изменён; функциональная проверка обвязки — первый e2e в T2.2.
- **Success criteria**: ноль ошибок lint/tsc/prettier; `git diff --exit-code apps/api/test/app.e2e-spec.ts` пуст; `seed` генерирует id с новым `prefix` на каждый вызов теста.
- **Failure response**: невозможность поднять `PostgresStore` или переопределить `MASTRA` — эскалация, не обход.
- **Verification level**: L3 (сборка/типы) здесь; L2 — в T2.2.

## Proof Obligations
### Obligation: Failure Mode: shared-state dependency
- **Claim**: параллельные e2e-файлы на общем Postgres не сталкиваются по PK `mastra_threads.id`; изоляция по `resourceId`.
- **Primary failure mode**: голые id вида `t-001` или общий `prefix` между тестами.
- **Boundary to exercise**: реальный Postgres через `Memory.saveThread` (проверяется в T2.2/T3.4).
- **State assertion**: N/A на этой задаче.
- **Mock boundary rationale**: мокается только модель (`MockLanguageModelV4`); БД — реальная.
- **Residual**: функциональная валидация — T2.2; параллельный прогон — T3.4.

## Completion Criteria
- [x] `tsc --noEmit` и oxlint по `test/` без ошибок
- [x] `pnpm --filter api exec tsc --noEmit -p tsconfig.json` — 0 ошибок (без `as`-приведений в обвязке)
- [x] `pnpm why -r ai` показывает `api` = `7.0.148` и `web` = `7.0.155`
- [x] `pnpm --filter api test` зелёный
- [x] `pnpm --filter api test:e2e` зелёный (`app.e2e-spec` + смоук обвязки)
- [x] `pnpm --filter web build` проходит (apps/web не затронут пином)
- [x] Два вызова `seed` с одинаковыми номерами дают непересекающиеся id
- [x] Обвязка готова к использованию первым e2e в T2.2
- [x] `apps/api/test/app.e2e-spec.ts` не изменён
- [x] Compliance Check = `Y`, доказательство в Investigation Notes
- [x] Готово к коммиту (manual-стратегия), строго после T1.2; `git commit` не выполнялся (обвязка готова; первое использование — T2.2)

## Notes
- Impact scope: все e2e-задачи плана.
- Scope boundary: правки вне Target Files — только `apps/api/package.json` (зависимость `ai`) и `pnpm-lock.yaml` через pnpm; `apps/web/**` не меняется; `apps/api/src/**`, `app.e2e-spec.ts`, скелеты `threads*.e2e-spec.ts` не меняются.
