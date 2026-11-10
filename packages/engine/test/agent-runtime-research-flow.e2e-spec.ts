// agent-runtime / research-flow E2E Test Skeletons (engine side) - Design Doc: docs/features/agent-runtime/design-research-flow.md (v1.3, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-12, FR-15; NFR-03 for the research forms). Test Strategy: UC-E5 (restart in the middle of the closure). Flow 1 and Flow 2 of the Design Doc ("Failure handling": the process dies after the model's answer).
// Generated: 2026-11-08 | Part: research-flow | Test type: End-to-End (real killed process + built runtime and engine + real Postgres; scripted model program; the shipped v3 configuration), CI job `e2e-engine`
// Implementation timing: after all research-flow slices land (final phase only). Needs the engine child to load the shipped v3 and the crash points around the form closure (test code, never `src`).
// Counterpart in-process file: agent-runtime-research-flow.int.e2e-spec.ts (INT-1..INT-4). The agent-core kill matrix (agent-runtime-agent-core.e2e-spec.ts, E2E-1 K1..K6) proves the agent's turn, its tools and its child runs under a killed process;
// this file proves only what the research forms add on top: the closure of a form and its write are ONE record with the run's result, so a restart neither loses a verification / an answer nor writes it twice.
//
// Started as `it.todo` skeletons; implemented by plan task T5.5 (rows V1, V2, R1, R2). Post-implementation cycle 1 (test audit): V2 and R2 merged into
// agent-runtime-agent-core.e2e-spec.ts E2E-1 K8 (a closure's write repeated after a kill right after it), L1 merged into L2; V1, R1, L2 and S1 stay.
//
// Environment (same as agent-core E2E-1; support in place: test/support/engineChild.ts, engineChildMain.ts, engineDb.ts; the agent additions of agent-core are assumed done):
// - Postgres 16 from infra/docker-compose.yml; the compiled child (`pnpm build && pnpm build:child`, `dist/test-child/`) with `RUNTIME_WORKERS=on`, short `RUNTIME_LEASE_MS`, `RUNTIME_REAPER_MS`, `RUNTIME_POLL_MS`.
// - The doubles are the model boundary and the counting source. The model is the `fallback` PROGRAM that answers from the call itself (the agent recognised by the leading text of its loaded system prompt, the step from the number of tool-result messages in the prompt), the same
//   program in the dying child and in the restarted one. The program answers the agents of the minimal scenario of the shipped v3 (no `subworker` is called): controller -> planner -> one worker with one claim -> one verifier -> synthesis -> `research_close`.
// - `EngineChildScenario` gains the process id and the version; the child registers the shipped v3 (`deepResearchProcessV3`) and the counting source with the scenario's records; its group table is built from the loaded config (as in the int file).
// - Crash points are test-code hooks in engineChildMain.ts (`ENGINE_CRASH_AT=<point>[:n]`, never read under `NODE_ENV=production`), built as a wrapper over `withAttemptGuard` that sees which form's closure write is about to run or has just returned:
//   `research-flow.close.before-write:<agent>` and `research-flow.close.after-write:<agent>` for `<agent>` = `verifier` | `controller`. "Before" is after the model's answer with the form's `finish` is recorded in the session and before the form's guarded write; "after" is right after that write returned.
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per row; `fileParallelism: false`. Synchronisation only on proven states: the exit code 137 of the dying child, then rows of the test database. No latency assertions; "continues after restart" is the harness timeout of the wait for the end state.
//
// Budget: E2E 1 of the part's 2 (the other is the api switch journey). One journey - the restart of an investigation on v3 at the two closures that write research state - with two rows (V1, R1). Nothing at a lower level can prove it: the death of the process between the
//   recorded turn and the form's write (or right after it) is not reproducible in-process; a held handler is alive and can write later, a dead one cannot. The agent-core matrix kills the process in the generic points of a turn (before the call, after the answer, after
//   a tool, around a child's `propose`); it does not run a form's closure, so a verification revision written outside the run's result record, or an answer written outside the root's, passes every agent-core row.
//
// AC -> proving test: DC-8 (the revision and the run's result are one record, so the retry after a restart executes the recorded `finish` and writes nothing a second time) = V1, agent-core K8;
//   DC-2 and KD-3 (the answer is written once with the root's result) = R1, agent-core K8; NFR-03 for the forms = V1, R1.

