# Task T4.2: `ThreadTitleService` (алгоритм 1–6 DD, вкл. лог `usage`) + `thread-title.service.spec.ts`

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 4, T4.2)
- Dependencies: T3.2 → Deliverable: `ThreadWriteLock`; T4.1 → Deliverable: `createThreadTitleAgent`, провайдер `THREAD_TITLE_AGENT`, `normalizeGeneratedTitle`
- Provides: `ThreadTitleService.schedule({ threadId, resourceId }): void`, токен `THREAD_TITLE_TIMEOUT_MS`; `ThreadsModule` экспортирует `ThreadsService` и `ThreadTitleService` — для T4.3
- Size: Small (3 файла)
- Covers: AC-17.1, AC-17.2, AC-17.3 (unit); риск стоимости заголовков PRD (строка `usage agent=thread-title`)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
`schedule({ threadId, resourceId }): void` — промис кладётся в `Set` (`pending`), все ошибки пойманы (нет висящих промисов, `no-floating-promises`); токен `THREAD_TITLE_TIMEOUT_MS` (`useValue: 8_000` в `ThreadsModule`). Шаги 1–4 Design Doc: (1) проверка, что title ещё пуст (иначе `debug` и выход, без `recall` и модели); (2) чтение первого сообщения из `Memory.recall` с литеральными аргументами, конкатенация текстовых частей, `trim`, обрезка до 2 000 символов; (3) вызов агента с `AbortSignal.timeout(THREAD_TITLE_TIMEOUT_MS)`; **сразу после разрешения `generate` (до `signal.throwIfAborted()`) — `this.logger.log('usage agent=thread-title thread=<id> input=<n> output=<n>')`**, где `input`/`output` — входные и выходные токены из total usage результата `generate`, `0` при отсутствии (тот же формат, что строка `usage` чата); только id и числа, без текста; затем `signal.throwIfAborted()` (Mastra разрешает прерванный `generate`); (4) запись заголовка под `ThreadWriteLock` с перепроверкой `title === ''`. **Шаг 5**: в `catch` — `reason = signal.aborted ? 'TimeoutError' : error.name`, плюс `statusCode=`/`code=` при наличии; без `error.message` и текста; `EmptyTitle` при пустой нормализации. Шаг 6 — повтор: следующий `schedule` повторяет генерацию. `beforeApplicationShutdown` — `Promise.allSettled(pending)`.

