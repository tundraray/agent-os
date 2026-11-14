// agent-platform / workflows Integration Test Skeletons - Design Doc: docs/features/agent-platform/design-workflows.md (Test Strategy UC-1, UC-E1..UC-E4; Flows 1-2; Invariants 1-4; DC-1..DC-4)
// PRD: docs/features/agent-platform/prd.md (FR-18, FR-19, FR-20, FR-26, FR-28 acceptance criteria; NFR-06 for reading a run). Upstream: docs/features/agent-platform/design-agents.md (Contract Definitions: SessionLimits, tools.register with confirmation and argument edits, the spawn helper, AgentView, HistoryEntry), design-runtime.md
// Generated: 2026-11-14 | Part: workflows | Test type: Integration (in-process `createRuntime` + `createAgents` + `createWorkflows` over real Postgres, real MCP fixture process, scripted model), CI job `e2e-workflows`
// Implementation timing: created alongside the slice each test names (INT-1 the brief and `start_workflow`; INT-2 the shipped `deep-research` template run to the report and `runs.get`; INT-3 the template limits as the coordinator meets them).
//
// File name follows the convention of the agents and runtime parts (`*.e2e-spec.ts` under packages/<pkg>/test, picked up by `vitest.config.e2e.ts`, run with `pnpm --filter @agent-os/workflows test:e2e`, never in the default `vitest run`).
// The package `packages/workflows` does not exist yet: the part's first task creates it with the same `vitest.config.e2e.ts` and `test/support/migrate.global-setup.ts` shape as `packages/agents`. The `.int.` infix separates in-process tests from a child-process file
// `agent-platform-workflows.e2e-spec.ts`; THAT FILE IS NOT GENERATED (see "E2E" below). Started as `it.todo` skeletons; the Given/When/Then comments are the rows' specification. Tests are written with their tasks and run once, at the end of the part
// (project rule "Tests only at the end").
//
// Light test process (CLAUDE.md "Tests"): this part owns no tables, no loop and no limit mechanics. Its own code is: the template file and its schema, the `start_workflow` tool (arguments, brief edit, the spawn with the template's limits), and `runs.get`.
// A skeleton exists only where a defect is invisible below this level - the brief reaching a real coordinator through the real confirmation of `agents`, the shipped template running through the real loop to a report, and the template's limits being the ones
// the coordinator actually meets. Already proven by the agents and runtime parts and NOT repeated here: the limit mechanics (`not_allowed` by list and count, `fork` refusal, the notice on a text without the final agent's report, the final agent's report as the session's
// report, `SessionLimits` rows - agents unit gate table and agents INT-1 row D), confirmations (request, approve, reject, `ALREADY_RESOLVED`, a decision surviving a restart - agents INT-3 rows B-D and runtime E2E-1), the inbox and message order (runtime INT-2, agents INT-1 row B),
// restart and lost steps (runtime E2E-1, agents INT-3 row E), stop of a tree (agents INT-2 row B), continue and restart of a finished agent (agents INT-1 row C), the owner check of the `agents` operations (agents INT-4).
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml (DATABASE_URL from apps/api/.env), migrations (runtime and agents; workflows has none) applied once by the global setup. Real `createRuntime`, real `createAgents`, real `createWorkflows` over a real pool,
//   `RUNTIME_WORKERS` on. No mock of Postgres, of the runtime, of `agents` or of `workflows`.
// - The model is the only double: the scripted `ModelClient` double of the agents harness (scenarios per agent keyed by description, gated answers, recorded inputs, model errors as a scripted answer kind). The coordinator's scenario answers from the state of ITS history
//   (the Design Doc's UC-1 Given), because a fixed list of answers cannot tell which report has arrived; the harness gets a "reply from history" scenario kind for that.
// - MCP is real: the `packages/mcp-fixture` stdio process (`logs` read-only) through `MCP_SERVERS_FILE`, `FIXTURE_CALL_LOG` as the evidence of what reached a server; a read call held on a latch, `MCP_ACCESS_TABLE` per test maps the owner to `logs`.
// - The tree root is an agent with a TEST definition that lists `start_workflow` and nothing else (the `chat` part's main chat does not exist yet; Design Doc "Test Strategy"). Its scenario calls `start_workflow`. Reusing the harness of the agents part
//   (`agentsHarness.ts`, `scriptedModel.ts`, `fixtureLog.ts`) is the plan's task, not a copy.
// - The templates under test: the SHIPPED `deep-research` (INT-1, INT-2 - the real file, so a template whose wiring is wrong fails here) and, in INT-3 only, a small TEST template built with the same `parseTemplate` and registered through the same `createWorkflows` path
//   (a coordinator with `maxTurns` 4 and one executor `answer` as `finalAgent`), so the final-step requirement and the list are shown with a coordinator that is cheap to drive.
// - Isolation (project convention, no truncate): a unique owner `newUser()` per test, a unique conversation per test, each test reads only its own tree. `fileParallelism: false`.
// - No sleeps for ordering: tests synchronise on latches and on rows; no latency assertions.
//
// Budget: Integration 3 of 3 (base 3). Core: INT-1, INT-2, INT-3. Nothing extra.
//
// E2E: 0 of 1-2 - the file `agent-platform-workflows.e2e-spec.ts` is deliberately not generated. The part has no process of its own and no commit boundary: a restart mid-run is a property of `agents` and `runtime` (runtime E2E-1, agents INT-3 row E), and the
//   journey the employee notices first (ask in chat, confirm the brief card, read the report) crosses `chat` and `web` and belongs to those parts' E2E. Prompt quality of the Haiku and Sonnet agents is a manual run (Design Doc Risks), not an automated test.
//
// Proven elsewhere (not in this file; the plan reads this to avoid a second test for an AC already proven):
// - unit, packages/workflows/src, one table-driven file per rule (literal rows, no database):
//     * `parseTemplate` and `createWorkflows` startup checks - the shipped `deep-research` parses (the row that also keeps its values: `finalAgent` is `deep-research-answer`, a `maxRuns` per executor, coordinator model); unknown field; name not in kebab-case;
//       duplicate executor name; `finalAgent` not among the executors; `maxRuns` 0 and above 20; `maxTurns` out of bounds; an executor holding `start_workflow`; two templates with one name; each failing row names the template and the field path - DC-1, UC-E3
//       (one row in this file is NOT needed: a bad template throws from `createWorkflows` before `start()`, and that wiring is one call over a fake `agents` in the same unit file)
//     * `start_workflow` argument schema and edit schema - `template` unknown name, `question` empty or over 4000, `boundaries` and `result` over 4000; the edit schema accepts changes to `question`, `boundaries`, `result` only and returns `template` as it was - DC-4 (the rule),
//       FR-28 (rule half); the wiring of an edit through the real confirmation is INT-1 row B
//     * the brief to task mapping - the coordinator's task is JSON with the three fields and the description is the question; the `WorkflowRunView` mapping from `AgentView`s and the first history entry (`brief`, `template`, `steps` in creation order, `RUN_NOT_FOUND`
//       for an agent whose definition is not a template coordinator) - the view mapping and the definition check, over fakes of the `agents` operations
// - agents (AC-18.3 stop reaches all the run's agents, AC-18.4 continue in the same session, AC-26.1 a message lands at the nearest tool-result boundary of the coordinator): agents INT-2 row B, INT-1 row C, INT-1 row B - the operations are called on the coordinator
//   and need no code of this part (Design Doc Test Strategy: "своих тестов на них нет").
// - not automated: that the answer names the direction without data and that the coordinator follows its prompt rules (AC-19.3, the content half: the Design Doc assigns it to the manual run, business constraint 6); the 500-word cap of a gather report (prompt text);
//   the price of the Sonnet coordinator in the models price file (a startup row of `parseAgentsConfig`/`start()`: an unpriced model is `UNKNOWN_MODEL` - agents unit); live events of the card (the `chat` part reads runtime events, the package writes none).
//
// AC -> proving test:
// - AC-18.1: INT-2 row A (one coordinator, every agent of the run its child, `runs.get` shows one run with its steps)
// - AC-18.2: INT-2 row A (second plan refused, the shipped limits reach the coordinator) and INT-3 row A (an executor outside the list and `fork` refused) over the agents unit gate table
// - AC-18.3, AC-18.4, AC-26.1: agents INT-2 row B, INT-1 row C, INT-1 row B (see above)
// - AC-18.5, DC-2: INT-3 row B (a text without the final agent's report is refused, the run fails by `turn_limit`, the root is told); the positive half (the final agent's report is the run's report) is INT-2 row A
// - AC-19.1: INT-2 row A; AC-19.2: INT-2 row A (gather agents work at once; the count is the template's `maxRuns`, a value kept by the unit `deep-research` row); AC-19.3 (platform share): INT-2 row A
// - AC-20.1: INT-1 row A (the workflow starts from a confirmed brief; the "no other way" half is the absence of any other starter, a `chat` part definition rule); AC-20.2: INT-2 row A (the report text is the answer agent's text)
// - AC-28.1, AC-28.2: INT-1 row A; AC-28.3: INT-1 row C; DC-4: INT-1 row B (wiring) over the unit edit schema
// - DC-1, UC-E3: unit parse table; DC-3: INT-2 row A
// - NFR-06 (reading a run): INT-2 row B

