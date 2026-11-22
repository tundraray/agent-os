// deep-agents / agent-types - the brief (`start_deep_agent`) and the deep agent run in `agents`
// Design Doc: docs/features/deep-agents/design-agent-types.md (KD-2, Contract «`start_deep_agent`», «Маршруты» `/run`, Test Strategy UC-6)
// PRD: docs/features/deep-agents/prd.md (AC-03.1, AC-07.1, AC-02.2, AC-05.1, AC-05.2). Upstream: agent-platform design-workflows.md (archived), whose INT-1..INT-3 these rows were.
// Test type: Integration (in-process `createRuntime` + `createAgents` over real Postgres, real MCP fixture process, scripted model), run with
//   `pnpm --filter @agent-os/agents test:e2e` (`*.e2e-spec.ts`), never in the default `vitest run`.
//
// The tree root runs the library double's `chat` record without tools of its own, so the built-in, root-only `start_deep_agent` is the tool
// it calls; the brief is confirmed through the real `agents.brief` decision. The deep agents under test are records of the double:
// `deep-research` (INT-1, INT-2 - plan, gather over the run's `logs` server, answer as `finalSubagent`) and `limits-check` (INT-3 B - a deep
// agent with `maxTurns` 6 and one subagent `answer` as `finalSubagent`).
// Isolation: a unique owner `newUser()` per test, each test reads only its own tree. No sleeps for ordering: latches and rows.
//
// Not here: a start outside the team, a fork or a deep agent record at a deep agent (the `gateStart` table in tool-gate.spec.ts and
// agent-platform-agents INT-1 D); the brief card's content and the refusal order of `start_deep_agent` (start-deep-agent.spec.ts); the run
// view's mapping (deep-agent-run.spec.ts).
//
// AC -> proving test:
// - AC-03.1 (the deep agent starts only after the brief is approved, once per request; a decline starts nothing): INT-1
// - AC-07.1, AC-02.2, AC-05.1, AC-05.2 (one assignment per subagent, the final subagent's report is the answer): INT-2 A, INT-3 B
// - the run view and its isolation between owners: INT-2 B

import { randomUUID } from 'node:crypto';
import { type AgentHistoryEntry, AgentsError, type AgentTurnMessage, type AgentView, WAITING_RULE } from '@agent-os/agents';
import {
  createLatch,
  createScriptedModel,
  inputLines,
  modelError,
  type ReplyFromInput,
  type Script,
  type ScriptedModel,
  type ScriptedToolCall,
} from '@agent-os/agents/testing';
import { createFixtureFiles, type FixtureFiles, fixtureCallsOf, holdCall } from '@agent-os/mcp-fixture';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  childReportsOf,
  createAgentsHarness,
  deepAgentsUnder,
  historyOf,
  TEST_AUTHOR_ID,
  TEST_MODEL_CHOSEN,
  TEST_MODEL_DEFAULT,
  type TestDeepAgentRecord,
  testDeepAgent,
  testRecord,
  testSubagent,
  waitFor,
  waitForStatus,
} from './support/agentsHarness';
import { LOGS_SERVER } from './support/mcp-servers';
import { newUser } from './support/new-user';

/** Name of the test root: the conversation that starts deep agents. */
const ROOT_NAME = 'deep-agents-root';

/** The root every `sessions.start` runs: no tools of its own, so the root-only `start_deep_agent` is what it calls. */
const ROOT_RECORD = testRecord(ROOT_NAME, {
  prompt: 'You are a test conversation. Start a deep agent with start_deep_agent when asked.',
  maxTurns: 40,
});

/** Runtime + agents with the root above, the run's `logs` server for every owner, on these fixture files. */
function createDeepAgentsHarness(model: ScriptedModel, fixture?: FixtureFiles): Promise<AgentsHarness> {
  return createAgentsHarness({
    model,
    access: { '*': [LOGS_SERVER] },
    root: ROOT_RECORD,
    mcpServers: ['logs'],
    ...(fixture === undefined ? {} : { fixture }),
  });
}

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** The deep agent record the root starts: its name is the deep agent's name. */
const DEEP_RESEARCH = 'deep-research';

const PLAN_AGENT = 'deep-research-plan';
const GATHER_AGENT = 'deep-research-gather';
const ANSWER_AGENT = 'deep-research-answer';

/**
 * The `deep-research` deep agent record: a deep agent on the chosen model, one plan, up to five gather runs
 * over the run's `logs` server, and the answer as `finalSubagent`.
 */
function deepResearchRecord(): TestDeepAgentRecord {
  return testDeepAgent(DEEP_RESEARCH, {
    prompt: 'Plan first, then gather every direction, then write the answer.',
    servers: [],
    model: TEST_MODEL_CHOSEN,
    maxTurns: 20,
    subagents: [
      testSubagent(PLAN_AGENT, { description: 'Splits the brief into directions to gather data on.', maxTurns: 6, maxRuns: 1 }),
      testSubagent(GATHER_AGENT, {
        description: 'Gathers data on one direction and reports what it found.',
        servers: [LOGS_SERVER],
        maxTurns: 16,
        maxRuns: 5,
      }),
      testSubagent(ANSWER_AGENT, { description: 'Writes the answer from the reports of the directions.', maxTurns: 2, maxRuns: 2 }),
    ],
    finalSubagent: ANSWER_AGENT,
    taskList: true,
    selfLearning: false,
  });
}

