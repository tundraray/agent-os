# packages/runtime (`@agent-os/runtime`)

The durable task engine: tasks that run in steps and survive a server restart, the message inbox with the wake-up rule of awaited children (`awaited_step`), questions to a human, the tree signal (`pg_notify` on `runtime_tree`), the token ledger and recovery of lost steps. `agents` and `apps/api` depend on it; it depends on `db`, `contracts` and `common`.

## Rules here

- The engine is generic: it knows nothing about agents, models, tools or conversations. The work of a step is done by a handler that an upper layer registers by task type. Anything from another domain (owner check, prices) comes in as a parameter or a port.
- One process executes steps. There are no leases and no heartbeat: a step runs in this process until it ends, is cut off by a stop or an interrupt (`TaskControl` → `RunningTaskRegistry.abortTask`) or hits its step time limit. A `running` task whose step this process does not execute was lost in a crash; `RecoverySweeper` requeues it at the start and on its period.
- Only the services of this package change a task's status. Transition rules live in them, as guarded transitions; nobody else writes the status column.
- This is restart and concurrency code. There is no `FOR UPDATE` (ADR-0023): a transaction that will write a task makes a guarded `UPDATE` of that row its first statement (`Tasks.hold`), which returns the current row and makes other writers of the row wait until this transaction ends; later writes are guarded `UPDATE ... WHERE` on status and attempt. Keep those guards and the order of writes inside a transaction exact; do not "simplify" them. A step may run twice after a crash: every write must hold under a repeat.
- Row order (ADR-0023, п. 6): the first row a transaction writes is the task it is for — its own for a step, a claim, `guard`, a failure and a requeue; the top one for a stop and a tree deletion; the target of an interrupt; the recipient of a message outside a step; the parent of a child created outside a step. After it rows are taken only down the tree level by level in `task_id` order, one level up (the parent of a finished task) and to the recipient of a step's message. There is no total order, so deadlocks happen: an engine operation that opens its own transaction runs it through `withTxRetry` (`tasks/transaction-retry.ts`), which repeats it after `40P01` up to three times and logs each repeat; inside a caller's transaction it catches nothing. The step commit keeps its own retry loop. A savepoint (`inSavepoint`) never swallows an error after which the transaction cannot go on (`mustRetryTransaction`). A handler's savepoint inside its commit is `effects.savepoint`: its rollback also drops what it did through the effects (children, adopted objects, messages, a question), so the commit never counts a row that is gone. Cutting off steps and letting objects go happens after the transaction.
- The transaction goes to the handler, not from it: `StepCommitter` opens the step-result `db.transaction` and calls the result's `commit(effects)` inside it; the repositories the handler calls join it through `Db`. A guarded write in the middle of a step goes through `StepContext.guard`.
- Services are `@Injectable` classes with an explicit `@Inject(...)` on every constructor parameter. Pure rules, `WorkerLoop` and config parsing stay plain code, not providers.
- No table queries here: they live in `packages/db/src/repositories/runtime-*.repository.ts`.
- Every end of a task goes through `endTask` (`tasks/task-end.ts`): a `failed` task stops its unfinished descendants in the same transaction, then every task end hook (`TaskEndHooks`) runs in its own savepoint, then the parent gets `child_finished` — one on every end. A parent waiting for its children (`waiting(children)`) is woken only by the wake-up rule in `Inbox.insertMessage`, which counts its unfinished awaited children after writing its row and never writes the children's rows. A hook that throws is logged and the end still commits.
- A question to a human is a child task of the reserved type `runtime.question` (`QUESTION_TASK_TYPE`), never a table of its own: a step asks it with `effects.ask` in its commit (the question waits in `waiting(human)` with `awaited_step`, the asker in `waiting(children)`), `TaskControl.answer` ends it `completed` through `endTask` with the answer as its `result`, and the asker gets the answer as the question's `child_finished`. No handler may register that type, and no message may be written to a question task (`TASK_NOT_FOUND`); a stop ends it like any descendant.
- Background workers start in `onApplicationBootstrap` and stop in `beforeApplicationShutdown`; registrations (task handlers, task end hooks) happen in `onModuleInit`.

## Check your work

- `pnpm --filter @agent-os/runtime lint`
- `pnpm --filter @agent-os/runtime typecheck`
- `pnpm --filter @agent-os/runtime test`
- `pnpm --filter @agent-os/runtime test:e2e` and `test:verify` — these configs migrate the database in `DATABASE_URL` as soon as they load; point them only at a test database.

## More

- [docs/code-system/packages/runtime.md](../../docs/code-system/packages/runtime.md)
- [step-handler.md](../../docs/code-system/patterns/step-handler.md), [pure-decision.md](../../docs/code-system/patterns/pure-decision.md)
