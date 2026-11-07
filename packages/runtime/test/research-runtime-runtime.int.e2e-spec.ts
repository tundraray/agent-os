// research-runtime / runtime Integration Test Skeletons - Design Doc: docs/features/research-runtime/design-runtime.md
// PRD: docs/features/research-runtime/prd.md (FR-01..FR-10; Should: FR-18, FR-19, FR-20, FR-23). ADRs: ADR-0001 (runtime owner), ADR-0003 (Drizzle data layer)
// Generated: 2026-10-31 | Part: runtime | Test type: Integration (in-process runtime of the package + real Postgres), CI job `e2e-runtime`
// Implementation timing: created alongside the implementation slice that each test names (Design Doc "Implementation Approach": horizontal foundation, then vertical slices per Flow 1-5).
//
// File name follows the project convention (`*.e2e-spec.ts` under packages/runtime/test, picked up by vitest.config.e2e.ts, run with `pnpm --filter @agent-os/runtime test:e2e`).
// The `.int.` infix separates these in-process tests from the child-process file `research-runtime-runtime.e2e-spec.ts` (final phase). The sibling part
// `mcp-source` owns `research-runtime-mcp-source.e2e-spec.ts`; nothing here exercises MCP, ToolExecutor, the fixture or source adapters.
//
// Environment (Design Doc "Test Boundaries"):
// - Postgres 16 from infra/docker-compose.yml (DATABASE_URL from apps/api/.env), migrations applied by the e2e harness before the suite, `RUNTIME_WORKERS` on only where a test needs
//   the Dispatcher / OutboxRelay / RecoverySweeper. No mocks of Postgres or runtime components; threads are reached only through a ThreadOwnership double.
// - Isolation (project convention, no truncate): a unique `resourceId = 'e2e-' + randomUUID()` per test AND a unique `workflowType` per test. A worker only claims tasks whose
//   type and version are in its own HandlerRegistry, so another test file's workers never touch these rows.
// - Handlers are test handlers registered through `HandlerRegistry.register` (gate/latch based, scripted outcomes). Clock, backoff jitter and timers are injected; no sleeps for ordering.
// - Support: test/support/runtimeHarness.ts (createDatabase + createRuntime with test handlers, a ThreadOwnership double, a clock and a recording RuntimeLogger),
//   test/support/runtimeDb.ts (read-only snapshots of research_* rows, row-version snapshot for "no row changed" checks), test/support/testHandlers.ts.
//
// Budget: Integration 5 of 3, extended to 5 under the integration-e2e-testing rule ("up to 5 only when each extra test names the defect no other test catches").
//   INT-1..INT-3 are the core budget. INT-4 and INT-5 are the two extras; each states its unique defect below. INT-5 shares its slot with
//   apps/api/test/research-runtime-wiring.e2e-spec.ts (the rows that cross ThreadsService). That file also holds UC-E8, a sixth group the design
//   requires (the binding of the runtime to the Nest phases); the plan records it as an accepted budget exception.
// ROI note: scores use the raw skill formula (Business Value x Frequency + Legal x 10 + Defect Detection) / (Create 3 + Execute 5 + Maintain 3 = 11).
//
// Proven elsewhere (not in this file; see the plan's Appendix: Traceability, "AC -> доказывающий тест"):
// - unit, packages/runtime/src: AC-02.1, AC-02.2 (task-spec.spec.ts), AC-06.3, AC-06.5, AC-06.6 (dedup-key.spec.ts), AC-03.4 (contracts.spec.ts);
//   AC-RT-7: apps/api/src/mastra/mastra.provider.spec.ts and the packages' lint rule against `@mastra/*`
// - child-process file research-runtime-runtime.e2e-spec.ts: AC-08.1, AC-08.2, AC-08.4, AC-RT-4 (kill matrix)
// - packages/db/test/migrations.e2e-spec.ts: AC-10.1, AC-10.2, AC-RT-8; apps/api/test/research-runtime-boot.e2e-spec.ts: AC-RT-3 (boot against database states)
// - apps/api/test/research-runtime-wiring.e2e-spec.ts: AC-23.1-AC-23.3, AC-23.5 (thread deletion), the 404 of `create` on another user's thread, UC-E8
// - existing chat-shell e2e suite run unchanged at acceptance: AC-01.2, AC-23.4
// - on-demand script test/verify/runtime-latency.verify.ts, not in the suite: UC-N1, UC-N2 (latency, recovery time)

import { createHash, randomUUID } from 'node:crypto';
import {
  type EventEnvelope,
  type EvidenceRef,
  type TaskSpec,
  type ToolCallGrant,
} from '@agent-os/contracts';
import { researchInvestigations } from '@agent-os/db';
import {
  type Clock,
  type EventConsumer,
  type HandlerResult,
  type RegisterWaitResult,
  type RuntimeTx,
  systemClock,
  type TaskContext,
  type UpstreamTask,
} from '@agent-os/runtime';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CrashPoints } from '../src/crash-points.js';
import { EventConsumerRegistry } from '../src/event-consumer.registry.js';
import { EventLog } from '../src/event-log.js';
import { OutboxRelay } from '../src/outbox.relay.js';
import { SchedulerConsumer } from '../src/scheduler.consumer.js';
import { TaskRepository } from '../src/task.repository.js';
import { newUser } from './support/new-user.js';
import {
  clientRowsOf,
  closeRuntimeDb,
  createClientTable,
  dropClientTable,
  eventsOf,
  knowledgeStatusesOf,
  query,
  runtimeWorkSettled,
  tasksOf,
} from './support/runtimeDb.js';
import {
  createRuntimeHarness,
  type RuntimeHarness,
} from './support/runtimeHarness.js';
import {
  completed,
  evidenceInput,
  type Latch,
  latch,
  taskSpec,
  testHandler,
  uniqueWorkflowType,
  within,
} from './support/testHandlers.js';

