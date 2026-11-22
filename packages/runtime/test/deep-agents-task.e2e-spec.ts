// deep-agents / task E2E - Design Doc: docs/features/deep-agents/design-task.md (Test Strategy UC-3; KD-1, KD-2, KD-3; Flow 2)
// PRD: docs/features/deep-agents/prd.md (FR-22 AC-22.1, AC-22.2). ADR-0001 (runtime owner: one transaction per transition, recovery by lease).
// Test type: End-to-End (child processes running the runtime from source + real Postgres), the harness of agent-platform-runtime.e2e-spec.ts.
//
// UC-3: a tracker of three tasks, and the runtime process killed before the commit that opens it, after that commit, and in a
// task's step. Nothing below this level proves it: only a process that really dies between two writes shows that the tracker,
// its tasks and the wake-up commit together or not at all.
//
// How a row runs: the test process creates the owner task through its own runtime (workers off). Stage 1 runs the owner alone,
// so its tasks stay queued while the test sends the owner a note during its wait; stage 2 runs every type. A dying child
// registers only the type it must crash on, so the pass `:n` of `RUNTIME_CRASH_AT` counts that type's passes alone.
//
// Proof obligation (plan, phase 1): red if after a restart the tasks are not three or zero, a task has two runs, or
// `tasks_finished` is not exactly one; the note sent during the wait comes with it in one step (DC-4).

import { TASKS_FINISHED_KIND } from '@agent-os/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { newUser } from './support/new-user';
import { Children, type RuntimeChild } from './support/runtimeChild';
import {
  type ChildTypes,
  handlersFor,
  STEP_DONE,
  type TrackerOwnerView,
} from './support/runtimeChildHandlers';
import { closeRuntimeDb, handlerRowsOf, inboxOf } from './support/runtimeDb';
import { createRuntimeHarness, type RuntimeHarness } from './support/runtimeHarness';
import { TRACKER_OPENED_NOTE, uniqueType } from './support/testHandlers';

const RESUME_TARGET_MS = 60_000;
const TEST_TIMEOUT_MS = 300_000;
/** Tasks of the owner's tracker. */
const TRACKER_TASKS = 3;
/** The employee's note sent while the owner waits for its tasks. */
const NOTE = { text: 'while the tasks run' };

type Types = Required<Pick<ChildTypes, 'trackerOwner' | 'trackerTask'>>;

const trackerTypes = (): Types => ({
  trackerOwner: uniqueType('uc3-owner'),
  trackerTask: uniqueType('uc3-task'),
});

/** The test process's runtime: workers off, the types registered only so `tasks.create` accepts them. */
async function testRuntime(types: Types): Promise<RuntimeHarness> {
  const control = await createRuntimeHarness({ handlers: [], config: { workers: false } });
  for (const handler of handlersFor(types, control.db)) control.handlers.register(handler);
  return control;
}

interface Owner {
  ownerId: string;
  taskId: string;
}

async function createOwner(control: RuntimeHarness, types: Types): Promise<Owner> {
  const ownerId = newUser();
  const taskId = await control.tasks.create({
    type: types.trackerOwner,
    ownerId,
    input: { tasks: TRACKER_TASKS, taskType: types.trackerTask },
  });
  return { ownerId, taskId };
}

/** Every task of the owner's tree but the owner itself. */
async function tasksOf(control: RuntimeHarness, owner: Owner) {
  const tree = await control.tasks.listTree(owner.taskId, owner.ownerId);
  return tree.filter((task) => task.taskId !== owner.taskId);
}

/** The owner waits for its tasks: its tracker is committed. */
async function ownerWaitsForTasks(control: RuntimeHarness, owner: Owner): Promise<boolean> {
  const task = await control.tasks.get(owner.taskId, owner.ownerId);
  return task.status === 'waiting' && task.waitReason === 'tasks';
}

/** Stage 1: the owner alone opens its tracker; then the employee writes to it during the wait. */
async function openTrackerAndWrite(
  children: Children,
  control: RuntimeHarness,
  types: Types,
  owner: Owner,
): Promise<void> {
  const ownerOnly = await children.start({ types: { trackerOwner: types.trackerOwner } });
  await ownerOnly.until(() => ownerWaitsForTasks(control, owner), {
    what: 'the owner to wait for its tasks',
    timeoutMs: RESUME_TARGET_MS,
  });
  await ownerOnly.stop();
  await control.inbox.enqueue({
    recipientId: owner.taskId,
    ownerId: owner.ownerId,
    kind: 'note',
    sender: owner.ownerId,
    payload: NOTE,
  });
  // The note does not wake an owner that waits for its tasks.
  expect(await ownerWaitsForTasks(control, owner)).toBe(true);
}

/** Stage 2: every type runs until the owner completes. */
async function finish(
  children: Children,
  control: RuntimeHarness,
  types: Types,
  owner: Owner,
): Promise<void> {
  const fresh: RuntimeChild = await children.start({ types });
  await fresh.until(
    async () => (await control.tasks.get(owner.taskId, owner.ownerId)).status === 'completed',
    { what: 'the owner to complete', timeoutMs: RESUME_TARGET_MS },
  );
  await fresh.stop();
}

