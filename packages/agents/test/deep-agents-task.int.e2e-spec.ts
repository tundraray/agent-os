// deep-agents / task - agents-package integration test (in-process `RuntimeModule` + `createAgents` over real Postgres, scripted model)
// Design Doc: docs/features/deep-agents/design-task.md, Test Strategy UC-1, UC-2; KD-4, KD-5, KD-8; DC-1, DC-3, DC-7
// PRD: docs/features/deep-agents/prd.md FR-18, FR-19, FR-22 (AC-18.1 – AC-18.3, AC-19.1, AC-19.2, AC-22.4)
// Test type: Integration, run with `pnpm --filter @agent-os/agents test:e2e`.
//
// Harness: `createAgentsHarness` of support/agentsHarness.ts, the library double with a `deep_agent` record the root starts through
// `start_test_deep_agent` (a plain task, so a subagent's task is its description alone). A subagent fails as in deep-agents-run
// INT-2 A: its model errors on every attempt, held on a latch until the other subagent has completed (a failed awaited child wakes the
// deep agent at once, so the order is the test's, not the timing's). A unique owner `newUser()` per run; no sleeps, `waitForTaskStatus` orders the steps.
//
// Proven elsewhere (not restated here):
// - unit, packages/agents/src/tools/builtin/delegation-rules.spec.ts - UC-7, UC-8: every refusal of a task call, list items outside maxRuns,
//   and the cut of the result table.
// - unit, packages/agents/src/agent/turn-rules.spec.ts - UC-6: the answer fields.
// - integration, packages/runtime/test/deep-agents-task.*.e2e-spec.ts - waiting for awaited children: restarts, stop, one wake.

import { conversationTasks, toolResults } from '@agent-os/db';
import {
  createLatch,
  createLibraryDouble,
  createScriptedModel,
  modelError,
  type ReplyFromInput,
  type ScriptedModel,
} from '@agent-os/agents/testing';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  createAgentsHarness,
  historyLines,
  historyOf,
  START_TEST_DEEP_AGENT,
  taskCall,
  testDeepAgent,
  testRecord,
  testSubagent,
  TEST_MODEL_DEFAULT,
  toolCallRowsOf,
  waitForTaskStatus,
} from './support/agentsHarness';
import { newUser, waitFor } from '@agent-os/db/testing';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

const DEEP_AGENT = 'delegating deep agent';
const SCOUT_A = 'scout-a';
const SCOUT_B = 'scout-b';

/** A scripted `task_create` call. */
function taskCreate(subject: string) {
  return {
    tool: 'task_create',
    args: { subject, description: `Описание: ${subject}` },
  };
}

/** A scripted `task_update` call. */
function taskUpdate(taskId: number, status: string) {
  return { tool: 'task_update', args: { taskId, status } };
}

/** A harness whose root starts the deep agent `DEEP_AGENT` with two subagents, each given at most one single task. */
async function delegatingHarness(
  model: ScriptedModel,
): Promise<{ harness: AgentsHarness; recordId: string }> {
  const library = createLibraryDouble();
  const recordId = library.add(
    testDeepAgent(DEEP_AGENT, {
      prompt: 'You give the work to your scouts.',
      servers: [],
      model: TEST_MODEL_DEFAULT,
      maxTurns: 10,
      subagents: [testSubagent(SCOUT_A), testSubagent(SCOUT_B)],
      finalSubagent: null,
      taskList: true,
      listDelegation: true,
      selfLearning: false,
    }),
  );
  const harness = await createAgentsHarness({
    model,
    library,
    access: {},
    root: testRecord('root'),
    deepAgentStarter: true,
  });
  return { harness, recordId };
}

