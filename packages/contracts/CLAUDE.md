# packages/contracts (`@agent-os/contracts`)

zod schemas and types for data that crosses a boundary: API request and response bodies, runtime task input and output, library record content, value sets for CHECK constraints. The backend and `apps/web` both import it; it depends only on zod.

## Rules here

- Only zod: no workspace package, no NestJS, no Sentry, no Mastra (lint bans them). The code runs in the browser and in Node.
- One file per area (`library.ts`, `access.ts`, `runtime.ts`, ...), all exported from `src/index.ts`.
- A shape used on both sides of a boundary is declared here once as a zod schema, and its type is inferred from the schema. Neither the API nor the web declares its own copy.
- Tool-name constants (`RUN_CODE_TOOL`, `START_AGENT_TOOL`, ...) live here; code refers to a tool by the constant, not by a string literal.
- Small pure functions needed by both sides (for example `modelProvider`) may live here; anything with I/O or state may not.
- A change here changes the API contract: update the API and the web in the same change, no second version of a schema.

## Check your work

- `pnpm --filter @agent-os/contracts lint`
- `pnpm --filter @agent-os/contracts typecheck`
- `pnpm --filter @agent-os/contracts test`

## More

- [docs/code-system/packages/base.md](../../docs/code-system/packages/base.md)
- [web-api-client.md](../../docs/code-system/patterns/web-api-client.md)