import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import { afterAll, describe, expect, it } from 'vitest';
import { databaseUrl } from './support/database-url.js';
import { CRASH_EXIT_CODE, type RunRows, runScenario, type ScenarioRun } from './support/engineChild.js';
import { assertNoActiveInvestigations, closeEngineDb, trackedOwnerCount, trackInvestigationOwner } from './support/engineDb.js';
import { newUser } from './support/new-user.js';

const ROW_MS = 150_000;
const CLAIM_TEXT = 'payment-api logged a timeout at 19:04';
/** 13 turns of the tree (controller 5, planner 2, worker 4, verifier 1, synthesis 1) at 1 050 charged tokens each. */
const TREE_TOKENS = 13_650;
const CLAIM_RESULT = { status: 'supported', group: 'medium' };
/**
 * The pass of `relay.before-done` that delivers the root's `TaskSucceeded` to `engine.lifecycle`: six tasks end, each end
 * delivered to `runtime.scheduler` and then to `engine.lifecycle`, and the root's ends last.
 */
const CLOSURE_DELIVERY_PASS = 12;

/**
 * The shipped v3 in the engine child, killed at `crashAt`, then continued by a fresh child. The owner is tracked here: a
 * child's start does not pass through the in-process harness that tracks its own.
 */
function runRestart(crashAt: string): Promise<ScenarioRun> {
  const resourceId = newUser();
  trackInvestigationOwner(resourceId);
  return runScenario({ crashAt, resourceId, agents: { processId: 'deep-research', version: 3 } });
}

/** The same with a crash point of the runtime's closed list (`RUNTIME_CRASH_AT`) instead of the engine's. */
function runRuntimeRestart(runtimeCrashAt: string): Promise<ScenarioRun> {
  const resourceId = newUser();
  trackInvestigationOwner(resourceId);
  return runScenario({ runtimeCrashAt, resourceId, agents: { processId: 'deep-research', version: 3 } });
}

const agentOf = (task: { readonly input: unknown }): string | undefined => (task.input as { agentName?: string }).agentName;

function taskOf(rows: RunRows, agent: string) {
  const tasks = rows.tasks.filter((task) => agentOf(task) === agent);
  if (tasks.length !== 1) throw new Error(`${tasks.length} tasks of ${agent}`);
  return tasks[0]!;
}

/** `[agent of the writing run, status, group]` of every claim revision, in write order. */
function revisionsOf(rows: RunRows): [string | undefined, string, string | null][] {
  const authors = new Map(rows.tasks.map((task) => [task.taskId, agentOf(task)]));
  return rows.rows.claims.map((claim) => [authors.get(claim.taskId), claim.status, claim.confidence]);
}

function ledgerOf(rows: RunRows, agent: string): string[] {
  const { taskId } = taskOf(rows, agent);
  return rows.rows.llmCalls.filter((row) => row.taskId === taskId).map((row) => row.status);
}

/** `[toolName, state]` of the agent's tool calls, by number. */
function callsOf(rows: RunRows, agent: string): [string, string][] {
  const { taskId } = taskOf(rows, agent);
  return rows.agentRows.toolCalls.filter((call) => call.runTaskId === taskId).map((call) => [call.toolName, call.state]);
}

const runOf = (rows: RunRows, agent: string) => rows.agentRows.runs.find((run) => run.agentName === agent);
const answerOf = (rows: RunRows) => rows.rows.run?.answer as { outcome: string; message: { text: string } } | null | undefined;
const claimIdOf = (rows: RunRows): string => rows.rows.claims[0]!.claimId;

