// agent-platform / runtime Integration Test Skeletons - Design Doc: docs/features/agent-platform/design-runtime.md (Test Strategy, Flows 1-5, Invariants 1-9)
// PRD: docs/features/agent-platform/prd.md (FR-01 AC-01.1..AC-01.3, FR-02 AC-02.1..AC-02.2; NFR-01, NFR-04, NFR-05, NFR-06 in the part runtime gives). ADRs: ADR-0001 (runtime owner), ADR-0003 (Drizzle data layer), ADR-0004 (package rules)
// Generated: 2026-11-14 | Part: runtime | Test type: Integration (in-process runtime of the package + real Postgres), CI job `e2e-runtime`
// Implementation timing: created alongside the slice each test names (INT-1 the step and its commit; INT-2 the inbox; INT-3 interrupt and stop; INT-4 the owner check on every operation; INT-5 the token ledger).
//
// File name follows the project convention (`*.e2e-spec.ts` under packages/runtime/test, picked up by vitest.config.e2e.ts, run with `pnpm --filter @agent-os/runtime test:e2e`, never in the default `vitest run`).
// The `.int.` infix separates these in-process tests from the child-process file `agent-platform-runtime.e2e-spec.ts` (final phase). The old runtime tests (`research-runtime-runtime.*`) are deleted with the old code by the
// implementation tasks (KD-7); nothing here edits them. Started as `it.todo` skeletons; the Given/When/Then comments are the rows' specification. Tests are written with their tasks and run once, at the end of the part.
//
// Light test process (CLAUDE.md "Tests", owner decision): skeletons exist only where a defect is invisible below this level - concurrency (two instances, one step), the inbox race, interrupt and stop with a step in flight, isolation
// between users, and the money rows. Every pure rule is a unit test named in "Proven elsewhere". Restarts and the process-kill matrix are the sibling file (E2E-1).
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml (DATABASE_URL from apps/api/.env), migrations applied once by the global setup (`test/support/migrate.global-setup.ts`). Real `createRuntime` over a real pool; `RUNTIME_WORKERS` on. No mocks of
//   Postgres or runtime components. The only doubles are test handlers (`TaskHandler`: scripted outcomes, gates and latches) and, for the clock rows, the injected `Clock`. No model is called.
// - Two instances in one process (INT-1 row C, INT-3 rows A and B) are two `createRuntime` calls over two pools to the same database, registering the same handler types. The second instance is what makes "another instance" real:
//   claim contention and NOTIFY across connections need no second OS process.
// - Isolation (project convention, no truncate): a unique `ownerId = 'e2e-' + randomUUID()` (`newUser()`) and a unique task type per test (a worker claims only types in its own `handlers` registry, so another file's workers never touch these
//   rows); each test reads only its own tree. `fileParallelism: false`.
// - No sleeps for ordering and no latency assertions: tests synchronise on gates the handler waits on and on rows (`runtimeWorkSettled`-style). "Status changed within the command" (NFR-01) is asserted as: the status read right after the command's
//   response, while the handler is still held; the 5 s p95 is the on-demand script `test/verify/runtime-latency.verify.ts` (UC-N2), not this file.
// - Support to write alongside (test/support, same names as the old ones where the role is the same): runtimeHarness.ts (createDatabase + createRuntime with test handlers, injected Clock, an in-memory logger from `@agent-os/common/testing`,
//   `expireLease`, a second instance), runtimeDb.ts (read-only snapshots of `runtime_*` rows, a row-version snapshot for "nothing changed"), testHandlers.ts (step scripts, gates, a table of handler rows written through `commit`).
//
// Budget: Integration 5 of 3, extended to 5 under the integration-e2e-testing rule ("up to 5 only when each extra test names the defect no other test catches"). Core: INT-1, INT-2, INT-3. Extras: INT-4 and INT-5.
//   INT-4 unique defect: one operation of the part that filters by id and forgets the owner - a pure unit cannot see it, the SQL does; it is the NFR-06 share this part owns and CLAUDE.md lists isolation first.
//   INT-5 unique defect: the month window and the per-owner sum are SQL over real rows, and the survival of the rows after `deleteTree` is a foreign-key property (no FK on task); a mock cannot show either - money, CLAUDE.md "Tests".
//
// Proven elsewhere (not in this file; the plan reads this to avoid a second test for an AC already proven):
// - unit, packages/runtime/src: the cost rule (one table: input tier threshold, output, cache read, cache write; model with and without a tier) in `model-cost.spec.ts` - AC-02.2 (price per model, literal rows), the part of DC-9 that is the rule;
//   `parseRuntimeConfig` / `parseModelPrices` rows extend the existing `runtime-config.spec.ts` only if the plan changes the parsing
// - unit, packages/common/src: DC-11 and UC-9 - redaction by field name (case-insensitive, nested) and by secret value, the `[redacted]` replacement in BOTH sinks, error expansion with cause chain, the 16 KiB truncation, `child(fields)`; the console and the
//   Sentry sink over a fake SDK (one log call, plus one exception call when `error` is set). One table-driven file over `@agent-os/common/testing`; no integration test, the logger has no I/O of its own.
// - the process-kill matrix, restart, recovery exhaustion, the guard intent, the decision across a restart: sibling file agent-platform-runtime.e2e-spec.ts (E2E-1)
// - on-demand script test/verify/runtime-latency.verify.ts (not in the suite): UC-N1 (resume within 60 s, NFR-05 measured), UC-N2 (status within 5 s p95, NFR-01 measured)
// - not automated: task input validation (`UNKNOWN_TASK_TYPE`, `INVALID_TASK_INPUT` - zod is the library; the wiring is hit by every test that creates a task), event type prefix rule, `RUNTIME_*` defaults, Sentry initialisation in the apps
//
// AC -> proving test:
// - AC-01.1: E2E-1 (reference run and every crash row); INT-1 row A (the same three-step task without a crash)
// - AC-01.2: E2E-1 row "guard" (UC-7)
// - AC-01.3: INT-2 (rows A, B, E: once and in order), E2E-1 (a message pending at the kill)
// - AC-02.1, AC-02.2: INT-5 (rows A, B) and the cost-rule unit table
// - DC-1: INT-1 row A + E2E-1 row "kill inside the commit"; DC-2, DC-3, DC-7: E2E-1; DC-4: INT-2; DC-5: INT-1 rows A, B and INT-3 row B; DC-6: INT-3; DC-8: INT-4; DC-9: INT-5 row C; DC-10: INT-5 rows B, D; DC-11: unit (packages/common)
// - NFR-01 (status within the command): INT-3 rows A, B (the 5 s figure: verify script); NFR-04: INT-2 row E, INT-1 row C; NFR-05: E2E-1 harness timeout + verify script; NFR-06 (owner check in every operation): INT-4

import { randomUUID } from 'node:crypto';
import { runtimeDecisions, runtimeModelCalls } from '@agent-os/db';
import {
  type GuardResult,
  type NewMessage,
  RuntimeError,
  type StepContext,
  type StepResult,
  type TaskHandler,
} from '@agent-os/runtime';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newUser } from './support/new-user.js';
import {
  closeRuntimeDb,
  eventsOf,
  handlerRowsOf,
  inboxOf,
  rowVersionsOf,
  statusesOf,
  waitFor,
} from './support/runtimeDb.js';
import {
  createRuntimeHarness,
  expireLease,
  type RuntimeHarness,
  settableClock,
  TEST_MODEL_ONE,
  TEST_MODEL_TWO,
} from './support/runtimeHarness.js';
import {
  createGate,
  createGateBook,
  DEAF_SIGNAL,
  type Gate,
  type ScriptedStep,
  type StepView,
  scriptedHandler,
  uniqueType,
  writeHandlerRow,
} from './support/testHandlers.js';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 60_000;

/** A parent that only waits for messages: the test reads its inbox. */
const waitingParent = (type: string) =>
  scriptedHandler({ type, steps: [{ outcome: 'wait' }] });

/** `continue`, `continue`, then `complete` with a result: one handler row per step. */
const THREE_STEPS: readonly ScriptedStep[] = [
  { outcome: 'continue' },
  { outcome: 'continue' },
  { outcome: 'complete', result: { answer: 42 } },
];

/** The runtime's end notices in the parent's inbox, delivered or not. */
async function childFinishedOf(parentId: string) {
  const messages = await inboxOf(parentId);
  return messages.filter((message) => message.kind === 'child_finished');
}

/** An employee's message of kind `note` to the owner's task, without `revive`. */
function note(recipientId: string, ownerId: string, payload: unknown): NewMessage {
  return { recipientId, ownerId, kind: 'note', sender: ownerId, payload };
}

/** The stored state of a decision request. */
async function decisionOf(harness: RuntimeHarness, decisionId: string) {
  const [row] = await harness.db
    .select({
      status: runtimeDecisions.status,
      resolution: runtimeDecisions.resolution,
      deliveredStep: runtimeDecisions.deliveredStep,
    })
    .from(runtimeDecisions)
    .where(eq(runtimeDecisions.decisionId, decisionId));
  return row;
}

/** Every ledger row of the owner as stored. */
function ledgerRowsOf(harness: RuntimeHarness, ownerId: string) {
  return harness.db
    .select()
    .from(runtimeModelCalls)
    .where(eq(runtimeModelCalls.ownerId, ownerId));
}

/** Closes every harness the test opened, also when one of them fails to close. */
async function closeAll(harnesses: readonly RuntimeHarness[]): Promise<void> {
  const closed = await Promise.allSettled(harnesses.map((harness) => harness.close()));
  const failed = closed.find(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
  );
  if (failed) throw failed.reason;
}

/** Bound of a test that repeats a race; each iteration settles in well under a second. */
const RACE_TIMEOUT_MS = 300_000;
/** Iterations of a race, each with a fresh task or tree. */
const RACE_ITERATIONS = 100;

/** Any JSON object as input. */
const anyInput = z.record(z.string(), z.unknown());

/** An operation's answer: its value, or the code of the runtime's refusal. */
type Answer = { value: unknown } | { code: string };

