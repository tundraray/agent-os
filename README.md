# Agent OS — сетап

Короткая инструкция по развёртыванию каркаса. Все решения ниже обсуждены и зафиксированы; альтернативы вынесены в конец. Каждая зависимость ставится командой, рядом ссылка на официальную инструкцию установки.

## Решения

| Слой | Выбор | Почему |
|---|---|---|
| Монорепо | pnpm workspaces + Turborepo | Один lockfile, общие пакеты; Turborepo даёт граф задач и кэш сборок почти без конфигурации |
| Фронт | Next.js (App Router) + assistant-ui | Примитивы чата под MIT: вложения, ветки, редактирование, tool UI, approvals |
| Бэкенд | NestJS (Express-платформа) | Guards, interceptors, модули для входа, прав и аудита |
| Агенты | `packages/agents` поверх `packages/runtime` | Каждый агент — задача durable runtime; Nest только собирает пакеты |
| Транспорт | HTTP-команды и SSE (`GET /api/events`) | Команда отвечает сразу, ответ агента идёт живым потоком |
| Хранилище | Postgres (схема `app`, `packages/db`) | Задачи, сессии агентов, беседы, расход и аудит в одной БД |
| Инфра | Свой сервер, Docker Compose; веб пересылает `/api` в API | Без serverless-лимитов на стримы; наружу открыт один порт |

## Структура

```
agent-os/
  apps/
    web/              Next.js + assistant-ui
    api/              NestJS: API чата, SSE, сборка runtime и agents
  packages/
    common/           логгер и общие утилиты
    contracts/        общие типы: инструменты, события, DTO
    db/               модель схемы `app` (Drizzle), миграции, мигратор, createDatabase
    runtime/          durable runtime без NestJS: createRuntime, порты, порт обработчика
    agents/           агенты и глубокие агенты поверх runtime: снимки, сессии, инструменты, start_deep_agent, MCP: createAgents
    mcp-fixture/      HTTP-процесс с фикстурными MCP-серверами `logs`, `backoffice`, `tracker` для разработки и тестов
  infra/
    docker-compose.yml       стек из образов: postgres, migrate, api, web
    docker-compose.dev.yml   порт Postgres для запуска из исходников (pnpm db:up)
  pnpm-workspace.yaml
  turbo.json
  package.json
```

## Шаг 0. Инструменты

