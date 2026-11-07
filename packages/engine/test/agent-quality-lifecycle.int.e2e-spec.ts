// agent-quality / lifecycle Integration Test Skeletons (engine side) - Design Doc: docs/features/agent-quality/design-lifecycle.md
// PRD: docs/features/agent-quality/prd.md (FR-19, and the reserve refusal of FR-21). ADRs: ADR-0001 (runtime owner), ADR-0003 (Drizzle data layer), ADR-0004 (engine package), ADR-0005 (process config is data only).
// Generated: 2026-11-06 | Part: lifecycle | Test type: Integration (in-process runtime + engine + real Postgres, scripted model), CI job `e2e-engine`
// Implementation timing: created alongside the slices each row names (`InvestigationService.closeInTx` + `engine.lifecycle`; `withAttemptGuard` mode `requireActive` + the `stopping` reserve in the model gateway).
//
// File name and placement. Same package, same harness and same config as `deep-research-engine.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; run with `pnpm --filter @agent-os/engine test:e2e`,
// never in the default `vitest run`). The test is here, not in packages/runtime, because the closure consumer is registered by `createEngine`, and the reserve is the engine's `createModelGateway` over the runtime's
// `postgresCallLedger` and `withAttemptGuard`: a runtime-only test would need fake copies of both. The runtime operations `closeInTx` and the `requireActive` mode are therefore proven through the real consumer
// and the real gateway (no separate runtime test of them).
//
// Environment (as the sibling engine file):
// - Postgres 16 from infra/docker-compose.yml, migrations applied once (the new statuses `completed`, `failed` included). Real `createRuntime` and `createEngine` (with `runtime.eventConsumers`, which the harness
//   passes now); the model double is the scripted language model keyed by role; `TokenCounter` is the deterministic double; the counting source adapter is the only source.
// - A second runtime WITHOUT workers over the same database (`createEngineHarness({ runtime: { workers: false } })` in the same file) stands for "another instance": its `InvestigationService.cancel` cannot abort
//   an attempt of the first runtime in process, so the attempt learns of it only from the database (heartbeat) and from the reserve. `handlerHold.at` holds an attempt at `run` or `guarded`, which is how a
//   task "has not yet started its call" while the closure commits.
// - Isolation (project convention, no truncate): unique `resourceId` and `launchKey` per test (`new-user.ts`); the file runs with `fileParallelism: false`; `cancelStarted()` in afterEach.
// - Time: clock and lease are the injected ones (`expireLease`, `engineClock`); no sleeps for ordering. The heartbeat pulse that carries a cancel request to another instance is waited for as an end state with the
//   harness timeout, no latency is asserted.
//
// Budget: this file holds INT-3 of the part's 5 integration tests (see apps/api/test/agent-quality-lifecycle.int.e2e-spec.ts for the whole budget). INT-3 is one of the three core tests.
//
// Proven elsewhere (not in this file):
// - the api side of the closure (the card shows "Завершён"/"Не удалось"; the answer is written only for a `completed` investigation, DC-2): unit `research-answer.appender.spec.ts` and the existing chat-entry
//   delivery tests, run with an engine double that closes like `engine.lifecycle` (see the harness note of the api file).
// - the mapping closed status -> `InvestigationView.status` (`completed`/`failed`/`cancelled`, `deleting` shown as `cancelled`): unit table in `packages/engine/src/view/investigation-view.spec.ts`.
// - a kill between the controller's result and the closure: packages/engine/test/agent-quality-lifecycle.e2e-spec.ts (E2E-1).
// - cancel with a call in flight inside ONE process (abort by signal, the reservation stays `reserved`, counted in `tokensReserved`): existing `deep-research-engine.int.e2e-spec.ts` INT-2 L5, unchanged by this part.
// - a forced stop (budget below the next call) writes a code-built answer with `budget_exhausted` and ends the controller `succeeded`: existing `deep-research-engine.int.e2e-spec.ts` INT-2 L2 (was C3 here).

import { type EventEnvelope, EventEnvelopeSchema } from '@agent-os/contracts';
import { researchEventDeliveries, researchEvents, researchInvestigations } from '@agent-os/db';
import type { InvestigationView, StartInvestigationResult, TokenCountRequest } from '@agent-os/engine';
import { type CancelTimer, type Clock, systemClock } from '@agent-os/runtime';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeEngineDb, engineRowsOf, llmTranscriptsOf, rowVersionsOf, tasksOf } from './support/engineDb.js';
import { createEngineHarness, type EngineHarness } from './support/engineHarness.js';
import { newLaunchKey, newUser } from './support/new-user.js';

/** A gate a test opens once; waiting on an open gate goes on at once. */
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

