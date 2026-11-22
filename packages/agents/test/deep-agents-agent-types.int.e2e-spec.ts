// deep-agents / task-list - agents-package integration test (in-process `RuntimeModule` + `createAgents` over real Postgres, real MCP fixture process, scripted model)
// Design Doc: docs/features/deep-agents/design-task-list.md, Test Strategy UC-3, KD-1 – KD-4, DC-3
// PRD: docs/features/deep-agents/prd.md FR-13, FR-14 (AC-13.1, AC-14.5)
// Test type: Integration, run with `pnpm --filter @agent-os/agents test:e2e`.
//
// Harness: `createAgentsHarness` of support/agentsHarness.ts (real Postgres, real runtime and agents, scripted `ModelClient` as the only model double), the library double with a `deep_agent` record.
// "The restarted server" is a second harness over the same database; a lost step is a step held on the first harness (`ZOMBIE_RUNTIME`), which the start of the second requeues. A unique owner `newUser()` per test; no sleeps, `script.called(n)` and `waitForTaskStatus`
// order the steps.
//
// Proven elsewhere (not restated here):
// - unit, packages/agents/src/tools/system/task-list-rules.spec.ts - UC-1: numbering, blockers, cycles, deletion, limits.
// - unit, packages/agents/src/agent/turn-rules.spec.ts - AC-14.4: the open-tasks branch of `endOfTurn` and its order.
// - existing, packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-4 - UC-2: isolation of the list (another employee, a subagent, the root's list).

import { createLatch, createLibraryDouble, createScriptedModel, inputLines } from '@agent-os/agents/testing';
import { createFixtureFiles, fixtureCallsOf, holdCall } from '@agent-os/mcp-fixture';
import { describe, expect, it } from 'vitest';
import { TASK_BLOCK_HEADING } from '../src/tools/system/task-list-block';
import {
  type AgentsHarness,
  childNoticesOf,
  closeAll,
  createAgentsHarness,
  ZOMBIE_RUNTIME,
  historyLines,
  historyOf,
  sessionTaskRowsOf,
  START_TEST_DEEP_AGENT,
  taskBlockLinesOf,
  testDeepAgent,
  testRecord,
  testSubagent,
  TEST_MODEL_DEFAULT,
  toolCallRowsOf,
  waitForTaskStatus,
} from './support/agentsHarness';
import { LOGS_SERVER } from './support/mcp-servers';
import { newUser, waitFor } from '@agent-os/db/testing';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** `AGENT_COMPACT_AT_TOKENS` of the test: an answer that reports this many input tokens makes the next step a compaction. */
const COMPACT_AT_TOKENS = 5_000;

/** The fixture's read tool `get_trace` (the `logs` server) as the model names it, and its arguments. */
const GET_TRACE = `mcp__${LOGS_SERVER}__get_trace`;
const TRACE_A = { traceId: 'a'.repeat(32) };

/** The log record of a step result the runtime rejected because its attempt was lost. */
const REJECTED_STEP = 'step result rejected: the attempt is no longer current';

/** The first line of the request that follows the history in a compaction call (`compaction-step.ts`). */
const COMPACTION_REQUEST_START = 'user: The conversation above is getting too long.';

/** A scripted `task_create` call. */
function taskCreate(subject: string, activeForm?: string) {
  return {
    tool: 'task_create',
    args: { subject, description: `Описание: ${subject}`, ...(activeForm === undefined ? {} : { activeForm }) },
  };
}

/** A scripted `task_update` call. */
function taskUpdate(taskId: number, status: string) {
  return { tool: 'task_update', args: { taskId, status } };
}

/** The deep agent the root started: the child of its first tool call. */
async function startedDeepAgent(harness: AgentsHarness, rootId: string): Promise<string> {
  const calls = await waitFor(
    () => toolCallRowsOf(harness.db, rootId),
    (rows) => rows.some((row) => row.childTaskId !== null),
    `the deep agent of root ${rootId}`,
  );
  const childId = calls.find((row) => row.childTaskId !== null)?.childTaskId;
  if (childId === undefined || childId === null) throw new Error(`root ${rootId} started no deep agent`);
  return childId;
}

