# Agent OS — сетап

Короткая инструкция по развёртыванию каркаса. Все решения ниже обсуждены и зафиксированы; альтернативы вынесены в конец. Каждая зависимость ставится командой, рядом ссылка на официальную инструкцию установки.

## Решения

| Слой | Выбор | Почему |
|---|---|---|
| Монорепо | pnpm workspaces + Turborepo | Один lockfile, общие пакеты; Turborepo даёт граф задач и кэш сборок почти без конфигурации |
| Фронт | Next.js (App Router) + assistant-ui | Примитивы чата под MIT: вложения, ветки, редактирование, tool UI, approvals |
| Бэкенд | NestJS (Express-платформа) | Guards, interceptors, модули для auth/аудита/бюджетов |
| Агенты | Mastra как библиотека внутри Nest | Полный контроль над HTTP-слоем; MastraModule не используем |
| Транспорт | AI SDK UI message stream через `@mastra/ai-sdk` | Официально задокументированный путь Mastra ↔ assistant-ui |
| Хранилище | Postgres (`@mastra/pg`) | Память, треды, снапшоты воркфлоу, аудит в одной БД |
| Инфра | Свой сервер, Docker Compose, nginx | Без serverless-лимитов на стримы |

## Структура

```
agent-os/
  apps/
    web/              Next.js + assistant-ui
    api/              NestJS + Mastra
  packages/
    contracts/        общие типы: инструменты, события, DTO
    db/               модель схемы `app` (Drizzle), миграции, мигратор, createDatabase
    runtime/          durable runtime исследований без NestJS: createRuntime, порты, порт обработчика
    sources/          источники данных по MCP: createSources, исполнитель source.fetch, ToolExecutor, адаптер fixture
    engine/           исследовательский движок без NestJS: createEngine, контроллер, воркеры, проверка утверждений, синтез ответа
    mcp-fixture/      тестовый MCP-сервер логов (stdio): детерминированные срезы v1/v2, эталон, режимы отказа
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

Инструкции: [NestJS first steps](https://docs.nestjs.com/first-steps), [Mastra в NestJS](https://mastra.ai/guides/getting-started/nestjs), [Mastra memory](https://mastra.ai/docs/memory/overview), [Mastra PostgreSQL storage](https://mastra.ai/reference/storage/postgresql), [Mastra ↔ AI SDK](https://mastra.ai/docs/frameworks/agentic-uis/ai-sdk), [AI SDK в NestJS](https://ai-sdk.dev/cookbook/api-servers/nest), [AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai), [NestJS configuration](https://docs.nestjs.com/techniques/configuration), [NestJS validation](https://docs.nestjs.com/techniques/validation).

```bash
cd apps
pnpm dlx @nestjs/cli@latest new api --package-manager pnpm --skip-git --strict
cd api

# Mastra и провайдер модели
pnpm add @mastra/core @mastra/memory @mastra/pg @mastra/ai-sdk ai @ai-sdk/openai

# конфиг и валидация Nest
pnpm add @nestjs/config class-validator class-transformer

