# packages/code-runner (`@agent-os/code-runner`)

The code executor behind the `run_code` tool and agent scripts: a separate Node process per script with QuickJS inside, a bridge to the API process, limits and process kill. Only `agents` calls it; it depends only on `common`.

## Rules here

- No NestJS and no workspace import except `@agent-os/common` (lint bans the rest). The package exposes `createCodeRunner` and `CodeRunner.run`, plain code.
- The package knows nothing about agents and has no tables.
- The executor process decides nothing: it only asks the API process over the bridge to call a tool or read a result. Rights and call rules are checked by the caller, never here.
- The executor process starts only with the Node permission-model flags and reads only its own entry directory and QuickJS. Do not widen the flags or the readable paths.
- Code under `src/executor/` is run by Node directly in the child process; its imports go through `#executor/*`.

## Check your work

- `pnpm --filter @agent-os/code-runner lint`
- `pnpm --filter @agent-os/code-runner typecheck`
- `pnpm --filter @agent-os/code-runner test`
- `pnpm --filter @agent-os/code-runner test:e2e` — starts real executor processes; no database.

## More

- [docs/code-system/packages/base.md](../../docs/code-system/packages/base.md)
- [ADR-0011](../../docs/adr/ADR-0011-code-runner-quickjs-process.md)