/** Starts a conversation whose root starts the deep agent on `task`; returns the root's and the deep agent's ids. */
async function startDeepAgent(
  harness: AgentsHarness,
  model: ScriptedModel,
  input: {
    readonly ownerId: string;
    readonly recordId: string;
    readonly task: string;
  },
): Promise<{ rootId: string; deepAgentId: string }> {
  const rootTask = `Start the deep agent: ${input.task}`;
  model.script(
    { task: rootTask },
    [
      {
        calls: [
          {
            tool: START_TEST_DEEP_AGENT,
            args: {
              deepAgent: input.recordId,
              prompt: input.task,
              description: 'deep agent',
            },
          },
        ],
      },
    ],
    { thereafter: { text: 'noted' } },
  );
  const { agentId: rootId } = await harness.sessions.start({
    ownerId: input.ownerId,
    prompt: rootTask,
    description: 'root',
  });
  const rows = await waitFor(
    () => toolCallRowsOf(harness.db, rootId),
    (calls) => calls.some((call) => call.childTaskId !== null),
    `the deep agent of root ${rootId}`,
  );
  const deepAgentId = rows.find(
    (call) => call.childTaskId !== null,
  )?.childTaskId;
  if (deepAgentId === undefined || deepAgentId === null)
    throw new Error(`root ${rootId} started no deep agent`);
  return { rootId, deepAgentId };
}

/** The `task` results of the deep agent: subagent, outcome and text, in call order. */
async function taskResultsOf(
  harness: AgentsHarness,
  deepAgentId: string,
  ownerId: string,
) {
  return (await historyOf(harness, deepAgentId, ownerId)).flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === 'task'
      ? [
          {
            subagent: (entry.content.args as { subagentType: string })
              .subagentType,
            outcome: entry.content.outcome,
            text: entry.content.text,
          },
        ]
      : [],
  );
}

/** The callId of the deep agent's own `task` call in a recorded input. */
const taskCallId: (messages: Parameters<ReplyFromInput>[0]) => string = (
  messages,
) => {
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    const call = message.toolCalls.find(
      (candidate) => candidate.toolName === 'task',
    );
    if (call !== undefined) return call.toolCallId;
  }
  throw new Error('the deep agent made no task call');
};