# общие типы из монорепо
pnpm add @agent-os/contracts@workspace:*
cd ../..
```

Ключевые файлы:

- `src/mastra/mastra.provider.ts` — создаёт инстанс `Mastra` с агентами и `PostgresStore`, экспортируется как Nest-провайдер по токену `MASTRA`.
- `src/mastra/agents/assistant.agent.ts` — первый агент: инструкции, модель, память, инструменты.
- `src/chat/chat.controller.ts` — `POST /api/chat/:agentId`, стримит ответ в формате AI SDK:

```ts
@Post(':agentId')
@UseGuards(SessionGuard)
async chat(@Param('agentId') id: string, @Body() body: ChatDto, @Req() req, @Res() res) {
  const agent = this.mastra.getAgent(id);
  const stream = await agent.stream(body.messages, {
    memory: { thread: body.threadId, resource: req.user.id },
    abortSignal: req.signal,              // закрытая вкладка останавливает генерацию
  });
  const ui = createUIMessageStream({
    execute: ({ writer }) => writer.merge(toAISdkStream(stream, { from: 'agent' })),
  });
  pipeUIMessageStreamToResponse({ response: res, stream: ui });
}
```

- `src/audit/` — interceptor, пишущий события в Postgres батчами.
- `src/auth/` — `SessionGuard` (сессия или JWT), роли, доступ к агентам.

`main.ts`: включить `app.enableShutdownHooks()`, после `listen` вызвать `mastra.startWorkers()`, в `OnApplicationShutdown` — `mastra.shutdown()`.

`apps/api/.env`:

```
DATABASE_URL=postgres://agent:agent@localhost:5432/agent_os
OPENAI_API_KEY=...
FRONTEND_ORIGIN=http://localhost:3000
PORT=4000
```

## Шаг 4. Фронт `apps/web`

Инструкции: [Next.js installation](https://nextjs.org/docs/app/getting-started/installation), [assistant-ui installation](https://www.assistant-ui.com/docs/installation), [assistant-ui + Mastra, отдельный сервер](https://www.assistant-ui.com/docs/integrations/frameworks/mastra/separate-server), [shadcn Resizable](https://ui.shadcn.com/docs/components/resizable).

```bash
cd apps
pnpm create next-app@latest web --ts --app --tailwind --eslint --src-dir --use-pnpm --no-import-alias
cd web

# assistant-ui: CLI ставит @assistant-ui/react, транспорт AI SDK и shadcn-компоненты Thread
# запускать строго внутри apps/web, иначе CLI создаст отдельное приложение
pnpm dlx assistant-ui@latest init

# сплит-раскладка «рабочая область + чат» (ставит react-resizable-panels)
pnpm dlx shadcn@latest add resizable

# общие типы из монорепо
pnpm add @agent-os/contracts@workspace:*
cd ../..
```

`src/components/assistant.tsx`:

```tsx
'use client';
import { AssistantRuntimeProvider } from '@assistant-ui/react';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/ai-sdk';
import { Thread } from '@/components/assistant-ui/thread';

export function Assistant({ agentId }: { agentId: string }) {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({
      api: `${process.env.NEXT_PUBLIC_API_URL}/api/chat/${agentId}`,
      credentials: 'include',
    }),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  );
}
```

`apps/web/.env.local`:

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

`infra/nginx.conf`, для маршрутов `/api/chat/`:

```
proxy_buffering off;
proxy_read_timeout 3600s;
proxy_set_header Connection '';
proxy_http_version 1.1;
```

## Шаг 6. Запуск

```bash
pnpm install
pnpm db:up
pnpm dev
```

Хост-порт Postgres задаётся переменной `POSTGRES_PORT` (по умолчанию 5432). Если 5432 занят, поднимите базу на другом порту и укажите тот же порт в `DATABASE_URL` в `apps/api/.env`:

```bash
POSTGRES_PORT=5433 pnpm db:up
# apps/api/.env: DATABASE_URL=postgres://agent:agent@localhost:5433/agent_os
```

Проверка: открыть `http://localhost:3000`, отправить сообщение, увидеть стриминг. В логах `apps/api` должна появиться запись аудита.

## База данных, миграции и runtime

Таблицы приложения живут в схеме `app`; модель и миграции — в пакете `@agent-os/db` (ADR-0003, ADR-0004). Приложение при старте только сверяет миграции с журналом и не мигрирует само: на базе с неприменёнными миграциями `apps/api` завершается до открытия порта и называет файлы.

| Команда | Что делает |
|---|---|
| `pnpm db:migrate` | применяет миграции из `packages/db/migrations/` к базе `DATABASE_URL` из `apps/api/.env`; нужна собранная `apps/api` (`pnpm build`) |
| `pnpm db:generate` | генерирует миграцию из модели `packages/db/src/schema.ts` (drizzle-kit); после правки модели — затем `pnpm db:migrate` |

