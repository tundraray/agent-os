# Task T8.2: Dev-only seed для L1-4 и L1-10 (не в репозитории)

Metadata:
- Task type: **dev-only** — скрипт в scratchpad сессии, **никогда не коммитится** и не попадает в репозиторий (правило выполнения 9)
- Phase: 8
- Dependencies: task-T1.3 (стенд работает); может быть подготовлена в любой момент после T1.3
- Provides: `<scratchpad>/seed-l1.ts` (режимы: по умолчанию `SEED-RICH` + `SEED-TOOL-ERROR`; `--pages`; `--pages --remove`) для T8.3
- Size: Small (один скрипт вне репозитория)
- Commit: нет — файлов в репозитории не добавляется; `git status` без новых файлов от T8.2

## Environment (каждая задача)
- Postgres на хост-порту 5433 (`POSTGRES_PORT=5433 pnpm db:up`, `DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os`); `pnpm --filter api dev` (порт 4000) для проверки `GET /api/threads/...`.
- `ai`: `apps/api` — `7.0.148`; `apps/web` — `^7.0.155`. Не менять.
- Next.js 16.4.3 — к этой задаче не относится.
- Node 24.11: снятие типов TS встроено, `tsx` не нужен и не установлен.
- Никаких `git add/commit/stash/checkout`.

## Implementation Content
Скрипт пишет через `Memory.saveThread`/`saveMessages` для resource `dev-user` в БД `localhost:5433` сообщения format 2. Закрывает известный пробел стенда: у ассистента `tools: {}` — нет способа воспроизвести инструмент и упавший инструмент в реальной ленте (L1-4, L1-10 C).

## Target Files
- [x] Нет в репозитории — скрипт `<scratchpad>/seed-l1.ts` в scratchpad сессии исполнителя (путь scratchpad определяется системным окружением сессии; указать полный абсолютный путь в отчёте)

Любой файл внутри репозитория — нарушение; эскалация.

## Investigation Targets
- `apps/api/test/support/seed.ts` (только текстовые части — образец; строки 85-88 — повторный `saveThread`)
- `apps/api/src/mastra/mastra.provider.ts` (как строится `PostgresStore`/`Memory`)
- `apps/api/src/threads/thread.mapper.ts` (что уходит в `/messages`, `maskHistoryErrors`)
- `apps/api/src/mastra/agents/assistant.agent.ts`

## Decisions and Unresolved Items

| Item | Decision | Source / Rule |
|---|---|---|
| `SEED-RICH` | 12 сообщений; ответ с частью рассуждения; ответ с частью инструмента `output-available` и результатом; ответ с таблицей; ответ с блоком кода 80+ строк | План T8.2 |
| `SEED-TOOL-ERROR` | сообщение пользователя, ответ с частью инструмента `output-error`, `errorText: 'boom'`; сообщение пользователя, ответ **только** с частью инструмента; сообщение пользователя, ответ **только** с рассуждением | План T8.2 |
| Идемпотентность | фиксированные id `SEED-RICH`, `SEED-TOOL-ERROR`, удаление перед записью | План T8.2 |
| `--pages` | 120 бесед `SEED-PAGE-001…120` с `updatedAt` по образцу `descendingDates` из `apps/api/test/support/seed.ts` с шагом 12 ч (охват 60 дней — все пять групп, включая «Старше»), по 2 текстовых сообщения; после `saveMessages` повторно вызвать `saveThread` с исходным `updatedAt` (как `seed()` в `apps/api/test/support/seed.ts`, строки 85-88) — `saveMessages` сбрасывает `updatedAt` на `now()` | План T8.2 |
| `--pages --remove` | удаляет `SEED-PAGE-*` | План T8.2 |
| Запуск | `node <scratchpad>/seed-l1.ts [--pages [--remove]]` | План T8.2 |
| Синтаксис | только стираемый TS (без `enum`, `namespace`, parameter properties; типы — `import type`) | План T8.2 |
| Разрешение пакетов | голые спецификаторы из scratchpad не разрешаются; пакеты берутся от `apps/api`: `const require = createRequire('<abs>/apps/api/package.json')`, затем `await import(pathToFileURL(require.resolve('@mastra/memory')).href)` и так же `@mastra/pg` (`createRequire` — `node:module`, `pathToFileURL` — `node:url`) | План T8.2 |

## Investigation Notes
(Полный путь скрипта; результат пробных запусков.)

