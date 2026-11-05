// research-runtime / runtime — wiring of the composition root (`ResearchModule` in apps/api) against real Postgres.
// Design Doc: docs/features/research-runtime/design-runtime.md (KD-5, KD-7, "Функции сборки и порты", ThreadDeletionHook, Test Strategy: UC-E8). ADR-0004.
// The runtime's own behaviour is proven in packages/runtime/test; this file proves only what a package test cannot see:
// the real ThreadsService behind the ThreadOwnership port and the deletion hook (INT-5 rows moved from
// research-runtime-runtime.int.e2e-spec.ts with their assertions unchanged, plus the 404 row of `create`), and the binding of
// `start`, `stop` and the pool's `close()` to the Nest phases (UC-E8).
// Run: `pnpm --filter api test:e2e:runtime`, never in parallel with the runtime package's suites against one database.

import { setTimeout as delay } from 'node:timers/promises';
import { ApiErrorSchema, type ToolCallGrant } from '@agent-os/contracts';
import type { HandlerResult, TaskContext } from '@agent-os/runtime';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRuntimeApp, type RuntimeApp } from './support/runtimeApp.js';
import { newUser } from './support/seed.js';
import {
  closeRuntimeDb,
  completed,
  evidenceInput,
  type Latch,
  latch,
  query,
  taskSpec,
  testHandler,
  uniqueWorkflowType,
  within,
} from './support/wiring-handlers.js';

