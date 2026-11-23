// data-model / runtime integration - Design Doc: docs/features/data-model/design-runtime.md (KD-3, KD-5, KD-7; Test Strategy UC-2, UC-3, UC-4, UC-5)
// Test type: Integration (in-process runtime of the package + real Postgres).
// Harness and isolation as in agent-platform-runtime.int.e2e-spec.ts: a unique owner and unique task types per test, no truncate.
//
// UC-2 → DC-38, DC-39 (engine), DC-41 (question records): a step's `effects.ask` makes a `runtime.question` child in
//   `waiting(human)` awaited by the asker; `TaskControl.answer` completes it once and wakes the asker through `child_finished`;
//   a message to the question answers as for a missing task; an answer after a stop of the asker changes nothing.
// UC-3 → DC-42, DC-34: a failed task stops its unfinished descendants in the transaction of its end (one `finished_at`),
//   their steps in this process are cut off, its parent gets `child_finished` with the reason and the text.
// Review I-1: a savepoint of a commit that rolls back (`effects.savepoint`) drops what it did through the effects.
// Review I-2: a failed step takes its messages with it, so a `revive` among them does not requeue the task into the same
//   failure; a new message still revives it.
// UC-4 → DC-43: a task end hook runs once on each end; a hook that throws rolls back only its own writes and is logged.
// UC-5 → DC-45: a stop of the parent takes the rows top-down, the end of a child bottom-up (its row, then the parent's
//   for `child_finished`); Postgres rolls one of them back with `40P01`, and the engine repeats it.

import { CHILD_FINISHED_KIND } from '@agent-os/contracts';
import { newUser, waitFor } from '@agent-os/db/testing';
import {
  QUESTION_TASK_TYPE,
  RuntimeError,
  type StepContext,
  type StepResult,
  type TaskEndHookInput,
  type TaskHandler,
} from '@agent-os/runtime';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  childRowsOf,
  closeRuntimeDb,
  handlerRowsOf,
  inboxOf,
} from './support/runtimeDb';
import { createRuntimeHarness } from './support/runtimeHarness';
import {
  answerSeen,
  createGateBook,
  DEAF_SIGNAL,
  HANDLER_ROWS_TABLE,
  scriptedHandler,
  type StepView,
  uniqueType,
} from './support/testHandlers';

const TEST_TIMEOUT_MS = 180_000;

/** Pairs of a parent stop and a child end, run one after the other. */
const RACES = 50;

/** Children of each parent: their ends race the stop together. */
const CHILDREN = 2;

const FINISHED = new Set(['completed', 'failed', 'stopped']);

const ANY_INPUT = z.record(z.string(), z.unknown());

