# Agent OS — сетап

Короткая инструкция по развёртыванию каркаса. Все решения ниже обсуждены и зафиксированы; альтернативы вынесены в конец. Каждая зависимость ставится командой, рядом ссылка на официальную инструкцию установки.

## Решения

| Слой | Выбор | Почему |
|---|---|---|
| Монорепо | pnpm workspaces + Turborepo | Один lockfile, общие пакеты; Turborepo даёт граф задач и кэш сборок почти без конфигурации |
| Фронт | Next.js (App Router) + assistant-ui | Примитивы чата под MIT: вложения, ветки, редактирование, tool UI, approvals |
| Бэкенд | NestJS (Express-платформа) | Guards, interceptors, модули для auth/аудита/бюджетов |
| Агенты | `packages/agents` поверх `packages/runtime` | Каждый агент — задача durable runtime; Nest только собирает пакеты |
| Транспорт | HTTP-команды и SSE (`GET /api/events`) | Команда отвечает сразу, ответ агента идёт живым потоком |
| Хранилище | Postgres (схема `app`, `packages/db`) | Задачи, сессии агентов, беседы, расход и аудит в одной БД |
| Инфра | Свой сервер, Docker Compose, nginx | Без serverless-лимитов на стримы |

## Структура

```
agent-os/
  apps/
    web/              Next.js + assistant-ui
    api/              NestJS: API чата, SSE, сборка runtime, agents и workflows
  packages/
    common/           логгер и общие утилиты
    contracts/        общие типы: инструменты, события, DTO
    db/               модель схемы `app` (Drizzle), миграции, мигратор, createDatabase
    runtime/          durable runtime без NestJS: createRuntime, порты, порт обработчика
    agents/           агенты поверх runtime: определения, сессии, инструменты, MCP: createAgents
    workflows/        шаблоны процессов (deep-research), инструмент start_workflow, чтение запуска: createWorkflows
    mcp-fixture/      фикстурные MCP-серверы `logs` и `backoffice` для локального запуска и тестов
  infra/
    docker-compose.yml
    nginx.conf
  pnpm-workspace.yaml
  turbo.json
  package.json
```

## Шаг 0. Инструменты

