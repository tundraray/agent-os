# api

NestJS server of Agent OS: the chat API (`/api/threads`, `/api/agents`, `/api/decisions`, `/api/spend`), the live stream (`GET /api/events`, SSE) and the runtime workers that run the agents. Agents come from `packages/agents` on top of `packages/runtime`; the fixture MCP servers come from `packages/mcp-fixture`.

## How to run locally

Run from the repository root, in this order:

```bash
pnpm install
pnpm db:up                                   # Postgres 16 from infra/docker-compose.yml
cp apps/api/.env.example apps/api/.env       # then set ANTHROPIC_API_KEY in apps/api/.env
pnpm turbo build --filter=api...             # api and every package it uses, the MCP fixture included
pnpm --filter api db:migrate                 # applies the migrations; the app only checks them
pnpm --filter api start:dev                  # http://localhost:4000/api
```

What `apps/api/.env` needs:

- `DATABASE_URL` — required; the example matches `infra/docker-compose.yml`. If host port 5432 is taken, run `POSTGRES_PORT=5433 pnpm db:up` and use port 5433 here.
- `ANTHROPIC_API_KEY` — the server starts without it, but every model call is refused.
- Everything else has a working default in `.env.example`: `AGENT_DEFAULT_MODEL=anthropic/claude-haiku-5-5` (the chat's model; it must be in `config/model-prices.json`), `MODEL_PRICES_FILE` and `MCP_SERVERS_FILE` (files in `config/`, relative to `apps/api`; a missing or invalid file stops the start), `MCP_ACCESS_TABLE` (grants `dev-user` the fixture servers `logs` and `backoffice`; empty gives nobody any server), `SENTRY_DSN` (optional), `LOG_LEVEL`, `RUNTIME_*`, `AGENT_*`, `MCP_CALL_TIMEOUT_MS`. An invalid value stops the start naming the variable.

The fixture servers are started by the api itself (`node ../../packages/mcp-fixture/dist/server.js`), so `packages/mcp-fixture` must be built: the `pnpm turbo build --filter=api...` step does it (`pnpm --filter @agent-os/mcp-fixture build` builds it alone).

There is no login yet: outside `NODE_ENV=production` every request runs as `dev-user`; the `x-user-id` header names another employee (not one starting with `system:`).

### Check with curl

```bash
# 1. A new conversation; the answer carries its id
curl -s -X POST http://localhost:4000/api/threads

# 2. In a second terminal: the live stream of that conversation
curl -N "http://localhost:4000/api/events?watch=thread:<id>"

# 3. A message: 202, then the stream shows `ready`, `delta` (the answer's text parts) and `tree`
curl -s -X POST http://localhost:4000/api/threads/<id>/messages \
  -H 'Content-Type: application/json' -d '{"text":"Hello"}'

# 4. The stored history
curl -s http://localhost:4000/api/threads/<id>/history
```

Each message is a paid model call on `ANTHROPIC_API_KEY`.

The web app (`apps/web`) does not work with this API until the `web` part of agent-platform is built.

Tests: `pnpm --filter api test` (unit) and `pnpm --filter api test:e2e` (needs Postgres up and the build above).

### e2e tests and the database

- The e2e suites run against the Postgres in `DATABASE_URL` (process environment first, otherwise `apps/api/.env`). The app refuses to start on pending migrations, so the suite's global setup (`test/support/migrate.global-setup.ts`) applies them once before any test file boots the app, through the same `applyMigrations` from `@agent-os/db` as `pnpm db:migrate`.
- The suites replace the model client with the test double and set their own `MCP_SERVERS_FILE`, `MCP_ACCESS_TABLE` and `RUNTIME_WORKERS`; they make no paid calls.
- Migration tests live in `packages/db`.
- Run Postgres suites one at a time, never in parallel against the same database: runtime workers (relay, reaper) touch rows of other tests.

## Observability

Logs go through the logger of `@agent-os/common` to the console and, when `SENTRY_DSN` is set, to Sentry (`src/instrument.ts`, `src/logging/app-logger.ts`). `LOG_LEVEL` sets the lowest level. Secrets — `ANTHROPIC_API_KEY`, `SENTRY_DSN`, the database password and the MCP servers' environment values — are redacted.
