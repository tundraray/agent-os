// custom-agents / runtime - workflows-package integration skeleton (in-process `createRuntime` + `createAgents` + `createWorkflows` over real Postgres, scripted model, library double)
// Design Doc: docs/features/custom-agents/design-runtime.md (v1.1), Test Strategy UC-6, UC-E4; Flow 2; KD-5;
//   PRD: docs/features/custom-agents/prd.md FR-13, FR-16 (AC-13.4, AC-16.1, AC-16.2, AC-16.3, AC-16.4, AC-16.6).
// Generated: 2026-11-17
// Part: runtime. THE PART'S BUDGET, THE FULL acProof AND THE LIST OF UNIT TABLES ARE IN `apps/api/test/custom-agents-runtime.int.e2e-spec.ts` (one place;
//   this file holds INT-2 of 4).
// Test Type: Integration. Run with `pnpm --filter @agent-os/workflows test:e2e` (`*.e2e-spec.ts`), never in the default `vitest run`.
//
// Harness (follows agent-platform-workflows.int.e2e-spec.ts and test/support/workflowsHarness.ts):
//   real Postgres, real runtime, agents and workflows, workers on; the scripted model (the coordinator's scenario answers from the state of its
//   history, the "reply from history" kind of the existing harness) is the only model double. The harness's template registration
//   (`shippedTemplatesWith`, `LIMITS_TEMPLATE`) is replaced by the `library` double of the agents harness holding a WORKFLOW record
//   (`WorkflowContent`: coordinator, executors with `role` and `maxRuns`, no rules, no `finalExecutor`). The tree root is the test root of the
//   existing harness whose set lists `start_workflow`; the brief is confirmed through the real `workflows.brief` decision.
//
// What is NOT repeated here: the existing workflows INT-1..INT-3 (the brief reaching the coordinator, a run to the report, the final-step
//   rule) are rewritten by the implementation tasks onto the library double (design Appendix: Fact Disposition) and stay as they are; the
//   `gateStart` rule rows (`not_allowed` for a name outside the team and for a fork at a coordinator, `run_limit` at the limit) are the unit
//   table of `tool-gate.spec.ts`; the workflow-content-to-snapshot function and the `WorkflowRunView` mapping are unit tables over fakes.
//
// Budget and acProof: see the api file.

import { randomUUID } from 'node:crypto';
import type { AgentHistoryEntry, AgentTurnMessage, AgentTurnModelClient } from '@agent-os/agents';
import {
  createLatch,
  createScriptedModel,
  type RecordedModelCall,
  type ReplyFromInput,
  type ScriptedModel,
  type ScriptedToolCall,
} from '@agent-os/agents/testing';
import { describe, expect, it } from 'vitest';
import { newUser } from './support/new-user.js';
import {
  childReportsOf,
  coordinatorsUnder,
  createWorkflowsHarness,
  HAIKU_MODEL,
  historyOf,
  type TestAgentRecord,
  type TestWorkflowContent,
  type TestWorkflowOverrides,
  testExecutor,
  testWorkflow,
  toolCallRowsOf,
  waitFor,
  waitForStatus,
  type WorkflowsHarness,
} from './support/workflowsHarness.js';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** The workflow of Аня that Борис runs: its name is the coordinator's name. */
const WORKFLOW_NAME = 'incident review';

/**
 * The coordinator's turns, counted call by call (a turn is one model call; `turns >= maxTurns` fails the
 * step before the call). Row A, first run: the start of a, b and c (1), the text on its own results (2), a
 * wake per report, the last one being the answer (3-5) — 5 at most. Row A, second run: start a, text, the
 * report — 3. Row B: start b twice (1), start b and d (2), a text (3), a wake per report of b (4-5) — 5.
 */
const COORDINATOR_MAX_TURNS = 5;

/** Rules of the coordinator that version 2 adds (version 1 has none, AC-16.4). */
const RULES_V2 = 'Start a first; start b and c only when a found something.';