const CONTROLLER_CALLS: [string, string][] = [
  ['call_agent', 'done'],
  ['call_agent', 'done'],
  ['call_agent', 'done'],
  ['investigation_read', 'done'],
  ['finish', 'done'],
];
const WORKER_CALLS: [string, string][] = [
  ['gather', 'done'],
  ['claims_write', 'done'],
  ['call_agent', 'done'],
  ['finish', 'done'],
];

/**
 * The common Then of every row: `completed` and closed once; every task of the one tree `succeeded`; the claim's two
 * revisions, the check written by the verifier; one answer written with the root's result in one row version; every
 * recorded answer has exactly one settled ledger row, none lost or asked again; the ledger adds up to the charge.
 */
function expectCommonEnd(end: RunRows): void {
  expect(end.closure.status).toBe('completed');
  expect(end.closure.completedEvents).toBe(1);
  expect([end.investigations, end.engineRuns]).toEqual([1, 1]);
  expect(end.tasks.map((task) => [task.workflowType, agentOf(task), task.status])).toEqual([
    ['agent.root', 'controller', 'succeeded'],
    ['agent.run', 'planner', 'succeeded'],
    ['agent.run', 'worker', 'succeeded'],
    ['source.fetch', undefined, 'succeeded'],
    ['agent.run', 'verifier', 'succeeded'],
    ['agent.run', 'synthesis', 'succeeded'],
  ]);

  expect(new Set(end.rows.claims.map((claim) => claim.claimId)).size).toBe(1);
  expect(end.rows.claims.map((claim) => claim.text)).toEqual([CLAIM_TEXT, CLAIM_TEXT]);
  expect(revisionsOf(end)).toEqual([
    ['worker', 'unverified', null],
    ['verifier', 'supported', 'medium'],
  ]);

  const answer = answerOf(end);
  expect(answer?.outcome).toBe('answered');
  expect(answer?.message.text).toContain(`- ${CLAIM_TEXT} [1] (уверенность средняя)`);
  expect(end.answerRow?.engineVersion).toBe(end.answerRow?.rootVersion);
  expect({ ...(end.answerRow?.rootResult as object), message: answer?.message }).toEqual(answer);

  for (const task of end.tasks.filter((one) => agentOf(one) !== undefined)) {
    const messages = end.agentRows.messages.filter((message) => message.runTaskId === task.taskId);
    expect(messages.map((message) => message.seq)).toEqual(messages.map((_, index) => index));
    const byId = (left: string, right: string) => left.localeCompare(right);
    const answered = messages.flatMap((message) => (message.kind === 'model_answer' ? [String(message.llmCallId)] : [])).sort(byId);
    const settled = end.rows.llmCalls.filter((row) => row.taskId === task.taskId).map((row) => row.callId).sort(byId);
    expect(answered).toEqual(settled);
  }
  expect(['controller', 'planner', 'worker', 'verifier', 'synthesis'].map((agent) => ledgerOf(end, agent).length)).toEqual([5, 2, 4, 1, 1]);
  expect([...new Set(end.rows.llmCalls.map((row) => row.status))]).toEqual(['settled']);
  expect(end.rows.llmCalls.reduce((sum, row) => sum + (row.chargedTokens ?? 0), 0)).toBe(TREE_TOKENS);
  expect([end.rows.run?.tokensSpent, end.rows.run?.tokensReserved]).toEqual([TREE_TOKENS, 0]);

  expect(callsOf(end, 'controller')).toEqual(CONTROLLER_CALLS);
  expect(callsOf(end, 'worker')).toEqual(WORKER_CALLS);
  expect(callsOf(end, 'verifier')).toEqual([['finish', 'done']]);
}

/** Runs `work` over a connection of its own. */
async function withConnection<T>(work: (connection: DatabaseConnection) => Promise<T>): Promise<T> {
  const connection = createDatabase({ connectionString: databaseUrl(), poolMax: 1 });
  try {
    return await work(connection);
  } finally {
    await connection.close();
  }
}

