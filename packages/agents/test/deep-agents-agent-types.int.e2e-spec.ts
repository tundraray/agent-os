// deep-agents / agent-types - agents-package integration skeleton (in-process `createRuntime` + `createAgents` over real Postgres, real MCP fixture process, scripted model)
// Design Doc: docs/features/deep-agents/design-agent-types.md (v1.2, Draft), Test Strategy UC-7, UC-8 (wiring half), KD-5, DC-4, Invariants 1 and 2
// PRD: docs/features/deep-agents/prd.md FR-04, FR-09 (AC-04.1, AC-04.2, AC-09.1, AC-09.2)
// Generated: 2026-11-22 | Part: agent-types | Test type: Integration (no E2E file in this package)
// Implementation timing: written alongside the plan slice (`agent_run_tasks`, `task_list`, the plan block of the model and compaction steps, the open-items input of `endOfTurn`) and run once, at the end of the part.
//
// File name follows the repo convention of the `agents` package (`<feature>-<part>.int.e2e-spec.ts` under packages/agents/test, run with `pnpm --filter @agent-os/agents test:e2e`). The test is `it.todo`:
// the comments above it are its specification; the implementing task replaces `it.todo` by `it`, adds the imports and fills the body.
//
// Harness: `createAgentsHarness` of support/agentsHarness.ts (real Postgres, real runtime and agents, scripted `ModelClient` as the only model double), the library double extended with a `deep_agent`
// record kind (a team of two subagents and a final subagent). "The restarted server" is a second harness over the same database (`createAgentsHarness` again, as agent-platform-agents INT-3 C does);
// a lost step is `expireLease` as in INT-3 E. A unique owner `newUser()` per test; no sleeps, `script.called(n)` and `waitForTaskStatus` order the steps.
//   Support the implementation tasks add (not skeletons): `LibraryDoubleRecord` gets the `deep_agent` kind; a reader `planRowsOf(db, sessionId)` over `app.agent_run_tasks`;
//   a model-input reader for the LAST line of the system prompt of a recorded call (`script.calls[n].system`).
//
// Budget: Integration 1 here (INT-3). With INT-1 and INT-2 (apps/api) the part uses 3 of 3; INT-3 names its defects below. E2E 0 in this package.
//
// Proven elsewhere (the plan reads this to avoid a second test for an AC already proven):
// - unit, packages/agents/src/step/turn-rules.spec.ts (extend the `endOfTurn` table): deep agent with no children in work x {open item `waiting`, open item `running`, all `done` or `cancelled`, no plan}, and the
//   order of branches (open items before the final-subagent rule; root, plain agent and subagent unchanged) - UC-8, AC-09.1 (rule), AC-09.2
// - unit, `task_list` rule table (next to the tool): `add` numbers from 1 and never reuses a number; `set` of an unknown number, a move out of `done` or `cancelled`, `failed` from an agent, an empty call and a
//   plan over the code limit -> `invalid_arguments` with its text - KD-5, Invariant 2
// - unit, `gateStart` table (extend): deep agent x {name in the team, name outside it, id of a `deep_agent` record, `maxRuns` reached}, and agent x {id of a `deep_agent` record} -> `not_allowed` / `run_limit`
//   - UC-5, AC-02.1, AC-03.2, DC-2, DC-3. The wiring (a refused start creates no task, session or ledger row) is proven by the rewritten INT-1 D below, not again here.
// - rewritten existing, packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-1 D (final subagent's report becomes the session's report, an answer before it gets a notice, a start outside the team is
//   refused without creating a task) and packages/agents/test/agent-platform-workflows.int.e2e-spec.ts INT-2 A, INT-3 B (the research run end to end: plan, two gather agents, early answer notice, report as the
//   run's answer) - they move here onto `deep_agent` as the one proof of UC-6 / AC-02.2 / AC-05.1 / AC-05.2 / AC-07.1 / AC-03.2. Nothing of them is restated in this file.
// - rewritten existing, agent-platform-workflows INT-1 (the brief: nothing starts before the decision, an edited question reaches the run, one run per request, a decline starts nothing) moves with
//   `start_workflow` into `agents` as the `start_deep_agent` test - AC-03.1.
// - existing, agent-platform-agents INT-4 (every agents operation called as another owner answers as for a missing agent): the new `tasks` read of `GET /api/agents/:agentId/tasks` is ONE MORE ROW of its table
//   (owner sees the three items; another employee and an unknown id answer `AGENT_NOT_FOUND`) - UC-7 second half, AC-04.1 isolation. Not a new test; the plan adds the row to that file.
// - rewritten existing, self-learning-core INT-1..INT-12 on `deep_agent` (the learning run row is written at start, the extraction task after the end) - UC-9, AC-08.1; the flag reaching `learningRunOf` is the
//   rewritten INT-1 there.
//
// acProof of this file: AC-04.2: INT-3 rows A and B; AC-04.1 (model side): INT-3 row B; AC-09.1 (wiring), AC-09.2: INT-3 row C; DC-4: INT-3 row B

