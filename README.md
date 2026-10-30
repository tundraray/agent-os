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
      - "5432:5432"
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

Проверка: открыть `http://localhost:3000`, отправить сообщение, увидеть стриминг. В логах `apps/api` должна появиться запись аудита.

## Проверки качества

| Команда | Что делает |
|---|---|
| `pnpm lint` | oxlint (`api`, `contracts`) и ESLint (`web`); любое предупреждение — ошибка |
| `pnpm typecheck` | `tsc --noEmit` по всем пакетам, включая тесты (`web` сначала генерирует типы роутов `next typegen`) |
| `pnpm build` | сборка всех пакетов |
| `pnpm knip` | неиспользуемые файлы, экспорты и зависимости ([knip](https://knip.dev)); настройки в `knip.json` |
| `pnpm check` | всё вышеперечисленное плюс `pnpm test` — то же, что гоняет CI (`.github/workflows/ci.yml`) |

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