## Target Files
- [ ] `apps/api/src/threads/thread-title.service.ts` (new)
- [ ] `apps/api/src/threads/thread-title.service.spec.ts` (new)
- [ ] `apps/api/src/threads/threads.module.ts`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `docs/features/chat-shell/design-threads-api.md` (§ ThreadTitleService алгоритм 1–6 и шаги 3 и 5, § Logging and Monitoring, § Test Strategy `thread-title.service.spec.ts`, § Integration Verification Points)
- `apps/api/src/threads/thread-title.agent.ts`, `thread-write-lock.ts`, `threads.service.ts`, `threads.module.ts`
- `apps/api/.oxlintrc.json` (`typescript/no-floating-promises`)

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ Logging and Monitoring) | derived-display | «`ThreadTitleService`: `warn` при ошибке/таймауте/пустом результате: `Title generation failed thread=<id> reason=<reason>`: `TimeoutError`, когда `signal.aborted === true` (в том числе при отклонении `generate` обёрнутой ошибкой после прерывания), иначе `error.name`; пустой результат — `EmptyTitle`, плюс `statusCode=<n>` и `code=<c>`, когда они есть у ошибки (ошибки провайдера модели); `debug` при пропуске (title уже есть). `error.message`, текст сообщений и заголовков в лог не пишутся.» | Y, если формат `warn`/`debug` и состав полей совпадают, `error.message` и тексты в лог не попадают |
| design-threads-api.md (§ Test Strategy, `thread-title.service.spec.ts`) | derived-display | «`warn` вызван ровно с `'Title generation failed thread=t-1 reason=TimeoutError'`, `updateThread` не вызван» | Y, если unit-тест таймаута проверяет ровно эту строку и отсутствие `updateThread` |
| design-threads-api.md (§ ThreadTitleService шаг 5) | derived-display | «`reason = signal.aborted ? 'TimeoutError' : error.name` (сигнал создаётся до `generate` и виден в `catch`; до шага 3 сигнала нет — `reason = error.name`)»; Test Strategy: «фейковый агент ждёт события `abort` на переданном `abortSignal` и **отклоняется** `new Error('wrapped')` → `warn` вызван ровно с `'Title generation failed thread=t-1 reason=TimeoutError'`, `updateThread` не вызван» | Y, если сигнал создаётся до `generate`, `reason` вычисляется этим выражением, а unit-кейс с `new Error('wrapped')` даёт `reason=TimeoutError` |
| design-threads-api.md (§ Logging and Monitoring) | derived-display | «`ThreadTitleService` после каждого разрешённого `generate` пишет `log`-строку `usage agent=thread-title thread=<id> input=<n> output=<n>` в том же формате — расход модели заголовков виден в логе `usage` (митигация риска стоимости из PRD).» | Y, если строка пишется после каждого разрешённого `generate` в этом формате |
| design-threads-api.md (§ ThreadTitleService, шаг 3) | derived-display | «где input и output — входные и выходные токены из общего расхода (total usage) результата `generate`, 0 при отсутствии, как в строке `usage` чата» | Y, если токены берутся из total usage, `0` при отсутствии; текст сообщений и заголовков в строку не попадает |
| design-threads-api.md (§ Test Strategy, `thread-title.service.spec.ts`) | derived-display | «фейковый агент возвращает `totalUsage` `{ inputTokens: 12, outputTokens: 5 }` → `log` вызван ровно с `'usage agent=thread-title thread=t-1 input=12 output=5'` (риск стоимости PRD)» | Y, если unit-кейс проверяет ровно эту строку |
| design-threads-api.md (§ ThreadTitleService, шаг 3) | derived-display | «`throwIfAborted()` бросает `signal.reason` — `DOMException` с `name === 'TimeoutError'` (так `AbortSignal.timeout` помечает истечение времени; `AbortError` — только для ручного `abort()`)» | Y, если после `generate` вызывается `signal.throwIfAborted()` и тест таймаута красный без него |
| design-threads-api.md (§ ThreadTitleService, Dependencies) | structure-order | «`THREAD_TITLE_TIMEOUT_MS` … `ThreadsModule` даёт `useValue: 8_000`»; unit: «`THREAD_TITLE_TIMEOUT_MS = 20`» | Y, если модуль даёт `useValue: 8_000`, а unit подставляет 20 |
| design-threads-api.md (§ Test Strategy, `thread-title.service.spec.ts`) | structure-order | «`recall` вызван с `{ threadId: 't-1', resourceId: 'u-1', perPage: 1, page: 0, orderBy: { field: 'createdAt', direction: 'ASC' }, includeTotal: false }`» | Y, если unit-тест проверяет `recall` ровно с этими аргументами |
| design-threads-api.md (§ ThreadTitleService, шаг 2) | derived-display | «конкатенация `first.content.parts` с `type === 'text'`, `trim`, обрезка до 2 000 символов» | Y, если сообщение из 2 500 символов передаётся модели ровно 2 000 символов |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Ошибки фоновой задачи | не пробрасываются в стрим чата; логируются `warn` без `error.message` | Design Doc Logging; work plan AC-17.3 |
| Расход модели заголовков | лог `usage agent=thread-title` после каждого разрешённого `generate`, до `throwIfAborted()`; без текста | Design Doc Logging and Monitoring; PRD риск стоимости |
| Гонка с ручным переименованием | запись только под `ThreadWriteLock` с перепроверкой `title === ''` | work plan T4.2, AC-17.2 |

## Investigation Notes
(Заполняется исполнителем до реализации: план подхода и результат каждого Compliance Check.)

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
- PII в логах: без `error.message`, текста сообщений и заголовков — Enforces: логи заголовков — Config/Source: DD «Logging and Monitoring» — Type: `passive_constraint`
- Покрытие нового кода ≥ 80 % — Enforces: качество unit — Config/Source: `@vitest/coverage-v8` — Type: `executable_check`

## Operation Verification Methods
- **Verification method**: unit `thread-title.service.spec.ts` с фейковыми `Memory` и агентом.
- **Success criteria**: все кейсы Design Doc — `recall` с литеральными аргументами; модель получила «План отпуска на Байкал в августе»; первое сообщение из 2 500 символов → фейковый агент получает ровно 2 000 символов; первое не `user` / без текста → модель не вызвана; непустой title → нет `recall` и модели; запись при `''`; **лог `usage`**: фейковый агент возвращает `totalUsage` `{ inputTokens: 12, outputTokens: 5 }` → `log` вызван ровно с `'usage agent=thread-title thread=t-1 input=12 output=5'`; ошибка модели → нет записи, `warn` с `threadId` и `statusCode`/`code`, без `error.message`; таймаут (`THREAD_TITLE_TIMEOUT_MS = 20`, агент разрешается `{ text: '', finishReason: 'aborted' }`) → `warn` ровно `'Title generation failed thread=t-1 reason=TimeoutError'`, `updateThread` не вызван; таймаут с обёрнутой ошибкой (`new Error('wrapped')`) → тот же `warn`; повтор после ошибки; гонка AC-17.2; `beforeApplicationShutdown` дожидается незавершённой задачи.
- **Failure response**: красный тест таймаута без `throwIfAborted` — добавить вызов, не менять тест.
- **Verification level**: L2.

