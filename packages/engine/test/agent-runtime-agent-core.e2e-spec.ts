// agent-runtime / agent-core E2E tests - Design Doc: docs/features/agent-runtime/design-agent-core.md (v1.2, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-02, FR-05, NFR-03). Test Strategy: UC-E3 (restart at each point of a turn), UC-E4 (restart while the parent waits). Flows 1 and 2 of the Design Doc.
// Generated: 2026-11-08 | Part: agent-core | Test type: End-to-End (real killed process + built runtime and engine + real Postgres; scripted model program), CI job `e2e-engine`
// Implementation timing: after all agent-core slices land (final phase only). Needs the engine child to load the probe process and the agent crash points (test code, never `src`).
// Counterpart in-process file: agent-runtime-agent-core.int.e2e-spec.ts (INT-1..INT-4). The runtime's own kill matrix proves the primitives; this file proves the agent's turn and its tool calls on top of them.
//
// Started as `it.todo` skeletons; implemented by plan task T7.5 (K1-K6 by the skeleton, K7-K8 added by the task text). The support listed below is in place.
//
// Environment (same as deep-research E2E-2; support in place: test/support/engineChild.ts, engineChildMain.ts, engineDb.ts):
// - Postgres 16 from infra/docker-compose.yml; the compiled child (`pnpm build && pnpm build:child`, `dist/test-child/`) with `RUNTIME_CRASH_AT` for runtime points, `RUNTIME_WORKERS=on`, short `RUNTIME_LEASE_MS`, `RUNTIME_REAPER_MS`, `RUNTIME_POLL_MS`.
// - The only double is the model boundary. A dead process cannot hand its remaining script to the next one, so the double runs as the existing `fallback` PROGRAM: it answers from the call itself (the agent recognised by its prompt marker, the step from
//   the number of tool-result messages in the prompt), the same program in the dying child and in the restarted one. It lives in test code (scriptedModel.ts gains the agent role, see the int file's support list).
// - The probe process (`agent-probe`, data in test/support/test-configs.ts) is selected by the scenario: `EngineChildScenario` gains the process id, and the child registers that config instead of the shipped deep-research. No fixture source is needed.
// - Support (in place since T7.5): engineChildMain.ts - the agent crash points below in `CRASH_POINTS` (`ENGINE_CRASH_AT=<point>[:n]`, never read under `NODE_ENV=production`), built as test-code hooks: a wrapper of the model double (K2) and a hook before the reserve of a turn (K1), a `handlerHold`-style wrapper over `withAttemptGuard` (points after a guarded write) and a wrapper over the `TaskScheduler` handed to `createEngine` (points around `propose`). engineChild.ts - a scenario runner for the probe
//   (start with the same `launchKey`, kill, read what the dead child left, start a fresh child, wait for the closed investigation). engineDb.ts - snapshots of the agent tables (see the int file's support list).
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per row; `fileParallelism: false`. Synchronisation only on proven states: the exit code 137 of the dying child, then rows of the test database. No latency assertions; "continues
//   after restart" is the harness timeout of the wait for the end state.
//
// Budget: E2E 1 of 2 (the second slot is left free). E2E-1 is one journey, the restart matrix of NFR-03, with the rows below; nothing at a lower level can prove it - the death of the process between two writes is not reproducible in-process (a held handler is still alive and
// can write later; a dead one cannot). An in-process zombie attempt would prove the fence, not the recovery of an agent turn.
//
// AC -> proving test: AC-02.1 = K1; AC-02.2, DC-3 = K2, K3; AC-05.4 = K4, K5, K6; DC-23, UC-E11 = K7, K8; NFR-03 = K1..K4 (the four points of the PRD: before the model call, after its answer, after the tool, before the write that records the wait).

import { afterAll, describe, expect, it } from 'vitest';
import { CRASH_EXIT_CODE, type RunRows, runScenario, type ScenarioOptions } from './support/engineChild.js';
import { closeEngineDb } from './support/engineDb.js';
import { PROBE_PROCESS_ID } from './support/test-configs.js';