Тесты с Postgres поднимают базу `DATABASE_URL` (из окружения, иначе из `apps/api/.env`) и сами применяют миграции один раз до набора. Запускайте их **по одному**, не параллельно против одной базы: воркеры runtime (relay, reaper) трогают чужие строки.

| Команда | Что проверяет |
|---|---|
| `pnpm --filter @agent-os/db test:e2e` | миграции и домены CHECK схемы `app` |
| `pnpm --filter @agent-os/runtime test:e2e` | интеграционные тесты runtime и матрицу убийств процесса (собирает пакет и дочерний процесс) |
| `pnpm --filter api test:e2e:runtime` | связывание runtime с `apps/api`: старт против состояний базы, фазы Nest, порт владельца беседы, хук удаления |
| `pnpm --filter api test:e2e` | весь e2e-набор `apps/api` (чат, беседы, связывание runtime) |
| `pnpm --filter @agent-os/runtime test:verify` | замеры по требованию: старт зависимой задачи (NFR-01) и время восстановления (NFR-04); в обычный набор не входят |

Настройки runtime — переменные окружения `apps/api` (`apps/api/.env.example`, смысл и правила — `docs/features/research-runtime/design-runtime.md`, Runtime Settings). Неверное значение останавливает старт с именем переменной.

| Переменная | По умолчанию |
|---|---|
| `RUNTIME_WORKERS` | `on` (`off` — без воркеров) |
| `RUNTIME_CONCURRENCY` | 4 |
| `RUNTIME_POLL_MS` | 500 |
| `RUNTIME_NOTIFY` | `on` |
| `RUNTIME_LEASE_MS` / `RUNTIME_HEARTBEAT_MS` / `RUNTIME_REAPER_MS` | 30000 / 10000 / 5000 |
| `RUNTIME_MAX_RECOVERIES` | 3 |
| `RUNTIME_DELIVERY_MAX_ATTEMPTS` | 5 |
| `RUNTIME_SHUTDOWN_GRACE_MS` | 5000 |
| `RUNTIME_QUEUE_WAIT_MS` / `RUNTIME_ATTEMPT_MS` | 600000 / 900000 (не меньше 1000; срок ожидания в очереди и срок попытки, `docs/features/agent-quality/design-lifecycle.md`) |
| `DB_POOL_MAX` | 10 |
| `RUNTIME_CRASH_AT` | не задана (только для тестов) |

## Источники MCP и fixture

Пакет `@agent-os/sources` подключает внешние источники по MCP: `apps/api` собирает его через `createSources` в `SourcesModule` и регистрирует исполнитель `source.fetch@1` в runtime. Единственный источник сейчас — `fixture`: пакет `@agent-os/mcp-fixture`, MCP-сервер логов по stdio с детерминированными данными. Процесс fixture запускается лениво, при первом вызове, и закрывается при остановке `apps/api`. Разрешённые пары «исполнитель → источник/инструмент» — в `apps/api/src/sources/sources.config.ts`; дизайн — `docs/features/research-runtime/design-mcp-source.md`.

| Команда | Что делает |
|---|---|
| `pnpm --filter @agent-os/mcp-fixture generate` | собирает fixture и пишет эталон `packages/mcp-fixture/ground-truth/<версия>.json` (все версии или названные: `generate v1`); повторная генерация даёт те же байты |
| `pnpm --filter @agent-os/sources test` | unit и интеграционные тесты против процесса fixture, без Postgres (входят в `pnpm check`) |
| `pnpm --filter @agent-os/sources test:e2e` | E2E против Postgres и fixture: сквозной сценарий `source.fetch` и восстановление после гибели процесса (собирает пакет и дочерний процесс) |
| `pnpm --filter @agent-os/sources test:verify` | замеры по требованию: накладные расходы `ToolExecutor` (UC-N1) и ответ fixture на страницу (UC-N2); в обычный набор не входят |

