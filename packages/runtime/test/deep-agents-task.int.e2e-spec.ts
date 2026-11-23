// data-model / runtime integration - Design Doc: docs/features/data-model/design-runtime.md (KD-2, «Правило пробуждения»,
// «Состояния задачи», «Логи вместо событий»; Test Strategy UC-1). Test type: Integration (in-process runtime + real Postgres).
// Harness and isolation as in agent-platform-runtime.int.e2e-spec.ts: a unique owner and unique task types per test, no truncate.
//
// UC-1 → DC-34, DC-35, DC-36, DC-37, DC-41:
//   run 1 — three awaited children; the first ends `completed` alone, then the second and the third at once: the parent is
//     queued once, after the last of them, and its step gets the three `child_finished`;
//   run 2 — the second child fails at once with the end of the first, the employee writes to the waiting parent: the parent is
//     woken once, right after the failure, without a repeated transaction, the note comes in the same step, the rows of the
//     children are not written by the wake-up; the woken parent creates a new group while the third child of the old one
//     runs, and the end of that third child does not wake it; the log holds the children created, the wait and the delivery.

import { CHILD_FINISHED_KIND } from '@agent-os/contracts';
import type { LogRecord } from '@agent-os/common';
import { newUser, waitFor } from '@agent-os/db/testing';
import type { StepResult, TaskHandler } from '@agent-os/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  childRowsOf,
  closeRuntimeDb,
  inboxOf,
  statusesOf,
} from './support/runtimeDb';
import {
  createRuntimeHarness,
  type RuntimeHarness,
} from './support/runtimeHarness';
import {
  awaitingParentHandler,
  createGateBook,
  type GateBook,
  type StepView,
  uniqueType,
} from './support/testHandlers';

const TEST_TIMEOUT_MS = 60_000;

/** An employee's note to the waiting parent. */
const NOTE = { text: 'and add the prices' };

/** The failure of the child that fails. */
const FAILURE = { reason: 'model_error', message: 'provider answered 500' };

/** Log records of a repeated transaction: the engine's deadlock retry and the step commit's own. */
const RETRY_MESSAGES = new Set([
  'engine transaction deadlocked; repeating it',
  'step commit transaction failed',
]);

const ChildInputSchema = z.object({
  item: z.number().int(),
  fail: z.boolean().optional(),
});

/** An awaited child: holds at its own gate, then completes with its item or fails with {@link FAILURE}. */
function childHandler(type: string, gates: GateBook): TaskHandler {
  return {
    type,
    inputSchema: ChildInputSchema,
    async step(ctx): Promise<StepResult> {
      const { item, fail } = ChildInputSchema.parse(ctx.input);
      await gates.of(ctx.taskId).pass(ctx.signal);
      return fail
        ? { outcome: 'fail', ...FAILURE }
        : { outcome: 'complete', result: { item } };
    },
  };
}

const wokenSteps = (seen: readonly StepView[]) =>
  seen.filter((view) => view.stepNo > 0);

const recordsOf = (harness: RuntimeHarness, message: string): LogRecord[] =>
  harness.logs.filter((record) => record.message === message);

async function parentState(
  harness: RuntimeHarness,
  parentId: string,
  ownerId: string,
) {
  const task = await harness.tasks.get(parentId, ownerId);
  return { status: task.status, waitReason: task.waitReason };
}