async function answerOf(call: () => Promise<unknown>): Promise<Answer> {
  try {
    return { value: await call() };
  } catch (error) {
    if (error instanceof RuntimeError) return { code: error.code };
    throw error;
  }
}

/** What the cut-off step of INT-3 A did after its command, and what the steps after it saw. */
interface CutOffProbe {
  intent?: GuardResult<void>;
  signal?: AbortSignal;
  lateGuard?: GuardResult<void>;
  later: {
    stepNo: number;
    resumedAfterLoss: boolean;
    messages: { kind: string; sender: string; payload: unknown }[];
  }[];
}

/**
 * INT-3 A: the first call writes a guarded intent row and records a model call, then holds at
 * `held` deaf to its signal; let go, it calls `guard` again and returns `continue` with a commit
 * row. Every later call holds at `next` and returns `wait` with a commit row.
 */
function cutOffHandler(options: {
  type: string;
  held: Gate;
  next: Gate;
  probe: CutOffProbe;
  recordCall: (taskId: string) => Promise<unknown>;
}): TaskHandler {
  const { type, held, next, probe, recordCall } = options;
  let calls = 0;
  return {
    type,
    inputSchema: anyInput,
    async step(ctx: StepContext): Promise<StepResult> {
      calls += 1;
      if (calls > 1) {
        probe.later.push({
          stepNo: ctx.stepNo,
          resumedAfterLoss: ctx.resumedAfterLoss,
          messages: ctx.messages.map(({ kind, sender, payload }) => ({ kind, sender, payload })),
        });
        await next.pass(ctx.signal);
        return { outcome: 'wait', commit: writeHandlerRow(ctx, 'commit') };
      }
      probe.intent = await ctx.guard(writeHandlerRow(ctx, 'intent'));
      await recordCall(ctx.taskId);
      probe.signal = ctx.signal;
      await held.pass(DEAF_SIGNAL);
      probe.lateGuard = await ctx.guard(writeHandlerRow(ctx, 'late-guard'));
      return { outcome: 'continue', commit: writeHandlerRow(ctx, 'late-commit') };
    },
  };
}