/** The first line of the text every coordinator starts from (`COORDINATOR_PROMPT` of `agents`). */
const COORDINATOR_FIRST_LINE =
  'You coordinate a workflow for an employee: you get the work done by starting the executors of your team with start_agent, calling each by its name.';
/** The finishing rule of a workflow without `finalExecutor` (DC-7). */
const COORDINATOR_WRITES_ANSWER = 'When the work is done, write the answer yourself as plain text without tool calls.';

/** The team as the coordinator's `start_agent` lists it: «имя (до N вызовов): роль». */
const TEAM_V1_LINES = [
  'a (до 1 вызовов): Reads the incident timeline (version 1).',
  'b (до 2 вызовов): Checks the payment logs.',
  'c (до 1 вызовов): Writes the customer note.',
];
const TEAM_V2_LINES = [
  'a (до 1 вызовов): Reads the incident timeline and the deploy log (version 2).',
  'b (до 2 вызовов): Checks the payment logs.',
  'c (до 1 вызовов): Writes the customer note.',
];

/** The agent records of Аня the executors `a` and `c` were taken from. */
interface TeamSources {
  readonly a: string;
  readonly c: string;
}

/**
 * Version 1 of the workflow: three executors with a role line each and `maxRuns` 1, 2 and 1, no coordinator
 * rules and no `finalExecutor`; `a` is a copy of its source at version 2, `c` of its source at version 1.
 */
function teamV1(sources: TeamSources): TestWorkflowContent {
  return {
    coordinator: { rules: '', model: HAIKU_MODEL, maxTurns: COORDINATOR_MAX_TURNS },
    executors: [
      testExecutor('a', {
        role: 'Reads the incident timeline (version 1).',
        prompt: 'You are executor a of team version 1.',
        source: { recordId: sources.a, version: 2 },
      }),
      testExecutor('b', {
        role: 'Checks the payment logs.',
        prompt: 'You are executor b of team version 1.',
        maxRuns: 2,
      }),
      testExecutor('c', {
        role: 'Writes the customer note.',
        prompt: 'You are executor c of team version 1.',
        source: { recordId: sources.c, version: 1 },
      }),
    ],
    finalExecutor: null,
  };
}

/** Version 2: coordinator rules, and `a` updated from its source's version 3 (another role and prompt). */
function teamV2(sources: TeamSources): TestWorkflowContent {
  const v1 = teamV1(sources);
  return {
    ...v1,
    coordinator: { ...v1.coordinator, rules: RULES_V2 },
    executors: v1.executors.map((executor) =>
      executor.name === 'a'
        ? {
            ...executor,
            role: 'Reads the incident timeline and the deploy log (version 2).',
            prompt: 'You are executor a from its source version 3.',
            source: { recordId: sources.a, version: 3 },
          }
        : executor,
    ),
  };
}

/** The workflow is Аня's and open to Борис (as to a role he holds), offered in his main chat. */
function sharedWith(ana: string, boris: string): TestWorkflowOverrides {
  return { ownerId: ana, ownerName: 'Аня', everyone: false, viewers: [boris], offerInChat: true };
}

/** A private agent record of Аня: Борис does not see it. */
function anaAgent(ana: string, name: string, prompt: string): TestAgentRecord {
  return { kind: 'agent', name, ownerId: ana, ownerName: 'Аня', content: agentContent(prompt) };
}

function agentContent(prompt: string): TestAgentRecord['content'] {
  return { prompt, servers: [], model: HAIKU_MODEL, maxTurns: 2, agents: [], tools: [] };
}

/** What one model call was given besides its messages: the system prompt and the description of `start_agent`. */
interface TurnInput {
  readonly instructions: string;
  readonly startAgent: string | undefined;
}

/**
 * The scripted model with the instructions and the `start_agent` description of every call kept (the double
 * records only the messages): `inputOf` finds them by the call's message list, the array the double records.
 */
