// runtime-fixes / steps - runtime integration skeleton (`RuntimeModule` over real Postgres, test handlers; no agents)
// Design Doc: docs/features/runtime-fixes/design-steps.md (v1.2), KD-1, "Contract Definitions" (Крючок прерывания)
// PRD: docs/features/runtime-fixes/prd.md FR-01 (AC-01.1, AC-01.7)
// Generated: 2026-11-28 | Part: steps | Test type: Integration (the fourth integration test of the part; the other three are in packages/agents/test/runtime-fixes-steps.int.e2e-spec.ts, which names why a fourth is allowed)
// Implementation timing: written alongside the interrupt hook registry in `TaskControl`; run once at the end of the part.
// Run with `pnpm --filter @agent-os/runtime test:e2e`, DATABASE_URL on a test database only. Harness: support/runtimeHarness.ts (a test registers its own hook before the interrupt, as
// data-model-runtime.int.e2e-spec.ts UC-4 does for end hooks).
//
// Proven elsewhere: the end-hook registry (once per end, a throwing hook rolls back only its writes) - data-model-runtime.int.e2e-spec.ts UC-4; the fence and the order of writes of an
// interrupt - agent-platform-runtime.int.e2e-spec.ts. The partial answer itself (the agents hook) - packages/agents INT-1.
//
// acProof: AC-01.1 (the engine half: the hook runs in the interrupt transaction after the fence): this test; AC-01.7 (the engine half: no hook call without the transaction): packages/agents INT-2.

import type { Db } from '@agent-os/db';
import { newUser, waitFor } from '@agent-os/db/testing';
import type {
  StepContext,
  StepResult,
  TaskHandler,
  TaskInterruptHookInput,
} from '@agent-os/runtime';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { closeRuntimeDb, handlerRowsOf } from './support/runtimeDb';
import {
  createRuntimeHarness,
  type RuntimeHarness,
} from './support/runtimeHarness';
import {
  createGateBook,
  DEAF_SIGNAL,
  HANDLER_ROWS_TABLE,
  uniqueType,
  writeHandlerRow,
} from './support/testHandlers';

const TEST_TIMEOUT_MS = 120_000;

/** The kind of the interrupt message the tests send. */
const INTERRUPT_KIND = 'test.interrupt';

/** The note of the row the hook writes in the interrupt's transaction. */
const HOOK_NOTE = 'interrupt-hook';

/** The note of the row a fenced step would write with its late result. */
const LATE_NOTE = 'late-step';

/** The task row and its interrupt messages as the transaction open where it is read sees them. */
interface TaskSeen {
  readonly attempt: number;
  readonly status: string;
  readonly interruptMessages: number;
}

async function taskSeen(db: Db, taskId: string): Promise<TaskSeen> {
  const { rows } = await db.client.execute<{
    attempt: number;
    status: string;
    interruptMessages: number;
  }>(sql`
    SELECT t.attempt, t.status,
           (SELECT count(*)::int FROM app.runtime_inbox i
             WHERE i.recipient_id = t.task_id AND i.kind = ${INTERRUPT_KIND}) AS "interruptMessages"
      FROM app.runtime_tasks t WHERE t.task_id = ${taskId}`);
  const [row] = rows;
  if (row === undefined) throw new Error(`task ${taskId} has no row`);
  return row;
}

/** Writes the hook's row in the transaction open where it is called. */
async function writeHookRow(db: Db, taskId: string): Promise<void> {
  await db.client.execute(sql`
    INSERT INTO ${sql.raw(HANDLER_ROWS_TABLE)} (task_id, step_no, attempt, resumed_after_loss, note)
    VALUES (${taskId}, 0, 0, false, ${HOOK_NOTE})`);
}

/**
 * A task whose first step holds at its gate deaf to its signal and then tries to complete with a row; a step
 * that got the interrupt message waits.
 */
function heldTaskHandler(
  type: string,
  gates: ReturnType<typeof createGateBook>,
): TaskHandler {
  return {
    type,
    inputSchema: z.record(z.string(), z.unknown()),
    async step(ctx: StepContext): Promise<StepResult> {
      if (ctx.messages.some((message) => message.kind === INTERRUPT_KIND))
        return { outcome: 'wait' };
      await gates.of(ctx.taskId).pass(DEAF_SIGNAL);
      return {
        outcome: 'complete',
        result: { late: true },
        commit: writeHandlerRow(ctx, LATE_NOTE),
      };
    },
  };
}

/** Starts a held task and returns it with its attempt before the interrupt. */
async function heldTask(
  harness: RuntimeHarness,
  type: string,
  ownerId: string,
  gates: ReturnType<typeof createGateBook>,
): Promise<{ taskId: string; attemptBefore: number }> {
  const taskId = await harness.tasks.create({ type, ownerId, input: {} });
  await gates.of(taskId).reached;
  return {
    taskId,
    attemptBefore: (await taskSeen(harness.runtimeDb, taskId)).attempt,
  };
}