| Инструмент | Установка | Инструкция |
|---|---|---|
| Node.js 26 | скачать установщик или через менеджер версий | [nodejs.org/en/download](https://nodejs.org/en/download) |
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
pnpm pkg set scripts.db:up="docker compose -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up -d postgres"

cat > turbo.json <<'EOF'
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": { "outputs": ["dist/**", ".next/**", "!.next/cache/**"] },
    "dev": { "cache": false, "persistent": true },
    "lint": {},
    "test": {}
  }
}
EOF
```

Собираются только приложения (`apps/api`, `apps/web`). Пакеты в `packages/` сборки не имеют: приложения и тесты берут их исходный TypeScript (ADR-0004). Удалённый кэш не нужен, локального достаточно.

## Шаг 2. Общие типы `packages/contracts`

Инструкция: [zod.dev](https://zod.dev).

```bash
mkdir -p packages/contracts/src && cd packages/contracts
pnpm init
pnpm pkg set name="@agent-os/contracts" type="module" exports="./src/index.ts"
pnpm add zod
pnpm add -D typescript
cd ../..
```

Здесь живут схемы DTO чата, описания инструментов и события аудита, которые используют и фронт, и бэкенд.

## Шаг 3. Бэкенд `apps/api`

Инструкции: [NestJS first steps](https://docs.nestjs.com/first-steps), [NestJS configuration](https://docs.nestjs.com/techniques/configuration), [NestJS SSE](https://docs.nestjs.com/techniques/server-sent-events).

`apps/api` — NestJS-приложение, которое собирает пакеты `runtime` и `agents` и отдаёт API чата:

- `src/runtime/`, `src/agents/` — модули-сборщики пакетов: читают переменные окружения.
- `src/chat/` — беседы, агенты, решения, расход (HTTP-команды) и живой поток `GET /api/events` (SSE поверх `LISTEN/NOTIFY` Postgres).
- `src/audit/` — interceptor, пишущий события в Postgres.
- `src/identity/`, `src/access/` — вход, сессии, роли и права на MCP-серверы и модели.
- `src/library/` — записи агентов и глубоких агентов.

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
# необязательно: куда веб пересылает /api (по умолчанию http://localhost:4000)
# API_INTERNAL_URL=http://localhost:4000
```

Артефакты рендерятся через Tool UI assistant-ui в правую панель `ResizablePanel`.

## Шаг 5. Инфра

Инструкции: [образ postgres](https://hub.docker.com/_/postgres), [Docker Compose](https://docs.docker.com/compose/).

`infra/docker-compose.yml` поднимает платформу из образов `ghcr.io/tundraray/agent-os-api:latest` и `ghcr.io/tundraray/agent-os-web:latest`. Сервисы: `postgres`, `migrate` (разовый запуск миграций образом API), `api` (стартует после успешного `migrate`) и `web`. Наружу открыт только порт `3000` веба; браузер достаёт API через пересылку `/api` веба, nginx не нужен.

```bash
cat > infra/.env <<'EOF'        # не коммитится
FRONTEND_ORIGIN=http://localhost:3000   # адрес, на котором браузер открывает веб; по умолчанию этот
SENTRY_DSN=                              # необязательно: проект Sentry для API и веба
EOF
docker compose -f infra/docker-compose.yml up -d
docker compose -f infra/docker-compose.yml ps -a   # migrate — Exited (0), api и web — Up
```

Первая учётная запись — один раз, пароль (12 символов и больше) идёт на стандартный ввод:

```bash
read -rs PW   # пароль вводится без эха и не попадает в историю оболочки
printf '%s' "$PW" | docker compose -f infra/docker-compose.yml run --rm -T api \
  node dist/super-admin-cli.js --login admin --name Admin --email admin@example.com
unset PW
```

Веб — `http://localhost:3000`. Провайдеры моделей и их ключи задаются в панели администратора. Стек на сборке одного коммита: скачать оба образа с тегом `sha-<short sha>` и поставить им локально тег `latest` (`docker tag`); compose скачивает образ, только когда его нет на машине.

Для запуска из исходников (шаг 6) `pnpm db:up` поднимает только `postgres` и публикует его порт `${POSTGRES_PORT:-5432}` наложением `infra/docker-compose.dev.yml`.

Образ — `pgvector/pgvector:pg16-trixie`: PostgreSQL 16 с расширением `vector` на Debian 13 (trixie), как у прежнего `postgres:16`. Debian тот же, поэтому версия сопоставлений (glibc 2.41) у баз на старом томе не меняется. Тег без `-trixie` собран на bookworm — он не подходит.

### Переключение существующей базы разработчика на образ с pgvector

Нужно один раз, если контейнер `infra-postgres-1` был поднят на `postgres:16`. Ниже порт 5433; подставьте свой `POSTGRES_PORT`. Команды — из корня репозитория.

1. Копия базы вне репозитория:
   ```bash
   docker exec infra-postgres-1 pg_dump -U agent -d agent_os -Fc -f /tmp/agent_os.dump
   docker cp infra-postgres-1:/tmp/agent_os.dump <папка-вне-репозитория>/agent_os.dump
   ```
   Размер файла больше нуля.
2. Счёт строк каждой таблицы схемы `app` — в файл рядом с копией:
   ```bash
   docker exec infra-postgres-1 psql -U agent -d agent_os -Atc "select table_name, (xpath('/row/c/text()', query_to_xml('select count(*) as c from app.' || quote_ident(table_name), false, true, '')))[1]::text from information_schema.tables where table_schema='app' and table_type='BASE TABLE' order by 1" > <папка-вне-репозитория>/rows-before.txt
   ```
3. Пересоздать контейнер с новым образом на том же томе:
   ```bash
   POSTGRES_PORT=5433 pnpm db:up
   ```
4. Проверки:
   ```bash
   docker exec infra-postgres-1 psql -U agent -d agent_os -c "select version()"
   docker exec infra-postgres-1 psql -U agent -d agent_os -c "select datname, datcollversion, pg_database_collation_actual_version(oid) from pg_database where datname <> 'template0'"
   docker exec infra-postgres-1 psql -U agent -d agent_os -c "select name from pg_available_extensions where name='vector'"
   ```
   `version()` — 16.x; в каждой строке `datcollversion` равна фактической версии (у `template0` версии нет); `vector` — одна строка.
5. Повторить шаг 2 в `rows-after.txt` и сравнить: файлы совпадают.

Откат при расхождении версий сопоставлений или строк: вернуть в `infra/docker-compose.yml` строку `image: postgres:16` и снова выполнить шаг 3 — контейнер поднимется на прежнем образе с тем же томом. Если данные повреждены, восстановить копию: `docker cp <папка-вне-репозитория>/agent_os.dump infra-postgres-1:/tmp/agent_os.dump`, затем `docker exec infra-postgres-1 pg_restore -U agent -d agent_os --clean --if-exists /tmp/agent_os.dump`.

## Шаг 6. Запуск

Порядок команд, нужные переменные и проверка curl'ом — `apps/api/README.md`, раздел «How to run locally»:

```bash
pnpm install
pnpm db:up
cp apps/api/.env.example apps/api/.env       # провайдеры и ключ задаются посевом seed:access или в панели
pnpm --filter api build
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
| `pnpm db:migrate` | применяет миграции из `packages/db/src/migrations/` к базе `DATABASE_URL` из `apps/api/.env`; нужна собранная `apps/api` (`pnpm --filter api build`: сборка кладёт миграции в `apps/api/dist/migrations`) |
| `pnpm db:generate` | генерирует миграцию из модели `packages/db/src/schema.ts` (drizzle-kit); после правки модели — затем `pnpm db:migrate` |

Тесты с Postgres поднимают базу `DATABASE_URL` (из окружения, иначе из `apps/api/.env`) и сами применяют миграции один раз до набора. Запускайте их **по одному**, не параллельно против одной базы: воркеры runtime (relay, reaper) трогают чужие строки.

| Команда | Что проверяет |
|---|---|
| `pnpm --filter @agent-os/db test:e2e` | миграции и домены CHECK схемы `app` |
| `pnpm --filter @agent-os/runtime test:e2e` | интеграционные тесты runtime и матрицу убийств процесса (дочерний процесс запускается из исходников через `tsx`) |
| `pnpm --filter @agent-os/agents test:e2e` | интеграционные тесты агентов и глубоких агентов |
| `pnpm --filter api test:e2e` | весь e2e-набор `apps/api` (беседы, агенты, решения, живой поток) |
| `pnpm --filter @agent-os/runtime test:verify` | замеры по требованию: старт зависимой задачи (NFR-01) и время восстановления (NFR-04); в обычный набор не входят |

Настройки runtime — переменные окружения `apps/api` (`apps/api/.env.example`, смысл и правила — [`design-runtime.md`](docs/features/agent-platform/design-runtime.md#runtime-settings)). Неверное значение останавливает старт с именем переменной.

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
| `pnpm build` | сборка приложений: `apps/api` (бандл Nest CLI на rspack, исходники пакетов внутри) и `apps/web` (Next); у пакетов в `packages/` сборки нет |
| `pnpm knip` | неиспользуемые файлы, экспорты и зависимости ([knip](https://knip.dev)); настройки в `knip.json` |
| `pnpm check` | всё вышеперечисленное плюс `pnpm test` — то же, что гоняет CI (`.github/workflows/ci.yml`) |

Сообщения коммитов пишутся на английском и проверяются [commitlint](https://commitlint.js.org) по [Conventional Commits](https://www.conventionalcommits.org): `type(scope): subject`, например `feat(web): add new chat button` или `fix(api): keep thread title after delete`. Хук `commit-msg` ставит husky при `pnpm install`; в CI проверяются все коммиты PR.

Скопированные компоненты shadcn и assistant-ui (`components/ui`, `components/assistant-ui`, `file`, `image`, `media-player`, `surfaces`) исключены из проверки неиспользуемых экспортов: это библиотечный код, его API шире того, что использует приложение. Неиспользуемые файлы и зависимости в них по-прежнему ловятся.

## Альтернативы, которые отложены

- **CopilotKit + AG-UI** вместо assistant-ui: даёт общее состояние агент↔приложение и готовый сайдбар, но вложения и переподключение стрима в платном слое.
