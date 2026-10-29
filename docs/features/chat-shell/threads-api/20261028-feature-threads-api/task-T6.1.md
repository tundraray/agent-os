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
- [ ] `apps/api/test/threads.perf.e2e-spec.ts`
- [ ] `apps/api/package.json` (скрипт `test:perf` — **только** при нестабильности)
- [ ] `apps/api/vitest.config.e2e.ts` (исключение perf из `test:e2e` — **только** при нестабильности)
- [ ] `docs/features/chat-shell/threads-api/20261028-feature-threads-api.md` (только пункт «Решение о `test:perf`» в Notes)

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
(Заполняется исполнителем до реализации: план подхода.)

## Implementation Steps (TDD: Red-Green-Refactor)
### 1. Red Phase
- [ ] Прочитать все Investigation Targets, записать наблюдения в Investigation Notes
- [ ] Просмотреть deliverables зависимостей (см. Metadata)
- [ ] Сверить контракты (Reference Contracts) с Design Doc, записать план подхода в Investigation Notes
- [ ] Написать падающие тесты (unit — test-first; e2e — наполнить `it.todo` скелета по его комментариям Arrange/Act/Assert, ожидаемые значения — литералы, пустые заглушки запрещены)
- [ ] Запустить тесты и убедиться, что они падают по правильной причине (см. Proof Obligations)

### 2. Green Phase
- [ ] Добавить минимальную реализацию
- [ ] Запустить только добавленные тесты, убедиться, что они проходят

### 3. Refactor Phase
- [ ] Улучшить код, не меняя поведения
- [ ] Повторно запустить добавленные тесты

### 4. Gates (все — ноль ошибок; перед vitest после правки `packages/contracts` — `pnpm --filter @agent-os/contracts build`; перед e2e — `pnpm db:up` и `apps/api/.env` с `DATABASE_URL`)
- [ ] `pnpm --filter api lint`
- [ ] `pnpm --filter api exec tsc --noEmit -p tsconfig.json`
- [ ] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`
- [ ] `pnpm --filter api test`
- [ ] `pnpm --filter api test:e2e` (если задача затрагивает e2e или HTTP-поверхность)
- [ ] `pnpm --filter api build`

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
- [ ] Perf 2/2 зелёные; `it.todo` в `threads.perf.e2e-spec.ts` не осталось
- [ ] Решение о скрипте (`test:e2e` или `test:perf`) записано в Notes плана
- [ ] Compliance Check = `Y`, доказательство в Investigation Notes
- [ ] lint/tsc/prettier/e2e/build — ноль ошибок
- [ ] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: время прогона `test:e2e`.
- Scope boundary: `apps/api/src/**` не меняется; `package.json`/`vitest.config.e2e.ts` — только при нестабильности.
