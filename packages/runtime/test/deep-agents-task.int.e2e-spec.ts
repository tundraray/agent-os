// deep-agents / task integration - Design Doc: docs/features/deep-agents/design-task.md (Contract «Рантайм», Data Model, KD-1 – KD-3; Test Strategy UC-4, UC-5)
// PRD: docs/features/deep-agents/prd.md (FR-22 AC-22.3, AC-22.4, AC-22.5). Test type: Integration (in-process runtime of the package + real Postgres).
// Harness and isolation as in agent-platform-runtime.int.e2e-spec.ts: a unique owner and unique task types per test, no truncate.
// The restart rows of the tracker (UC-3) are the sibling file deep-agents-task.e2e-spec.ts.
//
// R-1 → AC-22.3, DC-5 (runtime): a stop of the owner stops both tasks, creates none, leaves one `tasks_finished` without
//   `revive` in its queue; a message revives the owner and its step gets both.
// R-2 → AC-22.5: `trackers.list` with another's task or as another employee is empty.
// R-3 → AC-22.4 (runtime), DC-4: `tasks_finished` carries `failed` and wakes the owner, which does not fail; a message that
//   arrived during the wait comes with it in the same step, and an interrupt meanwhile is `not_active`.

import { randomUUID } from 'node:crypto';
import { TASKS_FINISHED_KIND } from '@agent-os/contracts';
import type { OpenedTracker } from '@agent-os/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newUser, waitFor } from '@agent-os/db/testing';
import { closeRuntimeDb, inboxOf } from './support/runtimeDb';
import { createRuntimeHarness, type RuntimeHarness } from './support/runtimeHarness';
import {
  createGateBook,
  scriptedHandler,
  type StepView,
  trackerOwnerHandler,
  uniqueType,
} from './support/testHandlers';

const TEST_TIMEOUT_MS = 60_000;

/** An employee's note to the owner's task. */
const NOTE = { text: 'meanwhile' };

const taskOf = (harness: RuntimeHarness, taskId: string, ownerId: string) =>
  harness.tasks.get(taskId, ownerId);