/** The INT-3 B deep agent record and its only subagent, the final one. */
const LIMITS_DEEP_AGENT = 'limits-check';
const LIMITS_ANSWER_AGENT = 'answer';

/** `limits-check`: a cheap deep agent with `maxTurns` 6 and one subagent `answer`, started at most twice, as `finalSubagent`. */
function limitsRecord(): TestDeepAgentRecord {
  return testDeepAgent(LIMITS_DEEP_AGENT, {
    prompt: 'Start the subagent answer with start_agent and wait for its report.',
    servers: [],
    model: TEST_MODEL_DEFAULT,
    maxTurns: 6,
    subagents: [testSubagent(LIMITS_ANSWER_AGENT, { description: 'Writes the answer of the limits check.', maxTurns: 2, maxRuns: 2 })],
    finalSubagent: LIMITS_ANSWER_AGENT,
    taskList: true,
    selfLearning: false,
  });
}

/** One INT-1 conversation: the root's task, its two replies around the employee's follow-up, and the brief it proposes. */
interface BriefConversation {
  readonly task: string;
  readonly firstReply: string;
  readonly followUp: string;
  readonly secondReply: string;
  readonly brief: { readonly question: string; readonly boundaries: string; readonly result: string };
  /** Id of the deep agent record the root asks for. */
  readonly deepAgent: string;
}

/** A root whose `start_deep_agent` call waits for the employee's decision. */
interface WaitingBrief {
  readonly rootId: string;
  readonly rootScript: Script;
  readonly decisionId: string;
}

/**
 * Starts a root with a two-message history before the call: the root replies to its task, the employee
 * follows up, and the root's second reply calls `start_deep_agent` with the conversation's brief. Returns
 * once the brief waits for the decision. Every root call after the second answers with a short text.
 */
async function rootWithWaitingBrief(
  harness: AgentsHarness,
  model: ScriptedModel,
  ownerId: string,
  conversation: BriefConversation,
): Promise<WaitingBrief> {
  const rootScript = model.script(
    { task: conversation.task },
    [
      { text: conversation.firstReply },
      {
        text: conversation.secondReply,
        calls: [
          { tool: 'start_deep_agent', args: { deepAgent: conversation.deepAgent, ...conversation.brief } },
        ],
      },
    ],
    { thereafter: { text: 'Noted.' } },
  );
  const { agentId: rootId } = await harness.sessions.start({
    ownerId,
    prompt: conversation.task,
    description: 'Conversation',
  });
  await waitFor(
    () => historyOf(harness, rootId, ownerId),
    (entries) => entries.some((entry) => entry.kind === 'model_answer' && entry.content.text === conversation.firstReply),
    `root ${rootId} to answer its task`,
  );
  await harness.sessions.send({ agentId: rootId, ownerId, text: conversation.followUp });
  const [request] = await waitFor(
    async () => (await harness.sessions.confirmations(rootId, ownerId)).filter((c) => c.status === 'open'),
    (open) => open.length === 1,
    `the brief of root ${rootId} to wait for a decision`,
  );
  return { rootId, rootScript, decisionId: request.decisionId };
}

/** Names of the root's tree, in creation order. */
async function namesUnder(harness: AgentsHarness, rootId: string, ownerId: string): Promise<string[]> {
  return (await harness.sessions.list(rootId, ownerId)).map((view) => view.name);
}

/** The root's `start_deep_agent` result entries, as `history` stores them. */
function startDeepAgentResults(entries: readonly AgentHistoryEntry[]) {
  return entries.flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === 'start_deep_agent' ? [entry.content] : [],
  );
}

/** The output of the last tool message of a recorded model input. */
function lastToolOutput(script: Script, call: number): { toolName: string; output: unknown }[] {
  const messages = script.calls[call - 1].messages;
  const last = messages[messages.length - 1];
  if (last.role !== 'tool') throw new Error(`Call ${call} does not end with a tool result: ${inputLines(messages).join(' | ')}`);
  return last.results.map((result) => ({ toolName: result.toolName, output: result.output }));
}

/** A `start_agent` call of a scripted answer. */
function startAgent(agent: string, description: string, prompt: string): ScriptedToolCall {
  return { tool: 'start_agent', args: { agent, description, prompt } };
}

/** Each `start_agent` result of an agent's history as [agent asked for, outcome, refusal reason], in order. */
function startAgentResults(entries: readonly AgentHistoryEntry[]): [string, string, string | null][] {
  return entries.flatMap((entry): [string, string, string | null][] =>
    entry.kind === 'tool_result' && entry.content.tool === 'start_agent'
      ? [[(entry.content.args as { agent: string }).agent, entry.content.outcome, entry.content.refusalReason]]
      : [],
  );
}

/** The child reports an agent's history holds, in order. */
function childReportsOfHistory(entries: readonly AgentHistoryEntry[]) {
  return entries.flatMap((entry) => (entry.kind === 'child_report' ? [entry.content] : []));
}

/** The direct children of an agent, in creation order. */
async function childrenOf(harness: AgentsHarness, rootId: string, parentId: string, ownerId: string): Promise<AgentView[]> {
  return (await harness.sessions.list(rootId, ownerId)).filter((view) => view.parentId === parentId);
}

/** The `start_agent` calls of the model's own earlier answers in a recorded input. */
function startCallsIn(messages: readonly AgentTurnMessage[]): { agent: string; description: string }[] {
  return messages.flatMap((message) =>
    message.role === 'assistant'
      ? message.toolCalls.flatMap((call) =>
          call.toolName === 'start_agent' ? [call.args as { agent: string; description: string }] : [],
        )
      : [],
  );
}

