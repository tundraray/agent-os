// agent-quality / lifecycle Integration Test Skeletons (runtime side) - Design Doc: docs/features/agent-quality/design-lifecycle.md
// PRD: docs/features/agent-quality/prd.md (FR-20). ADRs: ADR-0001 (runtime owner), ADR-0003 (Drizzle data layer), ADR-0004 (packages do not read the environment).
// Generated: 2026-11-06 | Part: lifecycle | Test type: Integration (in-process runtime of the package + real Postgres), CI job `e2e-runtime`
// Implementation timing: created alongside the slice that adds the three task limits (collector: queue wait; dispatcher: attempt limit; both through the existing recovery rules).
//
// File name and placement. Same package, harness and config as `research-runtime-runtime.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; `pnpm --filter @agent-os/runtime test:e2e`,
// never in the default `vitest run`).
//
// Environment (as the sibling runtime file):
// - Postgres 16 from infra/docker-compose.yml, migrations applied once. Real `createRuntime` through `createRuntimeHarness` with `RUNTIME_WORKERS` on, test handlers (`testHandlers.ts`: latch-based, scripted
//   outcomes), a ThreadOwnership double. No mocks of Postgres or runtime components.
// - Limits are the part's runtime settings, set small for the test (`runtime: { queueWaitMs, attemptMs }` over the harness defaults); the Clock is the injected one, moved by the test. The instant a limit
//   passes is produced by moving the clock (and by `lease_expires_at` where the existing tests do), never by sleeping.
// - Isolation (project convention, no truncate): unique `resourceId = 'e2e-' + randomUUID()` and a unique `workflowType` per test; a worker only claims tasks of the types in its own HandlerRegistry. The
//   "type no instance handles" in Q1 is a `workflowType` that is registered nowhere.
//
// Budget: this file holds INT-4 of the part's 5 integration tests (whole budget in apps/api/test/agent-quality-lifecycle.int.e2e-spec.ts). INT-4 is an extra; unique defect: a limit measured from the wrong
// moment (creation instead of readiness, the first attempt instead of the current one, a dependency wait counted as queue time) or a timed-out attempt that is neither retried nor failed. No other test, at any
// level, can show it: the origins are rows and a dispatcher/collector pair, not a function.
//
// Proven elsewhere (not in this file):
// - the effective limit "the smaller of the setting and the task's total deadline" and "the smaller of the setting and the time left to the total deadline": unit table over the limit function (named for the plan).
// - `RUNTIME_QUEUE_WAIT_MS` / `RUNTIME_ATTEMPT_MS` defaults and the minimum 1000: unit, `runtime-config.spec.ts`; the allowlist in `apps/api/src/research/runtime-settings.spec.ts`.
// - the fencing and recovery rules a timed-out attempt reuses (attempt number, lease, retry counter, `RUNTIME_MAX_RECOVERIES`): existing INT-3 of `research-runtime-runtime.int.e2e-spec.ts` and the kill matrix.
// - retries exhausted -> `failed` with code `recovery_exhausted` and its message (was A2 here): existing INT-3 R2 of `research-runtime-runtime.int.e2e-spec.ts` (every lease expiry and every attempt timeout end
//   through the same `expired` outcome and the same collector rule, so a second run of it adds no defect).
// - the total deadline while running -> `failed` with code `deadline_exceeded`, class `deadline`, the attempt aborted with reason `{ kind: 'deadline' }`, no retry (was T1 here): existing INT-3 R3 of the same file.
// - how a controller reacts to a failed child task: packages/engine, unchanged.

import type { TaskSpec, ToolCallGrant } from '@agent-os/contracts';
import {
  type CancelTimer,
  type Clock,
  type HandlerResult,
  systemClock,
  type TaskContext,
  type UpstreamTask,
} from '@agent-os/runtime';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { newUser } from './support/new-user.js';
import { closeRuntimeDb, query, runtimeWorkSettled } from './support/runtimeDb.js';
import {
  createRuntimeHarness,
  type RuntimeHarness,
} from './support/runtimeHarness.js';
import {
  completed,
  type Latch,
  latch,
  taskSpec,
  testHandler,
  uniqueWorkflowType,
  within,
} from './support/testHandlers.js';

