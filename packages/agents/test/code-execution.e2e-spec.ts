// code-execution / code-execution E2E Test - Design Doc: docs/features/code-execution/design-code-execution.md (Test Strategy UC-E7; DC-15)
// PRD: docs/features/code-execution/prd.md v1.8 (AC-10.2, AC-10.6)
// Test Type: End-to-End Test (child-process harness: a real process is killed, a second one continues)
//
// Harness: the child-process technique of `packages/runtime/test/agent-platform-runtime.e2e-spec.ts`. Here the child (`test/support/codeRunChildMain.ts`, run from source through `tsx`, started by
// `test/support/codeRunChild.ts`) is an API-equivalent process with `RuntimeModule` + `createAgents` + the REAL `packages/code-runner` executor, a scripted model and the MCP fixture over real Postgres;
// the test process starts the fixture process (through its own harness, which registers the run's servers at it before the first child starts; the children only read the registry rows), so the
// fixture outlives every killed child, and `FIXTURE_CALL_LOG` is the evidence of what reached a server across all processes. The test kills the child from outside while the fixture holds a call of the script (`holdCall`); a fresh child
// without the hold continues. The test process itself only starts agents and decides requests (`createAgentsHarness` with the runtime workers off). Run with
// `pnpm --filter @agent-os/agents test:e2e`, never in the default `vitest run`.
//
// Why a dead process and not the in-process zombie of agents INT-3 row E: the claim here is about the process pair - the killed API process takes its executor process with it and the second instance never inherits a running script; an in-process zombie leaves the executor alive.
// The step commit boundary itself is runtime E2E-1 and is not repeated.
//
// Budget: E2E 1 of 2 in this part (E2E-2, the executor process boundary, is `packages/code-runner/test/executor-process.e2e-spec.ts`).
//
// AC -> proving test: AC-10.2 (write): row C; AC-10.6 (read, once): rows A, B; DC-15: row B

import { createScriptedModel } from '@agent-os/agents/testing';
import {
  createFixtureFiles,
  type FileLatch,
  type FixtureFaultRule,
  type FixtureFiles,
  fixtureCallsOf,
  holdCall,
  readFixtureLog,
} from '@agent-os/mcp-fixture';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  codeCallRowsOf,
  createAgentsHarness,
  historyLines,
  historyOf,
  testRecord,
  toolCallRowsOf,
  waitFor,
} from './support/agentsHarness';
import {
  type ChildScenario,
  childScenario,
  type CodeRunChild,
  CodeRunChildren,
  codeRunRecord,
  FIRST_NOTE,
  readRun,
  type ScenarioRun,
  TRACE,
  writeRun,
} from './support/codeRunChild';
import { BACKOFFICE_SERVER, LOGS_SERVER } from './support/mcp-servers';
import { newUser } from './support/new-user';

/** The run's servers of the scenario; the test's harness registers them at its fixture process. */
const SERVERS = { logs: LOGS_SERVER, backoffice: BACKOFFICE_SERVER };
const CODE_RUN = codeRunRecord(SERVERS);
const READ_RUN = readRun(SERVERS);
const WRITE_RUN = writeRun(SERVERS);

const TEST_TIMEOUT_MS = 300_000;
/** How long a step may take to reach its point, a lost step included (lease 1 s, reaper 0.2 s). */
const STEP_MS = 60_000;
/** How long an executor may outlive its killed API process (it exits on the end of its stdin). */
const EXECUTOR_EXIT_MS = 10_000;
/** The latch of the held call; released when a test ends, so the fixture answers the call it still holds. */
const HOLD = 'held-call';

/** One test: an owner allowed both servers, the fixture files, the children and the test's own instance. */
interface Scene {
  readonly ownerId: string;
  readonly fixture: FixtureFiles;
  readonly scenario: ChildScenario;
  readonly children: CodeRunChildren;
  /** The test's instance over the same database: starts agents and decides requests, runs no step. */
  readonly control: AgentsHarness;
}