- Скрипт: `D:/Temp/claude/D--git-github-ai-agent-os/9bee0586-b376-4f97-b39b-7eb4cd59a0ce/scratchpad/seed-l1.ts` (вне репозитория). Пакеты `@mastra/pg`, `@mastra/memory` — через `createRequire('D:/git/github/ai/agent-os/apps/api/package.json')` + `import(pathToFileURL(...))`; хранилище — `new PostgresStore({ connectionString })` + `new Memory({ storage, options: { lastMessages: 20 } })`.
- Формат частей в БД (сверено с реальной строкой `mastra_messages` и `MessageList.toUIPart` в `@mastra/core` 1.80.0): рассуждение `{type:'reasoning', reasoning, details:[{type:'text',text}]}`; инструмент `{type:'tool-invocation', toolInvocation:{state:'result'|'output-error', toolCallId, toolName, args, result|errorText}}`. В БД хранится сырой `errorText: 'boom'`, сервер (`maskHistoryErrors`) отдаёт `'Agent error'`.
- Режимы: без аргументов — `SEED-RICH` (12 сообщений) и `SEED-TOOL-ERROR` (6); `--remove` — удаляет их; `--pages` / `--pages --remove` — `SEED-PAGE-001…120`, шаг 12 ч, повторный `saveThread` после `saveMessages`. Удаление проверяет владельца (`dev-user`), чужие беседы не трогаются.
- Прогон 2026-10-30: без аргументов → `--remove` (GET /messages → 404) → снова без аргументов. `GET /api/threads/SEED-RICH/messages` → 200: reasoning:done+text; tool-getWeather:output-available+text; таблица; блок кода ```ts на 86 строк; ссылки/картинки L1-4; итог. `GET .../SEED-TOOL-ERROR/messages` → 200: tool-failing:output-error (errorText `Agent error`)+text; только tool-getWeather:output-available; только reasoning:done. `boom` в телах ответов — 0 вхождений. Обе беседы видны в `GET /api/threads` с заданным `updatedAt`.
- `--pages` по указанию оркестратора запускался в T8.3 (2026-10-30): `--pages` → проверка FR-19 → `--pages --remove`; после удаления `SEED-PAGE-*` — 0 в `GET /api/threads` и 0 в `mastra_threads`.
- Дополнительно (по запросу оркестратора): `--long` — беседа `SEED-LONG` («SEED-LONG: 50 сообщений»), 50 сообщений user/assistant попеременно, ответы 460–630 символов со списком, блок кода ```ts в каждом 5-м ответе (каждые 10 сообщений, всего 5); тот же порядок saveThread → saveMessages → saveThread, `dev-user`. `--long --remove` — удаляет её. Прогон 2026-10-30: `GET /api/threads/SEED-LONG/messages` → 200, 50 сообщений; беседа видна в `GET /api/threads`.

## Implementation Steps (dev-скрипт; TDD неприменим — проверка запросами к API)
### 1. Подготовка
- [x] Прочитать Investigation Targets; убедиться, что БД на 5433 и API на 4000 запущены

### 2. Скрипт
- [x] Написать `<scratchpad>/seed-l1.ts` по Decisions
- [x] Прогнать без аргументов; прогнать `--pages`, затем `--pages --remove` (`--pages`/`--pages --remove` — в T8.3)

### 3. Проверка
- [x] `GET /api/threads/SEED-RICH/messages` и `.../SEED-TOOL-ERROR/messages` → 200, части нужных типов, в теле нет `boom`
- [x] После `--pages` → `--pages --remove` в `GET /api/threads` не остаётся `SEED-PAGE-*` (и в `mastra_threads` — 0)
- [x] `git status` не показывает новых файлов от T8.2

## Quality Assurance Mechanisms
- Проверка через публичный API (`/messages`, список) — Type: `executable_check` (ручная)
- Правило 9: seed не в репозитории — Type: `passive_constraint`

## Operation Verification Methods
- **Verification method**: запросы `GET /api/threads/...`, `git status`.
- **Success criteria**: перечисленные в Completion Criteria.
- **Failure response**: расхождение формата сообщений format 2 — перечитать `thread.mapper.ts`; не менять `apps/api`.
- **Verification level**: L1 (на стенде).

## Proof Obligations
### Obligation: Known gap — нет инструментов на стенде (L1-4, L1-10 C)
- **Claim**: `SEED-RICH` и `SEED-TOOL-ERROR` отдаются API в нужной форме, ошибка инструмента замаскирована серверным маппером.
- **Primary failure mode**: `boom` протекает в `/messages`; части не тех типов.
- **Boundary to exercise**: HTTP `GET /api/threads/:id/messages` реального API.
- **State assertion**: seed → GET 200, части `reasoning`/`tool`/таблица/код; `errorText` ≠ `boom`.
- **Mock boundary rationale**: none (реальная БД и API).
- **Proven by**: `new (проверка стенда): GET /messages` (автотеста нет — dev-only).
- **Residual**: отображение в ленте — L1-4/L1-10 (T8.3).

## Completion Criteria
- [x] `GET /api/threads/SEED-RICH/messages` и `.../SEED-TOOL-ERROR/messages` → 200, части нужных типов, в теле нет `boom`
- [x] Пробный прогон `--pages`, затем `--pages --remove` — в `GET /api/threads` не остаётся `SEED-PAGE-*`
- [x] `git status` не показывает новых файлов от T8.2
- [x] Полный абсолютный путь скрипта передан оркестратору

## Notes
- Impact scope: данные dev-БД (`dev-user`); `apps/api` без изменений.
- Scope boundary: репозиторий не менять.