/** The child reports of a recorded input, as the provider gets them (`provider-messages.ts`). */
function childReportsIn(messages: readonly AgentTurnMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'user' && message.content.startsWith('<data source="child agent report"') ? [message.content] : [],
  );
}

/** Whether the newest part of a recorded input is the results of the model's own last calls. */
function endsWithOwnResults(messages: readonly AgentTurnMessage[]): boolean {
  return messages[messages.length - 1]?.role === 'tool';
}

// ----- INT-2: the deep-research run (one per test: each test has its own harness and model) -----

/** The fixture's read tool (the run's `logs` server) the first gather agent calls, and its arguments. */
const GET_TRACE = `mcp__${LOGS_SERVER}__get_trace`;
const TRACE = { traceId: 'c'.repeat(32) };

const RUN_BRIEF = {
  question: 'Why did card payments fail yesterday between 10:00 and 12:00 UTC?',
  boundaries: 'payments service and its gateway only',
  result: 'causes with the evidence for each',
} as const;
/** The deep agent's task: the confirmed brief as `start_deep_agent` writes it. */
const RUN_TASK =
  '{"question":"Why did card payments fail yesterday between 10:00 and 12:00 UTC?","boundaries":"payments service and its gateway only","result":"causes with the evidence for each"}';

const PLAN_DESCRIPTION = 'План ресерча';
const GATHER_A_DESCRIPTION = 'Сбор · ошибки авторизации';
const GATHER_B_DESCRIPTION = 'Сбор · таймауты шлюза';
const ANSWER_DESCRIPTION = 'Ответ ресерча';

const PLAN_TASK = `Plan the research of this brief: ${RUN_TASK}`;
const GATHER_A_TASK = `Gather data on the direction "authorization errors" of this brief: ${RUN_TASK}`;
const GATHER_B_TASK = `Gather data on the direction "gateway timeouts" of this brief: ${RUN_TASK}`;
const ANSWER_TASK =
  `Write the answer of this brief: ${RUN_TASK}. Direction "authorization errors": issuer declines rose at 10:40. ` +
  'Direction "gateway timeouts": no data, the gather agent failed (provider_unavailable).';

const PLAN_REPORT = '1. authorization errors - logs\n2. gateway timeouts - logs';
const GATHER_A_REPORT = 'Issuer declines rose at 10:40 UTC (get_trace).';
/** The answer agent's report: the run's report, literally. */
const ANSWER_TEXT =
  'Card payments failed because issuer declines rose at 10:40 UTC. Gateway timeouts: no data, the gather agent failed.';

/** Whether a recorded input holds the report of the child with this description. */
function reported(messages: readonly AgentTurnMessage[], description: string): boolean {
  return childReportsIn(messages).some((report) => report.includes(description));
}

/**
 * The deep agent of INT-2 answers from its own input: results of its own
 * `start_agent` newest -> a short text (it waits); otherwise by what has started and reported: two plan
 * agents in one answer, then both gather agents in one answer, a text while a gather report is missing,
 * then the answer agent, then a closing text. With `maxTurns` 20 the run takes about eight calls, the
 * texts on its own results being calls 2, 4 and 7.
 */
const deepResearchCoordinator: ReplyFromInput = (messages) => {
  if (endsWithOwnResults(messages)) return { text: 'Waiting for the agents I started.' };
  const started = startCallsIn(messages).map((call) => call.description);
  if (!started.includes(PLAN_DESCRIPTION)) {
    return {
      calls: [
        startAgent(PLAN_AGENT, PLAN_DESCRIPTION, PLAN_TASK),
        startAgent(PLAN_AGENT, PLAN_DESCRIPTION, PLAN_TASK),
      ],
    };
  }
  if (!reported(messages, PLAN_DESCRIPTION)) return { text: 'Waiting for the plan.' };
  if (!started.includes(GATHER_A_DESCRIPTION)) {
    return {
      calls: [
        startAgent(GATHER_AGENT, GATHER_A_DESCRIPTION, GATHER_A_TASK),
        startAgent(GATHER_AGENT, GATHER_B_DESCRIPTION, GATHER_B_TASK),
      ],
    };
  }
  if (!reported(messages, GATHER_A_DESCRIPTION) || !reported(messages, GATHER_B_DESCRIPTION)) {
    return { text: 'Waiting for the other direction.' };
  }
  if (!started.includes(ANSWER_DESCRIPTION)) return { calls: [startAgent(ANSWER_AGENT, ANSWER_DESCRIPTION, ANSWER_TASK)] };
  if (!reported(messages, ANSWER_DESCRIPTION)) return { text: 'Waiting for the answer.' };
  return { text: 'The answer is ready.' };
};

/** A deep-research run started through a confirmed brief. */
interface DeepResearchRun {
  readonly deepAgentId: string;
  readonly rootId: string;
  readonly coordinatorId: string;
  readonly coordinatorScript: Script;
}

/**
 * Scripts the run's agents (the second gather agent's model always errors, the first makes one `logs`
 * read), starts the root, confirms its brief unchanged and returns once the coordinator exists.
 */
