# Task T1.2: `configureApp`, `ZodValidationPipe`, зависимость `zod` в `apps/api`

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 1, T1.2)
- Dependencies: T1.1 → Deliverable: `packages/contracts/dist` (собранный `@agent-os/contracts`)
- Provides: `configureApp(app)` (для `main.ts` и `createTestApp` в T1.3), `ZodValidationPipe` (для T2.2 и далее)
- Parallel: T1.2 ‖ T1.3 (после T1.1)
- Size: Medium (6 файлов, из них `pnpm-lock.yaml` генерируется)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
`configureApp(app)` в `app.setup.ts` — `setGlobalPrefix('api')`, `enableCors(...)`, `useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))` — перенос из `main.ts` без изменения поведения; `main.ts` вызывает её, `enableShutdownHooks`, `listen`, `MastraLifecycle.start()` остаются. `ZodValidationPipe` в `apps/api/src/common/`; зависимость `zod: ^4.6.7` в `apps/api/package.json`.

## Target Files
- [x] `apps/api/src/app.setup.ts` (new)
- [x] `apps/api/src/main.ts`
- [x] `apps/api/src/common/zod-validation.pipe.ts` (new)
- [x] `apps/api/src/common/zod-validation.pipe.spec.ts` (new)
- [x] `apps/api/package.json` (`zod: ^4.6.7`)
- [x] `pnpm-lock.yaml`

These paths define the executor's File Scope Constraint. Файл вне списка менять нельзя без эскалации.

## Investigation Targets
- `apps/api/src/main.ts` (текущая инлайн-настройка HTTP)
- `apps/api/test/app.e2e-spec.ts` (не менять; должен проходить)
- `docs/features/chat-shell/design-threads-api.md` (§ Main Components `ZodValidationPipe`, § Integration Point 4 `configureApp`)
- `packages/contracts/package.json` (версия `zod` для согласования)

## Reference Contracts
| Source | Contract Type | Required Observable Value | Compliance Check |
|---|---|---|---|
| design-threads-api.md (§ ZodValidationPipe) | derived-display | «`BadRequestException({ statusCode: 400, error: 'Bad Request', errorCode: 'VALIDATION_FAILED', message: issues.map(i => `${i.path.join('.') \|\| '(root)'}: ${i.message}`) })`» | Y, если при ошибке пайп бросает исключение с `statusCode: 400`, `error: 'Bad Request'`, `errorCode: 'VALIDATION_FAILED'`, `message` — массив строк `'<path>: <message>'`, корневая ошибка — `'(root): …'` |

## Decisions and Unresolved Items
| Item | Decision | Source / Rule |
|---|---|---|
| Возвращаемое значение пайпа | возвращает `result.data` (преобразованные данные, trim), не исходное значение | work plan T1.2, Proof obligations |