function withTurnInputs(scripted: ScriptedModel): {
  readonly model: ScriptedModel;
  readonly inputOf: (call: RecordedModelCall | undefined) => TurnInput;
} {
  const inputs = new WeakMap<readonly AgentTurnMessage[], TurnInput>();
  const turnClient: AgentTurnModelClient = {
    streamTurn(call, options) {
      inputs.set(call.messages, {
        instructions: call.instructions,
        startAgent: call.tools.find((tool) => tool.name === 'start_agent')?.description,
      });
      return scripted.turnClient.streamTurn(call, options);
    },
  };
  return {
    model: { ...scripted, turnClient },
    inputOf: (call) => {
      const input = call === undefined ? undefined : inputs.get(call.messages);
      if (input === undefined) throw new Error('No model call was recorded there');
      return input;
    },
  };
}

/** The record's own prompt: the instructions before the package's text that follows it. */
function promptOf(input: TurnInput): string {
  return input.instructions.split('\n\n')[0] ?? '';
}

/** The lines of whom `start_agent` may start, as the model reads them. */
function teamLinesOf(input: TurnInput): string[] {
  const lines = (input.startAgent ?? '').split('\n');
  return lines.slice(lines.indexOf('Agents you may start:') + 1).map((line) => line.replace(/^- /, ''));
}

/** A `start_agent` call of a scripted answer: `agent` is an executor's name. */
function startAgent(agent: string, description: string, prompt: string): ScriptedToolCall {
  return { tool: 'start_agent', args: { agent, description, prompt } };
}

/** The `start_agent` calls of the model's own earlier answers in a recorded input. */
function startCallsIn(messages: readonly AgentTurnMessage[]): number {
  return messages.reduce(
    (count, message) =>
      message.role === 'assistant'
        ? count + message.toolCalls.filter((call) => call.toolName === 'start_agent').length
        : count,
    0,
  );
}

/** Whether a recorded input holds a report of every child with these descriptions (`provider-messages.ts`). */
function allReported(messages: readonly AgentTurnMessage[], descriptions: readonly string[]): boolean {
  const reports = messages.flatMap((message) =>
    message.role === 'user' && message.content.startsWith('<data source="child agent report"') ? [message.content] : [],
  );
  return descriptions.every((description) => reports.some((report) => report.includes(description)));
}

/** A coordinator that writes `answer` once every child it started has reported, and a short text before that. */
function answerWhenReported(descriptions: readonly string[], answer: string): ReplyFromInput {
  return (messages) => ({ text: allReported(messages, descriptions) ? answer : 'Waiting for the team.' });
}

/** Each `start_agent` result of an agent's history as [executor asked for, outcome, refusal reason], in order. */
function startAgentResults(entries: readonly AgentHistoryEntry[]): [string, string, string | null][] {
  return entries.flatMap((entry): [string, string, string | null][] =>
    entry.kind === 'tool_result' && entry.content.tool === 'start_agent'
      ? [[(entry.content.args as { agent: string }).agent, entry.content.outcome, entry.content.refusalReason]]
      : [],
  );
}

interface WorkflowConversation {
  /** The root's task: its script calls `start_workflow` with the brief. */
  readonly task: string;
  readonly workflowId: string;
  readonly brief: { readonly question: string; readonly boundaries: string; readonly result: string };
}

/**
 * Starts a conversation whose first answer calls `start_workflow`, confirms the brief unchanged through the
 * real `workflows.brief` decision and returns once the coordinator exists.
 */
async function confirmWorkflow(
  harness: WorkflowsHarness,
  model: ScriptedModel,
  ownerId: string,
  conversation: WorkflowConversation,
): Promise<{ rootId: string; coordinatorId: string }> {
  model.script(
    { task: conversation.task },
    [{ calls: [{ tool: 'start_workflow', args: { workflow: conversation.workflowId, ...conversation.brief } }] }],
    { thereafter: { text: 'Noted.' } },
  );
  const { agentId: rootId } = await harness.sessions.start({
    ownerId,
    prompt: conversation.task,
    description: 'Conversation',
  });
  const [request] = await waitFor(
    async () => (await harness.sessions.confirmations(rootId, ownerId)).filter((c) => c.status === 'open'),
    (open) => open.length === 1,
    `the brief of root ${rootId} to wait for a decision`,
  );
  expect(await harness.sessions.resolveConfirmation({ decisionId: request.decisionId, ownerId, approve: true })).toBe(
    'resolved',
  );
  const [coordinator] = await waitFor(
    () => coordinatorsUnder(harness, rootId, ownerId),
    (found) => found.length > 0,
    `the coordinator under root ${rootId}`,
  );
  return { rootId, coordinatorId: coordinator.agentId };
}

