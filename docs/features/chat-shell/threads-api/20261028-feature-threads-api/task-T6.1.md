# Task T6.1: Perf-тесты AC-13.4, AC-14.4

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 6, T6.1)
- Dependencies: T5.1 → Deliverable: полный набор маршрутов и e2e-обвязка
- Provides: решение о запуске perf (`test:e2e` или `test:perf`) — для T6.2
- Size: Small (1 файл; при нестабильности — до 3 файлов)
- Covers: AC-13.4, AC-14.4

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
Наполнить 2 `it.todo` скелета `threads.perf.e2e-spec.ts`: `AC-13.4: GET /api/threads p95 <= 300 ms with 200 threads`; `AC-14.4: GET /api/threads/:threadId/messages p95 <= 500 ms with 100 messages`. Метод — Reference Contract Values: 5 прогревочных + 50 последовательных запросов; p95 по отсортированным длительностям (индекс `ceil(0.95·n)−1`, для n = 50 — `durations[47]`).

**Решение плана о запуске** (Design Doc передал его плану): perf остаётся в `test:e2e`. Если perf-кейс падает хотя бы в 1 из 3 полных прогонов `test:e2e`, но проходит в изолированном прогоне — perf выносится в `test:perf` (`vitest run --config ./vitest.config.e2e.ts --no-file-parallelism test/threads.perf.e2e-spec.ts`), а `test:e2e` его исключает; запись в Notes плана.

## Target Files
- [x] `apps/api/test/threads.perf.e2e-spec.ts`
- [ ] `apps/api/package.json` (скрипт `test:perf` — **только** при нестабильности)
- [ ] `apps/api/vitest.config.e2e.ts` (исключение perf из `test:e2e` — **только** при нестабильности)
- [x] `docs/features/chat-shell/threads-api/20261028-feature-threads-api.md` (только пункт «Решение о `test:perf`» в Notes)

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Performance Tests, § Test Strategy perf, AC-13.4, AC-14.4)
- `apps/api/test/threads.perf.e2e-spec.ts` (скелет)
- `apps/api/test/support/*`, `apps/api/vitest.config.e2e.ts`, `apps/api/package.json`

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Test Strategy, perf) | structure-order | «5 прогревочных + 50 последовательных запросов; p95 (по отсортированным длительностям, индекс `ceil(0.95·n)−1`) ≤ 300 / ≤ 500 мс» | Y, если тесты делают 5 прогревочных + 50 последовательных запросов и сравнивают `durations[47]` (отсортированные) с 300 мс для списка и 500 мс для сообщений |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Запуск perf | по умолчанию в `test:e2e`; вынос в `test:perf` только по правилу «падает хотя бы в 1 из 3 полных прогонов, но проходит изолированно» | work plan T6.1 |
| Размеры данных | 200 бесед для AC-13.4; 100 сообщений для AC-14.4 | work plan T6.1 |

## Investigation Notes
- Скелет: 2 `it.todo` с Arrange/Act/Assert; харнесс `test/support` — `createTestApp()` (mock-модели, `THREAD_TITLE_AGENT` подменён — сеть не используется), `seed` (явный `updatedAt`, format-2 сообщения, префикс id на вызов), `descendingDates`, `newUser`, `cleanupUsers`. Список — страница 20 (`ThreadListResponseSchema`), история возвращает все сообщения (`ThreadMessagesResponseSchema`). `vitest.config.e2e.ts` подхватывает `**/*.e2e-spec.ts`, файлы идут параллельно.
- План: одно приложение на файл (`beforeAll`/`afterAll` с `cleanupUsers` и `app.close()`), уникальный пользователь на тест; хелпер `measureSequential` — 5 прогревочных (тоже проверяются, но в замер не входят) + 50 последовательных запросов с `performance.now()`, каждый ответ проверяется (200, 20 бесед / 100 сообщений), длительности сортируются по возрастанию, сравнивается `durations[47]` (константа `P95_INDEX = ceil(0.95·50) − 1`) с литералами 300 / 500. Таймаут теста 120 с (засев 200 бесед).
- Reference Contract — **Y**: 5 прогревочных + 50 последовательных запросов; сравнивается отсортированный `durations[47]` с 300 мс (список) и 500 мс (сообщения) — `test/threads.perf.e2e-spec.ts`, `measureSequential` и два `expect(durations[P95_INDEX]).toBeLessThanOrEqual(...)`.
- Red: до реализации кейсы были `it.todo` (не исполнялись); проверка, что утверждение может упасть, — временный порог 1 мс краснит оба кейса (`expected 4.64 / 6.40 to be less than or equal to 1`), порог возвращён.
- Результаты (Postgres `localhost:5433`, пустые ключи): изолированно p95 AC-13.4 = 4.6 мс, AC-14.4 = 6.4 мс; полный `test:e2e` — 4/4 прогона зелёные (30/30), в verbose-прогоне p95 6.6 / 6.0 мс. Правило выноса в `test:perf` не сработало — perf остаётся в `test:e2e`, `package.json` и `vitest.config.e2e.ts` не менялись.
- Гейты: lint (код выхода 0), `tsc --noEmit`, unit 118/118, `nest build` — OK; `prettier --check` по целевому файлу OK; общий `prettier --check "src/**/*.ts" "test/**/*.ts"` предупреждает о 7 файлах вне scope, не изменённых относительно HEAD (`src/audit/audit.module.ts`, `src/audit/audit.service.ts`, `src/auth/session.guard.ts`, `src/mastra/agents/assistant.agent.ts`, `src/mastra/mastra.lifecycle.ts`, `src/mastra/models.spec.ts`, `src/mastra/models.ts`) — уже существовавшее состояние, оставлено для T6.2.

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
- [x] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"` (целевой файл чист; 7 файлов вне scope, не изменённых относительно HEAD, — см. Investigation Notes)
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
- **Verification method**: perf-кейсы на реальном Postgres; 3 полных прогона `pnpm --filter api test:e2e`, затем изолированный прогон при падении.
- **Success criteria**: оба perf-кейса зелёные (p95 ≤ 300 / ≤ 500 мс); решение о скрипте записано в Notes плана.
- **Failure response**: стабильное превышение порога в изолированном прогоне — не менять порог, эскалировать (регрессия производительности); шум только при параллельном запуске — вынести в `test:perf`.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-13.4 / AC-14.4
- **Claim**: p95 списка ≤ 300 мс при 200 беседах; p95 истории ≤ 500 мс при 100 сообщениях.
- **Primary failure mode**: линейная деградация/лишние запросы; тест, сравнивающий не отсортированные длительности либо не тот индекс.
- **Boundary to exercise**: HTTP → реальный Postgres, последовательные запросы.
- **State assertion**: N/A.
- **Mock boundary rationale**: модель не участвует; сообщения засеяны `seed`.
- **Residual**: шум общей БД при параллельном запуске — правило выноса в `test:perf`.

## Completion Criteria
- [x] Perf 2/2 зелёные; `it.todo` в `threads.perf.e2e-spec.ts` не осталось
- [x] Решение о скрипте (`test:e2e` или `test:perf`) записано в Notes плана
- [x] Compliance Check = `Y`, доказательство в Investigation Notes
- [x] lint/tsc/prettier/e2e/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: время прогона `test:e2e`.
- Scope boundary: `apps/api/src/**` не меняется; `package.json`/`vitest.config.e2e.ts` — только при нестабильности.