/** `[revision version, run version]` of the claim revisions the verifier wrote: one transaction shows as one `xmin` on both (DC-8). */
function verificationVersionsOf(rows: RunRows): Promise<[string, string][]> {
  return withConnection(async ({ pool }) => {
    const { rows: versions } = await pool.query<{ revision: string; run: string }>(
      `SELECT c.xmin::text AS revision, r.xmin::text AS run
         FROM app.research_claims c
         JOIN app.research_agent_runs r ON r.task_id = c.task_id
        WHERE c.investigation_id = $1 AND r.agent_name = 'verifier'`,
      [rows.investigationId],
    );
    return versions.map(({ revision, run }) => [revision, run]);
  });
}

/** The one verification revision and the verifier's result were written by one transaction. */
async function expectVerificationInOneWrite(end: RunRows): Promise<void> {
  const versions = await verificationVersionsOf(end);
  expect(versions).toHaveLength(1);
  expect(versions[0]![0]).toBe(versions[0]![1]);
}

/** The worker's one call of the verifier ended with the number, the status and the group of the check. */
function expectWorkerGotCheck(end: RunRows): void {
  const { taskId } = taskOf(end, 'worker');
  const checks = end.agentRows.toolCalls.filter((call) => call.runTaskId === taskId && call.toolName === 'call_agent');
  expect(checks.map((call) => [call.childTaskId, call.outcome])).toEqual([
    [taskOf(end, 'verifier').taskId, { outcome: 'success', result: { claimId: claimIdOf(end), ...CLAIM_RESULT } }],
  ]);
}

// Rule 9 of the plan: the suite leaves no `active` investigation of the users it started them for. The check passes on no
// owner at all, so the count is what makes it bite.
afterAll(async () => {
  try {
    expect(trackedOwnerCount()).toBeGreaterThan(0);
    await assertNoActiveInvestigations();
  } finally {
    await closeEngineDb();
  }
});