describe('agent-platform / runtime - integration (in-process runtime + real Postgres)', () => {
  afterAll(closeRuntimeDb);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  A step is run once and committed as one: two instances, one step; the parent is told once
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-01.1: "Given агент выполняет многошаговое задание, when сервер останавливают посреди работы и запускают снова, then агент продолжает и сдаёт отчёт, а в его истории нет потерянных и повторённых шагов." (the part without a crash; the crash half is E2E-1)
  // DC-1: "Записи обработчика за шаг, доставка взятых им сообщений, новый статус задачи и события фиксируются вместе или не фиксируются вовсе."
  // DC-5: "Когда задача заканчивается — завершена, упала или остановлена, — в очереди её родителя появляется ровно одно уведомление со статусом и итогом." (completed and failed here; stopped in INT-3)
  // NFR-04: "Каждое принятое сообщение, отчёт и уведомление доставляется ровно один раз и в порядке отправки" (the notification half)
  // Use cases: UC-1, UC-E8, and the "second worker" half of the concurrency requirement. EARS: When. Design flow: Flow 1 (step runs and commits), KD-2 (one transaction per step), KD-3 (the runtime writes the child notification in the transition's transaction).
  //
  // Catches: (1) a step claimed by two workers at once - a handler row written twice or `stepNo` skipping, because the claim guard (`SKIP LOCKED`, attempt number, `status = queued` re-check) was weakened; (2) the handler's rows, the new status and the
  //   parent's notification not in one transaction - a completed task with no `child_finished` in the parent's inbox, or two of them; (3) a throwing handler leaving the task `running` or the parent unnotified.
  // Not re-checked here: input validation, the shape of `StepResult` variants (types), the cost of the step (INT-5).
  // Behavior: ready tasks -> claimed by one of two instances -> each step's handler rows + status + notification committed once -> the tree reads as one uninterrupted run
  // @category: core-functionality
  // @dependency: createRuntime x2 (Dispatcher, TaskControl, Inbox, EventLog), test handlers, Postgres
  // @complexity: high
  //
  // Verification items (table-driven by scenario; one child task under a parent task whose inbox is read):
  // - Row A "three steps": the child's handler returns `continue`, `continue`, then `complete` with a result, writing one row per step to its own table through `commit`. Then: three handler rows with step numbers 0, 1, 2 and no others; the child `completed`
  //   with `stepNo` 3 and the result stored; the parent's inbox holds exactly one `child_finished` with status `completed`, the child's `taskId`, the result, the step count and a duration; `task.step_committed` appears three times for the child.
  // - Row B "handler throws": the handler throws an error with a `cause` on its first step. Then: the child `failed` with reason `handler_error`; no row of that step in the handler's table; exactly one `child_finished` with status `failed` and the failure in the
  //   parent's inbox; the error is in the in-memory log with its stack and cause (the log side of DC-11 is the unit table, this row only checks that the failure is logged at all).
  // - Row C "two instances, one step": two runtimes over the same database, the same handler type, 20 ready tasks of three steps each. Then: for every task each of the three step numbers has one handler row; `attempt` of each committed step is the one claimed;
  //   every task has exactly one `child_finished` to its (shared) parent; both instances committed at least one step (the contention was real, not one worker doing everything). One executor per step is proven by the claim guard; this row turns red only when
  //   both the guarded claim write and the re-check under the row lock are removed, which is the defect it names.
  it('INT-1 A: a three-step task writes one row per step, ends completed, and its parent holds exactly one child_finished with the result', async () => {
    // Given: a child of three steps under a parent that waits for messages
    const ownerId = newUser();
    const parentType = uniqueType('int1a-parent');
    const childType = uniqueType('int1a-child');
    const harness = await createRuntimeHarness({
      handlers: [
        waitingParent(parentType),
        scriptedHandler({ type: childType, steps: THREE_STEPS }),
      ],
    });
    try {
      const parentId = await harness.tasks.create({ type: parentType, ownerId, input: {} });
      const childId = await harness.tasks.create({
        type: childType,
        ownerId,
        input: {},
        parentId,
      });

      // When: the workers run the child to its end
      await waitFor(
        () => statusesOf([childId]),
        (statuses) => statuses.get(childId) === 'completed',
        'the child to complete',
      );

      // Then: one handler row per step, the result stored, one notice to the parent
      const rows = await handlerRowsOf([childId]);
      expect(rows.map((row) => row.stepNo)).toEqual([0, 1, 2]);
      expect(await harness.tasks.get(childId, ownerId)).toMatchObject({
        status: 'completed',
        stepNo: 3,
        result: { answer: 42 },
        failure: null,
      });
      const notices = await childFinishedOf(parentId);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ sender: childId, revive: false });
      expect(notices[0].payload).toEqual({
        taskId: childId,
        status: 'completed',
        result: { answer: 42 },
        steps: 3,
        durationMs: expect.any(Number),
      });
      const committed = (await eventsOf(childId)).filter(
        (event) => event.type === 'task.step_committed',
      );
      expect(committed.map((event) => event.payload.stepNo)).toEqual([0, 1, 2]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 B: a throwing handler fails the task with handler_error, applies none of that step\'s rows, and notifies the parent once', async () => {
    // Given: a child whose first step throws an error with a cause
    const ownerId = newUser();
    const parentType = uniqueType('int1b-parent');
    const childType = uniqueType('int1b-child');
    const error = new Error('step exploded', { cause: new Error('disk on fire') });
    const harness = await createRuntimeHarness({
      handlers: [
        waitingParent(parentType),
        scriptedHandler({ type: childType, steps: [{ outcome: 'throw', error }] }),
      ],
    });
    try {
      const parentId = await harness.tasks.create({ type: parentType, ownerId, input: {} });
      const childId = await harness.tasks.create({
        type: childType,
        ownerId,
        input: {},
        parentId,
      });

      // When: the workers run the step
      await waitFor(
        () => statusesOf([childId]),
        (statuses) => statuses.get(childId) === 'failed',
        'the child to fail',
      );

      // Then: failed with handler_error, no row of the step, one notice, the error logged
      expect(await harness.tasks.get(childId, ownerId)).toMatchObject({
        status: 'failed',
        stepNo: 0,
        failure: { reason: 'handler_error', message: 'step exploded' },
      });
      expect(await handlerRowsOf([childId])).toEqual([]);
      const notices = await childFinishedOf(parentId);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ sender: childId, revive: false });
      expect(notices[0].payload).toEqual({
        taskId: childId,
        status: 'failed',
        failure: { reason: 'handler_error', message: 'step exploded' },
        steps: 0,
        durationMs: expect.any(Number),
      });
      // The log line follows the failing transaction's commit, so it is awaited too.
      const logged = await waitFor(
        async () =>
          harness.logs.find(
            (record) =>
              record.level === 'error' &&
              record.fields.taskId === childId &&
              record.fields.reason === 'handler_error',
          ),
        (record) => record !== undefined,
        'the step failure in the log',
      );
      expect(logged?.fields.error).toMatchObject({
        message: 'step exploded',
        stack: expect.stringContaining('step exploded'),
        cause: { message: 'disk on fire' },
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 C: two instances run twenty three-step tasks; every step is written once, every parent notification arrives once, both instances took part', async () => {
    // Given: two instances over one database with the same handler types, workers held; twenty
    // ready children of three steps under one parent
    const ownerId = newUser();
    const parentType = uniqueType('int1c-parent');
    const childType = uniqueType('int1c-child');
    const handlersOf = (instance: string) => [
      waitingParent(parentType),
      scriptedHandler({ type: childType, steps: THREE_STEPS, note: instance }),
    ];
    const harnesses: RuntimeHarness[] = [];
    try {
      harnesses.push(
        await createRuntimeHarness({ handlers: handlersOf('A'), startWorkers: false }),
      );
      harnesses.push(
        await createRuntimeHarness({ handlers: handlersOf('B'), startWorkers: false }),
      );
      const [first] = harnesses;
      const parentId = await first.tasks.create({ type: parentType, ownerId, input: {} });
      const childIds: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        childIds.push(
          await first.tasks.create({ type: childType, ownerId, input: {}, parentId }),
        );
      }

      // When: both instances start at once
      for (const harness of harnesses) harness.start();
      await waitFor(
        () => statusesOf(childIds),
        (statuses) => childIds.every((childId) => statuses.get(childId) === 'completed'),
        'twenty children to complete',
      );

      // Then: per task one row per step number, written by the attempt that committed it
      const rows = await handlerRowsOf(childIds);
      const written = Object.fromEntries(
        childIds.map((childId) => [
          childId,
          rows
            .filter((row) => row.taskId === childId)
            .map((row) => ({ stepNo: row.stepNo, attempt: row.attempt })),
        ]),
      );
      expect(Object.values(written).map((steps) => steps.map((step) => step.stepNo))).toEqual(
        childIds.map(() => [0, 1, 2]),
      );
      const committed = Object.fromEntries(
        await Promise.all(
          childIds.map(async (childId) => [
            childId,
            (await eventsOf(childId))
              .filter((event) => event.type === 'task.step_committed')
              .map((event) => ({ stepNo: event.payload.stepNo, attempt: event.payload.attempt })),
          ]),
        ),
      );
      expect(written).toEqual(committed);
      // every child told the shared parent exactly once
      const notices = await childFinishedOf(parentId);
      expect(notices.map((notice) => notice.sender).sort()).toEqual([...childIds].sort());
      // the contention was real: both instances committed steps
      expect(new Set(rows.map((row) => row.note))).toEqual(new Set(['A', 'B']));
    } finally {
      await closeAll(harnesses);
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  The inbox: order, one delivery, wake-up, revive - and the race with the end of a step
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-01.3: "Given сообщение агенту ждало в очереди, when сервер перезапускается, then сообщение доставляется агенту один раз." (the in-process half; the restart is E2E-1)
  // DC-4: "Сообщение свободной задаче будит её в той же транзакции; занятая задача получает его в следующем шаге; задача, которая ждёт решения, получает его после решения; законченная задача оживает от сообщения, только если оно отправлено с `revive`."
  // NFR-04: "Каждое принятое сообщение, отчёт и уведомление доставляется ровно один раз и в порядке отправки — в том числе когда отправка, конец хода, прерывание и рестарт сервера совпадают по времени."
  // Invariants 2 and 4: "Задача в `waiting` с причиной `messages` никогда не имеет недоставленных сообщений." / "Каждое сообщение доставлено не больше чем в одном зафиксированном шаге, и сообщения одного получателя доставляются в порядке номеров."
  // Use cases: UC-3, UC-4, UC-5, UC-E4. EARS: When / While. Design flow: Flow 3, KD-3 (one queue, delivery on the step's commit).
  //
  // Catches: (1) a message that arrives during a step shown to that same step (the "current step sees no messages" boundary), or delivered twice, or out of order; (2) a task left `waiting` with a pending message when the message lands between the handler's
  //   `wait` result and the commit (the lost wake-up of Invariant 2); (3) a finished task revived without `revive`, or a stopped parent revived by a child's notification (KD-3 "a child's notification does not revive").
  // Not re-checked here: the kill half of UC-E4 (E2E-1 row "message pending at the kill"), the decision-waiting case (E2E-1 row "decision across a restart", which holds the pending message), `PAYLOAD_TOO_LARGE`.
  // Behavior: messages enqueued -> task busy / free / finished / racing with the end of a step -> delivered in the next committed step once, in number order, with the task never left asleep over them
  // @category: core-functionality
  // @dependency: createRuntime (Inbox, Dispatcher, TaskControl), test handlers with gates, Postgres NOTIFY
  // @complexity: high
  //
  // Verification items (table-driven by recipient state):
  // - Row A "busy": a step is held on a gate. Enqueue three messages in a row. Then: the held step's context had none of them; after the gate opens the next step's context lists all three in the order sent; after that step commits all three are `delivered`
  //   with that step number; a further step's context lists none (no redelivery).
  // - Row B "free, waiting for messages": the task is `waiting` with reason `messages`. Enqueue one message. Then: in the same call's transaction the task reads `queued` (checked before any worker could have run: workers paused for this row); with workers on, the
  //   next step receives the message.
  // - Row C "finished, no revive, then revive": the task is `completed`. Enqueue without `revive`: the task stays `completed`, the message is listed pending. Enqueue with `revive`: the task is `queued`; its next step receives both messages in number order.
  // - Row D "a child's notification does not revive a stopped parent": stop the parent (its children finish afterwards): the parent stays `stopped` and the `child_finished` messages wait. (A `completed` parent: the same.)
  // - Row E "race": the step's handler returns `wait`; messages are enqueued in parallel with the commit of that step, with an `interrupt` of the task, and with the commit of a second step of the same task on the other instance after a lease expiry; the scenario is repeated
  //   100 times with a fresh task each. After every iteration: no task is `waiting` with reason `messages` while a message is pending (Invariant 2); every message is `delivered` exactly once and the delivery order equals the number order (Invariant 4); the
  //   number sequence of one recipient has no gaps and no repeats under 8 concurrent senders.
// - Row F "revive during the last step" (UC-E10, Invariant 9, design v1.2): a child's step is held on a gate and will return `complete`. Enqueue a message without `revive`, then one with `revive`;
//   open the gate. Then: the parent's inbox holds exactly one `child_finished` with status `completed`; the child reads `queued` with the same `taskId` (no new task) and its result cleared; its next step's
//   context lists both messages in number order. Catches: the commit leaving the task `completed` over a pending `revive` message (a lost revive), or reviving without notifying the parent first.
  // - Row B, decision half (task T4.4 proof obligation, DC-4 "задача, которая ждёт решения, получает его после решения"): a task waiting for a decision gets a message and stays
  //   `waiting` (`decision`); `resolve` twice answers `resolved`, then `already_resolved`; the next step alone gets the decision and the message; the decision reads `resolved`
  //   with `delivered_step` of that step.
  it('INT-2 A: a message sent during a step is invisible to it, comes in the next step in the order sent, and is not delivered again', async () => {
    // Given: a task whose first step holds on a gate and continues; then it continues once and waits
    const ownerId = newUser();
    const type = uniqueType('int2a');
    const gate = createGate();
    const seen: StepView[] = [];
    const harness = await createRuntimeHarness({
      handlers: [
        scriptedHandler({
          type,
          seen,
          steps: [{ outcome: 'continue', gate }, { outcome: 'continue' }, { outcome: 'wait' }],
        }),
      ],
    });
    try {
      const taskId = await harness.tasks.create({ type, ownerId, input: {} });
      await gate.reached;

      // When: three messages are sent while the step is held, then the step is let go
      const sent: number[] = [];
      for (const n of [1, 2, 3]) {
        sent.push((await harness.inbox.enqueue(note(taskId, ownerId, { n }))).seq);
      }
      gate.open();
      await waitFor(
        () => statusesOf([taskId]),
        (statuses) => statuses.get(taskId) === 'waiting',
        'the task to wait for messages',
      );

      // Then: the held step saw none; the next step all three in the order sent; the one after none
      expect(sent).toEqual([0, 1, 2]);
      expect(seen.map((view) => view.stepNo)).toEqual([0, 1, 2]);
      expect(seen[0].messages).toEqual([]);
      expect(seen[1].messages.map((message) => [message.seq, message.payload])).toEqual([
        [0, { n: 1 }],
        [1, { n: 2 }],
        [2, { n: 3 }],
      ]);
      expect(seen[2].messages).toEqual([]);
      expect(
        (await inboxOf(taskId)).map((message) => [
          message.seq,
          message.status,
          message.deliveredStep,
        ]),
      ).toEqual([
        [0, 'delivered', 1],
        [1, 'delivered', 1],
        [2, 'delivered', 1],
      ]);
      expect(await harness.inbox.listPending(taskId, ownerId)).toEqual([]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-2 B: a message to a task waiting for messages makes it queued in the same transaction, and its next step receives it', async () => {
    // Given: a task that waits for messages, and (the decision half) a task that asks for a decision
    const ownerId = newUser();
    const messagesType = uniqueType('int2b-messages');
    const decisionType = uniqueType('int2b-decision');
    const seenByMessages: StepView[] = [];
    const seenByDecision: StepView[] = [];
    const harness = await createRuntimeHarness({
      handlers: [
        scriptedHandler({
          type: messagesType,
          seen: seenByMessages,
          steps: [{ outcome: 'wait' }],
        }),
        scriptedHandler({
          type: decisionType,
          seen: seenByDecision,
          steps: [
            { outcome: 'await_decision', kind: 'approve', payload: { question: 'go?' } },
            { outcome: 'continue' },
            { outcome: 'wait' },
          ],
        }),
      ],
    });
    try {
      const taskId = await harness.tasks.create({ type: messagesType, ownerId, input: {} });
      await waitFor(
        () => harness.tasks.get(taskId, ownerId),
        (task) => task.status === 'waiting' && task.waitReason === 'messages',
        'the task to wait for messages',
      );

      // When: with the workers paused, one message is sent
      await harness.stop();
      await harness.inbox.enqueue(note(taskId, ownerId, { n: 1 }));

      // Then: the send itself made the task queued - no worker could have run
      expect(await harness.tasks.get(taskId, ownerId)).toMatchObject({
        status: 'queued',
        waitReason: null,
        stepNo: 1,
      });

      // And: with the workers on, the next step receives the message, once
      harness.start();
      await waitFor(
        () => statusesOf([taskId]),
        (statuses) => statuses.get(taskId) === 'waiting' && seenByMessages.length === 2,
        'the second step to commit',
      );
      expect(
        seenByMessages.map((view) => view.messages.map((message) => message.payload)),
      ).toEqual([[], [{ n: 1 }]]);
      expect(
        (await inboxOf(taskId)).map((message) => [message.status, message.deliveredStep]),
      ).toEqual([['delivered', 1]]);

      // Given (decision half): a task waiting for a decision gets a message and keeps waiting
      const decidingId = await harness.tasks.create({ type: decisionType, ownerId, input: {} });
      await waitFor(
        () => harness.tasks.get(decidingId, ownerId),
        (task) => task.status === 'waiting' && task.waitReason === 'decision',
        'the task to wait for a decision',
      );
      await harness.inbox.enqueue(note(decidingId, ownerId, { n: 1 }));
      expect(await harness.tasks.get(decidingId, ownerId)).toMatchObject({
        status: 'waiting',
        waitReason: 'decision',
      });
      const [request] = (await harness.decisions.listTree(decidingId, ownerId)).filter(
        (d) => d.status === 'open',
      );

      // When: the decision is resolved twice
      const first = await harness.decisions.resolve(request.decisionId, ownerId, {
        approved: true,
      });
      const second = await harness.decisions.resolve(request.decisionId, ownerId, {
        approved: false,
      });

      // Then: resolved once; only the next step gets the decision, together with the message
      expect([first, second]).toEqual(['resolved', 'already_resolved']);
      await waitFor(
        () => statusesOf([decidingId]),
        (statuses) => statuses.get(decidingId) === 'waiting' && seenByDecision.length === 3,
        'the steps after the decision to commit',
      );
      expect(seenByDecision[0].decision).toBeNull();
      expect(seenByDecision[1]).toMatchObject({
        stepNo: 1,
        decision: {
          decisionId: request.decisionId,
          kind: 'approve',
          payload: { question: 'go?' },
          resolution: { approved: true },
        },
      });
      expect(seenByDecision[1].messages.map((message) => message.payload)).toEqual([{ n: 1 }]);
      expect(seenByDecision[2]).toMatchObject({ stepNo: 2, decision: null, messages: [] });
      expect(await decisionOf(harness, request.decisionId)).toEqual({
        status: 'resolved',
        resolution: { approved: true },
        deliveredStep: 1,
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-2 C: a finished task stays finished for a message without revive and comes back, with both messages in order, for one with revive', async () => {
    // Given: a task that completes in its first step and waits in the next; workers paused after it
    const ownerId = newUser();
    const type = uniqueType('int2c');
    const seen: StepView[] = [];
    const harness = await createRuntimeHarness({
      handlers: [
        scriptedHandler({
          type,
          seen,
          steps: [{ outcome: 'complete', result: { done: true } }, { outcome: 'wait' }],
        }),
      ],
    });
    try {
      const taskId = await harness.tasks.create({ type, ownerId, input: {} });
      await waitFor(
        () => statusesOf([taskId]),
        (statuses) => statuses.get(taskId) === 'completed',
        'the task to complete',
      );
      await harness.stop();

      // When: a message without revive is sent
      await harness.inbox.enqueue(note(taskId, ownerId, { n: 1 }));

      // Then: the task stays completed and the message waits
      expect(await harness.tasks.get(taskId, ownerId)).toMatchObject({
        status: 'completed',
        result: { done: true },
      });
      expect(
        (await harness.inbox.listPending(taskId, ownerId)).map((message) => message.payload),
      ).toEqual([{ n: 1 }]);

      // When: a message with revive is sent
      await harness.inbox.enqueue({ ...note(taskId, ownerId, { n: 2 }), revive: true });

      // Then: the same task is queued with its result cleared; its next step gets both in order
      expect(await harness.tasks.get(taskId, ownerId)).toMatchObject({
        status: 'queued',
        stepNo: 1,
        result: null,
      });
      harness.start();
      await waitFor(
        () => statusesOf([taskId]),
        (statuses) => statuses.get(taskId) === 'waiting' && seen.length === 2,
        'the revived step to commit',
      );
      expect(
        seen[1].messages.map((message) => [message.seq, message.payload, message.revive]),
      ).toEqual([
        [0, { n: 1 }, false],
        [1, { n: 2 }, true],
      ]);
      expect(
        (await inboxOf(taskId)).map((message) => [message.status, message.deliveredStep]),
      ).toEqual([
        ['delivered', 1],
        ['delivered', 1],
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-2 D: a child\'s finish notification does not revive a stopped or completed parent', async () => {
    // Given: a parent whose child holds its step; a parent that completes while its child still runs
    const ownerId = newUser();
    const parentType = uniqueType('int2d-parent');
    const heldChildType = uniqueType('int2d-held-child');
    const finishingType = uniqueType('int2d-finishing');
    const lateChildType = uniqueType('int2d-late-child');
    const heldChild = createGate();
    const parentLastStep = createGate();
    const childLastStep = createGate();
    const harness = await createRuntimeHarness({
      handlers: [
        waitingParent(parentType),
        scriptedHandler({ type: heldChildType, steps: [{ outcome: 'continue', gate: heldChild }] }),
        scriptedHandler({
          type: finishingType,
          steps: [{ outcome: 'complete', result: { parent: 'done' }, gate: parentLastStep }],
        }),
        scriptedHandler({
          type: lateChildType,
          steps: [{ outcome: 'complete', result: { child: 'done' }, gate: childLastStep }],
        }),
      ],
      config: { concurrency: 4 },
    });
    try {
      const stoppedParentId = await harness.tasks.create({ type: parentType, ownerId, input: {} });
      const stoppedChildId = await harness.tasks.create({
        type: heldChildType,
        ownerId,
        input: {},
        parentId: stoppedParentId,
      });
      await heldChild.reached;

      // When: the parent is stopped - its child ends after it, in the same stop
      const stoppedIds = await harness.tasks.stop(stoppedParentId, ownerId);

      // Then: the parent stays stopped and the child's notice waits in its queue
      expect(stoppedIds).toEqual([stoppedParentId, stoppedChildId]);
      expect(await harness.tasks.get(stoppedParentId, ownerId)).toMatchObject({
        status: 'stopped',
        waitReason: null,
      });
      expect(
        (await harness.inbox.listPending(stoppedParentId, ownerId)).map((message) => [
          message.kind,
          message.sender,
          message.revive,
          message.payload,
        ]),
      ).toEqual([
        [
          'child_finished',
          stoppedChildId,
          false,
          { taskId: stoppedChildId, status: 'stopped', steps: 0, durationMs: expect.any(Number) },
        ],
      ]);

      // Given: a parent that completes while its child holds its last step
      const completedParentId = await harness.tasks.create({
        type: finishingType,
        ownerId,
        input: {},
      });
      await parentLastStep.reached;
      const lateChildId = await harness.tasks.create({
        type: lateChildType,
        ownerId,
        input: {},
        parentId: completedParentId,
      });
      await childLastStep.reached;
      parentLastStep.open();
      await waitFor(
        () => statusesOf([completedParentId]),
        (statuses) => statuses.get(completedParentId) === 'completed',
        'the parent to complete',
      );

      // When: the child completes after its parent
      childLastStep.open();
      await waitFor(
        () => statusesOf([lateChildId]),
        (statuses) => statuses.get(lateChildId) === 'completed',
        'the child to complete',
      );

      // Then: the parent stays completed with its result, and the notice waits
      expect(await harness.tasks.get(completedParentId, ownerId)).toMatchObject({
        status: 'completed',
        result: { parent: 'done' },
      });
      expect(
        (await harness.inbox.listPending(completedParentId, ownerId)).map((message) => [
          message.kind,
          message.sender,
          message.revive,
          message.payload,
        ]),
      ).toEqual([
        [
          'child_finished',
          lateChildId,
          false,
          {
            taskId: lateChildId,
            status: 'completed',
            result: { child: 'done' },
            steps: 1,
            durationMs: expect.any(Number),
          },
        ],
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-2 E: messages racing the end of a step, an interrupt and a lease expiry, 100 times, never leave a waiting task over a pending message and never deliver twice or out of order', async () => {
    // Given: two instances of one step at a time each; a task type whose first step holds on its
    // task's gate and every step returns `wait`; sweepers that pass every 25 ms
    const ownerId = newUser();
    const type = uniqueType('int2e');
    const senders = 8;
    const messagesPerSender = 3;
    const firstSteps = createGateBook();
    const racingWaiter: TaskHandler = {
      type,
      inputSchema: anyInput,
      async step(ctx) {
        if (ctx.stepNo === 0) await firstSteps.of(ctx.taskId).pass(ctx.signal);
        return { outcome: 'wait', commit: writeHandlerRow(ctx, null) };
      },
    };
    const config = { concurrency: 1, reaperMs: 25, heartbeatMs: 60_000 };
    const harnesses: RuntimeHarness[] = [];
    try {
      harnesses.push(await createRuntimeHarness({ handlers: [racingWaiter], config }));
      harnesses.push(await createRuntimeHarness({ handlers: [racingWaiter], config }));
      const [first, second] = harnesses;

      for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
        const at = `iteration ${iteration}`;
        const taskId = await first.tasks.create({ type, ownerId, input: {} });
        const gate = firstSteps.of(taskId);
        await gate.reached;
        // The step's process stops beating: a sweeper requeues the step, and the other instance -
        // the holder's only slot is taken - claims it again and holds at the same gate.
        await expireLease(first.db, taskId);
        await waitFor(
          () => eventsOf(taskId),
          (events) => events.some((event) => event.type === 'task.recovered'),
          `the lost step to be requeued (${at})`,
        );

        // When: both attempts of step 0 are let go while 8 senders and an interrupt hit the task
        gate.open();
        const interrupting = second.tasks.interrupt(taskId, ownerId, {
          kind: 'note',
          sender: ownerId,
          payload: { interrupt: true },
        });
        await Promise.all(
          Array.from({ length: senders }, async (_, sender) => {
            const via = harnesses[sender % 2];
            for (let n = 0; n < messagesPerSender; n += 1) {
              await via.inbox.enqueue(note(taskId, ownerId, { sender, n }));
            }
          }),
        );
        expect(await interrupting, at).toBe('interrupted');

        // Then: the task settles waiting for messages with none pending (Invariant 2)
        const settled = await waitFor(
          () => first.tasks.get(taskId, ownerId),
          (task) => task.status === 'waiting',
          `the task to wait again (${at})`,
        );
        expect(settled.waitReason, at).toBe('messages');
        expect(await first.inbox.listPending(taskId, ownerId), at).toEqual([]);

        // And: numbers without gaps or repeats, each message delivered, in number order (Invariant 4)
        const messages = await inboxOf(taskId);
        const total = senders * messagesPerSender + 1;
        expect(
          messages.map((message) => message.seq),
          at,
        ).toEqual(Array.from({ length: total }, (_, seq) => seq));
        expect(
          messages.filter((message) => message.status !== 'delivered'),
          at,
        ).toEqual([]);
        const deliveredSteps = messages.map((message) => message.deliveredStep ?? -1);
        expect(deliveredSteps, at).toEqual([...deliveredSteps].sort((left, right) => left - right));
        for (let sender = 0; sender < senders; sender += 1) {
          expect(
            messages
              .map((message) => message.payload as { sender?: number; n?: number })
              .filter((payload) => payload.sender === sender)
              .map((payload) => payload.n),
            `${at}, sender ${sender}`,
          ).toEqual([0, 1, 2]);
        }
        // each message is named by exactly one committed delivery
        const deliveredIds = (await eventsOf(taskId))
          .filter((event) => event.type === 'inbox.delivered')
          .flatMap((event) => event.payload.messageIds as string[]);
        expect([...deliveredIds].sort(), at).toEqual(
          messages.map((message) => message.messageId).sort(),
        );
        // each step number was committed once: the lost attempt's late commit was refused
        const rows = await handlerRowsOf([taskId]);
        expect(
          rows.map((row) => row.stepNo),
          at,
        ).toEqual(rows.map((_, stepNo) => stepNo));
      }
    } finally {
      await closeAll(harnesses);
    }
  }, RACE_TIMEOUT_MS);

  it('INT-2 F: a revive message that arrives during the step that completes the task notifies the parent once and queues the same task again with both messages in order', async () => {
    // Given: a child whose first step holds on a gate and completes; its next step holds, then waits
    const ownerId = newUser();
    const parentType = uniqueType('int2f-parent');
    const childType = uniqueType('int2f-child');
    const lastStep = createGate();
    const nextStep = createGate();
    const seen: StepView[] = [];
    const harness = await createRuntimeHarness({
      handlers: [
        waitingParent(parentType),
        scriptedHandler({
          type: childType,
          seen,
          steps: [
            { outcome: 'complete', result: { answer: 1 }, gate: lastStep },
            { outcome: 'wait', gate: nextStep },
          ],
        }),
      ],
    });
    try {
      const parentId = await harness.tasks.create({ type: parentType, ownerId, input: {} });
      const childId = await harness.tasks.create({
        type: childType,
        ownerId,
        input: {},
        parentId,
      });
      await lastStep.reached;

      // When: a message without revive and one with revive arrive during the last step
      await harness.inbox.enqueue(note(childId, ownerId, { n: 1 }));
      await harness.inbox.enqueue({ ...note(childId, ownerId, { n: 2 }), revive: true });
      lastStep.open();
      await nextStep.reached;

      // Then: the commit that completed the child queued it again - same task, result cleared
      const events = await eventsOf(childId);
      const completedAt = events.findIndex((event) => event.type === 'task.completed');
      expect(completedAt).toBeGreaterThan(-1);
      expect(
        events.slice(completedAt + 1).find((event) => event.type === 'task.queued')?.payload,
      ).toMatchObject({ cause: 'revive', from: 'completed' });
      expect(await harness.tasks.get(childId, ownerId)).toMatchObject({
        taskId: childId,
        status: 'running',
        stepNo: 1,
        result: null,
      });
      expect((await harness.tasks.listTree(parentId, ownerId)).map((task) => task.taskId)).toEqual(
        [parentId, childId],
      );

      // And: its next step gets both messages in order; the parent was told exactly once
      nextStep.open();
      await waitFor(
        () => statusesOf([childId]),
        (statuses) => statuses.get(childId) === 'waiting',
        'the revived step to commit',
      );
      expect(
        seen[1].messages.map((message) => [message.seq, message.payload, message.revive]),
      ).toEqual([
        [0, { n: 1 }, false],
        [1, { n: 2 }, true],
      ]);
      const notices = await childFinishedOf(parentId);
      expect(notices).toHaveLength(1);
      expect(notices[0].payload).toMatchObject({
        taskId: childId,
        status: 'completed',
        result: { answer: 1 },
        steps: 1,
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Interrupt and stop: the status changes in the command, the step in flight is cut off, the tree is closed
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // DC-6: "Прерывание и остановка меняют статус в пределах команды; итог шага, который шёл в этот момент, не применяется; остановка захватывает всех незаконченных потомков."
  // DC-5 (the stopped half): "Когда задача заканчивается — завершена, упала или остановлена, — в очереди её родителя появляется ровно одно уведомление со статусом и итогом."
  // NFR-01: "Прерывание и остановка меняют статус агента не позже чем через 5 с после команды (p95)." (status in the command's own transaction here; the figure is the verify script)
  // Invariant 1 and 6: "Записать итог шага или охраняемую запись может только текущая попытка задачи." / "Дочерняя задача не создаётся под законченным родителем, а остановка дерева не оставляет в нём незаконченных задач, даже когда ребёнка порождают одновременно с остановкой."
  // Use cases: UC-E2, UC-E3, UC-E9. EARS: When. Design flow: Flow 4, KD-4 (status first, step cut off by fencing).
  //
  // Catches: (1) an interrupted step whose late result is still applied (handler rows, delivery marks, a new status over `waiting`) - the fencing by attempt number; (2) a stop that leaves a grandchild running, a decision `open`, or notifies the parent twice or not
  //   at all; (3) a child spawned in the gap between the stop's tree read and its commit, which then runs under a stopped parent (the race of Invariant 6).
  // Not re-checked here: the cooperative signal reaching the handler over NOTIFY (the handler's abort is observed only to release the gate), interrupting a finished task or one that waits for a decision (a branch of the command, trivial).
  // Behavior: command on instance B -> status changes before the handler on instance A answers -> the late result is refused -> the next step runs with the message and the loss flag; stop closes the tree and its decisions and tells the parent once
  // @category: core-functionality
  // @dependency: createRuntime x2 (TaskControl, Dispatcher, Decisions, Inbox, TokenLedger), test handlers with gates and an abort observer, Postgres NOTIFY
  // @complexity: high
  //
  // Verification items (table-driven):
  // - Row A "interrupt with a message, step in flight on the other instance": a step on instance A holds on a gate after writing a guarded intent row (`guard`) and after `ledger.record` of one call. `interrupt(taskId, ownerId, message)` through instance B returns
  //   `interrupted`. Then, before the gate opens: the task reads `queued` and the message is pending; the handler's signal reason is `interrupted`. The gate opens and the handler returns a result with a `commit` row. Then: that result is refused - the commit row is
  //   absent, `stepNo` is unchanged, the message is not marked delivered by it; the guarded intent row and the ledger row written before the signal remain; the NEXT step's context carries the message and `resumedAfterLoss` true; a `guard` call made by the
  //   cut-off handler after the command returns `fenced` and writes nothing.
  // - Row B "stop of a subtree": parent P with child C (running a held step) and grandchild G (queued); C has an open decision. `stop(C)` returns the stopped ids {C, G}. Then: C and G `stopped`; the decision `cancelled`; P's inbox holds exactly one
  //   `child_finished` for C with status `stopped`; the late result of C's held step is refused; no step of C or G is claimed afterwards (a second runtime pass, workers on); P is not touched - it reads `queued` or `running`, and its next step receives the notification.
  // - Row C "stop against spawn, repeated": a step on instance A spawns a child through `effects.spawn` in its commit while instance B calls `stop` on the parent, and `create({ parentId })` is called against the same parent in parallel; 100 iterations with a fresh
  //   tree each. After each: the tree has no unfinished task; every `create` that lost the race answered `PARENT_FINISHED` and wrote no task; no task exists under a `stopped` parent in a non-final status.
  it('INT-3 A: interrupting a running step with a message changes the status in the command, refuses the late result, keeps intent and ledger rows, and the next step gets the message with the loss flag', async () => {
    // Given: instance A runs one step at a time, so the held step keeps its only slot; instance B
    // only takes commands. The step wrote an intent row through `guard` and recorded a model call.
    const ownerId = newUser();
    const type = uniqueType('int3a');
    const held = createGate();
    const next = createGate();
    const probe: CutOffProbe = { later: [] };
    const harnesses: RuntimeHarness[] = [];
    const handler = cutOffHandler({
      type,
      held,
      next,
      probe,
      // 1000 input + 200 output tokens on model one: 0.002 USD (by hand)
      recordCall: (taskId) =>
        harnesses[0].ledger.record({
          ownerId,
          taskId,
          model: TEST_MODEL_ONE,
          usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
    });
    const message = { kind: 'note', sender: ownerId, payload: { text: 'change course' } };
    try {
      harnesses.push(
        await createRuntimeHarness({ handlers: [handler], config: { concurrency: 1 } }),
      );
      harnesses.push(await createRuntimeHarness({ handlers: [handler], startWorkers: false }));
      const [first, second] = harnesses;
      const taskId = await second.tasks.create({ type, ownerId, input: {} });
      await held.reached;

      // When: instance B interrupts the task with a message
      const answer = await second.tasks.interrupt(taskId, ownerId, message);

      // Then: before the held handler answers, the status changed and the message waits
      expect(answer).toBe('interrupted');
      expect(await second.tasks.get(taskId, ownerId)).toMatchObject({
        status: 'queued',
        waitReason: null,
        stepNo: 0,
      });
      expect(
        (await second.inbox.listPending(taskId, ownerId)).map((pending) => pending.payload),
      ).toEqual([{ text: 'change course' }]);
      const signalReason = await waitFor(
        async (): Promise<unknown> =>
          probe.signal?.aborted === true ? probe.signal.reason : undefined,
        (reason) => reason !== undefined,
        'the held step to get its signal',
      );
      expect(signalReason).toBe('interrupted');

      // When: the cut-off handler answers late, and the next step is claimed
      held.open();
      await next.reached;

      // Then: the late result and the late guard wrote nothing; the intent and ledger rows stay
      expect(probe.intent).toMatchObject({ outcome: 'committed' });
      expect(probe.lateGuard).toEqual({ outcome: 'fenced' });
      const intentRow = {
        taskId,
        stepNo: 0,
        attempt: 1,
        resumedAfterLoss: false,
        note: 'intent',
      };
      expect(await handlerRowsOf([taskId])).toEqual([intentRow]);
      expect(await first.tasks.get(taskId, ownerId)).toMatchObject({
        status: 'running',
        stepNo: 0,
      });
      expect(
        (await inboxOf(taskId)).map((stored) => [stored.seq, stored.status, stored.deliveredStep]),
      ).toEqual([[0, 'pending', null]]);
      expect(
        (await ledgerRowsOf(first, ownerId)).map((row) => [row.taskId, row.model, row.costUsd]),
      ).toEqual([[taskId, TEST_MODEL_ONE, 0.002]]);
      // the next step carries the message and the loss flag
      expect(probe.later).toEqual([
        {
          stepNo: 0,
          resumedAfterLoss: true,
          messages: [{ kind: 'note', sender: ownerId, payload: { text: 'change course' } }],
        },
      ]);

      // And: the next step commits step 0 with the message
      next.open();
      await waitFor(
        () => statusesOf([taskId]),
        (statuses) => statuses.get(taskId) === 'waiting',
        'the next step to commit',
      );
      expect(await handlerRowsOf([taskId])).toEqual([
        intentRow,
        { taskId, stepNo: 0, attempt: 3, resumedAfterLoss: true, note: 'commit' },
      ]);
      expect(
        (await inboxOf(taskId)).map((stored) => [stored.seq, stored.status, stored.deliveredStep]),
      ).toEqual([[0, 'delivered', 0]]);
    } finally {
      held.open();
      next.open();
      await closeAll(harnesses);
    }
  }, TEST_TIMEOUT_MS);

  it('INT-3 B: stopping a child closes it and its grandchild, cancels its decision, tells the parent once, and leaves the parent running', async () => {
    // Given: parent P waits for messages; child C waits for a decision; grandchild G holds a step
    // deaf to its signal on instance A; instance B, workers held, takes the command
    const ownerId = newUser();
    const parentType = uniqueType('int3b-parent');
    const childType = uniqueType('int3b-child');
    const grandchildType = uniqueType('int3b-grandchild');
    const parentNext = createGate();
    const grandchildHeld = createGate();
    const seenByParent: StepView[] = [];
    const handlers = [
      scriptedHandler({
        type: parentType,
        seen: seenByParent,
        steps: [{ outcome: 'wait' }, { outcome: 'wait', gate: parentNext }],
      }),
      scriptedHandler({
        type: childType,
        steps: [{ outcome: 'await_decision', kind: 'approve', payload: { question: 'go on?' } }],
      }),
      scriptedHandler({
        type: grandchildType,
        steps: [{ outcome: 'continue', gate: grandchildHeld, deaf: true }],
      }),
    ];
    const harnesses: RuntimeHarness[] = [];
    try {
      harnesses.push(await createRuntimeHarness({ handlers }));
      harnesses.push(await createRuntimeHarness({ handlers, startWorkers: false }));
      const [first, second] = harnesses;
      const parentId = await first.tasks.create({ type: parentType, ownerId, input: {} });
      const childId = await first.tasks.create({ type: childType, ownerId, input: {}, parentId });
      await waitFor(
        () => first.tasks.listTree(parentId, ownerId),
        (tree) =>
          tree.map((task) => task.waitReason).join() === ['messages', 'decision'].join(),
        'the parent to wait for messages and the child for a decision',
      );
      const grandchildId = await first.tasks.create({
        type: grandchildType,
        ownerId,
        input: {},
        parentId: childId,
      });
      await grandchildHeld.reached;
      const [request] = (await first.decisions.listTree(parentId, ownerId)).filter(
        (d) => d.status === 'open',
      );
      expect(request.taskId).toBe(childId);

      // When: instance B stops the child
      const stoppedIds = await second.tasks.stop(childId, ownerId);

      // Then: child and grandchild stopped, the decision cancelled, the parent told once and woken
      expect(stoppedIds).toEqual([childId, grandchildId]);
      const statuses = await statusesOf([parentId, childId, grandchildId]);
      expect([statuses.get(childId), statuses.get(grandchildId)]).toEqual(['stopped', 'stopped']);
      expect(['queued', 'running']).toContain(statuses.get(parentId));
      expect(await decisionOf(second, request.decisionId)).toEqual({
        status: 'cancelled',
        resolution: null,
        deliveredStep: null,
      });
      const stoppedNotice = {
        taskId: childId,
        status: 'stopped',
        steps: 1,
        durationMs: expect.any(Number),
      };
      expect(
        (await childFinishedOf(parentId)).map((notice) => [notice.sender, notice.payload]),
      ).toEqual([[childId, stoppedNotice]]);

      // When: the grandchild's held step answers late
      grandchildHeld.open();
      await waitFor(
        async () =>
          first.logs.find(
            (record) =>
              record.fields.taskId === grandchildId &&
              record.message === 'step result rejected: the attempt is no longer current',
          ),
        (record) => record !== undefined,
        'the late result of the grandchild to be refused',
      );

      // Then: refused - no row of it, the grandchild still stopped
      expect(await handlerRowsOf([grandchildId])).toEqual([]);
      expect((await statusesOf([grandchildId])).get(grandchildId)).toBe('stopped');

      // And: with workers on both instances, the parent's next step receives the notice and no
      // stopped task is claimed again
      second.start();
      parentNext.open();
      await waitFor(
        () => statusesOf([parentId]),
        (current) => current.get(parentId) === 'waiting' && seenByParent.length === 2,
        'the parent\'s next step to commit',
      );
      expect(
        seenByParent[1].messages.map((seen) => [seen.kind, seen.sender, seen.payload]),
      ).toEqual([['child_finished', childId, stoppedNotice]]);
      const claimsOf = async (taskId: string) =>
        (await eventsOf(taskId)).filter((event) => event.type === 'task.step_started').length;
      expect([await claimsOf(childId), await claimsOf(grandchildId)]).toEqual([1, 1]);
      const after = await statusesOf([childId, grandchildId]);
      expect([after.get(childId), after.get(grandchildId)]).toEqual(['stopped', 'stopped']);
    } finally {
      parentNext.open();
      grandchildHeld.open();
      await closeAll(harnesses);
    }
  }, TEST_TIMEOUT_MS);

  it('INT-3 C: stop racing a spawn and a create never leaves an unfinished task in the tree and answers PARENT_FINISHED to the loser', async () => {
    // Given: a parent type whose step holds on its task's gate and spawns a child in its commit;
    // instance A runs the steps, instance B (workers held) takes the stop and the create
    const ownerId = newUser();
    const parentType = uniqueType('int3c-parent');
    const childType = uniqueType('int3c-child');
    const spawnSteps = createGateBook();
    const spawningParent: TaskHandler = {
      type: parentType,
      inputSchema: anyInput,
      async step(ctx) {
        await spawnSteps.of(ctx.taskId).pass(ctx.signal);
        return {
          outcome: 'wait',
          commit: async (tx, effects) => {
            await effects.spawn({ type: childType, input: {} });
            await writeHandlerRow(ctx, 'spawned')(tx);
          },
        };
      },
    };
    const handlers = [spawningParent, scriptedHandler({ type: childType, steps: [{ outcome: 'wait' }] })];
    const harnesses: RuntimeHarness[] = [];
    try {
      harnesses.push(await createRuntimeHarness({ handlers }));
      harnesses.push(await createRuntimeHarness({ handlers, startWorkers: false }));
      const [first, second] = harnesses;

      for (let iteration = 0; iteration < RACE_ITERATIONS; iteration += 1) {
        const at = `iteration ${iteration}`;
        const parentId = await first.tasks.create({ type: parentType, ownerId, input: {} });
        const gate = spawnSteps.of(parentId);
        await gate.reached;

        // When: the spawning step is let go while B stops the parent and creates a child under it
        gate.open();
        const [stoppedIds, created] = await Promise.all([
          second.tasks.stop(parentId, ownerId),
          answerOf(() =>
            second.tasks.create({ type: childType, ownerId, input: {}, parentId }),
          ),
        ]);

        // Then: every task of the tree is stopped, and by this stop
        const tree = await second.tasks.listTree(parentId, ownerId);
        expect(
          tree.filter((task) => task.status !== 'stopped').map((task) => task.taskId),
          at,
        ).toEqual([]);
        expect(stoppedIds[0], at).toBe(parentId);
        expect([...stoppedIds].sort(), at).toEqual(tree.map((task) => task.taskId).sort());
        // the create either won and its child is in the tree, or lost and wrote nothing
        const spawned = (await handlerRowsOf([parentId])).length;
        const createdId = 'value' in created ? created.value : undefined;
        if (createdId === undefined) {
          expect(created, at).toEqual({ code: 'PARENT_FINISHED' });
        } else {
          expect(tree.map((task) => task.taskId), at).toContain(createdId);
        }
        expect(tree, at).toHaveLength(1 + spawned + (createdId === undefined ? 0 : 1));
      }
    } finally {
      await closeAll(harnesses);
    }
  }, RACE_TIMEOUT_MS);

  // Row D "siblings of one commit": a step spawns five children in one commit, so they share `created_at`.
  // Catches: the tree read ordering siblings of one transaction by the random `task_id` instead of the order they were created in.
  it('INT-3 D: children spawned in one commit come back from listTree in the order they were spawned', async () => {
    // Given: a parent whose first step spawns five children in its commit
    const ownerId = newUser();
    const parentType = uniqueType('int3d-parent');
    const childType = uniqueType('int3d-child');
    const spawnedIds: string[] = [];
    const spawningParent: TaskHandler = {
      type: parentType,
      inputSchema: anyInput,
      async step() {
        return {
          outcome: 'wait',
          commit: async (_tx, effects) => {
            spawnedIds.length = 0; // a retried commit spawns again
            for (let index = 0; index < 5; index += 1) {
              spawnedIds.push(await effects.spawn({ type: childType, input: { index } }));
            }
          },
        };
      },
    };
    const harness = await createRuntimeHarness({
      handlers: [spawningParent, scriptedHandler({ type: childType, steps: [{ outcome: 'wait' }] })],
    });
    try {
      // When: the parent's step commits
      const parentId = await harness.tasks.create({ type: parentType, ownerId, input: {} });
      await waitFor(
        () => statusesOf([parentId]),
        (statuses) => statuses.get(parentId) === 'waiting',
        'the spawning step to commit',
      );

      // Then: the tree lists the parent, then the children in spawn order
      expect(spawnedIds).toHaveLength(5);
      expect((await harness.tasks.listTree(parentId, ownerId)).map((task) => task.taskId)).toEqual([
        parentId,
        ...spawnedIds,
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Isolation: every operation answers a foreign owner as for a missing object
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // DC-8: "Операция с задачей, сообщением или запросом чужого владельца отвечает так же, как для несуществующего."
  // NFR-06 (the part this runtime gives): "Изоляция данных пользователей — как в бизнес-ограничении 2 в `.claude/skills/project-context/SKILL.md`: каждая точка доступа к агентам, сессиям и workflow покрыта e2e-тестом с двумя пользователями."
  // Invariant 7: "Дерево целиком принадлежит одному владельцу."
  // Use case: UC-E5. EARS: If-then. Design flow: Contract Definitions ("Все операции принимают владельца ... и для чужой задачи, сообщения или запроса отвечают так же, как для несуществующих").
  //
  // Catches: one operation of the part that looks the object up by id alone - a foreign owner reads a task, a tree, events or pending messages, puts a message into, interrupts, stops, deletes or resolves another user's object, or creates a child under another
  //   user's parent (a tree with two owners, Invariant 7). The difference between "foreign" and "missing" answers is itself a leak, so each row compares the two answers.
  // Not re-checked here: authentication (the owner id is handed in by `apps/api` from the session; that edge is tested in the api part), the authorization of MCP servers and of the web routes (later parts).
  // Behavior: owner B calls each operation on owner A's task, message or decision -> the answer equals the answer for an id that does not exist -> nothing in A's tree changed
  // @category: core-functionality
  // @dependency: createRuntime (TaskControl, Inbox, Decisions, EventLog), a test handler that opens a decision, Postgres
  // @complexity: medium
  //
  // Verification items (table-driven by operation; A has a tree: a root, a child, a pending message, an open decision, events):
  // - Rows: `tasks.get`, `tasks.listTree`, `tasks.create` with A's task as `parentId`, `tasks.interrupt`, `tasks.stop`, `tasks.deleteTree`, `inbox.enqueue`, `inbox.listPending`, `decisions.resolve`, `decisions.listTree`, `events.listAfter`.
  // - For each row the same call is made with a random well-formed id that exists for nobody (the "missing" reference). Then: the answers are equal in kind and shape - the same error code (`TASK_NOT_FOUND` / `DECISION_NOT_FOUND`), or the same empty list for the list operations; no timing or message difference is asserted.
  // - After all rows: a row-version snapshot of A's tasks, messages, decisions and events equals the snapshot before; A's decision is still `open` and can be resolved by A (`resolved`), and A's tree can still be read in full by A.
  it('INT-4: every runtime operation called as another owner answers exactly as for a missing object and changes none of the owner\'s rows', async () => {
    // Given: owner A's tree - a root waiting for its open decision with a pending message, a child
    // waiting for messages, their events - with the workers paused so that only the calls act
    const ownerA = newUser();
    const ownerB = newUser();
    const rootType = uniqueType('int4-root');
    const childType = uniqueType('int4-child');
    const harness = await createRuntimeHarness({
      handlers: [
        scriptedHandler({
          type: rootType,
          steps: [{ outcome: 'await_decision', kind: 'approve', payload: { question: 'go?' } }],
        }),
        scriptedHandler({ type: childType, steps: [{ outcome: 'wait' }] }),
      ],
    });
    try {
      const rootId = await harness.tasks.create({ type: rootType, ownerId: ownerA, input: {} });
      await waitFor(
        () => harness.tasks.get(rootId, ownerA),
        (task) => task.waitReason === 'decision',
        'the root to wait for a decision',
      );
      const childId = await harness.tasks.create({
        type: childType,
        ownerId: ownerA,
        input: {},
        parentId: rootId,
      });
      await waitFor(
        () => harness.tasks.get(childId, ownerA),
        (task) => task.waitReason === 'messages',
        'the child to wait for messages',
      );
      await harness.inbox.enqueue(note(rootId, ownerA, { n: 1 }));
      await harness.stop();
      const [request] = (await harness.decisions.listTree(rootId, ownerA)).filter(
        (d) => d.status === 'open',
      );
      expect(request.taskId).toBe(rootId);
      expect(await harness.inbox.listPending(rootId, ownerA)).toHaveLength(1);
      expect(await harness.events.listAfter(rootId, ownerA, 0, 500)).not.toEqual([]);
      const before = await rowVersionsOf(rootId);
      expect(new Set(before.map((row) => row.table))).toEqual(
        new Set(['tasks', 'inbox', 'decisions', 'events']),
      );
      const missingId = randomUUID();
      const notFound = { code: 'TASK_NOT_FOUND' };
      const none = { value: [] };

      // When: owner B calls every operation on A's objects, and on an id that exists for nobody
      const operations: [string, string, (id: string) => Promise<unknown>, Answer][] = [
        ['tasks.get', childId, (id) => harness.tasks.get(id, ownerB), notFound],
        ['tasks.listTree', rootId, (id) => harness.tasks.listTree(id, ownerB), none],
        [
          'tasks.create under the task',
          rootId,
          (id) => harness.tasks.create({ type: childType, ownerId: ownerB, input: {}, parentId: id }),
          notFound,
        ],
        [
          'tasks.interrupt',
          childId,
          (id) =>
            harness.tasks.interrupt(id, ownerB, { kind: 'note', sender: ownerB, payload: {} }),
          notFound,
        ],
        ['tasks.stop', childId, (id) => harness.tasks.stop(id, ownerB), notFound],
        ['tasks.deleteTree', rootId, (id) => harness.tasks.deleteTree(id, ownerB), notFound],
        ['inbox.enqueue', rootId, (id) => harness.inbox.enqueue(note(id, ownerB, { n: 2 })), notFound],
        ['inbox.listPending', rootId, (id) => harness.inbox.listPending(id, ownerB), none],
        [
          'decisions.resolve',
          request.decisionId,
          (id) => harness.decisions.resolve(id, ownerB, { approved: false }),
          { code: 'DECISION_NOT_FOUND' },
        ],
        ['decisions.listTree', rootId, (id) => harness.decisions.listTree(id, ownerB), none],
        ['events.listAfter', rootId, (id) => harness.events.listAfter(id, ownerB, 0, 500), none],
      ];

      // Then: each answer for A's object equals the answer for the missing one
      for (const [operation, ownedId, call, expected] of operations) {
        const foreign = await answerOf(() => call(ownedId));
        const missing = await answerOf(() => call(missingId));
        expect({ operation, foreign, missing }).toEqual({
          operation,
          foreign: expected,
          missing: expected,
        });
      }

      // And: no row of A's tree changed; A still reads the whole tree and resolves the decision
      expect(await rowVersionsOf(rootId)).toEqual(before);
      expect((await harness.tasks.listTree(rootId, ownerA)).map((task) => task.taskId)).toEqual([
        rootId,
        childId,
      ]);
      expect(await harness.decisions.resolve(request.decisionId, ownerA, { approved: true })).toBe(
        'resolved',
      );
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  The token ledger: cost by the model's price, the owner's month in UTC, rows that outlive the tree
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-02.1: "Given агент вызвал модель, when вызов закончился, then в журнале есть запись: сессия, агент, модель, входные и выходные токены, стоимость в долларах." (the task is the session; the agent's name is the `agents` part's)
  // AC-02.2: "Given у сотрудника есть агенты на разных моделях, when их вызовы записаны, then стоимость каждого вызова посчитана по цене его модели, а расход сотрудника за месяц равен сумме этих стоимостей."
  // DC-9: "Запись вызова с моделью, для которой нет цены, отвергается, и ничего не записывается."
  // DC-10: "Расход месяца — сумма стоимостей строк сотрудника с началом вызова в этом календарном месяце по UTC, и он не меняется, когда дерево задач удаляют."
  // Invariant 8: "Каждый вызов модели, о котором верхний слой сообщил `record`, — одна строка журнала со стоимостью; строки не меняются и не удаляются вместе с задачами."
  // Use cases: UC-8, UC-E6, UC-E7. EARS: When / If-then. Design flow: Flow 5, KD-5.
  //
  // Catches: (1) a cost taken from the wrong model's price, or a row without owner, task or tokens; (2) a month sum that includes the previous month's last second, drops the 1st 00:00:00 UTC instant, adds another owner's rows or double-counts; (3) `deleteTree` taking the
  //   ledger rows with the tree (a foreign key with cascade), so deleting a conversation lowers the month's spend; (4) a row written for a model with no price.
  // Not re-checked here: the cost rule's variants (tier, cache read and write) - the unit table proves the rule; one literal price per model proves it is wired.
  // Behavior: calls recorded on two priced models for two owners across a month boundary -> rows and costs per model price -> `monthSpend` is the owner's sum for the UTC month -> the sum survives `deleteTree`; an unpriced model leaves no row
  // @category: core-functionality
  // @dependency: createRuntime (TokenLedger, TaskControl), the injected Clock, a test price table of two models with different input and output prices, Postgres
  // @complexity: medium
  //
  // Verification items (table-driven by step; costs are hardcoded literals computed by hand from the test price table, not by the rule):
  // - Row A "rows and costs": owner A records calls with a task id on model M1 and on model M2 (different input and output prices), each at a Clock instant in November 2026. Then: each returned `costUsd` equals the literal for its model; each row holds the owner,
  //   the task id, the model, the four token counts, the cost and the time; `callId`s are distinct.
  // - Row B "the month window": A also has calls at 2026-10-31T23:59:59Z, 2026-11-01T00:00:00Z, 2026-11-30T23:59:59Z and 2026-12-01T00:00:00Z; owner B has November calls. Then: `monthSpend(A, '2026-11')` equals the literal sum of A's calls from 2026-11-01T00:00:00Z
  //   through 2026-11-30T23:59:59Z, and its call count equals their number; October, December and B's rows are not in it; `monthSpend(A, '2026-09')` is `{ costUsd: 0, calls: 0 }`.
  // - Row C "unknown price": `record` for a model absent from the price table rejects with `UNKNOWN_MODEL_PRICE`; the ledger has no new row (row count before equals after); the in-memory log has an error entry naming the model; `pricedModels()` lists exactly the table's models.
  // - Row D "tree deletion": A's calls were recorded with the ids of tasks of one tree. `deleteTree(root)` returns `deleted`. Then: the tree's tasks, messages, decisions and events are gone; the ledger rows still exist with their task ids; `monthSpend(A, '2026-11')` is unchanged.
  it('INT-5 A: a recorded call stores owner, task, model, tokens and a cost taken from its own model\'s price', async () => {
    // Given: a task of owner A and a clock in November 2026
    const ownerId = newUser();
    const type = uniqueType('int5a');
    const calledAt = new Date('2026-11-14T10:00:00Z');
    const harness = await createRuntimeHarness({
      handlers: [scriptedHandler({ type, steps: [{ outcome: 'wait' }] })],
      clock: settableClock(calledAt),
      startWorkers: false,
    });
    try {
      const taskId = await harness.tasks.create({ type, ownerId, input: {} });
      const usage = {
        inputTokens: 1200,
        outputTokens: 200,
        cacheReadTokens: 100,
        cacheWriteTokens: 100,
      };

      // When: one call is recorded on each model
      const one = await harness.ledger.record({ ownerId, taskId, model: TEST_MODEL_ONE, usage });
      const two = await harness.ledger.record({ ownerId, taskId, model: TEST_MODEL_TWO, usage });

      // Then: each cost is its own model's price (by hand: 1000*1 + 100*1.25 + 100*0.125 +
      // 200*5 = 2137.5 micro-USD; 1000*3 + 100*3.75 + 100*0.375 + 200*15 = 6412.5 micro-USD)
      expect(one.costUsd).toBe(0.0021375);
      expect(two.costUsd).toBe(0.0064125);
      expect(one.callId).not.toBe(two.callId);
      const rows = await ledgerRowsOf(harness, ownerId);
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            callId: one.callId,
            ownerId,
            taskId,
            model: TEST_MODEL_ONE,
            inputTokens: 1200,
            outputTokens: 200,
            cacheReadTokens: 100,
            cacheWriteTokens: 100,
            costUsd: 0.0021375,
            calledAt,
          },
          {
            callId: two.callId,
            ownerId,
            taskId,
            model: TEST_MODEL_TWO,
            inputTokens: 1200,
            outputTokens: 200,
            cacheReadTokens: 100,
            cacheWriteTokens: 100,
            costUsd: 0.0064125,
            calledAt,
          },
        ]),
      );
      expect(rows).toHaveLength(2);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-5 B: the month spend is the owner\'s own sum for the UTC month, excluding the boundary seconds on either side and other owners', async () => {
    // Given: owner A's calls on both sides of November's edges, owner B's call in November
    const ownerA = newUser();
    const ownerB = newUser();
    const clock = settableClock(new Date('2026-11-01T00:00:00Z'));
    const harness = await createRuntimeHarness({ handlers: [], clock, startWorkers: false });
    // 1000 input + 200 output tokens: 0.002 USD on model one, 0.006 USD on model two (by hand)
    const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const calls: { ownerId: string; model: string; at: string }[] = [
      { ownerId: ownerA, model: TEST_MODEL_ONE, at: '2026-10-31T23:59:59Z' },
      { ownerId: ownerA, model: TEST_MODEL_ONE, at: '2026-11-01T00:00:00Z' },
      { ownerId: ownerA, model: TEST_MODEL_TWO, at: '2026-11-30T23:59:59Z' },
      { ownerId: ownerA, model: TEST_MODEL_TWO, at: '2026-12-01T00:00:00Z' },
      { ownerId: ownerB, model: TEST_MODEL_TWO, at: '2026-11-15T12:00:00Z' },
    ];
    try {
      for (const call of calls) {
        clock.set(new Date(call.at));
        await harness.ledger.record({ ownerId: call.ownerId, model: call.model, usage });
      }

      // When / Then: each month holds exactly the owner's calls inside it, by UTC
      expect(await harness.ledger.monthSpend(ownerA, '2026-11')).toEqual({
        costUsd: 0.008,
        calls: 2,
      });
      expect(await harness.ledger.monthSpend(ownerA, '2026-10')).toEqual({
        costUsd: 0.002,
        calls: 1,
      });
      expect(await harness.ledger.monthSpend(ownerA, '2026-12')).toEqual({
        costUsd: 0.006,
        calls: 1,
      });
      expect(await harness.ledger.monthSpend(ownerB, '2026-11')).toEqual({
        costUsd: 0.006,
        calls: 1,
      });
      expect(await harness.ledger.monthSpend(ownerA, '2026-09')).toEqual({
        costUsd: 0,
        calls: 0,
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-5 C: a call for a model with no price is rejected with UNKNOWN_MODEL_PRICE and leaves no row', async () => {
    // Given: the test price table of two models
    const ownerId = newUser();
    const unknownModel = 'test/model-without-price';
    const harness = await createRuntimeHarness({ handlers: [], startWorkers: false });
    try {
      const before = await ledgerRowsOf(harness, ownerId);

      // When: a call on a model outside the table is recorded
      const recording = harness.ledger.record({
        ownerId,
        model: unknownModel,
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      });

      // Then: rejected, no row, an error naming the model, and the table's models listed
      await expect(recording).rejects.toMatchObject({ code: 'UNKNOWN_MODEL_PRICE' });
      expect(before).toEqual([]);
      expect(await ledgerRowsOf(harness, ownerId)).toEqual([]);
      expect(
        harness.logs.filter(
          (record) => record.level === 'error' && record.fields.model === unknownModel,
        ),
      ).toHaveLength(1);
      expect(harness.ledger.pricedModels()).toEqual([TEST_MODEL_ONE, TEST_MODEL_TWO]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
  it('INT-5 D: deleting the task tree removes the tree but leaves the ledger rows and the month spend unchanged', async () => {
    // Given: owner A's tree - a root waiting for a decision with a pending message, a child - and a
    // call recorded for each task in November 2026
    const ownerId = newUser();
    const rootType = uniqueType('int5d-root');
    const childType = uniqueType('int5d-child');
    const harness = await createRuntimeHarness({
      handlers: [
        scriptedHandler({
          type: rootType,
          steps: [{ outcome: 'await_decision', kind: 'approve', payload: { question: 'go?' } }],
        }),
        scriptedHandler({ type: childType, steps: [{ outcome: 'wait' }] }),
      ],
      clock: settableClock(new Date('2026-11-14T10:00:00Z')),
    });
    try {
      const rootId = await harness.tasks.create({ type: rootType, ownerId, input: {} });
      await waitFor(
        () => harness.tasks.get(rootId, ownerId),
        (task) => task.waitReason === 'decision',
        'the root to wait for a decision',
      );
      const childId = await harness.tasks.create({
        type: childType,
        ownerId,
        input: {},
        parentId: rootId,
      });
      await waitFor(
        () => harness.tasks.get(childId, ownerId),
        (task) => task.waitReason === 'messages',
        'the child to wait for messages',
      );
      await harness.inbox.enqueue(note(rootId, ownerId, { n: 1 }));
      const [request] = (await harness.decisions.listTree(rootId, ownerId)).filter(
        (d) => d.status === 'open',
      );
      // 1000 input + 200 output tokens: 0.002 USD on model one, 0.006 USD on model two (by hand)
      const usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 };
      await harness.ledger.record({ ownerId, taskId: rootId, model: TEST_MODEL_ONE, usage });
      await harness.ledger.record({ ownerId, taskId: childId, model: TEST_MODEL_TWO, usage });
      expect(await harness.ledger.monthSpend(ownerId, '2026-11')).toEqual({
        costUsd: 0.008,
        calls: 2,
      });

      // When: the tree is deleted
      const answer = await harness.tasks.deleteTree(rootId, ownerId);

      // Then: the tree's tasks, messages, decision and events are gone
      expect(answer).toBe('deleted');
      expect([...(await statusesOf([rootId, childId]))]).toEqual([]);
      expect([...(await inboxOf(rootId)), ...(await inboxOf(childId))]).toEqual([]);
      expect([...(await eventsOf(rootId)), ...(await eventsOf(childId))]).toEqual([]);
      expect(await decisionOf(harness, request.decisionId)).toBeUndefined();
      await expect(harness.tasks.get(rootId, ownerId)).rejects.toMatchObject({
        code: 'TASK_NOT_FOUND',
      });

      // And: the ledger rows stay with their task ids, and the month spend is unchanged
      const rows = await ledgerRowsOf(harness, ownerId);
      expect(rows.map((row) => [row.taskId, row.model, row.costUsd])).toEqual(
        expect.arrayContaining([
          [rootId, TEST_MODEL_ONE, 0.002],
          [childId, TEST_MODEL_TWO, 0.006],
        ]),
      );
      expect(rows).toHaveLength(2);
      expect(await harness.ledger.monthSpend(ownerId, '2026-11')).toEqual({
        costUsd: 0.008,
        calls: 2,
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
