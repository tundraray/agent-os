// custom-agents / runtime - agents-package integration skeleton (in-process `RuntimeModule` + `createAgents` over real Postgres, scripted model, library double)
// Design Doc: docs/features/custom-agents/design-runtime.md (v1.1), Test Strategy UC-5, UC-E1, UC-E2 (the start procedure and the snapshot);
//   PRD: docs/features/custom-agents/prd.md FR-13, FR-14 (AC-13.1 .. AC-13.4, AC-14.1, AC-14.3, AC-14.4).
// Generated: 2026-11-17
// Part: runtime. THE PART'S BUDGET, THE FULL acProof AND THE LIST OF UNIT TABLES ARE IN `apps/api/test/custom-agents-runtime.int.e2e-spec.ts` (one place;
//   this file holds INT-1 and INT-2 A of 4). Sibling skeleton
//   file of the part: apps/api/test/custom-agents-runtime.int.e2e-spec.ts (INT-3, INT-4).
// Test Type: Integration. Run with `pnpm --filter @agent-os/agents test:e2e` (`vitest.config.e2e.ts`, `*.e2e-spec.ts`), never in the default `vitest run`.
//
// Harness (follows agent-platform-agents.int.e2e-spec.ts and test/support/agentsHarness.ts):
//   real Postgres, real `RuntimeModule` and `createAgents`, workers on; the scripted `ModelClient` is the only model double and records the
//   input of every call (the assertion surface for "the next model call carries prompt X"; the system prompt is read by a thin wrapper of
//   its `turnClient`, below); the MCP fixture process is the real one. The library is `options.library` - a `createLibraryDouble` of
//   `@agent-os/agents/testing` (records in memory with owner, "visible to all", viewers; operations to edit a record into a new version
//   and delete it) passed to `createAgents({ library })`; the access gate double of the
//   harness refuses a model per owner (`ownerModelRefusals`, read on every question) and answers `model_not_connected` for a model
//   without a price. Mock boundary: the library double stands for `LibraryService` ONLY (its visibility and version rules are proven in
//   the `library` part against the real service); the runtime, the agents package, the snapshot in `runtime_tasks.input`, the tool gate
//   and the history are all real. A second instance over a zombie (`ZOMBIE_RUNTIME`) is the "restarted server" exactly as in agents INT-3 row E.
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
import type { DeepAgentContent } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  childReportsOf,
  closeAll,
  createAgentsHarness,
  ZOMBIE_RUNTIME,
  historyLines,
  historyOf,
  START_TEST_DEEP_AGENT,
  setRootRecord,
  taskCall,
  TEST_AUTHOR_ID,
  TEST_MODEL_CHOSEN,
  TEST_MODEL_DEFAULT,
  testDeepAgent,
  testRecord,
  testSubagent,
  toolCallRowsOf,
  waitForStatus,
  waitForTaskStatus,
} from './support/agentsHarness';
import { newUser, waitFor } from '@agent-os/db/testing';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** A model the access gate double has no price for: `model_not_connected`. */
const UNCONNECTED_MODEL = 'anthropic/test-unconnected';

/** The refusal `ownerModelRefusals` gives for a model taken from an owner. */
const MODEL_NOT_ALLOWED = {
  kind: 'refused',
  reason: 'model_not_allowed',
} as const;

/** A built-in call that needs no server; a record without `list_agents` in its tools gets it refused. */
const LIST_AGENTS: ScriptedToolCall = { tool: 'list_agents', args: {} };

/** A `start_agent` call of a scripted answer: `agent` is a record's name or `fork`. */
function startAgent(args: {
  agent: string;
  description: string;
  prompt: string;
}): ScriptedToolCall {
  return { tool: 'start_agent', args };
}

/** Agents the agent started, in the order of its starting calls (`start_agent`, `start_test_deep_agent`). */
async function startedChildrenOf(
  harness: AgentsHarness,
  agentId: string,
): Promise<string[]> {
  const calls = await toolCallRowsOf(harness.db, agentId);
  return calls.flatMap((call) =>
    call.childTaskId !== null ? [call.childTaskId] : [],
  );
}