async function startDeepResearch(harness: AgentsHarness, model: ScriptedModel, ownerId: string): Promise<DeepResearchRun> {
  const deepAgentId = harness.library.add(deepResearchRecord());
  const coordinatorScript = model.script({ task: RUN_TASK }, [], { thereafter: deepResearchCoordinator });
  model.script({ task: PLAN_TASK }, [{ text: PLAN_REPORT }]);
  model.script({ task: GATHER_A_TASK }, [{ calls: [{ tool: GET_TRACE, args: TRACE }] }, { text: GATHER_A_REPORT }]);
  model.script({ task: GATHER_B_TASK }, [], { thereafter: modelError() });
  model.script({ task: ANSWER_TASK }, [{ text: ANSWER_TEXT }]);
  const root = await rootWithWaitingBrief(harness, model, ownerId, {
    task: 'Why did card payments fail yesterday?',
    firstReply: 'Root reply one: which period?',
    followUp: 'Yesterday 10:00-12:00 UTC',
    secondReply: 'Root reply two: here is the brief to confirm.',
    brief: RUN_BRIEF,
    deepAgent: deepAgentId,
  });
  expect(
    await harness.sessions.resolveConfirmation({ decisionId: root.decisionId, ownerId, approve: true }),
  ).toBe('resolved');
  const [coordinator] = await waitFor(
    () => deepAgentsUnder(harness, root.rootId, ownerId),
    (found) => found.length > 0,
    'the coordinator of the run',
  );
  return { deepAgentId, rootId: root.rootId, coordinatorId: coordinator.agentId, coordinatorScript };
}

// ----- INT-3 B: the deep agent `limits-check` -----

const ANSWER_RUN_TASK = 'Write the answer of the limits check.';

/**
 * The deep agent of INT-3 B answers from its own input, by its starts of `answer` (s) and the failures of
 * `answer` that came (f): s = 0 -> start `answer`; s > f -> text (the child has not ended); s = f = 1 ->
 * start `answer` again; f = 2 -> text. Expected order: call 1 start, 2 text, 3 start, 4 text, 5 and 6
 * text each met by a notice, then `turn_limit`.
 */
const limitsCoordinator: ReplyFromInput = (messages) => {
  const starts = startCallsIn(messages).filter((call) => call.agent === LIMITS_ANSWER_AGENT).length;
  const failures = childReportsIn(messages).filter((report) => report.includes('ended: failed')).length;
  if (starts === 0) return { calls: [startAgent(LIMITS_ANSWER_AGENT, 'Answer', ANSWER_RUN_TASK)] };
  if (starts > failures) return { text: 'Waiting for the answer.' };
  if (failures === 1) return { calls: [startAgent(LIMITS_ANSWER_AGENT, 'Answer, second run', ANSWER_RUN_TASK)] };
  return { text: 'I could not get the answer.' };
};