describe('data-model / runtime - integration (in-process runtime + real Postgres)', () => {
  afterAll(closeRuntimeDb);

  it(
    'UC-5: a parent stop racing a child end, 50 times in a row: each pair ends without an error, the tree is stopped, each child leaves one child_finished in the parent queue',
    async () => {
      const parentType = uniqueType('uc5-parent');
      const childType = uniqueType('uc5-child');
      const gates = createGateBook();
      const parent: TaskHandler = {
        type: parentType,
        inputSchema: z.record(z.string(), z.unknown()),
        step(ctx: StepContext): Promise<StepResult> {
          if (ctx.stepNo > 0) return Promise.resolve({ outcome: 'wait' });
          return Promise.resolve({
            outcome: 'wait',
            commit: async (effects) => {
              for (let index = 0; index < CHILDREN; index += 1)
                await effects.spawn({ type: childType, input: { index } });
            },
          });
        },
      };
      // A child holds at its gate deaf to the stop, so its end comes at the moment the test opens it.
      const child: TaskHandler = {
        type: childType,
        inputSchema: z.record(z.string(), z.unknown()),
        async step(ctx) {
          await gates.of(ctx.taskId).pass(DEAF_SIGNAL);
          return { outcome: 'complete', result: { done: ctx.taskId } };
        },
      };
      const harness = await createRuntimeHarness({
        config: { concurrency: CHILDREN + 1, dbPoolMax: CHILDREN + 4 },
        handlers: [parent, child],
      });
      try {
        const ownerId = await newUser();
        for (let race = 0; race < RACES; race += 1) {
          const parentId = await harness.tasks.create({
            type: parentType,
            ownerId,
            input: {},
          });
          const spawned = await waitFor(
            () => harness.tasks.listTree(parentId, ownerId),
            (tree) => tree.length === CHILDREN + 1,
            `the children of race ${race}`,
          );
          const childIds = spawned.slice(1).map((task) => task.taskId);
          await Promise.all(childIds.map((id) => gates.of(id).reached));

          // The children's commits and the stop start together.
          for (const id of childIds) gates.of(id).open();
          await expect(
            harness.tasks.stop(parentId, ownerId),
          ).resolves.toContain(parentId);

          const tree = await waitFor(
            () => harness.tasks.listTree(parentId, ownerId),
            (tasks) => tasks.every((task) => FINISHED.has(task.status)),
            `the tree of race ${race} to finish`,
          );
          expect(tree[0].status).toBe('stopped');
          for (const task of tree.slice(1))
            expect(['completed', 'stopped']).toContain(task.status);
          const notices = (await inboxOf(parentId)).filter(
            (message) => message.kind === CHILD_FINISHED_KIND,
          );
          expect(
            notices
              .map((message) => (message.payload as { taskId: string }).taskId)
              .sort(),
          ).toEqual([...childIds].sort());
        }
        // The races did deadlock at least once, and the engine repeated what Postgres rolled back.
        const deadlockRepeats = harness.logs.filter(
          (record) =>
            record.message === 'engine transaction deadlocked; repeating it' ||
            (record.message === 'step commit transaction failed' &&
              JSON.stringify(record.fields.error).includes(
                'deadlock detected',
              )),
        );
        expect(deadlockRepeats.length).toBeGreaterThan(0);
        // No transaction gave up: neither a stop nor a child's commit.
        expect(
          harness.logs.filter(
            (record) =>
              record.message === 'task stop failed' ||
              record.message ===
                'step commit abandoned to the recovery sweeper',
          ),
        ).toEqual([]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'UC-3: a task with two running children and a grandchild fails: the three are stopped in the transaction of its end, their steps are cut off, its parent gets child_finished with the reason and the text',
    async () => {
      const rootType = uniqueType('uc3-root');
      const failingType = uniqueType('uc3-failing');
      const childType = uniqueType('uc3-child');
      const grandchildType = uniqueType('uc3-grandchild');
      const gates = createGateBook();
      /** Why each held step's signal was aborted, by task. */
      const cutOffReasons = new Map<string, unknown>();
      /** A step that holds at its task's gate, never opened, until its signal is aborted. */
      const holdUntilCutOff = async (ctx: StepContext): Promise<StepResult> => {
        try {
          await gates.of(ctx.taskId).pass(ctx.signal);
        } catch (error) {
          cutOffReasons.set(ctx.taskId, ctx.signal.reason);
          throw error;
        }
        throw new Error('the gate of a held step was opened');
      };
      const spawnAndWait = (
        children: readonly { type: string; input: Record<string, unknown> }[],
      ): StepResult => ({
        outcome: 'wait',
        commit: async (effects) => {
          for (const child of children) await effects.spawn(child);
        },
      });
      const root: TaskHandler = {
        type: rootType,
        inputSchema: ANY_INPUT,
        step: (ctx) =>
          Promise.resolve(
            ctx.stepNo === 0
              ? spawnAndWait([{ type: failingType, input: {} }])
              : { outcome: 'wait' },
          ),
      };
      // Spawns its two children, then fails on the test's message.
      const failing: TaskHandler = {
        type: failingType,
        inputSchema: ANY_INPUT,
        step: (ctx) =>
          Promise.resolve(
            ctx.stepNo === 0
              ? spawnAndWait([
                  { type: childType, input: { withGrandchild: true } },
                  { type: childType, input: { withGrandchild: false } },
                ])
              : {
                  outcome: 'fail',
                  reason: 'model_error',
                  message: 'the model broke',
                },
          ),
      };
      const child: TaskHandler = {
        type: childType,
        inputSchema: ANY_INPUT,
        step: (ctx) =>
          ctx.stepNo === 0 &&
          (ctx.input as { withGrandchild: boolean }).withGrandchild
            ? Promise.resolve({
                outcome: 'continue',
                commit: async (effects) => {
                  await effects.spawn({ type: grandchildType, input: {} });
                },
              })
            : holdUntilCutOff(ctx),
      };
      const grandchild: TaskHandler = {
        type: grandchildType,
        inputSchema: ANY_INPUT,
        step: holdUntilCutOff,
      };
      const harness = await createRuntimeHarness({
        config: { concurrency: 5, dbPoolMax: 8 },
        handlers: [root, failing, child, grandchild],
      });
      try {
        const ownerId = await newUser();
        // A tree of root → failing → two children, one with a grandchild, every held step at its gate.
        const first = await (async () => {
          const rootId = await harness.tasks.create({
            type: rootType,
            ownerId,
            input: {},
          });
          const tree = await waitFor(
            () => harness.tasks.listTree(rootId, ownerId),
            (tasks) => tasks.length === 5,
            'the tree of five tasks',
          );
          const failingId = tree.find(
            (task) => task.type === failingType,
          )!.taskId;
          const heldIds = tree
            .filter(
              (task) => task.type === grandchildType || task.type === childType,
            )
            .map((task) => task.taskId);
          await Promise.all(heldIds.map((id) => gates.of(id).reached));
          return { rootId, failingId, heldIds };
        })();

        // A failure of the task in the middle.
        await harness.inbox.enqueue({
          recipientId: first.failingId,
          ownerId,
          kind: 'test.fail',
          payload: {},
        });
        const afterFailure = await waitFor(
          () => harness.tasks.listTree(first.rootId, ownerId),
          (tasks) =>
            tasks.some(
              (task) =>
                task.taskId === first.failingId && task.status === 'failed',
            ),
          'the middle task to fail',
        );
        const descendants = afterFailure.filter((task) =>
          first.heldIds.includes(task.taskId),
        );
        expect(descendants.map((task) => task.status)).toEqual([
          'stopped',
          'stopped',
          'stopped',
        ]);
        // One `finished_at` — the time of one transaction — for the failure and the three stops.
        const ended = afterFailure.filter(
          (task) =>
            task.taskId === first.failingId ||
            first.heldIds.includes(task.taskId),
        );
        expect(
          new Set(ended.map((task) => task.finishedAt?.getTime())).size,
        ).toBe(1);
        await waitFor(
          () =>
            Promise.resolve(first.heldIds.map((id) => cutOffReasons.get(id))),
          (reasons) => reasons.every((reason) => reason === 'stopped'),
          'the held steps to be cut off',
        );
        const notices = (await inboxOf(first.rootId)).filter(
          (message) => message.kind === CHILD_FINISHED_KIND,
        );
        expect(notices.map((message) => message.payload)).toEqual([
          expect.objectContaining({
            taskId: first.failingId,
            status: 'failed',
            failure: { reason: 'model_error', message: 'the model broke' },
          }),
        ]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "UC-4: a task end hook runs once on each completed, failed and stopped end; the end whose hook throws still commits, the hook's write rolls back and its failure is logged",
    async () => {
      const completingType = uniqueType('uc4-completing');
      const failingType = uniqueType('uc4-failing');
      const waitingType = uniqueType('uc4-waiting');
      const types = new Set([completingType, failingType, waitingType]);
      const hookName = `test.uc4-hook-${completingType}`;
      const HOOK_NOTE = 'end-hook';
      const harness = await createRuntimeHarness({
        handlers: [
          {
            type: completingType,
            inputSchema: ANY_INPUT,
            step: () =>
              Promise.resolve({ outcome: 'complete', result: { ok: true } }),
          },
          {
            type: failingType,
            inputSchema: ANY_INPUT,
            step: () =>
              Promise.resolve({
                outcome: 'fail',
                reason: 'test_failure',
                message: 'failed on purpose',
              }),
          },
          {
            type: waitingType,
            inputSchema: ANY_INPUT,
            step: () => Promise.resolve({ outcome: 'wait' }),
          },
        ],
      });
      const calls: TaskEndHookInput[] = [];
      // Writes a row in the end's transaction; throws on the failed end, after its write.
      harness.endHooks.register(hookName, async (end) => {
        if (!types.has(end.type)) return;
        calls.push(end);
        await harness.runtimeDb.client.execute(sql`
          INSERT INTO ${sql.raw(HANDLER_ROWS_TABLE)} (task_id, step_no, attempt, resumed_after_loss, note)
          VALUES (${end.taskId}, 0, 0, false, ${HOOK_NOTE})`);
        if (end.status === 'failed') throw new Error('the hook broke');
      });
      try {
        const ownerId = await newUser();
        const create = (type: string) =>
          harness.tasks.create({ type, ownerId, input: {} });
        const completedId = await create(completingType);
        const failedId = await create(failingType);
        const waitingId = await create(waitingType);
        await waitFor(
          () => harness.tasks.get(waitingId, ownerId),
          (task) => task.status === 'waiting',
          'the waiting task to wait',
        );
        await harness.tasks.stop(waitingId, ownerId);
        // The hook's calls are recorded before their transactions commit: wait for the committed ends.
        await waitFor(
          () =>
            Promise.all(
              [completedId, failedId].map((id) =>
                harness.tasks.get(id, ownerId),
              ),
            ),
          (tasks) => tasks.every((task) => FINISHED.has(task.status)),
          'the completing and the failing task to end',
        );

        const byTask = new Map(calls.map((call) => [call.taskId, call.status]));
        expect(calls).toHaveLength(3);
        expect(Object.fromEntries(byTask)).toEqual({
          [completedId]: 'completed',
          [failedId]: 'failed',
          [waitingId]: 'stopped',
        });
        expect(calls.find((call) => call.taskId === failedId)).toMatchObject({
          rootId: failedId,
          parentId: null,
          ownerId,
          type: failingType,
          failure: { reason: 'test_failure', message: 'failed on purpose' },
        });
        // The end with the failed hook committed; only the hook's own write rolled back.
        expect((await harness.tasks.get(failedId, ownerId)).status).toBe(
          'failed',
        );
        const hookRows = (
          await handlerRowsOf([completedId, failedId, waitingId])
        ).filter((row) => row.note === HOOK_NOTE);
        expect(hookRows.map((row) => row.taskId).sort()).toEqual(
          [completedId, waitingId].sort(),
        );
        expect(
          harness.logs
            .filter(
              (record) =>
                record.message ===
                'task end hook failed; its writes rolled back',
            )
            .map((record) => ({
              hook: record.fields.hook,
              taskId: record.fields.taskId,
            })),
        ).toEqual([{ hook: hookName, taskId: failedId }]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "UC-2: a question waits for its owner's answer, is answered once, wakes the asker with the answer, refuses messages, and takes no answer after a stop of the asker",
    async () => {
      // Given: a handler whose first step asks a question and whose later steps wait
      const askerType = uniqueType('uc2-asker');
      const seen: StepView[] = [];
      const harness = await createRuntimeHarness({
        handlers: [
          scriptedHandler({
            type: askerType,
            seen,
            steps: [
              { outcome: 'ask', kind: 'approve', payload: { question: 'go?' } },
              { outcome: 'wait' },
            ],
          }),
        ],
      });
      /** The asker waits for its question; returns the question task. */
      const askedBy = async (askerId: string, ownerId: string) => {
        await waitFor(
          () => harness.tasks.get(askerId, ownerId),
          (task) => task.status === 'waiting' && task.waitReason === 'children',
          'the asker to wait for its question',
        );
        const tree = await harness.tasks.listTree(askerId, ownerId);
        return tree.filter((task) => task.type === QUESTION_TASK_TYPE);
      };
      const notFoundOf = (call: () => Promise<unknown>) =>
        call().then(
          () => 'answered without an error',
          (error: unknown) =>
            error instanceof RuntimeError ? error.code : String(error),
        );
      try {
        const ownerId = await newUser();
        const askerId = await harness.tasks.create({
          type: askerType,
          ownerId,
          input: {},
        });
        const [question, ...more] = await askedBy(askerId, ownerId);
        expect(more).toEqual([]);

        // Then (DC-38): the question is a child in waiting(human), awaited by the asker's new step
        expect(question).toMatchObject({
          parentId: askerId,
          status: 'waiting',
          waitReason: 'human',
          input: { kind: 'approve', payload: { question: 'go?' } },
        });
        const asker = await harness.tasks.get(askerId, ownerId);
        expect(await childRowsOf(askerId)).toEqual([
          expect.objectContaining({
            taskId: question.taskId,
            awaitedStep: asker.stepNo,
          }),
        ]);

        // When: a message is written to the question
        const message = () =>
          harness.inbox.enqueue({
            recipientId: question.taskId,
            ownerId,
            kind: 'note',
            payload: { approved: true },
          });

        // Then: it is refused as for a question that does not exist, and the question still waits
        expect(await notFoundOf(message)).toBe('TASK_NOT_FOUND');
        expect(
          await harness.inbox.listPending(question.taskId, ownerId),
        ).toEqual([]);
        expect((await harness.tasks.get(question.taskId, ownerId)).status).toBe(
          'waiting',
        );

        // When: the owner answers twice
        const first = await harness.tasks.answer(question.taskId, ownerId, {
          approved: true,
        });
        const second = await harness.tasks.answer(question.taskId, ownerId, {
          approved: false,
        });

        // Then (DC-39): answered once; the question keeps the first answer; the asker's next step
        // gets it in the question's child_finished
        expect([first, second]).toEqual(['answered', 'already_answered']);
        expect(await harness.tasks.get(question.taskId, ownerId)).toMatchObject(
          { status: 'completed', result: { approved: true } },
        );
        await waitFor(
          () => harness.tasks.get(askerId, ownerId),
          (task) =>
            task.status === 'waiting' &&
            task.waitReason === 'messages' &&
            seen.length === 2,
          'the asker to take the answer in',
        );
        expect(answerSeen(seen[1], question.taskId)?.payload).toEqual({
          taskId: question.taskId,
          status: 'completed',
          result: { approved: true },
          durationMs: expect.any(Number),
        });

        // And (DC-41): the log names the question asked and each answer
        const questionLogs = harness.logs
          .filter(
            (record) =>
              record.fields.questionId === question.taskId &&
              (record.message === 'question asked' ||
                record.message === 'question answered'),
          )
          .map((record) => ({
            message: record.message,
            askerId: record.fields.askerId,
            kind: record.fields.kind,
            outcome: record.fields.outcome,
            askerWoken: record.fields.askerWoken,
          }));
        expect(questionLogs).toEqual([
          {
            message: 'question asked',
            askerId,
            kind: 'approve',
            outcome: undefined,
            askerWoken: undefined,
          },
          {
            message: 'question answered',
            askerId,
            kind: undefined,
            outcome: 'answered',
            askerWoken: true,
          },
          {
            message: 'question answered',
            askerId,
            kind: undefined,
            outcome: 'already_answered',
            askerWoken: false,
          },
        ]);

        // When (another run): the asker is stopped while its question waits
        const stoppedAskerId = await harness.tasks.create({
          type: askerType,
          ownerId,
          input: {},
        });
        const [open] = await askedBy(stoppedAskerId, ownerId);
        await harness.tasks.stop(stoppedAskerId, ownerId);

        // Then: an answer after the stop changes nothing
        expect(
          await harness.tasks.answer(open.taskId, ownerId, { approved: true }),
        ).toBe('already_answered');
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'review I-1: a savepoint of a commit that rolls back leaves no child, no adopted object and no wait for children',
    async () => {
      const parentType = uniqueType('i1-parent');
      const childType = uniqueType('i1-child');
      /** What the savepoint answered inside the commit. */
      const attempts: boolean[] = [];
      const parent: TaskHandler = {
        type: parentType,
        inputSchema: ANY_INPUT,
        step: (ctx) =>
          Promise.resolve(
            ctx.stepNo > 0
              ? { outcome: 'wait' }
              : {
                  outcome: 'wait',
                  // A tool of the commit spawns an awaited child, hands its object over, then throws.
                  commit: async (effects) => {
                    const attempt = await effects.savepoint(async () => {
                      const childId = await effects.spawn({
                        type: childType,
                        input: {},
                        awaited: true,
                      });
                      effects.adopt(childId, {
                        step: () => Promise.resolve({ outcome: 'wait' }),
                      });
                      throw new Error('the tool broke');
                    });
                    attempts.push(attempt.ok);
                  },
                },
          ),
      };
      const harness = await createRuntimeHarness({ handlers: [parent] });
      harness.handlers.registerLive({
        type: childType,
        inputSchema: ANY_INPUT,
        restore: () =>
          Promise.resolve({ step: () => Promise.resolve({ outcome: 'wait' }) }),
      });
      try {
        const ownerId = await newUser();
        const parentId = await harness.tasks.create({
          type: parentType,
          ownerId,
          input: {},
        });

        // The commit counts no awaited child: the parent waits for messages, not for a child that is gone.
        const task = await waitFor(
          () => harness.tasks.get(parentId, ownerId),
          (current) => current.status === 'waiting',
          'the parent to wait',
        );
        expect(task.waitReason).toBe('messages');
        expect(attempts).toEqual([false]);
        expect(await harness.tasks.listTree(parentId, ownerId)).toHaveLength(1);
        // The commit names no child and adopts no object.
        const committed = harness.logs.filter(
          (record) =>
            record.message === 'step committed' &&
            record.fields.taskId === parentId,
        );
        expect(committed).toHaveLength(1);
        expect(committed[0].fields.childIds).toBeUndefined();
        expect(committed[0].fields.adoptedTaskIds).toBeUndefined();
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'review I-2: a step that throws takes its revive message with it, so the task stays failed; a new message revives it once more',
    async () => {
      const failingType = uniqueType('i2-failing');
      /** Steps the handler ran. */
      let steps = 0;
      const harness = await createRuntimeHarness({
        handlers: [
          {
            type: failingType,
            inputSchema: ANY_INPUT,
            step: () => {
              steps += 1;
              return Promise.reject(new Error('the handler broke'));
            },
          },
        ],
      });
      try {
        const ownerId = await newUser();
        const taskId = await harness.tasks.create({
          type: failingType,
          ownerId,
          input: {},
        });
        /** Waits until the task failed and no message of it is pending. */
        const failedWithNothingPending = (label: string) =>
          waitFor(
            async () => ({
              task: await harness.tasks.get(taskId, ownerId),
              messages: await inboxOf(taskId),
            }),
            ({ task, messages }) =>
              task.status === 'failed' &&
              messages.every((message) => message.delivered),
            label,
          );
        await failedWithNothingPending('the first failure');
        const revive = () =>
          harness.inbox.enqueue({
            recipientId: taskId,
            ownerId,
            kind: 'note',
            payload: {},
            revive: true,
          });

        // A message with revive requeues the failed task; its step fails again and takes the message.
        await revive();
        await waitFor(
          () => Promise.resolve(steps),
          (count) => count >= 2,
          'the revived step',
        );
        await failedWithNothingPending('the second failure');
        // A new message revives it once more.
        await revive();
        await waitFor(
          () => Promise.resolve(steps),
          (count) => count >= 3,
          'the step of the new message',
        );
        const { task } = await failedWithNothingPending('the third failure');
        expect(task.failure).toMatchObject({ reason: 'handler_error' });
        expect(steps).toBe(3);
        expect(
          (await inboxOf(taskId)).map((message) => message.delivered),
        ).toEqual([true, true]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
