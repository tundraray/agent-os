# packages/common (`@agent-os/common`)

The logger wrapper and the secret masker. Every package and both applications depend on it; it depends on nothing.

## Rules here

- No dependency on any workspace package and on no SDK: `package.json` has no `dependencies`. Lint bans `@agent-os/*`, `@nestjs/*`, `@sentry/*` and `@mastra/*`.
- No NestJS. The `LOGGER` token is a plain value; a module that needs the logger provides it.
- The Sentry SDK is passed in by the application (`src/sinks.ts`), never imported here.
- The code runs in the browser and in Node: no Node-only APIs.
- The logger is the one place that writes a record to the console and to Sentry. A value that may be a secret goes through the masker (`createSecretMasker`, `rememberSecret`).
- Test doubles are exported from the `./testing` entry only.

## Check your work

- `pnpm --filter @agent-os/common lint`
- `pnpm --filter @agent-os/common typecheck`
- `pnpm --filter @agent-os/common test`

## More

- [docs/code-system/packages/base.md](../../docs/code-system/packages/base.md)
- [logging.md](../../docs/code-system/patterns/logging.md)