async function openScene(holds: (latch: FileLatch) => FixtureFaultRule[]): Promise<Scene> {
  const ownerId = newUser();
  const fixture = createFixtureFiles('code-run-restart');
  fixture.setFaults(holds(fixture.latch(HOLD)));
  const access = { [ownerId]: [LOGS_SERVER, BACKOFFICE_SERVER] };
  // First: a stale child build fails the test before anything is started.
  const children = new CodeRunChildren();
  const control = await createAgentsHarness({
    model: createScriptedModel(),
    fixture,
    access,
    root: testRecord(CODE_RUN.name, { servers: CODE_RUN.servers }),
    runtimeConfig: { workers: false },
  });
  return { ownerId, fixture, scenario: childScenario(access, SERVERS), children, control };
}

async function closeScene(scene: Scene): Promise<void> {
  try {
    await scene.children.killAll();
  } finally {
    scene.fixture.latch(HOLD).release();
    await scene.control.close();
  }
}

async function startAgent(scene: Scene, run: ScenarioRun): Promise<string> {
  const { agentId } = await scene.control.sessions.start({
    ownerId: scene.ownerId,
    prompt: run.task,
    description: run.description,
  });
  return agentId;
}

/** The agent's one `run_code` call row. */
async function runOf(scene: Scene, agentId: string) {
  const [run] = await waitFor(
    () => toolCallRowsOf(scene.control.db, agentId),
    (rows) => rows.length === 1,
    `the run_code call of agent ${agentId}`,
  );
  return run;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kills the API process while the fixture holds call `count` of `tool` from the agent's script, and
 * waits until every executor process the child started for the run has exited with it. Resolves their pids.
 */
async function killDuringCall(
  scene: Scene,
  child: CodeRunChild,
  agentId: string,
  call: { readonly tool: string; readonly count: number },
): Promise<number[]> {
  await child.until(async () => fixtureCallsOf(scene.fixture.callLog, { tool: call.tool }).length === call.count, {
    what: `call ${call.count} of ${call.tool} on the server`,
    timeoutMs: STEP_MS,
  });
  const { callId } = await runOf(scene, agentId);
  await child.until(async () => child.executorPids(callId).length > 0, {
    what: 'the executor start of the run in its log',
    timeoutMs: STEP_MS,
  });
  const pids = child.executorPids(callId);

  await child.kill();

  await waitFor(
    () => pids.filter(isAlive),
    (alive) => alive.length === 0,
    `executor processes ${pids.join(', ')} to exit with their API process`,
    EXECUTOR_EXIT_MS,
  );
  return pids;
}

/** Waits until the agent reported after its run, while `child` lives. */
async function untilReported(scene: Scene, child: CodeRunChild, agentId: string, run: ScenarioRun): Promise<void> {
  await child.until(
    async () =>
      historyLines(await historyOf(scene.control, agentId, scene.ownerId)).includes(`model_answer: ${run.report} []`),
    { what: `the report of agent ${agentId}`, timeoutMs: STEP_MS },
  );
}

/** What reached the servers, in order: `<tool> <fault mode or "answered">`. */
function journalLines(scene: Scene): string[] {
  return readFixtureLog(scene.fixture.callLog).map((entry) => `${entry.tool} ${entry.mode ?? 'answered'}`);
}

/** The run's row: `<tool> <outcome> attempts <n> <result text or ->`. */
async function runLine(scene: Scene, agentId: string): Promise<string> {
  const run = await runOf(scene, agentId);
  return `${run.tool} ${run.outcome ?? 'open'} attempts ${run.attempts} ${run.resultText ?? '-'}`;
}

/** The audit rows of the script's calls: `<attempt>/<seq> <server>/<tool> <outcome>`. */
async function codeCallLines(scene: Scene, agentId: string): Promise<string[]> {
  const { callId } = await runOf(scene, agentId);
  const rows = await codeCallRowsOf(scene.control.db, agentId, callId);
  return rows.map((row) => `${row.attempt}/${row.seq} ${row.server ?? '-'}/${row.tool} ${row.outcome ?? 'open'}`);
}

function historyOfRun(run: ScenarioRun, resultLine: string): string[] {
  return [`task: ${run.task}`, 'model_answer:  [run_code]', resultLine, `model_answer: ${run.report} []`];
}

describe('E2E-1: a server restart in the middle of a run (killed process, second instance)', () => {
  // User Journey: the employee's agent is running a script that calls tools; the server dies mid-run and is started again
  // AC-10.6: "Given идёт запуск `read`, when сервер останавливают и запускают снова, then платформа исполняет этот запуск заново ровно один раз: в логе запуска видно одно повторное исполнение, а агент получает его итог или ошибку, как от обычного запуска."
  // AC-10.2: "Given идёт запуск `write`, when сервер останавливают и запускают снова, then запуск сам не повторяется, а агент получает результат «исход неизвестен: запуск прерван рестартом»."
  // Design DC-15: "Читающий запуск, потерянный рестартом второй раз, третий раз не исполняется: вызов закрыт ошибкой «the run was interrupted by a restart twice»."
  // Verification: rows - A a read run killed during a from-code call; B the same run killed a second time; C a confirmed write run killed after its first from-code call
  // Behavior: process killed at the point -> a second instance continues -> A: the read script runs once more, exactly once, the log has one "повторное исполнение" record and the agent gets the result; B: the error "the run was interrupted by a restart twice" and no third execution;
  //   C: the result "исход неизвестен", and the fixture journal holds no more calls than before the restart (the script is not run again)
  // Catches: a restart that repeats a mutating script (a note created twice), or one that loses a read run for good, or a read run that a crash loop re-executes forever
  // @category: e2e
  // @dependency: full-system (two OS processes, Postgres, runtime, agents, code-runner executor, MCP fixture)
  // @complexity: high
  it(
    'E2E-1 row A: AC-10.6 a read run killed mid-call is executed once more, exactly once, and the agent gets its result',
    async () => {
      // Given: the fixture holds the first get_trace of the script; the first API process runs the read run
      const scene = await openScene((latch) => [holdCall('get_trace', TRACE, latch)]);
      try {
        const first = await scene.children.start(scene.scenario);
        const agentId = await startAgent(scene, READ_RUN);

        // When: the API process dies while the call is held, and a second one starts
        const killedExecutors = await killDuringCall(scene, first, agentId, { tool: 'get_trace', count: 1 });
        const second = await scene.children.start(scene.scenario);
        await untilReported(scene, second, agentId, READ_RUN);
        await second.stop();

        // Then: the killed process took its one executor with it; the second ran the script once more, in one executor
        const { callId } = await runOf(scene, agentId);
        expect(killedExecutors).toHaveLength(1);
        expect(second.executorPids(callId)).toHaveLength(1);
        expect(journalLines(scene)).toEqual(['get_trace wait_for_file', 'get_trace answered']);

        // Then: one re-execution record in the run's log (attempt 2); the call of attempt 1 is interrupted, attempt 2 succeeded
        expect(
          second.runLogs(callId, 'code run re-executed after a lost step').map((record) => record.fields.attempt),
        ).toEqual([2]);
        expect(await codeCallLines(scene, agentId)).toEqual([
          `1/1 ${LOGS_SERVER}/get_trace interrupted`,
          `2/1 ${LOGS_SERVER}/get_trace success`,
        ]);

        // Then: the agent got the script's result as from an ordinary run and reported
        expect(await runLine(scene, agentId)).toBe('run_code success attempts 2 trace read');
        expect(historyLines(await historyOf(scene.control, agentId, scene.ownerId))).toEqual(
          historyOfRun(READ_RUN, 'tool_result: run_code success'),
        );
      } finally {
        await closeScene(scene);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'E2E-1 row B: DC-15 a read run killed twice ends with "the run was interrupted by a restart twice" and is not executed a third time',
    async () => {
      // Given: the fixture holds the first two get_trace calls; the first API process runs the read run
      const scene = await openScene((latch) => [holdCall('get_trace', TRACE, latch, [1, 2])]);
      try {
        const first = await scene.children.start(scene.scenario);
        const agentId = await startAgent(scene, READ_RUN);

        // When: the API process dies during attempt 1, the second one during attempt 2, and a third starts
        await killDuringCall(scene, first, agentId, { tool: 'get_trace', count: 1 });
        const second = await scene.children.start(scene.scenario);
        await killDuringCall(scene, second, agentId, { tool: 'get_trace', count: 2 });
        const third = await scene.children.start(scene.scenario);
        await untilReported(scene, third, agentId, READ_RUN);
        await third.stop();

        // Then: the third process started no executor for the run and nothing more reached the server
        const { callId } = await runOf(scene, agentId);
        expect(third.executorPids(callId)).toEqual([]);
        expect(third.runLogs(callId, 'code run not started: it was lost to a restart twice')).toHaveLength(1);
        expect(journalLines(scene)).toEqual(['get_trace wait_for_file', 'get_trace wait_for_file']);

        // Then: both attempts' calls are interrupted, attempts stays 2, and the agent got the error and reported
        expect(await codeCallLines(scene, agentId)).toEqual([
          `1/1 ${LOGS_SERVER}/get_trace interrupted`,
          `2/1 ${LOGS_SERVER}/get_trace interrupted`,
        ]);
        expect(await runLine(scene, agentId)).toBe('run_code tool_error attempts 2 the run was interrupted by a restart twice');
        expect(historyLines(await historyOf(scene.control, agentId, scene.ownerId))).toEqual(
          historyOfRun(READ_RUN, 'tool_result: run_code tool_error'),
        );
      } finally {
        await closeScene(scene);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'E2E-1 row C: AC-10.2 a confirmed write run killed after its first call ends "исход неизвестен" and the server journal grows by no further call',
    async () => {
      // Given: the fixture holds the first note of the script; the employee approves the write run
      const scene = await openScene((latch) => [holdCall('create_incident_note', FIRST_NOTE, latch)]);
      try {
        const first = await scene.children.start(scene.scenario);
        const agentId = await startAgent(scene, WRITE_RUN);
        const openRequests = async () =>
          (await scene.control.sessions.confirmations(agentId, scene.ownerId)).filter(
            (request) => request.status === 'open',
          );
        await first.until(async () => (await openRequests()).length === 1, {
          what: 'the confirmation request of the write run',
          timeoutMs: STEP_MS,
        });
        const [request] = await openRequests();
        expect(
          await scene.control.sessions.resolveConfirmation({
            decisionId: request.decisionId,
            ownerId: scene.ownerId,
            approve: true,
          }),
        ).toBe('resolved');

        // When: the API process dies while its first note is held on the server, and a second one starts
        const killedExecutors = await killDuringCall(scene, first, agentId, { tool: 'create_incident_note', count: 1 });
        const journalBeforeRestart = journalLines(scene);
        const second = await scene.children.start(scene.scenario);
        await untilReported(scene, second, agentId, WRITE_RUN);
        await second.stop();

        // Then: the script ran in one executor of the killed process and was not run again: the journal did not grow
        const { callId } = await runOf(scene, agentId);
        expect(killedExecutors).toHaveLength(1);
        expect(second.executorPids(callId)).toEqual([]);
        expect(journalBeforeRestart).toEqual(['create_incident_note wait_for_file']);
        expect(journalLines(scene)).toEqual(journalBeforeRestart);

        // Then: the run and its sent call end "исход неизвестен"; a write run counts no attempts
        expect(await codeCallLines(scene, agentId)).toEqual([`1/1 ${BACKOFFICE_SERVER}/create_incident_note unknown`]);
        expect(await runLine(scene, agentId)).toBe('run_code unknown attempts 0 -');
        expect(historyLines(await historyOf(scene.control, agentId, scene.ownerId))).toEqual(
          historyOfRun(WRITE_RUN, 'tool_result: run_code unknown'),
        );
      } finally {
        await closeScene(scene);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
