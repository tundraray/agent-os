# api

NestJS server of Agent OS: the chat API (`/api/threads`, `/api/agents`, `/api/decisions`, `/api/spend`), the live stream (`GET /api/events`, SSE) and the runtime workers that run the agents. Agents come from `packages/agents` on top of `packages/runtime`; the fixture MCP servers come from `packages/mcp-fixture`.

## How to run locally

Run from the repository root, in this order:

```bash
pnpm install
pnpm db:up                                   # Postgres 16 from infra/docker-compose.yml (POSTGRES_PORT=5433 pnpm db:up when 5432 is taken)
cp apps/api/.env.example apps/api/.env       # then set ANTHROPIC_API_KEY in apps/api/.env
pnpm turbo build --filter=api...             # api and every package it uses, the MCP fixture included
pnpm --filter api db:migrate                 # applies the migrations; the app only checks them
printf '%s' '<password>' | pnpm --filter api identity:super-admin --login admin --name Admin --email admin@example.com
pnpm --filter api start:dev                  # http://localhost:4000/api
```

What `apps/api/.env` needs:

- `DATABASE_URL` — required; the example matches `infra/docker-compose.yml`. If host port 5432 is taken, run `POSTGRES_PORT=5433 pnpm db:up` and use port 5433 here.
- `ANTHROPIC_API_KEY` — the server starts without it, but every model call is refused.
- Everything else has a working default in `.env.example`: `AGENT_DEFAULT_MODEL=anthropic/claude-haiku-5-5` (the chat's model; it must be in `config/model-prices.json`), `MODEL_PRICES_FILE` and `MCP_SERVERS_FILE` (files in `config/`, relative to `apps/api`; a missing or invalid file stops the start), `MCP_ACCESS_TABLE` (its `*` row grants every employee the fixture servers `logs`, `backoffice` and `tracker`; empty gives nobody any server), `SENTRY_DSN` (optional), `LOG_LEVEL`, `RUNTIME_*`, `AGENT_*`, `MCP_CALL_TIMEOUT_MS`, and the `run_code` limits `CODE_RUN_TIMEOUT_MS` (30000), `CODE_RUN_MEMORY_MB` (512), `CODE_RUN_MAX_TOOL_CALLS` (50), `CODE_RUN_MAX_CONCURRENT` (4, per API process) and `CODE_RUN_MAX_CONCURRENT_PER_USER` (2, per employee and API process). An invalid value stops the start naming the variable.

The fixture servers are started by the api itself (`node ../../packages/mcp-fixture/dist/server.js`), so `packages/mcp-fixture` must be built: the `pnpm turbo build --filter=api...` step does it (`pnpm --filter @agent-os/mcp-fixture build` builds it alone).

Every request except sign-in and `GET /api/health` needs a session: an employee signs in by login and password (`POST /api/auth/password`, 204 and the `aos_session` cookie) or through a sign-in provider the administrator set up. The first account is the super-administrator, made by the operator command `identity:super-admin` above: it takes `--login`, `--name` and `--email` and reads the password (12 characters or more) from standard input, never from the arguments. Run again with the same login, it sets the new password, turns the account on and gives it the administrator role back. A request that changes something and carries the cookie must also carry `Origin: <FRONTEND_ORIGIN>` (`http://localhost:3000` by default).

### Check with curl

```bash
# 0. Sign in; the session cookie goes to cookies.txt and every later call sends it with -b
curl -s -c cookies.txt -X POST http://localhost:4000/api/auth/password \
  -H 'Content-Type: application/json' -d '{"login":"admin","password":"<password>"}'

# 1. A new conversation; the answer carries its id
curl -s -b cookies.txt -H 'Origin: http://localhost:3000' -X POST http://localhost:4000/api/threads

# 2. In a second terminal: the live stream of that conversation
curl -N -b cookies.txt "http://localhost:4000/api/events?watch=thread:<id>"

# 3. A message: 202, then the stream shows `ready`, `delta` (the answer's text parts) and `tree`
curl -s -b cookies.txt -H 'Origin: http://localhost:3000' -X POST http://localhost:4000/api/threads/<id>/messages \
  -H 'Content-Type: application/json' -d '{"text":"Hello"}'

# 4. The stored history
curl -s -b cookies.txt http://localhost:4000/api/threads/<id>/history
```

Each message is a paid model call on `ANTHROPIC_API_KEY`.

The web app (`apps/web`) does not work with this API until the `web` part of agent-platform is built.

Tests: `pnpm --filter api test` (unit) and `pnpm --filter api test:e2e` (needs Postgres up and the build above).

### e2e tests and the database

- The e2e suites run against the Postgres in `DATABASE_URL` (process environment first, otherwise `apps/api/.env`). The app refuses to start on pending migrations, so the suite's global setup (`test/support/migrate.global-setup.ts`) applies them once before any test file boots the app, through the same `applyMigrations` from `@agent-os/db` as `pnpm db:migrate`.
- The suites replace the model client with the test double and set their own `MCP_SERVERS_FILE`, `MCP_ACCESS_TABLE` and `RUNTIME_WORKERS`; they make no paid calls.
- Migration tests live in `packages/db`.
- Run Postgres suites one at a time, never in parallel against the same database: runtime workers (relay, reaper) touch rows of other tests.

## Docker image

The image holds the API only, built from `apps/api/Dockerfile` with the repository root as the build context. `.dockerignore` keeps every `.env` out of it.

```bash
docker build -f apps/api/Dockerfile -t agent-os-api:local .

# Migrations: the same command as `pnpm db:migrate`; the server only checks them and refuses to start on pending ones
docker run --rm -e DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db> \
  agent-os-api:local node dist/runtime/migrate-cli.js

# The server, on port 4000
docker run -p 4000:4000 \
  -e DATABASE_URL=postgres://<user>:<password>@<host>:5432/<db> \
  -e ANTHROPIC_API_KEY=<key> \
  -e FRONTEND_ORIGIN=http://localhost:3000 \
  agent-os-api:local
```

- `DATABASE_URL` is required. `ANTHROPIC_API_KEY` is passed at run time and never baked into the image; without it the server starts, but every model call is refused. The other variables of `.env.example` (`FRONTEND_ORIGIN`, `PORT`, `SENTRY_DSN`, `LOG_LEVEL`, `MCP_ACCESS_TABLE`, `RUNTIME_*`, `AGENT_*`, `CODE_RUN_*`) are optional and passed the same way. The image carries `config/` and the fixture MCP servers, so `MODEL_PRICES_FILE` and `MCP_SERVERS_FILE` keep their defaults.
- Every request needs a session, as in local runs. Make the super-administrator once against the same database: `docker run --rm -i -e DATABASE_URL=... agent-os-api:local node dist/identity/super-admin-cli.js --login admin --name Admin --email admin@example.com`, with the password on standard input.
- The server runs as the user `node` under `tini` (the image's entrypoint), which passes signals to Node and reaps the child processes of code runs and MCP servers. No `--init` is needed.
- CI (`.github/workflows/docker.yml`) builds the image on every push to `main` and pushes it to `ghcr.io/<owner>/<repo>-api` with the tags `latest` and `sha-<short sha>`.

## Observability

Logs go through the logger of `@agent-os/common` to the console and, when `SENTRY_DSN` is set, to Sentry (`src/instrument.ts`, `src/logging/app-logger.ts`). `LOG_LEVEL` sets the lowest level. Secrets — `ANTHROPIC_API_KEY`, `SENTRY_DSN`, the database password and the MCP servers' environment values — are redacted.
