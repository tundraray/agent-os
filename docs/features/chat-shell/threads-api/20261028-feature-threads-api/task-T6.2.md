# Task T6.2: Итоговые гейты качества и проверка всех AC

Metadata:
- Plan: docs/features/chat-shell/threads-api/20261028-feature-threads-api.md (Phase 6, T6.2)
- Dependencies: T3.5 → Deliverable: `AuditInterceptor` + unit; T6.1 → Deliverable: perf-кейсы и решение о `test:perf` (транзитивно — все задачи T1.1–T5.1)
- Provides: подтверждение готовности части к пользовательскому утверждению; заполненная таблица «Проверка AC»
- Size: Small (проверочная задача; изменений кода нет)

## Commit Strategy (manual)
Стратегия коммитов фичи — `manual`. **Исполнитель задачи НЕ запускает `git commit`** (также не `git add`/`git push`/`git stash`/`git reset`): изменения остаются в рабочем дереве ветки `feature/chat-shell`. Задача завершается в состоянии «готово к коммиту (manual-стратегия)»: все гейты задачи пройдены, затронуты только Target Files. Коммит делает пользователь или он создаётся по его явной просьбе (без строк `Co-Authored-By`, `Claude-Session`, «Generated with Claude Code»).

## Implementation Content
Проверочная задача: прогон всех гейтов качества и сверка каждого AC Design Doc с тестами. Кода не пишет. Исправления, если гейт упал, выполняются в рамках файлов уже затронутых задач, **отдельной единицей, готовой к коммиту (manual-стратегия)** — с эскалацией оркестратору, если нужен файл вне Target Files соответствующей задачи.

## Target Files
Изменений кода нет. Разрешено править только файлы, уже затронутые задачами плана, и только для исправления упавшего гейта (отдельная единица). Если агрегат покрытия < 80 % из-за контроллера/сервиса, покрытых только e2e — добавить unit-тесты `ThreadsService.list`/`listMessages`/`create`/`delete` с фейковым `Memory` в `apps/api/src/threads/threads.service.spec.ts` (файл T3.4) отдельной единицей, готовой к коммиту.

## Investigation Targets
- `docs/features/chat-shell/threads-api/20261028-feature-threads-api.md` (§ «Проверка AC», § Quality Assurance Mechanisms)
- `docs/features/chat-shell/design-threads-api.md` (§ AC — EARS)
- `apps/api/vitest.config.ts`, `apps/api/package.json`

## Reference Contracts
Отдельных строк Reference Contract Values для T6.2 нет; обязательство — исполняемые гейты ниже.

## Investigation Notes
(Заполняется исполнителем: результат каждого шага, время прогона `test:e2e`.)

## Implementation Steps
- [ ] `pnpm db:up`; `pnpm --filter @agent-os/contracts build`
- [ ] `pnpm --filter api lint`
- [ ] `pnpm --filter api exec tsc --noEmit -p tsconfig.json`
- [ ] `pnpm --filter api exec prettier --check "src/**/*.ts" "test/**/*.ts"`
- [ ] `pnpm --filter api exec vitest run --coverage --coverage.include='src/threads/**' --coverage.include='src/common/**' --coverage.thresholds.lines=80` — исполняемый гейт покрытия: ненулевой код выхода = гейт не пройден
- [ ] `pnpm --filter api test:e2e` (зафиксировать время прогона)
- [ ] `pnpm --filter api build`
- [ ] `pnpm test` (turbo, `^build`)
- [ ] `pnpm why -r ai` — `apps/api` `ai` 7.0.148, `apps/web` 7.0.155 (Проверка версий `ai` DD); результат записать в Investigation Notes
- [ ] `git diff main -- packages/contracts/src/index.ts` = одна добавленная строка `export * from './threads.js';`
- [ ] `git diff --exit-code apps/api/test/app.e2e-spec.ts` — пусто (AC-18.3)
- [ ] Проверка атрибуции по всем коммитам, существующим на ветке на момент T6.2 (при manual-стратегии их может не быть — пустой диапазон считается пройденным): `git log --format=%B main..HEAD | grep -iE '^(co-authored-by|claude-session):|generated with claude'` — вывод пуст (код выхода `grep` = 1)
- [ ] Заполнить таблицу «Проверка AC» (ниже)
- [ ] Исполнитель сам **не коммитит**; при необходимости исправлений — отдельная единица, готовая к коммиту

## Проверка AC (заполняется в T6.2)