/** A count of the worker's packet (its output schema asks for claims). */
function isWorkerRequest(request: TokenCountRequest): boolean {
  const properties = (request.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return 'claims' in properties;
}

/**
 * The harness clock with the heartbeat parked while `pause()` holds: a timer of exactly `heartbeatMs` (only the
 * dispatcher's heartbeat asks for one) fires when it is due and the gate is open, or at `resume()`. A cancelled timer
 * never fires. So a test decides when the next pulse of an instance comes, with no sleep.
 */
function heartbeatGate(base: Clock, heartbeatMs: number) {
  let paused = false;
  const parked: (() => void)[] = [];
  const clock: Clock = {
    now: () => base.now(),
    random: () => base.random(),
    setTimer: (ms, callback): CancelTimer => {
      if (ms !== heartbeatMs) return base.setTimer(ms, callback);
      let cancelled = false;
      const fire = () => {
        if (!cancelled) callback();
      };
      const cancelBase = base.setTimer(ms, () => {
        if (paused) parked.push(fire);
        else fire();
      });
      return () => {
        cancelled = true;
        cancelBase();
      };
    },
  };
  return {
    clock,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      parked.splice(0).forEach((fire) => fire());
    },
  };
}

const ANALYZE = 'research.analyze';
const subquestion = (service: string) => ({
  text: `what did ${service} log?`,
  sourceId: 'fixture',
  toolName: 'search_logs',
  args: { service },
  completeness: 'all',
});

