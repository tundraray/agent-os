// agent-quality / lifecycle E2E Test Skeletons (engine process) - Design Doc: docs/features/agent-quality/design-lifecycle.md
// PRD: docs/features/agent-quality/prd.md (FR-19; the non-functional requirement "restart loses and duplicates no work"). Verification Strategy of the runtime: kill matrix (design-runtime.md).
// Generated: 2026-11-06 | Part: lifecycle | Test type: End-to-End (compiled engine child process + real Postgres, scripted model), CI job `e2e-engine`
// Implementation timing: after the closure slice (`engine.lifecycle`) lands - final phase only.
//
// Counterpart in-process file: agent-quality-lifecycle.int.e2e-spec.ts (INT-3 proves the rule of the closure; this file proves that the closure survives a real process death).
//
// File name and placement follow `deep-research-engine.e2e-spec.ts`: `packages/engine/test/*.e2e-spec.ts`, `pnpm --filter @agent-os/engine test:e2e` (builds the packages and the child first).
//
// Environment:
// - Postgres 16 from infra/docker-compose.yml. The compiled engine child (`pnpm build && pnpm build:child`, test/support/engineChild.ts, `runScenario`) with `RUNTIME_CRASH_AT=<point>[:n]` (ignored when
//   NODE_ENV=production), short lease, heartbeat and reaper, `RUNTIME_WORKERS=on`. No new crash point is needed: both points below are in the runtime's existing closed list
//   (`dispatch.after-terminal`: the controller's result and its events are committed, nothing is delivered; `relay.before-done`: inside the delivery transaction that closes the investigation).
// - The only double is the model boundary (the role-aware scripted program behind `resolveModel`); no network, no API key. The child's scenario reads one page of the MCP fixture process, as in
//   deep-research E2E-2 (`runScenario` starts it).
// - Isolation: a unique `resourceId` per row (`runScenario` creates its own user, thread and launch key); the file runs with `fileParallelism: false`.
// - No latency assertions: "within the target" for recovery is the harness timeout of the wait for the end state.
//
// Budget: this file holds E2E-1 of the part's E2E limit (1 of 2). The second slot is left unused on purpose: a second real process death (a server holding the thread lock or a run mark) would prove only
// Postgres' own release of a dead connection's advisory lock and the lease arithmetic that apps/api INT-2 M5/M6 already prove in process.
//
// Proven elsewhere (not in this file):
// - "the answer stands in the thread exactly once" across a restart: apps/api `deep-research-chat-entry.e2e-spec.ts` E2E-1 K2 (the append is idempotent by message id); this file asserts the engine side only.
// - the closure rule itself (status per controller outcome, cancel of unfinished tasks, no second close): INT-3.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRASH_EXIT_CODE, endStateOf, type RunRows, runScenario, type ScenarioRun } from './support/engineChild.js';
import { closeEngineDb } from './support/engineDb.js';

