# api

NestJS server of Agent OS: the chat API (`/api/threads`, `/api/agents`, `/api/decisions`, `/api/spend`), the live stream (`GET /api/events`, SSE) and the runtime workers that run the agents. Agents come from `packages/agents` on top of `packages/runtime`; the MCP servers they call are rows of the registry in the database, reached over HTTP.

## How to run locally

Run from the repository root, in this order:

```bash
pnpm install
pnpm db:up                                   # Postgres 16 from infra/docker-compose.yml (POSTGRES_PORT=5433 pnpm db:up when 5432 is taken)
cp apps/api/.env.example apps/api/.env
pnpm turbo build --filter=api...             # api and every package it uses, the MCP fixture included
pnpm --filter api db:migrate                 # applies the migrations; the app only checks them
printf '%s' '<password>' | pnpm --filter api identity:super-admin --login admin --name Admin --email admin@example.com
pnpm --filter api start:dev                  # http://localhost:4000/api
```

MCP servers for local runs, in two more terminals once the API is up:

```bash
pnpm --filter @agent-os/mcp-fixture start    # the fixture MCP servers on http://localhost:4100
printf '%s' '<password>' | pnpm --filter api seed:mcp --login admin
printf '%s\n%s\n%s\n' '<password>' '<Anthropic key>' '<Google key>' | pnpm --filter api seed:access --login admin
```

`seed:access` is a client of the running API too. It reads three lines from standard input, never from the arguments: the administrator's password, the Anthropic key, the Google key. An empty key line leaves that provider without a key (`printf '%s\n%s\n%s\n' '<password>' '<Anthropic key>' ''` — no Google key); a key shorter than 8 characters stops the run before sign-in. It registers the providers `anthropic` (kind `anthropic`) and `google` (kind `gemini`), adds Haiku and Sonnet (chat) and `google/gemini-embedding-001` (embeddings, 768 dimensions) to the catalogue, chooses Haiku and `gemini-embedding-001` as the default models where none is chosen yet, and allows the built-in role the `seed:mcp` servers and both chat models. Run it after `seed:mcp`: a server not registered yet is skipped with a warning and exit code 1. A repeated run creates nothing twice and keeps the administrator's default models; a given key replaces the provider's key, an empty line keeps it. Neither the output nor the log carries a key: the summary says only which providers were created and whether a key was set.

The MCP servers live in the registry in the database; the administrator manages it under `/api/admin/mcp-servers`. `seed:mcp` is a client of the running API: it signs in as the administrator (password on standard input), registers the fixture's `logs` and `tracker` (shared token) and `backoffice` (personal OAuth) and connects the administrator's account on `backoffice`. A repeated run skips the names already taken. Each `oauth` server has its own OAuth return address, `<public address>/api/mcp/oauth/callback/<server name>`, and the registration registers the platform's client at the authorization server with exactly that address. A server registered before the address became per-server holds a client with the old shared address (`/api/mcp/oauth/callback`), which no route answers any more: delete it and register it again (for the seeded `backoffice`: delete it in the admin panel, then run `seed:mcp` again). `--api` (default `http://localhost:4000`) and `--fixture` (default `http://localhost:4100`) change the addresses. The fixture is a developer tool: the production image does not carry it.

What `apps/api/.env` needs:

- `DATABASE_URL` — required; the example matches `infra/docker-compose.yml`. If host port 5432 is taken, run `POSTGRES_PORT=5433 pnpm db:up` and use port 5433 here.
- Model providers and their keys are not variables: they are set by `seed:access` or in the admin panel. The server starts without a provider, and every model call is refused until one is set up.
- Everything else has a working default in `.env.example`: `SENTRY_DSN` (optional), `LOG_LEVEL`, `RUNTIME_*`, `AGENT_*`, `MCP_CALL_TIMEOUT_MS`, and the `run_code` limits `CODE_RUN_TIMEOUT_MS` (30000), `CODE_RUN_MEMORY_MB` (512), `CODE_RUN_MAX_TOOL_CALLS` (50), `CODE_RUN_MAX_CONCURRENT` (4, per API process) and `CODE_RUN_MAX_CONCURRENT_PER_USER` (2, per employee and API process). An invalid value stops the start naming the variable.
- Rights to MCP servers, their tools and models are grants in the database, set in the admin panel; there is no environment variable for them. `seed:access` gives the built-in role the servers `logs`, `backoffice`, `tracker` and both developer models.