/** A clock that `shift` moves forward: the collector of its runtime sees a limit pass on demand. */
function shiftableClock(): Clock & { shift(ms: number): void } {
  let offset = 0;
  return {
    now: () => new Date(systemClock.now().getTime() + offset),
    random: () => systemClock.random(),
    setTimer: (ms, callback) => systemClock.setTimer(ms, callback),
    shift: (ms) => {
      offset += ms;
    },
  };
}

/**
 * A clock that `shift` moves forward and that runs, at the shift, every timer whose time has come
 * by the moved clock: a dispatcher's attempt or deadline timer passes on demand, without sleeping.
 * A timer not yet due still runs after its real delay.
 */
function steppableClock(): Clock & { shift(ms: number): void } {
  let offset = 0;
  const pending = new Set<{ dueAt: number; fire(): void }>();
  const nowMs = () => systemClock.now().getTime() + offset;
  return {
    now: () => new Date(nowMs()),
    random: () => systemClock.random(),
    setTimer: (ms, callback) => {
      let cancelReal: CancelTimer = () => undefined;
      const timer = {
        dueAt: nowMs() + ms,
        fire: () => {
          pending.delete(timer);
          cancelReal();
          callback();
        },
      };
      pending.add(timer);
      cancelReal = systemClock.setTimer(ms, timer.fire);
      return () => {
        pending.delete(timer);
        cancelReal();
      };
    },
    shift: (ms) => {
      offset += ms;
      const due = [...pending]
        .filter((timer) => timer.dueAt <= nowMs())
        .sort((a, b) => a.dueAt - b.dueAt);
      // A fired timer's callback may cancel a later due timer: fire only those still pending.
      for (const timer of due) if (pending.has(timer)) timer.fire();
    },
  };
}