// Task text over the skeleton (plan 1.2, rule 7): four probe definitions (recorder with the form `probe_record`), and
// the rows K7, K8 (UC-E11, DC-23) of the same table. The engine child (test/support/engineChildMain.ts) loads the probe
// as data and the probe forms through `composeEngine` from the sources; its program: lead writes a note, calls helper
// and finishes; helper calls recorder and finishes; recorder finishes at once (K5: helper's model is unavailable).

/** The probe tree in the engine child, killed at `crashAt`, then continued by a fresh child. */
function runProbe(crashAt: string, program?: 'helper-fails') {
  const options: ScenarioOptions = { crashAt, agents: { processId: PROBE_PROCESS_ID, ...(program === undefined ? {} : { program }) } };
  return runScenario(options);
}

const agentOf = (task: { readonly input: unknown }): string | undefined => (task.input as { agentName?: string }).agentName;

/** The task of the agent's (only) run. */
function taskOf(rows: RunRows, agent: string) {
  const tasks = rows.tasks.filter((task) => agentOf(task) === agent);
  if (tasks.length !== 1) throw new Error(`${tasks.length} tasks of ${agent}`);
  return tasks[0]!;
}

/** `status` of the agent's ledger rows, oldest first. */
function ledgerOf(rows: RunRows, agent: string): string[] {
  const tasks = new Set(rows.tasks.filter((task) => agentOf(task) === agent).map((task) => task.taskId));
  return rows.rows.llmCalls.filter((row) => tasks.has(row.taskId)).map((row) => row.status);
}

/** The session messages of the agent's run, as `[kind, turn of an answer]`. */
function sessionOf(rows: RunRows, agent: string): [string, number | null][] {
  const { taskId } = taskOf(rows, agent);
  return rows.agentRows.messages
    .filter((message) => message.runTaskId === taskId)
    .map((message) => [message.kind, message.kind === 'model_answer' ? ((message.content as { turn?: number }).turn ?? null) : null]);
}

/** `[toolName, state]` of the agent's tool calls. */
function callsOf(rows: RunRows, agent: string): [string, string][] {
  const { taskId } = taskOf(rows, agent);
  return rows.agentRows.toolCalls.filter((call) => call.runTaskId === taskId).map((call) => [call.toolName, call.state]);
}

/**
 * The common Then of every row: the investigation `completed`; every agent task final with the expected status; each
 * run's messages numbered without a gap; every model answer in a session has exactly one settled ledger row of its run's
 * task, and no reserve is left open; the notes are the program's; the ledger adds up to the investigation's charge.
 */
function expectCommonEnd(end: RunRows, expected: { readonly tasks: [string, string][]; readonly notes: string[] }) {
  expect(end.closure.status).toBe('completed');
  expect(end.tasks.map((task) => [agentOf(task), task.status])).toEqual(expected.tasks);
  for (const task of end.tasks) {
    const messages = end.agentRows.messages.filter((message) => message.runTaskId === task.taskId);
    expect(messages.map((message) => message.seq)).toEqual(messages.map((_, index) => index));
    const byId = (left: string, right: string) => left.localeCompare(right);
    const answered = messages.flatMap((message) => (message.kind === 'model_answer' ? [String(message.llmCallId)] : [])).sort(byId);
    const settled = end.rows.llmCalls.filter((row) => row.taskId === task.taskId && row.status === 'settled').map((row) => row.callId).sort(byId);
    expect(answered).toEqual(settled);
  }
  expect(end.rows.llmCalls.filter((row) => row.status === 'reserved')).toEqual([]);
  expect(end.agentRows.memory.map((note) => note.text)).toEqual(expected.notes);
  expect(end.rows.llmCalls.reduce((sum, row) => sum + (row.chargedTokens ?? 0), 0)).toBe(end.rows.run?.tokensSpent);
}

const WHOLE_TREE: [string, string][] = [
  ['lead', 'succeeded'],
  ['helper', 'succeeded'],
  ['recorder', 'succeeded'],
];
const TREE_NOTES = ['lead note', 'probe closure: accepted'];
/** The sessions of an uninterrupted tree: what every row must end with, whatever its restart. */
const LEAD_SESSION: [string, number | null][] = [
  ['assignment', null],
  ['model_answer', 1],
  ['tool_result', null],
  ['model_answer', 2],
  ['tool_result', null],
  ['model_answer', 3],
  ['tool_result', null],
];
const ROW_MS = 150_000;

