// custom-agents / runtime - agents-package integration skeleton (in-process `createRuntime` + `createAgents` over real Postgres, scripted model, library double)
// Design Doc: docs/features/custom-agents/design-runtime.md (v1.1), Test Strategy UC-5, UC-E1, UC-E2 (the start procedure and the snapshot);
//   PRD: docs/features/custom-agents/prd.md FR-13, FR-14 (AC-13.1 .. AC-13.4, AC-14.1, AC-14.3, AC-14.4).
// Generated: 2026-11-17
// Part: runtime. THE PART'S BUDGET, THE FULL acProof AND THE LIST OF UNIT TABLES ARE IN `apps/api/test/custom-agents-runtime.int.e2e-spec.ts` (one place;
//   this file holds INT-1 of 4). Sibling skeleton files of the part: packages/workflows/test/custom-agents-runtime.int.e2e-spec.ts (INT-2),
//   apps/api/test/custom-agents-runtime.int.e2e-spec.ts (INT-3, INT-4).
// Test Type: Integration. Run with `pnpm --filter @agent-os/agents test:e2e` (`vitest.config.e2e.ts`, `*.e2e-spec.ts`), never in the default `vitest run`.
//
// Harness (follows agent-platform-agents.int.e2e-spec.ts and test/support/agentsHarness.ts):
//   real Postgres, real `createRuntime` and `createAgents`, workers on; the scripted `ModelClient` is the only model double and records the
//   input of every call (the assertion surface for "the next model call carries prompt X"; the system prompt is read by a thin wrapper of
//   its `turnClient`, below); the MCP fixture process is the real one. The library is `options.library` - a `createLibraryDouble` of
//   `@agent-os/agents/testing` (records in memory with owner, "visible to all", viewers; operations to edit a record into a new version,
//   delete it, close it to the runner and hide it from one viewer) passed to `createAgents({ library })`; the access gate double of the
//   harness refuses a model per owner (`ownerModelRefusals`, read on every question) and answers `model_not_connected` for a model
//   without a price. Mock boundary: the library double stands for `LibraryService` ONLY (its visibility and version rules are proven in
//   the `library` part against the real service); the runtime, the agents package, the snapshot in `runtime_tasks.input`, the tool gate
//   and the history are all real. A second instance (`zombie` + `expireLease`) is the "restarted server" exactly as in agents INT-3 row E.
//   Isolation: a unique runner `newUser()` (an author is a fresh uuid) and unique records per test.
//
// Proven elsewhere, not repeated here (CLAUDE.md: one test at the lowest level that catches the defect):
//   - `resolveStart` as a function over the two ports: the table of start kinds x outcomes lives in `packages/agents/src/start/resolve-start.spec.ts`
//       (unit, the double, no database) - see the list in the api file. This file proves only what the table cannot see: that the snapshot
//       reaches the real task input, the real steps and the real restart.
//   - The access of the run (Jira absent for Boris, no call with either account - AC-14.2) is the unchanged `AccessGate` and tool gate:
//       agents INT-3 row A of agent-platform-agents.int.e2e-spec.ts (rewritten onto the library double by the implementation tasks, not duplicated).
//   - Process kill and step recovery at the commit boundary: runtime E2E-1 and agents INT-3 row E. Row A here reuses that technique once only to
//       show the snapshot is in Postgres, not in memory.

import { randomUUID } from 'node:crypto';
import type { AgentTurnMessage, AgentTurnModelClient } from '@agent-os/agents';
import {
  createLatch,
  createLibraryDouble,
  createScriptedModel,
  inputLines,
  type RecordedModelCall,
  type ScriptedModel,
  type ScriptedToolCall,
} from '@agent-os/agents/testing';
import type { LogRecord } from '@agent-os/common';
import type { Database } from '@agent-os/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  closeAll,
  createAgentsHarness,
  expireLease,
  historyLines,
  historyOf,
  ledgerRowsOf,
  START_TEST_WORKFLOW,
  setRootRecord,
  TEST_AUTHOR_ID,
  TEST_MODEL_CHOSEN,
  testRecord,
  toolCallRowsOf,
  waitFor,
  waitForTaskStatus,
} from './support/agentsHarness.js';
import { newUser } from './support/new-user.js';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** A model the access gate double has no price for: `model_not_connected`. */
const UNCONNECTED_MODEL = 'anthropic/test-unconnected';