| AC | Тест(ы) | Задача |
|---|---|---|
| AC-13.1 | e2e `AC-13.1` | T3.1 |
| AC-13.2 | e2e `AC-13.2`, unit `thread-cursor.spec.ts` | T3.1 |
| AC-13.2a | e2e `AC-13.2a`, unit `thread-cursor.spec.ts` | T3.4, T3.1 |
| AC-13.3 | e2e `AC-13.3` | T3.4 |
| AC-13.4 | perf `AC-13.4` | T6.1 |
| AC-14.1 | e2e `AC-14.1`, `AC-14.1 (output comparison)` | T2.2, T2.3 |
| AC-14.2 / AC-14.3 | e2e IDOR GET | T2.2 |
| AC-14.4 | perf `AC-14.4` | T6.1 |
| AC-15.1 / 15.2 / 15.3 | e2e `AC-15.1`, `AC-15.2`, IDOR PATCH | T3.4 |
| AC-16.1 | e2e `AC-16.1/AC-16.3` (threads), `AC-16.1` (chat) | T3.3, T5.1 |
| AC-16.2 / AC-16.3 | e2e IDOR DELETE, `AC-16.1/AC-16.3` | T3.3 |
| AC-17.1 / 17.2 / 17.3 | e2e 17.x, unit `thread-title.service.spec.ts` | T4.3, T4.2 |
| AC-18.1 | `contracts.spec.ts`, сборка contracts | T1.1 |
| AC-18.3 | `app.e2e-spec.ts` без правок | T1.2, T5.1, T6.2 |


## Quality Assurance Mechanisms
- oxlint type-aware (`typescript/no-floating-promises: error`) — Enforces: нет висящих промисов, типовые ошибки — Config/Source: `apps/api/.oxlintrc.json` — Type: `executable_check`
- TypeScript `strict`, `nodenext`, `.js`-суффиксы импортов — Enforces: строгие типы, без `as`-обхода — Config/Source: `apps/api/tsconfig.json`, `packages/contracts/tsconfig.json` — Type: `executable_check`
- Prettier — Enforces: форматирование — Config/Source: `apps/api/.prettierrc` — Type: `executable_check`
- Vitest unit / e2e (реальный Postgres) — Enforces: поведение и AC — Config/Source: `apps/api/vitest.config.ts`, `apps/api/vitest.config.e2e.ts` — Type: `executable_check`
- `nest build` — Enforces: сборка production-кода — Config/Source: `apps/api/tsconfig.build.json`, `apps/api/nest-cli.json` — Type: `executable_check`
- Без миграций и новых таблиц — Enforces: система записи — `mastra_threads`/`mastra_messages` — Config/Source: Design Doc «Agreement Checklist» — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: полный прогон гейтов (Implementation Steps) и ручной старт `pnpm --filter api dev`: отвечает на `/api/chat` и `/api/threads`. Операционные процедуры Integration Points 1–4 DD (см. Phase 2, 3, 4, 5 completion) выполняются заново одним полным прогоном `test:e2e` и unit.
- **Success criteria**: все гейты — код выхода 0; покрытие `src/threads` и `src/common` ≥ 80 %; все AC из раздела EARS DD отмечены по результатам тестов; нерешённых тестов: 0 (21/21 интеграционных из скелетов + 5/5 доп., 2/2 perf, все unit); `pnpm why -r ai` — `apps/api` `ai` 7.0.148, `apps/web` 7.0.155; `index.ts` — одна добавленная строка; проверка атрибуции — пустой вывод.
- **Failure response**: упавший гейт — исправление отдельной единицей в рамках файлов затронутых задач; при необходимости файла вне Target Files — эскалация оркестратору.
- **Verification level**: L1 (ручной старт) + L2 + L3.

## Proof Obligations
### Obligation: итоговое покрытие AC
- **Claim**: каждый AC Design Doc проходит автоматический тест; 0 `it.todo`.
- **Primary failure mode**: AC без теста или тест-заглушка; устаревший `dist` contracts при прямом запуске vitest.
- **Boundary to exercise**: полный набор unit/e2e/perf; `pnpm test` через turbo (`^build`).
- **State assertion**: N/A.
- **Mock boundary rationale**: как в задачах-источниках.
- **Residual**: L1 с реальной моделью — T6.3.

## Completion Criteria
- [ ] Гейт покрытия завершился с кодом 0
- [ ] Проверка атрибуции — пустой вывод
- [ ] Все AC из раздела EARS DD отмечены по результатам тестов (таблица выше)
- [ ] Нерешённых тестов: 0 (21/21 интеграционных из скелетов + 5/5 доп., 2/2 perf, все unit); время прогона `test:e2e` записано в Notes плана
- [ ] Все гейты (lint, tsc, prettier, unit+coverage, e2e, build, `pnpm test`) — ноль ошибок
- [ ] `git commit` не выполнялся

## Notes
- Impact scope: нет (проверка).
- Scope boundary: файлы вне ранее затронутых задачами не меняются.
