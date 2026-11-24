# packages/mcp-fixture (`@agent-os/mcp-fixture`)

A fake MCP server for tests and local runs: a deterministic dataset, an OAuth authorization server, a call log and scheduled faults. It is a dev dependency of `agents` and `apps/api` tests; it imports no workspace package.

## Rules here

- Test support only: product code never imports it.
- Keep it deterministic: data comes from the seeded generator (`src/prng.ts`, `src/dataset.ts`), never from `Math.random` or the clock, so a test sees the same answers on every run.
- It runs as its own process (`src/main.ts`, started by `startFixtureProcess`); tests control it and read its call log through the helpers exported from `src/index.ts`.
- No NestJS and no database.
- The package has no tests of its own: it is exercised by the e2e suites of `agents` and `apps/api`.

## Check your work

- `pnpm --filter @agent-os/mcp-fixture lint`
- `pnpm --filter @agent-os/mcp-fixture typecheck`
- `pnpm --filter @agent-os/mcp-fixture start` — runs the server on port 4100.

## More

- [docs/code-system/README.md](../../docs/code-system/README.md)