/** The refusal `ownerModelRefusals` gives for a model taken from an owner. */
const MODEL_NOT_ALLOWED = { kind: 'refused', reason: 'model_not_allowed' } as const;

/** A built-in call that needs no server; a record without `list_agents` in its tools gets it refused. */
const LIST_AGENTS: ScriptedToolCall = { tool: 'list_agents', args: {} };

/** A `start_agent` call of a scripted answer: `agent` is a record id, an executor's name or `fork`. */
function startAgent(args: { agent: string; description: string; prompt: string }): ScriptedToolCall {
  return { tool: 'start_agent', args };
}

/** Agents the agent started, in the order of its starting calls (`start_agent`, `start_test_workflow`). */
async function startedChildrenOf(harness: AgentsHarness, agentId: string): Promise<string[]> {
  const calls = await toolCallRowsOf(harness.db, agentId);
  return calls.flatMap((call) => (call.childTaskId !== null ? [call.childTaskId] : []));
}

/** Waits until the agent has started `count` children (1 by default) and returns the last of them. */
async function startedChild(harness: AgentsHarness, agentId: string, count = 1): Promise<string> {
  const children = await waitFor(
    () => startedChildrenOf(harness, agentId),
    (started) => started.length >= count,
    `child ${count} of agent ${agentId}`,
  );
  const child = children[count - 1];
  if (child === undefined) throw new Error(`agent ${agentId} started no child ${count}`);
  return child;
}

/**
 * The scripted model with each call's system prompt kept beside it: the double records the messages,
 * the model and the tools, and this wrapper of its `turnClient` the instructions, keyed by the call's
 * message list (the double records that very array). `lineOf` gives a call as
 * `<prompt> | <model> | <tool>, …`, the prompt being the record's own text before the package's preamble.
 */
function withPrompts(scripted: ScriptedModel): {
  readonly model: ScriptedModel;
  readonly lineOf: (call: RecordedModelCall | undefined) => string;
} {
  const prompts = new WeakMap<readonly AgentTurnMessage[], string>();
  const turnClient: AgentTurnModelClient = {
    streamTurn(call, options) {
      prompts.set(call.messages, call.instructions);
      return scripted.turnClient.streamTurn(call, options);
    },
  };
  return {
    model: { ...scripted, turnClient },
    lineOf: (call) => {
      if (call === undefined) return 'no call';
      const prompt = (prompts.get(call.messages) ?? '').split('\n\n')[0];
      return `${prompt} | ${call.model} | ${call.toolNames.join(', ')}`;
    },
  };
}

/** The owner's agents and their sessions as rows: a refused start or restart adds to neither. */
async function ownerRowCounts(db: Database, ownerId: string): Promise<{ tasks: number; sessions: number }> {
  const { rows } = await db.execute(sql`
    SELECT (SELECT count(*) FROM app.runtime_tasks WHERE owner_id = ${ownerId})::int AS tasks,
           (SELECT count(*) FROM app.agent_sessions WHERE owner_id = ${ownerId})::int AS sessions`);
  return { tasks: Number(rows[0]?.tasks), sessions: Number(rows[0]?.sessions) };
}

/** Log records of an instance whose late step result for the task was refused (the attempt was taken over). */
function notCurrentLogsOf(harness: AgentsHarness, taskId: string): LogRecord[] {
  return harness.logs.filter(
    (record) => record.fields.taskId === taskId && record.message.endsWith('the attempt is no longer current'),
  );
}

