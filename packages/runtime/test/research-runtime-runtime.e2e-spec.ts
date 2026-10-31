// research-runtime / runtime E2E Test Skeletons - Design Doc: docs/features/research-runtime/design-runtime.md
// PRD: docs/features/research-runtime/prd.md. Verification Strategy: "Correctness Proof Method", "Early Verification Point" (kill matrix).
// Generated: 2026-10-31 | Part: runtime | Test type: End-to-End (child processes running the built runtime + real Postgres), CI job `e2e-runtime`
// Implementation timing: after the runtime slices of Flow 1-3 land for the first test (Early Verification Point), the full matrix at part acceptance (final phase only).
// Counterpart in-process file: research-runtime-runtime.int.e2e-spec.ts. The sibling part `mcp-source` owns research-runtime-mcp-source.e2e-spec.ts and its own restart
// scenario with a real MCP source; this file owns the process-death and multi-instance proof of the runtime itself and uses test handlers without MCP.
//
// File name follows the project convention (`*.e2e-spec.ts` under packages/runtime/test, run with `pnpm --filter @agent-os/runtime test:e2e`).
//
// Environment (Design Doc "Test Boundaries", "Verification Strategy"):
// - Postgres 16 from infra/docker-compose.yml. Child-process harness (test/support/runtimeChild.ts): spawns the compiled child (KD-8), which runs the packages' built `dist`
//   with test handlers under unique workflowType, with `RUNTIME_CRASH_AT=<point>[:n]` (ignored when NODE_ENV=production), `RUNTIME_WORKERS=on`, short `RUNTIME_LEASE_MS`, `RUNTIME_REAPER_MS`, `RUNTIME_POLL_MS`; kills by `process.exit(137)` from the crash point.
// - Isolation (project convention, no truncate): unique `resourceId = 'e2e-' + randomUUID()` and unique `workflowType` per row; a row reads only its own investigation.
// - "Within the PRD target" for recovery (AC-08.4, 60 s) is the harness timeout of the wait for the end state; no latency is asserted (latency is the on-demand script UC-N2).
// - No LLM, no network, no MCP.
//
// E2E-1 holds the full kill matrix (early points T3.2, the rest T4.1). E2E-2 (boot against database states) lives with the code it boots: the migration rows in
// packages/db, the start of the api in apps/api.
//
// Budget: E2E 2 of 2. ROI uses the raw skill formula (Business Value x Frequency + Legal x 10 + Defect Detection) / (Create 10 + Execute 20 + Maintain 8 = 38).
// With that formula no E2E test can reach the ">50" threshold the generator spec mentions (maximum 3.2); the sibling part's skeletons note the same. Both are kept because the Design Doc makes
// them gates: the kill matrix is the "first verification target" and the `e2e-runtime` CI job lists migrations (UC-14); nothing at a lower level can prove a real process death, a second real instance,
// or the exit code of a real boot. E2E-2 is the first to drop if the budget has to shrink: its ACs then stay with unit comparison tests plus the CI `db:migrate` step.

import { afterAll, describe, expect, it } from 'vitest';
import {
  type EndState,
  type KillSnapshot,
  runScenario,
  runTwoInstances,
  type TaskEnd,
  TWO_INSTANCE_TASKS,
} from './support/runtimeChild.js';
import { closeRuntimeDb } from './support/runtimeDb.js';