describe('data-model / runtime - UC-1 awaited children (in-process runtime + real Postgres)', () => {
  afterAll(closeRuntimeDb);

  it(
    'UC-1 run 1: one of three awaited children ends, then the other two at once: the parent is queued once, after both, and its step gets three child_finished',
    async () => {
      const parentType = uniqueType('uc1a-parent');
      const childType = uniqueType('uc1a-child');
      const gates = createGateBook();
      const seen: StepView[] = [];
      const spawned = new Map<number, string[]>();
      const harness = await createRuntimeHarness({
        config: { concurrency: 4, dbPoolMax: 6 },
        handlers: [
          awaitingParentHandler({
            type: parentType,
            groups: [
              [0, 1, 2].map((item) => ({ type: childType, input: { item } })),
            ],
            seen,
            spawned,
          }),
          childHandler(childType, gates),
        ],
      });
      try {
        const ownerId = await newUser();
        const parentId = await harness.tasks.create({
          type: parentType,
          ownerId,
          input: {},
        });
        const [first, second, third] = await waitFor(
          async () => spawned.get(0) ?? [],
          (ids) => ids.length === 3,
          'the awaited children',
        );
        await Promise.all(
          [first, second, third].map((id) => gates.of(id).reached),
        );
        expect(await parentState(harness, parentId, ownerId)).toEqual({
          status: 'waiting',
          waitReason: 'children',
        });
        // Each child carries the parent's `step_no` after the commit that created it.
        expect(
          (await childRowsOf(parentId)).map((row) => row.awaitedStep),
        ).toEqual([1, 1, 1]);

        gates.of(first).open();
        await waitFor(
          () => statusesOf([first]),
          (statuses) => statuses.get(first) === 'completed',
          'the first child to complete',
        );
        // A `completed` end while two awaited children run: nothing wakes the parent.
        expect(await parentState(harness, parentId, ownerId)).toEqual({
          status: 'waiting',
          waitReason: 'children',
        });
        expect(wokenSteps(seen)).toEqual([]);

        // The last two end at once: each counts the other after taking the parent's row, so exactly one wakes it.
        gates.of(second).open();
        gates.of(third).open();
        await waitFor(
          () => parentState(harness, parentId, ownerId),
          (state) =>
            state.status === 'waiting' && state.waitReason === 'messages',
          'the woken parent to commit its step',
        );
        const woken = wokenSteps(seen);
        expect(woken).toHaveLength(1);
        expect(woken[0].messages.map((message) => message.kind)).toEqual([
          CHILD_FINISHED_KIND,
          CHILD_FINISHED_KIND,
          CHILD_FINISHED_KIND,
        ]);
        expect(
          woken[0].messages.map(
            (message) => (message.payload as { taskId: string }).taskId,
          ),
        ).toEqual(expect.arrayContaining([first, second, third]));
        // The payload by the contract: no step count, the result of a completed child.
        expect(
          woken[0].messages.find(
            (message) =>
              (message.payload as { taskId: string }).taskId === third,
          )?.payload,
        ).toEqual({
          taskId: third,
          status: 'completed',
          result: { item: 2 },
          durationMs: expect.any(Number),
        });
        expect(
          harness.logs.filter((record) => RETRY_MESSAGES.has(record.message)),
        ).toEqual([]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'UC-1 run 2: a child fails at once with the end of another: one wake-up right after the failure with the note, no child row written by it, no repeated transaction; the old group no longer wakes the parent that waits for a new one',
    async () => {
      const parentType = uniqueType('uc1b-parent');
      const childType = uniqueType('uc1b-child');
      const gates = createGateBook();
      const seen: StepView[] = [];
      const spawned = new Map<number, string[]>();
      const harness = await createRuntimeHarness({
        config: { concurrency: 5, dbPoolMax: 7 },
        handlers: [
          awaitingParentHandler({
            type: parentType,
            groups: [
              [
                { type: childType, input: { item: 0 } },
                { type: childType, input: { item: 1, fail: true } },
                { type: childType, input: { item: 2 } },
              ],
              [{ type: childType, input: { item: 3 } }],
            ],
            seen,
            spawned,
          }),
          childHandler(childType, gates),
        ],
      });
      try {
        const ownerId = await newUser();
        const parentId = await harness.tasks.create({
          type: parentType,
          ownerId,
          input: {},
        });
        const [first, failing, third] = await waitFor(
          async () => spawned.get(0) ?? [],
          (ids) => ids.length === 3,
          'the awaited children',
        );
        await Promise.all(
          [first, failing, third].map((id) => gates.of(id).reached),
        );

        // DC-37: the employee's message to a parent waiting for its children waits in the queue.
        const note = await harness.inbox.enqueue({
          recipientId: parentId,
          ownerId,
          kind: 'note',
          payload: NOTE,
        });
        expect(await parentState(harness, parentId, ownerId)).toEqual({
          status: 'waiting',
          waitReason: 'children',
        });
        const thirdBefore = (await childRowsOf(parentId)).find(
          (row) => row.taskId === third,
        );

        gates.of(first).open();
        gates.of(failing).open();
        const [woken] = await waitFor(
          async () => wokenSteps(seen),
          (views) => views.length > 0,
          'the parent to be woken',
        );
        // The woken step creates the new group and waits for it.
        const [newChild] = await waitFor(
          async () => spawned.get(1) ?? [],
          (ids) => ids.length === 1,
          'the new group',
        );
        await gates.of(newChild).reached;
        expect(await parentState(harness, parentId, ownerId)).toEqual({
          status: 'waiting',
          waitReason: 'children',
        });

        // The step got the note and the failure with its reason and text.
        expect(woken.messages.map((message) => message.kind)).toContain('note');
        expect(
          woken.messages.find(
            (message) =>
              message.kind === CHILD_FINISHED_KIND &&
              (message.payload as { taskId: string }).taskId === failing,
          )?.payload,
        ).toEqual({
          taskId: failing,
          status: 'failed',
          failure: FAILURE,
          durationMs: expect.any(Number),
        });
        // The wake-up wrote no child row: the third child, still running, is the row it was.
        const rows = await childRowsOf(parentId);
        expect(rows.find((row) => row.taskId === third)).toEqual(thirdBefore);
        expect(rows.map((row) => row.awaitedStep)).toEqual([1, 1, 1, 2]);

        // DC-36: the end of the old group's third child does not wake the parent waiting for the new one.
        gates.of(third).open();
        await waitFor(
          async () =>
            (await inboxOf(parentId)).filter(
              (message) =>
                message.kind === CHILD_FINISHED_KIND &&
                (message.payload as { taskId: string }).taskId === third,
            ),
          (notices) => notices.length === 1,
          "the third child's child_finished",
        );
        expect(await parentState(harness, parentId, ownerId)).toEqual({
          status: 'waiting',
          waitReason: 'children',
        });
        expect(wokenSteps(seen)).toHaveLength(1);
        expect(
          harness.logs.filter((record) => RETRY_MESSAGES.has(record.message)),
        ).toEqual([]);

        // DC-41: the log names the children created with their `awaited_step`, the wait and the delivery.
        expect(
          recordsOf(harness, 'child task created in step').map((record) => [
            record.fields.childId,
            record.fields.awaitedStep,
          ]),
        ).toEqual([
          [first, 1],
          [failing, 1],
          [third, 1],
          [newChild, 2],
        ]);
        const parentCommits = recordsOf(harness, 'step committed').filter(
          (record) => record.fields.taskId === parentId,
        );
        expect(parentCommits.map((record) => record.fields.waitReason)).toEqual(
          ['children', 'children'],
        );
        const delivered = parentCommits[1].fields.deliveredMessages as {
          messageId: string;
          kind: string;
        }[];
        expect(delivered.map((message) => message.messageId)).toContain(
          note.messageId,
        );
        expect(
          recordsOf(harness, 'task ended').find(
            (record) => record.fields.taskId === failing,
          )?.fields,
        ).toMatchObject({
          to: 'failed',
          failureReason: FAILURE.reason,
          failureMessage: FAILURE.message,
          parentWoken: true,
        });
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