describe('agent-quality / lifecycle - E2E (compiled engine child, real Postgres, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Exactly one closure when the process dies between the controller's result and the delivery of its event
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: a research is running with a controller and an unfinished worker task; the server dies right after the controller's answer is committed; after the restart the investigation is closed
  // as `completed` once, nothing keeps spending tokens, and no second answer or second event appears.
  // Covers (original statements):
  // AC-19.1: "Given ответ записан в беседу, Then расследование в состоянии «завершено», и после этого в нём не начинается ни один вызов модели."
  // Non-functional constraint (Design Doc "Constraints"): "Рестарт не теряет и не дублирует работу. Закрытие идёт через доставку события, которую runtime повторяет до успеха, а повторное закрытие ничего не меняет."
  // Use case: UC-N1. KD-1. Flow 3 failure handling.
  //
  // Primary failure mode (turns red when): the closure is done outside the delivery transaction or outside the event delivery, so a death after the result leaves the investigation `active` forever with live
  // workers; or a death inside the delivery transaction leaves a half-closed state (status changed, tasks not cancelled) or closes twice (two `InvestigationCompleted` events).
  // Behavior: the child runs the investigation to the controller's result -> the process exits with code 137 at the crash point -> a fresh child over the same database delivers the pending event ->
  //   `engine.lifecycle` closes -> the end state equals the end state of an uninterrupted reference run
  // @category: e2e
  // @dependency: full-system (compiled runtime + engine child, real Postgres, scripted model)
  // @complexity: high
  //
  // Verification items (each row compares its end state with the reference run of `runScenario()` by `endStateOf`, then asserts the literals):
  // - K1 `dispatch.after-terminal` (UC-N1): the child exits with 137 with the controller `succeeded`, its `TaskSucceeded` committed and undelivered, the investigation still `active` at the kill; after the restart
  //   the investigation is `completed` once, every unfinished task is `cancelled` or ended, `research_events` holds one `InvestigationCompleted`, and the answer row is the one written before the kill
  // - K2 `relay.before-done` (UC-N1): the child exits with 137 inside the delivery transaction; the investigation is `active` at the kill (the transaction rolled back whole: no half-closed state); after the
  //   restart the same single closure is observable as in K1
  //
  // The scenario is the child's of deep-research E2E-2 (support/engineChildMain.ts): plan; step 1 `requestAnalysis` (a `source.fetch` and a
  // `research.analyze` task); step 2 `proposeAnswer` (a `research.synthesize` task); the controller succeeds last, after the synthesis wrote
  // the answer. No task is unfinished at the controller's result, so "every unfinished task ends" is observed as "every task ends as in the
  // reference run"; the cancel of a task still queued or running at the closure is INT-3's.
  // Crash passes count over the whole first child, and its fence leaves no foreign task or delivery to it:
  // - `dispatch.after-terminal` follows every committed outcome of an attempt: the controller's two waits, the fetch, the analysis and the
  //   synthesis, then the controller's success - the 6th;
  // - `relay.before-done` follows every applied delivery: `runtime.scheduler` and `engine.lifecycle` of the fetch's, the analysis' and the
  //   synthesis' `TaskSucceeded` (6), then the two of the controller's - the 8th is the closure, after the scheduler's of the same event
  //   (the relay orders the deliveries of one event by descending consumer name; runtime INT-4 order).
  //   The rows at the kill prove which delivery died: the scheduler's is done, the closure's is pending.
  describe('E2E-1', () => {
    let reference: ScenarioRun;

    /** The closure every run ends in: `completed` once, every delivery of the controller's end done. */
    const CLOSED_ONCE = {
      status: 'completed',
      completedEvents: 1,
      controllerEndDeliveries: [
        ['engine.lifecycle', 'done'],
        ['runtime.scheduler', 'done'],
      ],
      pendingDeliveries: 0,
    };

    beforeAll(async () => {
      reference = await runScenario();
      expect(reference.firstExitCode).toBe(0);
      expect(reference.end.closure).toEqual(CLOSED_ONCE);
    }, 120_000);

    afterAll(async () => {
      await closeEngineDb();
    });

    /** What the dead child left: the controller's result and the answer committed, the investigation still open. */
    function expectOpenAtKill(
      atKill: RunRows | undefined,
      controllerEndDeliveries: [string, string][],
      pendingDeliveries: number,
    ) {
      expect(atKill?.tasks.map((task) => [task.workflowType, task.status])).toEqual([
        ['research.controller', 'succeeded'],
        ['source.fetch', 'succeeded'],
        ['research.analyze', 'succeeded'],
        ['research.synthesize', 'succeeded'],
      ]);
      expect(atKill?.rows.run?.answer).toEqual(expect.objectContaining({ outcome: 'inconclusive' }));
      expect(atKill?.closure).toEqual({
        status: 'active',
        completedEvents: 0,
        controllerEndDeliveries,
        pendingDeliveries,
      });
    }

    /**
     * After the restart: closed `completed` once, the end of the reference run, the answer written before the kill, and no model call
     * after it (AC-19.1).
     */
    function expectClosedOnce(run: ScenarioRun) {
      expect(run.end.closure).toEqual(CLOSED_ONCE);
      expect(endStateOf(run.end)).toEqual(endStateOf(reference.end));
      expect([run.end.investigations, run.end.engineRuns]).toEqual([1, 1]);
      expect(run.end.investigationId).toBe(run.atKill?.investigationId);
      expect(run.end.rows.run?.answer).toEqual(run.atKill?.rows.run?.answer);
      expect(run.end.rows.llmCalls).toEqual(run.atKill?.rows.llmCalls);
    }

    it("E2E-1 K1: a kill after the controller's result and before its event is delivered leaves the investigation active at the kill and completed exactly once after the restart", async () => {
      const run = await runScenario({ runtimeCrashAt: 'dispatch.after-terminal:6' });

      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      // The controller's `TaskSucceeded` is committed and reached no consumer.
      expectOpenAtKill(run.atKill, [
        ['engine.lifecycle', 'pending'],
        ['runtime.scheduler', 'pending'],
      ], 2);
      expectClosedOnce(run);
    }, 120_000);

    it('E2E-1 K2: a kill inside the delivery transaction of the closure leaves nothing half-closed and ends in the same single completed state after the restart', async () => {
      const run = await runScenario({ runtimeCrashAt: 'relay.before-done:8' });

      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      // The scheduler's delivery of the same event is done; the closure's rolled back whole, so nothing of it is visible.
      expectOpenAtKill(run.atKill, [
        ['engine.lifecycle', 'pending'],
        ['runtime.scheduler', 'done'],
      ], 1);
      expectClosedOnce(run);
    }, 120_000);
  });
});