describe('deep-agents / task - a deep agent gives work to its subagents with task and is woken once with every result', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // UC-1: two task calls in one answer - one wake, a failed subagent does not fail the deep agent, task 1 of the list
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-18.1 (the result of task is the subagent's last message), AC-18.2 (one assignment in the subagent's history), AC-18.3 (task 1 of
  //   the list gets the subagent as its owner and is completed by its answer), AC-22.4 (a failed subagent is the call's error, the deep
  //   agent works on), DC-1 (the task calls of one answer, awaited children, one wake), DC-7 (a failed delegation leaves task 1 in_progress and
  //   names it).
  // Catches: (1) a wake per subagent instead of one; (2) a failed subagent that fails the deep agent; (3) the assignment written twice
  //   into the subagent's history; (4) task 1 left unlabelled, completed after a failure, or not completed after a success.
  // Rows: "second fails" - scout-b fails, task 1 (scout-a's) ends completed; "first fails" - scout-a fails, task 1 stays in_progress and
  //   the result says so, the deep agent completes it with task_update before its text.
  it.each<{ readonly row: string; readonly failing: 'a' | 'b' }>([
    { row: 'second fails', failing: 'b' },
    { row: 'first fails', failing: 'a' },
  ])(
    'UC-1 ($row): two task calls wake the deep agent once, the failed one is an error, the other the answer, and task 1 follows its subagent',
    async ({ row, failing }) => {
      // Given: a deep agent whose first answer creates task 1 and whose second gives scout-a (for task 1) and scout-b a task
      const ownerId = await newUser();
      const model = createScriptedModel();
      const { harness, recordId } = await delegatingHarness(model);
      const assignmentA = `Find the cause (${row})`;
      const assignmentB = `Check the logs (${row})`;
      // The failing subagent fails only once the other has completed.
      const failLatch = createLatch();
      const deepAgent = model.script({ task: `Investigate (${row})` }, [
        { calls: [taskCreate('Найти причину')] },
        {
          calls: [
            taskCall({
              subagentType: SCOUT_A,
              description: assignmentA,
              taskId: 1,
            }),
            taskCall({ subagentType: SCOUT_B, description: assignmentB }),
          ],
        },
        ...(failing === 'a' ? [{ calls: [taskUpdate(1, 'completed')] }] : []),
        { text: `Done (${row})` },
      ]);
      model.script(
        { task: assignmentA },
        failing === 'a' ? [] : [{ text: 'The cause is a bad deploy.' }],
        failing === 'a' ? { thereafter: modelError(undefined, failLatch) } : {},
      );
      model.script(
        { task: assignmentB },
        failing === 'b' ? [] : [{ text: 'The logs agree.' }],
        failing === 'b' ? { thereafter: modelError(undefined, failLatch) } : {},
      );
      try {
        // When: the root starts the deep agent and both subagents end
        const { rootId, deepAgentId } = await startDeepAgent(harness, model, {
          ownerId,
          recordId,
          task: `Investigate (${row})`,
        });
        // Only the succeeding subagent can complete while the failing one is held.
        await waitFor(
          async () =>
            (await harness.runtime.tasks.listTree(rootId, ownerId)).filter(
              (task) => task.parentId === deepAgentId,
            ),
          (subagents) =>
            subagents.length === 2 &&
            subagents.some((task) => task.status === 'completed'),
          'the succeeding subagent to complete',
        );
        failLatch.open();
        await waitForTaskStatus(harness, deepAgentId, ownerId, 'completed');

        // Then: one wake for both calls - the third model call holds both results; the failed one is an error with its reason
        const woken = deepAgent.calls[2]?.messages.at(-1);
        expect(
          woken?.role === 'tool'
            ? woken.results.map((result) => result.toolName)
            : [],
        ).toEqual(['task', 'task']);
        const results = await taskResultsOf(harness, deepAgentId, ownerId);
        // data-model design-runtime.md, «Инструмент `task`»: the reason and the failure's text.
        const failedText = 'The subagent failed: provider_unavailable: ';
        expect(results).toEqual(
          failing === 'b'
            ? [
                {
                  subagent: SCOUT_A,
                  outcome: 'success',
                  text: 'The cause is a bad deploy.\n\nTask 1 completed',
                },
                {
                  subagent: SCOUT_B,
                  outcome: 'tool_error',
                  text: expect.stringMatching(
                    new RegExp(`^${failedText}.+\\.$`),
                  ),
                },
              ]
            : [
                {
                  subagent: SCOUT_A,
                  outcome: 'tool_error',
                  text: expect.stringMatching(
                    new RegExp(
                      `^${failedText}.+\\.\n\nTask 1 is still in_progress$`,
                    ),
                  ),
                },
                {
                  subagent: SCOUT_B,
                  outcome: 'success',
                  text: 'The logs agree.',
                },
              ],
        );

        // Then: each subagent's history holds its assignment once
        const subagents = (
          await toolCallRowsOf(harness.db, deepAgentId)
        ).flatMap((call) =>
          call.childTaskId === null ? [] : [call.childTaskId],
        );
        expect(subagents).toHaveLength(2);
        for (const [index, subagentId] of subagents.entries()) {
          const lines = historyLines(
            await historyOf(harness, subagentId, ownerId),
          );
          expect(lines.filter((line) => line.startsWith('task: '))).toEqual([
            `task: ${index === 0 ? assignmentA : assignmentB}`,
          ]);
        }

        // Then: task 1 carries scout-a as its owner and is completed - by the answer, or by the deep agent after the failure
        const [task] = await harness.db
          .select({
            status: conversationTasks.status,
            owner: conversationTasks.owner,
          })
          .from(conversationTasks)
          .where(
            and(
              eq(conversationTasks.conversationId, deepAgentId),
              eq(conversationTasks.number, 1),
            ),
          );
        expect(task).toEqual({ status: 'completed', owner: SCOUT_A });
        expect(deepAgent.calls).toHaveLength(failing === 'a' ? 4 : 3);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // UC-2: a list of five items - five subagents, a table of five rows, the failed one with its reason, the full answers stored
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-19.1 (one subagent per item, none skipped), AC-19.2 (the table: item, status, answer or reason), DC-3 (a cut table is read whole
  //   with read_tool_result).
  // Catches: (1) an item without its subagent or its row; (2) a failed item that drops out of the table or loses its reason; (3) a cut table
  //   whose full answers are lost - not stored under the call, or not readable by read_tool_result.
  it(
    'UC-2: a list of five items starts five subagents and returns a cut table of five rows, the failed one with its reason, the full one read with read_tool_result',
    async () => {
      // Given: five items whose answers are longer than their share of the table; the third item's subagent fails
      const ownerId = await newUser();
      const model = createScriptedModel();
      const { harness, recordId } = await delegatingHarness(model);
      const instruction = 'Collect the facts of the city';
      const items = ['Москва', 'Казань', 'Тверь', 'Пермь', 'Омск'];
      const answerOf = (item: string) =>
        `Answer for ${item}: ${'факт '.repeat(1_500)}end of ${item}`;
      // The third item's subagent fails only once the other four have completed.
      const failLatch = createLatch();
      for (const [index, item] of items.entries()) {
        const task = `${instruction}\n\nItem: ${item}`;
        if (index === 2)
          model.script({ task }, [], {
            thereafter: modelError(undefined, failLatch),
          });
        else model.script({ task }, [{ text: answerOf(item) }]);
      }
      const readStored: ReplyFromInput = (messages) => ({
        calls: [
          { tool: 'read_tool_result', args: { callId: taskCallId(messages) } },
        ],
      });
      const deepAgent = model.script({ task: 'Collect five cities' }, [
        { calls: [taskCall({ subagentType: SCOUT_A, instruction, items })] },
        readStored,
        { text: 'The cities are collected.' },
      ]);
      try {
        // When: the deep agent gives the list, then reads the stored table
        const { rootId, deepAgentId } = await startDeepAgent(harness, model, {
          ownerId,
          recordId,
          task: 'Collect five cities',
        });
        await waitFor(
          async () =>
            (await harness.runtime.tasks.listTree(rootId, ownerId)).filter(
              (task) =>
                task.parentId === deepAgentId && task.status === 'completed',
            ),
          (completed) => completed.length === 4,
          'the four succeeding subagents to complete',
        );
        failLatch.open();
        await waitForTaskStatus(harness, deepAgentId, ownerId, 'completed');

        // Then: five subagents, one per item, under the deep agent
        const children = (await harness.sessions.list(rootId, ownerId)).filter(
          (view) => view.parentId === deepAgentId,
        );
        expect(
          children.map(({ description, status }) => ({ description, status })),
        ).toEqual(
          items.map((item, index) => ({
            description: item,
            status: index === 2 ? 'failed' : 'completed',
          })),
        );

        // Then: the table has five rows in item order, the failed one with its reason, and is cut with the line naming the call
        const [result] = await taskResultsOf(harness, deepAgentId, ownerId);
        const lines = (result?.text ?? '').split('\n');
        expect(
          lines
            .slice(2, 7)
            .map((line) => line.split(' | ').slice(0, 3).join(' | ')),
        ).toEqual([
          '| 1 | Москва | completed',
          '| 2 | Казань | completed',
          '| 3 | Тверь | failed',
          '| 4 | Пермь | completed',
          '| 5 | Омск | completed',
        ]);
        expect(lines[4]).toContain('provider_unavailable');
        const callId = taskCallId(deepAgent.calls[1]?.messages ?? []);
        expect(lines.at(-1)).toContain(`read_tool_result (callId "${callId}")`);

        // Then: the full table is stored under the call with every whole answer, and read_tool_result reads it
        const [stored] = await harness.db
          .select({ text: toolResults.text })
          .from(toolResults)
          .where(
            and(
              eq(toolResults.conversationId, deepAgentId),
              eq(toolResults.callId, callId),
            ),
          );
        for (const [index, item] of items.entries()) {
          if (index !== 2) expect(stored?.text).toContain(answerOf(item));
        }
        const read = (await historyOf(harness, deepAgentId, ownerId)).find(
          (entry) =>
            entry.kind === 'tool_result' &&
            entry.content.tool === 'read_tool_result',
        );
        expect(read?.kind === 'tool_result' ? read.content.outcome : null).toBe(
          'success',
        );
        expect(read?.kind === 'tool_result' ? read.content.text : '').toContain(
          '| 1 | Москва | completed | Answer for Москва:',
        );
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