describe('deep-agents / task - integration (in-process runtime + real Postgres)', () => {
  afterAll(closeRuntimeDb);

  it('R-1: stopping the owner stops both tasks, creates none, queues one tasks_finished without revive; a message revives the owner and its step gets both', async () => {
    const ownerType = uniqueType('r1-owner');
    const taskType = uniqueType('r1-task');
    const gates = createGateBook();
    const seen: StepView[] = [];
    const opened: OpenedTracker[] = [];
    const harness = await createRuntimeHarness({
      config: { concurrency: 3 },
      handlers: [
        trackerOwnerHandler({
          type: ownerType,
          tasks: [
            { type: taskType, input: { item: 'a' } },
            { type: taskType, input: { item: 'b' } },
          ],
          seen,
          opened,
        }),
        // Each task holds at its own gate until its signal aborts.
        {
          type: taskType,
          inputSchema: z.record(z.string(), z.unknown()),
          async step(ctx) {
            await gates.of(ctx.taskId).pass(ctx.signal);
            return { outcome: 'complete', result: { late: true } };
          },
        },
      ],
    });
    try {
      const ownerId = newUser();
      const ownerTaskId = await harness.tasks.create({ type: ownerType, ownerId, input: {} });
      await waitFor(async () => opened.length, (count) => count > 0, 'the tracker to open');
      const [taskA, taskB] = opened[0].taskIds;
      await gates.of(taskA).reached;
      await gates.of(taskB).reached;

      const stoppedIds = await harness.tasks.stop(ownerTaskId, ownerId);

      expect(new Set(stoppedIds)).toEqual(new Set([ownerTaskId, taskA, taskB]));
      const tree = await harness.tasks.listTree(ownerTaskId, ownerId);
      expect(tree.map((task) => [task.taskId, task.status])).toEqual([
        [ownerTaskId, 'stopped'],
        [taskA, 'stopped'],
        [taskB, 'stopped'],
      ]);
      const [tracker] = await harness.trackers.list(ownerTaskId, ownerId);
      expect(tracker.status).toBe('finished');
      const inbox = await inboxOf(ownerTaskId);
      expect(inbox.map(({ kind, revive, status, payload }) => ({ kind, revive, status, payload }))).toEqual([
        {
          kind: TASKS_FINISHED_KIND,
          revive: false,
          status: 'pending',
          payload: {
            trackerId: opened[0].trackerId,
            tasks: [
              { taskId: taskA, status: 'stopped' },
              { taskId: taskB, status: 'stopped' },
            ],
          },
        },
      ]);

      await harness.inbox.enqueue({
        recipientId: ownerTaskId,
        ownerId,
        kind: 'note',
        sender: ownerId,
        payload: NOTE,
        revive: true,
      });

      const woken = await waitFor(
        async () => seen.filter((view) => view.stepNo > 0),
        (views) => views.length > 0,
        'the revived owner to run a step',
      );
      expect(woken[0].messages.map((message) => message.kind)).toEqual([TASKS_FINISHED_KIND, 'note']);
      // The revived owner opens no tracker and starts no task: the tree keeps its three tasks.
      await waitFor(
        () => taskOf(harness, ownerTaskId, ownerId),
        (task) => task.status === 'waiting',
        'the revived owner to wait again',
      );
      expect(await harness.tasks.listTree(ownerTaskId, ownerId)).toHaveLength(3);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('R-2: trackers.list gives the owner\'s trackers only; another\'s task or another employee gets an empty list', async () => {
    const ownerType = uniqueType('r2-owner');
    const taskType = uniqueType('r2-task');
    const opened: OpenedTracker[] = [];
    const harness = await createRuntimeHarness({
      handlers: [
        trackerOwnerHandler({
          type: ownerType,
          tasks: [
            { type: taskType, input: {} },
            { type: taskType, input: {} },
          ],
          opened,
        }),
        scriptedHandler({ type: taskType, steps: [{ outcome: 'complete', result: { ok: true } }] }),
      ],
    });
    try {
      const alice = newUser();
      const bob = newUser();
      const aliceTask = await harness.tasks.create({ type: ownerType, ownerId: alice, input: {} });
      const bobTask = await harness.tasks.create({ type: ownerType, ownerId: bob, input: {} });
      const finished = async (taskId: string, ownerId: string) =>
        (await harness.trackers.list(taskId, ownerId)).map((tracker) => tracker.status);
      await waitFor(() => finished(aliceTask, alice), (s) => s[0] === 'finished', 'Alice\'s tracker');
      await waitFor(() => finished(bobTask, bob), (s) => s[0] === 'finished', 'Bob\'s tracker');

      const own = await harness.trackers.list(aliceTask, alice);
      expect(own).toHaveLength(1);
      expect(own[0].tasks.map(({ status, result, failure }) => ({ status, result, failure }))).toEqual([
        { status: 'completed', result: { ok: true }, failure: null },
        { status: 'completed', result: { ok: true }, failure: null },
      ]);

      expect(await harness.trackers.list(aliceTask, bob)).toEqual([]);
      expect(await harness.trackers.list(bobTask, alice)).toEqual([]);
      expect(await harness.trackers.list(randomUUID(), alice)).toEqual([]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('R-3: a failed task is reported as failed and wakes the owner, which does not fail; a message sent during the wait comes in the same step, and an interrupt meanwhile is not_active', async () => {
    const ownerType = uniqueType('r3-owner');
    const okType = uniqueType('r3-ok');
    const failType = uniqueType('r3-fail');
    const gates = createGateBook();
    const seen: StepView[] = [];
    const opened: OpenedTracker[] = [];
    const harness = await createRuntimeHarness({
      config: { concurrency: 3 },
      handlers: [
        trackerOwnerHandler({
          type: ownerType,
          tasks: [
            { type: okType, input: {} },
            { type: failType, input: {} },
          ],
          seen,
          opened,
        }),
        scriptedHandler({ type: okType, steps: [{ outcome: 'complete', result: { answer: 1 } }] }),
        scriptedHandler({
          type: failType,
          steps: [{ outcome: 'throw', error: new Error('subagent broke'), gate: gates.of('fail') }],
        }),
      ],
    });
    try {
      const ownerId = newUser();
      const ownerTaskId = await harness.tasks.create({ type: ownerType, ownerId, input: {} });
      await gates.of('fail').reached;
      const [okTask, failTask] = opened[0].taskIds;
      await waitFor(
        () => taskOf(harness, okTask, ownerId),
        (task) => task.status === 'completed',
        'the first task to complete',
      );

      // Waiting for its tasks: neither the employee's message nor an interrupt wakes the owner.
      await harness.inbox.enqueue({
        recipientId: ownerTaskId,
        ownerId,
        kind: 'note',
        sender: ownerId,
        payload: NOTE,
      });
      expect(await harness.tasks.interrupt(ownerTaskId, ownerId)).toBe('not_active');
      const waiting = await taskOf(harness, ownerTaskId, ownerId);
      expect([waiting.status, waiting.waitReason]).toEqual(['waiting', 'tasks']);
      expect((await inboxOf(ownerTaskId)).map((message) => message.kind)).toEqual(['note']);

      gates.of('fail').open();

      const woken = await waitFor(
        async () => seen.filter((view) => view.stepNo > 0),
        (views) => views.length > 0,
        'the owner to be woken',
      );
      expect(woken).toHaveLength(1);
      expect(woken[0].messages.map(({ kind, payload }) => ({ kind, payload }))).toEqual([
        { kind: 'note', payload: NOTE },
        {
          kind: TASKS_FINISHED_KIND,
          payload: {
            trackerId: opened[0].trackerId,
            tasks: [
              { taskId: okTask, status: 'completed' },
              { taskId: failTask, status: 'failed' },
            ],
          },
        },
      ]);
      const owner = await waitFor(
        () => taskOf(harness, ownerTaskId, ownerId),
        (task) => task.status === 'waiting' && task.waitReason === 'messages',
        'the owner to wait for messages after its step',
      );
      expect(owner.failure).toBeNull();
      const [tracker] = await harness.trackers.list(ownerTaskId, ownerId);
      expect(tracker.tasks.map(({ status, failure }) => ({ status, reason: failure?.reason }))).toEqual([
        { status: 'completed', reason: undefined },
        { status: 'failed', reason: 'handler_error' },
      ]);
      // The tracker's tasks never send `child_finished`.
      expect(
        (await inboxOf(ownerTaskId)).filter((message) => message.kind === 'child_finished'),
      ).toEqual([]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