| Инструмент | Установка | Инструкция |
|---|---|---|
| Node.js 22+ | скачать установщик или через менеджер версий | [nodejs.org/en/download](https://nodejs.org/en/download) |
| pnpm 9+ | `corepack enable && corepack prepare pnpm@latest --activate` | [pnpm.io/installation](https://pnpm.io/installation) |
| Docker + Compose | Docker Desktop или пакет дистрибутива | [docs.docker.com/compose/install](https://docs.docker.com/compose/install/) |

Проверка: `node -v`, `pnpm -v`, `docker compose version`.

## Шаг 1. Монорепо

Инструкции: [pnpm workspaces](https://pnpm.io/workspaces), [Turborepo installation](https://turborepo.com/docs/getting-started/installation).

```bash
pnpm init
pnpm pkg set packageManager="pnpm@9" private=true
printf 'packages:\n  - "apps/*"\n  - "packages/*"\n' > pnpm-workspace.yaml
mkdir -p apps packages infra

pnpm add -Dw turbo typescript
pnpm pkg set scripts.dev="turbo dev" scripts.build="turbo build" scripts.lint="turbo lint" scripts.test="turbo test"
pnpm pkg set scripts.db:up="docker compose -f infra/docker-compose.yml up -d"

cat > turbo.json <<'EOF'
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "test": { "dependsOn": ["^build"] }
  }
}
EOF
```

`^build` означает «сначала собрать зависимости», так `packages/contracts` всегда собирается до `apps/*`. Удалённый кэш не нужен, локального достаточно.

## Шаг 2. Общие типы `packages/contracts`

Инструкция: [zod.dev](https://zod.dev).

```bash
mkdir -p packages/contracts/src && cd packages/contracts
pnpm init
pnpm pkg set name="@agent-os/contracts" type="module" main="./dist/index.js" types="./dist/index.d.ts"
pnpm pkg set scripts.build="tsc -p tsconfig.json"
pnpm add zod
pnpm add -D typescript
cd ../..
```

Здесь живут схемы DTO чата, описания инструментов и события аудита, которые используют и фронт, и бэкенд.

## Шаг 3. Бэкенд `apps/api`

Инструкции: [NestJS first steps](https://docs.nestjs.com/first-steps), [NestJS configuration](https://docs.nestjs.com/techniques/configuration), [NestJS SSE](https://docs.nestjs.com/techniques/server-sent-events).

`apps/api` — NestJS-приложение, которое собирает пакеты `runtime`, `agents` и `workflows` и отдаёт API чата:

- `src/runtime/`, `src/agents/`, `src/workflows/` — модули-сборщики пакетов: читают переменные окружения и файлы `config/`.
- `src/chat/` — беседы, агенты, решения, расход (HTTP-команды) и живой поток `GET /api/events` (SSE поверх `LISTEN/NOTIFY` Postgres).
- `src/audit/` — interceptor, пишущий события в Postgres.
- `src/auth/` — `SessionGuard`: в разработке все запросы идут от `dev-user` (заголовок `x-user-id` подменяет пользователя).

Переменные окружения и запуск — `apps/api/README.md` («How to run locally») и `apps/api/.env.example`.

## Шаг 4. Фронт `apps/web`

Инструкции: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [assistant-ui installation](https://www.assistant-ui.com/docs/installation), [shadcn Resizable](https://ui.shadcn.com/docs/components/resizable).

```bash
cd apps
pnpm create next-app@latest web --ts --app --tailwind --eslint --src-dir --use-pnpm --no-import-alias
cd web

# assistant-ui: примитивы ленты и композера (запускать строго внутри apps/web)
pnpm dlx assistant-ui@latest init

# сплит-раскладка «рабочая область + чат» (ставит react-resizable-panels)
pnpm dlx shadcn@latest add resizable

# общие типы и логгер из монорепо
pnpm add @agent-os/contracts@workspace:* @agent-os/common@workspace:*
cd ../..
```

Лента — assistant-ui с внешним хранилищем (`useExternalStoreRuntime`): команды уходят HTTP-запросами, живые обновления приходят одним потоком SSE `GET /api/events`.

Переменные (`apps/web/.env.local`, образец — `apps/web/.env.example`), запуск и маршруты — `apps/web/README.md`:

```
NEXT_PUBLIC_API_URL=http://localhost:4000
```

Артефакты рендерятся через Tool UI assistant-ui в правую панель `ResizablePanel`.

## Шаг 5. Инфра

Инструкции: [образ postgres](https://hub.docker.com/_/postgres), [nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html).

```bash
cat > infra/docker-compose.yml <<'EOF'
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: agent
      POSTGRES_PASSWORD: agent
      POSTGRES_DB: agent_os
    ports:
      - "${POSTGRES_PORT:-5432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
EOF
```

`infra/nginx.conf`, для потока `/api/events`:

```
proxy_buffering off;
proxy_read_timeout 3600s;
proxy_set_header Connection '';
proxy_http_version 1.1;
```

## Шаг 6. Запуск

Порядок команд, нужные переменные и проверка curl'ом — `apps/api/README.md`, раздел «How to run locally»:

```bash
pnpm install
pnpm db:up
cp apps/api/.env.example apps/api/.env       # и вписать ANTHROPIC_API_KEY
pnpm turbo build --filter=api...
pnpm --filter api db:migrate
pnpm --filter api start:dev
```

Хост-порт Postgres задаётся переменной `POSTGRES_PORT` (по умолчанию 5432). Если 5432 занят, поднимите базу на другом порту и укажите тот же порт в `DATABASE_URL` в `apps/api/.env`:

```bash
POSTGRES_PORT=5433 pnpm db:up
# apps/api/.env: DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os
```

Проверка: шаги с curl из `apps/api/README.md` — сообщение отвечает 202, в потоке `GET /api/events` идут `ready`, `delta` и `tree`.

## База данных, миграции и runtime

Таблицы приложения живут в схеме `app`; модель и миграции — в пакете `@agent-os/db` (ADR-0003, ADR-0004). Приложение при старте только сверяет миграции с журналом и не мигрирует само: на базе с неприменёнными миграциями `apps/api` завершается до открытия порта и называет файлы.

| Команда | Что делает |
|---|---|
| `pnpm db:migrate` | применяет миграции из `packages/db/migrations/` к базе `DATABASE_URL` из `apps/api/.env`; нужна собранная `apps/api` (`pnpm turbo build --filter=api...`) |
| `pnpm db:generate` | генерирует миграцию из модели `packages/db/src/schema.ts` (drizzle-kit); после правки модели — затем `pnpm db:migrate` |

Тесты с Postgres поднимают базу `DATABASE_URL` (из окружения, иначе из `apps/api/.env`) и сами применяют миграции один раз до набора. Запускайте их **по одному**, не параллельно против одной базы: воркеры runtime (relay, reaper) трогают чужие строки.

| Команда | Что проверяет |
|---|---|
| `pnpm --filter @agent-os/db test:e2e` | миграции и домены CHECK схемы `app` |
| `pnpm --filter @agent-os/runtime test:e2e` | интеграционные тесты runtime и матрицу убийств процесса (собирает пакет и дочерний процесс) |
| `pnpm --filter @agent-os/agents test:e2e` / `pnpm --filter @agent-os/workflows test:e2e` | интеграционные тесты агентов и шаблонов процессов |
| `pnpm --filter api test:e2e` | весь e2e-набор `apps/api` (беседы, агенты, решения, живой поток) |
| `pnpm --filter @agent-os/runtime test:verify` | замеры по требованию: старт зависимой задачи (NFR-01) и время восстановления (NFR-04); в обычный набор не входят |

Настройки runtime — переменные окружения `apps/api` (`apps/api/.env.example`, смысл и правила — `docs/features/agent-platform/design-runtime.md`, Runtime Settings). Неверное значение останавливает старт с именем переменной. Настройки агентов (`AGENT_*`, `MCP_*`) — там же, в `.env.example`.

| Переменная | По умолчанию |
|---|---|
| `RUNTIME_WORKERS` | `on` (`off` — без воркеров) |
| `RUNTIME_CONCURRENCY` | 16 |
| `RUNTIME_POLL_MS` | 500 |
| `RUNTIME_NOTIFY` | `on` |
| `RUNTIME_LEASE_MS` / `RUNTIME_HEARTBEAT_MS` / `RUNTIME_REAPER_MS` | 30000 / 10000 / 5000 |
| `RUNTIME_MAX_RECOVERIES` | 3 |
| `RUNTIME_DELIVERY_MAX_ATTEMPTS` | 5 |
| `RUNTIME_SHUTDOWN_GRACE_MS` | 5000 |
| `RUNTIME_STEP_MS` | 900000 (не меньше 1000; предел длительности одного шага) |
| `DB_POOL_MAX` | 10 |
| `INBOX_PAYLOAD_MAX_BYTES` | 1048576 |
| `RUNTIME_CRASH_AT` | не задана (только для тестов) |

## Проверки качества

| Команда | Что делает |
|---|---|
| `pnpm lint` | oxlint (`api` и пакеты в `packages/`) и ESLint (`web`); любое предупреждение — ошибка |
| `pnpm typecheck` | `tsc --noEmit` по всем пакетам, включая тесты (`web` сначала генерирует типы роутов `next typegen`) |
| `pnpm build` | сборка всех пакетов |
| `pnpm knip` | неиспользуемые файлы, экспорты и зависимости ([knip](https://knip.dev)); настройки в `knip.json` |
| `pnpm check` | всё вышеперечисленное плюс `pnpm test` — то же, что гоняет CI (`.github/workflows/ci.yml`) |

Сообщения коммитов пишутся на английском и проверяются [commitlint](https://commitlint.js.org) по [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`, например `feat(web): add new chat button` или `fix(api): keep thread title after delete`. Хук `commit-msg` ставит husky при `pnpm install`; в CI проверяются все коммиты PR.

Скопированные компоненты shadcn и assistant-ui (`components/ui`, `components/assistant-ui`, `file`, `image`, `media-player`, `surfaces`) исключены из проверки неиспользуемых экспортов: это библиотечный код, его API шире того, что использует приложение. Неиспользуемые файлы и зависимости в них по-прежнему ловятся.

## Что дальше

1. Авторизация через корпоративный OIDC в `apps/api/src/auth`.
2. Бюджеты токенов на пользователя и подразделение.
3. Инструменты в изолированных Docker-воркерах (`apps/api/src/sandbox`).

## Альтернативы, которые отложены

- **CopilotKit + AG-UI** вместо assistant-ui: даёт общее состояние агент↔приложение и готовый сайдбар, но вложения и переподключение стрима в платном слое.
