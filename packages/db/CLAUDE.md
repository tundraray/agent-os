# packages/db (`@agent-os/db`)

The one database of the backend: pool, Drizzle client, the `app` schema, migrations and the repositories of every table. `runtime`, `agents` and `apps/api` depend on it; it depends only on `contracts` and `common`.

## Rules here

- Schema: one file per table in `src/schema/`, named after the table (`runtime-tasks.ts`), collected in `src/schema/index.ts`.
- A schema change needs a generated migration: `pnpm db:generate`. Never write or edit migration SQL by hand. A migration changes the schema only, it carries no data rows.
- Repositories live flat in `src/repositories/`, one file per table or table group, named by the table prefix (`runtime-tasks.repository.ts`). A new class goes into the `REPOSITORIES` list in `src/repositories/index.ts`.
- A repository is a stateless `@Injectable` class that only reads and writes rows. It takes `Db` in the constructor and queries through `this.db.client`: the transaction a service opened with `db.transaction(...)`, otherwise the plain database. It never opens a transaction, takes no locks, holds no domain logic and does not map rows into domain objects. A typed projection of columns is still a row; a grouping into a `Map`, a domain rename or a parse of a jsonb column is mapping and belongs to the service that calls the repository.
- A repository imports only drizzle, `Db`, the schema and `@agent-os/contracts`.
- Row types (`RuntimeTrackerRow` and the like) are exported from here; packages above use them and declare none of their own.
- Explicit `@Inject(...)` on every constructor parameter.
- The server never applies migrations at start, it only checks that none are pending. Migrations are applied by `pnpm db:migrate`.

## Check your work

- `pnpm --filter @agent-os/db lint`
- `pnpm --filter @agent-os/db typecheck`
- `pnpm --filter @agent-os/db test`
- `pnpm --filter @agent-os/db test:e2e` — creates and drops scratch databases on the server named by `DATABASE_URL`; point it only at a test server, never at the development database.

## More

- [docs/code-system/packages/db.md](../../docs/code-system/packages/db.md)
- [repository-over-transaction.md](../../docs/code-system/patterns/repository-over-transaction.md), [composition-root.md](../../docs/code-system/patterns/composition-root.md)
- [ADR-0022](../../docs/adr/ADR-0022-one-database-and-nestjs-modules.md)
