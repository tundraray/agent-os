# apps/api (`api`)

The HTTP API on NestJS and the composition point of the backend: `AppModule` wires `DbModule`, `RuntimeModule`, `AgentsModule` and the application's own modules (sign-in, access, library, audit, chat, training). `apps/web` calls it through `/api/...`; no package imports it.

## Rules here

- One NestJS module per area, one directory per module under `src/`.
- Controllers are thin: take the owner from `req.user`, validate the body with a zod schema from `@agent-os/contracts`, call one service, return its result. No rules and no queries in a controller.
- Services hold the logic and open the transaction; they read and write rows through the repositories of `@agent-os/db`. No table query in this app.
- `SessionGuard` covers the whole API. A route is public only by an explicit mark; another user's object answers exactly like a missing one.
- A port declared by a package (`AccessGate`, `AccessAudit`, `RecordLibrary`) is bound here to the app's service with `useExisting`.
- Settings an administrator can change live in the database and the admin panel. No new environment variables and no JSON config files. This app is the only place that reads the environment; packages get settings from their `forRootAsync` factory.
- CLI entry points live in `src/cli/` and are run through the `package.json` scripts.
- Sentry is imported here only for wiring (`src/instrument.ts`, `src/logging/`); code logs through the `LOGGER` token. No `@mastra/*` imports (lint).
- A workspace package is imported only through its entry `.` (or `./testing` in tests).

## Check your work

- `pnpm --filter api lint`
- `pnpm --filter api typecheck`
- `pnpm --filter api test`
- `pnpm --filter api build`
- `pnpm --filter api test:e2e` and `test:verify` — these configs migrate the database in `DATABASE_URL` as soon as they load; point them only at a test database.

## More

- [docs/code-system/packages/api.md](../../docs/code-system/packages/api.md)
- [auth-boundary.md](../../docs/code-system/patterns/auth-boundary.md), [port-module-split.md](../../docs/code-system/patterns/port-module-split.md), [keyed-settings.md](../../docs/code-system/patterns/keyed-settings.md)
