# Task T3.2: `ThreadWriteLock` + `thread-write-lock.spec.ts`

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 3, T3.2)
- Dependencies: T2.3 (гейт G), T2.5 (гейт G3) — оба должны быть пройдены (T2.4 — доказательства, входят в единицу T2.4 + T2.5) → Deliverable: `ThreadsModule` (`threads.module.ts`)
- Provides: `ThreadWriteLock` (сериализация записи по ключу) — для T3.4, T4.1 (общий `threads.module.ts`), T4.2
- Parallel: T3.2 ‖ T3.1 ‖ T3.5
- Size: Small (3 файла)
- Covers: Element 4

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
`ThreadWriteLock` — сериализация асинхронных задач по ключу (`threadId`): задачи одного ключа строго последовательны, разных ключей — параллельны; хвост ключа очищается после завершения (в том числе после отказа задачи); отказ одной задачи не блокирует следующую. Провайдер регистрируется в `ThreadsModule`.

## Target Files
- [x] `apps/api/src/threads/thread-write-lock.ts` (new)
- [x] `apps/api/src/threads/thread-write-lock.spec.ts` (new)
- [x] `apps/api/src/threads/threads.module.ts`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ Element 4 / Main Components `ThreadWriteLock`, § State Transitions and Invariants)
- `apps/api/src/threads/threads.module.ts` (T2.1, T2.2)

## Reference Contracts
Отдельных строк Reference Contract Values для T3.2 в плане нет; обязательства — поведение из Unit-списка ниже.

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Область блокировки | in-process (процесс-локальный) lock по ключу; advisory lock в БД отложен | Design Doc, Future Extensibility |

## Investigation Notes
- Design Doc v1.8 «ThreadWriteLock»: интерфейс `run<T>(key: string, fn: () => Promise<T>): Promise<T>`; хвост цепочки по ключу удаляется после завершения. Element 4 (вариант A): in-process мьютекс по `threadId` для `rename` и записи автозаголовка (AC-17.2).
- `threads.module.ts` (T2.1/T2.2): `providers: [threadMemoryProvider, ThreadsService]` — `ThreadWriteLock` добавлен в `providers` (не экспортируется: потребители T3.4 `ThreadsService` и T4.2 `ThreadTitleService` живут в том же модуле).
- Поиск аналогов (mutex/lock/`Map<string, Promise>`) в `apps/api/src` и `packages` — 0 совпадений; дублирования нет.
- План: `Map<string, Promise<void>>` — хвост ключа, который никогда не отклоняется; новая задача `previous.then(fn)`; хвост = `result.then(noop, noop)` (отказ не «отравляет» цепочку, исходная ошибка пробрасывается вызывающему); в `finally` хвост удаляется, только если он всё ещё последний для ключа. Класс `@Injectable()` (Nest-провайдер).
- Дополнение к интерфейсу DD: `isHeld(key): boolean` — только чтение, нужно для state assertion Proof Obligation (хвост присутствует во время выполнения и удалён после завершения/отказа). Контракт `run` не изменён.
- Reference Contracts: строк нет. Binding Decisions: раздела нет.
- Red: тест падал на отсутствующем модуле; мутации проверены — `fn()` без цепочки → падает тест последовательности; без удаления хвоста → падают 3 теста очистки.

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
- **Verification method**: unit `thread-write-lock.spec.ts` (test-first, без БД и сети).
- **Success criteria**: задачи одного ключа строго последовательны (порядок завершения = порядок постановки); задачи разных ключей выполняются параллельно; после завершения и после отказа задачи хвост ключа удалён; отказ одной задачи не блокирует следующую.
- **Failure response**: гонки в unit — исправить реализацию, не вводить таймеры-ожидания в тест.
- **Verification level**: L2.

## Proof Obligations
### Obligation: Failure Mode: shared-state dependency (ThreadWriteLock)
- **Claim**: запись по одному `threadId` сериализована; разные `threadId` не блокируют друг друга; состояние не течёт.
- **Primary failure mode**: две задачи одного ключа выполняются одновременно; отказ задачи оставляет «отравленный» хвост и блокирует следующие; карта ключей растёт.
- **Boundary to exercise**: in-process unit.
- **State assertion**: до → после: хвост ключа присутствует во время выполнения и удалён после завершения/отказа.
- **Mock boundary rationale**: none (чистая логика; управляемые отложенные промисы).
- **Residual**: интеграция с rename и автозаголовком — T3.4, T4.2, T4.3.

## Completion Criteria
- [x] Unit зелёный, прогон содержательный
- [x] Провайдер зарегистрирован в `ThreadsModule`
- [x] lint/tsc/prettier/unit/build — ноль ошибок
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `threads.module.ts` (общий с T2.1, T2.2, T4.1, T4.2 — строго по порядку плана; T4.1 готова к коммиту только после T3.2).
- Scope boundary: `threads.service.ts`/`threads.controller.ts` не меняются (подключение lock — в T3.4).