/** The end state every row must reach, as in a run without a crash. */
async function expectEndState(control: RuntimeHarness, owner: Owner): Promise<void> {
  const tasks = await tasksOf(control, owner);
  expect(tasks.map((task) => task.status)).toEqual(['completed', 'completed', 'completed']);
  expect(tasks.map((task) => task.result)).toEqual([{ item: 0 }, { item: 1 }, { item: 2 }]);

  // One run per task: one committed step row each, at step 0.
  const rows = await handlerRowsOf(tasks.map((task) => task.taskId));
  expect(
    tasks.map((task) =>
      rows.filter((row) => row.taskId === task.taskId && row.note === STEP_DONE).map((row) => row.stepNo),
    ),
  ).toEqual([[0], [0], [0]]);

  // One tracker, finished, holding the three tasks in their order.
  const trackers = await control.trackers.list(owner.taskId, owner.ownerId);
  expect(trackers).toHaveLength(1);
  expect(trackers[0].status).toBe('finished');
  expect(trackers[0].tasks.map((task) => task.taskId)).toEqual(tasks.map((task) => task.taskId));

  // Exactly one `tasks_finished`, no `child_finished`, and the note delivered to the same step.
  const inbox = await inboxOf(owner.taskId);
  const finished = inbox.filter((message) => message.kind === TASKS_FINISHED_KIND);
  expect(finished).toHaveLength(1);
  expect(inbox.filter((message) => message.kind === 'child_finished')).toEqual([]);
  expect(finished[0]).toMatchObject({
    revive: false,
    status: 'delivered',
    payload: {
      trackerId: trackers[0].trackerId,
      tasks: tasks.map((task) => ({ taskId: task.taskId, status: 'completed' })),
    },
  });
  const note = inbox.filter((message) => message.kind === 'note');
  expect(note).toHaveLength(1);
  expect(note[0].deliveredStep).toBe(finished[0].deliveredStep);

  const ownerTask = await control.tasks.get(owner.taskId, owner.ownerId);
  const view: TrackerOwnerView = {
    tasksFinished: [finished[0].payload],
    messages: [NOTE],
  };
  expect(ownerTask.result).toEqual(view);
}

/** The tracker rows a dying child left: none before the commit, all of them after it. */
async function expectAllOrNothing(
  control: RuntimeHarness,
  owner: Owner,
  committed: boolean,
): Promise<void> {
  const tasks = await tasksOf(control, owner);
  const trackers = await control.trackers.list(owner.taskId, owner.ownerId);
  const opened = (await handlerRowsOf([owner.taskId])).filter(
    (row) => row.note === TRACKER_OPENED_NOTE,
  );
  if (committed) {
    expect(tasks.map((task) => task.status)).toEqual(['queued', 'queued', 'queued']);
    expect(trackers.map((tracker) => tracker.status)).toEqual(['open']);
    expect(opened).toHaveLength(1);
    expect(await ownerWaitsForTasks(control, owner)).toBe(true);
  } else {
    expect(tasks).toEqual([]);
    expect(trackers).toEqual([]);
    expect(opened).toEqual([]);
  }
}

afterAll(closeRuntimeDb);

describe('deep-agents / task - E2E (real Postgres, child processes)', () => {
  // UC-3 · AC-22.1: "Given трекер на три задачи, when сервер падает и поднимается, then задач три или ноль, у каждой один
  // сабагент"; AC-22.2: a lost step of a task is redone by the sweeper, its late result refused, no second run; DC-4: the
  // note that waited comes with the one `tasks_finished`.
  it.each([
    { name: 'inside the commit that opens the tracker', crashAt: 'step.inside-commit', committed: false },
    { name: 'right after the commit that opens the tracker', crashAt: 'step.after-commit', committed: true },
  ])(
    'UC-3 kill $name: the tracker and its three tasks exist all or none, and the run ends with one tasks_finished',
    async (row) => {
      const types = trackerTypes();
      const control = await testRuntime(types);
      const children = new Children();
      try {
        const owner = await createOwner(control, types);

        const dying = await children.start({
          types: { trackerOwner: types.trackerOwner },
          crashAt: row.crashAt,
        });
        await dying.crashed();
        await expectAllOrNothing(control, owner, row.committed);

        await openTrackerAndWrite(children, control, types, owner);
        await finish(children, control, types, owner);

        await expectEndState(control, owner);
      } finally {
        await children.killAll();
        await control.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'UC-3 kill in a task\'s step: the lost step is redone once, and the run ends with one tasks_finished',
    async () => {
      const types = trackerTypes();
      const control = await testRuntime(types);
      const children = new Children();
      try {
        const owner = await createOwner(control, types);
        await openTrackerAndWrite(children, control, types, owner);

        // The first commit of a task's step dies inside its transaction; the other steps die with
        // the process. Their leases expire and the sweeper of the next child requeues them.
        const dying = await children.start({
          types: { trackerTask: types.trackerTask },
          crashAt: 'step.inside-commit',
        });
        await dying.crashed();
        expect((await tasksOf(control, owner)).map((task) => task.status)).not.toContain(
          'completed',
        );
        expect((await control.trackers.list(owner.taskId, owner.ownerId))[0].status).toBe('open');

        await finish(children, control, types, owner);

        await expectEndState(control, owner);
      } finally {
        await children.killAll();
        await control.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