describe('agent-runtime / agent-core - E2E (killed process, real Postgres, scripted model program, probe process)', () => {
  afterAll(async () => {
    await closeEngineDb();
  });
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Restart matrix: the server dies at each point of an agent turn and of a parent's wait, and the tree continues without a lost turn or a doubled effect
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: an employee's investigation is running on agents -> the server is restarted (deploy, crash) at an unlucky moment -> the investigation still ends with its result, its notes are not doubled, and its children are not started twice.
  // Verification: end-to-end recovery of the agent's session, tool calls and child runs through a really killed process, with the new process continuing from the database alone.
  // Covers (original statements):
  // AC-02.1: "Given сервер остановлен между ходами агента, When сервер перезапущен, Then агент продолжает со следующего хода, и ни один сохранённый ход не выполнен заново."
  // AC-02.2: "Given сервер остановлен посреди хода, после того как инструмент этого хода уже исполнен, When ход повторяется после рестарта, Then инструмент не исполнен второй раз, а агент получает его прежний результат."
  // AC-05.4: "Given сервер перезапущен, пока родитель ждёт дочернего агента, Then после рестарта дочерний агент продолжает свою работу, родитель получает его результат, и второго запуска по тому же вызову нет."
  // NFR-03: "остановка сервера в любой точке хода агента - до вызова модели, после её ответа, после исполнения инструмента, до записи хода - не теряет ход и не исполняет инструмент дважды."
  // DC-3: "Если процесс упал после ответа модели, но до записи хода, ход выполняется заново новым вызовом модели: резерв потерянного вызова списывается полностью, как сейчас, а инструменты этого хода ещё не исполнялись."
  // Use cases: UC-E3, UC-E4. Flow 1 (whole), Flow 2 (failure handling).
  //
  // Primary failure mode (turns red when): a turn the process had already recorded is run again (a second model call and a second ledger row for the same turn); the tool of a turn whose answer was recorded runs twice (two notes); a model call lost to the crash
  //   stays an open reserve that blocks the pool or is charged half; the retry of a `call_agent` after the crash creates a second child task for the same call (two `agent.run` rows for one call), or loses a child that had already failed so the parent waits forever.
  // Behavior: question -> probe tree under a program model -> the child process exits 137 at a named point -> a new child process starts the same investigation (same `launchKey`) -> the tree ends and the investigation closes `completed`
  // @category: e2e
  // @dependency: full-system (runtime, engine, Postgres, built child process)
  // @complexity: high
  //
  // Common Then of every row (read from the rows the two processes left): the investigation is `completed`; each agent task is `succeeded`; every recorded turn appears once in the session (message numbers gap-free); every model response in the session has exactly
  //   one ledger row of the run's task; the note count is the count the program writes (one per scripted `memory_write`); the sum of per-run spend equals the investigation's charged total.
  //
  // Rows (one table; points are test-code hooks; scenario `lead` unless stated):
  //   K1 - between turns (before the reserve of turn 2): lead has recorded turn 1 (answer + tool result) and the child dies before the reserve of the next model call.
  //        Then: turn 1 is not run again (one ledger row and one model call for it in total across both processes); the run continues from turn 2 (AC-02.1); no abandoned row.
  //   K2 - after the model answered, before the turn is recorded: the double exits after producing the answer of lead's turn that asks `memory_write`, before the gateway returns it.
  //        Then: the reserve of the lost call is `abandoned` and charged in full (the whole reserve, not half); the turn is run again with ONE new model call; the note is written once (no tool of that turn ran before the crash); total model calls for the turn = 2 (DC-3).
  //        Note: "before the model call" and "after the model answered" differ only if "before" is placed BEFORE the reserve (K1) - an exit between the reserve and the double's answer leaves the same state as K2, so K2 is the single row for the lost-call case.
  //   K3 - after the tool ran, before the next step: the child dies right after the guarded write that stored the `memory_write` note and its result (the hook after that `withAttemptGuard` returns).
  //        Then: the note exists once; the tool call has its result; the restarted run does not run the tool again and the model's next view carries the first result (AC-02.2); the turn that asked for the tool is not run again.
  //   K4 - after the parent started a child, before the child's task id is recorded on the call (Flow 2 failure): the child dies after `TaskScheduler.propose` returned for the call, before the guarded write that moves the call to `waiting`.
  //        Then: after restart the parent finds the child's task by the deduplication key (any status) and records it; exactly ONE `agent.run` task and one run row exist for that call; the child finishes, the parent gets its result (AC-05.4).
  //   K5 - as K4, and the child had already failed before the process died: the child's model program ends its run with a failure (its model unavailable after the gateway's retries) in the same process, and the child process exits only after the database shows that
  //        task `failed` (the hook polls the task row; the dead process runs no worker, so the failure must happen BEFORE the kill).
  //        Then: after restart the parent finds the FAILED task by key, does NOT propose a new one (the runtime's own deduplication would not return a failed task - this is the defect), records it, is woken and gets `child_failed` (reason `model_unavailable`); there is one task for the call.
  //   K6 - restart while the parent waits: lead is `waiting` for a running helper (no write is in flight) and the child dies.
  //        Then: lead stays waiting; the helper continues from its last recorded turn; lead is woken once and receives the helper's result; one helper run for the call.
  //   K7 - (task text, plan 1.2; UC-E11, DC-23) after the guarded write of recorder's prologue (form `probe_record`), before its first turn.
  //        Then: the prologue is not run again - one first message; recorder ends with the closure's result. Catches: a second run of the form's code after the restart.
  //   K8 - (task text) after the guarded write of recorder's accepted closure, before its task ends.
  //        Then: the closure is not run again - one closure note; recorder's task `succeeded` with the result written at the kill and no new turn; its parent helper is woken once
  //        with that result. Catches: as K7, and a closure whose write the retry repeats or whose parent is woken twice. Absorbs research-flow E2E-1 V2 and R2 (a verification revision
  //        or an answer written a second time after a kill right after the form's write): the forms' closures run through the same process code, so the probe form proves it once.
  describe('E2E-1', () => {
    it('E2E-1 K1: a process killed between two turns continues with the next turn and runs no recorded turn again', async () => {
      // When: the child dies at the count of lead's second turn, before its reserve
      const run = await runProbe('agent.before-reserve:2');

      // Then: at the kill lead had recorded turn 1 and its note, nothing of turn 2
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(ledgerOf(atKill, 'lead')).toEqual(['settled']);
      expect(atKill.agentRows.memory.map((note) => note.text)).toEqual(['lead note']);
      // Turn 1 is not run again: one ledger row per turn, no abandoned row; the run went on from turn 2 (AC-02.1)
      expectCommonEnd(run.end, { tasks: WHOLE_TREE, notes: TREE_NOTES });
      expect(ledgerOf(run.end, 'lead')).toEqual(['settled', 'settled', 'settled']);
      expect(sessionOf(run.end, 'lead')).toEqual(LEAD_SESSION);
    }, ROW_MS);

    it("E2E-1 K2: a process killed after the model answered but before the turn was recorded repeats the turn with one new call, charges the lost reserve in full and writes the turn's note once", async () => {
      // When: the double has produced lead's answer asking memory_write (its reserve is written), and the child dies
      const run = await runProbe('agent.after-answer');

      // Then: at the kill the reserve is open and no tool ran
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(ledgerOf(atKill, 'lead')).toEqual(['reserved']);
      expect(atKill.agentRows.memory).toEqual([]);
      expect(atKill.agentRows.toolCalls).toEqual([]);
      // The lost reserve is abandoned and charged whole; the turn ran again with one new call; the note is written once (DC-3)
      expectCommonEnd(run.end, { tasks: WHOLE_TREE, notes: TREE_NOTES });
      expect(ledgerOf(run.end, 'lead')).toEqual(['abandoned', 'settled', 'settled', 'settled']);
      const [lost] = run.end.rows.llmCalls.filter((row) => row.status === 'abandoned');
      expect(lost!.reservedTokens).toBeGreaterThan(0);
      expect(lost!.chargedTokens).toBe(lost!.reservedTokens);
      expect(sessionOf(run.end, 'lead')).toEqual(LEAD_SESSION);
    }, ROW_MS);

    it('E2E-1 K3: a process killed right after a memory write keeps one note and does not run the tool again; the next view carries its first result', async () => {
      // When: the child dies right after the guarded write of lead's note and its call's result
      const run = await runProbe('agent.after-note');

      // Then: at the kill the note and the call's outcome are there
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(atKill.agentRows.memory.map((note) => note.text)).toEqual(['lead note']);
      expect(callsOf(atKill, 'lead')).toEqual([['memory_write', 'done']]);
      // One note, one memory_write call; the turn that asked for it is not run again; turn 2 follows its result (AC-02.2)
      expectCommonEnd(run.end, { tasks: WHOLE_TREE, notes: TREE_NOTES });
      expect(callsOf(run.end, 'lead')).toEqual([
        ['memory_write', 'done'],
        ['call_agent', 'done'],
        ['finish', 'done'],
      ]);
      expect(ledgerOf(run.end, 'lead')).toEqual(['settled', 'settled', 'settled']);
      expect(sessionOf(run.end, 'lead')).toEqual(LEAD_SESSION);
    }, ROW_MS);

    it('E2E-1 K4: a process killed after the child task was proposed and before it was recorded continues with the one child task of that call', async () => {
      // When: the child dies after propose of helper's task returned, before lead's call records its id
      const run = await runProbe('agent.after-propose');

      // Then: at the kill the call is `starting` without a child id, and helper's task exists
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(atKill.agentRows.toolCalls.filter((call) => call.toolName === 'call_agent').map((call) => [call.state, call.childTaskId])).toEqual([
        ['starting', null],
      ]);
      expect(atKill.tasks.map(agentOf)).toEqual(['lead', 'helper']);
      // One task of helper for the call, recorded on it; helper finished and lead got its result (AC-05.4)
      expectCommonEnd(run.end, { tasks: WHOLE_TREE, notes: TREE_NOTES });
      const [callAgent] = run.end.agentRows.toolCalls.filter((call) => call.toolName === 'call_agent' && call.runTaskId === taskOf(run.end, 'lead').taskId);
      expect([callAgent!.state, callAgent!.childTaskId, callAgent!.outcome]).toEqual([
        'done',
        taskOf(run.end, 'helper').taskId,
        { outcome: 'success', result: { summary: 'helper done', refs: [] } },
      ]);
      expect(run.end.agentRows.runs.map((row) => row.agentName)).toEqual(['lead', 'helper', 'recorder']);
    }, ROW_MS);

    it('E2E-1 K5: as K4 with the child already failed, the parent receives child_failed and no second child task is created', async () => {
      // When: helper's model is unavailable, helper's task fails while lead's call has not recorded its id, then the child dies
      const run = await runProbe('agent.after-propose-failed', 'helper-fails');

      // Then: at the kill helper's task is failed and the call `starting`
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(atKill.tasks.map((task) => [agentOf(task), task.status])).toEqual([
        ['lead', 'running'],
        ['helper', 'failed'],
      ]);
      // lead found the failed task by key, proposed no second one and got child_failed(model_unavailable)
      expectCommonEnd(run.end, {
        tasks: [
          ['lead', 'succeeded'],
          ['helper', 'failed'],
        ],
        notes: ['lead note'],
      });
      expect((taskOf(run.end, 'helper').failureReason as { code?: string } | null)?.code).toBe('model_unavailable');
      const [callAgent] = run.end.agentRows.toolCalls.filter((call) => call.toolName === 'call_agent');
      expect([callAgent!.childTaskId, callAgent!.outcome]).toEqual([
        taskOf(run.end, 'helper').taskId,
        { outcome: 'tool_error', reason: 'child_failed', result: { child_failed: 'model_unavailable' } },
      ]);
    }, ROW_MS);

    it('E2E-1 K6: a process killed while the parent waits resumes the child and wakes the parent once with its result', async () => {
      // When: lead waits for helper, helper is in its first model call, and the child dies
      const run = await runProbe('agent.while-waiting');

      // Then: at the kill lead is waiting and helper's call is an open reserve
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(atKill.tasks.map((task) => [agentOf(task), task.status])).toEqual([
        ['lead', 'waiting'],
        ['helper', 'running'],
      ]);
      expect(ledgerOf(atKill, 'helper')).toEqual(['reserved']);
      // helper continued (its lost reserve abandoned), one helper run, lead woken once (one more attempt) with its result
      expectCommonEnd(run.end, { tasks: WHOLE_TREE, notes: TREE_NOTES });
      expect(ledgerOf(run.end, 'helper')).toEqual(['abandoned', 'settled', 'settled']);
      expect(taskOf(run.end, 'lead').attempt).toBe(2);
      expect(sessionOf(run.end, 'lead')).toEqual(LEAD_SESSION);
    }, ROW_MS);

    it('E2E-1 K7: a process killed after the prologue was written does not run the prologue again: one first message', async () => {
      // When: the child dies right after the guarded write of recorder's prologue
      const run = await runProbe('agent.after-prologue');

      // Then: at the kill recorder has its first message and no turn
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(sessionOf(atKill, 'recorder')).toEqual([['prologue', null]]);
      expect(ledgerOf(atKill, 'recorder')).toEqual([]);
      // One prologue message; recorder finished with the closure's result (UC-E11, DC-23)
      expectCommonEnd(run.end, { tasks: WHOLE_TREE, notes: TREE_NOTES });
      expect(sessionOf(run.end, 'recorder')).toEqual([
        ['prologue', null],
        ['model_answer', 1],
        ['tool_result', null],
      ]);
      expect(run.end.agentRows.runs.find((row) => row.agentName === 'recorder')?.result).toEqual({ note: 'recorded', group: 'probe-group-a' });
    }, ROW_MS);

    it('E2E-1 K8: a process killed after the closure was written and before the task ended does not run the closure again: one note, recorder completed with its result', async () => {
      // When: the child dies right after the guarded write of recorder's accepted closure
      const run = await runProbe('agent.after-closure');

      // Then: at the kill the result and the closure's note are written and the task has not ended
      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      const atKill = run.atKill!;
      expect(taskOf(atKill, 'recorder').status).toBe('running');
      expect(atKill.agentRows.memory.map((note) => note.text)).toEqual(['lead note', 'probe closure: accepted']);
      const recorded = { note: 'recorded', group: 'probe-group-a' };
      expect(atKill.agentRows.runs.find((row) => row.agentName === 'recorder')?.result).toEqual(recorded);
      // The closure is not run again: one note; recorder `succeeded` with the result, without a new turn (DC-23)
      expectCommonEnd(run.end, { tasks: WHOLE_TREE, notes: TREE_NOTES });
      expect(ledgerOf(run.end, 'recorder')).toEqual(['settled']);
      expect(run.end.agentRows.runs.find((row) => row.agentName === 'recorder')?.result).toEqual(recorded);
      // helper is woken once, with the result the kill left: one attempt to its wait, one after recorder
      expect(taskOf(run.end, 'helper').attempt).toBe(2);
      const recorderCall = run.end.agentRows.toolCalls.find((call) => call.childTaskId === taskOf(run.end, 'recorder').taskId);
      expect(recorderCall?.outcome).toEqual({ outcome: 'success', result: recorded });
    }, ROW_MS);
  });
});


// ---------------------------------------------------------------------------------------------------------------
// Not observable as an assertion (reported to the caller)
// ---------------------------------------------------------------------------------------------------------------
// - Design wording of UC-E3 lists "до записи ожидания" as the fourth point; that is the K4 point (between `propose` and the write that records the task id), so the four points of the PRD map to K1 (before the call), K2 (after the answer, before the turn is recorded),
//   K3 (after the tool) and K4 (before the wait record). UC-E4 adds K5 and K6.
// - K1 can differ from K2 only by where the kill is placed relative to the reserve; the Design Doc does not say which side "before the model call" means. Chosen here: before the reserve.
// - K5 needs the child to FAIL while its parent's process is still alive and to be killed afterwards; the Design Doc's wording "helper успел провалиться до подъёма" ("before the rise") cannot happen with no worker running. The hook that waits for the failed task row before exiting makes it testable.