describe('research-runtime / runtime - wiring of ResearchModule (in-process Nest + real Postgres)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  Thread boundary: owner isolation and deletion of a thread's investigations   [EXTRA: budget slot 5 of 5, shared with the package's INT-5]
  // ---------------------------------------------------------------------------------------------------------------
  // Unique defect no other test catches: the only test that crosses ThreadsService.delete (stop -> cancelRunsThen -> purge -> deleteThread) and ThreadsService.withOwnedThread
  // behind the ThreadOwnership port - a wrong-owner create or delete, a source call after deletion, a stale row reappearing, or a failed purge that still deletes the thread.
  // The visibility row (AC-01.1, the owner filter of listForThread) lives in packages/runtime/test with the runtime it proves.
  // Covers (original statements):
  // AC-23.1: "Given у беседы T пользователя U есть расследование с задачами, событиями и evidence, When беседа T удалена, Then в хранилище не осталось ни расследования, ни его задач, событий, evidence и содержимого выходов."
  // AC-23.2: "Given fetch-задача расследования беседы T в running, When беседа T удалена, Then после удаления источник не вызван ни разу и ни одна запись расследования не появилась снова."
  // AC-23.3: "Given расследования другого пользователя и расследования другой беседы пользователя U, When пользователь U удаляет беседу T, Then эти расследования, их задачи и evidence не изменились."
  // AC-23.5: "Given удаление данных расследований не удалось, Then беседа не удалена, запрос удаления завершается ошибкой, и повторный запрос удаляет и расследования, и беседу."
  // Use cases: UC-1, UC-17. EARS: When / If-then. Design flow: Flow 5, KD-5, ThreadDeletionHook table. AC-23.4 (thread without investigations) is the unchanged chat-shell suite, not repeated here.
  //
  // Primary failure mode (turns red when): ResearchModule passes a ThreadOwnership that skips ThreadsService, `purge` leaves a child table's rows (cascade not from research_investigations), `stop` does not set `cancel_requested_at` so a running handler can still reserve a call,
  // or ThreadsService deletes the thread although the purge failed (no 500, no retry path).
  // ROI: 5.3 | Business Value: 8 (user data deletion, tenant isolation) | Frequency: 5 | Legal: true (data deletion on user request) | Defect Detection: 8
  // Behavior: DELETE /api/threads/:threadId by U -> T's investigations and all dependent rows are gone, other threads and users untouched, nothing recreated; a failing purge gives 500, thread and its investigations remain consistent, the retry deletes both
  // @category: integration
  // @dependency: ThreadsService (real), ThreadDeletionHooks, InvestigationService, Dispatcher + test handler with a call counter, Memory (mastra_* via ThreadsService), HTTP (supertest), Postgres
  // @complexity: high
  //
  // Verification items:
  // - Arrange for deletion: U owns T and T2 (investigation each), V owns T3 (investigation); in T a task is `running` inside a handler blocked on a latch and calls a counted test "source" after being released; evidence with content exists for all three
  // - Delete T as U -> 204; zero rows with T's investigationId in investigations, tasks, dependencies, subscribers, events, deliveries, evidence, evidence_contents
  // - After release of the latch: the counted source was never reached after the delete, `reserveToolCall` is refused/fenced, and no row for T's investigation reappears (re-check after the settle window)
  // - U's T2 investigation and V's T3 investigation: full row snapshots (including `state_version`) equal to the ones taken before the delete
  // - Failure path: inject a failure of the purge in the database itself (for example a temporary BEFORE DELETE trigger raising on one of T's child tables), not by replacing a component -> DELETE returns the existing 500, the thread still exists
  //   in Memory, T's investigation is `deleting` and its tasks do not run; its unfinished task (running in another instance, blocked on a latch) has `cancel_requested_at`, and once released
  //   its `reserveToolCall` is refused with `cancel_requested` (the stop's guard, not the purge's fence); remove the failure, repeat DELETE -> 204, investigation rows and thread both gone
  // - Status code and body shapes follow chat-shell's existing error contract (ApiErrorSchema from @agent-os/contracts)
  // - Visibility on create (UC-1): InvestigationService.create for V on U's thread T -> the threads API's 404 through ThreadsService, no investigation row for V
  // The test app has no `configureApp` (`createRuntimeApp`), so the route is `/threads/:threadId` — the same controller, guard and pipe as `/api/threads/:threadId`.
  describe('INT-5', () => {
    const LATCH_MS = 15_000;
    const workflowType = uniqueWorkflowType('int5');

    /** Behaviour of the tasks whose `input.key` names it; any other task stores one evidence and completes. */
    const scripts = new Map<
      string,
      (ctx: TaskContext) => Promise<HandlerResult>
    >();
    const opened: Latch[] = [];
    const gate = (): Latch => {
      const gateLatch = latch();
      opened.push(gateLatch);
      return gateLatch;
    };
    const bytes = (text: string) => new TextEncoder().encode(text);
    const handler = testHandler(workflowType, async (ctx) => {
      const key = typeof ctx.input.key === 'string' ? ctx.input.key : '';
      const script = scripts.get(key);
      if (script) return script(ctx);
      const ref = await ctx.putEvidence(
        evidenceInput(`${key}-page`, bytes(`${key} page`)),
      );
      return completed({ evidenceRefs: [ref.evidenceId] });
    });

    let runtime: RuntimeApp;
    let http: ReturnType<typeof request>;

    beforeAll(async () => {
      runtime = await createRuntimeApp({
        handlers: [handler],
        runtime: { concurrency: 4, dbPoolMax: 8 },
      });
      http = request(runtime.app.getHttpServer());
    });

    afterAll(async () => {
      for (const open of opened) open.release();
      await runtime?.close();
      await closeRuntimeDb();
    });

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

    /** Ids of the investigation's rows in the tables a cascade reaches only through another row. */
    async function childIds(investigationId: string) {
      const [row] = await query<{
        taskIds: string[];
        eventIds: string[];
        evidenceIds: string[];
      }>(
        `SELECT
           ARRAY(SELECT task_id::text FROM app.research_tasks WHERE investigation_id = $1) AS "taskIds",
           ARRAY(SELECT event_id::text FROM app.research_events WHERE investigation_id = $1) AS "eventIds",
           ARRAY(SELECT evidence_id::text FROM app.research_evidence WHERE investigation_id = $1) AS "evidenceIds"`,
        [investigationId],
      );
      return row;
    }

    /** Rows per research_* table that still belong to the investigation (`ids` read before the delete). */
    async function rowsLeft(
      investigationId: string,
      ids: Awaited<ReturnType<typeof childIds>>,
    ): Promise<Record<string, number>> {
      const [row] = await query<Record<string, number>>(
        `SELECT
           (SELECT count(*)::int FROM app.research_investigations WHERE investigation_id = $1) AS investigations,
           (SELECT count(*)::int FROM app.research_tasks WHERE investigation_id = $1) AS tasks,
           (SELECT count(*)::int FROM app.research_task_dependencies WHERE investigation_id = $1) AS dependencies,
           (SELECT count(*)::int FROM app.research_task_subscribers WHERE task_id = ANY($2::uuid[])) AS subscribers,
           (SELECT count(*)::int FROM app.research_events WHERE investigation_id = $1) AS events,
           (SELECT count(*)::int FROM app.research_event_deliveries WHERE event_id = ANY($3::uuid[])) AS deliveries,
           (SELECT count(*)::int FROM app.research_evidence WHERE investigation_id = $1) AS evidence,
           (SELECT count(*)::int FROM app.research_evidence_contents WHERE evidence_id = ANY($4::uuid[])) AS "evidenceContents"`,
        [investigationId, ids.taskIds, ids.eventIds, ids.evidenceIds],
      );
      return row;
    }

    const NOTHING_LEFT = {
      investigations: 0,
      tasks: 0,
      dependencies: 0,
      subscribers: 0,
      events: 0,
      deliveries: 0,
      evidence: 0,
      evidenceContents: 0,
    };

    /** Every research_* row of the investigation as JSON, `state_version` and delivery counters included. */
    async function snapshot(investigationId: string): Promise<unknown> {
      const [row] = await query<{ snapshot: unknown }>(
        `SELECT jsonb_build_object(
           'investigation', (SELECT to_jsonb(i) FROM app.research_investigations i WHERE i.investigation_id = $1),
           'tasks', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.task_id) FROM app.research_tasks t WHERE t.investigation_id = $1),
           'subscribers', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.task_id, s.subscriber_key) FROM app.research_task_subscribers s
                             JOIN app.research_tasks t ON t.task_id = s.task_id WHERE t.investigation_id = $1),
           'events', (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.seq) FROM app.research_events e WHERE e.investigation_id = $1),
           'deliveries', (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.event_id, d.consumer)
                            FROM app.research_event_deliveries d
                            JOIN app.research_events e ON e.event_id = d.event_id WHERE e.investigation_id = $1),
           'evidence', (SELECT jsonb_agg(to_jsonb(v) ORDER BY v.evidence_id) FROM app.research_evidence v WHERE v.investigation_id = $1),
           'contents', (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.evidence_id) FROM app.research_evidence_contents c
                          JOIN app.research_evidence v ON v.evidence_id = c.evidence_id WHERE v.investigation_id = $1)
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

    const deleteThread = (threadId: string, userId: string) =>
      http.delete(`/threads/${threadId}`).set('x-user-id', userId);

    const getThread = (threadId: string, userId: string) =>
      http.get(`/threads/${threadId}`).set('x-user-id', userId);

    // The ThreadOwnership port is ThreadsService itself: a double that just calls the function would let this through.
    it('INT-5 ownership port: another user cannot create an investigation on a thread (404 through ThreadsService, nothing written)', async () => {
      const owner = newUser();
      const other = newUser();
      const threadId = await runtime.createThread(owner);

      await expect(
        runtime.investigations.create({
          resourceId: other,
          threadId,
          query: 'INT-5 foreign thread',
          budget: { maxTasks: 10, maxToolCalls: 20 },
        }),
      ).rejects.toMatchObject({
        status: 404,
        response: { errorCode: 'THREAD_NOT_FOUND' },
      });
      expect(
        await query(
          'SELECT investigation_id FROM app.research_investigations WHERE resource_id = $1',
          [other],
        ),
      ).toEqual([]);
    }, 30_000);

    it('INT-5 deletion: DELETE of a thread removes its investigations with every dependent row, its running handler reaches no source afterwards, and other threads and users are untouched', async () => {
      const owner = newUser();
      const other = newUser();
      const threadId = await runtime.createThread(owner);
      const siblingThreadId = await runtime.createThread(owner);
      const foreignThreadId = await runtime.createThread(other);

      const investigationId = await investigationWithEvidence(owner, threadId);
      const siblingId = await investigationWithEvidence(owner, siblingThreadId);
      const foreignId = await investigationWithEvidence(other, foreignThreadId);

      // Running in this process, blocked until the thread is deleted; then it asks for a source call.
      const started = gate();
      const held = gate();
      const finished = gate();
      let sourceCalls = 0;
      let grant: ToolCallGrant | undefined;
      let lateEvidence = 'not tried';
      scripts.set('int5-running', async (ctx) => {
        started.release();
        await held.promise;
        try {
          grant = await ctx.reserveToolCall('fixture.read', false);
          if (grant.granted) sourceCalls += 1;
          lateEvidence = await ctx
            .putEvidence(evidenceInput('int5-late', bytes('late page')))
            .then(
              () => 'returned',
              (error: unknown) =>
                error instanceof Error ? error.name : 'unknown',
            );
          return completed();
        } finally {
          finished.release();
        }
      });
      const runningId = await create(investigationId, 'int5-running');
      await within(started.promise, LATCH_MS, 'the running attempt');

      const ids = await childIds(investigationId);
      expect(ids.taskIds).toHaveLength(2);
      expect(ids.evidenceIds).toHaveLength(1);
      expect(ids.eventIds.length).toBeGreaterThan(0);
      const siblingBefore = await quietSnapshot(siblingId);
      const foreignBefore = await quietSnapshot(foreignId);

      const response = await deleteThread(threadId, owner);

      expect(response.status).toBe(204);
      expect(await rowsLeft(investigationId, ids)).toEqual(NOTHING_LEFT);
      expect((await getThread(threadId, owner)).status).toBe(404);
      expect(await statusOf(runningId)).toBeUndefined();

      // The handler resumes after the delete: its reservation is refused and nothing reappears.
      held.release();
      await within(finished.promise, LATCH_MS, 'the resumed handler');
      expect(grant).toEqual({ granted: false, reason: 'not_current_attempt' });
      expect(sourceCalls).toBe(0);
      expect(lateEvidence).not.toBe('returned');
      expect(await rowsLeft(investigationId, ids)).toEqual(NOTHING_LEFT);

      expect(await snapshot(siblingId)).toEqual(siblingBefore);
      expect(await snapshot(foreignId)).toEqual(foreignBefore);
      expect((await getThread(siblingThreadId, owner)).status).toBe(200);
      expect((await getThread(foreignThreadId, other)).status).toBe(200);
    }, 30_000);

    it('INT-5 failure path: a purge failing in the database answers 500 and keeps the thread with its investigation stopped and its running task cancel-requested; the retry deletes both', async () => {
      const owner = newUser();
      const threadId = await runtime.createThread(owner);
      const investigationId = await investigationWithEvidence(owner, threadId);

      // Running in another instance, which learns of the stop only through its next reservation.
      const remoteType = uniqueWorkflowType('int5-remote');
      const remoteStarted = gate();
      const resumeRemote = gate();
      const remoteReserved = gate();
      let remoteReserve: ToolCallGrant | undefined;
      const remote = await createRuntimeApp({
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
      let remoteId: string;
      try {
        const proposed = await remote.scheduler.propose(
          taskSpec({
            investigationId,
            workflowType: remoteType,
            input: { key: 'int5-remote' },
          }),
          'int5-requester',
        );
        if (proposed.outcome !== 'created') {
          throw new Error(`task not created: ${JSON.stringify(proposed)}`);
        }
        remoteId = proposed.taskId;
        await within(remoteStarted.promise, LATCH_MS, 'the remote attempt');

        // The failure is the database's own: a temporary trigger refuses deleting this investigation's tasks.
        expect(investigationId).toMatch(/^[0-9a-f-]{36}$/);
        const name = `int5_fail_purge_${investigationId.replaceAll('-', '')}`;
        await query(
          `CREATE FUNCTION app.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'INT-5 injected purge failure'; END $$`,
          [],
        );
        try {
          await query(
            `CREATE TRIGGER ${name} BEFORE DELETE ON app.research_tasks FOR EACH ROW
             WHEN (OLD.investigation_id = '${investigationId}') EXECUTE FUNCTION app.${name}()`,
            [],
          );

          const failed = await deleteThread(threadId, owner);

          expect(failed.status).toBe(500);
          expect(ApiErrorSchema.parse(failed.body).statusCode).toBe(500);
          expect((await getThread(threadId, owner)).status).toBe(200);
          const [investigation] = await query<{ status: string }>(
            'SELECT status FROM app.research_investigations WHERE investigation_id = $1',
            [investigationId],
          );
          expect(investigation.status).toBe('deleting');
          expect(
            await runtime.scheduler.propose(
              taskSpec({
                investigationId,
                workflowType,
                input: { key: 'late' },
              }),
              'int5-requester',
            ),
          ).toMatchObject({
            outcome: 'rejected',
            reason: 'investigation_inactive',
          });
          // The stop committed before the purge failed: the unfinished task is cancel-requested.
          const [stopped] = await query<{
            status: string;
            cancelRequested: boolean;
          }>(
            `SELECT status, cancel_requested_at IS NOT NULL AS "cancelRequested"
             FROM app.research_tasks WHERE task_id = $1`,
            [remoteId],
          );
          expect(stopped).toEqual({ status: 'running', cancelRequested: true });
        } finally {
          await query(
            `DROP TRIGGER IF EXISTS ${name} ON app.research_tasks`,
            [],
          );
          await query(`DROP FUNCTION IF EXISTS app.${name}()`, []);
        }

        // Released before the retry: the remote attempt's reservation is refused by the stop.
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
      } finally {
        resumeRemote.release();
        await remote.close();
      }
      const ids = await childIds(investigationId);
      expect(ids.taskIds).toHaveLength(2);

      const retried = await deleteThread(threadId, owner);

      expect(retried.status).toBe(204);
      expect(await rowsLeft(investigationId, ids)).toEqual(NOTHING_LEFT);
      expect((await getThread(threadId, owner)).status).toBe(404);
    }, 30_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // UC-E8  Nest phases of ResearchModule: workers start and stop with the application, the pool closes after them
  // ---------------------------------------------------------------------------------------------------------------
  // Budget: a sixth integration group beyond the limit of 5, required by the design (Test Strategy: UC-E8); the plan records it as an accepted
  // budget exception.
  // Unique defect no other test catches: the order of `runtime.stop()` and the pool's `close()` in the Nest phases (KD-7). The package's INT-3 R7 calls
  // `stop()` then `close()` itself; only the real module can close the pool too early or start workers under RUNTIME_WORKERS=off.
  // Covers: AC-RT-5 ("stop returns running tasks to queued"), Use case UC-E8. Design: KD-7, "Функции сборки и порты".
  // Primary failure mode (turns red when): ResearchModule closes the pool in `beforeApplicationShutdown` before `runtime.stop()` (the requeue cannot be written,
  // the task stays running), or starts the workers although RUNTIME_WORKERS=off.
  // Each row runs its own app; the thread and the investigation belong to an app without workers, whose DELETE removes them afterwards.
  describe('UC-E8', () => {
    const LATCH_MS = 15_000;
    /** How long the app without workers is watched for a claim: many poll periods of the row app (50 ms). */
    const WATCH_MS = 500;

    let owner: RuntimeApp;
    let http: ReturnType<typeof request>;

    beforeAll(async () => {
      owner = await createRuntimeApp({
        handlers: [],
        runtime: { workers: false },
      });
      http = request(owner.app.getHttpServer());
    });

    afterAll(async () => {
      await owner?.close();
      await closeRuntimeDb();
    });

    const whenAborted = (signal: AbortSignal): Promise<void> =>
      new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });

    async function taskState(taskId: string) {
      const [row] = await query<{
        status: string;
        attempt: number;
        recoveryCount: number;
      }>(
        `SELECT status, attempt, recovery_count AS "recoveryCount"
           FROM app.research_tasks WHERE task_id = $1`,
        [taskId],
      );
      return row;
    }

    it.each([
      {
        workers: true,
        name: 'RUNTIME_WORKERS=on: app.close() with a running task returns it to queued without a recovery, with no error from a closed pool',
        end: { status: 'queued', attempt: 1, recoveryCount: 0 },
        handlerCalls: 1,
      },
      {
        workers: false,
        name: 'RUNTIME_WORKERS=off: a ready task stays queued and its handler is never called',
        end: { status: 'queued', attempt: 0, recoveryCount: 0 },
        handlerCalls: 0,
      },
    ])(
      '$name',
      async ({ workers, end, handlerCalls }) => {
        const resourceId = newUser();
        const threadId = await owner.createThread(resourceId);
        const { investigationId } = await owner.investigations.create({
          resourceId,
          threadId,
          query: 'UC-E8',
          budget: { maxTasks: 1, maxToolCalls: 2 },
        });
        const workflowType = uniqueWorkflowType('uc-e8');
        const started = latch();
        let calls = 0;
        const row = await createRuntimeApp({
          handlers: [
            testHandler(workflowType, async (ctx) => {
              calls += 1;
              started.release();
              await whenAborted(ctx.signal);
              return completed();
            }),
          ],
          runtime: { workers },
        });
        const errors = vi.spyOn(Logger.prototype, 'error');
        let closed = false;
        try {
          const proposed = await row.scheduler.propose(
            taskSpec({
              investigationId,
              workflowType,
              input: { key: 'uc-e8' },
            }),
            'uc-e8-requester',
          );
          if (proposed.outcome !== 'created') {
            throw new Error(`task not created: ${JSON.stringify(proposed)}`);
          }
          if (workers) await within(started.promise, LATCH_MS, 'the attempt');
          else await delay(WATCH_MS);
          errors.mockClear();

          closed = true;
          await row.app.close();

          expect(await taskState(proposed.taskId)).toEqual(end);
          expect(calls).toBe(handlerCalls);
          expect(errors.mock.calls).toEqual([]);
        } finally {
          errors.mockRestore();
          if (!closed) await row.close();
          await http
            .delete(`/threads/${threadId}`)
            .set('x-user-id', resourceId);
        }
      },
      30_000,
    );
  });
});