describe('agent-quality / lifecycle - engine integration (real Postgres, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  A finished investigation is closed once and nothing starts a model call in a closed or stopped one
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-19.1: "Given ответ записан в беседу, Then расследование в состоянии «завершено», и после этого в нём не начинается ни один вызов модели."
  // AC-19.2: "Given расследование не удалось, Then оно в состоянии «не удалось», а его незаконченные задачи отменены."
  // AC-21.1 (the model half): "...новые вызовы модели не начинаются."
  // DC-1 (FR-19): "Когда задача controller завершилась успешно, расследование становится `completed`, когда провалилась — `failed`; тем же действием все его незаконченные задачи отменяются."
  // DC-3 (FR-19): "После закрытия или остановки расследования ни одна его задача не начинает новый вызов модели ни на одном экземпляре: резерв вызова отказывает."
  // DC-4 (FR-19): "Ответ, собранный при принудительной остановке — бюджет, недоступная модель, предел шагов, — ведёт к «Завершён», а не к «Не удалось»."
  // Use cases: UC-1, UC-2, UC-3. KD-1, KD-2. Flow 3. Invariants 1, 2, 3.
  //
  // Primary failure mode (turns red when): a succeeded controller leaves the investigation `active` (its workers go on spending tokens); a failed controller cancels nothing; a code-built answer from a forced stop is
  // closed as `failed`; a task of another instance starts a model call after the closure or after a cancel (a ledger row or a transcript appears, tokens are charged); a refused reserve leaves a row behind; the
  // closure overrides an earlier stop (`cancelled` becomes `completed`) or is applied twice (two events); the closing of a reservation after a cancel request is refused too (the ledger sum stops matching).
  // Behavior: the controller task ends (`TaskSucceeded` / `TaskFailed`) -> `engine.lifecycle` finds the investigation by `research_engine_runs` and calls `closeInTx` in the delivery transaction -> status
  //   `completed` / `failed`, waiting tasks `cancelled`, running tasks get a cancel request, event `InvestigationCompleted` / `InvestigationFailed` -> a task asking for a reserve gets `stopping` -> the gateway
  //   answers `no_answer` with reason `cancelled` -> no call, no `research_llm_calls` row, no transcript
  // @category: core-functionality
  // @dependency: engine.lifecycle consumer, InvestigationService.closeInTx / cancel, TaskContext.withAttemptGuard (requireActive), postgresCallLedger.reserve, createModelGateway, OutboxRelay, Postgres
  // @complexity: high
  //
  // Verification items (table; every row asserts on `research_investigations`, `research_tasks`, `research_events`, `research_llm_calls` and the model double's recorded calls, with literal expected values):
  // - C1 success closes before anything more is spent (UC-1, AC-19.1, DC-1, DC-3): the controller decides `proposeAnswer` while a worker task is held at `run` (it has not started its model call); the controller
  //   writes its answer and ends -> the investigation is `completed` (not `active`), `InvestigationView.status` is `completed`, the worker task is `cancelled`; the held worker is released and asks for its reserve ->
  //   the model double got no call for it, `research_llm_calls` has no row and no transcript created after the closure, the charged total is unchanged
  // - C2 failure closes as failed (UC-2, AC-19.2, DC-1): one unstarted (queued or waiting) and one running task, the controller task fails (exhausted recoveries) -> the investigation is `failed`, the
  //   unstarted task `cancelled`, the running task gets a cancel request and ends `cancelled`, `InvestigationFailed` is written once, and no answer exists
  // - C3 a forced stop is "completed" (UC-3, DC-4): dropped from this file - `deep-research-engine.int.e2e-spec.ts` INT-2 L2 already proves that a controller stopped by its budget writes a code-built answer with
  //   `budget_exhausted` and ends `succeeded`, and that succeeded controller closes the investigation as `completed` through the same consumer C1 proves (the other forced reasons end the same way)
  // - C4 a stop on another instance (DC-3, AC-21.1): calls run on the first runtime, the second runtime (no workers) cancels the investigation -> the cancel is committed, and on the first runtime:
  //   (a) a reserve after the stop is `stopping`: no row, no transcript, no call; (b) a call that answered after the stop closes its reservation `settled` under the cancel request; (c) the call still in
  //   flight is aborted at the next pulse, its reservation stays `reserved` (design-engine.md UC-E2) and the ledger sums match (charged rows = `tokensSpent`, the open reservation = `tokensReserved`)
  // - C5 order and repetition (Invariant 1, Flow 3 failure handling): the same `TaskSucceeded` of the controller is delivered a second time -> one `InvestigationCompleted`, nothing else changes (row-version
  //   snapshot); `TaskSucceeded` of a worker task closes nothing; a stop that commits before the controller's event leaves the investigation `cancelled` and writes no `InvestigationCompleted`; a cancel after the
  //   closure leaves `completed`
  describe('INT-3', () => {
    // A lease is lost only when a test moves it back (C2): no heartbeat beats within a test, the sweeper runs every
    // 50 ms, and no recovery is allowed, so the first lost lease fails the task (`recovery_exhausted`). Two slots: with
    // the controller in one, a worker held in the other keeps the second worker unstarted.
    let harness: EngineHarness;

    beforeAll(async () => {
      harness = await createEngineHarness({
        runtime: { concurrency: 2, dbPoolMax: 8, leaseMs: 60_000, heartbeatMs: 60_000, reaperMs: 50, maxRecoveries: 0 },
      });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
    });

    afterEach(async () => {
      try {
        // A step left in the script means the test scripted a call that never happened.
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        harness.handlerHold.at = undefined;
        await harness.cancelStarted();
      }
    });

    const conclude = { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } };

    async function start(query: string) {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const result: StartInvestigationResult = await harness.engine.startInvestigation({
        resourceId,
        threadId,
        query,
        processId: 'deep-research',
        launchKey: newLaunchKey(),
      });
      if (result.outcome === 'rejected') throw new Error(`start refused: ${result.code}`);
      return { resourceId, investigationId: result.investigationId, controllerTaskId: result.controllerTaskId };
    }

    async function view(investigationId: string, resourceId: string): Promise<InvestigationView> {
      const read = await harness.engine.readInvestigation({ investigationId, resourceId });
      if (read.outcome !== 'found') throw new Error(`investigation ${investigationId} not found`);
      return read.view;
    }

    async function investigationStatus(investigationId: string): Promise<string | undefined> {
      const [row] = await harness.db
        .select({ status: researchInvestigations.status })
        .from(researchInvestigations)
        .where(eq(researchInvestigations.investigationId, investigationId));
      return row?.status;
    }

    /** Waits for the investigation row to leave `active` (rule 9: each test waits for its own end state). */
    function closed(investigationId: string): Promise<string> {
      return vi.waitFor(
        async () => {
          const status = await investigationStatus(investigationId);
          if (status === undefined || status === 'active') throw new Error(`investigation ${investigationId} is ${status}`);
          return status;
        },
        { timeout: 20_000, interval: 50 },
      );
    }

    /** The investigation's events, oldest first. */
    function eventsOf(investigationId: string) {
      return harness.db
        .select()
        .from(researchEvents)
        .where(eq(researchEvents.investigationId, investigationId))
        .orderBy(asc(researchEvents.seq));
    }

    /** Types of the events that end the investigation itself, oldest first. */
    const endEventTypesOf = async (investigationId: string) =>
      (await eventsOf(investigationId))
        .map((event) => event.type)
        .filter((type) => ['InvestigationCompleted', 'InvestigationFailed', 'InvestigationCancelled'].includes(type));

    /** The task's ending event as stored. */
    async function taskEventOf(investigationId: string, taskId: string, type: string) {
      const event = (await eventsOf(investigationId)).find((row) => row.taskId === taskId && row.type === type);
      if (event === undefined) throw new Error(`no ${type} of task ${taskId}`);
      return event;
    }

    /** Waits until the relay has applied `engine.lifecycle` to the event. */
    function lifecycleDelivered(eventId: string) {
      return vi.waitFor(
        async () => {
          const [delivery] = await harness.db
            .select()
            .from(researchEventDeliveries)
            .where(and(eq(researchEventDeliveries.eventId, eventId), eq(researchEventDeliveries.consumer, 'engine.lifecycle')));
          if (delivery?.status !== 'done') throw new Error(`engine.lifecycle delivery of ${eventId} is ${delivery?.status}`);
        },
        { timeout: 20_000, interval: 50 },
      );
    }

    /** Waits until no delivery of the investigation's events is pending, and none needs attention. */
    function quiet(investigationId: string) {
      return vi.waitFor(
        async () => {
          const rows = await harness.db
            .select({ status: researchEventDeliveries.status })
            .from(researchEventDeliveries)
            .innerJoin(researchEvents, eq(researchEvents.eventId, researchEventDeliveries.eventId))
            .where(eq(researchEvents.investigationId, investigationId));
          if (rows.some((row) => row.status === 'pending')) throw new Error(`investigation ${investigationId} has pending deliveries`);
          expect(rows.filter((row) => row.status !== 'done')).toEqual([]);
        },
        { timeout: 20_000, interval: 50 },
      );
    }

    /** The stored event as a consumer receives it (as the relay's `toEnvelope` builds it). */
    const envelopeOf = (event: typeof researchEvents.$inferSelect): EventEnvelope =>
      EventEnvelopeSchema.parse({
        eventId: event.eventId,
        type: event.type,
        schemaVersion: event.schemaVersion,
        investigationId: event.investigationId,
        taskId: event.taskId,
        causationId: event.causationId,
        correlationId: event.correlationId,
        stateRevision: event.stateRevision,
        payloadRef: event.payloadRef,
        payload: event.payload,
        createdAt: event.createdAt.toISOString(),
      });

    /**
     * The real `engine.lifecycle` consumer (the one `createEngine` registered) applied to `event` once more, as the
     * relay applies it: in a transaction, in a savepoint.
     */
    async function deliverAgain(event: EventEnvelope): Promise<void> {
      const consumer = harness.runtime.eventConsumers.get('engine.lifecycle');
      if (consumer === undefined) throw new Error('engine.lifecycle is not registered');
      await harness.db.transaction((tx) => tx.transaction((savepoint) => consumer.handle(savepoint, event)));
    }

    // C1: the worker is held at `run` — claimed, its model call not started — while the controller concludes. The
    // closure does not abort an attempt of this process and no heartbeat beats within the test, so the released worker
    // reaches the reservation with its signal intact: only the reserve's `stopping` can keep it from the model.
    it("INT-3 C1: a succeeded controller closes the investigation as completed, cancels its unstarted worker, and that worker's later reserve is refused with no ledger row, no transcript and no model call", async () => {
      const workerHeld = latch();
      const workerGo = latch();
      try {
        harness.model.script(
          'controller',
          { output: { kind: 'requestAnalysis', rationale: 'one service', await: false, subquestions: [subquestion('service-1')] } },
          conclude,
        );
        harness.handlerHold.at = (point) => {
          if (point.at !== 'run' || point.workflowType !== ANALYZE) return;
          workerHeld.open();
          return workerGo.wait;
        };
        const { resourceId, investigationId, controllerTaskId } = await start('C1: why did service-1 slow down?');
        await workerHeld.wait;

        expect(await closed(investigationId)).toBe('completed');
        await lifecycleDelivered((await taskEventOf(investigationId, controllerTaskId, 'TaskSucceeded')).eventId);
        const [worker] = (await tasksOf(investigationId)).filter((task) => task.workflowType === ANALYZE);
        expect(worker).toMatchObject({ status: 'running', attempt: 1 });
        expect(worker!.cancelRequestedAt).toBeInstanceOf(Date);
        const atClosure = await engineRowsOf(investigationId);
        const transcriptsAtClosure = await llmTranscriptsOf(investigationId);
        const workerCountsBefore = harness.tokenCounter.requests.filter(isWorkerRequest).length;

        workerGo.open();
        await vi.waitFor(() => expect(harness.endedRuns).toContainEqual({ taskId: worker!.taskId, attempt: 1 }), {
          timeout: 20_000,
          interval: 50,
        });

        // The worker counted its packet and then the call's input — the gateway's last step before the reservation —
        // and was refused there: no call, no ledger row, no transcript, nothing charged.
        expect(harness.tokenCounter.requests.filter(isWorkerRequest)).toHaveLength(workerCountsBefore + 2);
        expect(harness.model.callsOf('worker')).toEqual([]);
        const afterRelease = await engineRowsOf(investigationId);
        expect(afterRelease.llmCalls).toEqual(atClosure.llmCalls);
        expect(afterRelease.llmCalls.filter((row) => row.taskId === worker!.taskId)).toEqual([]);
        expect(afterRelease.run).toMatchObject({
          tokensSpent: atClosure.run!.tokensSpent,
          tokensReserved: atClosure.run!.tokensReserved,
        });
        expect(await llmTranscriptsOf(investigationId)).toEqual(transcriptsAtClosure);
        // Refused as stopping, not as a lost attempt: the runtime logs no fenced write of the worker.
        expect(harness.logs.runtime.warn.filter(([message]) => message.includes(`taskId=${worker!.taskId}`))).toEqual([]);
        await vi.waitFor(
          async () => {
            const task = (await tasksOf(investigationId)).find((row) => row.taskId === worker!.taskId);
            expect(task).toMatchObject({ status: 'cancelled', failureReason: { class: 'cancelled', code: 'cancel_requested' } });
          },
          { timeout: 20_000, interval: 50 },
        );
        expect(await view(investigationId, resourceId)).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive' } });
        expect(await endEventTypesOf(investigationId)).toEqual(['InvestigationCompleted']);
      } finally {
        workerHeld.open();
        workerGo.open();
      }
    }, 60_000);
    // C2: the skeleton's "waiting" task is the unstarted one — `queued` behind its own analysis slot, which the closure
    // ends `cancelled` exactly as a `waiting` one (both go through the same branch of the cancel).
    it('INT-3 C2: a failed controller closes the investigation as failed, cancels the waiting task, asks the running one to cancel, and no answer exists', async () => {
      const controllerGo = latch();
      const workerGo = latch();
      try {
        // Step 1 asks for two analyses without waiting for them; step 2 is held, so the controller keeps one slot while
        // the first analysis to start holds the other inside its model call and the second one stays unstarted.
        harness.model.script(
          'controller',
          {
            output: {
              kind: 'requestAnalysis',
              rationale: 'two services',
              await: false,
              subquestions: [subquestion('service-1'), subquestion('service-2')],
            },
          },
          { ...conclude, holdUntil: controllerGo.wait },
        );
        harness.model.script('worker', { output: { claims: [] }, holdUntil: workerGo.wait });
        const { resourceId, investigationId, controllerTaskId } = await start('C2: why did the two services fail?');
        const [running, unstarted] = await vi.waitFor(
          async () => {
            expect(harness.model.callsOf('controller')).toHaveLength(2);
            expect(harness.model.callsOf('worker')).toHaveLength(1);
            const analyses = (await tasksOf(investigationId)).filter((task) => task.workflowType === ANALYZE);
            const runningTask = analyses.find((task) => task.status === 'running');
            const queuedTask = analyses.find((task) => task.status === 'queued');
            if (runningTask === undefined || queuedTask === undefined) throw new Error('the analyses are not placed yet');
            return [runningTask, queuedTask] as const;
          },
          { timeout: 20_000, interval: 50 },
        );

        // The controller's worker stops beating: with no retry left the sweeper fails it (recovery exhausted).
        await harness.expireLease(controllerTaskId, 1);

        expect(await closed(investigationId)).toBe('failed');
        await lifecycleDelivered((await taskEventOf(investigationId, controllerTaskId, 'TaskFailed')).eventId);
        const tasks = new Map((await tasksOf(investigationId)).map((task) => [task.taskId, task]));
        expect(tasks.get(controllerTaskId)).toMatchObject({
          status: 'failed',
          failureReason: { class: 'recovery_exhausted', code: 'recovery_exhausted' },
        });
        expect(tasks.get(unstarted.taskId)).toMatchObject({
          status: 'cancelled',
          failureReason: { class: 'cancelled', code: 'cancel_requested' },
        });
        // The closure does not abort an attempt of this process: the running one is only asked to cancel.
        expect(tasks.get(running.taskId)).toMatchObject({ status: 'running' });
        expect(tasks.get(running.taskId)?.cancelRequestedAt).toBeInstanceOf(Date);
        expect(await endEventTypesOf(investigationId)).toEqual(['InvestigationFailed']);
        const [failedEvent] = (await eventsOf(investigationId)).filter((event) => event.type === 'InvestigationFailed');
        expect((await taskEventOf(investigationId, unstarted.taskId, 'TaskCancelled')).causationId).toBe(failedEvent!.eventId);
        expect(await view(investigationId, resourceId)).toMatchObject({ status: 'failed', answer: null });

        // The held worker answers: its outcome is written under the cancel request, so the task ends cancelled.
        workerGo.open();
        await vi.waitFor(
          async () => {
            const task = (await tasksOf(investigationId)).find((row) => row.taskId === running.taskId);
            expect(task).toMatchObject({ status: 'cancelled', failureReason: { class: 'cancelled', code: 'cancel_requested' } });
          },
          { timeout: 20_000, interval: 50 },
        );
        // The failed controller's attempt goes on to its decision write, which is fenced: still no answer.
        controllerGo.open();
        await vi.waitFor(() => expect(harness.endedRuns).toContainEqual({ taskId: controllerTaskId, attempt: 1 }), {
          timeout: 20_000,
          interval: 50,
        });
        await quiet(investigationId);
        expect((await engineRowsOf(investigationId)).run).toMatchObject({ answer: null, answerId: null });
        expect(await view(investigationId, resourceId)).toMatchObject({ status: 'failed', answer: null });
        expect(await endEventTypesOf(investigationId)).toEqual(['InvestigationFailed']);
      } finally {
        controllerGo.open();
        workerGo.open();
      }
    }, 60_000);
    // C3 (a forced stop closes as `completed`) is proven by deep-research-engine INT-2 L2 and is not repeated here.
    // C4 runs in its own block below: it needs a second instance and a heartbeat it controls.
    it('INT-3 C5: a redelivered controller event, a worker event, an earlier stop and a later cancel never produce a second or a conflicting close', async () => {
      const controllerGo = latch();
      try {
        // (b) the end of a worker task closes nothing: the fetch succeeds while the controller's next step is held.
        harness.model.script(
          'controller',
          {
            output: {
              kind: 'requestEvidence',
              rationale: 'read the logs',
              sourceId: 'fixture',
              toolName: 'search_logs',
              args: { service: 'service-1' },
              completeness: 'all',
            },
          },
          { ...conclude, holdUntil: controllerGo.wait },
        );
        const { resourceId, investigationId, controllerTaskId } = await start('C5: why did service-1 restart?');
        const fetch = await vi.waitFor(
          async () => {
            expect(harness.model.callsOf('controller')).toHaveLength(2);
            const task = (await tasksOf(investigationId)).find((row) => row.workflowType === 'source.fetch');
            expect(task).toMatchObject({ status: 'succeeded' });
            return task!;
          },
          { timeout: 20_000, interval: 50 },
        );
        const fetchSucceeded = await taskEventOf(investigationId, fetch.taskId, 'TaskSucceeded');
        await lifecycleDelivered(fetchSucceeded.eventId);
        expect(await investigationStatus(investigationId)).toBe('active');
        expect(await endEventTypesOf(investigationId)).toEqual([]);
        expect(await view(investigationId, resourceId)).toMatchObject({ status: 'running' });

        // The closure needs no recorded `controller_task_id`: a controller that ends before the start records it (a
        // fast controller) still closes its investigation.
        await harness.unrecordControllerTask(investigationId);
        controllerGo.open();
        expect(await closed(investigationId)).toBe('completed');
        expect((await engineRowsOf(investigationId)).run).toMatchObject({ controllerTaskId: null });
        const controllerSucceeded = await taskEventOf(investigationId, controllerTaskId, 'TaskSucceeded');
        await lifecycleDelivered(controllerSucceeded.eventId);
        await quiet(investigationId);
        const afterClosure = await rowVersionsOf(investigationId);

        // (a) the controller's TaskSucceeded applied a second time changes no row.
        await deliverAgain(envelopeOf(controllerSucceeded));
        expect(await rowVersionsOf(investigationId)).toEqual(afterClosure);
        expect(await endEventTypesOf(investigationId)).toEqual(['InvestigationCompleted']);

        // (d) a cancel after the closure leaves it completed.
        await harness.runtime.investigations.cancel(investigationId, resourceId);
        expect(await rowVersionsOf(investigationId)).toEqual(afterClosure);
        expect(await endEventTypesOf(investigationId)).toEqual(['InvestigationCompleted']);
        expect(await view(investigationId, resourceId)).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive' } });
      } finally {
        controllerGo.open();
      }

      // (c) a stop that commits before the controller's TaskSucceeded is delivered: the investigation stays cancelled.
      // The runtime turns an outcome written after a cancel into `cancelled`, so this order exists only as the race
      // "TaskSucceeded committed, the stop committed, then the delivery ran"; its event is the controller's stored end
      // event with the type it would have had before the stop.
      const stopped = latch();
      try {
        harness.model.script('controller', { ...conclude, holdUntil: stopped.wait });
        const controllerCallsBefore = harness.model.callsOf('controller').length;
        const { resourceId, investigationId, controllerTaskId } = await start('C5: why did service-2 restart?');
        await vi.waitFor(() => expect(harness.model.callsOf('controller')).toHaveLength(controllerCallsBefore + 1), {
          timeout: 20_000,
          interval: 50,
        });
        await harness.runtime.investigations.cancel(investigationId, resourceId);
        stopped.open();
        const controllerEnd = await vi.waitFor(() => taskEventOf(investigationId, controllerTaskId, 'TaskCancelled'), {
          timeout: 20_000,
          interval: 50,
        });
        await quiet(investigationId);
        const afterStop = await rowVersionsOf(investigationId);

        await deliverAgain({ ...envelopeOf(controllerEnd), type: 'TaskSucceeded', payload: {} });

        expect(await investigationStatus(investigationId)).toBe('cancelled');
        expect(await rowVersionsOf(investigationId)).toEqual(afterStop);
        expect(await endEventTypesOf(investigationId)).toEqual(['InvestigationCancelled']);
        expect(await view(investigationId, resourceId)).toMatchObject({ status: 'cancelled', answer: null });
      } finally {
        stopped.open();
      }
    }, 60_000);
  });
  // INT-3 C4 (DC-3, AC-21.1, the model half). Two instances over one database: `first` with workers, whose heartbeat the
  // test parks and releases (`heartbeatGate`), and `second` without workers, whose `InvestigationService.cancel` cannot
  // abort an attempt of `first` in process. While the heartbeat is parked, `first` learns of the stop only from the
  // database: the guard of a reservation (refused, `stopping`) and of a closing (still written). Releasing the heartbeat
  // is the next pulse, which aborts the call still in flight.
  // The call aborted by the pulse keeps its reservation `reserved`, counted in `tokensReserved` (design-engine.md v1.11
  // UC-E2, INT-2 L5: no close point applies to a cancelled investigation); the closing that must pass after the cancel
  // request is the one of a call that answered after the stop. Unique defect: a closing in the mode `requireActive` (the
  // answered call's charge never reaches the ledger), or a reserve that only an in-process abort stops.
  describe('INT-3 C4', () => {
    const HEARTBEAT_MS = 977;
    const heartbeats = heartbeatGate(systemClock, HEARTBEAT_MS);
    let first: EngineHarness;
    let second: EngineHarness;

    beforeAll(async () => {
      first = await createEngineHarness({
        clock: heartbeats.clock,
        runtime: { concurrency: 3, dbPoolMax: 8, leaseMs: 60_000, heartbeatMs: HEARTBEAT_MS, reaperMs: 50, maxRecoveries: 0 },
      });
      second = await createEngineHarness({ runtime: { workers: false } });
    });

    afterAll(async () => {
      try {
        await second?.close();
      } finally {
        await first?.close();
        await closeEngineDb();
      }
    });

    afterEach(async () => {
      try {
        expect(first.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        first.handlerHold.at = undefined;
        heartbeats.resume();
        await first.cancelStarted();
      }
    });

    it('INT-3 C4: a stop made on another instance refuses every later reserve there, lets a call that answered after it close its reservation, and aborts the call still in flight at the next heartbeat', async () => {
      const answerGo = latch();
      const unstartedHeld = latch();
      const unstartedGo = latch();
      heartbeats.pause();
      try {
        // The controller asks for two analyses without waiting and then calls the model until a pulse aborts it. The
        // first analysis to start calls the model and answers when the test says; the second is held at `run`.
        first.model.script(
          'controller',
          {
            output: {
              kind: 'requestAnalysis',
              rationale: 'two services',
              await: false,
              subquestions: [subquestion('service-1'), subquestion('service-2')],
            },
          },
          { hangUntilAborted: true },
        );
        first.model.script('worker', { output: { claims: [] }, holdUntil: answerGo.wait });
        let answering: string | undefined;
        first.handlerHold.at = (point) => {
          if (point.at !== 'run' || point.workflowType !== ANALYZE) return;
          answering ??= point.taskId;
          if (point.taskId === answering) return;
          unstartedHeld.open();
          return unstartedGo.wait;
        };
        const resourceId = newUser();
        const threadId = await first.createThread(resourceId);
        const started = await first.engine.startInvestigation({
          resourceId,
          threadId,
          query: 'C4: why did the two services fail?',
          processId: 'deep-research',
          launchKey: newLaunchKey(),
        });
        if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
        const { investigationId, controllerTaskId } = started;
        await unstartedHeld.wait;
        const atCancel = await vi.waitFor(
          async () => {
            expect(first.model.callsOf('controller')).toHaveLength(2);
            expect(first.model.callsOf('worker')).toHaveLength(1);
            const rows = (await engineRowsOf(investigationId)).llmCalls;
            expect(rows.filter((row) => row.status === 'reserved').map((row) => row.role).sort()).toEqual(['controller', 'worker']);
            return rows;
          },
          { timeout: 20_000, interval: 50 },
        );
        const analyses = (await tasksOf(investigationId)).filter((task) => task.workflowType === ANALYZE);
        const answeringTask = analyses.find((task) => task.taskId === answering)!;
        const unstartedTask = analyses.find((task) => task.taskId !== answering)!;
        const answeringCall = atCancel.find((row) => row.taskId === answeringTask.taskId)!;
        const controllerCall = atCancel.find((row) => row.taskId === controllerTaskId && row.status === 'reserved')!;
        const workerCountsAtCancel = first.tokenCounter.requests.filter(isWorkerRequest).length;

        await second.runtime.investigations.cancel(investigationId, resourceId);

        // Committed on `second`; `first` has not learnt of it: its three attempts run on, each with a cancel request.
        const [investigation] = await first.db
          .select({ status: researchInvestigations.status })
          .from(researchInvestigations)
          .where(eq(researchInvestigations.investigationId, investigationId));
        expect(investigation).toEqual({ status: 'cancelled' });
        const running = (await tasksOf(investigationId)).filter((task) => task.status === 'running');
        expect(running.map((task) => task.taskId).sort()).toEqual([controllerTaskId, answeringTask.taskId, unstartedTask.taskId].sort());
        expect(running.every((task) => task.cancelRequestedAt instanceof Date)).toBe(true);
        expect(first.endedRuns).toEqual([]);

        // A reserve after the stop: the held analysis counts its call and is refused — no call, no row, no transcript.
        unstartedGo.open();
        await vi.waitFor(() => expect(first.endedRuns).toContainEqual({ taskId: unstartedTask.taskId, attempt: 1 }), {
          timeout: 20_000,
          interval: 50,
        });
        expect(first.tokenCounter.requests.filter(isWorkerRequest)).toHaveLength(workerCountsAtCancel + 2);
        expect(first.model.callsOf('worker')).toHaveLength(1);
        expect((await engineRowsOf(investigationId)).llmCalls).toEqual(atCancel);
        expect((await llmTranscriptsOf(investigationId)).map((row) => row.taskId)).not.toContain(unstartedTask.taskId);
        expect(first.logs.runtime.warn.filter(([message]) => message.includes(`taskId=${unstartedTask.taskId}`))).toEqual([]);

        // The call that answers after the stop closes its reservation under the cancel request.
        answerGo.open();
        await vi.waitFor(() => expect(first.endedRuns).toContainEqual({ taskId: answeringTask.taskId, attempt: 1 }), {
          timeout: 20_000,
          interval: 50,
        });
        const afterAnswer = (await engineRowsOf(investigationId)).llmCalls;
        expect(afterAnswer.find((row) => row.callId === answeringCall.callId)).toMatchObject({ status: 'settled' });
        expect(afterAnswer.find((row) => row.callId === answeringCall.callId)?.chargedTokens).toBeGreaterThan(0);
        expect(afterAnswer.find((row) => row.callId === controllerCall.callId)).toMatchObject({ status: 'reserved' });
        expect(first.endedRuns).not.toContainEqual({ taskId: controllerTaskId, attempt: 1 });

        // The next pulse aborts the controller's call in flight.
        heartbeats.resume();
        await vi.waitFor(() => expect(first.endedRuns).toContainEqual({ taskId: controllerTaskId, attempt: 1 }), {
          timeout: 20_000,
          interval: 50,
        });
        await vi.waitFor(
          async () =>
            expect((await tasksOf(investigationId)).filter((task) => task.workflowType !== 'source.fetch').map((task) => task.status)).toEqual([
              'cancelled',
              'cancelled',
              'cancelled',
            ]),
          { timeout: 20_000, interval: 50 },
        );
        expect(first.model.callsOf('controller')).toHaveLength(2);
        expect(first.model.callsOf('worker')).toHaveLength(1);
        const { run, llmCalls } = await engineRowsOf(investigationId);
        expect(llmCalls.map((row) => row.callId)).toEqual(atCancel.map((row) => row.callId));
        expect(llmCalls.find((row) => row.callId === controllerCall.callId)).toMatchObject({ status: 'reserved', chargedTokens: null });
        // The ledger sum: the charged rows are what was spent, the open one what is still reserved.
        expect(llmCalls.reduce((sum, row) => sum + (row.chargedTokens ?? 0), 0)).toBe(run!.tokensSpent);
        expect(run!.tokensReserved).toBe(controllerCall.reservedTokens);
      } finally {
        heartbeats.resume();
        answerGo.open();
        unstartedGo.open();
      }
    }, 60_000);
  });
});