## Investigation Notes
- **Наблюдения**: `main.ts` инлайн выполнял `setGlobalPrefix('api')`, `enableCors({ origin: FRONTEND_ORIGIN ?? 'http://localhost:3000', credentials: true })`, `useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))`. `app.e2e-spec.ts` не вызывает настройку приложения (бьёт в `/chat` без префикса) — вынос `configureApp` его не затрагивает. `packages/contracts` использует `zod ^4.6.7` (установлен 4.6.7) — та же версия добавлена в `apps/api`. `apps/api/src/common/` не существовал; похожих пайпов в репозитории нет (`ZodValidationPipe`/`PipeTransform` — 0 совпадений), дублирования нет.
- **Deliverable T1.1**: `packages/contracts/dist` (`index.js`, `threads.js`, `.d.ts`) собран.
- **План подхода (Reference Contract)**: `ZodValidationPipe<T extends ZodType>` вызывает `schema.safeParse(value)`; успех → `result.data` (решение «возвращает преобразованные данные»); ошибка → `new BadRequestException({ statusCode: 400, error: 'Bad Request', errorCode: 'VALIDATION_FAILED', message: issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`) })` — дословно по Design Doc.
- **Compliance Check = Y** (по финальной реализации): `zod-validation.pipe.spec.ts` литерально проверяет `getResponse()` = `{ statusCode: 400, error: 'Bad Request', errorCode: 'VALIDATION_FAILED', message: ['title: Too short', 'meta.tag: Expected tag'] }`, корневая ошибка → `['(root): Expected a string']`; успех → `{ title: 'Trip plan' }` из `'  Trip plan  '` (trim), лишний ключ отброшен.
- **AC-18.3 (промежуточно)**: `pnpm --filter api test:e2e -- app.e2e-spec` — 2 passed; `git diff --exit-code apps/api/test/app.e2e-spec.ts` пуст.
- **Ручная проверка (L1)**: собранный `node dist/main.js` (тот же bootstrap, что `pnpm --filter api dev`, без watch): `POST /api/chat/no-such-agent {"id":"x","messages":[]}` → 404 `Unknown agent: no-such-agent`; `POST /api/chat/assistant {"messages":[]}` → 400 `threadId or id is required`; preflight с `Origin: http://localhost:3000` → 204 и `Access-Control-Allow-Origin: http://localhost:3000`.
- **Gates**: lint 0, tsc 0, unit 28/28, build OK. Prettier: новые/изменённые файлы чистые; 10 предсуществующих файлов вне Target Files (`app.module.ts`, `audit/*`, `auth/session.guard.ts`, `chat/chat.controller.ts`, `mastra/*`) — долг вне scope задачи.

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
- **Verification method**: unit `zod-validation.pipe.spec.ts`; `pnpm db:up` и `pnpm --filter api test:e2e -- app.e2e-spec`; ручной старт `pnpm --filter api dev` и запрос `POST localhost:4000/api/chat/no-such-agent` с телом `{"id":"x","messages":[]}`.
- **Success criteria**: unit зелёный; 2 теста `app.e2e-spec.ts` зелёные без правок файла; ручной запрос отвечает 404 как прежде.
- **Failure response**: расхождение поведения с прежним `main.ts` — вернуть идентичность, не править `app.e2e-spec.ts`.
- **Verification level**: L1 (ручной старт) + L2.

## Proof Obligations
### Obligation: VALIDATION_FAILED body
- **Claim**: ошибка схемы превращается в 400 с `errorCode: 'VALIDATION_FAILED'` и читаемым массивом `message`; успех возвращает преобразованные данные (trim).
- **Primary failure mode**: пайп возвращает исходное значение вместо `result.data`; корневая ошибка без `(root)`.
- **Boundary to exercise**: in-process unit.
- **State assertion**: N/A.
- **Mock boundary rationale**: none (чистая функция над zod-схемой).
- **Residual**: HTTP-уровень покрывается e2e T2.2+.

### Obligation: AC-18.3 (промежуточно)
- **Claim**: `app.e2e-spec.ts` проходит без правок после выноса `configureApp`.
- **Primary failure mode**: смена поведения глобального префикса/пайпа/CORS.
- **Boundary to exercise**: e2e `app.e2e-spec.ts`.
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Residual**: окончательно — T5.1, T6.2.

## Completion Criteria
- [x] Unit зелёный, прогон содержательный
- [x] `test/app.e2e-spec.ts` проходит без правок (`git diff --exit-code apps/api/test/app.e2e-spec.ts` пуст)
- [x] Ручной старт `pnpm --filter api dev` отвечает на `/api/chat` как раньше
- [x] Compliance Check = `Y`, доказательство в Investigation Notes
- [x] Gates (lint, tsc, prettier, unit, e2e `app.e2e-spec`, build) — ноль ошибок
- [x] Готово к коммиту (manual-стратегия); `git commit` не выполнялся

## Notes
- Impact scope: `main.ts` (все HTTP-маршруты), `pnpm-lock.yaml`.
- Scope boundary: `apps/api/test/app.e2e-spec.ts` и `packages/contracts/**` не меняются.
