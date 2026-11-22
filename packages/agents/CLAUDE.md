# packages/agents (`@agent-os/agents`)

The agents of the platform: agent classes and their step, the tools library, start by snapshot, the MCP registry, model providers and embeddings, deep-agent knowledge, and the operations `apps/api` calls. Only `apps/api` depends on it; it depends on `runtime`, `db`, `code-runner`, `contracts` and `common`.

## Rules here

- An agent kind is a class that extends `BaseAgent` and is registered as a live runtime task type: one object per task, made by `AgentFactory`, kept in memory by the runtime between steps. The object changes only in `absorb`, after a committed step; what rights depend on (tools, listing, knowledge) is read on every step, never kept. What differs between kinds is an overridden method, never a branch on the kind inside shared code.
- An agent declares the tools it needs (`BaseAgent.declaration`); the registry decides what the session gets from the owner's rights through its single entry `toolsFor(owner, declaration)`.
- The tools library knows no system tool by name: system tools are registered into it from outside. `src/tools/` and `src/tools/external/` do not import `agent/`, `deep/`, `operations/` or `knowledge/`.
- Services are `@Injectable` classes with an explicit `@Inject(...)` on every constructor parameter (test child processes run under `tsx`, which emits no decorator metadata). Pure rules and tool objects stay plain code.
- Registrations (agent classes as task handlers, event consumers, system tools) happen in `onModuleInit`.
- Another domain arrives as a port: rights, quotas and library records come through `AccessGate`, `AccessAudit` and `RecordLibrary`, which `apps/api` implements. Never import `apps/api`.
- Mastra (`@mastra/*`) is imported in this package only.
- No table queries here: they live in `packages/db/src/repositories/agent-*.repository.ts`.
- A writing registry operation (MCP servers, providers, knowledge settings) returns "before" and "after" with secrets replaced by a marker; `apps/api` writes the audit.
- A secret (employee token, provider key) leaves the package only inside the request to its own server.

## Check your work

- `pnpm --filter @agent-os/agents lint`
- `pnpm --filter @agent-os/agents typecheck`
- `pnpm --filter @agent-os/agents test`
- `pnpm --filter @agent-os/agents test:e2e` and `test:verify` — these configs migrate the database in `DATABASE_URL` as soon as they load; point them only at a test database.

## More

- [docs/code-system/packages/agents.md](../../docs/code-system/packages/agents.md)
- [tool-declaration.md](../../docs/code-system/patterns/tool-declaration.md), [step-handler.md](../../docs/code-system/patterns/step-handler.md), [run-snapshot.md](../../docs/code-system/patterns/run-snapshot.md)
