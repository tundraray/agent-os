# Task T8.4: Отложенные проверки `threads-api` T6.3-a (метрика № 10) и T6.3-b (метрика № 7)

Metadata:
- Task type: **L1/browser** — выполняет **оркестратор** через Claude-in-Chrome (и измерения на стенде); шаги `[DevTools — user]` — просьба пользователю. Не отдавать `task-executor-frontend`.
- Phase: 8
- Dependencies: task-T8.1 (production-сборка), task-T8.3 (стенд свободен: T6.3-a останавливает API на порту 4000 ради worktree `83fd532`)
- Provides: измерения метрик № 10 и № 7; перенос результатов в Notes плана `threads-api` («L1 / метрики № 7, № 10») через `update` этого плана оркестратором (статус `completed` у `threads-api` сохраняется)
- Size: Small по файлам (1 документ)
- Commit: manual — репозиторий меняется только `l1-browser-scenarios.md` (Evidence, Sign-off)

## Environment (каждая задача)
- Postgres 5433 (`POSTGRES_PORT=5433 pnpm db:up`, `postgres://agent:agent@localhost:5433/agent_os`); `apps/api/.env`: `FRONTEND_ORIGIN=http://localhost:3000`; `pnpm --filter api dev` (порт 4000); `apps/web/.env.local`: `NEXT_PUBLIC_API_URL=http://localhost:4000`; production-сборка web.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Ключ `ANTHROPIC_API_KEY` из `apps/api/.env` разрешён пользователем (Открытые вопросы плана п. 1).
- Никаких `git add/commit/stash/checkout` в основном репозитории; git worktree — вне репозитория, удаляется в конце.

## Implementation Content
Отложенные из `threads-api` T6.3 проверки, требующие реальных ключей провайдера: T6.3-a — задержка (метрика № 10) «до» (`main` `83fd532`, worktree) и «после» (текущая ветка); T6.3-b — качество автозаголовков (метрика № 7).

## Target Files
- [ ] `docs/features/chat-shell/web-shell/l1-browser-scenarios.md` (Evidence, Sign-off)

## Investigation Targets
- Раздел «Deferred from `threads-api` T6.3» в `docs/features/chat-shell/web-shell/l1-browser-scenarios.md`
- Лог `apps/api` (время появления заголовка)
- `docs/features/chat-shell/threads-api/20261028-feature-threads-api.md` (Notes «L1 / метрики № 7, № 10» — только чтение; запись делает оркестратор через `update`)

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| T6.3-a | «до» — `main` `83fd532` в git worktree вне репозитория; по разогреву и 5 прогонов на каждую сторону; median(after) − median(before) ≤ 50 мс, иначе эскалация с десятью значениями; worktree удалить | План T8.4 |
| T6.3-b | 20 новых бесед (10 RU, 10 EN); ≥ 19 из 20 заголовков 1…80 символов без кавычек и переносов, на языке первого сообщения, видны ≤ 15 с; лог `apps/api` — ≤ 10 с; провал — эскалация | План T8.4 |
| Остановка API | T6.3-a останавливает API на порту 4000 ради worktree `83fd532`; после — вернуть стенд | План, граф зависимостей |
| Перенос результатов | В Notes плана `threads-api` — оркестратор через `update` этого плана | План T8.4 |

## Investigation Notes
(Десять значений и медианы; таблица 20 бесед.)

## Implementation Steps (процедура L1; TDD неприменим)
### 1. Предусловия
- [ ] T8.1 и T8.3 завершены; ключ провайдера действителен

### 2. T6.3-a (метрика № 10)
- [ ] Создать worktree `main@83fd532` вне репозитория; прогнать по разогреву + 5 прогонов «до»; остановить/перезапустить API по необходимости; 5 прогонов «после»
- [ ] Вычислить median(after) − median(before); > 50 мс → эскалация с десятью значениями
- [ ] Удалить worktree

### 3. T6.3-b (метрика № 7)
- [ ] 20 новых бесед (10 RU, 10 EN); собрать заголовки; проверить длину 1…80, отсутствие кавычек/переносов, язык, видимость ≤ 15 с и ≤ 10 с по логу API
- [ ] < 19/20 → эскалация

### 4. Фиксация
- [ ] Evidence и Sign-off; результаты — оркестратору для переноса в Notes плана `threads-api`

## Quality Assurance Mechanisms
- Измерения по чек-листу — Type: `executable_check` (ручная процедура)
- `git worktree list` — только основной — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: раздел «Deferred from `threads-api` T6.3» чек-листа.
- **Success criteria**: median(after) − median(before) ≤ 50 мс; ≥ 19/20 заголовков удовлетворяют критериям, видны ≤ 15 с (лог API ≤ 10 с).
- **Failure response**: эскалация пользователю с данными (десять значений / таблица 20 бесед).
- **Verification level**: L1.

## Proof Obligations
### Obligation: Метрика № 10 (T6.3-a) — вклад `threads-api` в задержку
- **Claim**: median(after) − median(before) ≤ 50 мс.
- **Primary failure mode**: регрессия задержки первого токена из-за проверки существования беседы.
- **Boundary to exercise**: реальный API + модель, «до»/«после».
- **State assertion**: N/A.
- **Mock boundary rationale**: none.
- **Proven by**: `new (L1): T6.3-a`.
- **Residual**: нет.

### Obligation: Метрика № 7 (T6.3-b) — качество автозаголовков
- **Claim**: ≥ 19/20 заголовков корректны и появляются ≤ 15 с.
- **Primary failure mode**: заголовки в кавычках/с переносом/не на языке сообщения/слишком поздно.
- **Boundary to exercise**: реальный API + модель + UI.
- **State assertion**: заголовок отсутствует → появился ≤ 15 с.
- **Mock boundary rationale**: none.
- **Proven by**: `new (L1): T6.3-b`.
- **Residual**: нет.

## Completion Criteria
- [ ] Десять значений и медианы записаны
- [ ] Таблица 20 бесед записана
- [ ] `git worktree list` — только основной

## Notes
- Impact scope: стенд; остановка API на порту 4000 во время T6.3-a.
- Scope boundary: `apps/api`/`apps/web` код не менять; план `threads-api` — только через `update` оркестратором (статус `completed` сохраняется).