## Proof Obligations
### Obligation: AC-17.3 / таймаут
- **Claim**: прерванный по таймауту `generate` не записывает заголовок и логирует `reason=TimeoutError`.
- **Primary failure mode**: нет `signal.throwIfAborted()` (Mastra разрешает прерванный `generate`) — пустой/частичный текст записывается.
- **Boundary to exercise**: in-process unit.
- **State assertion**: `updateThread` не вызван; `warn` вызван ровно один раз с литеральной строкой.
- **Mock boundary rationale**: `Memory` и агент мокаются — внешние I/O.
- **Residual**: реальная модель — T6.3.

### Obligation: ThreadTitleService шаг 5 (DD v1.3)
- **Claim**: при истечении таймаута reason всегда `TimeoutError`, даже если `generate` отклонился обёрнутой ошибкой.
- **Primary failure mode**: логирование `reason=Error` (`error.name` вместо `signal.aborted`).
- **Boundary to exercise**: in-process unit (агент ждёт `abort`, отклоняется `new Error('wrapped')`).
- **State assertion**: N/A.
- **Mock boundary rationale**: как выше.
- **Residual**: нет.

### Obligation: Logging and Monitoring — строка `usage` (риск стоимости PRD)
- **Claim**: расход модели заголовков виден в логе: после каждого разрешённого `generate` пишется `usage agent=thread-title thread=<id> input=<n> output=<n>`.
- **Primary failure mode**: строка не пишется; пишется до разрешения `generate`; токены берутся не из total usage; в строку попадает текст.
- **Boundary to exercise**: in-process unit (фейковый агент с `totalUsage` `{ inputTokens: 12, outputTokens: 5 }`).
- **State assertion**: `log` вызван ровно с `'usage agent=thread-title thread=t-1 input=12 output=5'`.
- **Mock boundary rationale**: `Memory` и агент мокаются — внешние I/O.
- **Residual**: реальный расход — T6.3.

### Obligation: Step 2 — обрезка до 2 000
- **Claim**: модель получает не более 2 000 символов первого сообщения.
- **Primary failure mode**: необрезанный текст передан модели.
- **Boundary to exercise**: in-process unit (2 500 → ровно 2 000).
- **State assertion**: N/A.
- **Mock boundary rationale**: как выше.
- **Residual**: нет.

### Obligation: AC-17.2 — гонка (unit)
- **Claim**: ручной заголовок побеждает фоновую генерацию.
- **Primary failure mode**: нет перепроверки `title === ''` под lock — перезапись ручного заголовка.
- **Boundary to exercise**: in-process unit (генерация блокирована отложенным промисом, `rename` через тот же `ThreadWriteLock`).
- **State assertion**: до: title `''` → ручной rename → разрешение генерации → title остаётся ручным.
- **Mock boundary rationale**: как выше.
- **Residual**: гонка на реальной БД — T4.3 (доп. e2e).

### Obligation: Failure Mode: no-op / empty input / shared-state
- **Claim**: непустой title → модель не вызвана; пустая нормализация → `EmptyTitle`; `pending`-набор дожидается при остановке.
- **Primary failure mode**: лишний вызов модели; потеря фоновой задачи при shutdown.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: как выше.
- **Residual**: нет.

## Completion Criteria
- [ ] Unit зелёный, прогон содержательный (включая кейс «таймаут с обёрнутой ошибкой», обрезку 2 500 → 2 000 и литерал строки `usage agent=thread-title thread=t-1 input=12 output=5`)
- [ ] oxlint `no-floating-promises` без ошибок
- [ ] Покрытие файла `thread-title.service.ts` ≥ 80 %
- [ ] Каждый Compliance Check = `Y`, доказательства в Investigation Notes
- [ ] lint/tsc/prettier/unit/build — ноль ошибок
- [ ] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `threads.module.ts` (последний в цепочке T2.1 → T2.2 → T3.2 → T4.1 → T4.2).
- Scope boundary: `chat/**` не меняется (подключение — T4.3); `app.e2e-spec.ts` не меняется.