const FIRST_BRIEF = { question: 'What broke card payments on Monday?', boundaries: 'payments only', result: 'a short review' };
/** The coordinator's task: the confirmed brief as `start_workflow` writes it. */
const FIRST_BRIEF_TASK = '{"question":"What broke card payments on Monday?","boundaries":"payments only","result":"a short review"}';
const FIRST_ANSWER = 'Review: the timeline, the logs and the note agree - a bad deploy at 10:40.';

const SECOND_BRIEF = { question: 'What broke card payments on Tuesday?', boundaries: '', result: '' };
const SECOND_BRIEF_TASK = '{"question":"What broke card payments on Tuesday?","boundaries":"","result":""}';
const SECOND_ANSWER = 'Review: the timeline shows a second deploy.';

const LIMIT_BRIEF = { question: 'How many payments failed on Wednesday?', boundaries: '', result: 'one number' };
const LIMIT_BRIEF_TASK = '{"question":"How many payments failed on Wednesday?","boundaries":"","result":"one number"}';
const LIMIT_ANSWER = 'Twelve payments failed on Wednesday.';

/**
 * The coordinator of row B, from its own input: no start yet -> `b` twice in one answer; two starts ->
 * `b` a third time and `d` (not in the team) in one answer; then the answer once both runs of `b` have
 * reported, a short text before that.
 */
const overTheLimit: ReplyFromInput = (messages) => {
  const starts = startCallsIn(messages);
  if (starts === 0) {
    return {
      calls: [
        startAgent('b', 'b first', 'Check the payment logs (first).'),
        startAgent('b', 'b second', 'Check the payment logs (second).'),
      ],
    };
  }
  if (starts === 2) {
    return {
      calls: [startAgent('b', 'b third', 'Check the payment logs (third).'), startAgent('d', 'd', 'Do the work of d.')],
    };
  }
  return { text: allReported(messages, ['b first', 'b second']) ? LIMIT_ANSWER : 'Waiting for b.' };
};