Every request except sign-in and `GET /api/health` needs a session: an employee signs in by login and password (`POST /api/auth/password`, 204 and the `aos_session` cookie) or through a sign-in provider the administrator set up. The first account is the super-administrator, made by the operator command `identity:super-admin` above: it takes `--login`, `--name` and `--email` and reads the password (12 characters or more) from standard input, never from the arguments. Run again with the same login, it sets the new password, turns the account on, ends its sessions and gives it the administrator role back. Every request that changes something (`POST`, `PUT`, `PATCH`, `DELETE`), the sign-in included, must carry `Origin: <FRONTEND_ORIGIN>` (`http://localhost:3000` by default). With `FRONTEND_ORIGIN` on `https` the cookies are `Secure`.

### Check with curl

```bash
# 0. Sign in; the session cookie goes to cookies.txt and every later call sends it with -b
curl -s -c cookies.txt -H 'Origin: http://localhost:3000' -X POST http://localhost:4000/api/auth/password \
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

Each message is a paid model call on the key of the model's provider.

The web app (`apps/web`) does not work with this API until the `web` part of agent-platform is built.

Tests: `pnpm --filter api test` (unit) and `pnpm --filter api test:e2e` (needs Postgres up and the build above).

### e2e tests and the database

- The e2e suites run against the Postgres in `DATABASE_URL` (process environment first, otherwise `apps/api/.env`). The app refuses to start on pending migrations, so the suite's global setup (`test/support/migrate.global-setup.ts`) applies them once before any test file boots the app, through the same `applyMigrations` from `@agent-os/db` as `pnpm db:migrate`.
- The suites replace the model client with the test double and start their own fixture process (`createTestApp({ mcpServers })`), register its servers under per-run names and set their own `RUNTIME_WORKERS`, and give their employees rights to the run's model and servers in the database; they make no paid calls.
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
  -e FRONTEND_ORIGIN=http://localhost:3000 \
  agent-os-api:local
```

- `DATABASE_URL` is required. Model providers and their keys live in the database (set by `seed:access` or in the admin panel), never in the image; without a provider the server starts, but every model call is refused. The other variables of `.env.example` (`FRONTEND_ORIGIN`, `PORT`, `SENTRY_DSN`, `LOG_LEVEL`, `RUNTIME_*`, `AGENT_*`, `CODE_RUN_*`) are optional and passed the same way. Model prices live in the model catalogue in the database, not in the image. It does not carry the MCP fixture: the administrator registers real MCP servers in the registry, and under `NODE_ENV=production` (set in the image) a server or authorization address must be `https`.
- Every request needs a session, as in local runs. Make the super-administrator once against the same database: `docker run --rm -i -e DATABASE_URL=... agent-os-api:local node dist/identity/super-admin-cli.js --login admin --name Admin --email admin@example.com`, with the password on standard input.
- The server runs as the user `node` under `tini` (the image's entrypoint), which passes signals to Node and reaps the child processes of code runs. No `--init` is needed.
- CI (`.github/workflows/docker.yml`) builds the image on every push to `main` and pushes it to `ghcr.io/<owner>/<repo>-api` with the tags `latest` and `sha-<short sha>`.

## Observability

Logs go through the logger of `@agent-os/common` to the console and, when `SENTRY_DSN` is set, to Sentry (`src/instrument.ts`, `src/logging/app-logger.ts`). `LOG_LEVEL` sets the lowest level. Secrets — model provider keys, `SENTRY_DSN`, the database password, and fields named like a token, password or key — are redacted.