`test:e2e` и `test:verify` пакета sources тоже работают с Postgres — запускайте их по одному с остальными наборами из раздела выше.

Переменные `apps/api` (`apps/api/.env.example`). Неверное значение останавливает старт.

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `SOURCE_CALL_TIMEOUT_MS` | 30000 | таймаут вызова инструмента и чтения среза, мс; дедлайн задачи может его урезать |
| `SOURCE_RETRY_BASE_MS` / `SOURCE_RETRY_CAP_MS` | 200 / 5000 | backoff full jitter между повторами: случайная задержка в [0, min(cap, base × 2^n)] |
| `SOURCE_MAX_PAGES` | 1000 | предел страниц на одну задачу fetch |
| `FIXTURE_DATASET` | `v1` | версия данных fixture при старте процесса: `v1` или `v2` |
| `FIXTURE_FAULTS` | не задана | JSON-массив правил отказа (только для тестов); без `FIXTURE_CALL_LOG` — ошибка старта; при `NODE_ENV=production` не читается |
| `FIXTURE_CALL_LOG` | не задана | путь к журналу вызовов `tools/call` процесса fixture (только для тестов) |

## Исследовательский движок

Пакет `@agent-os/engine` ведёт глубокое исследование поверх runtime и источников деревом агентов: корневой агент `controller` вызывает планировщика (`planner`), исполнителей (`worker`, `subworker`), которые читают источник и пишут утверждения, проверяющего (`verifier`), который оценивает каждое утверждение по записям источника, и агента ответа (`synthesis`); закрытие корня проводит черновик через шлюз ответа. Каждый агент — модель с инструментами и сессией в базе; запуск агента — задача runtime (`agent.root`, `agent.run`). Пакет не зависит от NestJS и не читает переменные окружения: `apps/api` собирает его в `EngineModule` (`apps/api/src/engine/`) — передаёт runtime, реестр источников, подключённые источники, порт `resolveModel` (модели агентов на `@ai-sdk/anthropic`) и счётчик токенов `AnthropicTokenCounter`. Процесс исследования задаёт конфигурация `deep-research` v3 (`packages/engine/src/processes/deep-research.v3.json`): определения агентов (модель, окно, инструменты, промпт), лимиты, разделы ответа. Дизайн — `docs/features/agent-runtime/design-agent-core.md` и `docs/features/agent-runtime/design-research-flow.md`.

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `ANTHROPIC_API_KEY` | не задана | ключ провайдера; без него `apps/api` стартует, но вызовы моделей движка получат отказ провайдера |
| `RESEARCH_ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | база провайдера **без версии API**; одна база на вызов модели (`<база>/v1/messages`) и на подсчёт входа (`<база>/v1/messages/count_tokens`), поэтому вызов и его подсчёт идут на один адрес. Значение не http(s) URL останавливает старт с именем переменной |
| `TRANSCRIPT_RETENTION_DAYS` | 30 | срок хранения транскриптов вызовов моделей в расследованиях сотрудников, дни; раз в час сервер удаляет транскрипты старше срока, кроме транскриптов расследований самопроверки (`system:self-check`) и вызовов вне расследования; журнал вызовов с расходом остаётся. Целое не меньше 1, иначе старт останавливается с именем переменной |

`ANTHROPIC_BASE_URL` движок не читает и не задаёт. Её читает Mastra для агента чата, и там она — база **с** версией (`…/v1`); общая переменная увела бы вызовы движка и его подсчёт входа на разные адреса, а переменная процесса меняла бы адрес и для чата.

**Режим без источников.** Если ни один источник не подключён (например, установка без devDependency `@agent-os/mcp-fixture`), движок работает в режиме `model_knowledge`: при старте `apps/api` пишет одно предупреждение `no data source is connected: investigations will run on model knowledge, without evidence (sourceMode model_knowledge)`, корнем расследования становится агент ответа `synthesis` (ключ `modelKnowledgeRoot` конфигурации), а все утверждения ответа попадают в раздел `assumed` без evidence и без проверки. Режим фиксируется при создании движка и записывается в каждое расследование (`sourceMode`).

**Таблица групп уверенности.** Группу уверенности утверждения («высокая», «средняя», «низкая») задаёт таблица групп, построенная калибровкой. Таблица привязана к паре отпечатков: определения агента `verifier` (модель и промпт) и памяти его определения. Сервер не стартует, если для поставляемой конфигурации такой таблицы нет: `apps/api` завершает старт с ошибкой `calibration_missing`, в сообщении — процесс, версия и оба отпечатка, порт не открывается. Так бывает после смены модели или правки промпта проверяющего вызова. Таблицу строит команда самопроверки `calibrate` (раздел «Самопроверка агента»); готовый файл кладётся в `packages/engine/src/processes/` и подключается в `shipped-group-tables.ts`. Программа самопроверки стартует и без таблицы — её утверждения получают низшую группу. Тесты, которые поднимают `AppModule`, подставляют тестовую таблицу (`apps/api/test/support/testGroupTables.ts`) и от калибровки не зависят.

| Команда | Что делает |
|---|---|
| `pnpm --filter @agent-os/engine test` | unit-таблицы и свойства движка, без Postgres и без сети (входят в `pnpm check`) |
| `pnpm --filter @agent-os/engine test:e2e` | интеграционные, репозиторные и сквозные тесты ядра агентов и процесса исследования (`packages/engine/test/agent-runtime-agent-core.*` и `agent-runtime-research-flow.*`) против Postgres и runtime; собирает пакет и дочерний процесс движка (сквозные тесты роняют и поднимают его). Источник — считающий двойник в процессе, модель — сценарный двойник; ни процесс fixture, ни провайдер тесты не вызывают |

`test:e2e` движка работает с Postgres — запускайте его по одному с остальными наборами (`db`, `runtime`, `sources`, `api`), не параллельно против одной базы.

## Ресерч из чата

Глубокое исследование запускается прямо из беседы (`apps/api/src/research-chat/`, `apps/web/src/components/research/`; дизайн — `docs/features/deep-research/design-chat-entry.md`). У главного агента есть инструмент `deepResearch`:

- **Режим ресерча** — переключатель «Глубокий ресерч» у поля ввода (Tab, затем Space). Сообщение, отправленное в режиме, сразу запускает расследование, и в ответе появляется карточка «Идёт» с целью и бюджетом токенов. После отправки режим выключается.
- **Предложение** — без режима агент сам предлагает ресерч, когда на вопрос нужно отвечать по данным источников. Карточка ждёт решения: «Запустить» или «Не нужно». Следующее сообщение закрывает открытые предложения.
- **Кнопки карточки** («Запустить», «Не нужно», «Остановить») отправляют скрытый ход беседы. Лента от них не растёт, меняется только карточка. Повторное нажатие на карточке, чья судьба уже решена, ничего не меняет.
- **Ответ** дописывается в конец беседы отдельным сообщением ассистента, без перезагрузки и не позже чем через 5 с после завершения расследования. Если в этот момент в беседе стримится ответ, сообщение появляется после конца стрима. У утверждений ответа есть сноски на список источников. Без подключённых источников ответ, карточка и каждое утверждение несут предупреждение, что ответ дан по знаниям модели и не проверен по данным.

Ходы режима и решения всегда идут на `anthropic/claude-haiku-5-5` с `effort` не выше `high`, какой бы ни была `ASSISTANT_MODEL`: только эта модель принимает обязательный вызов инструмента с выключенным рассуждением. Поэтому ключ `ANTHROPIC_API_KEY` нужен при любой модели чата. Остальные ходы беседы идут на `ASSISTANT_MODEL`. Состояние карточек веб берёт из `GET /api/threads/:threadId/research` и опрашивает его раз в 2 с, пока в беседе идёт ресерч.

Переменные `apps/api` (`apps/api/.env.example`). Неверное значение останавливает старт с именем переменной.

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `RESEARCH_APPEND_GIVE_UP_MS` | 300000 | сколько после первой неудачной записи ответа цикл доставки ещё пробует, прежде чем перевести запуск в `failed`, мс. Пауза между попытками начинается с `RUNTIME_POLL_MS` и удваивается до 16-кратной |
| `RESEARCH_LAUNCH_RECOVERY_MS` | 60000 | через сколько цикл доставки доводит запуск, который сбой процесса оставил в `launching`, мс |

Цикл доставки ответов работает только с `RUNTIME_WORKERS=on`.

| Команда | Что делает |
|---|---|
| `pnpm --filter api test:e2e:chat-entry` | интеграционные тесты части (INT-1…INT-3) и E2E-1 с гибелью дочернего процесса `apps/api` против Postgres; собирает `apps/api` и дочерний процесс. Модель и движок в тестах — двойники, к провайдеру тесты не обращаются |
| `pnpm --filter api test:e2e:lifecycle` | интеграционные тесты части `lifecycle` фичи `agent-quality` (INT-1, INT-2): остановка ресерча маршрутом `POST /api/threads/:threadId/research/:launchKey/stop` без вызова модели, отказы и повтор, изоляция пользователей; против Postgres, собирает `apps/api`. Модель и движок — двойники |
| `pnpm --filter web test` | компонентные таблицы карточки и ответа и интеграционные тесты веба (INT-4, INT-5) на MSW, без Postgres |

`test:e2e:chat-entry` работает с Postgres. Как и остальные наборы с Postgres (`db`, `runtime`, `sources`, `engine`, `api`), его запускают **по одному**, не параллельно против одной базы: relay и reaper одного набора трогают строки другого.

## Самопроверка агента

Программа самопроверки (`apps/api/src/self-check/`, дизайн — `docs/features/agent-quality/design-self-check.md`) — отдельная командная точка входа `apps/api`, без сервера и без Nest. Отдельной базы у неё нет: она работает на той же базе `DATABASE_URL`, что и сервер, и при старте сама применяет к ней недостающие миграции, как `pnpm db:migrate`. Свои расследования программа пишет под владельцем `system:self-check`; отменяет и удаляет она только их, а расследования сотрудников лишь читает — для `replay` и `show`.

Очередь задач runtime общая: исполнитель берёт задачу любого владельца. Поэтому самопроверку запускают на базе разработчика, где в это время **не работают исполнители runtime сервера** (сервер остановлен или запущен с `RUNTIME_WORKERS=off`) и **нет незаконченных расследований сотрудников**. Иначе сервер исполнит задачу сценария на своём fixture, а программа — задачу сотрудника на fixture сценария. Программа это условие не проверяет.

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `DATABASE_URL` | не задана | та же база, что у сервера, обязательна для программы: без неё команды `run`, `replay`, `show` и `calibrate` завершаются ошибкой. Здесь лежат и расследования сотрудников, и расследования `system:self-check` с их транскриптами |
| `ANTHROPIC_API_KEY`, `RESEARCH_ANTHROPIC_BASE_URL` | как у сервера | ключ и база провайдера: программа зовёт настоящую модель так же, как движок сервера, — и в расследованиях, и как судья |
| `TRANSCRIPT_RETENTION_DAYS` | 30 | срок хранения транскриптов расследований сотрудников. Сервер по нему чистит транскрипты (первый проход — при старте сервера, дальше раз в час) и не трогает транскрипты расследований `system:self-check` и вызовов вне расследования. Программа по нему читает в `show` расследование сотрудника и при старте удаляет свои копии — повторы и транскрипты судьи `show`, — чей оригинал удалён или старше срока; прогоны сценариев и их повторы хранятся без срока |
| `FIXTURE_SCENARIO` | — | задавать не нужно: программа ставит её сама процессу fixture каждого сценария |

Остальные переменные runtime и источников (`RESEARCH_*`, `FIXTURE_*`, сроки вызовов) программа читает так же, как сервер.

| Команда | Что делает |
|---|---|
| `pnpm --filter api self-check <команда>` | запускает программу из собранной `apps/api` (`pnpm build`), окружение — из `apps/api/.env`. Код выхода: 0 — успех, 2 — отказ (код и причина в stderr), 1 — ошибка. Отчёты по умолчанию пишутся в `apps/api/self-check-reports` |

Команды программы (после `pnpm --filter api self-check`):

| Команда | Что делает |
|---|---|
| `run --set <набор> [--runs <n>] [--agent-model <агент>=<провайдер/модель> …] [--thresholds <файл>] [--budget <токены>]` | прогоняет набор сценариев из `packages/mcp-fixture/scenario-sets/` (`smoke` — три сценария, `first` — первый набор), по умолчанию 3 прогона на сценарий на поставляемой конфигурации `deep-research` (v3); `--agent-model` меняет модель одного агента, флаг повторяемый. Печатает каталог запуска |
| `replay --investigation <id> [--investigation <id> …] --owner <ownerId> [--runs <n>] [--config frozen\|shipped] [--agent-model …] [--thresholds <файл>]` | повторяет сохранённые расследования — сотрудника или `system:self-check` — на срезе источника, записанном при их старте, по умолчанию 3 раза, с замороженной конфигурацией (`shipped` — с поставляемой сейчас). Повторы — новые расследования `system:self-check`, исходное только читается. Печатает каталог запуска |
| `show --investigation <id> --owner <ownerId>` | печатает ход расследования: сигналы сбоя, вызовы моделей по времени с транскриптами, отклонённые решения controller и отсеянные утверждения. Транскрипты расследования сотрудника читает в пределах `TRANSCRIPT_RETENTION_DAYS`, расследования `system:self-check` — без срока. Ничего не сохраняет; это единственный вывод программы с промптами, записями и ответами модели |
| `compare <каталог базы> <каталог кандидата>` | сравнивает два завершённых запуска одного набора: по каждой метрике разница с интервалом и общий вердикт «лучше», «хуже» или «неясно». Работает только с файлами — ни базы, ни модели |
| `calibrate --set <набор> --out <файл таблицы> [--config <файл конфигурации>] [--groups 3\|4]` | калибрует проверяющий вызов (роль `verifier`) конфигурации — по умолчанию поставляемой `deep-research` — на калибровочных парах набора: один вызов на пару и то же правило статуса, что в расследовании. Пишет таблицу групп (по умолчанию 3 группы) в `--out`, путь считается от `apps/api`; новая калибровка перезаписывает файл. Печатает отчёт: по видам пар доли совпадений с ключом и рядом с долей решения алгоритма — долю, которую на тех же парах дало бы прежнее вето «итог сверки `unmatched` (значения не совпали) — не установлено»; профили с итогом сверки словами («значения совпали», «значения не совпали», «без атомов»), по группам число пар и долю верных, пометку H-03 и пары без оценки. Задач расследований не берёт. Отказы: `set_invalid`, `process_config_rejected`, `calibration_prompt_has_fields`, `calibration_empty` (таблица не пишется) |

Файл порогов — JSON `{ "bands": { <метрика>: <доля> }, "levels": { "judgeAgreementMin", "unclearMax", "injectionInfluenceMax" } }`. Он либо не передан, либо полон для своего вида запуска: запуск сценариев требует все три уровня, `replay` — только `unclearMax`; иначе отказ `thresholds_invalid` до первого расследования. `injectionInfluenceMax` — наибольшая допустимая доля сценариев, где текст в записях, обращённый к модели, изменил оценку проверяющего вызова; на вердикт `compare` он не влияет. Без файла запуск пишет метрики, а `compare` даёт метрики и интервалы без вердикта.

**Каталог отчётов** — `apps/api/self-check-reports/`, в git не попадает. Каждый `run` и `replay` создаёт в нём каталог запуска `<время>-<8 знаков>`, например `2026-11-07T01-41-24-355Z-1dd154e0`: `result.json` (файл результата, его читает `compare`), `report.md` (отчёт для чтения) и `thresholds.json` (копия порогов, если файл передан). Упавший или прерванный запуск файла результата не оставляет. `compare` пишет `compare-<база>-vs-<кандидат>/` с `comparison.json` и `report.md`; повтор той же команды перезаписывает те же файлы.

**Настоящие вызовы стоят денег.** `run`, `replay`, `show` и `calibrate` зовут настоящую модель: расследования, судью, проверочные ответы судьи и проверяющий вызов на калибровочных парах. Набор `first` по три прогона — около семидесяти расследований, каждое со своим бюджетом из поставляемой конфигурации; отчёт показывает токены и стоимость каждого прогона. Наборы тестов и CI настоящую модель не зовут: они идут на моделях-заглушках.

**Общий бюджет запуска** (`run --budget <токены>`) ограничивает расход всего запуска. Программа не начинает сценарий, если остатка не хватает на бюджеты всех его прогонов: такие сценарии помечаются «не прогнан», запуск — незавершённым, и `compare` его не берёт. Вызовы вне расследований (судья, проверочные ответы) заранее не резервируются, поэтому предел может быть превышен, но не больше чем на эти вызовы одного сценария и на проверочные ответы в конце запуска. Без `--budget` общего предела нет — только бюджет каждого расследования. Начинайте с `--set smoke --runs 1`.

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

## Оговорки по коду

- Сниппет контроллера с `toAISdkStream` и `createUIMessageStream` собран по докам Mastra и AI SDK для Next.js route handlers. Под Nest его нужно сверить с установленными версиями `@mastra/ai-sdk` и `ai` при первом запуске: сигнатуры и имена экспортов между мажорными версиями менялись.
- Имя пакета `@assistant-ui/ai-sdk` взято из текущих доков assistant-ui. После `pnpm dlx assistant-ui@latest init` проверить, какой пакет транспорта CLI поставил фактически, и импортировать из него.
- Версия UI message stream должна совпадать на обеих сторонах: при `ai@7` на фронте бэкенд должен отдавать поток версии v7, по умолчанию Mastra отдаёт v5.

## Что дальше

1. Авторизация через корпоративный OIDC в `apps/api/src/auth`.
2. Бюджеты токенов на пользователя и подразделение.
3. Инструменты в изолированных Docker-воркерах (`apps/api/src/sandbox`).
4. Очередь долгих задач и переподключение стрима по run id: `pnpm add pg-boss` в `apps/api`, [инструкция](https://github.com/timgit/pg-boss).
5. Mastra Studio только в dev: `pnpm add @mastra/nestjs` и `MastraModule` под префиксом `/api/mastra`, [инструкция](https://mastra.ai/reference/server/nestjs-adapter).

## Альтернативы, которые отложены

- **CopilotKit + AG-UI** вместо assistant-ui: даёт общее состояние агент↔приложение и готовый сайдбар, но вложения и переподключение стрима в платном слое. Бэкенд переводится на `@ag-ui/mastra` без изменений в Nest-структуре. [Инструкция](https://mastra.ai/docs/frameworks/agentic-uis/copilotkit).
- **Mastra как отдельный сервер** за Nest-прокси: если понадобится жёсткая изоляция или независимое масштабирование агентов.