describe('deep-agents / task-list - the list belongs to the session: written with the step, read at every step, never lost or doubled', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // UC-3: the list survives a replayed step, a restart, compaction and a continuation, and an answer with open tasks is refused
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-13.1 (the list is the same after a restart, a compaction and a new message), AC-14.5 (the model sees the list at every step), DC-3 (a replayed step does not create a task twice);
  //   the wiring of AC-14.4 (the step feeds `endOfTurn` the open tasks read from the table).
  // Catches: (1) the list kept only in the history or in memory - lost by compaction or a restart; (2) a replayed step writing the three tasks twice (tasks 4-6), or the numbers restarting at 1 after the
  //   restart; (3) the task block missing from the COMPACTION call or from the first step after it; (4) the open tasks not read from the table before `endOfTurn`, so the early answer is accepted.
  // Verification items (one scripted deep agent run, started by the root as a `deep_agent` record of the library):
  // - Row A "lost step and restart": answer 1 creates three tasks together with a read call `get_trace` that the fixture holds, so the tool step of instance A (a zombie) is in flight before its commit.
  //   Instance B over the same database replays the tool step: the rows are exactly three (numbers 1-3, pending), each `tool_result` stands once, the zombie's late commit writes nothing. After the run
  //   ends, a message continues the deep agent on B: its model input shows the same list, and a further `task_create` gets number 4.
  // - Row B "block at every step and after compaction": calls after the first end their system text with the block, a task in progress by its active form; the compaction call carries the same block; the
  //   first step after it too; the block is in no history entry.
  // - Row C "answer with open tasks": a text answer while tasks are open gets a `notice` naming them; after every task is completed the next text answer ends the run with that text as its report.
  it('UC-3: the task list is written with the step and survives a replayed step, a restart, compaction and a new message without a double or a renumbering, and an answer with open tasks is refused', async () => {
    // Given: a deep agent record with one subagent and the `logs` server; the root starts it; the deep agent's
    // first read call is held on the fixture, and its second model call is held by a latch
    const ownerId = newUser();
    const library = createLibraryDouble();
    const deepAgentRecordId = library.add(
      testDeepAgent('planning deep agent', {
        prompt: 'You plan the work and do it.',
        servers: [LOGS_SERVER],
        model: TEST_MODEL_DEFAULT,
        maxTurns: 20,
        subagents: [testSubagent('helper')],
        finalSubagent: null,
        taskList: true,
        listDelegation: true,
        selfLearning: false,
      }),
    );
    const fixture = createFixtureFiles();
    const traceHeld = fixture.latch('trace-held');
    fixture.setFaults([holdCall('get_trace', TRACE_A, traceHeld)]);
    const secondCallHeld = createLatch();
    const model = createScriptedModel();
    model.script(
      { task: 'Start the planner' },
      [
        {
          calls: [
            {
              tool: START_TEST_DEEP_AGENT,
              args: { deepAgent: deepAgentRecordId, prompt: 'Plan the work', description: 'planner' },
            },
          ],
        },
      ],
      { thereafter: { text: 'noted' } },
    );
    const deepAgent = model.script({ agent: 'planning deep agent' }, [
      {
        calls: [
          taskCreate('Собрать логи', 'Собираю логи'),
          taskCreate('Сверить с заказами'),
          taskCreate('Написать вывод'),
          { tool: GET_TRACE, args: TRACE_A },
        ],
      },
      {
        calls: [taskUpdate(1, 'in_progress')],
        usage: { inputTokens: COMPACT_AT_TOKENS },
        latch: secondCallHeld,
      },
      { text: 'summary of the task work' },
      { text: 'early done' },
      { calls: [taskUpdate(1, 'completed'), taskUpdate(2, 'completed'), taskUpdate(3, 'completed')] },
      { text: 'all done' },
      { calls: [taskCreate('Перепроверить вывод')] },
      { calls: [taskUpdate(4, 'completed')] },
      { text: 'done again' },
    ]);
    const options = {
      model,
      fixture,
      library,
      access: { [ownerId]: [LOGS_SERVER] },
      root: testRecord('root'),
      deepAgentStarter: true,
      variables: { AGENT_COMPACT_AT_TOKENS: String(COMPACT_AT_TOKENS) },
    };
    const harnesses: AgentsHarness[] = [];
    try {
      const zombie = await createAgentsHarness({
        ...options,
        runtimeConfig: ZOMBIE_RUNTIME,
      });
      harnesses.push(zombie);
      const { agentId: rootId } = await zombie.sessions.start({
        ownerId,
        prompt: 'Start the planner',
        description: 'root',
      });
      const deepAgentId = await startedDeepAgent(zombie, rootId);

      // When: the zombie's tool step holds the read call, before its commit
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A }),
        (calls) => calls.length === 1,
        'the held read call of the zombie',
      );

      // Then: nothing of the list is written before the commit
      expect(await sessionTaskRowsOf(zombie.db, deepAgentId)).toEqual([]);

      // When: the restarted server starts, requeues the zombie's step as a lost one and replays the tool step
      const restarted = await createAgentsHarness(options);
      harnesses.push(restarted);
      await secondCallHeld.reached();

      // Then (row A): three tasks, numbered 1-3, written once; each call has one result
      expect(await sessionTaskRowsOf(restarted.db, deepAgentId)).toEqual([
        '1 pending Собрать логи',
        '2 pending Сверить с заказами',
        '3 pending Написать вывод',
      ]);
      const firstAnswer = [
        'task: Plan the work',
        `model_answer:  [task_create, task_create, task_create, ${LOGS_SERVER}/get_trace]`,
        'tool_result: task_create success',
        'tool_result: task_create success',
        'tool_result: task_create success',
        'tool_result: get_trace success',
      ];
      expect(historyLines(await historyOf(restarted, deepAgentId, ownerId))).toEqual(firstAnswer);

      // When: the run goes on: the first task starts, the history is compacted, the deep agent answers early,
      // completes the tasks and answers again
      secondCallHeld.open();
      await waitForTaskStatus(restarted, deepAgentId, ownerId, 'completed');

      // Then (row C): the early answer met a notice naming the open tasks, and the answer after they were
      // completed ended the run as its report
      const openNotice = [
        'You cannot finish yet: these tasks of your list are still open:',
        '1. [in_progress] Собираю логи',
        '2. [pending] Сверить с заказами',
        '3. [pending] Написать вывод',
        'Do the work they name and mark each completed with task_update, or delete the ones no longer needed; then answer.',
      ].join('\n');
      expect(inputLines(deepAgent.calls[4]?.messages ?? []).join('\n')).toContain(openNotice);
      const reports = (await childNoticesOf(restarted.db, rootId, deepAgentId)).map(
        (notice) => `${notice.payload.status} ${notice.payload.result?.report ?? ''}`,
      );
      expect(reports).toEqual(['completed all done']);

      // Then (row B): no block before any task; the same list at the end of the system text of every later
      // call, the compaction call and the first call after it included
      const blockOf = (call: number) => taskBlockLinesOf(deepAgent.calls[call]?.instructions ?? '');
      const started = [
        TASK_BLOCK_HEADING,
        '1. [in_progress] Собираю логи',
        '2. [pending] Сверить с заказами',
        '3. [pending] Написать вывод',
      ];
      const completed = [
        TASK_BLOCK_HEADING,
        '1. [completed] Собрать логи',
        '2. [completed] Сверить с заказами',
        '3. [completed] Написать вывод',
      ];
      expect(blockOf(0)).toEqual([]);
      expect(blockOf(1)).toEqual([
        TASK_BLOCK_HEADING,
        '1. [pending] Собрать логи',
        '2. [pending] Сверить с заказами',
        '3. [pending] Написать вывод',
      ]);
      expect(inputLines(deepAgent.calls[2]?.messages ?? []).at(-1)).toMatch(
        new RegExp(`^${COMPACTION_REQUEST_START}`),
      );
      expect(blockOf(2)).toEqual(started);
      expect(blockOf(3)).toEqual(started);
      expect(blockOf(4)).toEqual(started);
      expect(blockOf(5)).toEqual(completed);

      // When: the owner continues the finished deep agent with a message on the restarted server
      await restarted.sessions.send({ agentId: deepAgentId, ownerId, text: 'Add one more check' });
      await deepAgent.called(9);
      await waitForTaskStatus(restarted, deepAgentId, ownerId, 'completed');

      // Then (row A): the message's step sees the same list, and the new task gets number 4
      expect(blockOf(6)).toEqual(completed);
      expect(await sessionTaskRowsOf(restarted.db, deepAgentId)).toEqual([
        '1 completed Собрать логи',
        '2 completed Сверить с заказами',
        '3 completed Написать вывод',
        '4 completed Перепроверить вывод',
      ]);

      // Then: the block is in no history entry, and the history holds every step once
      const history = historyLines(await historyOf(restarted, deepAgentId, ownerId));
      expect(history.filter((line) => line.includes(TASK_BLOCK_HEADING))).toEqual([]);
      expect(history).toEqual([
        ...firstAnswer,
        'model_answer:  [task_update]',
        'tool_result: task_update success',
        'compaction: summary of the task work',
        'event: compacted',
        'model_answer: early done []',
        `notice: ${openNotice}`,
        'model_answer:  [task_update, task_update, task_update]',
        'tool_result: task_update success',
        'tool_result: task_update success',
        'tool_result: task_update success',
        'model_answer: all done []',
        'event: continued',
        'user_message: Add one more check',
        'model_answer:  [task_create]',
        'tool_result: task_create success',
        'model_answer:  [task_update]',
        'tool_result: task_update success',
        'model_answer: done again []',
      ]);

      // When: the zombie's held read call answers
      traceHeld.release();
      await waitFor(
        () => zombie.logs.filter((record) => record.message === REJECTED_STEP && record.fields.taskId === deepAgentId),
        (records) => records.length === 1,
        'the zombie tool step result to be rejected',
      );

      // Then: its late commit wrote nothing: still four tasks and the same history
      expect(await sessionTaskRowsOf(restarted.db, deepAgentId)).toHaveLength(4);
      expect(historyLines(await historyOf(restarted, deepAgentId, ownerId))).toEqual(history);
    } finally {
      traceHeld.release();
      await closeAll(harnesses);
    }
  }, TEST_TIMEOUT_MS);
});