import { randomUUID } from 'node:crypto';
import { type AgentHistoryEntry, type AgentTurnMessage, type AgentView, GENERAL_PURPOSE, WAITING_RULE } from '@agent-os/agents';
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
import { createFixtureFiles, fixtureCallsOf, holdCall } from '@agent-os/mcp-fixture';
import { WorkflowsError } from '@agent-os/workflows';
import { describe, expect, it } from 'vitest';
import { newUser } from './support/new-user.js';
import {
  childReportsOf,
  createWorkflowsHarness,
  historyOf,
  LIMITS_ANSWER_AGENT,
  LIMITS_TEMPLATE,
  LIMITS_TEMPLATE_NAME,
  SONNET_MODEL,
  shippedTemplatesWith,
  waitFor,
  type WorkflowsHarness,
} from './support/workflowsHarness.js';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** The shipped template the root starts, its title and its coordinator's definition. */
const DEEP_RESEARCH = 'deep-research';
const DEEP_RESEARCH_TITLE = 'Глубокий ресерч';

/** One INT-1 conversation: the root's task, its two replies around the employee's follow-up, and the brief it proposes. */
interface BriefConversation {
  readonly task: string;
  readonly firstReply: string;
  readonly followUp: string;
  readonly secondReply: string;
  readonly brief: { readonly question: string; readonly boundaries: string; readonly result: string };
  /** The template the root asks for; `deep-research` when omitted. */
  readonly template?: string;
}

/** A root whose `start_workflow` call waits for the employee's decision. */
interface WaitingBrief {
  readonly rootId: string;
  readonly rootScript: Script;
  readonly decisionId: string;
}

/**
 * Starts a root with a two-message history before the call: the root replies to its task, the employee
 * follows up, and the root's second reply calls `start_workflow` with the conversation's brief. Returns
 * once the brief waits for the decision. Every root call after the second answers with a short text.
 */