describe('custom-agents / runtime - agents package (real runtime + Postgres, scripted model, library double)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: a start freezes the record's content, a restart takes the right snapshot, a refused start creates nothing
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-13.1 "Given агент Бориса работает на версии 1, when Аня сохраняет версию 2, then агент Бориса доделывает работу на версии 1,
  //   а следующий старт идёт на версии 2"; AC-13.2 "Given работающий агент запускает агента по записи, которую Аня удалила, then запуск
  //   отклонён, и родитель получает причину"; AC-13.3 "Given беседа создана до правки определения главного чата, when сотрудник пишет в
  //   неё, then чат отвечает по прежней копии, а новая беседа - по новой версии"; AC-14.1 "Given агенту Ани разрешено запускать её
  //   личного агента «сбор логов», when агент Ани работает в беседе Бориса и запускает «сбор логов», then запуск отклонён, потому что
  //   Борис эту запись не видит"; AC-14.3 "Given Бориса сняли с роли, when он или его агент запускает запись этой роли, then отказ с
  //   причиной"; AC-14.4 "Given в агенте Ани выбрана модель, на которую у Ани больше нет права, when Аня запускает агента из чата, then
  //   агент не стартует, а Аня видит, какая модель ей недоступна". Design: UC-5, UC-E1, UC-E2, DC-3, DC-4, DC-5, KD-1, KD-2, KD-3,
  //   invariants 1 and 2.
  // Behavior: a root (the `chat` record of the double) starts a child by a record number -> `resolveStart` asks the library for the RUNNER ->
  //   the snapshot is written into the child's task input -> every later step reads only that input; a restart picks its source by kind.
  // Rows (literal expected values; each row has its own owner, records and tree):
  //   A. Frozen copy (AC-13.1, AC-13.3, DC-3). Given Аня's agent R in version 1 shared with Борис, and Борис's root; When Борис's root starts R
  //      by its number and the child's first model call is held on a latch; Аня saves version 2 of R (another prompt, another tool set) in the
  //      double, and the administrator edits the `chat` record (another prompt); the second instance takes the child over after `expireLease`
  //      and the latch is released; Then the child's model inputs (before and after the takeover) carry the version-1 prompt and its tool set
  //      and never the version-2 prompt; Борис's root starts R again -> that child's inputs carry the version-2 prompt; the run origin of the
  //      first child says version 1, of the second version 2; the first child's tool call of a tool only version 2 has is refused by the gate
  //      (not in its snapshot). The root created BEFORE the `chat` edit answers its next message with the old chat prompt; a root created
  //      after the edit starts with the new one. "Запустить с нуля" of the finished first child (`sessions.restart`) starts a new agent on
  //      version 2 (DC-3; UXRD KD-7).
  //   B. Who restarts on whose copy (DC-3, DC-4, DC-5, invariant 2). Given a coordinator-style tree: an executor started from the snapshot of
  //      its coordinator (the executor's own source record is then deleted in the double) and a fork of a record-agent; When each finished
  //      agent is restarted; Then the executor restarts on its own stored snapshot although its source is gone (no library read: the double's
  //      call count of `resolve` did not move), the fork restarts on the snapshot of the caller it ran on and does not inherit the parent's
  //      history; Given the record of a restarted agent is then deleted -> `sessions.restart` is refused `START_REFUSED` with reason
  //      `record_unavailable`, and the number of agents under the parent did not change; Given the agent's model is no longer allowed to its
  //      owner (the access gate double) -> refused with reason `model_not_allowed` and the model's number, again no new agent.
  //   C. A refused start leaves a reason and nothing else (AC-13.2, AC-14.1, AC-14.3, AC-14.4, DC-5). Given Аня's agent that may start
  //      Аня's personal "сбор логов" (in its `agents`) running in Борис's tree; When it calls `start_agent` with that record's number; Then
  //      the call is refused with `record_unavailable` (the library double is asked for Борис, not for Аня), the parent's history holds the tool
  //      result with that reason, no child task and no `agent_sessions` row of that call exist, and no ledger row was written for it. The same
  //      refusal for a record deleted, a record closed to the runner, and a runner removed from the record's role (three setups, one assertion
  //      set). A start whose record's model is not allowed to the runner is refused `model_not_allowed` carrying the model's number, and a model
  //      with no connection `model_not_connected`; again no child, no ledger row, the root keeps answering.
  // Catches: a step that reads the library or an in-memory catalog after the start (an edit, a delete or a role change reaches a running
  //   agent); a snapshot kept only in the process (lost with a restart of the server); a restart of an executor or a fork that asks the library
  //   (and fails when the source is gone, or silently swaps it for the latest version); a record restart that copies the old snapshot (stale
  //   version against UXRD KD-7) or that creates the new agent before the check (a refused restart leaves a stray agent); a start asked
  //   for the AUTHOR instead of the runner (Борис runs Аня's private record through her agent); a refusal that still writes a child task, a
  //   session row or a ledger row.
  // @category: core-functionality
  // @dependency: Agents.resolveStart, Agents.sessions.start / restart / snapshot, startChild, tool gate, RecordLibrary (double), AccessGate (double), runtime (tasks.input), Postgres
  // @complexity: high
  it('INT-1 A: a started agent keeps the version it started on across an edit of its record and of the chat and a server restart, while the next start, a new conversation and a restart from scratch take the new version', async () => {
    // Given: Аня's agent R in version 1 (no tools, the default model), shared with Борис and offered in the chat;
    // Борис's root on chat version 1 starts R; the child's first model call will be held
    const anya = randomUUID();
    const boris = newUser();
    const library = createLibraryDouble();
    const recordR = testRecord('log digest', {
      ownerId: anya,
      everyone: false,
      viewers: [boris],
      prompt: 'Digest prompt, version 1.',
    });
    const recordId = library.add(recordR);
    const childHeld = createLatch();
    const { model, lineOf } = withPrompts(createScriptedModel());
    const firstAsk = model.script(
      { task: 'Run the digest' },
      [{ calls: [startAgent({ agent: recordId, description: 'digest one', prompt: 'Digest task' })] }],
      { thereafter: { text: 'noted' } },
    );
    const secondAsk = model.script(
      { task: 'Run the digest again' },
      [{ calls: [startAgent({ agent: recordId, description: 'digest two', prompt: 'Second digest task' })] }],
      { thereafter: { text: 'noted' } },
    );
    const digest = model.script({ task: 'Digest task' }, [
      { calls: [LIST_AGENTS], latch: childHeld },
      { calls: [LIST_AGENTS] },
      { text: 'report of the first digest' },
      { text: 'report of the restarted digest' },
    ]);
    const secondDigest = model.script({ task: 'Second digest task' }, [{ text: 'report of the second digest' }]);
    const newConversation = model.script({ task: 'A new conversation' }, [{ text: 'hello' }]);
    const options = { model, library, access: {} };
    const harnesses: AgentsHarness[] = [];
    try {
      // Instance A: one slot, a lease only the test expires, a heartbeat that never comes
      const zombie = await createAgentsHarness({
        ...options,
        root: testRecord('chat', { prompt: 'Chat prompt, version 1.', tools: ['start_agent'] }),
        zombie: true,
        runtimeConfig: { concurrency: 1, leaseMs: 600_000 },
      });
      harnesses.push(zombie);
      const { agentId: rootId } = await zombie.sessions.start({
        ownerId: boris,
        prompt: 'Run the digest',
        description: 'conversation before the edit',
      });
      const firstChildId = await startedChild(zombie, rootId);
      await childHeld.reached();

      // When: Аня saves version 2 of R (another prompt, a tool, another model) and the administrator edits
      // the chat record while the child's call is held
      library.edit(recordId, {
        body: {
          kind: 'agent',
          content: {
            ...recordR.content,
            prompt: 'Digest prompt, version 2.',
            tools: ['list_agents'],
            model: TEST_MODEL_CHOSEN,
          },
        },
      });
      await setRootRecord(library, testRecord('chat', { prompt: 'Chat prompt, version 2.', tools: ['start_agent'] }));

      // When: instance B starts, A's lease expires and B takes the held step over; then A's held call answers
      const restarted = await createAgentsHarness(options);
      harnesses.push(restarted);
      await expireLease(zombie.db, firstChildId);
      await waitForTaskStatus(restarted, firstChildId, boris, 'completed');
      childHeld.open();
      await waitFor(
        () => notCurrentLogsOf(zombie, firstChildId),
        (records) => records.length > 0,
        'the late step result of instance A to be refused',
      );

      // Then: every call of the first child, on A before the takeover and on B after it, ran on version 1 -
      // its prompt, its (empty) tool set, its model - and the call of the tool only version 2 has was refused
      expect(digest.calls.map(lineOf)).toEqual([
        'Digest prompt, version 1. | anthropic/test-default | run_code',
        'Digest prompt, version 1. | anthropic/test-default | run_code',
        'Digest prompt, version 1. | anthropic/test-default | run_code',
      ]);
      expect(historyLines(await historyOf(restarted, firstChildId, boris))).toEqual([
        'task: Digest task',
        'model_answer:  [list_agents]',
        'tool_result: list_agents refused tool_not_in_definition',
        'model_answer: report of the first digest []',
      ]);
      // Then: instance B reads the snapshot from the task input in Postgres
      expect((await restarted.sessions.snapshot(firstChildId, boris))?.content).toMatchObject({
        prompt: 'Digest prompt, version 1.',
        tools: [],
      });

      // When: Борис's root, created before the chat edit, gets a message and starts R again
      await restarted.sessions.send({ agentId: rootId, ownerId: boris, text: 'Run the digest again' });
      const secondChildId = await startedChild(restarted, rootId, 2);
      await waitForTaskStatus(restarted, secondChildId, boris, 'completed');

      // Then: the second child runs on version 2; the run origins say 1 and 2
      expect(secondDigest.calls.map(lineOf)).toEqual([
        'Digest prompt, version 2. | anthropic/test-chosen | list_agents, run_code',
      ]);
      const firstView = await restarted.sessions.get(firstChildId, boris);
      const secondView = await restarted.sessions.get(secondChildId, boris);
      expect([firstView.origin?.recordId, firstView.origin?.version]).toEqual([recordId, 1]);
      expect([secondView.origin?.recordId, secondView.origin?.version]).toEqual([recordId, 2]);

      // Then: the old conversation answered every message, the one after the edit too, on chat version 1
      expect(lineOf(secondAsk.calls[0]).split(' | ')[0]).toBe('Chat prompt, version 1.');
      expect(new Set([...firstAsk.calls, ...secondAsk.calls].map((call) => lineOf(call).split(' | ')[0]))).toEqual(
        new Set(['Chat prompt, version 1.']),
      );

      // When: the finished first child is restarted from scratch
      const { agentId: restartId } = await restarted.sessions.restart({ agentId: firstChildId, ownerId: boris });
      await waitForTaskStatus(restarted, restartId, boris, 'completed');

      // Then: a new agent under the same root on version 2, asked of the library for Борис
      expect(lineOf(digest.calls[3])).toBe('Digest prompt, version 2. | anthropic/test-chosen | list_agents, run_code');
      expect(inputLines(digest.calls[3]?.messages ?? [])).toEqual(['user: Digest task']);
      const restartView = await restarted.sessions.get(restartId, boris);
      expect([restartView.parentId, restartView.origin?.version]).toEqual([rootId, 2]);
      expect(library.resolveCalls.at(-1)).toEqual({ viewerId: boris, recordId });

      // When: Борис opens a new conversation after the chat edit
      await restarted.sessions.start({ ownerId: boris, prompt: 'A new conversation', description: 'conversation after the edit' });
      await newConversation.called(1);

      // Then: it runs on chat version 2
      expect(lineOf(newConversation.calls[0]).split(' | ')[0]).toBe('Chat prompt, version 2.');
    } finally {
      childHeld.open();
      await closeAll(harnesses);
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 B: an executor and a fork restart on their own snapshot without asking the library, and a restart refused for a deleted record or a withdrawn model names its reason and creates no agent', async () => {
    // Given: a workflow record whose executor `planner` was taken from a source record; an agent record
    // `forker` that forks itself; a `leaf` record. The root starts the coordinator, the forker and the leaf;
    // the coordinator and the forker are then held in a model call, so they stay unfinished parents
    const boris = newUser();
    const library = createLibraryDouble();
    const sourceId = library.add(testRecord('planner source', { prompt: 'Planner prompt.' }));
    const workflowId = library.add({
      kind: 'workflow',
      name: 'restart workflow',
      ownerId: TEST_AUTHOR_ID,
      everyone: true,
      offerInChat: true,
      content: {
        coordinator: { rules: '', model: 'anthropic/test-default', maxTurns: 20 },
        executors: [
          {
            name: 'planner',
            role: 'Plans the work',
            prompt: 'Planner prompt.',
            servers: [],
            model: TEST_MODEL_CHOSEN,
            maxTurns: 20,
            maxRuns: 1,
            tools: [],
            source: { recordId: sourceId, version: 1 },
          },
        ],
        finalExecutor: null,
      },
    });
    const forkerRecord = testRecord('forker', { prompt: 'Forker prompt, version 1.', tools: ['start_agent'] });
    const forkerRecordId = library.add(forkerRecord);
    const leafRecordId = library.add(testRecord('leaf'));
    const coordinatorHeld = createLatch();
    const forkerHeld = createLatch();
    const modelRefusals: Record<string, Record<string, typeof MODEL_NOT_ALLOWED>> = {};
    const { model, lineOf } = withPrompts(createScriptedModel());
    model.script(
      { task: 'Start the restart tree' },
      [
        {
          calls: [
            {
              tool: START_TEST_WORKFLOW,
              args: { workflow: workflowId, prompt: 'Coordinate the plan', description: 'coordinator' },
            },
            startAgent({ agent: forkerRecordId, description: 'forker', prompt: 'Fork yourself' }),
            startAgent({ agent: leafRecordId, description: 'leaf', prompt: 'Leaf task' }),
          ],
        },
      ],
      { thereafter: { text: 'noted' } },
    );
    model.script(
      { task: 'Coordinate the plan' },
      [{ calls: [startAgent({ agent: 'planner', description: 'planner', prompt: 'Plan the work' })] }],
      { thereafter: { text: 'coordinator holds', latch: coordinatorHeld } },
    );
    const planner = model.script({ task: 'Plan the work' }, [
      { text: 'plan' },
      { text: 'plan of the restarted executor' },
    ]);
    model.script(
      { task: 'Fork yourself' },
      [{ calls: [startAgent({ agent: 'fork', description: 'the fork', prompt: 'Fork task' })] }],
      { thereafter: { text: 'forker holds', latch: forkerHeld } },
    );
    const fork = model.script({ task: 'Fork task' }, [
      { text: 'report of the fork' },
      { text: 'report of the restarted fork' },
    ]);
    model.script({ task: 'Leaf task' }, [{ text: 'report of the leaf' }]);
    const harness = await createAgentsHarness({
      model,
      library,
      access: {},
      root: testRecord('chat', { tools: ['start_agent'] }),
      workflowStarter: true,
      ownerModelRefusals: modelRefusals,
    });
    try {
      const { agentId: rootId } = await harness.sessions.start({
        ownerId: boris,
        prompt: 'Start the restart tree',
        description: 'restart tree',
      });
      await startedChild(harness, rootId, 3);
      const [coordinatorId, forkerId, leafId] = await startedChildrenOf(harness, rootId);
      if (coordinatorId === undefined || forkerId === undefined || leafId === undefined) {
        throw new Error('the root started no coordinator, forker and leaf');
      }
      const plannerId = await startedChild(harness, coordinatorId);
      const forkId = await startedChild(harness, forkerId);
      await waitForTaskStatus(harness, plannerId, boris, 'completed');
      await waitForTaskStatus(harness, forkId, boris, 'completed');
      await waitForTaskStatus(harness, leafId, boris, 'completed');
      await coordinatorHeld.reached();
      await forkerHeld.reached();
      // Given: the fork ran on the forker's snapshot and saw its history up to the start call
      expect(inputLines(fork.calls[0]?.messages ?? [])).toEqual(['user: Fork yourself', 'user: Fork task']);

      // When: the executor's source record and its workflow are deleted, the forker's record gets version 2,
      // and the executor and the fork are restarted from scratch
      library.remove(sourceId);
      library.remove(workflowId);
      library.edit(forkerRecordId, {
        body: { kind: 'agent', content: { ...forkerRecord.content, prompt: 'Forker prompt, version 2.' } },
      });
      const resolvedBefore = library.resolveCalls.length;
      const { agentId: plannerRestartId } = await harness.sessions.restart({ agentId: plannerId, ownerId: boris });
      await waitForTaskStatus(harness, plannerRestartId, boris, 'completed');
      const { agentId: forkRestartId } = await harness.sessions.restart({ agentId: forkId, ownerId: boris });
      await waitForTaskStatus(harness, forkRestartId, boris, 'completed');

      // Then: neither restart asked the library
      expect(library.resolveCalls).toHaveLength(resolvedBefore);
      // Then: the executor restarted on its own snapshot although its source and its workflow are gone
      expect(planner.calls.map(lineOf)).toEqual([
        'Planner prompt. | anthropic/test-chosen | run_code',
        'Planner prompt. | anthropic/test-chosen | run_code',
      ]);
      const plannerRestart = await harness.sessions.get(plannerRestartId, boris);
      expect([
        plannerRestart.parentId,
        plannerRestart.origin?.recordId,
        plannerRestart.origin?.version,
        plannerRestart.origin?.executor,
      ]).toEqual([coordinatorId, workflowId, 1, 'planner']);
      // Then: the fork restarted on the forker's snapshot of version 1, without the forker's history
      expect(fork.calls.map(lineOf)).toEqual([
        'Forker prompt, version 1. | anthropic/test-default | start_agent, run_code',
        'Forker prompt, version 1. | anthropic/test-default | start_agent, run_code',
      ]);
      expect(inputLines(fork.calls[1]?.messages ?? [])).toEqual(['user: Fork task']);
      const forkRestart = await harness.sessions.get(forkRestartId, boris);
      expect([forkRestart.parentId, forkRestart.forkedFrom]).toEqual([forkerId, null]);

      // When: the leaf's record is deleted, then the planner's model is withdrawn from Борис, and each is restarted
      expect(await ownerRowCounts(harness.db, boris)).toEqual({ tasks: 8, sessions: 8 });
      library.remove(leafRecordId);
      await expect(harness.sessions.restart({ agentId: leafId, ownerId: boris })).rejects.toMatchObject({
        code: 'START_REFUSED',
        refusal: { reason: 'record_unavailable', model: null },
      });
      modelRefusals[boris] = { [TEST_MODEL_CHOSEN]: MODEL_NOT_ALLOWED };
      await expect(harness.sessions.restart({ agentId: plannerId, ownerId: boris })).rejects.toMatchObject({
        code: 'START_REFUSED',
        refusal: { reason: 'model_not_allowed', model: TEST_MODEL_CHOSEN },
      });

      // Then: neither refused restart made an agent or a session
      expect(await ownerRowCounts(harness.db, boris)).toEqual({ tasks: 8, sessions: 8 });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 C: a start refused for a record the runner cannot see or a model he may not use names its reason to the parent and writes no child task, session or ledger row', async () => {
    // Given: Аня's agent may start four of her records - her personal "сбор логов", one she will delete, one
    // the administrator will close and one of a role Борис will leave; it runs in Борис's tree. Борис's root
    // also starts a record on a model taken from him and one on a model with no connection
    const anya = randomUUID();
    const boris = newUser();
    const library = createLibraryDouble();
    const personalId = library.add(testRecord('сбор логов', { ownerId: anya, everyone: false }));
    const deletedId = library.add(testRecord('deleted target', { ownerId: anya }));
    const closedId = library.add(testRecord('closed target', { ownerId: anya }));
    const roleId = library.add(testRecord('role target', { ownerId: anya, everyone: false, viewers: [boris] }));
    const targets = [personalId, deletedId, closedId, roleId];
    const anyaAgentRecordId = library.add(
      testRecord('agent of Anya', { ownerId: anya, tools: ['start_agent'], agents: targets }),
    );
    const chosenModelRecordId = library.add(testRecord('chosen model agent', { model: TEST_MODEL_CHOSEN }));
    const unconnectedRecordId = library.add(testRecord('unconnected model agent', { model: UNCONNECTED_MODEL }));
    const anyaHeld = createLatch();
    const model = createScriptedModel();
    const root = model.script(
      { task: 'Start the agents of Anya' },
      [
        {
          calls: [
            startAgent({ agent: anyaAgentRecordId, description: 'agent of anya', prompt: 'Collect the logs for Boris' }),
            startAgent({ agent: chosenModelRecordId, description: 'chosen model', prompt: 'Work on the chosen model' }),
            startAgent({ agent: unconnectedRecordId, description: 'unconnected model', prompt: 'Work unconnected' }),
          ],
        },
      ],
      { thereafter: { text: 'noted' } },
    );
    model.script({ task: 'Collect the logs for Boris' }, [
      {
        latch: anyaHeld,
        calls: targets.map((agent, index) =>
          startAgent({ agent, description: `target ${index + 1}`, prompt: `Target task ${index + 1}` }),
        ),
      },
      { text: 'nothing started' },
    ]);
    const harness = await createAgentsHarness({
      model,
      library,
      access: {},
      root: testRecord('chat', { tools: ['start_agent'] }),
      ownerModelRefusals: { [boris]: { [TEST_MODEL_CHOSEN]: MODEL_NOT_ALLOWED } },
    });
    try {
      const { agentId: rootId } = await harness.sessions.start({
        ownerId: boris,
        prompt: 'Start the agents of Anya',
        description: 'conversation of Boris',
      });
      const anyaAgentId = await startedChild(harness, rootId);
      await anyaHeld.reached();
      await root.called(2);
      await waitForTaskStatus(harness, rootId, boris, 'waiting');

      // When: while Аня's agent is in its model call, one target is deleted, one closed and Борис leaves the
      // role of another; then the agent starts all four
      library.remove(deletedId);
      library.close(closedId);
      library.hideFrom(roleId, boris);
      anyaHeld.open();
      await waitForTaskStatus(harness, anyaAgentId, boris, 'completed');
      await root.called(3);
      await waitForTaskStatus(harness, rootId, boris, 'waiting');

      // Then: each start is refused `record_unavailable` with no child, and the library was asked for Борис only
      expect(
        (await toolCallRowsOf(harness.db, anyaAgentId)).map(
          (call) => `${call.tool} ${call.outcome} ${call.refusalReason} ${call.childTaskId}`,
        ),
      ).toEqual(Array<string>(4).fill('start_agent refused record_unavailable null'));
      expect(
        library.resolveCalls
          .filter((call) => targets.includes(call.recordId))
          .map((call) => `${call.viewerId} ${call.recordId}`)
          .sort(),
      ).toEqual(targets.map((id) => `${boris} ${id}`).sort());
      // Then: the agent's history holds the four refusals with their reason, and it went on
      expect(historyLines(await historyOf(harness, anyaAgentId, boris))).toEqual([
        'task: Collect the logs for Boris',
        'model_answer:  [start_agent, start_agent, start_agent, start_agent]',
        ...Array<string>(4).fill('tool_result: start_agent refused record_unavailable'),
        'model_answer: nothing started []',
      ]);

      // Then: the root's starts on a withdrawn and an unconnected model are refused with the model's number,
      // and the root kept answering
      expect(
        (await toolCallRowsOf(harness.db, rootId)).map(
          (call) => `${call.tool} ${call.outcome} ${call.refusalReason ?? '-'} ${JSON.stringify(call.refusalDetail)}`,
        ),
      ).toEqual([
        'start_agent success - null',
        'start_agent refused model_not_allowed {"model":"anthropic/test-chosen"}',
        'start_agent refused model_not_connected {"model":"anthropic/test-unconnected"}',
      ]);
      expect(historyLines(await historyOf(harness, rootId, boris))).toEqual([
        'task: Start the agents of Anya',
        'model_answer:  [start_agent, start_agent, start_agent]',
        'tool_result: start_agent success',
        'tool_result: start_agent refused model_not_allowed',
        'tool_result: start_agent refused model_not_connected',
        'model_answer: noted []',
        'child_report: agent of anya completed',
        'model_answer: noted []',
      ]);

      // Then: Борис has the root and Аня's agent only - no other task or session - and ledger rows of their
      // model calls only
      expect(await ownerRowCounts(harness.db, boris)).toEqual({ tasks: 2, sessions: 2 });
      const ledgerTaskIds = (await ledgerRowsOf(harness.db, boris)).map((row) => String(row.taskId));
      expect(ledgerTaskIds.sort((a, b) => a.localeCompare(b))).toEqual(
        [rootId, rootId, rootId, anyaAgentId, anyaAgentId].sort((a, b) => a.localeCompare(b)),
      );
    } finally {
      anyaHeld.open();
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
