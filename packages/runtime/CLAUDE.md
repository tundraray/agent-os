# packages/runtime (`@agent-os/runtime`)

The durable task engine: tasks that run in steps and survive a server restart, the message inbox, human decisions, child-task trackers, the event log with delivery, the token ledger and recovery of lost steps. `agents` and `apps/api` depend on it; it depends on `db`, `contracts` and `common`.

## Rules here

- The engine is generic: it knows nothing about agents, models, tools or conversations. The work of a step is done by a handler that an upper layer registers by task type. Anything from another domain (owner check, prices) comes in as a parameter or a port.
- One process executes steps. There are no leases and no heartbeat: a step runs in this process until it ends, is cut off by a stop or an interrupt (`TaskControl` → `RunningTaskRegistry.abortTask`) or hits its step time limit. A `running` task whose step this process does not execute was lost in a crash; `RecoverySweeper` requeues it at the start and on its period.
- Only the services of this package change a task's status. Transition rules live in them, as guarded transitions; nobody else writes the status column.
- This is restart and concurrency code. Keep locks, guarded `UPDATE ... WHERE` transitions and the order of writes inside a transaction exact; do not "simplify" them. A step may run twice after a crash: every write must hold under a repeat.
- The transaction goes to the handler, not from it: `StepCommitter` opens the step-result transaction and calls the handler's `commit` inside it. A guarded write in the middle of a step goes through `StepContext.guard`.
- Services are `@Injectable` classes with an explicit `@Inject(...)` on every constructor parameter. Pure rules, `WorkerLoop` and config parsing stay plain code, not providers.
- No table queries here: they live in `packages/db/src/repositories/runtime-*.repository.ts`.
- Background workers start in `onApplicationBootstrap` and stop in `beforeApplicationShutdown`; registrations happen in `onModuleInit`.

## Check your work

- `pnpm --filter @agent-os/runtime lint`
- `pnpm --filter @agent-os/runtime typecheck`
- `pnpm --filter @agent-os/runtime test`
- `pnpm --filter @agent-os/runtime test:e2e` and `test:verify` — these configs migrate the database in `DATABASE_URL` as soon as they load; point them only at a test database.

## More

- [docs/code-system/packages/runtime.md](../../docs/code-system/packages/runtime.md)
- [step-handler.md](../../docs/code-system/patterns/step-handler.md), [transactional-outbox.md](../../docs/code-system/patterns/transactional-outbox.md), [pure-decision.md](../../docs/code-system/patterns/pure-decision.md)