describe('runtime-fixes / steps - the interrupt hook of the runtime', () => {
  afterAll(closeRuntimeDb);

  // INT-4  The interrupt hook runs in the interrupt transaction after the fence, and a throwing hook does not stop the interrupt
  // AC-01.1: "Given модель написала половину ответа, when сотрудник жмёт «Прервать», then в ленте стоит этот текст обычным ответом агента, под ним строка «прервано»" (engine half: the hook's write is in the interrupt's own commit)
  // Behavior: a test hook registered by name is called by `TaskControl.interrupt` with `taskId`, `rootId`, `ownerId`, task type, after the task's `attempt` was raised -> its write is committed
  //   together with the interrupt; a second registration under another name is refused at start; a hook that throws is logged and its own writes roll back, the interrupt still commits.
  // Rows: A "ordering": the hook reads the task row inside its call: `attempt` already raised, status already `queued` with the interrupt message in the queue as the same transaction sees it;
  //   the hook's write is visible after the command, never partially (a step held at the time cannot commit its own write after: it is rejected by the fence).
  //   B "throwing hook": the hook writes a row, then throws -> the row is absent, the task is interrupted and queued, one warn record names the hook and the task id.
  //   C "one handler": a second registration under another name rejects the module start (the design allows exactly one handler).
  // Catches: a hook called before the fence (a step that could still commit its full answer then also commits next to the partial one - the duplicate of KD-1), called outside the interrupt
  //   transaction (partial text committed while the interrupt fails), and a throwing hook that blocks or rolls back the interrupt itself (the employee cannot interrupt). The agents layer cannot
  //   see these: it registers a working hook.
  // @category: core-functionality
  // @dependency: TaskControl.interrupt, interrupt hook registry, Tasks.hold (fence), logger, Postgres
  // @complexity: medium
  it(
    'INT-4: the interrupt hook runs after the fence in the interrupt transaction; a hook that throws rolls back only its writes and the interrupt commits; a second handler is refused',
    async () => {
      const ownerId = await newUser();

      // Row A - Given: a hook that reads the task row in its call and writes its own row; a task held in its step
      const orderingType = uniqueType('int4-ordering');
      const orderingGates = createGateBook();
      const ordering = await createRuntimeHarness({
        handlers: [heldTaskHandler(orderingType, orderingGates)],
      });
      const hookName = `test.int4-hook-${orderingType}`;
      const calls: { input: TaskInterruptHookInput; seen: TaskSeen }[] = [];
      ordering.interruptHooks.register(hookName, async (input) => {
        calls.push({
          input,
          seen: await taskSeen(ordering.runtimeDb, input.taskId),
        });
        await writeHookRow(ordering.runtimeDb, input.taskId);
      });
      let orderingTaskId: string | undefined;
      try {
        const { taskId, attemptBefore } = await heldTask(
          ordering,
          orderingType,
          ownerId,
          orderingGates,
        );
        orderingTaskId = taskId;

        // When: the task is interrupted
        await expect(
          ordering.tasks.interrupt(taskId, ownerId, {
            kind: INTERRUPT_KIND,
            payload: { by: 'test' },
          }),
        ).resolves.toBe('interrupted');

        // Then: the hook was called once with the task, inside the transaction after the fence and the message
        expect(calls).toEqual([
          {
            input: { taskId, rootId: taskId, ownerId, type: orderingType },
            seen: {
              attempt: attemptBefore + 1,
              status: 'queued',
              interruptMessages: 1,
            },
          },
        ]);
        // Then: its row is committed with the interrupt
        expect((await handlerRowsOf([taskId])).map((row) => row.note)).toEqual([
          HOOK_NOTE,
        ]);

        // When: the held step answers late; Then: the fence rejects it, and only the hook's row is there
        orderingGates.of(taskId).open();
        await waitFor(
          async () =>
            ordering.logs.filter(
              (record) =>
                record.message ===
                  'step result rejected: the attempt is no longer current' &&
                record.fields.taskId === taskId,
            ),
          (records) => records.length === 1,
          'the late step result to be rejected',
        );
        expect((await handlerRowsOf([taskId])).map((row) => row.note)).toEqual([
          HOOK_NOTE,
        ]);

        // Row C - When: a second hook is registered under another name; Then: it is refused, the first stays
        expect(() =>
          ordering.interruptHooks.register(
            `${hookName}-second`,
            async () => {},
          ),
        ).toThrow(/already registered/);
        expect(ordering.interruptHooks.current()?.name).toBe(hookName);
      } finally {
        if (orderingTaskId !== undefined)
          orderingGates.of(orderingTaskId).open();
        await ordering.close();
      }

      // Row B - Given: a hook that writes its row and then throws; a task held in its step
      const throwingType = uniqueType('int4-throwing');
      const throwingGates = createGateBook();
      const throwing = await createRuntimeHarness({
        handlers: [heldTaskHandler(throwingType, throwingGates)],
      });
      const throwingName = `test.int4-throwing-${throwingType}`;
      throwing.interruptHooks.register(throwingName, async (input) => {
        await writeHookRow(throwing.runtimeDb, input.taskId);
        throw new Error('the interrupt hook broke');
      });
      let throwingTaskId: string | undefined;
      try {
        const { taskId, attemptBefore } = await heldTask(
          throwing,
          throwingType,
          ownerId,
          throwingGates,
        );
        throwingTaskId = taskId;

        // When: the task is interrupted
        await expect(
          throwing.tasks.interrupt(taskId, ownerId, {
            kind: INTERRUPT_KIND,
            payload: { by: 'test' },
          }),
        ).resolves.toBe('interrupted');

        // Then: the interrupt committed (attempt raised, message queued), the hook's row rolled back
        const seen = await taskSeen(throwing.runtimeDb, taskId);
        expect(seen.attempt).toBe(attemptBefore + 1);
        expect(seen.interruptMessages).toBe(1);
        expect(await handlerRowsOf([taskId])).toEqual([]);
        // Then: one warn record names the hook and the task
        expect(
          throwing.logs
            .filter(
              (record) =>
                record.message ===
                'task interrupt hook failed; its writes rolled back',
            )
            .map((record) => ({
              level: record.level,
              hook: record.fields.hook,
              taskId: record.fields.taskId,
            })),
        ).toEqual([{ level: 'warn', hook: throwingName, taskId }]);
      } finally {
        if (throwingTaskId !== undefined)
          throwingGates.of(throwingTaskId).open();
        await throwing.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