import { createLatch, createLibraryDouble, createScriptedModel, inputLines } from '@agent-os/agents/testing';
import { createFixtureFiles, fixtureCallsOf, holdCall } from '@agent-os/mcp-fixture';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  childNoticesOf,
  closeAll,
  createAgentsHarness,
  expireLease,
  historyLines,
  historyOf,
  PLAN_BLOCK_HEADING,
  planBlockLinesOf,
  planRowsOf,
  START_TEST_DEEP_AGENT,
  testDeepAgent,
  testRecord,
  testSubagent,
  TEST_MODEL_DEFAULT,
  toolCallRowsOf,
  waitFor,
  waitForTaskStatus,
} from './support/agentsHarness';
import { LOGS_SERVER } from './support/mcp-servers';
import { newUser } from './support/new-user';

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

describe('deep-agents / agent-types - the plan belongs to the run: written with the step, read at every step, never lost or doubled', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: the plan survives a lost step, a restart and compaction, and the model is stopped by it when it answers with open items
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-04.1 "Given глубокий агент добавил три пункта и первый перевёл в «в работе», when сотрудник открывает экран агента, then видит три пункта и их статусы." (the read side: the rows and the model's block)
  //   AC-04.2 "Given у запуска есть план, when сервер перезапустился или сотрудник продолжил работу сообщением, then план тот же, с теми же статусами."
  //   AC-09.1 "Given в плане пункт «в работе», when глубокий агент отвечает текстом, then ответ не принят, а агент видит уведомление с этим пунктом."
  //   AC-09.2 "Given все пункты плана «готова» или «отменена», when глубокий агент отвечает текстом, then ответ принят."
  //   DC-4 "Модель видит план целиком в начале каждого шага, в том числе после сжатия истории."
  //   Invariants 1, 2: "Пункт плана пишется и меняется в транзакции шага своего запуска, вместе с `tool_result` вызова, который его изменил." / "Номер пункта не меняется и не повторяется в запуске."
  //   Design: UC-7, UC-8 (wiring); KD-5; Flow 2 (the open-items branch).
  // Behavior: a deep agent session calls `task_list` (add three items, set the first `running`) -> the rows are written in the step's transaction with the `tool_result` -> the step is lost after the commit and
  //   replayed, the server restarts, the employee writes a message, the history is compacted -> every model call and the compaction call see the same plan as a block at the end of the system prompt -> a text
  //   answer with an open item gets a `notice` naming it, and with all items closed ends the run.
  // Catches: (1) the plan kept only in the history or in memory - lost by compaction (the summary replaces the history) or by a restart; (2) a replayed step writing the three items twice (items 4-6), or the
  //   numbers restarting at 1 after the restart (the write not in the step's transaction, or not idempotent with the `tool_result`); (3) the plan block missing from the COMPACTION call or from the first step after
  //   it - the model then re-plans from the summary; (4) the open items not read from the table before `endOfTurn` (the rule is unit-correct, the step feeds it an empty list) so the early answer of the
  //   deep agent is accepted with work open.
  // @category: core-functionality
  // @dependency: createRuntime, createAgents (`task_list`, step handler, compaction step, endOfTurn input), library double with a `deep_agent` record, scripted model double, Postgres (agent_run_tasks)
  // @complexity: high
  //
  // Verification items (one scripted deep agent run, started by the root as a `deep_agent` record of the library; the model's literal texts and numbers are written in the test):
  // - Row A "lost step and restart" (AC-04.2, Invariants 1-2): answer 1 is `task_list { add: ['собрать логи', 'сверить с заказами', 'написать вывод'] }` together with a read call `get_trace` that the fixture
  //   holds, so the tool step of instance A (a zombie: one slot, a lease only the test expires) is in flight before its commit. Instance B over the same database is the restarted server: the lease is expired
  //   (`expireLease`) and B replays the tool step. The rows are exactly three (numbers 1-3, waiting), the `tool_result` of `task_list` stands once in the history, and the zombie's late commit is rejected and
  //   writes nothing. Answer 2 is `task_list { set: [{ number: 1, status: 'running' }] }`. After the run ends, a message from the owner continues the deep agent on B: its model input shows the same plan, and a
  //   further `add` gets number 4 (not 1).
  // - Row B "block at every step and after compaction" (AC-04.1, DC-4): with `AGENT_COMPACT_AT_TOKENS` low, the answer of step 2 reports usage over it so the next step is a compaction. Then: the recorded model call of
  //   step 1 (before any item exists) carries no items, calls of steps 2 and 3 end their system prompt with the block listing `1 running`, `2 waiting`, `3 waiting` and the item texts; the compaction call carries the
  //   same block; the first step after compaction carries it too; the block is not in any history entry (`historyOf` has no line with the block's text).
  // - Row C "answer with open items" (AC-09.1, AC-09.2): the deep agent has no children in work. Its text answer while item 1 is `running` -> the next model input holds a `notice` whose text names the number 1
  //   and the item text, and the run is not finished (status still active); after `task_list { set: [1 done, 2 cancelled, 3 done] }` the next text answer ends the run with that text as its report.
  it('INT-3: the plan is written with the step and survives a replayed step, a restart and compaction without a double or a renumbering, and an answer with an open item is refused with a notice naming it', async () => {
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
          { tool: 'task_list', args: { add: ['собрать логи', 'сверить с заказами', 'написать вывод'] } },
          { tool: GET_TRACE, args: TRACE_A },
        ],
      },
      {
        calls: [{ tool: 'task_list', args: { set: [{ number: 1, status: 'running' }] } }],
        usage: { inputTokens: COMPACT_AT_TOKENS },
        latch: secondCallHeld,
      },
      { text: 'summary of the plan work' },
      { text: 'early done' },
      {
        calls: [
          {
            tool: 'task_list',
            args: {
              set: [
                { number: 1, status: 'done' },
                { number: 2, status: 'cancelled' },
                { number: 3, status: 'done' },
              ],
            },
          },
        ],
      },
      { text: 'all done' },
      { calls: [{ tool: 'task_list', args: { add: ['перепроверить вывод'] } }] },
      { calls: [{ tool: 'task_list', args: { set: [{ number: 4, status: 'done' }] } }] },
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
        zombie: true,
        runtimeConfig: { concurrency: 1, leaseMs: 600_000 },
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

      // Then: nothing of the plan is written before the commit
      expect(await planRowsOf(zombie.db, deepAgentId)).toEqual([]);

      // When: the restarted server starts, the zombie's lease expires and the restarted server replays the tool step
      const restarted = await createAgentsHarness(options);
      harnesses.push(restarted);
      await expireLease(zombie.db, deepAgentId);
      await secondCallHeld.reached();

      // Then (row A): three items, numbered 1-3, written once; the call has one result
      expect(await planRowsOf(restarted.db, deepAgentId)).toEqual([
        '1 waiting собрать логи',
        '2 waiting сверить с заказами',
        '3 waiting написать вывод',
      ]);
      expect(historyLines(await historyOf(restarted, deepAgentId, ownerId))).toEqual([
        'task: Plan the work',
        `model_answer:  [task_list, ${LOGS_SERVER}/get_trace]`,
        'tool_result: task_list success',
        'tool_result: get_trace success',
      ]);

      // When: the run goes on: the first item starts, the history is compacted, the deep agent answers early,
      // closes the items and answers again
      secondCallHeld.open();
      await waitForTaskStatus(restarted, deepAgentId, ownerId, 'completed');

      // Then (row C): the early answer met a notice naming the open items, and the answer after they closed
      // ended the run as its report
      const openNotice = [
        'You cannot finish yet: these items of your plan are still open:',
        '1. [running] собрать логи',
        '2. [waiting] сверить с заказами',
        '3. [waiting] написать вывод',
        'Do the work they name, or mark each done or cancelled with task_list, then answer.',
      ].join('\n');
      expect(inputLines(deepAgent.calls[4]?.messages ?? []).join('\n')).toContain(openNotice);
      const reports = (await childNoticesOf(restarted.db, rootId, deepAgentId)).map(
        (notice) => `${notice.payload.status} ${notice.payload.result?.report ?? ''}`,
      );
      expect(reports).toEqual(['completed all done']);

      // Then (row B): no block before any item; the same plan at the end of the system text of every later
      // call, the compaction call and the first call after it included
      const blockOf = (call: number) => planBlockLinesOf(deepAgent.calls[call]?.instructions ?? '');
      const started = [
        PLAN_BLOCK_HEADING,
        '1. [running] собрать логи',
        '2. [waiting] сверить с заказами',
        '3. [waiting] написать вывод',
      ];
      const closed = [
        PLAN_BLOCK_HEADING,
        '1. [done] собрать логи',
        '2. [cancelled] сверить с заказами',
        '3. [done] написать вывод',
      ];
      expect(blockOf(0)).toEqual([]);
      expect(blockOf(1)).toEqual([
        PLAN_BLOCK_HEADING,
        '1. [waiting] собрать логи',
        '2. [waiting] сверить с заказами',
        '3. [waiting] написать вывод',
      ]);
      expect(inputLines(deepAgent.calls[2]?.messages ?? []).at(-1)).toMatch(
        new RegExp(`^${COMPACTION_REQUEST_START}`),
      );
      expect(blockOf(2)).toEqual(started);
      expect(blockOf(3)).toEqual(started);
      expect(blockOf(4)).toEqual(started);
      expect(blockOf(5)).toEqual(closed);

      // When: the owner continues the finished deep agent with a message on the restarted server
      await restarted.sessions.send({ agentId: deepAgentId, ownerId, text: 'Add one more check' });
      await deepAgent.called(9);
      await waitForTaskStatus(restarted, deepAgentId, ownerId, 'completed');

      // Then (row A): the message's step sees the same plan, and the new item gets number 4
      expect(blockOf(6)).toEqual(closed);
      expect(await planRowsOf(restarted.db, deepAgentId)).toEqual([
        '1 done собрать логи',
        '2 cancelled сверить с заказами',
        '3 done написать вывод',
        '4 done перепроверить вывод',
      ]);

      // Then: the block is in no history entry, and the history holds every step once
      const history = historyLines(await historyOf(restarted, deepAgentId, ownerId));
      expect(history.filter((line) => line.includes(PLAN_BLOCK_HEADING))).toEqual([]);
      expect(history).toEqual([
        'task: Plan the work',
        `model_answer:  [task_list, ${LOGS_SERVER}/get_trace]`,
        'tool_result: task_list success',
        'tool_result: get_trace success',
        'model_answer:  [task_list]',
        'tool_result: task_list success',
        'compaction: summary of the plan work',
        'event: compacted',
        'model_answer: early done []',
        `notice: ${openNotice}`,
        'model_answer:  [task_list]',
        'tool_result: task_list success',
        'model_answer: all done []',
        'event: continued',
        'user_message: Add one more check',
        'model_answer:  [task_list]',
        'tool_result: task_list success',
        'model_answer:  [task_list]',
        'tool_result: task_list success',
        'model_answer: done again []',
      ]);

      // When: the zombie's held read call answers
      traceHeld.release();
      await waitFor(
        () => zombie.logs.filter((record) => record.message === REJECTED_STEP && record.fields.taskId === deepAgentId),
        (records) => records.length === 1,
        'the zombie tool step result to be rejected',
      );

      // Then: its late commit wrote nothing: still four items and the same history
      expect(await planRowsOf(restarted.db, deepAgentId)).toHaveLength(4);
      expect(historyLines(await historyOf(restarted, deepAgentId, ownerId))).toEqual(history);
    } finally {
      traceHeld.release();
      await closeAll(harnesses);
    }
  }, TEST_TIMEOUT_MS);
});