describe('agent-runtime / research-flow - E2E (killed process, real Postgres, scripted model program, shipped v3)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Restart at the closure of the two forms that write: a verification and the answer
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: an employee's research is running on agents -> the server is restarted (deploy, crash) at the moment a verification or the final answer is being stored -> the research still ends with ONE verification of each claim and ONE answer, and the conversation gets one answer.
  // Verification: recovery of a form's closure through a really killed process: the new process continues from the database alone and the recorded `finish` is executed once.
  // Covers (original statements):
  // DC-8 (Flow 1, failure handling): "Процесс упал после ответа модели проверяющего -> повтор попытки исполняет `finish` по записанному ответу; ревизия и результат пишутся одной записью, поэтому второй ревизии нет."
  // DC-2 (Flow 2, failure handling): "Процесс упал до записи ответа -> повтор исполняет `finish` заново по записанному ответу хода; ответ и результат пишутся одной записью, поэтому ответ не появляется без результата корня и не пишется дважды."
  // UC-E5: "Given: процесс убит после ответа модели проверяющего до его закрытия; во втором прогоне - после ответа модели корня до записи ответа. When: сервер поднимается. Then: у утверждения одна ревизия проверки; ответ записан один раз, расследование `completed`, в беседе одно сообщение ответа."
  // Use cases: UC-E5. Flow 1 (verifier), Flow 2 (root).
  //
  // Primary failure mode (turns red when): the closure writes the verification revision or the answer in a record separate from the run's result, so a kill between the two leaves a revision without a finished verifier (the retry writes a second revision) or a finished
  //   verifier without a revision (a claim stays unchecked and the root's gate 2 sees an ended call), or an answer without the root's result (the retry writes it again), or the root's result without an answer (an investigation `completed` with nothing to deliver).
  // Behavior: question -> shipped v3 tree under a program model -> the child exits 137 at a named point of a closure -> a new child starts the same investigation (same `launchKey`) -> the tree ends and the investigation closes `completed`
  // @category: e2e
  // @dependency: full-system (runtime, engine, Postgres, built child process, shipped v3)
  // @complexity: high
  //
  // Common Then of every row (read from the rows the two processes left): the investigation is `completed`; each agent task is `succeeded`; the claim has exactly two revisions - the worker's `unverified` and ONE verification revision, written by the verifier run;
  //   the engine run row holds one answer and one message; the root's result is stored once; every recorded model answer in the sessions has exactly one ledger row (the killed turns were recorded, so they are NOT asked again: the number of model calls for the
  //   killed run's recorded turn is one in total across both processes); the sum of per-run spend equals the investigation's charged total; no reserve stays open.
  //
  // Rows (one table; points are test-code hooks):
  //   V1 - verifier, before the closure's write: the child dies after the verifier's `finish` (the assessment) is recorded, before the form's guarded write.
  //        Then: after restart the retry executes the recorded `finish`: ONE verification revision with the status the assessment gives, written together with the run's result; the verifier is `succeeded`; the worker receives claim number, status and group.
  //   V2 - merged into agent-core E2E-1 K8 (the retry after a kill right after a closure's write runs no closure again and wakes the parent once).
  //   R1 - root, before the closure's write: the child dies after the controller's `finish(research_close)` is recorded, before the form's guarded write that stores the answer.
  //        Then: after restart the retry runs the gates and the answer gateway again from the recorded `finish` and writes the answer, the message and the root's result as ONE record; one answer; `completed`.
  //   R2 - merged into agent-core E2E-1 K8 (as V2); the closure of the investigation after a restart is L2 below.
  describe('E2E-1', () => {
    it("E2E-1 V1: a process killed after the verifier's answer is recorded and before the closure writes leaves one verification revision, written once with the run's result", async () => {
      // When: the child dies after the verifier's `finish` is recorded, before the form's guarded write
      const run = await runRestart('research-flow.close.before-write:verifier');

      // Then: at the kill the answer is recorded and nothing of the closure is written
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(revisionsOf(atKill)).toEqual([['worker', 'unverified', null]]);
      expect(callsOf(atKill, 'verifier')).toEqual([['finish', 'requested']]);
      expect(ledgerOf(atKill, 'verifier')).toEqual(['settled']);
      expect(runOf(atKill, 'verifier')?.result).toBeNull();
      expect(taskOf(atKill, 'verifier').status).toBe('running');
      expect(taskOf(atKill, 'worker').status).toBe('waiting');
      // The retry executed the recorded `finish`: one revision with the run's result, the model not asked again (DC-8)
      expectCommonEnd(run.end);
      expect(runOf(run.end, 'verifier')?.result).toEqual({ claimId: claimIdOf(run.end), ...CLAIM_RESULT });
      expect(ledgerOf(run.end, 'verifier')).toEqual(['settled']);
      await expectVerificationInOneWrite(run.end);
      expectWorkerGotCheck(run.end);
    }, ROW_MS);

    it("E2E-1 R1: a process killed after the root's finish is recorded and before the answer is written ends with one answer, written together with the root's result", async () => {
      // When: the child dies after the controller's `finish(research_close)` is recorded, before the form's guarded write
      const run = await runRestart('research-flow.close.before-write:controller');

      // Then: at the kill the answer is recorded and there is neither an answer nor a result
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(answerOf(atKill)).toBeNull();
      expect(runOf(atKill, 'controller')?.result).toBeNull();
      expect(callsOf(atKill, 'controller').at(-1)).toEqual(['finish', 'requested']);
      expect(ledgerOf(atKill, 'controller')).toHaveLength(5);
      expect(atKill.closure.status).toBe('active');
      // The retry ran the gates and the gateway from the recorded `finish`: one answer in the root's own write (DC-2, KD-3)
      expectCommonEnd(run.end);
      expect(ledgerOf(run.end, 'controller')).toHaveLength(5);
    }, ROW_MS);

  });

  // Carried over from agent-quality-lifecycle E2E-1 K1, K2 (design-lifecycle.md, KD-1,
  // AC-19.1) and deep-research-engine E2E-2 K3 (KD-9): the closure of an investigation by `engine.lifecycle` and the start's
  // engine row survive a process death.
  //   L2 - the process dies inside the delivery transaction of the closure, after the scheduler's delivery of the same event; the root's `TaskSucceeded`
  //        has reached no `engine.lifecycle` consumer at the kill, so it also proves the former L1 (the end event delivered only after the restart).
  //   S1 - the process dies after the start wrote the engine row and before it proposed the root task; the repeated start
  //        with the same `launchKey` proposes it.
  // Catches: an investigation left `active` forever, or closed twice, when the end event of its root is delivered after a
  //   restart; a half-applied closure; a second investigation or engine row, or no root task, after a start died between them.
  describe('E2E-1 (lifecycle and start)', () => {
    /** At the kill: the answer is written and the investigation still open, with the root's end event where the row puts it. */
    function expectOpenAtKill(atKill: RunRows | undefined, rootEndDeliveries: [string, string][]): void {
      expect(answerOf(atKill!)?.outcome).toBe('answered');
      expect(atKill?.closure.status).toBe('active');
      expect(atKill?.closure.completedEvents).toBe(0);
      expect(atKill?.closure.rootEndDeliveries).toEqual(rootEndDeliveries);
    }

    /** After the restart: the common end, the answer of the kill unchanged, and no model call after it. */
    function expectClosedOnceAfter(run: ScenarioRun): void {
      expectCommonEnd(run.end);
      expect(run.end.investigationId).toBe(run.atKill?.investigationId);
      expect(answerOf(run.end)).toEqual(answerOf(run.atKill!));
      expect(run.end.rows.llmCalls).toEqual(run.atKill?.rows.llmCalls);
    }

    it('E2E-1 L2: a kill inside the delivery transaction of the closure leaves nothing half-closed and ends in the same single completed state after the restart', async () => {
      const run = await runRuntimeRestart(`relay.before-done:${CLOSURE_DELIVERY_PASS}`);

      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      // The scheduler's delivery of the same event is done; the closure's rolled back whole, so nothing of it is visible.
      expectOpenAtKill(run.atKill, [
        ['engine.lifecycle', 'pending'],
        ['runtime.scheduler', 'done'],
      ]);
      expectClosedOnceAfter(run);
    }, ROW_MS);

    it('E2E-1 S1: a kill after the start wrote the engine row and before it proposed the root task ends in one investigation after the repeated start', async () => {
      const run = await runRestart('engine.start.after-row');

      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      expect([run.atKill?.investigations, run.atKill?.engineRuns, run.atKill?.tasks]).toEqual([1, 1, []]);
      expect(run.last.started).toBe('existing');
      expectCommonEnd(run.end);
      expect(run.end.investigationId).toBe(run.atKill?.investigationId);
    }, ROW_MS);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Not observable as an assertion (reported to the caller)
// ---------------------------------------------------------------------------------------------------------------
// - UC-E5 says "в беседе одно сообщение ответа". The conversation message is made by the delivery loop of `chat-entry` in `apps/api`, which this engine child does not run. Here the observable part is the engine's side of it (one answer, one stored message, `readAnswerMessage` returns it once);
//   the delivery of that message exactly once after a kill is already proven by `apps/api/test/deep-research-chat-entry.e2e-spec.ts` (E2E-1, `chat-entry.append.after-save`) and is not repeated.
// - The design's UC-E5 names two kills (after the verifier's model answer, after the root's model answer). "Before the closure's write" (V1, R1) is that wording; V2 and R2 are added because the second defect of the primary failure mode - a second write after the retry - is visible only
//   when the kill is placed AFTER the write. V2 and R2 were merged into agent-core E2E-1 K8 (the forms' closures run through the same process code); V1 and R1 stay.
// - "Before the closure's write" is placed after the model's `finish` is recorded; a kill between the model's answer and the record of the turn is agent-core K2 (the turn is asked again). The two are different states and are not merged.