describe('deep-agents / agent-types - the brief and the deep agent run (in-process runtime + agents, real Postgres, real MCP fixture, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  The brief: nothing starts before the decision, a confirmed (or corrected) brief is the deep agent's only input, a declined or invalid one starts nothing
  // ---------------------------------------------------------------------------------------------------------------
  // AC-03.1 (deep-agents): the deep agent starts only through the brief the employee approved, once per request; a decline starts nothing.
  // Catches: (1) a deep agent that exists before the employee decided, or one started from the model's original arguments after the employee
  //   edited the question; (2) the conversation leaking into the deep agent's input - a first history entry that is not exactly the brief JSON;
  //   (3) two deep agents from one request (a repeated decision that starts a second one); (4) a declined brief that still starts a deep agent,
  //   or an invalid edit (empty question) that is accepted or closes the request; (5) a `start_deep_agent` result without the run id and the
  //   confirmed brief.
  // Rows: A "confirm with a corrected question" - one open `agents.brief` request with the record and the three fields and no deep agent
  //   before the decision; after approve with an edited question exactly one deep agent `deep-research` whose first history entry and first
  //   model input are the edited brief JSON; the root's next input holds the run id and the brief; a repeated decision is `already_resolved`.
  //   B "correction with an empty question" - `INVALID_ARGUMENTS`, the request stays open, nothing starts; a valid approval starts one.
  //   C "decline" - no deep agent ever; the call closes `rejected` and the root's next input holds it.
  it(
    'INT-1: a brief waits without starting anything, a confirmed or corrected one starts exactly one deep agent whose only input is that brief, an empty correction is refused and keeps the request open, and a decline starts nothing',
    async () => {
      const model = createScriptedModel();
      const ownerA = newUser();
      const ownerB = newUser();
      const ownerC = newUser();
      // The coordinators' first model calls are held: what the test reads is their input, not their run.
      const coordinatorHeld = createLatch();
      const harness = await createDeepAgentsHarness(model);
      const deepAgentId = harness.library.add(deepResearchRecord());
      try {
        // Row A "confirm with a corrected question" (AC-28.1, AC-28.2, AC-20.1, Invariants 1-2).
        const coordinatorA = model.script(
          {
            task: '{"question":"Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?","boundaries":"payments service only, no refunds","result":"causes with the evidence for each"}',
          },
          [],
          { thereafter: { latch: coordinatorHeld } },
        );
        const a = await rootWithWaitingBrief(harness, model, ownerA, {
          task: 'Why did payments fail yesterday? (A)',
          firstReply: 'Root reply one (A): which service and which period?',
          followUp: 'The payments service, yesterday 10:00-12:00 UTC (A)',
          secondReply: 'Root reply two (A): here is the brief to confirm.',
          brief: {
            question: 'Why did payments fail yesterday (A)?',
            boundaries: 'payments service only',
            result: 'a short list of causes',
          },
          deepAgent: deepAgentId,
        });

        // Before the decision: one open request of kind `agents.brief` with the record and the three fields, no deep agent.
        const askedBrief = {
          deepAgent: deepAgentId,
          question: 'Why did payments fail yesterday (A)?',
          boundaries: 'payments service only',
          result: 'a short list of causes',
        };
        expect(
          (await harness.sessions.confirmations(a.rootId, ownerA))
            .filter((c) => c.status === 'open')
            .map(({ kind, tool, server, args, content }) => ({ kind, tool, server, args, content })),
        ).toEqual([
          { kind: 'agents.brief', tool: 'start_deep_agent', server: null, args: askedBrief, content: askedBrief },
        ]);
        expect(await namesUnder(harness, a.rootId, ownerA)).toEqual([ROOT_NAME]);

        // The employee confirms with the question, boundaries and result edited.
        expect(
          await harness.sessions.resolveConfirmation({
            decisionId: a.decisionId,
            ownerId: ownerA,
            approve: true,
            args: {
              deepAgent: deepAgentId,
              question: 'Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?',
              boundaries: 'payments service only, no refunds',
              result: 'causes with the evidence for each',
            },
          }),
        ).toBe('resolved');
        const [coordinator] = await waitFor(
          () => deepAgentsUnder(harness, a.rootId, ownerA),
          (found) => found.length > 0,
          'the coordinator of row A',
        );
        expect(coordinator).toMatchObject({
          parentId: a.rootId,
          name: 'deep-research',
          origin: { recordId: deepAgentId, kind: 'deep_agent', version: 1, subagent: null },
          description: 'Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?',
        });

        // The coordinator's only input is the edited brief: its first history entry and its whole first model input.
        const coordinatorHistory = await historyOf(harness, coordinator.agentId, ownerA);
        expect(coordinatorHistory[0]).toMatchObject({
          kind: 'task',
          content: {
            text: '{"question":"Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?","boundaries":"payments service only, no refunds","result":"causes with the evidence for each"}',
          },
        });
        expect(JSON.stringify(coordinatorHistory)).not.toContain('Root reply');
        expect(JSON.stringify(coordinatorHistory)).not.toContain('Why did payments fail yesterday (A)?');
        await coordinatorA.called(1);
        expect(inputLines(coordinatorA.calls[0].messages)).toEqual([
          'user: {"question":"Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?","boundaries":"payments service only, no refunds","result":"causes with the evidence for each"}',
        ]);

        // The call result carries the run id and the confirmed brief, and the root's next model input holds it.
        expect(startDeepAgentResults(await historyOf(harness, a.rootId, ownerA))).toMatchObject([
          {
            outcome: 'success',
            text: `Deep agent "deep-research" started in the background, run id ${coordinator.agentId}. Confirmed brief: {"question":"Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?","boundaries":"payments service only, no refunds","result":"causes with the evidence for each"}\nIts answer will arrive as a message when it finishes. ${WAITING_RULE}`,
          },
        ]);
        await a.rootScript.called(3);
        const [rootSeesA] = lastToolOutput(a.rootScript, 3);
        expect(rootSeesA.toolName).toBe('start_deep_agent');
        expect(String(rootSeesA.output)).toContain(`run id ${coordinator.agentId}`);
        expect(String(rootSeesA.output)).toContain(
          'Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?',
        );

        // A repeated decision starts nothing more.
        expect(
          await harness.sessions.resolveConfirmation({ decisionId: a.decisionId, ownerId: ownerA, approve: true }),
        ).toBe('already_resolved');
        expect(await deepAgentsUnder(harness, a.rootId, ownerA)).toHaveLength(1);

        // Row B "correction with an empty question" (DC-4): refused, the request stays open, nothing starts; a valid approval starts one.
        const coordinatorB = model.script(
          { task: '{"question":"Which merchants saw declined payments last week (B)?","boundaries":"","result":""}' },
          [],
          { thereafter: { latch: coordinatorHeld } },
        );
        const b = await rootWithWaitingBrief(harness, model, ownerB, {
          task: 'Which merchants had declines? (B)',
          firstReply: 'Root reply one (B): over which period?',
          followUp: 'Last week (B)',
          secondReply: 'Root reply two (B): here is the brief to confirm.',
          brief: { question: 'Which merchants saw declined payments last week (B)?', boundaries: '', result: '' },
          deepAgent: deepAgentId,
        });
        await expect(
          harness.sessions.resolveConfirmation({
            decisionId: b.decisionId,
            ownerId: ownerB,
            approve: true,
            args: { deepAgent: deepAgentId, question: '', boundaries: '', result: '' },
          }),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
        expect(
          (await harness.sessions.confirmations(b.rootId, ownerB)).filter((c) => c.status === 'open').map((open) => open.decisionId),
        ).toEqual([b.decisionId]);
        expect(await namesUnder(harness, b.rootId, ownerB)).toEqual([ROOT_NAME]);

        expect(
          await harness.sessions.resolveConfirmation({ decisionId: b.decisionId, ownerId: ownerB, approve: true }),
        ).toBe('resolved');
        const coordinatorsB = await waitFor(
          () => deepAgentsUnder(harness, b.rootId, ownerB),
          (found) => found.length > 0,
          'the coordinator of row B',
        );
        expect(coordinatorsB).toHaveLength(1);
        expect((await historyOf(harness, coordinatorsB[0].agentId, ownerB))[0]).toMatchObject({
          kind: 'task',
          content: { text: '{"question":"Which merchants saw declined payments last week (B)?","boundaries":"","result":""}' },
        });
        await coordinatorB.called(1);
        await b.rootScript.called(3);
        expect(await deepAgentsUnder(harness, b.rootId, ownerB)).toHaveLength(1);

        // Row C "decline" (AC-28.3): no coordinator ever, the call closes as rejected and the root's next input holds it.
        const c = await rootWithWaitingBrief(harness, model, ownerC, {
          task: 'How many payments timed out today? (C)',
          firstReply: 'Root reply one (C): all payment methods?',
          followUp: 'Yes, all of them (C)',
          secondReply: 'Root reply two (C): here is the brief to confirm.',
          brief: { question: 'How many payments timed out today (C)?', boundaries: 'today only', result: 'one number' },
          deepAgent: deepAgentId,
        });
        expect(
          await harness.sessions.resolveConfirmation({ decisionId: c.decisionId, ownerId: ownerC, approve: false }),
        ).toBe('resolved');
        await c.rootScript.called(3);
        expect(lastToolOutput(c.rootScript, 3)).toEqual([
          {
            toolName: 'start_deep_agent',
            output: '<data source="tool start_deep_agent" author="agents">\n[rejected]\n</data>',
          },
        ]);
        expect(startDeepAgentResults(await historyOf(harness, c.rootId, ownerC))).toMatchObject([
          { outcome: 'rejected', refusalReason: null },
        ]);
        expect((await harness.sessions.confirmations(c.rootId, ownerC)).filter((request) => request.status === 'open')).toEqual([]);
        expect(await namesUnder(harness, c.rootId, ownerC)).toEqual([ROOT_NAME]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  A deep-research run reaches the report in the parent conversation, survives a failed gather subagent, and reads back as one run
  // ---------------------------------------------------------------------------------------------------------------
  // AC-07.1, AC-02.2, AC-05.1, AC-05.2 (deep-agents): every subagent gets one assignment, the final subagent's report is the run's answer.
  // Catches: (1) a team, tool or MCP wiring that does not make the plan -> gather -> answer chain run against the real loop; (2) the record's
  //   `maxRuns` not reaching the deep agent through `start_deep_agent` (a second plan allowed); (3) the gather subagents running one after
  //   another; (4) a failed gather subagent that kills the run, hides from the deep agent or leaves it without its answer; (5) the root
  //   getting the deep agent's own closing text instead of the answer subagent's report; (6) a run view that shows other steps than the deep
  //   agent's children, loses the brief, or answers for another employee's run or an ordinary agent.
  // Rows: A "run to the report" - the second plan is refused `run_limit`; the second gather subagent fails while the first is still working;
  //   the failure reaches the deep agent as a report with status and reason and it starts the answer subagent after both ended; one run
  //   under the root; the root gets one `completed` report whose text is the answer subagent's text, literally.
  //   B "reading the run" - `sessions.run` returns the origin, the brief, the deep agent, the team, the four steps in creation order and the
  //   one limit refusal; a foreign owner, an ordinary agent and an unknown id get one and the same `RUN_NOT_FOUND`.
  it(
    "INT-2 A: the deep-research deep agent runs plan, two gather subagents at once and the answer, refuses the second plan, goes on after a failed gather subagent, and hands the root the answer subagent's text as the run's report",
    async () => {
      const model = createScriptedModel();
      const ownerId = newUser();
      // The first gather agent's read is held on the fixture until the second gather agent has failed.
      const fixture = createFixtureFiles('agents-e2e');
      const gatherRead = fixture.latch('gather-read');
      fixture.setFaults([holdCall('get_trace', TRACE, gatherRead)]);
      const harness = await createDeepAgentsHarness(model, fixture);
      try {
        const run = await startDeepResearch(harness, model, ownerId);

        // The gather agents run at once: the second fails while the first is still inside its read.
        await waitFor(
          () => fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE }),
          (calls) => calls.length === 1,
          'the first gather agent read on the fixture',
        );
        const whileHeld = await waitFor(
          () => childrenOf(harness, run.rootId, run.coordinatorId, ownerId),
          (children) => children.some((child) => child.description === GATHER_B_DESCRIPTION && child.status === 'failed'),
          'the second gather agent to fail',
        );
        expect(
          whileHeld
            .filter((child) => child.name === GATHER_AGENT)
            .map(({ description, status, failureReason }) => ({ description, status, failureReason }))
            .sort((left, right) => left.description.localeCompare(right.description)),
        ).toEqual([
          { description: 'Сбор · ошибки авторизации', status: 'working', failureReason: null },
          { description: 'Сбор · таймауты шлюза', status: 'failed', failureReason: 'provider_unavailable' },
        ]);
        gatherRead.release();

        expect(await waitForStatus(harness, run.coordinatorId, ownerId, 'completed')).toMatchObject({
          name: 'deep-research',
          status: 'completed',
        });

        // The record's count of one plan reached the deep agent: the second plan is refused by the limit, no task for it.
        const coordinatorHistory = await historyOf(harness, run.coordinatorId, ownerId);
        expect(startAgentResults(coordinatorHistory)).toEqual([
          ['deep-research-plan', 'success', null],
          ['deep-research-plan', 'refused', 'run_limit'],
          ['deep-research-gather', 'success', null],
          ['deep-research-gather', 'success', null],
          ['deep-research-answer', 'success', null],
        ]);

        // One run in the root's tree: the coordinator, with plan, gather (completed), gather (failed) and answer under it.
        expect((await childrenOf(harness, run.rootId, run.rootId, ownerId)).map((child) => child.agentId)).toEqual([
          run.coordinatorId,
        ]);
        const steps = await childrenOf(harness, run.rootId, run.coordinatorId, ownerId);
        expect(steps).toHaveLength(4);
        expect(steps.map(({ name, description, status }) => ({ name, description, status }))).toEqual(
          expect.arrayContaining([
            { name: 'deep-research-plan', description: 'План ресерча', status: 'completed' },
            { name: 'deep-research-gather', description: 'Сбор · ошибки авторизации', status: 'completed' },
            { name: 'deep-research-gather', description: 'Сбор · таймауты шлюза', status: 'failed' },
            { name: 'deep-research-answer', description: 'Ответ ресерча', status: 'completed' },
          ]),
        );

        // The failure came to the coordinator as a report with status and reason, and its next input held it.
        expect(
          childReportsOfHistory(coordinatorHistory).map(({ description, status, reason }) => ({ description, status, reason })),
        ).toEqual(
          expect.arrayContaining([{ description: 'Сбор · таймауты шлюза', status: 'failed', reason: 'provider_unavailable' }]),
        );
        const inputAfterFailure = run.coordinatorScript.calls.find((call) => reported(call.messages, GATHER_B_DESCRIPTION));
        expect(childReportsIn(inputAfterFailure?.messages ?? []).find((report) => report.includes(GATHER_B_DESCRIPTION))).toContain(
          'Agent &quot;Сбор · таймауты шлюза&quot; ended: failed (provider_unavailable).',
        );

        // The coordinator started the answer agent only after both gather agents had ended.
        const reportSeq = (description: string) =>
          coordinatorHistory.find((entry) => entry.kind === 'child_report' && entry.content.description === description)?.seq ?? Infinity;
        const answerStartSeq = coordinatorHistory.find(
          (entry) =>
            entry.kind === 'model_answer' &&
            entry.content.toolCalls.some((call) => (call.args as { agent?: string }).agent === 'deep-research-answer'),
        )?.seq;
        expect(answerStartSeq).toBeGreaterThan(reportSeq('Сбор · ошибки авторизации'));
        expect(answerStartSeq).toBeGreaterThan(reportSeq('Сбор · таймауты шлюза'));

        // The root received one notification "completed" whose text is the answer agent's text, literally.
        const rootReports = await waitFor(
          () => childReportsOf(harness, run.rootId, ownerId),
          (reports) => reports.length > 0,
          'the run report at the root',
        );
        expect(rootReports.map(({ agentId, status, reason, text }) => ({ agentId, status, reason, text }))).toEqual([
          {
            agentId: run.coordinatorId,
            status: 'completed',
            reason: null,
            text: 'Card payments failed because issuer declines rose at 10:40 UTC. Gateway timeouts: no data, the gather agent failed.',
          },
        ]);
      } finally {
        gatherRead.release();
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-2 B: sessions.run returns the origin, the brief, the team, the four steps of a run in order and its over-limit start, and answers a foreign owner, an ordinary agent and an unknown id the same: RUN_NOT_FOUND',
    async () => {
      const model = createScriptedModel();
      const ownerId = newUser();
      const otherOwner = newUser();
      const harness = await createDeepAgentsHarness(model);
      try {
        const run = await startDeepResearch(harness, model, ownerId);
        await waitForStatus(harness, run.coordinatorId, ownerId, 'completed');

        const view = await harness.sessions.run(run.coordinatorId, ownerId);
        expect(view).toMatchObject({
          origin: {
            recordId: run.deepAgentId,
            kind: 'deep_agent',
            version: 1,
            name: 'deep-research',
            author: { id: TEST_AUTHOR_ID },
            builtinKey: null,
            subagent: null,
          },
          brief: {
            question: 'Why did card payments fail yesterday between 10:00 and 12:00 UTC?',
            boundaries: 'payments service and its gateway only',
            result: 'causes with the evidence for each',
          },
          deepAgent: {
            agentId: run.coordinatorId,
            parentId: run.rootId,
            name: 'deep-research',
            status: 'completed',
            model: TEST_MODEL_CHOSEN,
          },
          team: [
            { name: 'deep-research-plan', maxRuns: 1, final: false },
            { name: 'deep-research-gather', maxRuns: 5, final: false },
            { name: 'deep-research-answer', maxRuns: 2, final: true },
          ],
        });
        // The run's one start over a limit: the second plan.
        expect(view.limitRefusals).toEqual([{ subagent: 'deep-research-plan', at: expect.any(Date) }]);
        // Exactly the deep agent's four children in creation order, each named by its subagent; nothing of the root.
        expect(
          view.steps.map(({ parentId, name, origin, description, status }) => ({
            parentId,
            name,
            subagent: origin?.subagent,
            description,
            status,
          })),
        ).toEqual([
          {
            parentId: run.coordinatorId,
            name: 'deep-research-plan',
            subagent: 'deep-research-plan',
            description: 'План ресерча',
            status: 'completed',
          },
          {
            parentId: run.coordinatorId,
            name: 'deep-research-gather',
            subagent: 'deep-research-gather',
            description: 'Сбор · ошибки авторизации',
            status: 'completed',
          },
          {
            parentId: run.coordinatorId,
            name: 'deep-research-gather',
            subagent: 'deep-research-gather',
            description: 'Сбор · таймауты шлюза',
            status: 'failed',
          },
          {
            parentId: run.coordinatorId,
            name: 'deep-research-answer',
            subagent: 'deep-research-answer',
            description: 'Ответ ресерча',
            status: 'completed',
          },
        ]);

        // A foreign owner, an ordinary agent of the same owner (the conversation root: it runs the `chat` record)
        // and an unknown id: one and the same RUN_NOT_FOUND.
        const unknownId = randomUUID();
        const refusals = await Promise.all(
          [
            [run.coordinatorId, otherOwner],
            [run.rootId, ownerId],
            [unknownId, ownerId],
          ].map(([agentId, owner]) => harness.sessions.run(agentId, owner).then(() => undefined, (error: unknown) => error)),
        );
        for (const refusal of refusals) expect(refusal).toBeInstanceOf(AgentsError);
        expect(
          refusals.map((refusal) => {
            const { name, code, message } = refusal as AgentsError;
            return { name, code, message };
          }),
        ).toEqual([
          { name: 'AgentsError', code: 'RUN_NOT_FOUND', message: `Deep agent run ${run.coordinatorId} is not found` },
          { name: 'AgentsError', code: 'RUN_NOT_FOUND', message: `Deep agent run ${run.rootId} is not found` },
          { name: 'AgentsError', code: 'RUN_NOT_FOUND', message: `Deep agent run ${unknownId} is not found` },
        ]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3 B  The final subagent as the deep agent meets it: finishing without its completed report is refused until the run fails
  // ---------------------------------------------------------------------------------------------------------------
  // Catches: a deep agent whose `finalSubagent` does not reach its snapshot (it finishes with its own text and the run "completes" with no
  //   answer); an answer subagent that fails twice leaving the run `completed` or hanging instead of `failed` with `turn_limit`, or a root
  //   that is not told, or told without the status and reason.
  it(
    'INT-3 B: a deep agent that finishes in text while the answer subagent has failed twice gets a notice each time, the run ends failed by the turn limit and the root is told with status and reason',
    async () => {
      const model = createScriptedModel();
      const ownerId = newUser();
      const harness = await createDeepAgentsHarness(model);
      const limitsId = harness.library.add(limitsRecord());
      try {
        const coordinatorScript = model.script(
          { task: '{"question":"Does the run fail without its answer (INT-3 B)?","boundaries":"","result":""}' },
          [],
          { thereafter: limitsCoordinator },
        );
        // The answer agent's model fails on every attempt.
        model.script({ agent: LIMITS_ANSWER_AGENT }, [], { thereafter: modelError() });
        const root = await rootWithWaitingBrief(harness, model, ownerId, {
          deepAgent: limitsId,
          task: 'Check the final step (INT-3 B)',
          firstReply: 'Root reply one (INT-3 B).',
          followUp: 'Go on (INT-3 B)',
          secondReply: 'Root reply two (INT-3 B): here is the brief.',
          brief: { question: 'Does the run fail without its answer (INT-3 B)?', boundaries: '', result: '' },
        });
        expect(
          await harness.sessions.resolveConfirmation({ decisionId: root.decisionId, ownerId, approve: true }),
        ).toBe('resolved');
        const [coordinator] = await waitFor(
          () => deepAgentsUnder(harness, root.rootId, ownerId),
          (found) => found.length > 0,
          'the coordinator of limits-check',
        );

        // The run ends failed by the coordinator's turn limit after exactly six model calls.
        expect(await waitForStatus(harness, coordinator.agentId, ownerId, 'failed')).toMatchObject({
          status: 'failed',
          failureReason: 'turn_limit',
        });
        expect(coordinatorScript.calls).toHaveLength(6);

        // Both runs of the answer agent failed.
        expect(
          (await childrenOf(harness, root.rootId, coordinator.agentId, ownerId)).map(({ name, status, failureReason }) => ({
            name,
            status,
            failureReason,
          })),
        ).toEqual([
          { name: 'answer', status: 'failed', failureReason: 'provider_unavailable' },
          { name: 'answer', status: 'failed', failureReason: 'provider_unavailable' },
        ]);

        // Every text answer after the second failure is met by a notice, not by the end of the session.
        const history = await historyOf(harness, coordinator.agentId, ownerId);
        const secondFailure = history.filter((entry) => entry.kind === 'child_report')[1];
        expect(secondFailure).toMatchObject({ content: { status: 'failed', reason: 'provider_unavailable' } });
        const textsAfter = history.flatMap((entry, index) =>
          entry.kind === 'model_answer' && entry.seq > secondFailure.seq && entry.content.toolCalls.length === 0 ? [index] : [],
        );
        expect(textsAfter.length).toBeGreaterThanOrEqual(1);
        for (const index of textsAfter) {
          expect(history[index + 1]).toMatchObject({
            kind: 'notice',
            content: {
              text: 'You cannot finish: the last run of subagent "answer" ended as failed. The deep agent ends only with a completed report of subagent "answer"; start it with start_agent.',
            },
          });
        }

        // The root is told once: status "failed" with its reason.
        const rootReports = await waitFor(
          () => childReportsOf(harness, root.rootId, ownerId),
          (reports) => reports.length > 0,
          'the run report at the root',
        );
        expect(rootReports.map(({ agentId, status, reason }) => ({ agentId, status, reason }))).toEqual([
          { agentId: coordinator.agentId, status: 'failed', reason: 'turn_limit' },
        ]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