describe('research-runtime / runtime - E2E (real Postgres, child processes)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Exactly-once effects under process death and a second instance (kill matrix)
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: an investigation of three tasks (B depends on A, a subscriber waits on A, C independent) is running when the api process dies at a chosen point; after it is started again
  // (or while a second api instance competes for the same work) the investigation reaches the same end as an uninterrupted run, without double effects.
  // Covers (original statements):
  // AC-08.1: "Given расследование из нескольких задач исполняется, When процесс apps/api принудительно убит после записи событий и до их доставки и затем запущен снова, Then каждое ожидавшее событие доставлено и все задачи достигли тех же конечных состояний, что и в прогоне без сбоя. Намеренное исключение — задача, чей дедлайн истёк до восстановления (AC-19.2)."
  // AC-08.2: "Given тот же сценарий, Then evidence каждой fetch-задачи сохранено ровно один раз, ни одно состояние не перешло дважды, ни один подписчик не уведомлён дважды."
  // AC-08.4: "Given задача была в running в момент сбоя, Then после рестарта она не остаётся в running дольше времени восстановления (раздел Reliability) и исполняется снова; повторный вызов источника допустим, так как инструменты только читают."
  // AC-RT-4: "While работают два экземпляра apps/api с одним обработчиком, каждая готовая задача исполняется одной попыткой за раз, и каждая доставка выполняется до done одним экземпляром."
  // Use cases: UC-11, UC-E4. EARS: When / While. Design flow: Flow 3 (recovery), KD-3 (claim guard, fencing), KD-4 (outbox). Early Verification Point: at least 6 of the 9 points on a 3-task investigation.
  //
  // Primary failure mode (turns red when): a transaction boundary or guard is wrong at exactly one point of the run - an effect committed before its event/delivery (lost event), an event/delivery committed without its effect,
  // a retry that repeats an effect (second evidence, second subscriber mark, second terminal transition), or two instances executing the same task attempt.
  // ROI: 2.1 (raw formula: (10 x 7 + 0 + 10) / 38) | Business Value: 10 (the part's correctness definition) | Frequency: 7 (every restart / deploy) | Legal: false | Defect Detection: 10
  // Behavior: perturbation (process killed at point P, or a second instance) -> end state equals the uninterrupted reference run; each effect counted once
  // @category: e2e
  // @dependency: full-system (AppModule, RuntimeLifecycle, Dispatcher, OutboxRelay, RecoverySweeper, CrashPoints, Postgres, child process harness)
  // @complexity: high
  //
  // Verification items (table-driven by perturbation; every row first runs, or reuses for the same scenario script, the reference run without perturbation and compares to it):
  // - Reference run: B starts after A succeeded; the scenario's end states are fixed by assertion, not only by comparison (A, B, C `succeeded`; subscriber of A notified once; all deliveries `done`)
  // - Rows by crash point (one child process killed with exit code 137, then a fresh child started without RUNTIME_CRASH_AT):
  //     admission.after-commit | dispatch.after-claim | handler.after-evidence | dispatch.before-terminal |
  //     dispatch.after-terminal (events written, not delivered) | relay.before-done (inside the delivery transaction) | relay.after-done |
  //     reaper.after-requeue (second kill: first death leaves a `running` task, the restarted child dies at the reaper point, the third start finishes) |
  //     cancel.after-commit (scenario script includes a cancel of an unrelated active task; its reference run includes the same cancel)
  // - Row "two instances" (no crash): two children, one HandlerRegistry type, 20 ready tasks -> every task has `attempt` = 1 and a single terminal transition, every delivery reached `done` once
  //   (per-delivery attempts bookkeeping and the subscriber's `notified_event_id` carry exactly one eventId), the work was split across both instances (both claimed at least one task - proves the contention was real).
  //   One executor per task is proven by the claim guard: `from: [queued]` in the guarded claim write and the `status = queued` re-check under the row lock in the claim query. Either guard alone
  //   suffices, so the row turns red only when both are removed. SKIP LOCKED is throughput, not single execution; the on-demand latency script (`test:verify`) covers it, not this row.
  // - After every row: final task statuses and failure classes equal the reference; one evidence per (task, evidenceKey); one terminal transition event per task; `state_version` has no gaps beyond the recovered attempts
  //   (`recovery_count` accounts for the extra TaskQueued(recovered)/TaskStarted); every delivery `done`; the subscriber is marked with exactly one eventId; no task remains `running`
  // - A task `running` at the kill is executed again to its end within the recovery harness timeout (AC-08.4); a repeated handler call is allowed
  // - Exception stated by the AC: the deadline-passed-while-down case is not in this table; it is INT-3 row R4
  describe('E2E-1: killing the api process at each runtime crash point, or running a second instance, ends in the same end state as an uninterrupted run with every effect applied exactly once', () => {
    /** Boot of two children, the wait for the crash and the recovery within the PRD target. */
    const ROW_TIMEOUT_MS = 180_000;

    /** A scenario task that ended `succeeded` with its one evidence, each subscriber notified once. */
    const succeededTask = (
      evidenceKey: string,
      subscribers: string[],
    ): TaskEnd => ({
      status: 'succeeded',
      failureClass: null,
      evidenceKeys: [evidenceKey],
      outputRefsAreEvidence: true,
      queuedOverRecoveries: 1,
      startedOverRecoveries: 1,
      evidenceEvents: 1,
      terminalEvents: 1,
      stateVersionOverRecoveries: 2,
      subscribers: Object.fromEntries(
        subscribers.map((key) => [key, 'terminal event' as const]),
      ),
    });

    /** End of the uninterrupted run; every crash row must end exactly so. */
    const REFERENCE_END: EndState = {
      tasks: {
        A: succeededTask('page-A', ['scenario-A', 'scenario-subscriber']),
        B: succeededTask('page-B', ['scenario-B']),
        C: succeededTask('page-C', ['scenario-C']),
      },
      bStartedAfterASucceeded: true,
      // One `runtime.scheduler` delivery per terminal event, each `done`.
      deliveries: { done: 3 },
    };

    afterAll(async () => {
      await closeRuntimeDb();
    });

    it(
      'reference run: B starts after A succeeded, A, B and C succeed, both subscribers of A are notified once, every delivery is done',
      async () => {
        const run = await runScenario();

        expect(run.firstExitCode).toBe(0);
        expect(run.recoveries).toBe(0);
        expect(run.end).toEqual(REFERENCE_END);
      },
      ROW_TIMEOUT_MS,
    );

    /**
     * Early points (available after Flow 3, without cancel). `atKill` proves the child died where
     * the row says: what the dead process left behind, before the restart touches anything.
     */
    const EARLY_POINTS: {
      point: string;
      /** A task was `running` at the kill: the reaper must take it back (AC-08.4). */
      leftRunning: boolean;
      atKill: (state: KillSnapshot) => void;
    }[] = [
      {
        point: 'admission.after-commit',
        leftRunning: false,
        atKill: (state) =>
          expect(state).toMatchObject({ tasks: 1, started: 0, evidence: 0 }),
      },
      {
        point: 'dispatch.after-claim',
        leftRunning: true,
        atKill: (state) => {
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state).toMatchObject({ evidence: 0, terminal: 0 });
        },
      },
      {
        point: 'handler.after-evidence',
        leftRunning: true,
        atKill: (state) => {
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state.evidence).toBeGreaterThanOrEqual(1);
          expect(state.terminal).toBe(0);
        },
      },
      {
        point: 'dispatch.before-terminal',
        leftRunning: true,
        atKill: (state) => {
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state.evidence).toBeGreaterThanOrEqual(1);
          expect(state.terminal).toBe(0);
        },
      },
      {
        // Events written, not delivered.
        point: 'dispatch.after-terminal',
        leftRunning: false,
        atKill: (state) => {
          expect(state.terminal).toBeGreaterThanOrEqual(1);
          expect(state.pendingDeliveries).toBeGreaterThanOrEqual(1);
        },
      },
      {
        // Inside the delivery transaction: its writes roll back with the process.
        point: 'relay.before-done',
        leftRunning: false,
        atKill: (state) => {
          expect(state.pendingDeliveries).toBeGreaterThanOrEqual(1);
          expect(state.doneDeliveries).toBe(0);
        },
      },
    ];

    it.each(EARLY_POINTS)(
      'crash at $point: the child exits 137 there, and a fresh child ends the investigation as the reference run',
      async ({ point, leftRunning, atKill }) => {
        const run = await runScenario({ crashAt: point });

        expect(run.firstExitCode).toBe(137);
        if (!run.atKill) throw new Error('A crash run has a kill snapshot');
        atKill(run.atKill);
        if (leftRunning) expect(run.recoveries).toBeGreaterThanOrEqual(1);
        expect(run.end).toEqual(REFERENCE_END);
      },
      ROW_TIMEOUT_MS,
    );

    /**
     * The other passes of every point, up to the full matrix of PRD metric 2 (point x pass): a
     * point is passed once per task (claim, evidence, outcome, its delivery) and once per
     * proposal (A, the second subscriber of A, B, C), so the dying child of the scenario reaches
     * each pass listed here. `atKill` proves the death came at that pass.
     */
    const LATER_PASSES: {
      point: string;
      passes: number[];
      leftRunning: boolean;
      atKill: (state: KillSnapshot, pass: number) => void;
    }[] = [
      {
        // Passes: A, the second subscriber of A (no new task), B, C; handlers wait for all four.
        point: 'admission.after-commit',
        passes: [2, 3, 4],
        leftRunning: false,
        atKill: (state, pass) =>
          expect(state).toMatchObject({
            tasks: [1, 1, 2, 3][pass - 1],
            evidence: 0,
            terminal: 0,
          }),
      },
      {
        point: 'dispatch.after-claim',
        passes: [2, 3],
        leftRunning: true,
        atKill: (state, pass) => {
          expect(state.started).toBeGreaterThanOrEqual(pass);
          expect(state.running).toBeGreaterThanOrEqual(1);
        },
      },
      {
        point: 'handler.after-evidence',
        passes: [2, 3],
        leftRunning: true,
        atKill: (state, pass) => {
          expect(state.evidence).toBeGreaterThanOrEqual(pass);
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state.terminal).toBeLessThanOrEqual(pass - 1);
        },
      },
      {
        point: 'dispatch.before-terminal',
        passes: [2, 3],
        leftRunning: true,
        atKill: (state, pass) => {
          expect(state.evidence).toBeGreaterThanOrEqual(pass);
          expect(state.running).toBeGreaterThanOrEqual(1);
          expect(state.terminal).toBeLessThanOrEqual(pass - 1);
        },
      },
      {
        point: 'dispatch.after-terminal',
        passes: [2, 3],
        leftRunning: false,
        atKill: (state, pass) => {
          expect(state.terminal).toBeGreaterThanOrEqual(pass);
          expect(state.pendingDeliveries).toBeGreaterThanOrEqual(1);
        },
      },
      {
        // One relay delivers one at a time: the earlier deliveries are done, this one rolled back.
        point: 'relay.before-done',
        passes: [2, 3],
        leftRunning: false,
        atKill: (state, pass) => {
          expect(state.doneDeliveries).toBe(pass - 1);
          expect(state.pendingDeliveries).toBeGreaterThanOrEqual(1);
        },
      },
      {
        // After the delivery's commit: it is done and must not be applied again.
        point: 'relay.after-done',
        passes: [1, 2, 3],
        leftRunning: false,
        atKill: (state, pass) => expect(state.doneDeliveries).toBe(pass),
      },
    ];

    it.each(
      LATER_PASSES.flatMap(({ point, passes, ...row }) =>
        passes.map((pass) => ({ crashAt: `${point}:${pass}`, pass, ...row })),
      ),
    )(
      'crash at $crashAt: the child exits 137 there, and a fresh child ends the investigation as the reference run',
      async ({ crashAt, pass, leftRunning, atKill }) => {
        const run = await runScenario({ crashAt });

        expect(run.firstExitCode).toBe(137);
        if (!run.atKill) throw new Error('A crash run has a kill snapshot');
        atKill(run.atKill, pass);
        if (leftRunning) expect(run.recoveries).toBeGreaterThanOrEqual(1);
        expect(run.end).toEqual(REFERENCE_END);
      },
      ROW_TIMEOUT_MS,
    );

    it(
      'crash at reaper.after-requeue: the first child dies with a running task, the restarted child dies right after its reaper requeued it, a third child ends the investigation as the reference run',
      async () => {
        const run = await runScenario({
          crashAt: 'dispatch.after-claim',
          thenCrashAt: 'reaper.after-requeue',
        });

        expect(run.firstExitCode).toBe(137);
        expect(run.atKill?.recovered).toBe(0);
        expect(run.atKill?.running).toBeGreaterThanOrEqual(1);
        expect(run.restartExitCode).toBe(137);
        // The requeue committed before the second death.
        expect(run.atRestartKill?.recovered).toBeGreaterThanOrEqual(1);
        expect(run.end).toEqual(REFERENCE_END);
      },
      // Three children in a row: a hang reports the child's output before vitest's timeout does.
      3 * ROW_TIMEOUT_MS,
    );

    /** End of the unrelated investigation the cancel scenario cancels while its one task runs. */
    const CANCELLED_END = {
      investigationStatus: 'cancelled',
      end: {
        tasks: {
          D: {
            status: 'cancelled',
            failureClass: 'cancelled',
            evidenceKeys: [],
            outputRefsAreEvidence: true,
            queuedOverRecoveries: 1,
            startedOverRecoveries: 1,
            evidenceEvents: 0,
            terminalEvents: 1,
            // Claim, cancel request, cancelled outcome.
            stateVersionOverRecoveries: 3,
            subscribers: { 'scenario-D': 'terminal event' },
          },
        },
        bStartedAfterASucceeded: false,
        // The `TaskCancelled` delivery.
        deliveries: { done: 1 },
      },
    };

    it(
      'crash at cancel.after-commit: the scenario cancels an unrelated investigation whose task is running, as its reference run does, and a fresh child ends both investigations as that reference run',
      async () => {
        const reference = await runScenario({ cancel: true });
        expect(reference.firstExitCode).toBe(0);
        expect(reference.end).toEqual(REFERENCE_END);
        expect(reference.cancelled).toEqual(CANCELLED_END);

        const run = await runScenario({
          cancel: true,
          crashAt: 'cancel.after-commit',
        });

        expect(run.firstExitCode).toBe(137);
        // The cancel request committed, its outcome did not: D was still running, cancel requested.
        expect(run.cancelledAtKill).toEqual({
          status: 'running',
          cancelRequested: true,
        });
        expect(run.end).toEqual(REFERENCE_END);
        expect(run.cancelled).toEqual(CANCELLED_END);
      },
      2 * ROW_TIMEOUT_MS,
    );

    it(
      `two instances: ${TWO_INSTANCE_TASKS} ready tasks of one handler type, each executed by one attempt of one instance, every delivery done once, both instances executed work`,
      async () => {
        const steps = Array.from(
          { length: TWO_INSTANCE_TASKS },
          (_, index) => `T${String(index + 1).padStart(2, '0')}`,
        );
        const perStep = <T>(value: (step: string) => T) =>
          Object.fromEntries(steps.map((step) => [step, value(step)]));

        const run = await runTwoInstances();

        expect(run.exitCodes).toEqual([0, 0]);
        expect(run.end.tasks).toEqual(
          perStep((step) =>
            succeededTask(`page-${step}`, [`scenario-${step}`]),
          ),
        );
        expect(run.attempts).toEqual(perStep(() => 1));
        expect(run.handlerCalls).toEqual(perStep(() => 1));
        // One delivery per terminal event, done by its first attempt.
        expect(run.deliveryAttempts).toEqual({ 'done/1': TWO_INSTANCE_TASKS });
        // The contention was real: each instance executed work.
        expect(Math.min(...run.callsPerInstance)).toBeGreaterThanOrEqual(1);
      },
      ROW_TIMEOUT_MS,
    );
  });
});