describe('custom-agents / runtime - workflows package (real runtime + Postgres, scripted model, library double)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: a confirmed workflow runs to its end on the copies it started with, and a call over the limit leaves its own reason
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-13.4 "Given workflow запущен, when автор меняет координатора или исполнителя, then запуск доходит до конца на прежних копиях
  //   всех своих агентов"; AC-16.1 "Given исполнитель скопирован из агента Ани версии 2, when Аня сохраняет версию 3, then workflow
  //   работает на копии версии 2" (the "источник изменился" notice is the web part's); AC-16.2 "Given автор обновил исполнителя, when
  //   workflow запускают снова, then исполнитель работает по версии 3"; AC-16.3 "Given workflow Ани открыт роли «SRE», when Борис его
  //   запускает, then исполнители работают с правами Бориса, даже если их источники Борису не видны"; AC-16.4 "Given у workflow три
  //   исполнителя со своими строками, а правил координатора нет, when workflow запускают, then координатор видит строку каждого
  //   исполнителя и сам решает, кого и когда звать"; AC-16.6 "Given предел запуска workflow исчерпан, when координатор зовёт исполнителя
  //   из команды ещё раз, then вызов отклонён с причиной, которая называет предел запуска и отличается от причины отказа при вызове
  //   исполнителя, которого нет в команде". Design: UC-6, UC-E4 (the integration case), DC-7, KD-5, Flow 2, invariant 1.
  // Behavior: Борис confirms a workflow of Аня -> `resolveStart` builds ONE snapshot of the whole team from the record -> the coordinator and
  //   every executor start from it -> the coordinator ends the turn itself when the workflow has no final executor.
  // Rows (literal expected values):
  //   A. The whole team on one copy (AC-13.4, AC-16.1..AC-16.4, DC-7). Given Аня's workflow version 1 with three executors (names `a`, `b`, `c`,
  //      each with a role line and `maxRuns` 1, 2 and 1), no coordinator rules and no `finalExecutor`, shared with Борис's role; the source
  //      record of executor `c` is not visible to Борис in the double; When Борис confirms the brief; Then the coordinator's first model
  //      input carries `start_agent` described by exactly three lines "name (до N вызовов): роль" (N = 1, 2, 1) and the shared coordinator
  //      text; Аня then saves version 2 of the workflow (another coordinator prompt, another role line of `a`) and updates executor `a`'s
  //      source to version 3; the coordinator calls `a`, `b`, `c` by name: the three children start although `c`'s source is invisible to
  //      Борис (no library read happens for an executor), every child's first input carries the prompt of the version-1 team, and the
  //      coordinator's later inputs still carry the version-1 prompt; the coordinator finishes with its own text answer and the run is
  //      `completed` (no "answer through the final executor" notice, DC-7). Then Борис confirms the workflow again: the coordinator's input
  //      carries the version-2 prompt and executor `a` runs the updated copy (AC-16.2).
  //   B. Limit and unknown name are different reasons (AC-16.6, UC-E4). Given the same team where `b` may run twice; When the coordinator
  //      calls `b` a third time and then calls a name that is not in the team; Then the third call is closed with `run_limit`, the other
  //      with `not_allowed` (two different tool-result reasons in the coordinator's history); the `agent_tool_calls` row of the first holds
  //      `run_limit` (the CHECK of the migration accepts it); no third child of `b` exists; `runs.get` of the coordinator returns `team` with
  //      the three names, roles and `maxRuns`, `steps` with the children and their `origin.executor`, and `limitRefusals` with exactly one
  //      `{ executor: 'b', at }`.
  // Catches: an executor or the coordinator that reads the record at its own start (an author's edit reaches a run in progress - or a source
  //   the runner cannot see stops a run that the workflow itself allows); a coordinator that does not see each executor's role and limit
  //   (the model chooses blind); a final answer refused because no `finalExecutor` is set (the run stalls and ends by the turn limit); `run_limit`
  //   and `not_allowed` collapsed into one reason, or a `run_limit` refusal that never reaches the database (CHECK not rewritten) or the view;
  //   a team whose second run still uses the first run's copy.
  // @category: core-functionality
  // @dependency: Agents.resolveStart (workflow source), startChild, gateStart, workflows.brief / start_workflow, runs.get, RecordLibrary (double), runtime, Postgres
  // @complexity: high
  it(
    'INT-2 A: a confirmed workflow runs on one copy of its whole team whatever the author edits, ends with the coordinator\'s answer, and the next run takes the new version',
    async () => {
      const boris = newUser();
      const ana = randomUUID();
      const { model, inputOf } = withTurnInputs(createScriptedModel());
      const harness = await createWorkflowsHarness({ model, owners: [boris] });
      try {
        // Given: Аня's workflow version 1, open to Борис; the sources of `a` (version 2) and `c` are her private records
        const { library } = harness;
        const sourceA = library.add(anaAgent(ana, 'timeline reader', 'You read incident timelines, version 1.'));
        library.edit(sourceA, { body: { kind: 'agent', content: agentContent('You read incident timelines, version 2.') } });
        const sourceC = library.add(anaAgent(ana, 'note writer', 'You write customer notes.'));
        const sources = { a: sourceA, c: sourceC };
        const workflowId = library.add(testWorkflow(WORKFLOW_NAME, teamV1(sources), sharedWith(ana, boris)));

        const coordinatorHeld = createLatch();
        const firstRun = model.script(
          { task: FIRST_BRIEF_TASK },
          [
            {
              calls: [
                startAgent('a', 'executor a', 'Read the timeline (run one).'),
                startAgent('b', 'executor b', 'Check the payment logs (run one).'),
                startAgent('c', 'executor c', 'Write the customer note (run one).'),
              ],
              latch: coordinatorHeld,
            },
          ],
          { thereafter: answerWhenReported(['executor a', 'executor b', 'executor c'], FIRST_ANSWER) },
        );
        const executorA = model.script({ task: 'Read the timeline (run one).' }, [{ text: 'The timeline is read.' }]);
        const executorB = model.script({ task: 'Check the payment logs (run one).' }, [{ text: 'The logs are checked.' }]);
        const executorC = model.script({ task: 'Write the customer note (run one).' }, [{ text: 'The note is written.' }]);

        // When: Борис confirms the brief; the coordinator's first call is held
        const first = await confirmWorkflow(harness, model, boris, {
          task: 'Review the incident of Monday',
          workflowId,
          brief: FIRST_BRIEF,
        });
        await coordinatorHeld.reached();

        // Then: the coordinator starts from the shared text, writes the answer itself and sees each executor's role and limit
        const firstInput = inputOf(firstRun.calls[0]);
        expect(firstInput.instructions.split('\n')[0]).toBe(COORDINATOR_FIRST_LINE);
        expect(firstInput.instructions).toContain(COORDINATOR_WRITES_ANSWER);
        expect(firstInput.instructions).not.toContain('Rules of this workflow');
        expect(teamLinesOf(firstInput)).toEqual(TEAM_V1_LINES);

        // When: while the run goes on, Аня saves version 2 of the workflow and version 3 of the source of `a`
        library.edit(workflowId, { body: { kind: 'workflow', content: teamV2(sources) } });
        library.edit(sourceA, { body: { kind: 'agent', content: agentContent('You read incident timelines, version 3.') } });
        const readsBefore = library.resolveCalls.length;
        coordinatorHeld.open();

        // Then: the run ends with the coordinator's own answer, on version 1, with no library read for an executor
        expect(await waitForStatus(harness, first.coordinatorId, boris, 'completed')).toMatchObject({
          name: WORKFLOW_NAME,
          origin: { recordId: workflowId, kind: 'workflow', version: 1, executor: null },
        });
        expect(library.resolveCalls.slice(readsBefore)).toEqual([]);

        // Then: the three executors ran, `c` too though its source is hidden from Борис, each on the version-1 copy
        const team = (await harness.sessions.list(first.rootId, boris)).filter(
          (view) => view.parentId === first.coordinatorId,
        );
        expect(
          team
            .map(({ name, status, origin }) => ({ name, status, version: origin?.version, executor: origin?.executor }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        ).toEqual([
          { name: 'a', status: 'completed', version: 1, executor: 'a' },
          { name: 'b', status: 'completed', version: 1, executor: 'b' },
          { name: 'c', status: 'completed', version: 1, executor: 'c' },
        ]);
        expect([executorA, executorB, executorC].map((script) => promptOf(inputOf(script.calls[0])))).toEqual([
          'You are executor a of team version 1.',
          'You are executor b of team version 1.',
          'You are executor c of team version 1.',
        ]);

        // Then: every later input of the coordinator still holds the version-1 team and no version-2 rules
        expect(firstRun.calls.length).toBeGreaterThan(1);
        for (const call of firstRun.calls) {
          const input = inputOf(call);
          expect(teamLinesOf(input)).toEqual(TEAM_V1_LINES);
          expect(input.instructions).not.toContain(RULES_V2);
        }

        // Then: no "answer through the final executor" notice; the root receives the coordinator's answer as the run's report
        expect(
          (await historyOf(harness, first.coordinatorId, boris)).filter((entry) => entry.kind === 'notice'),
        ).toEqual([]);
        const firstReports = await waitFor(
          () => childReportsOf(harness, first.rootId, boris),
          (reports) => reports.length > 0,
          'the report of the first run at the root',
        );
        expect(firstReports.map(({ agentId, status, text }) => ({ agentId, status, text }))).toEqual([
          { agentId: first.coordinatorId, status: 'completed', text: FIRST_ANSWER },
        ]);

        // When: Борис confirms the workflow again
        const secondRun = model.script(
          { task: SECOND_BRIEF_TASK },
          [{ calls: [startAgent('a', 'executor a', 'Read the timeline (run two).')] }],
          { thereafter: answerWhenReported(['executor a'], SECOND_ANSWER) },
        );
        const executorASecond = model.script({ task: 'Read the timeline (run two).' }, [{ text: 'The timeline is read again.' }]);
        const second = await confirmWorkflow(harness, model, boris, {
          task: 'Review the incident of Tuesday',
          workflowId,
          brief: SECOND_BRIEF,
        });

        // Then: the second run is version 2 - the coordinator's rules and team, and `a` updated from its source (AC-16.2)
        expect(await waitForStatus(harness, second.coordinatorId, boris, 'completed')).toMatchObject({
          origin: { recordId: workflowId, version: 2, executor: null },
        });
        const secondInput = inputOf(secondRun.calls[0]);
        expect(secondInput.instructions).toContain(`Rules of this workflow:\n${RULES_V2}`);
        expect(teamLinesOf(secondInput)).toEqual(TEAM_V2_LINES);
        expect(promptOf(inputOf(executorASecond.calls[0]))).toBe('You are executor a from its source version 3.');
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-2 B: a call over the limit is refused as `run_limit`, not as an unknown name, and the refusal reaches the database and the run view',
    async () => {
      const boris = newUser();
      const ana = randomUUID();
      const model = createScriptedModel();
      const harness = await createWorkflowsHarness({ model, owners: [boris] });
      try {
        // Given: the same team, where `b` may run twice
        const workflowId = harness.library.add(
          testWorkflow(WORKFLOW_NAME, teamV1({ a: randomUUID(), c: randomUUID() }), sharedWith(ana, boris)),
        );
        model.script({ task: LIMIT_BRIEF_TASK }, [], { thereafter: overTheLimit });
        model.script({ task: 'Check the payment logs (first).' }, [{ text: 'First check: 7 failures.' }]);
        model.script({ task: 'Check the payment logs (second).' }, [{ text: 'Second check: 5 failures.' }]);

        // When: the coordinator calls `b` twice, then `b` a third time and `d`, which is not in the team
        const run = await confirmWorkflow(harness, model, boris, {
          task: 'Count the failed payments of Wednesday',
          workflowId,
          brief: LIMIT_BRIEF,
        });
        await waitForStatus(harness, run.coordinatorId, boris, 'completed');

        // Then: two different reasons in the coordinator's history, and in its rows of `agent_tool_calls`
        const history = await historyOf(harness, run.coordinatorId, boris);
        expect(startAgentResults(history)).toEqual([
          ['b', 'success', null],
          ['b', 'success', null],
          ['b', 'refused', 'run_limit'],
          ['d', 'refused', 'not_allowed'],
        ]);
        expect(
          (await toolCallRowsOf(harness.db, run.coordinatorId)).map(
            (row) => `${row.tool} ${row.outcome} ${row.refusalReason ?? '-'}`,
          ),
        ).toEqual([
          'start_agent success -',
          'start_agent success -',
          'start_agent refused run_limit',
          'start_agent refused not_allowed',
        ]);

        // Then: the run view has the team, the two runs of `b` (no third) and exactly one refusal by the limit
        const view = await harness.workflows.runs.get(run.coordinatorId, boris);
        expect(view.team).toEqual([
          { name: 'a', role: 'Reads the incident timeline (version 1).', maxRuns: 1, final: false },
          { name: 'b', role: 'Checks the payment logs.', maxRuns: 2, final: false },
          { name: 'c', role: 'Writes the customer note.', maxRuns: 1, final: false },
        ]);
        expect(
          view.steps.map(({ name, description, origin }) => ({ name, description, executor: origin?.executor })),
        ).toEqual([
          { name: 'b', description: 'b first', executor: 'b' },
          { name: 'b', description: 'b second', executor: 'b' },
        ]);
        const refusedAt = history.find(
          (entry) => entry.kind === 'tool_result' && entry.content.refusalReason === 'run_limit',
        )?.createdAt;
        expect(view.limitRefusals).toEqual([{ executor: 'b', at: refusedAt }]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