async function rootWithWaitingBrief(
  harness: WorkflowsHarness,
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
          { tool: 'start_workflow', args: { template: conversation.template ?? DEEP_RESEARCH, ...conversation.brief } },
        ],
      },
    ],
    { thereafter: { text: 'Noted.' } },
  );
  const { agentId: rootId } = await harness.sessions.start({
    ownerId,
    definition: harness.rootDefinition,
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

/** Definitions of the root's tree, in creation order. */
async function definitionsUnder(harness: WorkflowsHarness, rootId: string, ownerId: string): Promise<string[]> {
  return (await harness.sessions.list(rootId, ownerId)).map((view) => view.definition);
}

/** The coordinators (`deep-research` agents) of the root's tree. */
async function coordinatorsUnder(harness: WorkflowsHarness, rootId: string, ownerId: string) {
  return (await harness.sessions.list(rootId, ownerId)).filter((view) => view.definition === DEEP_RESEARCH);
}

/** The root's `start_workflow` result entries, as `history` stores them. */
function startWorkflowResults(entries: readonly AgentHistoryEntry[]) {
  return entries.flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === 'start_workflow' ? [entry.content] : [],
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
async function childrenOf(harness: WorkflowsHarness, rootId: string, parentId: string, ownerId: string): Promise<AgentView[]> {
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

// ----- INT-2: the shipped deep-research run (one per test: each test has its own harness and model) -----

/** The fixture's read tool (`logs` server) the first gather agent calls, and its arguments. */
const GET_TRACE = 'mcp__logs__get_trace';
const TRACE = { traceId: 'c'.repeat(32) };

const RUN_BRIEF = {
  question: 'Why did card payments fail yesterday between 10:00 and 12:00 UTC?',
  boundaries: 'payments service and its gateway only',
  result: 'causes with the evidence for each',
} as const;
/** The coordinator's task: the confirmed brief as `start_workflow` writes it. */
const RUN_TASK =
  '{"question":"Why did card payments fail yesterday between 10:00 and 12:00 UTC?","boundaries":"payments service and its gateway only","result":"causes with the evidence for each"}';

const PLAN_AGENT = 'deep-research-plan';
const GATHER_AGENT = 'deep-research-gather';
const ANSWER_AGENT = 'deep-research-answer';

const PLAN_DESCRIPTION = 'План ресерча';
const GATHER_A_DESCRIPTION = 'Сбор · ошибки авторизации';
const GATHER_B_DESCRIPTION = 'Сбор · таймауты шлюза';
const ANSWER_DESCRIPTION = 'Ответ ресерча';

const PLAN_TASK = `Plan the research of this brief: ${RUN_TASK}`;
const GATHER_A_TASK = `Gather data on the direction "authorization errors" of this brief: ${RUN_TASK}`;
const GATHER_B_TASK = `Gather data on the direction "gateway timeouts" of this brief: ${RUN_TASK}`;
const ANSWER_TASK =
  `Write the answer of this brief: ${RUN_TASK}. Direction "authorization errors": issuer declines rose at 10:40. ` +
  'Direction "gateway timeouts": no data, the gather agent failed (model_error).';

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
 * The coordinator of INT-2 answers from its own input (design UC-1 Given): results of its own
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
  readonly rootId: string;
  readonly coordinatorId: string;
  readonly coordinatorScript: Script;
}

/**
 * Scripts the run's agents (the second gather agent's model always errors, the first makes one `logs`
 * read), starts the root, confirms its brief unchanged and returns once the coordinator exists.
 */
async function startDeepResearch(harness: WorkflowsHarness, model: ScriptedModel, ownerId: string): Promise<DeepResearchRun> {
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
  });
  expect(
    await harness.sessions.resolveConfirmation({ decisionId: root.decisionId, ownerId, approve: true }),
  ).toBe('resolved');
  const [coordinator] = await waitFor(
    () => coordinatorsUnder(harness, root.rootId, ownerId),
    (found) => found.length > 0,
    'the coordinator of the run',
  );
  return { rootId: root.rootId, coordinatorId: coordinator.agentId, coordinatorScript };
}

/** Waits until the agent has ended with `status`. */
function waitForStatus(harness: WorkflowsHarness, agentId: string, ownerId: string, status: string): Promise<AgentView> {
  return waitFor(
    () => harness.sessions.get(agentId, ownerId),
    (view) => view.status === status,
    `agent ${agentId} to be ${status}`,
    60_000,
  );
}

// ----- INT-3: the test template's coordinator -----

const ANSWER_RUN_TASK = 'Write the answer of the limits check.';

/**
 * The coordinator of INT-3 B answers from its own input, by its starts of `answer` (s) and the failures of
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

describe('agent-platform / workflows - integration (in-process runtime + agents + workflows, real Postgres, real MCP fixture, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  The brief: nothing starts before the decision, a confirmed (or corrected) brief is the coordinator's only input, a declined or invalid one starts nothing
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-28.1: "Given чат подготовил бриф, when сотрудник ещё не решил, then workflow не запущен, а бриф ждёт решения в беседе."
  // AC-28.2: "Given бриф ждёт, when сотрудник подтверждает его, в том числе исправив текст, then запускается один workflow, и его агенты получают подтверждённый бриф, но не историю беседы."
  // AC-28.3: "Given бриф ждёт, when сотрудник отказывается, then workflow не запускается, а чат получает результат «отклонено пользователем» (как AC-12.4)."
  // AC-20.1: "Given беседа, when сотрудник просит глубокий ресерч, then чат готовит бриф и после подтверждения запускает workflow, а другого способа запустить расследование в продукте нет." (the workflow half: a confirmed brief starts the coordinator)
  // DC-4 (Design Doc, FR-28): "Подтверждение с правками, где вопрос пуст, получает `INVALID_ARGUMENTS`, а бриф продолжает ждать решения."
  // Invariants 1 and 2: "Координатор запуска создаётся только решением «подтверждено» по брифу и ровно один раз на запрос." / "При запуске задание координатора — подтверждённый бриф; историю беседы он не получает."
  // Use cases: UC-1 (first half), UC-E1. EARS: When / If-then. Design flow: Flow 1, KD-3.
  //
  // Catches: (1) a coordinator that exists before the employee decided, or one started from the model's original arguments after the employee edited the question (the edit lost between the confirmation and the spawn - the employee asks for one thing and the
  //   agents research another); (2) the conversation leaking into the coordinator's input - a first history entry that is not exactly the brief JSON, or any root entry in it (AC-05.2 for the workflow); (3) two coordinators from one request (a spawn that is not
  //   in the same transaction as the call's result, or a repeated decision that starts a second one); (4) a declined brief that still starts a coordinator, or an invalid edit (empty question) that is accepted, or that closes the request so the employee can no longer decide;
  //   (5) a `start_workflow` call whose result lacks the run id and the confirmed brief, so the chat cannot tell the employee what started.
  // Not re-checked here: the confirmation lifecycle, `ALREADY_RESOLVED` and its survival across a restart (agents INT-3, runtime E2E-1), the argument schema rows and the edit schema rules (unit), the card shown to the employee (`chat` and `web` parts), when the chat prepares a brief (FR-15, `chat` part).
  // Behavior: root model calls `start_workflow` with a brief -> the request waits and no coordinator exists -> the employee confirms (edited), or edits it empty, or declines -> exactly one coordinator whose input is the brief, a refusal with the request still open, or no coordinator and a closed call
  // @category: core-functionality
  // @dependency: createRuntime, createAgents (tool gate, confirmation with argument edits, `resolveConfirmation`, spawn helper), createWorkflows (`start_workflow`, shipped `deep-research` template), scripted model double, Postgres
  // @complexity: medium
  //
  // Verification items (table-driven by decision; the root has a two-message history before the call; literal question strings):
  // - Row A "confirm with a corrected question" (UC-1 first half, AC-28.1, AC-28.2, AC-20.1, Invariants 1-2): the root's script calls `start_workflow` for `deep-research` with question Q1. Then, before the decision: `agents.confirmations(root)` holds one request of kind
  //   `workflows.brief` carrying the template title and the three fields, and `agents.list(root)` has NO coordinator. The employee resolves with approve and the question changed to Q2. Then: exactly ONE coordinator under the root with definition `deep-research`;
  //   its history begins with a task entry that is JSON with `question` = Q2 (not Q1), `boundaries` and `result` as edited; no entry of the root's two replies is in its history; the call result the root's next model input holds contains the run id and the confirmed (edited) brief;
  //   resolving the same request again answers `already_resolved` and the number of coordinators stays one.
  // - Row B "correction with an empty question" (DC-4): the request waits; `resolveConfirmation` approves with `question` empty. Then: `INVALID_ARGUMENTS`; the request is still in `confirmations`; there is no coordinator; a following valid approval starts exactly one.
  // - Row C "decline" (AC-28.3): the request waits; the employee rejects. Then: no coordinator under the root ever (read after the next root step has run); the call's outcome is `rejected` ("отклонено пользователем") and the root's next model input holds that result.
  it(
    'INT-1: a brief waits without starting anything, a confirmed or corrected one starts exactly one coordinator whose only input is that brief, an empty correction is refused and keeps the request open, and a decline starts nothing',
    async () => {
      const model = createScriptedModel();
      const ownerA = newUser();
      const ownerB = newUser();
      const ownerC = newUser();
      // The coordinators' first model calls are held: what the test reads is their input, not their run.
      const coordinatorHeld = createLatch();
      const harness = await createWorkflowsHarness({ model, owners: [ownerA, ownerB, ownerC] });
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
        });

        // Before the decision: one open request of kind `workflows.brief` with the title and the three fields, no coordinator.
        expect(
          (await harness.sessions.confirmations(a.rootId, ownerA)).filter((c) => c.status === 'open').map(({ kind, tool, server, args }) => ({
            kind,
            tool,
            server,
            args,
          })),
        ).toEqual([
          {
            kind: 'workflows.brief',
            tool: 'start_workflow',
            server: null,
            args: {
              template: 'deep-research',
              question: 'Why did payments fail yesterday (A)?',
              boundaries: 'payments service only',
              result: 'a short list of causes',
            },
          },
        ]);
        expect(
          (await harness.runtime.decisions.listTree(a.rootId, ownerA)).filter((d) => d.status === 'open').map((decision) => decision.payload),
        ).toMatchObject([
          {
            content: {
              title: DEEP_RESEARCH_TITLE,
              question: 'Why did payments fail yesterday (A)?',
              boundaries: 'payments service only',
              result: 'a short list of causes',
            },
          },
        ]);
        expect(await definitionsUnder(harness, a.rootId, ownerA)).toEqual([harness.rootDefinition]);

        // The employee confirms with the question, boundaries and result edited.
        expect(
          await harness.sessions.resolveConfirmation({
            decisionId: a.decisionId,
            ownerId: ownerA,
            approve: true,
            args: {
              template: 'deep-research',
              question: 'Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?',
              boundaries: 'payments service only, no refunds',
              result: 'causes with the evidence for each',
            },
          }),
        ).toBe('resolved');
        const [coordinator] = await waitFor(
          () => coordinatorsUnder(harness, a.rootId, ownerA),
          (found) => found.length > 0,
          'the coordinator of row A',
        );
        expect(coordinator).toMatchObject({
          parentId: a.rootId,
          definition: 'deep-research',
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
        expect(startWorkflowResults(await historyOf(harness, a.rootId, ownerA))).toMatchObject([
          {
            outcome: 'success',
            text: `Workflow "deep-research" started in the background, run id ${coordinator.agentId}. Confirmed brief: {"question":"Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?","boundaries":"payments service only, no refunds","result":"causes with the evidence for each"}\nIts answer will arrive as a message when it finishes. ${WAITING_RULE}`,
          },
        ]);
        await a.rootScript.called(3);
        const [rootSeesA] = lastToolOutput(a.rootScript, 3);
        expect(rootSeesA.toolName).toBe('start_workflow');
        expect(String(rootSeesA.output)).toContain(`run id ${coordinator.agentId}`);
        expect(String(rootSeesA.output)).toContain(
          'Why did card payments fail yesterday between 10:00 and 12:00 UTC (A)?',
        );

        // A repeated decision starts nothing more.
        expect(
          await harness.sessions.resolveConfirmation({ decisionId: a.decisionId, ownerId: ownerA, approve: true }),
        ).toBe('already_resolved');
        expect(await coordinatorsUnder(harness, a.rootId, ownerA)).toHaveLength(1);

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
        });
        await expect(
          harness.sessions.resolveConfirmation({
            decisionId: b.decisionId,
            ownerId: ownerB,
            approve: true,
            args: { template: 'deep-research', question: '', boundaries: '', result: '' },
          }),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
        expect(
          (await harness.sessions.confirmations(b.rootId, ownerB)).filter((c) => c.status === 'open').map((open) => open.decisionId),
        ).toEqual([b.decisionId]);
        expect(await definitionsUnder(harness, b.rootId, ownerB)).toEqual([harness.rootDefinition]);

        expect(
          await harness.sessions.resolveConfirmation({ decisionId: b.decisionId, ownerId: ownerB, approve: true }),
        ).toBe('resolved');
        const coordinatorsB = await waitFor(
          () => coordinatorsUnder(harness, b.rootId, ownerB),
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
        expect(await coordinatorsUnder(harness, b.rootId, ownerB)).toHaveLength(1);

        // Row C "decline" (AC-28.3): no coordinator ever, the call closes as rejected and the root's next input holds it.
        const c = await rootWithWaitingBrief(harness, model, ownerC, {
          task: 'How many payments timed out today? (C)',
          firstReply: 'Root reply one (C): all payment methods?',
          followUp: 'Yes, all of them (C)',
          secondReply: 'Root reply two (C): here is the brief to confirm.',
          brief: { question: 'How many payments timed out today (C)?', boundaries: 'today only', result: 'one number' },
        });
        expect(
          await harness.sessions.resolveConfirmation({ decisionId: c.decisionId, ownerId: ownerC, approve: false }),
        ).toBe('resolved');
        await c.rootScript.called(3);
        expect(lastToolOutput(c.rootScript, 3)).toEqual([
          {
            toolName: 'start_workflow',
            output: '<data source="tool start_workflow" author="agents">\n[rejected]\n</data>',
          },
        ]);
        expect(startWorkflowResults(await historyOf(harness, c.rootId, ownerC))).toMatchObject([
          { outcome: 'rejected', refusalReason: null },
        ]);
        expect((await harness.sessions.confirmations(c.rootId, ownerC)).filter((request) => request.status === 'open')).toEqual([]);
        expect(await definitionsUnder(harness, c.rootId, ownerC)).toEqual([harness.rootDefinition]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  A deep-research run with a faked model reaches the report in the parent conversation, survives a failed gather agent, and reads back as one run
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-18.1: "Given workflow запущен из беседы, when сотрудник открывает список агентов, then видит запуск как одну запись, а его агентов — под ним."
  // AC-18.2: "Given шаблон объявляет, каких агентов и сколько раз координатор может вызвать, when координатор просит агента вне списка или сверх числа, then вызов не происходит, а координатор получает отказ с причиной." (the shipped template's list and count as the coordinator meets them)
  // AC-18.5: "Given шаблон объявляет обязательный последний шаг, when workflow заканчивается, then родитель получает как отчёт (FR-06) итог агента этого шага, а попытка координатора закончить без него получает отказ." (the report half)
  // AC-19.1: "Given подключён источник данных, when сотрудник подтвердил бриф глубокого ресерча, then в беседу приходит ответ агента ответа, а у запуска видны агенты плана, сбора и ответа."
  // AC-19.2: "Given координатор запустил несколько агентов сбора, when они работают, then они работают одновременно, и их не больше, чем разрешает шаблон."
  // AC-19.3 (platform share, Design Doc FR-19): "Сбой агента сбора приходит координатору отчётом со статусом «сбой» и причиной, координатор продолжает работу, и отчётом запуска становится отчёт агента ответа."
  // AC-20.2: "Given ответ глубокого ресерча, when сотрудник его читает, then в ответе нет статусов утверждений и групп уверенности." (the report in the conversation is the answer agent's text, nothing of the old contour is added)
  // NFR-06: "Изоляция данных пользователей — как в бизнес-ограничении 2 в `.claude/skills/project-context/SKILL.md`: каждая точка доступа к агентам, сессиям и workflow покрыта e2e-тестом с двумя пользователями." (`runs.get`)
  // Invariant 4: "Отчёт законченного запуска — последний отчёт агента `finalAgent`."
  // Use cases: UC-1 (the run), UC-E4. EARS: When. Design flow: Flow 2, `runs.get` in Contract Definitions, KD-2, KD-4.
  //
  // Catches: (1) a shipped template whose executors, tools or MCP wiring do not make the plan -> gather -> answer chain run at all against the real loop (a definition registered under the wrong name, `agents` not matching the executors, a model or tool reference
  //   `start()` accepted but the run cannot use); (2) the template's limits not passed to the coordinator at spawn - a second plan agent that is allowed - which the agents unit and INT-1 D tests cannot see because they build their own limits; (3) the gather agents
  //   running one after another, not at once (the coordinator's several `start_agent` calls in one answer handled sequentially); (4) one failed gather agent that kills the run, hides from the coordinator, or leaves the run without its answer - the failure not arriving
  //   as a report with status and reason; (5) the root getting the coordinator's own closing text, or a report enriched with anything but the answer agent's text, instead of the answer agent's report as the run's report; (6) `runs.get` that shows a different number of
  //   steps than the coordinator's children, or loses the brief, or answers for another employee's run or for an ordinary agent (leaking the existence of a run, or of any agent).
  // Not re-checked here: how the gate refuses (agents unit and INT-1 D), reports to a free or a busy parent (agents INT-1 A), the order and single delivery of the report notification (runtime INT-2), the content of the prompts, that the answer names the direction without data (manual run), restart mid-run (agents, runtime).
  // Behavior: confirmed brief -> coordinator starts a plan, then gather agents in one answer, one of them fails, then the answer agent -> the root's conversation receives the answer agent's text as the run's report -> `runs.get` returns the brief, the template and the four steps
  // @category: core-functionality
  // @dependency: createRuntime, createAgents (loop, SessionLimits, reports, list and history operations), createWorkflows (shipped `deep-research`, `start_workflow`, `runs.get`), scripted model double with a coordinator scenario that answers from its history, MCP fixture (`logs`, one read call held on a latch), Postgres
  // @complexity: high
  //
  // Verification items (the Design Doc's UC-1 Given: the coordinator answers from the state of its own history - first turn: two `start_agent` calls for the plan agent in one answer; after the plan report: two gather agents in one answer; on the first gather report, while the second has not
  //   come, text; when both have come, the answer agent; after the answer agent's report, text. The first gather agent's read call is held on the fixture's latch until the second gather agent has ended; the second gather agent's model answers with an error):
  // - Row A "run to the report" (UC-1, AC-18.1, AC-18.2, AC-19.1..19.3, AC-20.2, Invariant 4): start through the confirmed brief of INT-1 (the shared setup, not a second check of it). Then: the second plan `start_agent` has outcome `refused` with reason `not_allowed` and no second plan agent exists
  //   (the shipped limit of one reached the coordinator); the second gather agent ended `failed` while the first was still `working` (the gather agents ran at once); the coordinator's next input after the failure holds that agent's report with status "сбой" and its reason, and the
  //   coordinator went on to start the answer agent after both had ended; `agents.list(root)` shows ONE top-level run - the coordinator - with plan, gather (completed), gather (failed) and answer as its children (AC-18.1); the root received ONE notification with status "завершён"
  //   whose text equals, literally, the answer agent's scripted text and carries no status-of-claim or confidence-group wording (it is not built from anything but that text); the coordinator is `completed`.
  // - Row B "reading the run" (`runs.get`, UC-E4, NFR-06): after row A's run (a fresh run per test: a new owner, the scenario above), `runs.get(coordinatorId, owner)` returns `template` {name `deep-research`, title}, `brief` equal to the confirmed brief, `coordinator` (completed, its model),
  //   and `steps` of exactly four `AgentView`s in creation order - plan, gather "completed", gather "failed", answer - each with the description the coordinator gave; no `agents` entry for the root. Then the other table rows, all expecting `RUN_NOT_FOUND` with nothing of the run
  //   in the error: `runs.get(coordinatorId, otherOwner)`; `runs.get(ordinaryAgentId, owner)` for a `general-purpose` agent of the same owner; `runs.get(id that exists for nobody, owner)` - and the three answers are equal in code and shape.
  it(
    "INT-2 A: the shipped deep-research template runs plan, two gather agents at once and the answer, refuses the second plan, goes on after a failed gather agent, and hands the root the answer agent's text as the run's report under one coordinator",
    async () => {
      const model = createScriptedModel();
      const ownerId = newUser();
      // The first gather agent's read is held on the fixture until the second gather agent has failed.
      const fixture = createFixtureFiles('workflows-e2e');
      const gatherRead = fixture.latch('gather-read');
      fixture.setFaults([holdCall('get_trace', TRACE, gatherRead)]);
      const harness = await createWorkflowsHarness({ model, owners: [ownerId], fixture });
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
            .filter((child) => child.definition === GATHER_AGENT)
            .map(({ description, status, failureReason }) => ({ description, status, failureReason }))
            .sort((left, right) => left.description.localeCompare(right.description)),
        ).toEqual([
          { description: 'Сбор · ошибки авторизации', status: 'working', failureReason: null },
          { description: 'Сбор · таймауты шлюза', status: 'failed', failureReason: 'model_error' },
        ]);
        gatherRead.release();

        expect(await waitForStatus(harness, run.coordinatorId, ownerId, 'completed')).toMatchObject({
          definition: 'deep-research',
          status: 'completed',
        });

        // The shipped limit of one plan reached the coordinator: the second plan is refused, no task for it.
        const coordinatorHistory = await historyOf(harness, run.coordinatorId, ownerId);
        expect(startAgentResults(coordinatorHistory)).toEqual([
          ['deep-research-plan', 'success', null],
          ['deep-research-plan', 'refused', 'not_allowed'],
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
        expect(steps.map(({ definition, description, status }) => ({ definition, description, status }))).toEqual(
          expect.arrayContaining([
            { definition: 'deep-research-plan', description: 'План ресерча', status: 'completed' },
            { definition: 'deep-research-gather', description: 'Сбор · ошибки авторизации', status: 'completed' },
            { definition: 'deep-research-gather', description: 'Сбор · таймауты шлюза', status: 'failed' },
            { definition: 'deep-research-answer', description: 'Ответ ресерча', status: 'completed' },
          ]),
        );

        // The failure came to the coordinator as a report with status and reason, and its next input held it.
        expect(
          childReportsOfHistory(coordinatorHistory).map(({ description, status, reason }) => ({ description, status, reason })),
        ).toEqual(
          expect.arrayContaining([{ description: 'Сбор · таймауты шлюза', status: 'failed', reason: 'model_error' }]),
        );
        const inputAfterFailure = run.coordinatorScript.calls.find((call) => reported(call.messages, GATHER_B_DESCRIPTION));
        expect(childReportsIn(inputAfterFailure?.messages ?? []).find((report) => report.includes(GATHER_B_DESCRIPTION))).toContain(
          'Agent &quot;Сбор · таймауты шлюза&quot; ended: failed (model_error).',
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
    'INT-2 B: runs.get returns the brief, the template and the four steps of a run in order, and answers a foreign owner, an ordinary agent and an unknown id the same: RUN_NOT_FOUND',
    async () => {
      const model = createScriptedModel();
      const ownerId = newUser();
      const otherOwner = newUser();
      const harness = await createWorkflowsHarness({ model, owners: [ownerId, otherOwner] });
      try {
        const run = await startDeepResearch(harness, model, ownerId);
        await waitForStatus(harness, run.coordinatorId, ownerId, 'completed');

        const view = await harness.workflows.runs.get(run.coordinatorId, ownerId);
        expect(view).toMatchObject({
          agentId: run.coordinatorId,
          template: { name: 'deep-research', title: 'Глубокий ресерч' },
          brief: {
            question: 'Why did card payments fail yesterday between 10:00 and 12:00 UTC?',
            boundaries: 'payments service and its gateway only',
            result: 'causes with the evidence for each',
          },
          coordinator: {
            agentId: run.coordinatorId,
            parentId: run.rootId,
            definition: 'deep-research',
            status: 'completed',
            model: SONNET_MODEL,
          },
        });
        // Exactly the coordinator's four children in creation order; nothing of the root.
        expect(
          view.steps.map(({ parentId, definition, description, status }) => ({ parentId, definition, description, status })),
        ).toEqual([
          { parentId: run.coordinatorId, definition: 'deep-research-plan', description: 'План ресерча', status: 'completed' },
          {
            parentId: run.coordinatorId,
            definition: 'deep-research-gather',
            description: 'Сбор · ошибки авторизации',
            status: 'completed',
          },
          { parentId: run.coordinatorId, definition: 'deep-research-gather', description: 'Сбор · таймауты шлюза', status: 'failed' },
          { parentId: run.coordinatorId, definition: 'deep-research-answer', description: 'Ответ ресерча', status: 'completed' },
        ]);

        // A foreign owner, an ordinary agent of the same owner and an unknown id: one and the same RUN_NOT_FOUND.
        model.script({ task: 'An ordinary task (INT-2 B)' }, [{ text: 'Ordinary answer.' }]);
        const { agentId: ordinaryId } = await harness.sessions.start({
          ownerId,
          definition: GENERAL_PURPOSE.name,
          prompt: 'An ordinary task (INT-2 B)',
          description: 'Ordinary agent',
        });
        const unknownId = randomUUID();
        const refusals = await Promise.all(
          [
            [run.coordinatorId, otherOwner],
            [ordinaryId, ownerId],
            [unknownId, ownerId],
          ].map(([agentId, owner]) => harness.workflows.runs.get(agentId, owner).then(() => undefined, (error: unknown) => error)),
        );
        for (const refusal of refusals) expect(refusal).toBeInstanceOf(WorkflowsError);
        expect(
          refusals.map((refusal) => {
            const { name, code, message } = refusal as WorkflowsError;
            return { name, code, message };
          }),
        ).toEqual([
          { name: 'WorkflowsError', code: 'RUN_NOT_FOUND', message: `Workflow run ${run.coordinatorId} is not found` },
          { name: 'WorkflowsError', code: 'RUN_NOT_FOUND', message: `Workflow run ${ordinaryId} is not found` },
          { name: 'WorkflowsError', code: 'RUN_NOT_FOUND', message: `Workflow run ${unknownId} is not found` },
        ]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  The template's limits as the coordinator meets them: an executor outside the list is refused, finishing without the final step is refused until the run fails
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-18.2: "Given шаблон объявляет, каких агентов и сколько раз координатор может вызвать, when координатор просит агента вне списка или сверх числа, then вызов не происходит, а координатор получает отказ с причиной." (outside the list; the over-count half is INT-2 row A)
  // AC-18.5: "Given шаблон объявляет обязательный последний шаг, when workflow заканчивается, then родитель получает как отчёт (FR-06) итог агента этого шага, а попытка координатора закончить без него получает отказ."
  // DC-2 (Design Doc, FR-18): "Если агент последнего шага закончил со сбоем, координатор может запустить его ещё раз в пределах числа запусков; если отчёта агента последнего шага так и нет, запуск заканчивается сбоем по пределу ходов координатора, а беседа получает уведомление со статусом «сбой» и причиной."
  // KD-2: "Отказ при вызове вне списка или сверх числа, отказ закончить без агента последнего шага и его отчёт со статусом «завершён» как отчёт запуска — поведение `agents`; сбой или остановка агента последнего шага сессию не заканчивают."
  // Use cases: UC-E2. EARS: If-then. Design flow: Flow 2 (failure handling), KD-2.
  //
  // Catches: (1) a template whose `finalAgent` or list is not turned into the coordinator's `SessionLimits` in the form `agents` reads (a limit field renamed or dropped between the two parts, so that the coordinator may start any agent or finish with its own text and the run
  //   "completes" with no answer); (2) an answer agent that fails twice leaving the run `completed` or hanging forever instead of `failed` with `turn_limit`, or a root that is not told, or told without the status and reason; (3) a coordinator that is allowed to start an agent
  //   of a different template, an ordinary `general-purpose` agent or a `fork` (the escape from the list).
  // Not re-checked here: the gate's variants and counts (agents unit), that the final agent's report becomes the session's report (INT-2 row A), the notice wording and the turn counter (agents unit), the shipped template's values (unit `deep-research` row).
  // Behavior: coordinator asks for something the template does not allow, or finishes with text while the final agent has no report -> a refusal or a `notice` in its history, no task created, and, after the last turn, the run fails with `turn_limit` and the root is told "сбой"
  // @category: core-functionality
  // @dependency: createRuntime, createAgents (SessionLimits, loop, reports), createWorkflows (TEST template with `finalAgent` `answer`, `maxTurns` 4, built through the same `parseTemplate` and registration path), scripted model double (the answer agent's model always errors), Postgres
  // @complexity: medium
  //
  // Verification items (table-driven by scenario; the TEST template has one executor `answer`, `maxRuns` 2; the root starts it through a confirmed brief as in INT-1):
  // - Row A "outside the list" (AC-18.2): the coordinator's script asks, in one answer, for an ordinary `general-purpose` agent, for `answer` with `fork`, and for another template's coordinator `deep-research`. Then: each call has outcome `refused` with reason `not_allowed` in the coordinator's history; the number of
  //   agents under the coordinator is unchanged (no task created); the coordinator continues (its next model call happens).
  // - Row B "no final report" (UC-E2, AC-18.5, DC-2): the coordinator's script: turn 1 starts `answer`; turn 2, after the failure of `answer`, starts it again; turns 3 and 4, after the second failure, answer text. The answer agent's model always errors. Then: both answer agents are `failed`; the coordinator's history holds
  //   a `notice` entry (a refusal to finish) after each of the text answers of turns 3 and 4; the coordinator ends `failed` with `failureReason` `turn_limit` and the model double has no fifth coordinator call; the root received ONE notification with status "сбой" and a non-empty reason.
  it(
    "INT-3 A: a coordinator asking for an ordinary agent, a fork or another template's agent is refused with not_allowed, nothing is started, and it carries on",
    async () => {
      const model = createScriptedModel();
      const ownerId = newUser();
      const harness = await createWorkflowsHarness({
        model,
        owners: [ownerId],
        templates: shippedTemplatesWith(LIMITS_TEMPLATE),
      });
      try {
        // The coordinator asks, in one answer, for an ordinary agent, a fork and another template's coordinator.
        const coordinatorScript = model.script(
          { task: '{"question":"Is the limits check outside the list (INT-3 A)?","boundaries":"","result":""}' },
          [
            {
              calls: [
                startAgent(GENERAL_PURPOSE.name, 'Ordinary agent', 'Do the research yourself (INT-3 A).'),
                startAgent('fork', 'A copy of me', 'Continue as a copy (INT-3 A).'),
                startAgent('deep-research', 'Another workflow', 'Run a deep research (INT-3 A).'),
              ],
            },
          ],
          { thereafter: { text: 'Carrying on without them.' } },
        );
        const root = await rootWithWaitingBrief(harness, model, ownerId, {
          template: LIMITS_TEMPLATE_NAME,
          task: 'Check the limits (INT-3 A)',
          firstReply: 'Root reply one (INT-3 A).',
          followUp: 'Go on (INT-3 A)',
          secondReply: 'Root reply two (INT-3 A): here is the brief.',
          brief: { question: 'Is the limits check outside the list (INT-3 A)?', boundaries: '', result: '' },
        });
        expect(
          await harness.sessions.resolveConfirmation({ decisionId: root.decisionId, ownerId, approve: true }),
        ).toBe('resolved');
        const [coordinator] = await waitFor(
          async () => (await harness.sessions.list(root.rootId, ownerId)).filter((view) => view.definition === LIMITS_TEMPLATE_NAME),
          (found) => found.length > 0,
          'the coordinator of the test template',
        );

        // The coordinator carries on: its next model call sees the three refusals.
        await coordinatorScript.called(2);
        expect(lastToolOutput(coordinatorScript, 2)).toEqual([
          { toolName: 'start_agent', output: '<data source="tool start_agent" author="agents">\n[refused: not_allowed]\n</data>' },
          { toolName: 'start_agent', output: '<data source="tool start_agent" author="agents">\n[refused: not_allowed]\n</data>' },
          { toolName: 'start_agent', output: '<data source="tool start_agent" author="agents">\n[refused: not_allowed]\n</data>' },
        ]);
        expect(startAgentResults(await historyOf(harness, coordinator.agentId, ownerId))).toEqual([
          ['general-purpose', 'refused', 'not_allowed'],
          ['fork', 'refused', 'not_allowed'],
          ['deep-research', 'refused', 'not_allowed'],
        ]);
        // Nothing was started: the tree is the root and the coordinator only.
        expect(await childrenOf(harness, root.rootId, coordinator.agentId, ownerId)).toEqual([]);
        expect(await definitionsUnder(harness, root.rootId, ownerId)).toEqual([harness.rootDefinition, 'limits-check']);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-3 B: a coordinator that finishes in text while the answer agent has failed twice gets a notice each time, the run ends failed by the turn limit and the root is told with status and reason',
    async () => {
      const model = createScriptedModel();
      const ownerId = newUser();
      const harness = await createWorkflowsHarness({
        model,
        owners: [ownerId],
        templates: shippedTemplatesWith(LIMITS_TEMPLATE),
      });
      try {
        const coordinatorScript = model.script(
          { task: '{"question":"Does the run fail without its answer (INT-3 B)?","boundaries":"","result":""}' },
          [],
          { thereafter: limitsCoordinator },
        );
        // The answer agent's model fails on every attempt.
        model.script({ agent: LIMITS_ANSWER_AGENT }, [], { thereafter: modelError() });
        const root = await rootWithWaitingBrief(harness, model, ownerId, {
          template: LIMITS_TEMPLATE_NAME,
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
          async () => (await harness.sessions.list(root.rootId, ownerId)).filter((view) => view.definition === LIMITS_TEMPLATE_NAME),
          (found) => found.length > 0,
          'the coordinator of the test template',
        );

        // The run ends failed by the coordinator's turn limit after exactly six model calls.
        expect(await waitForStatus(harness, coordinator.agentId, ownerId, 'failed')).toMatchObject({
          status: 'failed',
          failureReason: 'turn_limit',
        });
        expect(coordinatorScript.calls).toHaveLength(6);

        // Both runs of the answer agent failed.
        expect(
          (await childrenOf(harness, root.rootId, coordinator.agentId, ownerId)).map(({ definition, status, failureReason }) => ({
            definition,
            status,
            failureReason,
          })),
        ).toEqual([
          { definition: 'answer', status: 'failed', failureReason: 'model_error' },
          { definition: 'answer', status: 'failed', failureReason: 'model_error' },
        ]);

        // Every text answer after the second failure is met by a notice, not by the end of the session.
        const history = await historyOf(harness, coordinator.agentId, ownerId);
        const secondFailure = history.filter((entry) => entry.kind === 'child_report')[1];
        expect(secondFailure).toMatchObject({ content: { status: 'failed', reason: 'model_error' } });
        const textsAfter = history.flatMap((entry, index) =>
          entry.kind === 'model_answer' && entry.seq > secondFailure.seq && entry.content.toolCalls.length === 0 ? [index] : [],
        );
        expect(textsAfter.length).toBeGreaterThanOrEqual(1);
        for (const index of textsAfter) {
          expect(history[index + 1]).toMatchObject({
            kind: 'notice',
            content: {
              text: 'You cannot finish: the last run of agent "answer" ended as failed. The session ends only with a completed report of agent "answer"; start it with start_agent.',
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