describe('research-runtime / runtime - integration (in-process runtime + real Postgres)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Admission under the investigation lock
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-06.1: "Given fetch-задача F выполняется, When поступает запрос с тем же ключом, Then новая задача не создана, запросивший записан подписчиком F, источник вызван ровно один раз, оба получают ссылку на одно evidence."
  // AC-06.2: "Given 10 одинаковых запросов поступают одновременно, Then создана одна задача и источник вызван ровно один раз."
  // AC-06.4: "Given F со срезом S1 завершилась, When поступает тот же запрос со срезом S2, Then создана новая задача, источник вызван снова, результат S1 не выдан как результат S2."
  // AC-07.1: "Given A ждёт B, When регистрируется ожидание B от A, Then оно отклонено с причиной «цикл ожидания» и перечнем задач цикла; A и B продолжают исполняться как до попытки."
  // AC-07.2: "Given цепочка A → B → C, When регистрируется зависимость C от A, Then она отклонена."
  // AC-07.3: "Given задача объявляет зависимость от самой себя, Then регистрация отклонена."
  // AC-04.3: "Given B зависит от задачи, которой нет в этом расследовании, Then регистрация B отклонена."
  // AC-05.1: "Given у расследования остался бюджет на 2 вызова инструментов, When предлагается задача с бюджетом на 3 вызова, Then предложение отклонено с причиной «бюджет», источник не вызван."
  // AC-05.2: "Given в расследовании достигнут лимит числа задач, When предлагается ещё одна, Then она отклонена, уже созданные задачи продолжают исполняться."
  // AC-RT-6: "If при приёме задачи её зависимость уже failed или cancelled, then задача создаётся сразу cancelled с классом dependency_failed; if при переходе в waiting все ожидаемые задачи уже завершены, then задача сразу возвращается в queued."
  // AC-02.2 (wiring only, the variants are unit): "Given задача с типом или версией workflow, для которых не зарегистрирован обработчик, Then регистрация отклонена."
  // Use cases: UC-9, UC-10, UC-8, UC-3 (one wiring row), UC-7 (admission half). EARS: When / If-then.
  // Design flow: Flow 1 (TaskScheduler.propose), KD-3 (FOR NO KEY UPDATE on the investigation + partial UNIQUE on dedup_key).
  //
  // Primary failure mode (turns red when): the investigation row lock or the partial UNIQUE (investigation_id, dedup_key) is dropped or narrowed - 10 concurrent identical proposals create
  // more than one task, crossed edges A<->B are both accepted (spike A2: 0 of 100 rejected without the lock), or a budget reservation is lost under concurrency.
  // Not re-checked here: input validation variants and key canonicalization (unit tests prove the rule; one rejection row below proves it is wired and writes nothing).
  // ROI: 6.3 | Business Value: 10 (duplicate or cyclic work defeats the budget guarantee) | Frequency: 6 (every proposal) | Legal: false | Defect Detection: 9
  // Behavior: concurrent / sequential propose calls on one investigation -> exactly the admitted rows, subscribers and reservations; every rejection is a value and leaves no row, edge or reservation
  // @category: core-functionality
  // @dependency: TaskScheduler, TaskRepository, EventLog, Postgres (app schema), test HandlerRegistry
  // @complexity: high
  //
  // Verification items (one table-driven test; rows A run concurrently via Promise.all on separate pooled connections, rows B run in order):
  // - A1: 10 identical proposals with 10 distinct requesterKey while F is running -> 1 task, 10 subscribers, task+tool-call reservation counted once, 1 TaskQueued event, 9 results `subscribed` with F's taskId
  // - A2: two transactions propose the crossed edges (A waits B, B waits A) -> exactly one `accepted`, the other `rejected: wait_cycle` with the cycle's task list; A and B statuses unchanged
  // - B1: A -> B -> C chain, C depends on A -> rejected `wait_cycle`; B2: self-dependency -> rejected `self_dependency`; B3: dependency from another investigation -> rejected `unknown_dependency`
  // - B4: remaining 2 tool calls vs a task needing 3 -> rejected `budget_exhausted` (details.limit = tool_calls); B5: maxTasks reached -> rejected `budget_exhausted` (details.limit = tasks); earlier tasks still claimable
  // - B6: F succeeded on snapshot S1, same spec with S2 -> new task; a key whose task is failed or cancelled -> new task (spike A1: not reused)
  // - B7: dependency already failed (or cancelled) -> task created at once `cancelled` with class dependency_failed, direct and root cause set; B8: waits_for target already succeeded -> task goes straight back to queued
  // - B9 (wiring row for AC-02.2): unknown workflowType -> rejected `unknown_workflow`; row counts of tasks, dependencies, subscribers and the investigation's reservation counters are identical before and after
  // - A3 (no budget overrun under concurrency): 6 concurrent proposals of distinct keys against maxTasks = 3 -> exactly 3 created, 3 rejected `budget_exhausted`
  //   (limit = tasks), tasks_reserved = 3. The dedup rows are also held by the partial UNIQUE alone; this row is the one that needs the investigation lock
  // - B2 also through `TaskContext.registerWait` on the task's own id -> `self_dependency`, nothing written
  // - every rejection row asserts zero new rows in research_tasks / research_task_dependencies / research_task_subscribers / research_events and unchanged `tasks_reserved`, `tool_calls_reserved`
  describe('INT-1', () => {
    const LATCH_MS = 15_000;
    const workflowType = uniqueWorkflowType('int1');
    const resourceId = newUser();

    /** Behaviour of the tasks whose `input.key` names it; any other task completes at once. */
    const scripts = new Map<
      string,
      (ctx: TaskContext) => Promise<HandlerResult>
    >();
    /** Handler invocations by `input.key`. */
    const runs = new Map<string, number>();
    const opened: Latch[] = [];
    const gate = (): Latch => {
      const gateLatch = latch();
      opened.push(gateLatch);
      return gateLatch;
    };
    const handler = testHandler(workflowType, (ctx) => {
      const key = typeof ctx.input.key === 'string' ? ctx.input.key : '';
      runs.set(key, (runs.get(key) ?? 0) + 1);
      const script = scripts.get(key);
      return script ? script(ctx) : Promise.resolve(completed());
    });

    let runtime: RuntimeHarness;
    let threadId: string;

    beforeAll(async () => {
      runtime = await createRuntimeHarness({
        handlers: [handler],
        // Room for the concurrent rows: ten admissions and two registerWait on their own connections.
        runtime: { concurrency: 4, dbPoolMax: 12 },
      });
      threadId = await runtime.createThread(resourceId);
    });

    afterAll(async () => {
      for (const open of opened) open.release();
      try {
        await runtimeWorkSettled([workflowType], LATCH_MS);
      } finally {
        await runtime?.close();
        await closeRuntimeDb();
      }
    }, 2 * LATCH_MS);

    async function newInvestigation(
      label: string,
      budget: { maxTasks: number; maxToolCalls: number },
    ): Promise<string> {
      const { investigationId } = await runtime.investigations.create({
        resourceId,
        threadId,
        query: `INT-1 ${label}`,
        budget,
      });
      return investigationId;
    }

    function spec(
      investigationId: string,
      key: string,
      options: {
        dependsOn?: string[];
        maxToolCalls?: number;
        snapshot?: string;
        workflowType?: string;
      } = {},
    ): TaskSpec {
      const base = taskSpec({
        investigationId,
        workflowType: options.workflowType ?? workflowType,
        input: { key },
        dependsOn: options.dependsOn,
      });
      return {
        ...base,
        inputRefs: options.snapshot
          ? [{ kind: 'fixture', ref: 'page-1', snapshot: options.snapshot }]
          : [],
        budget: {
          ...base.budget,
          maxToolCalls: options.maxToolCalls ?? base.budget.maxToolCalls,
        },
      };
    }

    async function create(proposal: TaskSpec): Promise<string> {
      const result = await runtime.scheduler.propose(
        proposal,
        'int1-requester',
      );
      if (result.outcome !== 'created') {
        throw new Error(`task not created: ${JSON.stringify(result)}`);
      }
      return result.taskId;
    }

    async function statusOf(taskId: string): Promise<string | undefined> {
      const [row] = await query<{ status: string }>(
        'SELECT status FROM app.research_tasks WHERE task_id = $1',
        [taskId],
      );
      return row?.status;
    }

    async function settledAs(taskId: string, status: string): Promise<void> {
      await vi.waitFor(
        async () => {
          expect(await statusOf(taskId)).toBe(status);
        },
        { timeout: LATCH_MS, interval: 25 },
      );
    }

    /** Everything an admission or an edge write adds to the investigation. */
    async function footprint(investigationId: string) {
      const [row] = await query<{
        tasks: number;
        edges: number;
        subscribers: number;
        events: number;
        tasksReserved: number;
        toolCallsReserved: number;
      }>(
        `SELECT
           (SELECT count(*)::int FROM app.research_tasks WHERE investigation_id = $1) AS tasks,
           (SELECT count(*)::int FROM app.research_task_dependencies WHERE investigation_id = $1) AS edges,
           (SELECT count(*)::int FROM app.research_task_subscribers s
              JOIN app.research_tasks t ON t.task_id = s.task_id
             WHERE t.investigation_id = $1) AS subscribers,
           (SELECT count(*)::int FROM app.research_events WHERE investigation_id = $1) AS events,
           i.tasks_reserved AS "tasksReserved", i.tool_calls_reserved AS "toolCallsReserved"
         FROM app.research_investigations i WHERE i.investigation_id = $1`,
        [investigationId],
      );
      return row;
    }

    /** Runs `act` and asserts it added no task, edge, subscriber, event or reservation. */
    async function writesNothing<T>(
      investigationId: string,
      act: () => Promise<T>,
    ): Promise<T> {
      const before = await footprint(investigationId);
      const result = await act();
      expect(await footprint(investigationId)).toEqual(before);
      return result;
    }

    function eventsOfTask(
      taskId: string,
    ): Promise<{ type: string; reason: string | null }[]> {
      return query(
        `SELECT type, payload->>'reason' AS reason
           FROM app.research_events WHERE task_id = $1 ORDER BY seq`,
        [taskId],
      );
    }

    const waitResult = (taskIds: string[]): HandlerResult => ({
      ...completed(),
      kind: 'wait',
      waitFor: taskIds,
    });

    it('INT-1 A1: ten identical concurrent proposals admit one task with ten subscribers and one reservation; a proposal while it runs subscribes; the handler runs once', async () => {
      const investigationId = await newInvestigation('A1', {
        maxTasks: 5,
        maxToolCalls: 10,
      });
      const started = gate();
      const release = gate();
      scripts.set('a1-F', async (ctx) => {
        started.release();
        await release.promise;
        await ctx.reserveToolCall('fixture.read', false);
        const ref = await ctx.putEvidence(
          evidenceInput('a1-page', new Uint8Array([1, 2, 3])),
        );
        return completed({ evidenceRefs: [ref.evidenceId] });
      });
      const fSpec = spec(investigationId, 'a1-F');

      // AC-06.2: one task, ten subscribers, the reservation counted once.
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          runtime.scheduler.propose(fSpec, `int1-a1-${i}`),
        ),
      );
      expect(results.map((result) => result.outcome).sort()).toEqual([
        'created',
        ...Array.from({ length: 9 }, () => 'subscribed'),
      ]);
      const taskIds = new Set(
        results.map((result) =>
          result.outcome === 'rejected' ? 'rejected' : result.taskId,
        ),
      );
      expect(taskIds.size).toBe(1);
      const [f] = taskIds;
      expect(await footprint(investigationId)).toMatchObject({
        tasks: 1,
        edges: 0,
        subscribers: 10,
        tasksReserved: 1,
        toolCallsReserved: 2,
      });
      expect(
        (await eventsOf(investigationId)).filter(
          (event) => event.type === 'TaskQueued',
        ),
      ).toHaveLength(1);

      // AC-06.1: while F runs, the same request subscribes to F.
      await within(started.promise, LATCH_MS, 'F to start');
      expect(await runtime.scheduler.propose(fSpec, 'int1-a1-late')).toEqual({
        outcome: 'subscribed',
        taskId: f,
        status: 'running',
      });
      expect(await footprint(investigationId)).toMatchObject({
        tasks: 1,
        subscribers: 11,
        tasksReserved: 1,
        toolCallsReserved: 2,
      });

      release.release();
      await settledAs(f, 'succeeded');
      expect(runs.get('a1-F')).toBe(1);
      expect((await tasksOf(investigationId)).get(f)?.outputRefs).toHaveLength(
        1,
      );
    }, 30_000);

    it('INT-1 A3: concurrent proposals of distinct tasks never reserve past the task limit', async () => {
      const investigationId = await newInvestigation('A3', {
        maxTasks: 3,
        maxToolCalls: 100,
      });

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          runtime.scheduler.propose(
            spec(investigationId, `a3-${i}`),
            'int1-a3',
          ),
        ),
      );

      expect(results.map((result) => result.outcome).sort()).toEqual([
        'created',
        'created',
        'created',
        'rejected',
        'rejected',
        'rejected',
      ]);
      expect(results.filter((result) => result.outcome === 'rejected')).toEqual(
        Array.from({ length: 3 }, () => ({
          outcome: 'rejected',
          reason: 'budget_exhausted',
          details: { limit: 'tasks', max: 3, reserved: 3 },
        })),
      );
      expect(await footprint(investigationId)).toMatchObject({
        tasks: 3,
        subscribers: 3,
        tasksReserved: 3,
        toolCallsReserved: 6,
      });
    }, 30_000);

    it('INT-1 A2: crossed waits registered concurrently accept exactly one edge and reject the other as a cycle; both tasks keep running', async () => {
      const investigationId = await newInvestigation('A2', {
        maxTasks: 5,
        maxToolCalls: 10,
      });
      const keys = ['a2-A', 'a2-B'] as const;
      type Key = (typeof keys)[number];
      const other: Record<Key, Key> = { 'a2-A': 'a2-B', 'a2-B': 'a2-A' };
      const ids = new Map<Key, string>();
      const waits = new Map<Key, RegisterWaitResult>();
      const go = gate();
      const started = { 'a2-A': gate(), 'a2-B': gate() };
      const registered = { 'a2-A': gate(), 'a2-B': gate() };
      const release = { 'a2-A': gate(), 'a2-B': gate() };
      for (const key of keys) {
        scripts.set(key, async (ctx) => {
          // A later attempt (a wake-up) has nothing left to do.
          if (ctx.attempt > 1) return completed();
          started[key].release();
          await go.promise;
          const target = ids.get(other[key]) ?? 'missing';
          const result = await ctx.registerWait([target]);
          waits.set(key, result);
          registered[key].release();
          await release[key].promise;
          return result.outcome === 'ok' ? waitResult([target]) : completed();
        });
      }
      for (const key of keys) {
        ids.set(key, await create(spec(investigationId, key)));
      }
      for (const key of keys) {
        await within(started[key].promise, LATCH_MS, `${key} to start`);
      }

      go.release();
      for (const key of keys) {
        await within(registered[key].promise, LATCH_MS, `${key} to register`);
      }

      const accepted = keys.filter((key) => waits.get(key)?.outcome === 'ok');
      expect(accepted).toHaveLength(1);
      const [winnerKey] = accepted;
      const loserKey = other[winnerKey];
      const winner = ids.get(winnerKey) ?? '';
      const loser = ids.get(loserKey) ?? '';
      // AC-07.1: the second edge names the cycle, starting at the task that asked.
      expect(waits.get(loserKey)).toEqual({
        outcome: 'rejected',
        reason: 'wait_cycle',
        details: { cycle: [loser, winner] },
      });
      expect(
        await query(
          `SELECT task_id AS "taskId", depends_on_task_id AS "targetId", kind
             FROM app.research_task_dependencies WHERE investigation_id = $1`,
          [investigationId],
        ),
      ).toEqual([{ taskId: winner, targetId: loser, kind: 'waits_for' }]);
      expect([await statusOf(winner), await statusOf(loser)]).toEqual([
        'running',
        'running',
      ]);

      // The accepted wait holds while its target runs: `waiting` with its condition.
      release[winnerKey].release();
      await settledAs(winner, 'waiting');
      const [waiting] = await query<{ waitCondition: unknown }>(
        'SELECT wait_condition AS "waitCondition" FROM app.research_tasks WHERE task_id = $1',
        [winner],
      );
      expect(waiting.waitCondition).toEqual({ waitFor: [loser] });
      expect((await eventsOfTask(winner)).map((event) => event.type)).toEqual([
        'TaskQueued',
        'TaskStarted',
        'TaskWaiting',
      ]);
      release[loserKey].release();
      await settledAs(loser, 'succeeded');
    }, 30_000);

    it('INT-1 B1, B2: a wait closing a dependency chain is rejected as a cycle and a wait on itself as a self-dependency; neither writes, and the chain runs on', async () => {
      const investigationId = await newInvestigation('B1', {
        maxTasks: 5,
        maxToolCalls: 10,
      });
      const go = gate();
      let a = 'missing';
      const waits: RegisterWaitResult[] = [];
      const footprints: Awaited<ReturnType<typeof footprint>>[] = [];
      scripts.set('b1-C', async (ctx) => {
        await go.promise;
        footprints.push(await footprint(investigationId));
        waits.push(await ctx.registerWait([ctx.taskId]));
        waits.push(await ctx.registerWait([a]));
        footprints.push(await footprint(investigationId));
        return completed();
      });
      // A depends on B, B on C: C runs first.
      const c = await create(spec(investigationId, 'b1-C'));
      const b = await create(spec(investigationId, 'b1-B', { dependsOn: [c] }));
      a = await create(spec(investigationId, 'b1-A', { dependsOn: [b] }));

      go.release();
      await settledAs(a, 'succeeded');
      expect(waits).toEqual([
        // AC-07.3
        {
          outcome: 'rejected',
          reason: 'self_dependency',
          details: { taskId: c },
        },
        // AC-07.2: C → A → B → C
        {
          outcome: 'rejected',
          reason: 'wait_cycle',
          details: { cycle: [c, a, b] },
        },
      ]);
      expect(footprints[1]).toEqual(footprints[0]);
      expect([await statusOf(b), await statusOf(c)]).toEqual([
        'succeeded',
        'succeeded',
      ]);

      // AC-07.3 at admission: the request depends on the task with its own key, which has already succeeded;
      // the self_dependency check takes precedence over dedup subscription.
      expect(
        await writesNothing(investigationId, () =>
          runtime.scheduler.propose(
            spec(investigationId, 'b1-C', { dependsOn: [c] }),
            'int1-b2',
          ),
        ),
      ).toEqual({
        outcome: 'rejected',
        reason: 'self_dependency',
        details: { taskId: c },
      });
    }, 30_000);

    it('INT-1 B3, B4, B5, B9: unknown dependency, tool-call budget, task limit and unknown workflow are rejected without writing; the admitted task still runs', async () => {
      const investigationId = await newInvestigation('B4', {
        maxTasks: 2,
        maxToolCalls: 4,
      });
      const elsewhere = await newInvestigation('B3 other', {
        maxTasks: 1,
        maxToolCalls: 2,
      });
      const foreign = await create(spec(elsewhere, 'b3-foreign'));
      const started = gate();
      const release = gate();
      scripts.set('b4-held', async () => {
        started.release();
        await release.promise;
        return completed();
      });
      const held = await create(spec(investigationId, 'b4-held'));
      await within(started.promise, LATCH_MS, 'the admitted task to start');

      // AC-04.3
      expect(
        await writesNothing(investigationId, () =>
          runtime.scheduler.propose(
            spec(investigationId, 'b3-dependent', { dependsOn: [foreign] }),
            'int1-b3',
          ),
        ),
      ).toEqual({
        outcome: 'rejected',
        reason: 'unknown_dependency',
        details: { taskIds: [foreign] },
      });
      // AC-05.1: 2 of 4 tool calls left, the task needs 3.
      expect(
        await writesNothing(investigationId, () =>
          runtime.scheduler.propose(
            spec(investigationId, 'b4-costly', { maxToolCalls: 3 }),
            'int1-b4',
          ),
        ),
      ).toEqual({
        outcome: 'rejected',
        reason: 'budget_exhausted',
        details: { limit: 'tool_calls', max: 4, reserved: 2, requested: 3 },
      });
      // AC-05.2: a second task takes the last of the task limit, a third is refused.
      const last = await create(
        spec(investigationId, 'b5-last', { maxToolCalls: 1 }),
      );
      await settledAs(last, 'succeeded');
      expect(
        await writesNothing(investigationId, () =>
          runtime.scheduler.propose(
            spec(investigationId, 'b5-over', { maxToolCalls: 1 }),
            'int1-b5',
          ),
        ),
      ).toEqual({
        outcome: 'rejected',
        reason: 'budget_exhausted',
        details: { limit: 'tasks', max: 2, reserved: 2 },
      });
      // AC-02.2, wiring only
      const unregistered = uniqueWorkflowType('int1-unregistered');
      expect(
        await writesNothing(investigationId, () =>
          runtime.scheduler.propose(
            spec(investigationId, 'b9', { workflowType: unregistered }),
            'int1-b9',
          ),
        ),
      ).toEqual({
        outcome: 'rejected',
        reason: 'unknown_workflow',
        details: { workflowType: unregistered, workflowVersion: 1 },
      });
      expect([runs.has('b4-costly'), runs.has('b5-over')]).toEqual([
        false,
        false,
      ]);

      release.release();
      await settledAs(held, 'succeeded');
    }, 30_000);

    it('INT-1 B6, B7: a succeeded key is reused only for the same snapshot, a failed or cancelled key admits a new task, and a task on a failed dependency is admitted cancelled with its cause', async () => {
      const investigationId = await newInvestigation('B6', {
        maxTasks: 10,
        maxToolCalls: 20,
      });
      scripts.set('b6-failing', () =>
        Promise.resolve({
          ...completed(),
          kind: 'failed',
          failure: {
            class: 'tool_error',
            code: 'fixture_error',
            message: 'The fixture failed',
            cause: null,
            attempt: 1,
            toolCalls: 0,
            retries: 0,
          },
        }),
      );

      // AC-06.4
      const s1 = await create(
        spec(investigationId, 'b6-F', { snapshot: 'S1' }),
      );
      await settledAs(s1, 'succeeded');
      expect(
        await runtime.scheduler.propose(
          spec(investigationId, 'b6-F', { snapshot: 'S1' }),
          'int1-b6-again',
        ),
      ).toEqual({ outcome: 'subscribed', taskId: s1, status: 'succeeded' });
      const s2 = await create(
        spec(investigationId, 'b6-F', { snapshot: 'S2' }),
      );
      expect(s2).not.toBe(s1);
      await settledAs(s2, 'succeeded');
      expect(runs.get('b6-F')).toBe(2);

      // spike A1: a failed key is not reused.
      const failing = await create(spec(investigationId, 'b6-failing'));
      await settledAs(failing, 'failed');
      const retried = await create(spec(investigationId, 'b6-failing'));
      expect(retried).not.toBe(failing);
      await settledAs(retried, 'failed');

      // AC-RT-6 (admission half): admitted at once cancelled, the root cause carried down.
      const d = await runtime.scheduler.propose(
        spec(investigationId, 'b7-D', { dependsOn: [failing] }),
        'int1-b7',
      );
      expect(d).toMatchObject({ outcome: 'created', status: 'cancelled' });
      const dId = d.outcome === 'created' ? d.taskId : 'missing';
      const e = await runtime.scheduler.propose(
        spec(investigationId, 'b7-E', { dependsOn: [dId] }),
        'int1-b7',
      );
      expect(e).toMatchObject({ outcome: 'created', status: 'cancelled' });
      const eId = e.outcome === 'created' ? e.taskId : 'missing';
      const failures = await query<{ taskId: string; failureReason: unknown }>(
        `SELECT task_id AS "taskId", failure_reason AS "failureReason"
           FROM app.research_tasks WHERE task_id = ANY($1::uuid[])`,
        [[dId, eId]],
      );
      expect(
        Object.fromEntries(
          failures.map((row) => [row.taskId, row.failureReason]),
        ),
      ).toEqual({
        [dId]: expect.objectContaining({
          class: 'dependency_failed',
          dependencyTaskId: failing,
          rootCauseTaskId: failing,
        }),
        [eId]: expect.objectContaining({
          class: 'dependency_failed',
          dependencyTaskId: dId,
          rootCauseTaskId: failing,
        }),
      });
      expect(await eventsOfTask(dId)).toEqual([
        { type: 'TaskCancelled', reason: null },
      ]);
      // A cancelled key is not reused either.
      const again = await runtime.scheduler.propose(
        spec(investigationId, 'b7-D', { dependsOn: [failing] }),
        'int1-b7-again',
      );
      expect(again).toMatchObject({ outcome: 'created', status: 'cancelled' });
      expect(again.outcome === 'created' ? again.taskId : dId).not.toBe(dId);
      expect([runs.has('b7-D'), runs.has('b7-E')]).toEqual([false, false]);
    }, 30_000);

    it('INT-1 B8: a wait on tasks that have all finished returns the task to queued at once, and its next attempt sees them upstream', async () => {
      const investigationId = await newInvestigation('B8', {
        maxTasks: 5,
        maxToolCalls: 10,
      });
      const target = await create(spec(investigationId, 'b8-T'));
      await settledAs(target, 'succeeded');
      const upstream: (readonly UpstreamTask[])[] = [];
      scripts.set('b8-W', async (ctx) => {
        upstream.push(ctx.upstream);
        if (ctx.attempt > 1) return completed();
        const registered = await ctx.registerWait([target]);
        if (registered.outcome !== 'ok') {
          throw new Error(`wait refused: ${JSON.stringify(registered)}`);
        }
        return waitResult([target]);
      });

      const w = await create(spec(investigationId, 'b8-W'));
      await settledAs(w, 'succeeded');
      expect(await eventsOfTask(w)).toEqual([
        { type: 'TaskQueued', reason: 'admitted' },
        { type: 'TaskStarted', reason: null },
        { type: 'TaskQueued', reason: 'woken' },
        { type: 'TaskStarted', reason: null },
        { type: 'TaskSucceeded', reason: null },
      ]);
      expect(upstream).toEqual([
        [],
        [
          {
            taskId: target,
            kind: 'waits_for',
            status: 'succeeded',
            outputRefs: [],
          },
        ],
      ]);
      expect((await tasksOf(investigationId)).get(w)?.attempt).toBe(2);
    }, 30_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Dependency-driven execution and the event envelope
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-04.1: "Given задача B зависит от A, When A ещё в queued или running, Then B не стартовала; When A перешла в succeeded, Then B стартует и получает ссылки на выходы A."
  // AC-18.1: "Given две готовые независимые задачи и лимит конкурентности ≥ 2, Then вторая стартует, не дожидаясь завершения первой."
  // AC-03.3: "Given fetch-задача завершилась succeeded, Then её evidence имеет статус observed; успех задачи не выставляет никакого другого статуса знания."
  // AC-09.1: "Given результат инструмента объёмом из AC-12.4, Then событие о его сохранении содержит ссылку на результат, а размер события не зависит от размера результата."
  // AC-09.3: "Given цепочка «задача → вызов → evidence → зависимая задача», Then по causationId и correlationId восстанавливается порядок причин от первого события до последнего."
  // Use cases: UC-6, UC-5 (observed half), UC-13. EARS: When / While.
  // Design flow: Flow 2 (Dispatcher claim, fenced TaskContext, guarded terminal write, dependent claim), Flow 1 events, EventEnvelope causal chain.
  //
  // Primary failure mode (turns red when): the Dispatcher claims B before A is `succeeded` (readiness query ignores a dependency), serialises independent tasks (slot logic), writes the terminal state
  // without its event and delivery rows in one transaction, or puts evidence bytes into the event payload instead of `payloadRef` (event size then grows with a 10 MiB result).
  // ROI: 8.9 | Business Value: 10 (core execution path every later feature builds on) | Frequency: 9 | Legal: false | Defect Detection: 8
  // Behavior: C (independent) and A run in parallel with concurrency 2, B waits for A -> B starts after A's TaskSucceeded, sees A's outputRefs in `ctx.upstream`; events form one causal chain; evidence is `observed`
  // @category: core-functionality
  // @dependency: Dispatcher, TaskContext, EvidenceStore, EventLog, OutboxRelay, SchedulerConsumer, Postgres (bytea), test handlers with latches
  // @complexity: high
  //
  // Verification items:
  // - Setup: B depends on A; C independent; RUNTIME_CONCURRENCY = 2; handlers block on latches released by the test (no sleeps)
  // - While A is running: C has reached `running` before A finishes; B is still `queued` (TaskStarted for B absent)
  // - A stores one 10 MiB evidence (distinct non-text bytes, including 0x00) and returns completed: A is `succeeded`, `output_refs` = [that evidenceId]; reading it back returns the same sha256 and size
  // - B starts only after A's TaskSucceeded; its `ctx.upstream` lists A with status `succeeded` and A's outputRefs
  // - Every evidence written has knowledge_status `observed`; no other knowledge status appears anywhere in the investigation
  // - The EvidenceStored event carries `payloadRef = evidence:<id>` and a serialized size far below 8 KiB regardless of the 10 MiB content (compare against a run storing 1 KiB: equal event size class)
  // - Following `causationId` from B's TaskStarted reaches A's TaskSucceeded, then EvidenceStored, ToolCallReserved, A's TaskStarted; all events share the investigation's `correlationId`
  // - AC-03.4 (conditional CHECK of research_evidence): a direct insert of `supported` evidence without `scope` -> error 23514, 0 rows before and after
  //   (`putEvidence` writes only `observed`; no other test exercises this CHECK)
  describe('INT-2', () => {
    const TEN_MIB = 10 * 1024 * 1024;
    const ONE_KIB = 1024;
    const EVENT_SIZE_CLASS_BYTES = 64;
    const LATCH_MS = 15_000;
    const workflowType = uniqueWorkflowType('int2');
    const resourceId = newUser();
    /** Distinct, non-text bytes including 0x00 (131 is odd: every byte value occurs). */
    const patternBytes = (size: number): Uint8Array<ArrayBuffer> => {
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i++) bytes[i] = (i * 131 + 7) & 0xff;
      return bytes;
    };
    const bigContent = patternBytes(TEN_MIB);
    const smallContent = patternBytes(ONE_KIB);
    const sha256 = (bytes: Uint8Array) =>
      createHash('sha256').update(bytes).digest('hex');

    const gate = {
      aStarted: latch(),
      releaseA: latch(),
      cStarted: latch(),
      releaseC: latch(),
      dStarted: latch(),
      releaseD: latch(),
      bStarted: latch(),
    };
    const seen: {
      bigRef?: EvidenceRef;
      smallRef?: EvidenceRef;
      bUpstream?: readonly UpstreamTask[];
    } = {};

    // A: reserves a call and stores the 10 MiB evidence once released. C: stores 1 KiB, then
    // waits. D: independent and younger than B — the task a freed slot must take while B's
    // dependency still runs.
    const handler = testHandler(workflowType, async (ctx) => {
      switch (ctx.input.role) {
        case 'A': {
          gate.aStarted.release();
          await gate.releaseA.promise;
          await ctx.reserveToolCall('fixture.read', false);
          seen.bigRef = await ctx.putEvidence(
            evidenceInput('page-big', bigContent),
          );
          return completed({ evidenceRefs: [seen.bigRef.evidenceId] });
        }
        case 'C': {
          await ctx.reserveToolCall('fixture.read', false);
          seen.smallRef = await ctx.putEvidence(
            evidenceInput('page-small', smallContent),
          );
          gate.cStarted.release();
          await gate.releaseC.promise;
          return completed({ evidenceRefs: [seen.smallRef.evidenceId] });
        }
        case 'D':
          gate.dStarted.release();
          await gate.releaseD.promise;
          return completed();
        case 'B':
          seen.bUpstream = ctx.upstream;
          gate.bStarted.release();
          return completed();
        default:
          return completed();
      }
    });

    let runtime: RuntimeHarness;
    let threadId: string;

    beforeAll(async () => {
      runtime = await createRuntimeHarness({
        handlers: [handler],
        runtime: { concurrency: 2 },
      });
      threadId = await runtime.createThread(resourceId);
    });

    afterAll(async () => {
      for (const open of Object.values(gate)) open.release();
      try {
        await runtimeWorkSettled([workflowType], LATCH_MS);
      } finally {
        await runtime?.close();
        await closeRuntimeDb();
      }
    }, 2 * LATCH_MS);

    async function propose(
      investigationId: string,
      role: string,
      dependsOn: string[] = [],
    ): Promise<string> {
      const result = await runtime.scheduler.propose(
        taskSpec({ investigationId, workflowType, input: { role }, dependsOn }),
        `int2-${role}`,
      );
      if (result.outcome !== 'created') {
        throw new Error(`task ${role} not created: ${JSON.stringify(result)}`);
      }
      return result.taskId;
    }

    it("INT-2: independent tasks run in parallel, a dependent task starts only after its dependency succeeds with that dependency's outputs, and events form one causal chain with payloads by reference", async () => {
      const { investigationId } = await runtime.investigations.create({
        resourceId,
        threadId,
        query: 'INT-2 execution',
        budget: { maxTasks: 10, maxToolCalls: 20 },
      });
      // Creation order A, C, B, D: a claim takes the oldest ready task.
      const a = await propose(investigationId, 'A');
      const c = await propose(investigationId, 'C');
      const b = await propose(investigationId, 'B', [a]);
      const d = await propose(investigationId, 'D');
      const statuses = async (ids: string[]) => {
        const tasks = await tasksOf(investigationId);
        return ids.map((id) => tasks.get(id)?.status);
      };

      // AC-18.1: with 2 slots, C reaches running while A is still running.
      await within(gate.aStarted.promise, LATCH_MS, 'A to start');
      await within(gate.cStarted.promise, LATCH_MS, 'C to start while A runs');
      expect(await statuses([a, c, b, d])).toEqual([
        'running',
        'running',
        'queued',
        'queued',
      ]);

      // AC-04.1: C frees a slot; it goes to D, younger than B, because B's dependency still runs.
      gate.releaseC.release();
      await within(gate.dStarted.promise, LATCH_MS, 'D to take the freed slot');
      expect(await statuses([a, b, d])).toEqual([
        'running',
        'queued',
        'running',
      ]);
      const startsOfB = (await eventsOf(investigationId)).filter(
        (event) => event.type === 'TaskStarted' && event.taskId === b,
      );
      expect(startsOfB).toEqual([]);

      // A succeeds with its output; B then starts and sees it in ctx.upstream.
      gate.releaseA.release();
      await within(gate.bStarted.promise, LATCH_MS, 'B to start after A');
      gate.releaseD.release();
      await vi.waitFor(
        async () => {
          expect(await statuses([a, b, c, d])).toEqual([
            'succeeded',
            'succeeded',
            'succeeded',
            'succeeded',
          ]);
        },
        { timeout: LATCH_MS, interval: 50 },
      );
      const bigId = seen.bigRef?.evidenceId ?? 'missing-big';
      const smallId = seen.smallRef?.evidenceId ?? 'missing-small';
      expect((await tasksOf(investigationId)).get(a)?.outputRefs).toEqual([
        bigId,
      ]);
      expect(seen.bUpstream).toEqual([
        {
          taskId: a,
          kind: 'depends_on',
          status: 'succeeded',
          outputRefs: [bigId],
        },
      ]);

      // The 10 MiB content reads back byte for byte.
      const stored = await runtime.evidence.get(bigId, resourceId);
      expect([stored.record.sha256, stored.record.byteSize]).toEqual([
        sha256(bigContent),
        10_485_760,
      ]);
      expect(sha256(stored.bytes)).toBe(sha256(bigContent));

      // AC-03.3: success sets no knowledge status other than observed.
      expect(
        Object.fromEntries(await knowledgeStatusesOf(investigationId)),
      ).toEqual({ [bigId]: 'observed', [smallId]: 'observed' });

      const events = await eventsOf(investigationId);
      const seqOf = (type: string, taskId: string) =>
        events.find((event) => event.type === type && event.taskId === taskId)
          ?.seq ?? Number.NaN;
      expect(seqOf('TaskStarted', b)).toBeGreaterThan(
        seqOf('TaskSucceeded', a),
      );

      // AC-09.1: EvidenceStored carries a reference; its size does not grow with the content.
      const evidenceStored = (taskId: string) =>
        events.find(
          (event) => event.type === 'EvidenceStored' && event.taskId === taskId,
        );
      expect([
        evidenceStored(a)?.payloadRef,
        evidenceStored(c)?.payloadRef,
      ]).toEqual([`evidence:${bigId}`, `evidence:${smallId}`]);
      const bigEventBytes = evidenceStored(a)?.payloadBytes ?? Number.NaN;
      const smallEventBytes = evidenceStored(c)?.payloadBytes ?? Number.NaN;
      expect(bigEventBytes).toBeLessThan(1024);
      // Same size class (evidence keys may differ in length), not proportional to 10 MiB.
      expect(Math.abs(bigEventBytes - smallEventBytes)).toBeLessThanOrEqual(
        EVENT_SIZE_CLASS_BYTES,
      );

      // AC-09.3: causationId leads from B's TaskStarted back to A's admission; one correlation.
      const byId = new Map(events.map((event) => [event.eventId, event]));
      const label = new Map([
        [a, 'A'],
        [b, 'B'],
      ]);
      const chain: string[] = [];
      let cursor = events.find(
        (event) => event.type === 'TaskStarted' && event.taskId === b,
      );
      while (cursor) {
        chain.push(`${cursor.type}:${label.get(cursor.taskId ?? '') ?? '?'}`);
        cursor = cursor.causationId ? byId.get(cursor.causationId) : undefined;
      }
      expect(chain).toEqual([
        'TaskStarted:B',
        'TaskSucceeded:A',
        'EvidenceStored:A',
        'ToolCallReserved:A',
        'TaskStarted:A',
        'TaskQueued:A',
      ]);
      const created = events.find(
        (event) => event.type === 'InvestigationCreated',
      );
      expect(new Set(events.map((event) => event.correlationId))).toEqual(
        new Set([created?.eventId]),
      );
    }, 30_000);

    it('INT-2: direct insert of supported evidence without scope is rejected', async () => {
      const { investigationId } = await runtime.investigations.create({
        resourceId,
        threadId,
        query: 'INT-2 conditional CHECK',
        budget: { maxTasks: 1, maxToolCalls: 2 },
      });
      const taskId = await propose(investigationId, 'check');
      const evidenceKey = `supported-without-scope-${randomUUID()}`;
      const countRows = async () => {
        const [row] = await query<{ count: string }>(
          'SELECT count(*) FROM app.research_evidence WHERE evidence_key = $1',
          [evidenceKey],
        );
        return row.count;
      };

      expect(await countRows()).toBe('0');
      const insert = query(
        `INSERT INTO app.research_evidence
           (evidence_id, investigation_id, task_id, evidence_key, written_by_attempt,
            knowledge_status, scope, basis, evidence_version, provenance, coverage)
         VALUES ($1, $2, $3, $4, 1, 'supported', NULL, 'basis', 1, '{}', '{}')`,
        [randomUUID(), investigationId, taskId, evidenceKey],
      );
      await expect(insert).rejects.toMatchObject({
        code: '23514',
        constraint: 'research_evidence_supported_check',
      });
      expect(await countRows()).toBe('0');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Only the live attempt writes: every way an attempt stops ends in its designated status
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-RT-1: "If попытка, чей lease перехвачен (меньший attempt или задача уже не running), пишет итог, evidence, checkpoint или резерв вызова, then система отклоняет запись и не меняет ни одной строки."
  // AC-RT-2: "If каждая попытка задачи прерывается истечением lease, then обработчик вызывается не больше RUNTIME_MAX_RECOVERIES + 1 раз, и следующее истечение lease записывает failed с классом recovery_exhausted."
  // AC-RT-5: "When процесс завершается штатно, исполняющиеся задачи возвращаются в queued без роста recovery_count, а пул закрывается после остановки воркеров."
  // AC-03.1: "Given задача в конечном состоянии (succeeded, failed, cancelled), When происходит попытка перевести её в running, Then переход отклонён, состояние не изменилось."
  // AC-03.2: "Given задача переводится в waiting без условия пробуждения, Then переход отклонён."
  // AC-19.1: "Given обработчик задачи работает дольше её дедлайна, Then задача failed с причиной «дедлайн», а независимые задачи завершаются как обычно."
  // AC-19.2: "Given задача исполнялась в момент гибели процесса, а процесс поднят уже после её дедлайна, Then после восстановления задача failed с причиной «дедлайн» и источник для неё больше не вызывается."
  // AC-19.3 (runtime half): "Given fetch-задача прервана по дедлайну, а лимиты повторов и вызовов не исчерпаны, Then повтора нет ... исход записан причиной «дедлайн»" (the source-call half belongs to mcp-source)
  // AC-20.1: "Given расследование с завершёнными и ожидающими задачами, When оно отменено, Then ожидающие задачи cancelled, evidence завершённых задач на месте."
  // AC-20.2 (runtime half): "Given fetch-задача в running ждёт ответа источника, When расследование отменено, Then задача cancelled, а после отмены источник не вызван ни разу" - here: reserveToolCall is refused after the cancel commit
  // AC-20.3: "Given задача завершилась succeeded до того, как отмена вступила в силу, Then она остаётся succeeded, а её evidence на месте."
  // Use cases: UC-E1, UC-E2 (lease half), UC-E5, UC-4, UC-15, UC-16. EARS: If-then / When.
  // Design flow: Flow 2 (guarded terminal write), Flow 3 (RecoverySweeper), Flow 4 (cancel), State Transitions (guard = source status + own attempt), Data Contract "Dispatcher: итог попытки".
  //
  // Primary failure mode (turns red when): one write path (terminal result, evidence, checkpoint, reserveToolCall, claim, waiting) lacks the `status = running AND attempt = own` guard or the `cancel_requested_at IS NULL` condition -
  // a zombie attempt or a post-cancel / post-deadline call then changes a row (double effect after recovery), or the poison task is retried forever, or the pool closes under a running worker.
  // ROI: 6.5 | Business Value: 9 (exactly-once effects) | Frequency: 7 | Legal: false | Defect Detection: 9
  // Behavior: a running attempt is stopped by cause X -> the task ends in the status and class designated for X, every later write by that attempt changes zero rows, an independent sibling task is unaffected
  // @category: core-functionality
  // @dependency: Dispatcher, RecoverySweeper, TaskContext (fenced API), InvestigationService.cancel, Runtime.stop, injected clock, Postgres
  // @complexity: high
  //
  // Verification items (table of causes; each row: stop cause -> final status/class -> late writes -> sibling):
  // - R1 lease lost, attempt superseded (UC-E1): lease of attempt 1 expires, sweeper requeues, attempt 2 claims; attempt 1 then writes terminal result, evidence, checkpoint, reserve -> all four rejected (warn `fenced`),
  //   zero rows and `state_version` unchanged for each; attempt 2's result accepted exactly once
  // - R2 poison (UC-E2, lease half): handler never returns and every attempt's lease expires -> handler invoked exactly RUNTIME_MAX_RECOVERIES + 1 times, next expiry writes `failed` class `recovery_exhausted`; a sibling task `succeeded`
  // - R3 deadline while running: handler outlasts `deadline_at` -> `failed` class `deadline` written without waiting for the handler, slot freed (one-slot app: the independent task `succeeded` while the handler is still held); the late `reserveToolCall` is refused; no retry attempt exists although `maxRetries` is 1
  // - R4 deadline already passed with no live worker (AC-19.2): task `running` with expired lease and `deadline_at` in the past, sweeper runs -> `failed` class `deadline`, test handler never invoked
  // - R5 cancel: investigation with a `succeeded` task (evidence stored), a `queued` task and a `running` task -> after cancel: queued and running are `cancelled`, succeeded stays with its evidence, `reserveToolCall` from the running attempt is refused
  //   (`cancel_requested`) right after the commit; a second cancel is a no-op (no new event)
  // - R6 guards on settled tasks: claim of `succeeded`, `failed`, `cancelled` tasks and a transition to `waiting` with an empty wait condition -> zero rows changed, `state_version` unchanged
  // - R7 graceful shutdown: `runtime.stop()` then the pool `close()` with a running task -> `queued`, `recovery_count` unchanged, no "pool closed" errors from any worker; variant: cancel committed while closing -> `cancelled`
  // - Every row asserts the rejected writes via before/after row-version snapshots, not via logs
  describe('INT-3', () => {
    const LATCH_MS = 15_000;
    /** `RUNTIME_MAX_RECOVERIES` of the test app: a poison task runs MAX_RECOVERIES + 1 times. */
    const MAX_RECOVERIES = 2;
    /** The smallest deadline a TaskBudget allows. */
    const DEADLINE_MS = 1_000;
    const workflowType = uniqueWorkflowType('int3');
    const resourceId = newUser();

    /** Behaviour of the tasks whose `input.key` names it; any other task completes at once. */
    const scripts = new Map<
      string,
      (ctx: TaskContext) => Promise<HandlerResult>
    >();
    /** Handler invocations by `input.key`. */
    const runs = new Map<string, number>();
    const opened: Latch[] = [];
    const gate = (): Latch => {
      const gateLatch = latch();
      opened.push(gateLatch);
      return gateLatch;
    };
    const runScript = (ctx: TaskContext): Promise<HandlerResult> => {
      const key = typeof ctx.input.key === 'string' ? ctx.input.key : '';
      runs.set(key, (runs.get(key) ?? 0) + 1);
      const script = scripts.get(key);
      return script ? script(ctx) : Promise.resolve(completed());
    };
    const handler = testHandler(workflowType, runScript);

    let runtime: RuntimeHarness;
    let threadId: string;
    beforeAll(async () => {
      runtime = await createRuntimeHarness({
        handlers: [handler],
        // A lease is lost only when a test moves `lease_expires_at` back: no heartbeat beats
        // within a test, the reaper runs every 50 ms. Every hung attempt holds a slot.
        runtime: {
          concurrency: 8,
          dbPoolMax: 10,
          leaseMs: 60_000,
          heartbeatMs: 60_000,
          reaperMs: 50,
          maxRecoveries: MAX_RECOVERIES,
          shutdownGraceMs: 100,
        },
      });
      threadId = await runtime.createThread(resourceId);
      await createClientTable();
    });

    afterAll(async () => {
      for (const open of opened) open.release();
      try {
        await runtimeWorkSettled([workflowType], LATCH_MS);
      } finally {
        await runtime?.close();
        await dropClientTable();
        await closeRuntimeDb();
      }
    }, 2 * LATCH_MS);

    async function newInvestigation(
      label: string,
      owner: { app: RuntimeHarness; threadId: string; resourceId: string } = {
        app: runtime,
        threadId,
        resourceId,
      },
    ): Promise<string> {
      const { investigationId } = await owner.app.investigations.create({
        resourceId: owner.resourceId,
        threadId: owner.threadId,
        query: `INT-3 ${label}`,
        budget: { maxTasks: 10, maxToolCalls: 20 },
      });
      return investigationId;
    }

    function spec(
      investigationId: string,
      key: string,
      options: {
        dependsOn?: string[];
        deadlineMs?: number;
        maxRetries?: number;
        workflowType?: string;
      } = {},
    ): TaskSpec {
      const base = taskSpec({
        investigationId,
        workflowType: options.workflowType ?? workflowType,
        input: { key },
        dependsOn: options.dependsOn,
      });
      return {
        ...base,
        budget: {
          ...base.budget,
          deadlineMs: options.deadlineMs ?? base.budget.deadlineMs,
          maxRetries: options.maxRetries ?? base.budget.maxRetries,
        },
      };
    }

    async function create(
      proposal: TaskSpec,
      app: RuntimeHarness = runtime,
    ): Promise<string> {
      const result = await app.scheduler.propose(proposal, 'int3-requester');
      if (result.outcome !== 'created') {
        throw new Error(`task not created: ${JSON.stringify(result)}`);
      }
      return result.taskId;
    }

    interface TaskState {
      status: string;
      attempt: number;
      recoveryCount: number;
      cancelRequested: boolean;
      toolCalls: number;
      failureClass: string | null;
      failureCode: string | null;
      failureMessage: string | null;
      answer: string | null;
    }

    async function taskState(taskId: string): Promise<TaskState> {
      const [row] = await query<TaskState>(
        `SELECT status, attempt, recovery_count AS "recoveryCount",
                cancel_requested_at IS NOT NULL AS "cancelRequested",
                tool_calls_used + attempt_tool_calls AS "toolCalls",
                failure_reason->>'class' AS "failureClass", failure_reason->>'code' AS "failureCode",
                failure_reason->>'message' AS "failureMessage", outcome->>'answerOrDelta' AS answer
           FROM app.research_tasks WHERE task_id = $1`,
        [taskId],
      );
      return row;
    }

    /** The whole task row as JSON, `state_version` included. */
    async function taskRow(taskId: string): Promise<unknown> {
      const [row] = await query<{ row: unknown }>(
        'SELECT to_jsonb(t) AS row FROM app.research_tasks t WHERE task_id = $1',
        [taskId],
      );
      return row.row;
    }

    async function settledAs(taskId: string, status: string): Promise<void> {
      await vi.waitFor(
        async () => {
          expect((await taskState(taskId)).status).toBe(status);
        },
        { timeout: LATCH_MS, interval: 25 },
      );
    }

    /** Every research_* row of the investigation as JSON, `state_version` and delivery counters included. */
    async function snapshot(investigationId: string): Promise<unknown> {
      const [row] = await query<{ snapshot: unknown }>(
        `SELECT jsonb_build_object(
           'investigation', (SELECT to_jsonb(i) FROM app.research_investigations i WHERE i.investigation_id = $1),
           'tasks', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.task_id) FROM app.research_tasks t WHERE t.investigation_id = $1),
           'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.seq) FROM app.research_events e WHERE e.investigation_id = $1),
           'deliveries', (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.event_id, d.consumer)
                            FROM app.research_event_deliveries d
                            JOIN app.research_events e ON e.event_id = d.event_id WHERE e.investigation_id = $1),
           'evidence', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.evidence_id) FROM app.research_evidence v WHERE v.investigation_id = $1)
         ) AS snapshot`,
        [investigationId],
      );
      return row.snapshot;
    }

    /** {@link snapshot} once the relay has delivered every event of the investigation. */
    async function quietSnapshot(investigationId: string): Promise<unknown> {
      await vi.waitFor(
        async () => {
          const [row] = await query<{ pending: number }>(
            `SELECT count(*)::int AS pending FROM app.research_event_deliveries d
               JOIN app.research_events e ON e.event_id = d.event_id
              WHERE e.investigation_id = $1 AND d.status = 'pending'`,
            [investigationId],
          );
          expect(row.pending).toBe(0);
        },
        { timeout: LATCH_MS, interval: 25 },
      );
      return snapshot(investigationId);
    }

    async function eventsOfType(
      investigationId: string,
      type: string,
    ): Promise<{ taskId: string | null; failureClass: string | null }[]> {
      return query(
        `SELECT task_id AS "taskId", payload->>'failureClass' AS "failureClass"
           FROM app.research_events WHERE investigation_id = $1 AND type = $2 ORDER BY seq`,
        [investigationId, type],
      );
    }

    /** The lease of the task's `attempt` runs out now, as if its worker had stopped beating. */
    async function expireLease(taskId: string, attempt: number): Promise<void> {
      const rows = await query(
        `UPDATE app.research_tasks SET lease_expires_at = now() - interval '1 second'
          WHERE task_id = $1 AND status = 'running' AND attempt = $2 RETURNING task_id`,
        [taskId, attempt],
      );
      expect(rows).toHaveLength(1);
    }

    /**
     * A claim by the worker of a process that is gone: a `queued` task held back by an unfinished
     * dependency becomes `running` attempt 1, and no process runs its handler.
     */
    async function claimByGoneWorker(
      taskId: string,
      times: { leaseExpired: boolean; deadlinePassed: boolean },
    ): Promise<void> {
      const rows = await query(
        `UPDATE app.research_tasks
            SET status = 'running', attempt = attempt + 1, state_version = state_version + 1,
                lease_owner = 'int3-gone-worker', started_at = now(),
                lease_expires_at = now() + ($2::int * interval '1 hour'),
                deadline_at = now() + ($3::int * interval '1 hour')
          WHERE task_id = $1 AND status = 'queued' RETURNING task_id`,
        [taskId, times.leaseExpired ? -1 : 1, times.deadlinePassed ? -1 : 1],
      );
      expect(rows).toHaveLength(1);
    }

    /** The name of the error a write threw, or `written`. */
    const outcomeOf = (write: Promise<unknown>): Promise<string> =>
      write.then(
        () => 'written',
        (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
      );

    /** `warn` of the runtime's logger: only tells when a fenced outcome write is over. */
    const fencedOutcomeLogged = (taskId: string, attempt: number): boolean =>
      runtime.logs.warn.some(
        ([message]) =>
          typeof message === 'string' &&
          message.startsWith('fenced outcome') &&
          message.includes(`taskId=${taskId} attempt=${attempt}`),
      );

    const whenAborted = (signal: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });

    const bytes = (text: string) => new TextEncoder().encode(text);

    it("INT-3 R1 lease lost: the superseded attempt's late result, evidence, checkpoint and reservation change no row; the next attempt's result is accepted once", async () => {
      const investigationId = await newInvestigation('R1');
      const firstStarted = gate();
      const resumeFirst = gate();
      const lateWritten = gate();
      const secondStarted = gate();
      const finishSecond = gate();
      const late: Record<string, unknown> = {};
      scripts.set('r1', async (ctx) => {
        if (ctx.attempt > 1) {
          secondStarted.release();
          await finishSecond.promise;
          return completed({ answerOrDelta: 'attempt 2' });
        }
        firstStarted.release();
        await resumeFirst.promise;
        late.reserve = await ctx.reserveToolCall('fixture.read', false);
        late.evidence = await outcomeOf(
          ctx.putEvidence(evidenceInput('r1-late', bytes('late page'))),
        );
        late.checkpoint = await outcomeOf(ctx.saveCheckpoint({ late: true }));
        lateWritten.release();
        return completed({ answerOrDelta: 'attempt 1' });
      });

      const taskId = await create(spec(investigationId, 'r1'));
      await within(firstStarted.promise, LATCH_MS, 'attempt 1');
      await expireLease(taskId, 1);
      await within(secondStarted.promise, LATCH_MS, 'attempt 2 after recovery');
      const before = await quietSnapshot(investigationId);

      resumeFirst.release();
      await within(lateWritten.promise, LATCH_MS, 'late writes of attempt 1');
      await vi.waitFor(
        () => expect(fencedOutcomeLogged(taskId, 1)).toBe(true),
        { timeout: LATCH_MS, interval: 25 },
      );
      expect(late).toEqual({
        reserve: { granted: false, reason: 'not_current_attempt' },
        evidence: 'AttemptFencedError',
        checkpoint: 'AttemptFencedError',
      });
      expect(await snapshot(investigationId)).toEqual(before);

      finishSecond.release();
      await settledAs(taskId, 'succeeded');
      expect(await taskState(taskId)).toMatchObject({
        attempt: 2,
        recoveryCount: 1,
        answer: 'attempt 2',
      });
      expect(await eventsOfType(investigationId, 'TaskSucceeded')).toHaveLength(
        1,
      );
    }, 30_000);

    it('INT-3 R2 poison: a handler whose every lease expires runs RUNTIME_MAX_RECOVERIES + 1 times, then the next expiry fails the task with recovery_exhausted; a sibling succeeds', async () => {
      const investigationId = await newInvestigation('R2');
      const started = Array.from({ length: MAX_RECOVERIES + 1 }, gate);
      const never = gate();
      scripts.set('r2', async (ctx) => {
        started[ctx.attempt - 1]?.release();
        await never.promise;
        return completed();
      });

      const taskId = await create(spec(investigationId, 'r2'));
      const siblingId = await create(spec(investigationId, 'r2-sibling'));
      for (let attempt = 1; attempt <= MAX_RECOVERIES + 1; attempt += 1) {
        await within(
          started[attempt - 1].promise,
          LATCH_MS,
          `poison attempt ${attempt}`,
        );
        await expireLease(taskId, attempt);
      }

      await settledAs(taskId, 'failed');
      // The code and the message are the ones the card shows for a task whose every attempt was lost (design-lifecycle.md, DC-6).
      expect(await taskState(taskId)).toMatchObject({
        attempt: MAX_RECOVERIES + 1,
        recoveryCount: MAX_RECOVERIES,
        failureClass: 'recovery_exhausted',
        failureCode: 'recovery_exhausted',
        failureMessage:
          'Every attempt of the task was lost or ran past its limit',
      });
      expect(runs.get('r2')).toBe(MAX_RECOVERIES + 1);
      await settledAs(siblingId, 'succeeded');
    }, 30_000);

    it('INT-3 R3 deadline while running: the task fails with class deadline without waiting for its handler and frees its only slot for an independent task, its late reservation changes no row, and there is no retry although its budget allows one', async () => {
      const investigationId = await newInvestigation('R3');
      const started = gate();
      const resume = gate();
      const lateReserved = gate();
      let lateReserve: ToolCallGrant | undefined;
      let signal: AbortSignal | undefined;
      scripts.set('r3', async (ctx) => {
        signal = ctx.signal;
        started.release();
        await resume.promise;
        lateReserve = await ctx.reserveToolCall('fixture.read', false);
        lateReserved.release();
        return completed();
      });
      // One slot: the independent task can run only once the deadline outcome has freed it.
      const slotType = uniqueWorkflowType('int3-slot');
      const oneSlot = await createRuntimeHarness({
        handlers: [testHandler(slotType, runScript)],
        runtime: { concurrency: 1, leaseMs: 60_000, heartbeatMs: 60_000 },
      });
      try {
        // A retry budget of one: a deadline that counted as retryable would run a second attempt.
        const taskId = await create(
          spec(investigationId, 'r3', {
            deadlineMs: DEADLINE_MS,
            maxRetries: 1,
            workflowType: slotType,
          }),
          oneSlot,
        );
        await within(started.promise, LATCH_MS, 'the r3 attempt');
        const siblingId = await create(
          spec(investigationId, 'r3-sibling', { workflowType: slotType }),
          oneSlot,
        );
        // The handler is still held: the deadline outcome does not wait for it, nor does the slot.
        await settledAs(taskId, 'failed');
        // Code `deadline_exceeded` (design-lifecycle.md, DC-7); the attempt's signal is aborted with the deadline as its reason.
        expect(await taskState(taskId)).toMatchObject({
          attempt: 1,
          failureClass: 'deadline',
          failureCode: 'deadline_exceeded',
          toolCalls: 0,
        });
        expect(signal?.reason).toEqual({ kind: 'deadline' });
        const before = await taskRow(taskId);
        await settledAs(siblingId, 'succeeded');

        resume.release();
        await within(lateReserved.promise, LATCH_MS, 'the late reservation');
        expect(lateReserve).toEqual({
          granted: false,
          reason: 'not_current_attempt',
        });
        expect(await taskRow(taskId)).toEqual(before);
        expect(runs.get('r3')).toBe(1);
        expect(
          (await eventsOfType(investigationId, 'TaskStarted')).filter(
            (event) => event.taskId === taskId,
          ),
        ).toHaveLength(1);
      } finally {
        resume.release();
        await oneSlot.close();
      }
    }, 30_000);

    it('INT-3 R4 deadline passed with no live worker: the reaper fails the task with class deadline and its handler is never invoked', async () => {
      const investigationId = await newInvestigation('R4');
      const releaseGate = gate();
      scripts.set('r4-gate', async () => {
        await releaseGate.promise;
        return completed();
      });
      const gateId = await create(spec(investigationId, 'r4-gate'));
      const taskId = await create(
        spec(investigationId, 'r4', { dependsOn: [gateId] }),
      );
      await claimByGoneWorker(taskId, {
        leaseExpired: true,
        deadlinePassed: true,
      });

      await settledAs(taskId, 'failed');
      expect(await taskState(taskId)).toMatchObject({
        attempt: 1,
        recoveryCount: 0,
        failureClass: 'deadline',
      });
      expect(runs.get('r4')).toBeUndefined();
    }, 30_000);

    it('INT-3 R5 cancel: queued and running tasks end cancelled (local without waiting for the handler, remote after a refused reservation, a gone worker through the reaper), a succeeded task keeps its evidence, and a second cancel changes no row', async () => {
      const investigationId = await newInvestigation('R5');
      // Succeeded before the cancel, with its evidence.
      scripts.set('r5-done', async (ctx) => {
        const ref = await ctx.putEvidence(
          evidenceInput('r5-page', bytes('r5 page')),
        );
        return completed({ evidenceRefs: [ref.evidenceId] });
      });
      const doneId = await create(spec(investigationId, 'r5-done'));
      await settledAs(doneId, 'succeeded');
      const evidenceBefore = await query(
        'SELECT to_jsonb(v) AS row FROM app.research_evidence v WHERE task_id = $1',
        [doneId],
      );
      expect(evidenceBefore).toHaveLength(1);

      // Running in this process; its handler never reacts to the abort.
      const localStarted = gate();
      const localHeld = gate();
      let localReturned = false;
      scripts.set('r5-local', async () => {
        localStarted.release();
        await localHeld.promise;
        localReturned = true;
        return completed();
      });
      const localId = await create(spec(investigationId, 'r5-local'));
      await within(localStarted.promise, LATCH_MS, 'the local attempt');
      const queuedId = await create(
        spec(investigationId, 'r5-queued', { dependsOn: [localId] }),
      );
      // Claimed by a process that is gone, its lease still live.
      const goneId = await create(
        spec(investigationId, 'r5-gone', { dependsOn: [localId] }),
      );
      await claimByGoneWorker(goneId, {
        leaseExpired: false,
        deadlinePassed: false,
      });

      // Running in another instance, which learns of the cancel only by its heartbeat.
      const remoteType = uniqueWorkflowType('int3-remote');
      const remoteStarted = gate();
      const resumeRemote = gate();
      const remoteReserved = gate();
      let remoteReserve: ToolCallGrant | undefined;
      const remote = await createRuntimeHarness({
        handlers: [
          testHandler(remoteType, async (ctx) => {
            remoteStarted.release();
            await resumeRemote.promise;
            remoteReserve = await ctx.reserveToolCall('fixture.read', false);
            remoteReserved.release();
            return completed();
          }),
        ],
        runtime: { concurrency: 1, leaseMs: 60_000, heartbeatMs: 60_000 },
      });
      try {
        const remoteId = await create(
          spec(investigationId, 'r5-remote', { workflowType: remoteType }),
          remote,
        );
        await within(remoteStarted.promise, LATCH_MS, 'the remote attempt');

        await runtime.investigations.cancel(investigationId, resourceId);

        // Committed by the cancel itself.
        expect(await taskState(queuedId)).toMatchObject({
          status: 'cancelled',
          failureClass: 'cancelled',
        });
        expect(await taskState(remoteId)).toMatchObject({
          status: 'running',
          cancelRequested: true,
        });
        expect(await taskState(goneId)).toMatchObject({
          status: 'running',
          cancelRequested: true,
        });

        // Refused right after the commit, before the remote attempt has learned of the cancel.
        resumeRemote.release();
        await within(
          remoteReserved.promise,
          LATCH_MS,
          'the remote reservation',
        );
        expect(remoteReserve).toEqual({
          granted: false,
          reason: 'cancel_requested',
        });
        await settledAs(remoteId, 'cancelled');
        expect(await taskState(remoteId)).toMatchObject({
          failureClass: 'cancelled',
          toolCalls: 0,
        });

        await settledAs(localId, 'cancelled');
        expect(localReturned).toBe(false);

        await expireLease(goneId, 1);
        await settledAs(goneId, 'cancelled');
        expect(await taskState(goneId)).toMatchObject({
          failureClass: 'cancelled',
        });
      } finally {
        resumeRemote.release();
        await remote.close();
      }

      expect(await taskState(doneId)).toMatchObject({ status: 'succeeded' });
      expect(
        await query(
          'SELECT to_jsonb(v) AS row FROM app.research_evidence v WHERE task_id = $1',
          [doneId],
        ),
      ).toEqual(evidenceBefore);
      expect(
        await eventsOfType(investigationId, 'InvestigationCancelled'),
      ).toHaveLength(1);
      expect(
        (await eventsOfType(investigationId, 'TaskCancelled')).map(
          (event) => event.failureClass,
        ),
      ).toEqual(['cancelled', 'cancelled', 'cancelled', 'cancelled']);

      const before = await quietSnapshot(investigationId);
      await runtime.investigations.cancel(investigationId, resourceId);
      expect(await snapshot(investigationId)).toEqual(before);
    }, 30_000);

    it('INT-3 R6 guards on settled tasks: a claim of a succeeded, failed or cancelled task, a wait result without waitFor, a waiting row without its condition and a cancel without an owner or by another owner change no row', async () => {
      const investigationId = await newInvestigation('R6');
      scripts.set('r6-fail', () => Promise.reject(new Error('r6 failure')));
      scripts.set('r6-wait', () =>
        Promise.resolve({ ...completed(), kind: 'wait', waitFor: [] }),
      );
      const doneId = await create(spec(investigationId, 'r6-done'));
      const failedId = await create(spec(investigationId, 'r6-fail'));
      const waitId = await create(spec(investigationId, 'r6-wait'));
      await settledAs(doneId, 'succeeded');
      await settledAs(failedId, 'failed');
      const cancelledId = await create(
        spec(investigationId, 'r6-cancelled', { dependsOn: [failedId] }),
      );
      expect((await taskState(cancelledId)).status).toBe('cancelled');

      // A wait result without waitFor is invalid: the task never enters `waiting`.
      await settledAs(waitId, 'failed');
      expect(await taskState(waitId)).toMatchObject({
        failureClass: 'internal',
      });
      expect(
        (await eventsOfType(investigationId, 'TaskWaiting')).filter(
          (event) => event.taskId === waitId,
        ),
      ).toEqual([]);

      const { db } = runtime;
      const tasks = new TaskRepository();
      for (const taskId of [doneId, failedId, cancelledId]) {
        const before = await taskRow(taskId);
        const now = new Date();
        const claimed = await db.transaction((tx) =>
          tasks.transition(
            tx,
            { taskId, from: ['queued'] },
            {
              kind: 'claim',
              leaseOwner: 'int3-claim',
              leaseExpiresAt: new Date(now.getTime() + 60_000),
              now,
            },
          ),
        );
        expect(claimed).toBeUndefined();
        expect(await taskRow(taskId)).toEqual(before);
      }

      const before = await quietSnapshot(investigationId);
      await expect(
        query(
          `UPDATE app.research_tasks SET status = 'waiting' WHERE task_id = $1`,
          [doneId],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'research_tasks_wait_condition_check',
      });
      await expect(
        runtime.investigations.cancel(investigationId, ''),
      ).rejects.toThrow(/resourceId must not be empty/);
      await expect(
        runtime.investigations.cancel(investigationId, newUser()),
      ).rejects.toMatchObject({ code: 'investigation_not_found' });
      expect(await snapshot(investigationId)).toEqual(before);
    }, 30_000);

    it('INT-3 R7 graceful shutdown: runtime.stop() then the pool close() with running tasks returns one to queued without a recovery and ends the one whose cancel commits while closing as cancelled, with no worker error', async () => {
      const shutdownType = uniqueWorkflowType('int3-shutdown');
      const closingOwner = newUser();
      const started = { plain: gate(), cancelling: gate() };
      const abortedBy = { plain: gate(), cancelling: gate() };
      const cancelCommitted = gate();
      const closing = await createRuntimeHarness({
        handlers: [
          testHandler(shutdownType, async (ctx) => {
            const role = ctx.input.key === 'plain' ? 'plain' : 'cancelling';
            started[role].release();
            await whenAborted(ctx.signal);
            abortedBy[role].release();
            if (role === 'cancelling') await cancelCommitted.promise;
            return completed();
          }),
        ],
        runtime: { concurrency: 2, shutdownGraceMs: LATCH_MS },
      });
      let closed: Promise<void> | undefined;
      // The closing runtime's own logger: the suite's runtime logs elsewhere.
      const closingErrors = () => closing.logs.error;
      try {
        // An owner of its own, on the closing runtime's thread double.
        const owner = {
          app: closing,
          resourceId: closingOwner,
          threadId: await closing.createThread(closingOwner),
        };
        const plainInvestigation = await newInvestigation('R7 plain', owner);
        const cancelledInvestigation = await newInvestigation(
          'R7 cancelled',
          owner,
        );
        const plainId = await create(
          spec(plainInvestigation, 'plain', { workflowType: shutdownType }),
          closing,
        );
        const cancellingId = await create(
          spec(cancelledInvestigation, 'cancelling', {
            workflowType: shutdownType,
          }),
          closing,
        );
        await within(started.plain.promise, LATCH_MS, 'the plain attempt');
        await within(
          started.cancelling.promise,
          LATCH_MS,
          'the cancelling attempt',
        );
        closing.logs.error.length = 0;

        closed = closing.stop().then(() => closing.closeDatabase());
        await within(abortedBy.cancelling.promise, LATCH_MS, 'shutdown abort');
        await closing.investigations.cancel(
          cancelledInvestigation,
          closingOwner,
        );
        cancelCommitted.release();
        await closed;

        expect(await taskState(plainId)).toMatchObject({
          status: 'queued',
          attempt: 1,
          recoveryCount: 0,
        });
        expect(await taskState(cancellingId)).toMatchObject({
          status: 'cancelled',
          failureClass: 'cancelled',
        });
        expect(closingErrors()).toEqual([]);
      } finally {
        cancelCommitted.release();
        if (!closed) await closing.close();
      }
    }, 30_000);

    // -------------------------------------------------------------------------------------------------------------
    // INT-3 R8..R10  TaskContext.withAttemptGuard (KD-9; design-runtime.md UC-E9 and its two variants)  [skeletons added 2026-11-01 for the deep-research engine part]
    // -------------------------------------------------------------------------------------------------------------
    // Same family and same primary failure mode as R1: one more write path (a client-table write through `withAttemptGuard`) lacks the `status = running AND attempt = own` check. It extends INT-3 as three rows
    // instead of a sixth integration test, so the part's integration budget is unchanged. The first consumer is the deep-research engine (design-engine.md KD-3); its own use of the guard is INT-4 of
    // packages/engine/test/deep-research-engine.int.e2e-spec.ts, which does not repeat these rows.
    // Covers (original statements):
    // AC-RT-1 (extended by design-runtime.md v1.18): "If попытка, чей lease перехвачен (меньший attempt или задача уже не running), пишет итог, evidence, checkpoint, резерв вызова или запись клиента через withAttemptGuard, система отклоняет запись и не меняет ни одной строки."
    // Invariants 13 and 14 (Design Doc): the guarded write is a one-task transaction that does not block the investigation and holds no model or external call; `work` only writes the database.
    // Use case: UC-E9 (main scenario and both variants). Contract: operations table, row `TaskContext.withAttemptGuard`; "withAttemptGuard(work)" paragraph of the Data Contract.
    // Support to add: a test client table created in `beforeAll` through the harness database (columns: id, task_id uuid references the runtime's task table with ON DELETE CASCADE, attempt, label), dropped in `afterAll`;
    //   it stands for any client package's table and is the "тестовая таблица клиента" of the use case.
    // @category: core-functionality
    // @dependency: TaskContext.withAttemptGuard, Dispatcher, RecoverySweeper, RUNTIME_LEASE_MS, test client table, injected clock, Postgres
    // @complexity: medium
    //
    // Verification items:
    // - R8 guard decides by attempt (UC-E9 main): lease of attempt 1 taken by attempt 2 (task `running`, attempt 2) -> attempt 1's `withAttemptGuard(work)` returns `fenced`, its `work` writes a row and the row is not in the client table (rolled back),
    //   a `fenced` warning reaches the recording RuntimeLogger; attempt 2's call returns `committed` with the result of `work` and its row is present; also `fenced` when the task is no longer `running` (settled or cancelled) and when the task row is gone;
    //   a cancel requested on a `running` task does not change the verdict (`committed`, as `putEvidence`). The task's own row (`state_version`) is unchanged by either call.
    // - R9 reaper waits for the commit (UC-E9 variant 1): the lease of attempt 2 expires while its `work` is still open (latch inside `work`) -> the sweeper does not requeue the task before `work` commits; after the commit the task is requeued and attempt 2's row is kept
    // - R10 `work` that must not commit (UC-E9 variant 2): `work` outlasting `RUNTIME_LEASE_MS` -> transaction rolled back, exception thrown, no client row; `work` that throws -> rollback and the same exception propagates (not wrapped into `fenced`);
    //   `work` that calls another TaskContext function (`saveCheckpoint`) -> rejected with an exception at once (it would wait on the same task row), no client row, no checkpoint written
    // - R10 also (orchestrator decision 2026-11-01): a session ended by `idle_in_transaction_session_timeout` while `work` waits outside the database does not crash the process (the pool client's
    //   `error` reaches the RuntimeLogger as a warning), and the next query of the same pool passes after each of the two timeouts

    /** The client's write of `work`: one row of the test client table for the attempt. */
    const insertClientRow = (
      tx: RuntimeTx,
      ctx: TaskContext,
      label: string,
    ): Promise<unknown> =>
      tx.execute(
        sql`INSERT INTO public.runtime_test_client_rows (task_id, attempt, label) VALUES (${ctx.taskId}, ${ctx.attempt}, ${label})`,
      );

    const fencedGuardLogged = (taskId: string, attempt: number): boolean =>
      runtime.logs.warn.some(
        ([message]) =>
          message.startsWith('fenced withAttemptGuard') &&
          message.includes(`taskId=${taskId} attempt=${attempt}`),
      );

    /** A clock `shift` moves forward: the reaper of its runtime sees a lease run out on demand. */
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

    /** An owner of its own on the thread double of `app`, for a runtime built by one test. */
    async function ownerOn(app: RuntimeHarness) {
      const owner = newUser();
      return { app, resourceId: owner, threadId: await app.createThread(owner) };
    }

    it('INT-3 R8 withAttemptGuard: a superseded or settled attempt gets fenced and its client row is rolled back; the live attempt gets committed with the result of work and its row is kept; cancel does not change the verdict', async () => {
      const investigationId = await newInvestigation('R8');
      const firstStarted = gate();
      const holdFirst = gate();
      const secondStarted = gate();
      const finishSecond = gate();
      const contexts: TaskContext[] = [];
      scripts.set('r8', async (ctx) => {
        contexts.push(ctx);
        if (ctx.attempt > 1) {
          secondStarted.release();
          await finishSecond.promise;
          return completed();
        }
        firstStarted.release();
        await holdFirst.promise;
        return completed();
      });

      const taskId = await create(spec(investigationId, 'r8'));
      await within(firstStarted.promise, LATCH_MS, 'attempt 1');
      await expireLease(taskId, 1);
      await within(secondStarted.promise, LATCH_MS, 'attempt 2 after recovery');
      const [first, second] = contexts;

      // The superseded attempt: fenced, nothing written, the task row untouched.
      const beforeFenced = await taskRow(taskId);
      expect(
        await first.withAttemptGuard((tx) =>
          insertClientRow(tx, first, 'attempt 1'),
        ),
      ).toEqual({ outcome: 'fenced' });
      expect(fencedGuardLogged(taskId, 1)).toBe(true);
      expect(await taskRow(taskId)).toEqual(beforeFenced);

      // A cancel requested on the running task does not change the verdict of the live attempt.
      await query(
        'UPDATE app.research_tasks SET cancel_requested_at = now() WHERE task_id = $1',
        [taskId],
      );
      const beforeCommitted = await taskRow(taskId);
      expect(
        await second.withAttemptGuard(async (tx) => {
          await insertClientRow(tx, second, 'attempt 2');
          return 'written by attempt 2';
        }),
      ).toEqual({ outcome: 'committed', value: 'written by attempt 2' });
      expect(await taskRow(taskId)).toEqual(beforeCommitted);

      // Settled with the same attempt: no longer `running`, so fenced.
      finishSecond.release();
      await settledAs(taskId, 'cancelled');
      expect(
        await second.withAttemptGuard((tx) =>
          insertClientRow(tx, second, 'attempt 2 after the end'),
        ),
      ).toEqual({ outcome: 'fenced' });
      expect(await clientRowsOf(taskId)).toEqual([
        { attempt: 2, label: 'attempt 2' },
      ]);

      // The task row is gone with its investigation.
      await query(
        'DELETE FROM app.research_investigations WHERE investigation_id = $1',
        [investigationId],
      );
      expect(
        await second.withAttemptGuard((tx) =>
          insertClientRow(tx, second, 'attempt 2 without a task'),
        ),
      ).toEqual({ outcome: 'fenced' });
      expect(await clientRowsOf(taskId)).toEqual([]);
      holdFirst.release();
    }, 30_000);

    it("INT-3 R9 withAttemptGuard: a lease that expires while work is open is not requeued by the reaper until work commits, and the live attempt's row is kept", async () => {
      const reaperType = uniqueWorkflowType('int3-guard-reaper');
      const clock = shiftableClock();
      const contexts: TaskContext[] = [];
      const started = gate();
      const holdFirst = gate();
      const app = await createRuntimeHarness({
        handlers: [
          testHandler(reaperType, async (ctx) => {
            contexts.push(ctx);
            if (ctx.attempt > 1) return completed();
            started.release();
            await holdFirst.promise;
            return completed();
          }),
        ],
        clock,
        // No heartbeat moves the lease within the test; the reaper runs every 50 ms.
        runtime: { leaseMs: 3_000, heartbeatMs: 60_000, reaperMs: 50 },
      });
      try {
        const investigationId = await newInvestigation('R9', await ownerOn(app));
        const taskId = await create(
          spec(investigationId, 'r9', { workflowType: reaperType }),
          app,
        );
        await within(started.promise, LATCH_MS, 'attempt 1');
        const [ctx] = contexts;

        const workOpen = gate();
        const commitWork = gate();
        const guarded = ctx.withAttemptGuard(async (tx) => {
          await insertClientRow(tx, ctx, 'attempt 1');
          workOpen.release();
          await commitWork.promise;
          return 'committed after the lease ran out';
        });
        await within(workOpen.promise, LATCH_MS, 'work open');
        clock.shift(4_000);
        // The reaper found the expired lease, and its guarded write waits for the task row.
        await vi.waitFor(
          async () => {
            const [waiting] = await query<{ count: number }>(
              `SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query ILIKE 'update "app"."research_tasks"%'`,
              [],
            );
            expect(waiting.count).toBe(1);
          },
          { timeout: LATCH_MS, interval: 25 },
        );
        expect(await taskState(taskId)).toMatchObject({
          status: 'running',
          attempt: 1,
          recoveryCount: 0,
        });

        commitWork.release();
        expect(await guarded).toEqual({
          outcome: 'committed',
          value: 'committed after the lease ran out',
        });
        await settledAs(taskId, 'succeeded');
        expect(await taskState(taskId)).toMatchObject({
          attempt: 2,
          recoveryCount: 1,
        });
        expect(await clientRowsOf(taskId)).toEqual([
          { attempt: 1, label: 'attempt 1' },
        ]);
      } finally {
        holdFirst.release();
        try {
          await runtimeWorkSettled([reaperType], LATCH_MS);
        } finally {
          await app.close();
        }
      }
    }, 30_000);

    it('INT-3 R10 withAttemptGuard: work longer than RUNTIME_LEASE_MS, work that throws and work that calls another TaskContext function roll back, throw, and leave no client row', async () => {
      const LEASE_MS = 1_500;
      const guardType = uniqueWorkflowType('int3-guard-rollback');
      const contexts: TaskContext[] = [];
      const started = gate();
      const finish = gate();
      const app = await createRuntimeHarness({
        handlers: [
          testHandler(guardType, async (ctx) => {
            contexts.push(ctx);
            started.release();
            await finish.promise;
            return completed();
          }),
        ],
        // No heartbeat within the test; the lease is moved an hour ahead below, so LEASE_MS bounds
        // only the guard's transactions here. One pooled connection, polling instead of LISTEN:
        // every query after a guard runs on the connection the guard used.
        runtime: {
          leaseMs: LEASE_MS,
          heartbeatMs: 60_000,
          dbPoolMax: 1,
          notify: false,
        },
      });
      const sessionEndLogged = (): boolean =>
        app.logs.warn.some(([message]) =>
          message.startsWith('database client error'),
        );
      const poolAnswers = async (): Promise<unknown> =>
        (await app.db.execute(sql`SELECT 1 AS one`)).rows;
      const poolTimeouts = async (): Promise<unknown> =>
        (
          await app.db.execute(
            sql`SELECT current_setting('statement_timeout') AS statement, current_setting('idle_in_transaction_session_timeout') AS idle`,
          )
        ).rows;
      try {
        const investigationId = await newInvestigation('R10', await ownerOn(app));
        const taskId = await create(
          spec(investigationId, 'r10', { workflowType: guardType }),
          app,
        );
        await within(started.promise, LATCH_MS, 'attempt 1');
        const [ctx] = contexts;
        // Every runtime's reaper sweeps every task: attempt 1 stays current through the test.
        const held = await query(
          `UPDATE app.research_tasks SET lease_expires_at = now() + interval '1 hour'
            WHERE task_id = $1 AND status = 'running' AND attempt = 1 RETURNING task_id`,
          [taskId],
        );
        expect(held).toHaveLength(1);

        // A statement outlasting the lease: statement_timeout cancels it.
        await expect(
          ctx.withAttemptGuard(async (tx) => {
            await insertClientRow(tx, ctx, 'slow statement');
            await tx.execute(sql`SELECT pg_sleep(5)`);
          }),
        ).rejects.toMatchObject({ cause: { code: '57014' } });
        expect(await poolAnswers()).toEqual([{ one: 1 }]);

        // A wait outside the database outlasting the lease: the session is ended, the process lives.
        await expect(
          ctx.withAttemptGuard(async (tx) => {
            await insertClientRow(tx, ctx, 'idle transaction');
            await vi.waitFor(() => expect(sessionEndLogged()).toBe(true), {
              timeout: LATCH_MS,
              interval: 25,
            });
            await tx.execute(sql`SELECT 1`);
          }),
        ).rejects.toThrow();
        expect(await poolAnswers()).toEqual([{ one: 1 }]);

        // `work` that throws: the same exception, not a `fenced` value.
        const workFailure = new Error('client work failed');
        await expect(
          ctx.withAttemptGuard(async (tx) => {
            await insertClientRow(tx, ctx, 'throwing work');
            throw workFailure;
          }),
        ).rejects.toBe(workFailure);

        // Another TaskContext function inside `work` is refused at once, not after the lease.
        await expect(
          within(
            ctx.withAttemptGuard(async (tx) => {
              await insertClientRow(tx, ctx, 'nested call');
              await ctx.saveCheckpoint({ nested: true });
            }),
            LEASE_MS / 2,
            'nested saveCheckpoint refusal',
          ),
        ).rejects.toThrow('inside withAttemptGuard');

        // The timeouts belong to the guard's transaction: a committed guard leaves none on the connection.
        expect(await ctx.withAttemptGuard(async () => 'nothing written')).toEqual(
          { outcome: 'committed', value: 'nothing written' },
        );
        expect(await poolTimeouts()).toEqual([{ statement: '0', idle: '0' }]);

        expect(await clientRowsOf(taskId)).toEqual([]);
        expect(await taskState(taskId)).toMatchObject({ status: 'running' });
        const [task] = await query<{ checkpoint: unknown }>(
          'SELECT checkpoint FROM app.research_tasks WHERE task_id = $1',
          [taskId],
        );
        expect(task.checkpoint).toBeNull();
      } finally {
        finish.release();
        try {
          await runtimeWorkSettled([guardType], LATCH_MS);
        } finally {
          await app.close();
        }
      }
    }, 30_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Event consumers: cascade, wake-up, redelivery and bad events   [EXTRA: budget slot 4 of 5]
  // ---------------------------------------------------------------------------------------------------------------
  // Unique defect no other test catches: a failing consumer or an event of unknown `schemaVersion` blocks, loses, or double-applies other deliveries; a redelivery of a `done` delivery re-applies a cascade.
  // INT-2 only feeds well-formed events, the kill matrix only crashes the process (it never delivers a malformed or failing event), and no other test cancels a dependent chain.
  // Covers (original statements):
  // AC-04.2: "Given A завершилась failed или cancelled, Then B не стартует и переходит в cancelled с причиной, называющей A."
  // AC-08.3: "Given событие доставлено повторно с тем же eventId, Then повторная доставка не меняет ни одной записи."
  // AC-09.2: "Given событие с неизвестной schemaVersion, Then оно не обрабатывается, не теряется и помечено как требующее внимания; доставка остальных событий продолжается."
  // AC-RT-6 (cascade half): "...задача создаётся сразу cancelled с классом dependency_failed..." applied to the descendants of a failed task
  // Use cases: UC-7, UC-12, UC-E3. EARS: When / If-then.
  // Design flow: Flow 3 (OutboxRelay: investigation lock, then pending delivery, consumer in a savepoint, `done` in the same transaction), Error Handling (consumer failure, unknown schemaVersion).
  //
  // Primary failure mode (turns red when): OutboxRelay does not check `status = pending` after taking the investigation lock (redelivery re-cancels or re-notifies), the savepoint rollback of a failing consumer also rolls back the delivery counters,
  // or an unknown `schemaVersion` raises instead of parking the delivery - the remaining deliveries then stall.
  // ROI: 3.3 | Business Value: 7 (silent event loss or stall) | Frequency: 4 | Legal: false | Defect Detection: 8
  // Behavior: events fed to OutboxRelay -> cascade cancels descendants with direct and root cause; a done delivery re-run changes nothing; a bad event parks as `needs_attention` while every other delivery reaches `done`
  // @category: edge-case
  // @dependency: OutboxRelay, SchedulerConsumer, EventConsumerRegistry (one test consumer that throws on a chosen event), Postgres
  // @complexity: medium
  //
  // Verification items:
  // - Cascade: chain A <- B <- C all `queued`, A fails -> B and C `cancelled`, class dependency_failed, `dependencyTaskId` = A for B and = B for C, `rootCauseTaskId` = A for both; one TaskCancelled event per task
  // - Redelivery: run the relay again for the same `done` delivery (and force a second consumer pass on the same eventId) -> a full before/after snapshot of research_* rows for the investigation is identical
  // - Unknown schemaVersion: an event with schemaVersion 99 -> its delivery is `needs_attention` at once, consumer not called, event row kept
  // - Failing consumer: throws on one event -> `attempts` grows with `next_attempt_at` set by the injected backoff, after RUNTIME_DELIVERY_MAX_ATTEMPTS the delivery is `needs_attention` with `last_error`; the failed consumer's partial writes are rolled back
  // - All remaining deliveries of the investigation are `done` after the relay drains
  // - Wake-up (the only test of this path): a task `waiting` on another returns to `queued` (`TaskQueued (woken)`) once the awaited task's TaskSucceeded is delivered,
  //   runs its next attempt, and the awaited task's subscriber is marked with that event's id
  // Time: INT-4 runs on the harness's default system clock, so the backoff is checked against the system clock's window and the test moves `next_attempt_at` back instead of waiting it out.
  describe('INT-4', () => {
    const LATCH_MS = 15_000;
    const MAX_ATTEMPTS = 3;
    const SCHEDULER = 'runtime.scheduler';
    const workflowType = uniqueWorkflowType('int4');
    const resourceId = newUser();
    /** A consumer of TaskSucceeded beside the scheduler's; fails on the poison task's event. */
    const probeName = `int4-probe-${randomUUID()}`;
    const probeCalls = new Map<string, number>();
    let poisonTaskId = 'unset';

    const gate = {
      releaseFailing: latch(),
      heldStarted: latch(),
      releaseHeld: latch(),
      releasePoison: latch(),
    };

    const failedResult = (): HandlerResult => ({
      ...completed(),
      kind: 'failed',
      failure: {
        class: 'tool_error',
        code: 'fixture_error',
        message: 'The fixture failed',
        cause: null,
        attempt: 1,
        toolCalls: 0,
        retries: 0,
      },
    });

    const handler = testHandler(workflowType, async (ctx) => {
      switch (ctx.input.role) {
        case 'failing':
          await gate.releaseFailing.promise;
          return failedResult();
        case 'held':
          gate.heldStarted.release();
          await gate.releaseHeld.promise;
          return completed();
        case 'poison':
          await gate.releasePoison.promise;
          return completed();
        case 'waiter': {
          if (ctx.attempt > 1) return completed();
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
    });

    const probe: EventConsumer = {
      name: probeName,
      eventTypes: ['TaskSucceeded'],
      schemaVersions: [1],
      handle: async (tx, event) => {
        probeCalls.set(event.eventId, (probeCalls.get(event.eventId) ?? 0) + 1);
        if (event.taskId !== poisonTaskId) return;
        // A partial write the savepoint must roll back.
        await tx
          .update(researchInvestigations)
          .set({ query: 'written by a failing consumer' })
          .where(
            eq(researchInvestigations.investigationId, event.investigationId),
          );
        throw new Error('probe consumer failure');
      },
    };

    let runtime: RuntimeHarness;
    let threadId: string;

    beforeAll(async () => {
      runtime = await createRuntimeHarness({
        handlers: [handler],
        runtime: { concurrency: 2, deliveryMaxAttempts: MAX_ATTEMPTS },
      });
      runtime.eventConsumers.register(probe);
      threadId = await runtime.createThread(resourceId);
    });

    afterAll(async () => {
      for (const open of Object.values(gate)) open.release();
      try {
        await runtimeWorkSettled([workflowType], LATCH_MS);
      } finally {
        await runtime?.close();
        await closeRuntimeDb();
      }
    }, 2 * LATCH_MS);

    async function newInvestigation(label: string): Promise<string> {
      const { investigationId } = await runtime.investigations.create({
        resourceId,
        threadId,
        query: `INT-4 ${label}`,
        budget: { maxTasks: 10, maxToolCalls: 20 },
      });
      return investigationId;
    }

    async function create(
      investigationId: string,
      input: Record<string, string>,
      dependsOn: string[] = [],
    ): Promise<string> {
      const result = await runtime.scheduler.propose(
        taskSpec({ investigationId, workflowType, input, dependsOn }),
        `int4-${input.key}`,
      );
      if (result.outcome !== 'created') {
        throw new Error(`task not created: ${JSON.stringify(result)}`);
      }
      return result.taskId;
    }

    interface Delivery {
      eventId: string;
      consumer: string;
      type: string;
      taskId: string | null;
      status: string;
      attempts: number;
      nextAttemptAt: Date;
      lastError: string | null;
    }

    function deliveriesOf(investigationId: string): Promise<Delivery[]> {
      return query<Delivery>(
        `SELECT d.event_id AS "eventId", d.consumer, e.type, e.task_id AS "taskId", d.status,
                d.attempts, d.next_attempt_at AS "nextAttemptAt", d.last_error AS "lastError"
           FROM app.research_event_deliveries d
           JOIN app.research_events e ON e.event_id = d.event_id
          WHERE e.investigation_id = $1
          ORDER BY e.seq, d.consumer`,
        [investigationId],
      );
    }

    async function delivery(
      eventId: string,
      consumer: string,
    ): Promise<Delivery | undefined> {
      const [row] = await query<Delivery>(
        `SELECT d.event_id AS "eventId", d.consumer, e.type, e.task_id AS "taskId", d.status,
                d.attempts, d.next_attempt_at AS "nextAttemptAt", d.last_error AS "lastError"
           FROM app.research_event_deliveries d
           JOIN app.research_events e ON e.event_id = d.event_id
          WHERE d.event_id = $1 AND d.consumer = $2`,
        [eventId, consumer],
      );
      return row;
    }

    /** Waits until no delivery of the investigation is `pending`. */
    async function drained(investigationId: string): Promise<Delivery[]> {
      let rows: Delivery[] = [];
      await vi.waitFor(
        async () => {
          rows = await deliveriesOf(investigationId);
          expect(rows.filter((row) => row.status === 'pending')).toEqual([]);
        },
        { timeout: LATCH_MS, interval: 25 },
      );
      return rows;
    }

    async function statusesOf(ids: string[]): Promise<(string | undefined)[]> {
      const rows = await query<{ taskId: string; status: string }>(
        `SELECT task_id AS "taskId", status FROM app.research_tasks WHERE task_id = ANY($1::uuid[])`,
        [ids],
      );
      const byId = new Map(rows.map((row) => [row.taskId, row.status]));
      return ids.map((id) => byId.get(id));
    }

    async function settled(ids: string[], statuses: string[]): Promise<void> {
      await vi.waitFor(
        async () => {
          expect(await statusesOf(ids)).toEqual(statuses);
        },
        { timeout: LATCH_MS, interval: 25 },
      );
    }

    function eventsOfTask(taskId: string): Promise<
      {
        eventId: string;
        type: string;
        reason: string | null;
        causationId: string | null;
      }[]
    > {
      return query(
        `SELECT event_id AS "eventId", type, payload->>'reason' AS reason, causation_id AS "causationId"
           FROM app.research_events WHERE task_id = $1 ORDER BY seq`,
        [taskId],
      );
    }

    /** Every research_* row of the investigation, as JSON (`state_version` and delivery counters included). */
    async function snapshot(investigationId: string): Promise<unknown> {
      const [row] = await query<{ snapshot: unknown }>(
        `SELECT jsonb_build_object(
           'investigation', (SELECT to_jsonb(i) FROM app.research_investigations i WHERE i.investigation_id = $1),
           'tasks', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.task_id) FROM app.research_tasks t WHERE t.investigation_id = $1),
           'edges', (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.task_id, d.depends_on_task_id, d.kind)
                       FROM app.research_task_dependencies d WHERE d.investigation_id = $1),
           'subscribers', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.task_id, s.subscriber_key)
                             FROM app.research_task_subscribers s
                             JOIN app.research_tasks t ON t.task_id = s.task_id WHERE t.investigation_id = $1),
           'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.seq) FROM app.research_events e WHERE e.investigation_id = $1),
           'deliveries', (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.event_id, d.consumer)
                            FROM app.research_event_deliveries d
                            JOIN app.research_events e ON e.event_id = d.event_id WHERE e.investigation_id = $1),
           'evidence', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.evidence_id) FROM app.research_evidence v WHERE v.investigation_id = $1)
         ) AS snapshot`,
        [investigationId],
      );
      return row.snapshot;
    }

    async function envelopeOf(eventId: string): Promise<EventEnvelope> {
      const [row] = await query<
        Omit<EventEnvelope, 'createdAt'> & { createdAt: Date }
      >(
        `SELECT event_id AS "eventId", type, schema_version AS "schemaVersion",
                investigation_id AS "investigationId", task_id AS "taskId",
                causation_id AS "causationId", correlation_id AS "correlationId",
                state_revision AS "stateRevision", payload_ref AS "payloadRef", payload,
                created_at AS "createdAt"
           FROM app.research_events WHERE event_id = $1`,
        [eventId],
      );
      return { ...row, createdAt: row.createdAt.toISOString() };
    }

    /**
     * The runtime's scheduler consumer and an outbox relay that delivers to it, built from the
     * package's `src` over the harness's client with the arguments `createRuntime` passes. Neither
     * is started nor registered with the harness's runtime: the test calls `deliver` and `handle`
     * itself.
     */
    function schedulerPartsOf(harness: RuntimeHarness): {
      relay: OutboxRelay;
      schedulerConsumer: SchedulerConsumer;
    } {
      const consumers = new EventConsumerRegistry();
      const tasks = new TaskRepository();
      const schedulerConsumer = new SchedulerConsumer(
        harness.clock,
        tasks,
        new EventLog(consumers),
      );
      consumers.register(schedulerConsumer);
      const relay = new OutboxRelay(
        harness.db,
        harness.config,
        harness.clock,
        harness.logger,
        consumers,
        tasks,
        CrashPoints.fromConfig(harness.config),
      );
      return { relay, schedulerConsumer };
    }

    it('INT-4 order: the deliveries of one event are applied by descending consumer name, not in the order their rows were written', async () => {
      // Lifecycle E2E-1 K2 counts relay passes, so it needs `runtime.scheduler` before `engine.lifecycle` for the
      // controller's end event: both rows share `next_attempt_at` and `seq`, and only the last order key separates them.
      // The consumer that sorts first by name is registered, and so written, second.
      const suffix = randomUUID();
      const applied: string[] = [];
      const recorder = (name: string): EventConsumer => ({
        name,
        eventTypes: ['TaskSucceeded'],
        schemaVersions: [1],
        handle: async (_tx, event) => {
          if (event.eventId === eventId) applied.push(name);
        },
      });
      const consumers = new EventConsumerRegistry();
      consumers.register(recorder(`int4-order-a-${suffix}`));
      consumers.register(recorder(`int4-order-z-${suffix}`));
      const investigationId = await newInvestigation('delivery order');
      const { eventId } = await runtime.db.transaction((tx) =>
        new EventLog(consumers).append(tx, {
          type: 'TaskSucceeded',
          investigationId,
          taskId: null,
          causationId: null,
          stateRevision: 1,
          payload: {},
        }),
      );
      // A relay of only these two consumers: the harness's relay does not deliver them.
      const relay = new OutboxRelay(
        runtime.db,
        runtime.config,
        runtime.clock,
        runtime.logger,
        consumers,
        new TaskRepository(),
        CrashPoints.fromConfig(runtime.config),
      );
      relay.start();
      try {
        const startedAt = Date.now();
        while (applied.length < 2 && Date.now() - startedAt < LATCH_MS) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        await relay.shutdown();
      }

      expect(applied).toEqual([`int4-order-z-${suffix}`, `int4-order-a-${suffix}`]);
    });

    it('INT-4 cascade and redelivery: a failed dependency cancels its descendants with direct and root cause; a redelivered done event and a second consumer pass change no row', async () => {
      const investigationId = await newInvestigation('cascade');
      // A fails only after B and C are admitted: the cascade, not admission, must cancel them.
      const a = await create(investigationId, { role: 'failing', key: 'a' });
      const b = await create(investigationId, { role: 'never', key: 'b' }, [a]);
      const c = await create(investigationId, { role: 'never', key: 'c' }, [b]);
      expect(await statusesOf([b, c])).toEqual(['queued', 'queued']);

      gate.releaseFailing.release();
      await settled([a, b, c], ['failed', 'cancelled', 'cancelled']);
      const deliveries = await drained(investigationId);

      // AC-04.2 / AC-RT-6 (cascade half): direct cause per hop, root cause A for both.
      const failures = await query<{ taskId: string; failureReason: unknown }>(
        `SELECT task_id AS "taskId", failure_reason AS "failureReason"
           FROM app.research_tasks WHERE task_id = ANY($1::uuid[])`,
        [[b, c]],
      );
      expect(
        Object.fromEntries(
          failures.map((row) => [row.taskId, row.failureReason]),
        ),
      ).toEqual({
        [b]: expect.objectContaining({
          class: 'dependency_failed',
          dependencyTaskId: a,
          rootCauseTaskId: a,
        }),
        [c]: expect.objectContaining({
          class: 'dependency_failed',
          dependencyTaskId: b,
          rootCauseTaskId: a,
        }),
      });
      const [aFailed] = (await eventsOfTask(a)).filter(
        (event) => event.type === 'TaskFailed',
      );
      const bEvents = await eventsOfTask(b);
      const cEvents = await eventsOfTask(c);
      expect(bEvents.map((event) => event.type)).toEqual([
        'TaskQueued',
        'TaskCancelled',
      ]);
      expect(cEvents.map((event) => event.type)).toEqual([
        'TaskQueued',
        'TaskCancelled',
      ]);
      expect([bEvents[1].causationId, cEvents[1].causationId]).toEqual([
        aFailed.eventId,
        bEvents[1].eventId,
      ]);
      expect(
        deliveries.map((row) => [row.type, row.consumer, row.status]),
      ).toEqual(
        expect.arrayContaining([
          ['TaskFailed', SCHEDULER, 'done'],
          ['TaskCancelled', SCHEDULER, 'done'],
        ]),
      );
      expect(await runs(investigationId)).toEqual([a]);

      // AC-08.3: the done delivery handed to the relay again, then the consumer run again on the same eventId.
      const before = await snapshot(investigationId);
      const { relay, schedulerConsumer } = schedulerPartsOf(runtime);
      const redelivered = await relay.deliver({
        eventId: aFailed.eventId,
        consumer: SCHEDULER,
      });
      expect(await snapshot(investigationId)).toEqual(before);
      expect(redelivered).toBe('skipped');
      const envelope = await envelopeOf(aFailed.eventId);
      await runtime.db.transaction((tx) =>
        schedulerConsumer.handle(tx, envelope),
      );
      expect(await snapshot(investigationId)).toEqual(before);
    }, 30_000);

    /** Tasks of the investigation that some attempt has started. */
    async function runs(investigationId: string): Promise<string[]> {
      const rows = await query<{ taskId: string }>(
        `SELECT DISTINCT task_id AS "taskId" FROM app.research_events
          WHERE investigation_id = $1 AND type = 'TaskStarted'`,
        [investigationId],
      );
      return rows.map((row) => row.taskId);
    }

    it("INT-4 wake-up: a task waiting on another returns to queued after the awaited task's TaskSucceeded is delivered, and the awaited task's subscriber is marked with that TaskSucceeded event id", async () => {
      const investigationId = await newInvestigation('wake');
      const held = await create(investigationId, { role: 'held', key: 'held' });
      await within(
        gate.heldStarted.promise,
        LATCH_MS,
        'the awaited task to start',
      );
      const waiter = await create(investigationId, {
        role: 'waiter',
        key: 'waiter',
        target: held,
      });
      await settled([waiter], ['waiting']);

      gate.releaseHeld.release();
      await settled([held, waiter], ['succeeded', 'succeeded']);
      await drained(investigationId);

      const [heldSucceeded] = (await eventsOfTask(held)).filter(
        (event) => event.type === 'TaskSucceeded',
      );
      const waiterEvents = await eventsOfTask(waiter);
      expect(waiterEvents.map((event) => [event.type, event.reason])).toEqual([
        ['TaskQueued', 'admitted'],
        ['TaskStarted', null],
        ['TaskWaiting', null],
        ['TaskQueued', 'woken'],
        ['TaskStarted', null],
        ['TaskSucceeded', null],
      ]);
      expect(waiterEvents[3].causationId).toBe(heldSucceeded.eventId);
      expect(
        await query(
          `SELECT subscriber_key AS "subscriberKey", notified_event_id AS "notifiedEventId"
             FROM app.research_task_subscribers WHERE task_id = $1`,
          [held],
        ),
      ).toEqual([
        { subscriberKey: 'int4-held', notifiedEventId: heldSucceeded.eventId },
      ]);
    }, 30_000);

    it('INT-4 bad events: an unknown schemaVersion parks at once without calling the consumer, a failing consumer backs off and parks after the attempt limit with its writes rolled back, and every other delivery is done', async () => {
      const investigationId = await newInvestigation('bad events');
      const [{ query: queryText }] = await query<{ query: string }>(
        'SELECT query FROM app.research_investigations WHERE investigation_id = $1',
        [investigationId],
      );
      const healthy = await create(investigationId, { role: 'ok', key: 'ok' });

      // AC-09.2: an event of schemaVersion 99 with a delivery to each consumer of its type.
      const unknownEventId = randomUUID();
      await query(
        `WITH created AS (
           SELECT event_id FROM app.research_events
            WHERE investigation_id = $2 AND type = 'InvestigationCreated'),
         inserted AS (
           INSERT INTO app.research_events
             (event_id, type, schema_version, investigation_id, task_id, correlation_id, state_revision, payload)
           SELECT $1, 'TaskSucceeded', 99, $2, $3, created.event_id, 1, '{}'::jsonb FROM created
           RETURNING event_id)
         INSERT INTO app.research_event_deliveries (event_id, consumer)
         SELECT inserted.event_id, consumer FROM inserted, unnest($4::text[]) AS consumer`,
        [unknownEventId, investigationId, healthy, [SCHEDULER, probeName]],
      );

      // The poison task's TaskSucceeded fails the probe on every pass; it finishes once the probe knows its id.
      let observedFrom = Date.now();
      const poison = await create(investigationId, {
        role: 'poison',
        key: 'poison',
      });
      poisonTaskId = poison;
      gate.releasePoison.release();
      await settled([healthy, poison], ['succeeded', 'succeeded']);
      const [poisonSucceeded] = (await eventsOfTask(poison)).filter(
        (event) => event.type === 'TaskSucceeded',
      );

      // Each failed pass: attempts + 1, last_error, next_attempt_at by the 1 s doubling backoff with jitter (half to whole).
      for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
        let failedPass: Delivery | undefined;
        await vi.waitFor(
          async () => {
            failedPass = await delivery(poisonSucceeded.eventId, probeName);
            expect(failedPass).toMatchObject({
              status: 'pending',
              attempts: attempt,
            });
          },
          { timeout: LATCH_MS, interval: 25 },
        );
        const observedUntil = Date.now();
        const ceiling = 1_000 * 2 ** (attempt - 1);
        const next = failedPass?.nextAttemptAt.getTime() ?? Number.NaN;
        expect(next).toBeGreaterThanOrEqual(observedFrom + ceiling / 2 - 1);
        expect(next).toBeLessThanOrEqual(observedUntil + ceiling + 1);
        expect(failedPass?.lastError).toContain('probe consumer failure');
        // Instead of waiting the backoff out: make the delivery due now.
        observedFrom = Date.now();
        await query(
          `UPDATE app.research_event_deliveries SET next_attempt_at = $3
            WHERE event_id = $1 AND consumer = $2`,
          [poisonSucceeded.eventId, probeName, new Date(observedFrom - 1_000)],
        );
      }
      const deliveries = await drained(investigationId);

      const parked = deliveries.filter((row) => row.status !== 'done');
      expect(
        parked.map((row) => ({
          eventId: row.eventId,
          consumer: row.consumer,
          status: row.status,
          attempts: row.attempts,
        })),
      ).toEqual(
        expect.arrayContaining([
          {
            eventId: unknownEventId,
            consumer: SCHEDULER,
            status: 'needs_attention',
            attempts: 0,
          },
          {
            eventId: unknownEventId,
            consumer: probeName,
            status: 'needs_attention',
            attempts: 0,
          },
          {
            eventId: poisonSucceeded.eventId,
            consumer: probeName,
            status: 'needs_attention',
            attempts: MAX_ATTEMPTS,
          },
        ]),
      );
      expect(parked).toHaveLength(3);
      expect(
        parked.find((row) => row.eventId === poisonSucceeded.eventId)
          ?.lastError,
      ).toContain('probe consumer failure');
      // Not processed, not lost.
      expect(probeCalls.get(unknownEventId)).toBeUndefined();
      expect(
        await query(
          'SELECT schema_version AS "schemaVersion" FROM app.research_events WHERE event_id = $1',
          [unknownEventId],
        ),
      ).toEqual([{ schemaVersion: 99 }]);
      // The failing consumer's own write was rolled back on every pass.
      expect(probeCalls.get(poisonSucceeded.eventId)).toBe(MAX_ATTEMPTS);
      expect(
        await query(
          'SELECT query FROM app.research_investigations WHERE investigation_id = $1',
          [investigationId],
        ),
      ).toEqual([{ query: queryText }]);
      // The other deliveries went on: the scheduler's of the poison event and both of the healthy task's.
      const succeededDeliveries = deliveries
        .filter(
          (row) =>
            row.type === 'TaskSucceeded' && row.eventId !== unknownEventId,
        )
        .map((row) => [row.taskId, row.consumer, row.status]);
      expect(succeededDeliveries).toHaveLength(4);
      expect(succeededDeliveries).toEqual(
        expect.arrayContaining([
          [healthy, SCHEDULER, 'done'],
          [healthy, probeName, 'done'],
          [poison, SCHEDULER, 'done'],
          [poison, probeName, 'needs_attention'],
        ]),
      );
    }, 30_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  Thread boundary: owner isolation of a thread's investigations   [EXTRA: budget slot 5 of 5, shared with INT-5 of apps/api]
  // ---------------------------------------------------------------------------------------------------------------
  // Unique defect no other test catches: the (resourceId, threadId) filter of listForThread - a wrong-owner read.
  // The rows that cross ThreadsService (deletion of a thread over HTTP, AC-23.1-AC-23.3, AC-23.5, and `create` on another user's thread) prove the
  // composition root and live in apps/api; this package sees threads only through the ThreadOwnership port.
  // Covers (original statements):
  // AC-01.1: "Given расследование создано для беседы T пользователя U, When расследования запрашиваются по (U, T), Then оно возвращается со своими задачами; запрос с другим resourceId его не возвращает."
  // Use cases: UC-1. EARS: When.
  //
  // Primary failure mode (turns red when): the owner filter is missing in listForThread.
  // ROI: 5.3 | Business Value: 8 (tenant isolation) | Frequency: 5 | Legal: true | Defect Detection: 8
  // Behavior: listForThread(U, T) returns T's investigation with its tasks; listForThread(V, T) returns nothing
  // @category: integration
  // @dependency: InvestigationService, Dispatcher + test handler, ThreadOwnership double, Postgres
  // @complexity: low
  //
  // Verification items:
  // - Visibility (AC-01.1): create via InvestigationService.create for (U, T); listForThread(U, T) returns it with its tasks; listForThread(V, T) returns []
  describe('INT-5', () => {
    const LATCH_MS = 15_000;
    const workflowType = uniqueWorkflowType('int5');

    const bytes = (text: string) => new TextEncoder().encode(text);
    const handler = testHandler(workflowType, async (ctx) => {
      const key = typeof ctx.input.key === 'string' ? ctx.input.key : '';
      const ref = await ctx.putEvidence(
        evidenceInput(`${key}-page`, bytes(`${key} page`)),
      );
      return completed({ evidenceRefs: [ref.evidenceId] });
    });

    let runtime: RuntimeHarness;

    beforeAll(async () => {
      runtime = await createRuntimeHarness({
        handlers: [handler],
        runtime: { concurrency: 4, dbPoolMax: 8 },
      });
    });

    afterAll(async () => {
      try {
        await runtimeWorkSettled([workflowType], LATCH_MS);
      } finally {
        await runtime?.close();
        await closeRuntimeDb();
      }
    }, 2 * LATCH_MS);

    async function newInvestigation(
      resourceId: string,
      threadId: string,
    ): Promise<string> {
      const { investigationId } = await runtime.investigations.create({
        resourceId,
        threadId,
        query: 'INT-5',
        budget: { maxTasks: 10, maxToolCalls: 20 },
      });
      return investigationId;
    }

    async function create(investigationId: string, key: string) {
      const result = await runtime.scheduler.propose(
        taskSpec({ investigationId, workflowType, input: { key } }),
        'int5-requester',
      );
      if (result.outcome !== 'created') {
        throw new Error(`task not created: ${JSON.stringify(result)}`);
      }
      return result.taskId;
    }

    async function statusOf(taskId: string): Promise<string | undefined> {
      const [row] = await query<{ status: string }>(
        'SELECT status FROM app.research_tasks WHERE task_id = $1',
        [taskId],
      );
      return row?.status;
    }

    async function settledAs(taskId: string, status: string): Promise<void> {
      await vi.waitFor(
        async () => {
          expect(await statusOf(taskId)).toBe(status);
        },
        { timeout: LATCH_MS, interval: 25 },
      );
    }

    /** An investigation of the thread with one succeeded task holding one evidence with content. */
    async function investigationWithEvidence(
      resourceId: string,
      threadId: string,
    ): Promise<string> {
      const investigationId = await newInvestigation(resourceId, threadId);
      await settledAs(await create(investigationId, 'evidence'), 'succeeded');
      return investigationId;
    }

    it("INT-5 visibility: a thread's investigations are listed only for its owner", async () => {
      const owner = newUser();
      const other = newUser();
      const threadId = await runtime.createThread(owner);
      const investigationId = await investigationWithEvidence(owner, threadId);

      const listed = await runtime.investigations.listForThread(
        owner,
        threadId,
      );
      expect(listed.map((row) => row.investigationId)).toEqual([
        investigationId,
      ]);
      expect(listed[0].tasks?.map((task) => task.status)).toEqual([
        'succeeded',
      ]);
      expect(
        await runtime.investigations.listForThread(other, threadId),
      ).toEqual([]);
    }, 30_000);
  });
});