/** Waits until the agent has started `count` children (1 by default) and returns the last of them. */
async function startedChild(
  harness: AgentsHarness,
  agentId: string,
  count = 1,
): Promise<string> {
  const children = await waitFor(
    () => startedChildrenOf(harness, agentId),
    (started) => started.length >= count,
    `child ${count} of agent ${agentId}`,
  );
  const child = children[count - 1];
  if (child === undefined)
    throw new Error(`agent ${agentId} started no child ${count}`);
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
async function ownerRowCounts(
  db: Database,
  ownerId: string,
): Promise<{ tasks: number; sessions: number }> {
  const { rows } = await db.execute(sql`
    SELECT (SELECT count(*) FROM app.runtime_tasks WHERE owner_id = ${ownerId})::int AS tasks,
           (SELECT count(*) FROM app.conversations WHERE owner_id = ${ownerId})::int AS sessions`);
  return { tasks: Number(rows[0]?.tasks), sessions: Number(rows[0]?.sessions) };
}

/** Log records of an instance whose late step result for the task was refused (the attempt was taken over). */
function notCurrentLogsOf(harness: AgentsHarness, taskId: string): LogRecord[] {
  return harness.logs.filter(
    (record) =>
      record.fields.taskId === taskId &&
      record.message.endsWith('the attempt is no longer current'),
  );
}

/** The deep agent of INT-2 A that Борис runs: its name is the deep agent's name. */
const TEAM_NAME = 'incident review';

/**
 * The deep agent's turns, counted call by call. First run: the task calls of a, b and c (1), the answer on their
 * results (2). Second run: the task call of a, the answer.
 */
const TEAM_MAX_TURNS = 5;

/** The finishing rule of a deep agent without `finalSubagent` (DC-7). */
const WRITES_ANSWER_ITSELF =
  'When the work is done, write the answer yourself as plain text without tool calls.';

/** The line of the built-in subagent every deep agent's `task` names (FR-20). */
const GENERAL_PURPOSE_LINE =
  'general-purpose (up to 20 runs): A subagent with the deep agent’s own model and tools: call it for a separate piece of work no other subagent fits.';

/** The team as the deep agent's `task` lists it: «имя (up to N runs): описание», then `general-purpose`. */
const TEAM_V1_LINES = [
  'a (up to 1 runs): Reads the incident timeline (version 1).',
  'b (up to 2 runs): Checks the payment logs.',
  'c (up to 1 runs): Writes the customer note.',
  GENERAL_PURPOSE_LINE,
];
const TEAM_V2_LINES = [
  'a (up to 1 runs): Reads the incident timeline and the deploy log (version 2).',
  'b (up to 2 runs): Checks the payment logs.',
  'c (up to 1 runs): Writes the customer note.',
  GENERAL_PURPOSE_LINE,
];

/** Version 1: three subagents with a description each and `maxRuns` 1, 2 and 1, no `finalSubagent`. */
function teamV1(): DeepAgentContent {
  return {
    prompt: 'You review incidents, version 1.',
    servers: [],
    model: TEST_MODEL_DEFAULT,
    maxTurns: TEAM_MAX_TURNS,
    subagents: [
      testSubagent('a', {
        description: 'Reads the incident timeline (version 1).',
        prompt: 'You are subagent a of team version 1.',
      }),
      testSubagent('b', {
        description: 'Checks the payment logs.',
        prompt: 'You are subagent b of team version 1.',
        maxRuns: 2,
      }),
      testSubagent('c', {
        description: 'Writes the customer note.',
        prompt: 'You are subagent c of team version 1.',
      }),
    ],
    finalSubagent: null,
    taskList: true,
    listDelegation: true,
    selfLearning: false,
  };
}

/** Version 2: another prompt of the deep agent, and `a` with another description and prompt. */
function teamV2(): DeepAgentContent {
  const v1 = teamV1();
  return {
    ...v1,
    prompt: 'You review incidents, version 2.',
    subagents: v1.subagents.map((subagent) =>
      subagent.name === 'a'
        ? {
            ...subagent,
            description:
              'Reads the incident timeline and the deploy log (version 2).',
            prompt: 'You are subagent a of team version 2.',
          }
        : subagent,
    ),
  };
}

const FIRST_RUN_TASK = 'Review the incident of Monday.';
const FIRST_ANSWER =
  'Review: the timeline, the logs and the note agree - a bad deploy at 10:40.';
const SECOND_RUN_TASK = 'Review the incident of Tuesday.';
const SECOND_ANSWER = 'Review: the timeline shows a second deploy.';

/** The record's own prompt: the instructions before the platform's text that follows it. */
function promptOf(call: RecordedModelCall | undefined): string {
  return (call?.instructions ?? '').split('\n\n')[0] ?? '';
}

/** The subagents `task` names, as the model reads them. */
function teamLinesOf(call: RecordedModelCall | undefined): string[] {
  const lines = (call?.toolDescriptions.task ?? '').split('\n');
  return lines
    .slice(lines.indexOf('Subagents you may call (subagentType):') + 1)
    .map((line) => line.replace(/^- /, ''));
}

/** A conversation of the owner whose first answer starts the deep agent record on `task`; returns once the deep agent exists. */
async function startDeepAgentRun(
  harness: AgentsHarness,
  model: ScriptedModel,
  ownerId: string,
  deepAgentId: string,
  task: string,
): Promise<{ rootId: string; deepAgentId: string }> {
  const conversation = `Start the deep agent: ${task}`;
  model.script(
    { task: conversation },
    [
      {
        calls: [
          {
            tool: START_TEST_DEEP_AGENT,
            args: {
              deepAgent: deepAgentId,
              prompt: task,
              description: TEAM_NAME,
            },
          },
        ],
      },
    ],
    { thereafter: { text: 'noted' } },
  );
  const { agentId: rootId } = await harness.sessions.start({
    ownerId,
    prompt: conversation,
    description: conversation,
  });
  return { rootId, deepAgentId: await startedChild(harness, rootId) };
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
  // Behavior: a root (the `chat` record of the double) starts a child by a record's name -> `resolveStart` asks the library for the RUNNER ->
  //   the snapshot is written into the child's task input -> every later step reads only that input; a restart picks its source by kind.
  // Rows (literal expected values; each row has its own owner, records and tree):
  //   A. Frozen copy (AC-13.1, AC-13.3, DC-3). Given Аня's agent R in version 1 shared with Борис, and Борис's root; When Борис's root starts R
  //      by its name and the child's first model call is held on a latch; Аня saves version 2 of R (another prompt, another tool set) in the
  //      double, and the administrator edits the `chat` record (another prompt); the second instance takes the child over at its start
  //      and the latch is released; Then the child's model inputs (before and after the takeover) carry the version-1 prompt and its tool set
  //      and never the version-2 prompt; Борис's root starts R again -> that child's inputs carry the version-2 prompt; the run origin of the
  //      first child says version 1, of the second version 2; the first child's tool call of a tool only version 2 has is refused by the gate
  //      (not in its snapshot). The root created BEFORE the `chat` edit answers its next message with the old chat prompt; a root created
  //      after the edit starts with the new one. "Запустить с нуля" of the finished first child (`sessions.restart`) starts a new agent on
  //      version 2 (DC-3; UXRD KD-7).
  //   B. Who restarts on whose copy (DC-3, DC-4, DC-5, invariant 2). Given a deep agent tree: a subagent started from the snapshot of
  //      its deep agent (the deep agent's record is then deleted in the double) and a fork of a record-agent; When each finished
  //      agent is restarted; Then the subagent restarts on its own stored snapshot although its record is gone (no library read: the double's
  //      call count of `resolve` did not move), the fork restarts on the snapshot of the caller it ran on and does not inherit the parent's
  //      history; Given the record of a restarted agent is then deleted -> `sessions.restart` is refused `START_REFUSED` with reason
  //      `record_unavailable`, and the number of agents under the parent did not change; Given the agent's model is no longer allowed to its
  //      owner (the access gate double) -> refused with reason `model_not_allowed` and the model's number, again no new agent.
  //   C. A name the runner cannot see is a temporary agent, a model he may not use is a refusal (AC-14.1, AC-14.3, AC-14.4, DC-5;
  //      data-model/design-agents.md KD-5, DC-24). Given Аня's agent running in Борис's tree; When it calls `start_agent` with the name of
  //      Аня's personal "сбор логов"; Then the call starts a temporary agent - the default agent's version under the name from the call -
  //      and it does not run on Аня's prompt (the name is looked up for Борис, not for Аня). A deleted record, one closed to the runner
  //      and one whose role he left are the same branch - a record the runner does not see - and have no target of their own;
  //      `record_unavailable` is a restart's answer only (row B). A start whose record's model is not allowed to the runner is refused `model_not_allowed` carrying the model's number, and a model with no connection
  //      `model_not_connected`; no child task and no `conversations` row of those calls exist, the root keeps answering.
  // Catches: a step that reads the library or an in-memory catalog after the start (an edit, a delete or a role change reaches a running
  //   agent); a snapshot kept only in the process (lost with a restart of the server); a restart of a subagent or a fork that asks the library
  //   (and fails when the record is gone, or silently swaps it for the latest version); a record restart that copies the old snapshot (stale
  //   version against UXRD KD-7) or that creates the new agent before the check (a refused restart leaves a stray agent); a start asked
  //   for the AUTHOR instead of the runner (Борис runs Аня's private record through her agent); a refusal that still writes a child task or a
  //   session row.
  // @category: core-functionality
  // @dependency: Agents.resolveStart, Agents.sessions.start / restart / snapshot, startChild, tool gate, RecordLibrary (double), AccessGate (double), runtime (tasks.input), Postgres
  // @complexity: high
  it(
    'INT-1 A: a started agent keeps the version it started on across an edit of its record and of the chat and a server restart, while the next start, a new conversation and a restart from scratch take the new version',
    async () => {
      // Given: Аня's agent R in version 1 (no tools, the default model), shared with Борис and offered in the chat;
      // Борис's root on chat version 1 starts R; the child's first model call will be held
      const anya = await newUser();
      const boris = await newUser();
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
        [
          {
            calls: [
              startAgent({
                agent: 'log digest',
                description: 'digest one',
                prompt: 'Digest task',
              }),
            ],
          },
        ],
        { thereafter: { text: 'noted' } },
      );
      const secondAsk = model.script(
        { task: 'Run the digest again' },
        [
          {
            calls: [
              startAgent({
                agent: 'log digest',
                description: 'digest two',
                prompt: 'Second digest task',
              }),
            ],
          },
        ],
        { thereafter: { text: 'noted' } },
      );
      const digest = model.script({ task: 'Digest task' }, [
        { calls: [LIST_AGENTS], latch: childHeld },
        { calls: [LIST_AGENTS] },
        { text: 'report of the first digest' },
        { text: 'report of the restarted digest' },
      ]);
      const secondDigest = model.script({ task: 'Second digest task' }, [
        { text: 'report of the second digest' },
      ]);
      const newConversation = model.script({ task: 'A new conversation' }, [
        { text: 'hello' },
      ]);
      const options = { model, library, access: {} };
      const harnesses: AgentsHarness[] = [];
      try {
        // Instance A: one slot, a sweeper that never passes again
        const zombie = await createAgentsHarness({
          ...options,
          root: testRecord('chat', {
            prompt: 'Chat prompt, version 1.',
            tools: ['start_agent'],
          }),
          runtimeConfig: ZOMBIE_RUNTIME,
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
        await setRootRecord(
          library,
          testRecord('chat', {
            prompt: 'Chat prompt, version 2.',
            tools: ['start_agent'],
          }),
        );

        // When: instance B starts, requeues the held step as a lost one and takes it over; then A's held call answers
        const restarted = await createAgentsHarness(options);
        harnesses.push(restarted);
        await waitForTaskStatus(restarted, firstChildId, boris, 'completed');
        // The root takes the child's report on B while A's only slot is still held
        await firstAsk.called(2);
        await waitForTaskStatus(restarted, rootId, boris, 'waiting');
        childHeld.open();
        await waitFor(
          () => notCurrentLogsOf(zombie, firstChildId),
          (records) => records.length > 0,
          'the late step result of instance A to be refused',
        );
        // Instance A is the dead process: one process executes steps, so its workers stop here. Left running, its
        // freed slot claims the root's next step on the object A kept from before the takeover, and B's sweeper
        // requeues that step as a lost one.
        await zombie.runtime.stop();

        // Then: every call of the first child, on A before the takeover and on B after it, ran on version 1 -
        // its prompt, its (empty) tool set, its model - and the call of the tool only version 2 has was refused
        expect(digest.calls.map(lineOf)).toEqual([
          `Digest prompt, version 1. | ${TEST_MODEL_DEFAULT} | read_tool_result, search_tool_result, run_code`,
          `Digest prompt, version 1. | ${TEST_MODEL_DEFAULT} | read_tool_result, search_tool_result, run_code`,
          `Digest prompt, version 1. | ${TEST_MODEL_DEFAULT} | read_tool_result, search_tool_result, run_code`,
        ]);
        expect(
          historyLines(await historyOf(restarted, firstChildId, boris)),
        ).toEqual([
          'task: Digest task',
          'model_answer:  [list_agents]',
          'tool_result: list_agents refused tool_not_in_definition',
          'model_answer: report of the first digest []',
        ]);
        // Then: instance B reads the version the task input names, version 1 of R, from Postgres (DC-18)
        expect(
          (await restarted.sessions.version(firstChildId, boris))?.version,
        ).toMatchObject({
          agentId: recordId,
          number: 1,
          content: { prompt: 'Digest prompt, version 1.', tools: [] },
        });

        // When: Борис's root, created before the chat edit, gets a message and starts R again
        await restarted.sessions.send({
          agentId: rootId,
          ownerId: boris,
          text: 'Run the digest again',
        });
        const secondChildId = await startedChild(restarted, rootId, 2);
        await waitForTaskStatus(restarted, secondChildId, boris, 'completed');

        // Then: the second child runs on version 2; the run origins say 1 and 2
        expect(secondDigest.calls.map(lineOf)).toEqual([
          `Digest prompt, version 2. | ${TEST_MODEL_CHOSEN} | list_agents, read_tool_result, search_tool_result, run_code`,
        ]);
        const firstView = await restarted.sessions.get(firstChildId, boris);
        const secondView = await restarted.sessions.get(secondChildId, boris);
        expect([firstView.origin?.recordId, firstView.origin?.version]).toEqual(
          [recordId, 1],
        );
        expect([
          secondView.origin?.recordId,
          secondView.origin?.version,
        ]).toEqual([recordId, 2]);

        // Then: the old conversation answered every message, the one after the edit too, on chat version 1
        expect(lineOf(secondAsk.calls[0]).split(' | ')[0]).toBe(
          'Chat prompt, version 1.',
        );
        expect(
          new Set(
            [...firstAsk.calls, ...secondAsk.calls].map(
              (call) => lineOf(call).split(' | ')[0],
            ),
          ),
        ).toEqual(new Set(['Chat prompt, version 1.']));

        // When: the finished first child is restarted from scratch
        const { agentId: restartId } = await restarted.sessions.restart({
          agentId: firstChildId,
          ownerId: boris,
        });
        await waitForTaskStatus(restarted, restartId, boris, 'completed');

        // Then: a new agent under the same root on version 2, asked of the library for Борис
        expect(lineOf(digest.calls[3])).toBe(
          `Digest prompt, version 2. | ${TEST_MODEL_CHOSEN} | list_agents, read_tool_result, search_tool_result, run_code`,
        );
        expect(inputLines(digest.calls[3]?.messages ?? [])).toEqual([
          'user: Digest task',
        ]);
        const restartView = await restarted.sessions.get(restartId, boris);
        expect([restartView.parentId, restartView.origin?.version]).toEqual([
          rootId,
          2,
        ]);
        expect(library.resolveCalls.at(-1)).toEqual({
          viewerId: boris,
          recordId,
        });

        // When: Борис opens a new conversation after the chat edit
        await restarted.sessions.start({
          ownerId: boris,
          prompt: 'A new conversation',
          description: 'conversation after the edit',
        });
        await newConversation.called(1);

        // Then: it runs on chat version 2
        expect(lineOf(newConversation.calls[0]).split(' | ')[0]).toBe(
          'Chat prompt, version 2.',
        );
      } finally {
        childHeld.open();
        await closeAll(harnesses);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-1 B: a subagent and a fork restart on their own snapshot without asking the library, and a restart refused for a deleted record or a withdrawn model names its reason and creates no agent',
    async () => {
      // Given: a deep agent record with the subagent `planner`; an agent record
      // `forker` that forks itself; a `leaf` record. The root starts the deep agent, the forker and the leaf;
      // the deep agent and the forker are then held in a model call, so they stay unfinished parents
      const boris = await newUser();
      const library = createLibraryDouble();
      const deepAgentRecordId = library.add({
        kind: 'deep_agent',
        name: 'restart deep agent',
        ownerId: TEST_AUTHOR_ID,
        everyone: true,
        offerInChat: true,
        content: {
          prompt: 'You run the plan.',
          servers: [],
          model: TEST_MODEL_DEFAULT,
          maxTurns: 20,
          subagents: [
            {
              name: 'planner',
              description: 'Plans the work',
              prompt: 'Planner prompt.',
              servers: [],
              model: TEST_MODEL_CHOSEN,
              maxTurns: 20,
              maxRuns: 1,
              taskList: false,
            },
          ],
          finalSubagent: null,
          taskList: true,
          listDelegation: true,
          selfLearning: false,
        },
      });
      const forkerRecord = testRecord('forker', {
        prompt: 'Forker prompt, version 1.',
        tools: ['start_agent'],
      });
      const forkerRecordId = library.add(forkerRecord);
      const leafRecordId = library.add(testRecord('leaf'));
      const deepAgentHeld = createLatch();
      const forkerHeld = createLatch();
      const modelRefusals: Record<
        string,
        Record<string, typeof MODEL_NOT_ALLOWED>
      > = {};
      const { model, lineOf } = withPrompts(createScriptedModel());
      model.script(
        { task: 'Start the restart tree' },
        [
          {
            calls: [
              {
                tool: START_TEST_DEEP_AGENT,
                args: {
                  deepAgent: deepAgentRecordId,
                  prompt: 'Coordinate the plan',
                  description: 'deep agent',
                },
              },
              startAgent({
                agent: 'forker',
                description: 'forker',
                prompt: 'Fork yourself',
              }),
              startAgent({
                agent: 'leaf',
                description: 'leaf',
                prompt: 'Leaf task',
              }),
            ],
          },
        ],
        { thereafter: { text: 'noted' } },
      );
      model.script(
        { task: 'Coordinate the plan' },
        [
          {
            calls: [
              taskCall({
                subagentType: 'planner',
                description: 'Plan the work',
              }),
            ],
          },
        ],
        { thereafter: { text: 'deep agent holds', latch: deepAgentHeld } },
      );
      const planner = model.script({ task: 'Plan the work' }, [
        { text: 'plan' },
        { text: 'plan of the restarted subagent' },
      ]);
      model.script(
        { task: 'Fork yourself' },
        [
          {
            calls: [
              startAgent({
                agent: 'fork',
                description: 'the fork',
                prompt: 'Fork task',
              }),
            ],
          },
        ],
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
        deepAgentStarter: true,
        ownerModelRefusals: modelRefusals,
      });
      try {
        const { agentId: rootId } = await harness.sessions.start({
          ownerId: boris,
          prompt: 'Start the restart tree',
          description: 'restart tree',
        });
        await startedChild(harness, rootId, 3);
        const [deepAgentId, forkerId, leafId] = await startedChildrenOf(
          harness,
          rootId,
        );
        if (
          deepAgentId === undefined ||
          forkerId === undefined ||
          leafId === undefined
        ) {
          throw new Error('the root started no deep agent, forker and leaf');
        }
        const plannerId = await startedChild(harness, deepAgentId);
        const forkId = await startedChild(harness, forkerId);
        await waitForTaskStatus(harness, plannerId, boris, 'completed');
        await waitForTaskStatus(harness, forkId, boris, 'completed');
        await waitForTaskStatus(harness, leafId, boris, 'completed');
        await deepAgentHeld.reached();
        await forkerHeld.reached();
        // Given: the fork ran on the forker's snapshot and saw its history up to the start call
        expect(inputLines(fork.calls[0]?.messages ?? [])).toEqual([
          'user: Fork yourself',
          'user: Fork task',
        ]);

        // When: the subagent's deep agent is deleted, the forker's record gets version 2,
        // and the subagent and the fork are restarted from scratch
        library.remove(deepAgentRecordId);
        library.edit(forkerRecordId, {
          body: {
            kind: 'agent',
            content: {
              ...forkerRecord.content,
              prompt: 'Forker prompt, version 2.',
            },
          },
        });
        const resolvedBefore = library.resolveCalls.length;
        const { agentId: plannerRestartId } = await harness.sessions.restart({
          agentId: plannerId,
          ownerId: boris,
        });
        await waitForTaskStatus(harness, plannerRestartId, boris, 'completed');
        const { agentId: forkRestartId } = await harness.sessions.restart({
          agentId: forkId,
          ownerId: boris,
        });
        await waitForTaskStatus(harness, forkRestartId, boris, 'completed');

        // Then: neither restart asked the library
        expect(library.resolveCalls).toHaveLength(resolvedBefore);
        // Then: the subagent restarted on its own snapshot although its deep agent is gone
        expect(planner.calls.map(lineOf)).toEqual([
          `Planner prompt. | ${TEST_MODEL_CHOSEN} | read_tool_result, search_tool_result, run_code`,
          `Planner prompt. | ${TEST_MODEL_CHOSEN} | read_tool_result, search_tool_result, run_code`,
        ]);
        const plannerRestart = await harness.sessions.get(
          plannerRestartId,
          boris,
        );
        expect([
          plannerRestart.parentId,
          plannerRestart.origin?.recordId,
          plannerRestart.origin?.version,
          plannerRestart.origin?.subagent,
        ]).toEqual([deepAgentId, deepAgentRecordId, 1, 'planner']);
        // Then: the fork restarted on the forker's snapshot of version 1, without the forker's history
        expect(fork.calls.map(lineOf)).toEqual([
          `Forker prompt, version 1. | ${TEST_MODEL_DEFAULT} | start_agent, read_tool_result, search_tool_result, run_code`,
          `Forker prompt, version 1. | ${TEST_MODEL_DEFAULT} | start_agent, read_tool_result, search_tool_result, run_code`,
        ]);
        expect(inputLines(fork.calls[1]?.messages ?? [])).toEqual([
          'user: Fork task',
        ]);
        const forkRestart = await harness.sessions.get(forkRestartId, boris);
        expect([forkRestart.parentId, forkRestart.forkedFrom]).toEqual([
          forkerId,
          null,
        ]);

        // When: the leaf's record is deleted, then the planner's model is withdrawn from Борис, and each is restarted
        expect(await ownerRowCounts(harness.db, boris)).toEqual({
          tasks: 8,
          sessions: 8,
        });
        library.remove(leafRecordId);
        await expect(
          harness.sessions.restart({ agentId: leafId, ownerId: boris }),
        ).rejects.toMatchObject({
          code: 'START_REFUSED',
          refusal: { reason: 'record_unavailable', model: null },
        });
        modelRefusals[boris] = { [TEST_MODEL_CHOSEN]: MODEL_NOT_ALLOWED };
        await expect(
          harness.sessions.restart({ agentId: plannerId, ownerId: boris }),
        ).rejects.toMatchObject({
          code: 'START_REFUSED',
          refusal: { reason: 'model_not_allowed', model: TEST_MODEL_CHOSEN },
        });

        // Then: neither refused restart made an agent or a session
        expect(await ownerRowCounts(harness.db, boris)).toEqual({
          tasks: 8,
          sessions: 8,
        });
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-1 C: a name the runner cannot see starts a temporary agent without the hidden record, and a start on a model he may not use names its reason to the parent and writes no child task or session',
    async () => {
      // Given: Аня's agent names her personal "сбор логов"; it runs in Борис's tree. Борис's root also starts a
      // record on a model taken from him and one on a model with no connection
      const anya = await newUser();
      const boris = await newUser();
      const library = createLibraryDouble();
      const privatePrompt = 'Private prompt of Anya.';
      const target = testRecord('сбор логов', {
        ownerId: anya,
        everyone: false,
        prompt: privatePrompt,
      });
      library.add(target);
      library.add(
        testRecord('agent of Anya', { ownerId: anya, tools: ['start_agent'] }),
      );
      library.add(
        testRecord('chosen model agent', { model: TEST_MODEL_CHOSEN }),
      );
      library.add(
        testRecord('unconnected model agent', { model: UNCONNECTED_MODEL }),
      );
      const model = createScriptedModel();
      const root = model.script(
        { task: 'Start the agents of Anya' },
        [
          {
            calls: [
              startAgent({
                agent: 'agent of Anya',
                description: 'agent of anya',
                prompt: 'Collect the logs for Boris',
              }),
              startAgent({
                agent: 'chosen model agent',
                description: 'chosen model',
                prompt: 'Work on the chosen model',
              }),
              startAgent({
                agent: 'unconnected model agent',
                description: 'unconnected model',
                prompt: 'Work unconnected',
              }),
            ],
          },
        ],
        { thereafter: { text: 'noted' } },
      );
      model.script(
        { task: 'Collect the logs for Boris' },
        [
          {
            calls: [
              startAgent({
                agent: target.name,
                description: 'target',
                prompt: 'Target task',
              }),
            ],
          },
        ],
        { thereafter: { text: 'reports read' } },
      );
      const temporary = model.script({ task: 'Target task' }, [
        { text: 'report of target' },
      ]);
      const harness = await createAgentsHarness({
        model,
        library,
        access: {},
        root: testRecord('chat', { tools: ['start_agent'] }),
        ownerModelRefusals: {
          [boris]: { [TEST_MODEL_CHOSEN]: MODEL_NOT_ALLOWED },
        },
      });
      try {
        const { agentId: rootId } = await harness.sessions.start({
          ownerId: boris,
          prompt: 'Start the agents of Anya',
          description: 'conversation of Boris',
        });
        // When: Аня's agent starts "сбор логов" by its name
        const anyaAgentId = await startedChild(harness, rootId);
        const temporaryId = await startedChild(harness, anyaAgentId);
        await temporary.called(1);

        // Then (DC-24, KD-5): the name Борис cannot see started a temporary agent - the default agent's version
        // under the name from the call - and it did not run on Аня's prompt: the name was looked up for the runner
        const general = await library.resolveBuiltin('agent');
        expect(
          (await toolCallRowsOf(harness.db, anyaAgentId)).map(
            (call) => `${call.tool} ${call.outcome}`,
          ),
        ).toEqual(['start_agent success']);
        const view = await harness.sessions.get(temporaryId, boris);
        const pinned = await harness.sessions.version(temporaryId, boris);
        expect(`${view.name} ${pinned?.version.agentId}`).toBe(
          `${target.name} ${general.id}`,
        );
        expect(temporary.calls[0]?.instructions.includes(privatePrompt)).toBe(
          false,
        );

        // Then: the root's starts on a withdrawn and an unconnected model are refused with the model's number
        expect(
          (await toolCallRowsOf(harness.db, rootId)).map(
            (call) =>
              `${call.tool} ${call.outcome} ${call.refusalReason ?? '-'} ${JSON.stringify(call.refusalDetail)}`,
          ),
        ).toEqual([
          'start_agent success - null',
          `start_agent refused model_not_allowed {"model":"${TEST_MODEL_CHOSEN}"}`,
          `start_agent refused model_not_connected {"model":"${UNCONNECTED_MODEL}"}`,
        ]);
        expect(
          historyLines(await historyOf(harness, rootId, boris)).slice(0, 5),
        ).toEqual([
          'task: Start the agents of Anya',
          'model_answer:  [start_agent, start_agent, start_agent]',
          'tool_result: start_agent success',
          'tool_result: start_agent refused model_not_allowed',
          'tool_result: start_agent refused model_not_connected',
        ]);
        await root.called(1);

        // Then: Борис has the root, Аня's agent and its temporary agent - the refused starts wrote no task or session
        expect(await ownerRowCounts(harness.db, boris)).toEqual({
          tasks: 3,
          sessions: 3,
        });
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
  // ---------------------------------------------------------------------------------------------------------------
  // INT-2 A: a deep agent runs to its end on the copy of its whole team it started with, and the next run takes the new version
  // ---------------------------------------------------------------------------------------------------------------
  // AC-13.4 "Given запуск идёт, when автор меняет запись, then запуск
  //   доходит до конца на прежних копиях всех своих агентов"; AC-16.2 "when запускают снова, then работает новая версия"; AC-16.3 the team
  //   runs with the runner's rights; AC-16.4 "the deep agent sees each subagent's line and decides itself whom to start"; ADR-0017.
  // Behavior: Борис starts Аня's deep agent shared with him -> `resolveStart` builds ONE snapshot of the whole team from the record -> the
  //   deep agent and every subagent start from it, no library read for a subagent -> without `finalSubagent` the deep agent ends with its own text.
  // Catches: a deep agent or a subagent that reads the record at its own start (an author's edit reaches a run in progress); a deep agent that
  //   does not see each subagent's description and limit; a final answer refused although no `finalSubagent` is set; a second run that still
  //   uses the first run's copy.
  // @category: core-functionality
  // @dependency: Agents.resolveStart (deep agent source), startChild, gateStart, subagent snapshots, RecordLibrary (double), runtime, Postgres
  // @complexity: high
  it(
    'INT-2 A: a deep agent runs on one copy of its whole team whatever the author edits, ends with its own answer, and the next run takes the new version',
    async () => {
      // Given: Аня's deep agent version 1, open to Борис and offered in his chat
      const boris = await newUser();
      const ana = await newUser();
      const library = createLibraryDouble();
      const deepAgentId = library.add(
        testDeepAgent(TEAM_NAME, teamV1(), {
          ownerId: ana,
          ownerName: 'Аня',
          everyone: false,
          viewers: [boris],
        }),
      );
      const model = createScriptedModel();
      const held = createLatch();
      const firstRun = model.script(
        { task: FIRST_RUN_TASK },
        [
          {
            calls: [
              taskCall({
                subagentType: 'a',
                description: 'Read the timeline (run one).',
              }),
              taskCall({
                subagentType: 'b',
                description: 'Check the payment logs (run one).',
              }),
              taskCall({
                subagentType: 'c',
                description: 'Write the customer note (run one).',
              }),
            ],
            latch: held,
          },
        ],
        // The three task calls wake the deep agent once, with all three answers (deep-agents/design-task.md KD-4).
        { thereafter: { text: FIRST_ANSWER } },
      );
      const subagentA = model.script({ task: 'Read the timeline (run one).' }, [
        { text: 'The timeline is read.' },
      ]);
      const subagentB = model.script(
        { task: 'Check the payment logs (run one).' },
        [{ text: 'The logs are checked.' }],
      );
      const subagentC = model.script(
        { task: 'Write the customer note (run one).' },
        [{ text: 'The note is written.' }],
      );
      const harness = await createAgentsHarness({
        model,
        library,
        access: {},
        root: testRecord('chat'),
        deepAgentStarter: true,
      });
      try {
        // When: Борис's conversation starts the deep agent; its first call is held
        const first = await startDeepAgentRun(
          harness,
          model,
          boris,
          deepAgentId,
          FIRST_RUN_TASK,
        );
        await held.reached();

        // Then: the deep agent starts from its record's prompt, writes the answer itself and sees each subagent's line and limit
        const firstCall = firstRun.calls[0];
        expect(promptOf(firstCall)).toBe('You review incidents, version 1.');
        expect(firstCall?.instructions).toContain(WRITES_ANSWER_ITSELF);
        expect(teamLinesOf(firstCall)).toEqual(TEAM_V1_LINES);

        // When: while the run goes on, Аня saves version 2
        library.edit(deepAgentId, {
          body: { kind: 'deep_agent', content: teamV2() },
        });
        const readsBefore = library.resolveCalls.length;
        held.open();

        // Then: the run ends with the deep agent's own answer, on version 1, with no library read for a subagent
        expect(
          await waitForStatus(harness, first.deepAgentId, boris, 'completed'),
        ).toMatchObject({
          name: TEAM_NAME,
          origin: {
            recordId: deepAgentId,
            kind: 'deep_agent',
            version: 1,
            subagent: null,
          },
        });
        expect(library.resolveCalls.slice(readsBefore)).toEqual([]);

        // Then: the three subagents ran on the version-1 copy
        const team = (await harness.sessions.list(first.rootId, boris)).filter(
          (view) => view.parentId === first.deepAgentId,
        );
        expect(
          team
            .map(({ name, status, origin }) => ({
              name,
              status,
              version: origin?.version,
              subagent: origin?.subagent,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        ).toEqual([
          { name: 'a', status: 'completed', version: 1, subagent: 'a' },
          { name: 'b', status: 'completed', version: 1, subagent: 'b' },
          { name: 'c', status: 'completed', version: 1, subagent: 'c' },
        ]);
        expect(
          [subagentA, subagentB, subagentC].map((script) =>
            promptOf(script.calls[0]),
          ),
        ).toEqual([
          'You are subagent a of team version 1.',
          'You are subagent b of team version 1.',
          'You are subagent c of team version 1.',
        ]);

        // Then: every later input of the deep agent still holds the version-1 prompt and team
        expect(firstRun.calls.length).toBeGreaterThan(1);
        for (const call of firstRun.calls) {
          expect(promptOf(call)).toBe('You review incidents, version 1.');
          expect(teamLinesOf(call)).toEqual(TEAM_V1_LINES);
        }

        // Then: no "answer through the final subagent" notice; the root receives the deep agent's answer as the run's report
        expect(
          (await historyOf(harness, first.deepAgentId, boris)).filter(
            (entry) => entry.kind === 'notice',
          ),
        ).toEqual([]);
        const firstReports = await waitFor(
          () => childReportsOf(harness, first.rootId, boris),
          (reports) => reports.length > 0,
          'the report of the first run at the root',
        );
        expect(
          firstReports.map(({ agentId, status, text }) => ({
            agentId,
            status,
            text,
          })),
        ).toEqual([
          {
            agentId: first.deepAgentId,
            status: 'completed',
            text: FIRST_ANSWER,
          },
        ]);

        // When: Борис starts the deep agent again
        const secondRun = model.script(
          { task: SECOND_RUN_TASK },
          [
            {
              calls: [
                taskCall({
                  subagentType: 'a',
                  description: 'Read the timeline (run two).',
                }),
              ],
            },
          ],
          { thereafter: { text: SECOND_ANSWER } },
        );
        const subagentASecond = model.script(
          { task: 'Read the timeline (run two).' },
          [{ text: 'The timeline is read again.' }],
        );
        const second = await startDeepAgentRun(
          harness,
          model,
          boris,
          deepAgentId,
          SECOND_RUN_TASK,
        );

        // Then: the second run is version 2 - the deep agent's prompt and team, and `a` with its new prompt (AC-16.2)
        expect(
          await waitForStatus(harness, second.deepAgentId, boris, 'completed'),
        ).toMatchObject({
          origin: { recordId: deepAgentId, version: 2, subagent: null },
        });
        expect(promptOf(secondRun.calls[0])).toBe(
          'You review incidents, version 2.',
        );
        expect(teamLinesOf(secondRun.calls[0])).toEqual(TEAM_V2_LINES);
        expect(promptOf(subagentASecond.calls[0])).toBe(
          'You are subagent a of team version 2.',
        );
      } finally {
        held.open();
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