describe('agent-quality / lifecycle - runtime integration (in-process runtime + real Postgres)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Task time limits: queue wait, one attempt, the whole work - each from its own moment, each with its own reason
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-20.1: "Given задача ждёт в очереди дольше своего срока, Then она завершается с причиной «истёк срок ожидания в очереди»."
  // AC-20.2: "Given попытка длится дольше своего срока, Then попытка прерывается, и задача повторяется по действующим правилам повторов."
  // AC-20.3: "Given вся работа задачи длится дольше своего срока, Then задача завершается неудачей с причиной «истёк общий срок»."
  // DC-5 (FR-20): "Срок очереди отсчитывается от момента, когда задача стала готовой, и действует до первого захвата... Задача, которая ждёт незаконченную зависимость, в очереди не стоит, и её срок очереди не идёт."
  // DC-6 (FR-20): "Попытка, которая длится дольше `RUNTIME_ATTEMPT_MS`, прерывается, и задача повторяется, пока повторы не исчерпаны и общий срок не вышел; иначе она `failed` с кодом `recovery_exhausted` или `deadline_exceeded`."
  // DC-7 (FR-20): "Причина «истёк срок ожидания в очереди» записывается кодом `queue_wait_exceeded`, «истёк общий срок» — кодом `deadline_exceeded`; у обеих класс `deadline`."
  // Use cases: UC-4, UC-5, UC-6, UC-E4, UC-E5. KD-3. Flow 4. Invariant 8.
  //
  // Primary failure mode (turns red when): a ready task of a type nobody handles waits forever; the queue limit runs while the task still waits for its dependency (a long gather kills the analysis task that
  // waits for it) or runs from creation instead of readiness; a hung attempt keeps its lease alive (heartbeats) and is never retried; the retry resets the total deadline or the retry counter; the total deadline
  // is replaced by a retry; the exhausted-retries case ends with a different code; a late result of the timed-out attempt overwrites the new attempt.
  // Behavior: a task is ready (created, dependencies succeeded) and not claimed -> the collector finds it past the queue limit -> `failed`/`queue_wait_exceeded`/class `deadline`, its waiting parent woken;
  //   a claimed attempt outlives the attempt limit -> the dispatcher aborts it and makes its lease expired -> the collector requeues it (attempt + 1, retry counter + 1) or fails it
  //   (`recovery_exhausted`); a task past its total deadline -> `failed`/`deadline_exceeded`, no retry
  // @category: core-functionality
  // @dependency: Dispatcher, RecoverySweeper, OutboxRelay (wake of the waiting parent), TaskContext lease/heartbeat, test handlers, Clock (injected), Postgres
  // @complexity: high
  //
  // Verification items (table; each row asserts on `research_tasks` (status, attempt, retry counter, failure code and class, timestamps), `research_events` and the handler's recorded calls, with literal values):
  // - Q1 queue limit (UC-4, AC-20.1, DC-5, DC-7): a ready task of a type that no instance handles, a parent task waiting on it, `queueWaitMs` small -> before the limit it is still `queued`; after the clock passes
  //   the limit plus one collector period it is `failed` with code `queue_wait_exceeded` and class `deadline`, it was never claimed (attempt 0), and the parent is woken by its outcome
  // - Q2 a dependency wait is not queue time (UC-E4, DC-5): task B depends on task A, A runs longer than `queueWaitMs` and then succeeds -> B is neither failed nor claimed while A runs; after A succeeds B is
  //   claimed and succeeds; and with a handler for B that is held, B fails with `queue_wait_exceeded` only a full limit after A's end, not after B's creation
  // - A1 a hung attempt is retried (UC-5, AC-20.2, DC-6): the handler does not answer in its first attempt (latch) and answers at once in the second, `attemptMs` small and the total deadline far -> after the clock
  //   passes `attemptMs` the first attempt's signal is aborted, the task is requeued, the retry counter is 1, attempt 2 ends `succeeded`; the total deadline (`deadline_at`) of attempt 2 equals that of attempt 1;
  //   the first handler is then released and its late result changes nothing (attempt number fences it)
  // - A2 retries exhausted (UC-E5, DC-6) and T1 total deadline (UC-6, AC-20.3, DC-7): dropped from this file; their literal code, message and abort reason are asserted in INT-3 R2 and R3 of
  //   `research-runtime-runtime.int.e2e-spec.ts` (see "Proven elsewhere")
  describe('INT-4', () => {
    const LATCH_MS = 15_000;
    /** `RUNTIME_QUEUE_WAIT_MS` of the test: far below the total deadline of the tasks that use it. */
    const QUEUE_WAIT_MS = 30_000;
    /** Total deadline of the tasks whose queue limit is the setting; no clock shift here reaches it. */
    const LONG_DEADLINE_MS = 3_600_000;
    /** The smallest total deadline a TaskBudget allows: its queue limit is the deadline, not the setting. */
    const SHORT_DEADLINE_MS = 1_000;
    const QUEUE_WAIT_EXCEEDED = {
      class: 'deadline',
      code: 'queue_wait_exceeded',
      message: 'The task waited in the queue past its limit',
    };

    const clock = shiftableClock();
    /** Handled by the working instance. */
    const workerType = uniqueWorkflowType('int4-worker');
    /** Known only to an instance without workers, so no instance ever claims its tasks. */
    const idleType = uniqueWorkflowType('int4-idle');
    const resourceId = newUser();
    const heldStarted = latch();
    const releaseHeld = latch();
    /** What a waiter saw upstream in its attempt after the wake-up, by its task id. */
    const upstreamSeen = new Map<string, readonly UpstreamTask[]>();

    const workerHandler = testHandler(
      workerType,
      async (ctx): Promise<HandlerResult> => {
        switch (ctx.input.role) {
          case 'held':
            heldStarted.release();
            await releaseHeld.promise;
            return completed();
          case 'waiter': {
            if (ctx.attempt > 1) {
              upstreamSeen.set(ctx.taskId, ctx.upstream);
              return completed();
            }
            const target =
              typeof ctx.input.target === 'string' ? ctx.input.target : '';
            const registered = await ctx.registerWait([target]);
            if (registered.outcome !== 'ok') {
              throw new Error(`wait refused: ${JSON.stringify(registered)}`);
            }
            return { ...completed(), kind: 'wait', waitFor: [target] };
          }
          default:
            return completed();
        }
      },
    );
    const idleHandler = testHandler(idleType, () => {
      throw new Error('An idle task was claimed');
    });

    /** Collector every 50 ms; leases and heartbeats outlast every clock shift of the tests. */
    let worker: RuntimeHarness;
    /** Admits tasks of `idleType` (as an API instance with RUNTIME_WORKERS=off); claims nothing. */
    let admitter: RuntimeHarness;
    let threadId: string;

    afterAll(() => closeRuntimeDb());

    /**
     * The collector is not scoped to a workflow type: with a shifted clock it also ends queued tasks
     * other runs left behind. Their events are delivered before a runtime closes, so no
     * `runtime.scheduler` delivery is left pending for the next file.
     */
    async function schedulerDeliveriesDrained(): Promise<void> {
      await vi.waitFor(
        async () => {
          const [left] = await query<{ pending: number }>(
            `SELECT count(*)::int AS pending FROM app.research_event_deliveries
              WHERE status = 'pending' AND consumer = 'runtime.scheduler'`,
            [],
          );
          expect(left.pending).toBe(0);
        },
        { timeout: LATCH_MS, interval: 25 },
      );
    }

    async function newInvestigation(
      label: string,
      app: RuntimeHarness = worker,
      thread: string = threadId,
    ): Promise<string> {
      const { investigationId } = await app.investigations.create({
        resourceId,
        threadId: thread,
        query: `INT-4 ${label}`,
        budget: { maxTasks: 10, maxToolCalls: 20 },
      });
      return investigationId;
    }

    async function create(
      app: RuntimeHarness,
      task: {
        investigationId: string;
        workflowType: string;
        input: Record<string, string>;
        dependsOn?: string[];
        deadlineMs?: number;
      },
    ): Promise<string> {
      const base = taskSpec(task);
      const proposal: TaskSpec = {
        ...base,
        budget: {
          ...base.budget,
          deadlineMs: task.deadlineMs ?? LONG_DEADLINE_MS,
        },
      };
      const result = await app.scheduler.propose(
        proposal,
        `int4-${task.input.key}`,
      );
      if (result.outcome !== 'created') {
        throw new Error(`task not created: ${JSON.stringify(result)}`);
      }
      return result.taskId;
    }

    interface TaskState {
      status: string;
      attempt: number;
      failureReason: Record<string, unknown> | null;
      finishedAt: Date | null;
    }

    async function taskState(taskId: string): Promise<TaskState> {
      const [row] = await query<TaskState>(
        `SELECT status, attempt, failure_reason AS "failureReason", finished_at AS "finishedAt"
           FROM app.research_tasks WHERE task_id = $1`,
        [taskId],
      );
      return row;
    }

    async function settledAs(taskId: string, status: string): Promise<void> {
      await vi.waitFor(
        async () => {
          expect((await taskState(taskId)).status).toBe(status);
        },
        { timeout: LATCH_MS, interval: 25 },
      );
    }

    /**
     * A task of `idleType` with no dependencies that is already past its queue limit: once it is
     * `failed`, a collector pass has run after this call, and that pass also saw every task
     * created before it.
     */
    async function collectorPassed(
      investigationId: string,
      key: string,
      deadlineMs?: number,
    ): Promise<void> {
      const probe = await create(admitter, {
        investigationId,
        workflowType: idleType,
        input: { key },
        deadlineMs,
      });
      return settledAs(probe, 'failed');
    }

    function eventsOfTask(taskId: string): Promise<
      {
        eventId: string;
        type: string;
        payload: Record<string, unknown>;
        causationId: string | null;
      }[]
    > {
      return query(
        `SELECT event_id AS "eventId", type, payload, causation_id AS "causationId"
           FROM app.research_events WHERE task_id = $1 ORDER BY seq`,
        [taskId],
      );
    }

    // The queue tests share one runtime whose clock they move far forward; it is closed before the
    // attempt tests start, whose fresh tasks its collector would otherwise end as past the queue limit.
    describe('queue limit (Q1, Q2)', () => {
      beforeAll(async () => {
        worker = await createRuntimeHarness({
          handlers: [workerHandler],
          clock,
          runtime: {
            queueWaitMs: QUEUE_WAIT_MS,
            reaperMs: 50,
            leaseMs: LONG_DEADLINE_MS,
            heartbeatMs: LONG_DEADLINE_MS,
          },
        });
        admitter = await createRuntimeHarness({
          handlers: [idleHandler],
          clock,
          runtime: { workers: false },
        });
        threadId = await worker.createThread(resourceId);
      });

      afterAll(async () => {
        releaseHeld.release();
        try {
          await runtimeWorkSettled([workerType, idleType], LATCH_MS);
          await schedulerDeliveriesDrained();
        } finally {
          await worker?.close();
          await admitter?.close();
        }
      }, 3 * LATCH_MS);

      it('INT-4 Q1: a ready task that no instance claims fails with queue_wait_exceeded of class deadline once its queue limit passes, and wakes its waiting parent', async () => {
        const investigationId = await newInvestigation('Q1');
        const idle = await create(admitter, {
          investigationId,
          workflowType: idleType,
          input: { key: 'q1-idle' },
        });
        const parent = await create(worker, {
          investigationId,
          workflowType: workerType,
          input: { role: 'waiter', key: 'q1-parent', target: idle },
        });
        await settledAs(parent, 'waiting');

        // Past the 1 s limit of a short-deadline task, far before the setting's 30 s.
        clock.shift(2_000);
        await collectorPassed(investigationId, 'q1-probe', SHORT_DEADLINE_MS);
        expect(await taskState(idle)).toMatchObject({
          status: 'queued',
          attempt: 0,
          failureReason: null,
        });

        clock.shift(QUEUE_WAIT_MS);
        await settledAs(idle, 'failed');
        await settledAs(parent, 'succeeded');

        expect(await taskState(idle)).toMatchObject({
          status: 'failed',
          attempt: 0,
          failureReason: { ...QUEUE_WAIT_EXCEEDED, cause: null, attempt: 0 },
        });
        const idleEvents = await eventsOfTask(idle);
        expect(idleEvents.map(({ type, payload }) => [type, payload])).toEqual([
          ['TaskQueued', { reason: 'admitted' }],
          [
            'TaskFailed',
            { attempt: 0, failureClass: 'deadline', code: 'queue_wait_exceeded' },
          ],
        ]);
        const woken = (await eventsOfTask(parent)).find(
          (event) =>
            event.type === 'TaskQueued' && event.payload.reason === 'woken',
        );
        expect(woken?.causationId).toBe(idleEvents[1].eventId);
        expect(upstreamSeen.get(parent)).toEqual([
          { taskId: idle, kind: 'waits_for', status: 'failed', outputRefs: [] },
        ]);
      }, 30_000);

      it('INT-4 Q2: the queue limit does not run while a task waits for its dependency and starts at the moment the dependency succeeds', async () => {
        const investigationId = await newInvestigation('Q2');
        const dependency = await create(worker, {
          investigationId,
          workflowType: workerType,
          input: { role: 'held', key: 'q2-dependency' },
        });
        await within(heldStarted.promise, LATCH_MS, 'the dependency to start');
        const claimable = await create(worker, {
          investigationId,
          workflowType: workerType,
          input: { key: 'q2-claimable' },
          dependsOn: [dependency],
        });
        const idle = await create(admitter, {
          investigationId,
          workflowType: idleType,
          input: { key: 'q2-idle' },
          dependsOn: [dependency],
        });

        // The dependency runs past a whole queue limit: its dependents are not in the queue yet.
        clock.shift(QUEUE_WAIT_MS + 1_000);
        await collectorPassed(investigationId, 'q2-probe-while-running');
        for (const taskId of [claimable, idle]) {
          expect(await taskState(taskId)).toMatchObject({
            status: 'queued',
            attempt: 0,
            failureReason: null,
          });
        }

        releaseHeld.release();
        await settledAs(dependency, 'succeeded');
        await settledAs(claimable, 'succeeded');
        expect((await taskState(claimable)).attempt).toBe(1);
        // B is a dependent of the unclaimed type: a held handler would claim B, and the claim ends its queue time.
        // Long past its creation plus the limit, but its limit runs from the dependency's end.
        await collectorPassed(investigationId, 'q2-probe-after-end');
        expect(await taskState(idle)).toMatchObject({
          status: 'queued',
          attempt: 0,
          failureReason: null,
        });

        clock.shift(QUEUE_WAIT_MS + 1_000);
        await settledAs(idle, 'failed');
        const ended = await taskState(idle);
        expect(ended).toMatchObject({
          attempt: 0,
          failureReason: { ...QUEUE_WAIT_EXCEEDED, attempt: 0 },
        });
        const { finishedAt: dependencyEnd } = await taskState(dependency);
        expect(
          (ended.finishedAt?.getTime() ?? 0) - (dependencyEnd?.getTime() ?? 0),
        ).toBeGreaterThanOrEqual(QUEUE_WAIT_MS);
      }, 30_000);
    });

    // The attempt test runs its own runtime on a fresh clock: the clock moves by a whole attempt
    // limit, and the collector of the queue-limit runtime, had its clock moved that far, would end
    // the next test's task as past its queue limit before its claim.
    describe('attempt limit (A1)', () => {
      /** `RUNTIME_ATTEMPT_MS` of the test: longer than LATCH_MS, so only a clock shift passes it within a test. */
      const ATTEMPT_MS = 60_000;
      /** One retry: the retry of the timed-out attempt is within the budget. */
      const MAX_RECOVERIES = 1;
      /** How far a clock shift goes past a limit. */
      const PAST = 1_000;
      /** Per test: a task left behind by a failing test is never claimed by the next test's runtime. */
      let attemptType: string;

      let attemptClock: ReturnType<typeof steppableClock>;
      let runtime: RuntimeHarness;
      let attemptThread: string;
      /** What the handler of the current test does in an attempt. */
      let script: (ctx: TaskContext) => Promise<HandlerResult>;
      /** Released after each test: a handler that hangs waits for it, never for the test's end. */
      let hang: Latch;

      beforeEach(async () => {
        attemptType = uniqueWorkflowType('int4-attempt');
        attemptClock = steppableClock();
        hang = latch();
        runtime = await createRuntimeHarness({
          handlers: [testHandler(attemptType, (ctx) => script(ctx))],
          clock: attemptClock,
          runtime: {
            attemptMs: ATTEMPT_MS,
            maxRecoveries: MAX_RECOVERIES,
            // The lease outlasts every clock shift: only the timed-out attempt's own write expires it.
            leaseMs: 2 * ATTEMPT_MS,
            // Frequent heartbeats make a beat in flight at the abort likely (not certain): one that
            // outlived its abort would extend the lease the attempt limit expired before the
            // collector's next pass.
            heartbeatMs: 50,
            reaperMs: 1_000,
          },
        });
        attemptThread = await runtime.createThread(resourceId);
      });

      afterEach(async () => {
        hang.release();
        try {
          await runtimeWorkSettled([attemptType], LATCH_MS);
          await schedulerDeliveriesDrained();
        } finally {
          await runtime.close();
        }
      }, 3 * LATCH_MS);

      interface AttemptState {
        status: string;
        attempt: number;
        recoveryCount: number;
        deadlineAt: Date | null;
        attemptToolCalls: number;
        failureReason: Record<string, unknown> | null;
        outcome: Record<string, unknown> | null;
      }

      async function attemptState(taskId: string): Promise<AttemptState> {
        const [row] = await query<AttemptState>(
          `SELECT status, attempt, recovery_count AS "recoveryCount", deadline_at AS "deadlineAt",
                  attempt_tool_calls AS "attemptToolCalls", failure_reason AS "failureReason", outcome
             FROM app.research_tasks WHERE task_id = $1`,
          [taskId],
        );
        return row;
      }

      async function startTask(label: string): Promise<string> {
        const investigationId = await newInvestigation(
          label,
          runtime,
          attemptThread,
        );
        return create(runtime, {
          investigationId,
          workflowType: attemptType,
          input: { key: `${label}-${investigationId}` },
        });
      }

      async function eventTrail(taskId: string): Promise<unknown[][]> {
        return (await eventsOfTask(taskId)).map(({ type, payload }) => [
          type,
          payload,
        ]);
      }

      it("INT-4 A1: an attempt that outlives its limit is aborted and the task is retried with the retry counter at 1 and the same total deadline, and the aborted attempt's late result changes nothing", async () => {
        const started = [latch(), latch()];
        const release = [latch(), latch()];
        const lateCallDone = latch();
        /** Released once attempt 1's handler has returned its late result. */
        const lateReturned = latch();
        const signals = new Map<number, AbortSignal>();
        let lateGrant: ToolCallGrant | undefined;
        const attemptScript = async (ctx: TaskContext) => {
          signals.set(ctx.attempt, ctx.signal);
          started[ctx.attempt - 1].release();
          await Promise.race([release[ctx.attempt - 1].promise, hang.promise]);
          if (ctx.attempt === 1) {
            // The aborted attempt goes on as a hung handler would, and tries to write.
            lateGrant = await ctx.reserveToolCall('int4.late', false);
            lateCallDone.release();
          }
          return completed({ answerOrDelta: `attempt ${ctx.attempt}` });
        };
        script = (ctx) =>
          attemptScript(ctx).finally(() => {
            if (ctx.attempt === 1) lateReturned.release();
          });
        const taskId = await startTask('A1');
        await within(started[0].promise, LATCH_MS, 'attempt 1 to start');
        const first = await attemptState(taskId);
        expect(first).toMatchObject({
          status: 'running',
          attempt: 1,
          recoveryCount: 0,
        });
        expect(first.deadlineAt).not.toBeNull();

        attemptClock.shift(ATTEMPT_MS + PAST);
        await within(started[1].promise, LATCH_MS, 'attempt 2 to start');
        expect(signals.get(1)?.reason).toEqual({ kind: 'attempt_timeout' });
        expect(await attemptState(taskId)).toMatchObject({
          status: 'running',
          attempt: 2,
          recoveryCount: 1,
          deadlineAt: first.deadlineAt,
        });

        // The aborted attempt answers late, while attempt 2 runs: the attempt number fences it.
        release[0].release();
        await within(lateCallDone.promise, LATCH_MS, 'the late call of attempt 1');
        expect(lateGrant).toEqual({
          granted: false,
          reason: 'not_current_attempt',
        });
        // Read the state only after attempt 1's handler has returned its late result.
        await within(lateReturned.promise, LATCH_MS, 'the return of attempt 1');
        await new Promise((resolve) => setImmediate(resolve));
        expect(await attemptState(taskId)).toMatchObject({
          status: 'running',
          attempt: 2,
          attemptToolCalls: 0,
        });

        release[1].release();
        await settledAs(taskId, 'succeeded');
        expect(await attemptState(taskId)).toMatchObject({
          attempt: 2,
          recoveryCount: 1,
          deadlineAt: first.deadlineAt,
          failureReason: null,
          outcome: { answerOrDelta: 'attempt 2' },
        });
        // The timed-out attempt's own write only expired its lease: no event of its own.
        expect(await eventTrail(taskId)).toEqual([
          ['TaskQueued', { reason: 'admitted' }],
          ['TaskStarted', { attempt: 1 }],
          ['TaskQueued', { reason: 'recovered' }],
          ['TaskStarted', { attempt: 2 }],
          ['TaskSucceeded', { attempt: 2, outputRefCount: 0 }],
        ]);
      }, 30_000);
    });
  });
});
