// research-runtime / mcp-source E2E Test Skeletons - Design Doc: docs/features/research-runtime/design-mcp-source.md
// Upstream contract consumed: docs/features/research-runtime/design-runtime.md
// PRD: docs/features/research-runtime/prd.md (metrics 1 and 3, outcomes list under "Исходы сквозного сценария")
// Generated: 2026-10-31 | Part: mcp-source | Test type: End-to-End (real Postgres + real fixture process), CI job `e2e-runtime`
// Implementation timing: after all mcp-source and runtime implementation tasks complete (final phase only).
//
// File name follows the project convention (`*.e2e-spec.ts` under packages/sources/test, picked up by packages/sources/vitest.config.e2e.ts and run with
// `pnpm --filter @agent-os/sources test:e2e`).
//
// Environment (Design Doc "Test Boundaries"):
// - Postgres from infra/docker-compose.yml (DATABASE_URL from apps/api/.env). No table cleanup; isolation by a unique `resourceId = 'e2e-' + randomUUID()` per test.
// - Real fixture process (FIXTURE_FAULTS and FIXTURE_CALL_LOG in a per-test temp dir). The fixture call log is the independent call counter.
// - Per-test fault rules keyed by argsHash with a distinct window / filter per test, so tests never share a journal or an occurrence counter.
// - Backoff jitter and clock injected; no LLM, no network.
// - The Design Doc lists UC-7 (stub adapter) under e2e-runtime; it needs no database and is proven at unit level instead (see the int skeleton file).
//
// E2E-1 registers a probe handler next to `source.fetch`: the other side of the dependency and of the refused wait.
//
// Budget: E2E 2 of 2. Raw-formula ROI is low for both because the formula divides by an E2E cost of 38; they are kept because the Design Doc and PRD make them the
// acceptance gates (metrics 1, 3) and nothing at a lower level can prove Postgres-backed fencing, recovery and storage.

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProposeResult, Task, TaskSpec } from '@agent-os/contracts';
import { argsHash, fixtureServerPath } from '@agent-os/mcp-fixture';
import type { HandlerResult, RegisterWaitResult, TaskContext, TaskHandler, UpstreamTask } from '@agent-os/runtime';
import { FIXTURE_SOURCE_ID, McpSourceClient, parseSourcesSettings } from '@agent-os/sources';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CRASH_EXIT_CODE, runFetchRecovery } from './support/fetchChild.js';
import {
  type CallLogLine,
  createSourcesHarness,
  type FetchArgs,
  type FetchRequest,
  type FixtureFaultRule,
  type FixtureFiles,
  fixtureFiles,
  proposeFetch,
  type ProposedFetch,
  SEARCH_LOGS,
  SOURCE_FETCH,
  type SourcesHarness,
  TEST_SOURCES_ENV,
} from './support/runtimeHarness.js';

describe('research-runtime / mcp-source - E2E (real Postgres, real fixture)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  User journey: the acceptance scenario, repeated
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: an investigation fetches logs from the fixture, dependent work waits for it, duplicates collapse to one source call, a deadlock is refused,
  // a mid-investigation restart loses nothing, empty / tool error / transport failure are told apart, and a new snapshot never reuses the old result.
  // Covers:
  // AC-12.1: "Given fetch-задача вызвала инструмент поиска fixture, Then её evidence содержит все поля provenance из FR-12, а выходные ссылки задачи указывают на это evidence."
  // PRD metric 1: "7 из 7 исходов из списка ниже" - integration test against Postgres and fixture, 20 consecutive runs without a failure. The seven outcomes:
  //   1. fetch task stores evidence with provenance (AC-12.1)
  //   2. dependent task starts only after its dependency succeeds (AC-04.1)
  //   3. a repeated identical request becomes a subscriber with one source call (AC-06.1)
  //   4. mutual wait of A and B is rejected (AC-07.1)
  //   5. a restart in the middle of an investigation passes without loss or duplicates (AC-08.1, AC-08.2)
  //   6. empty result, tool error and transport failure are distinguished (FR-13)
  //   7. a new data snapshot does not reuse an old result (AC-06.4)
  // PRD metric 3: "1 вызов источника в 20 из 20 прогонов сценария AC-06.2" (10 identical requests -> 1 call in the fixture log).
  // Use cases: UC-8, UC-1 (EARS: When - event-driven, end to end).
  //
  // Primary failure mode (turns red when): any of the seven outcomes breaks in the assembled system (runtime + sources + Postgres + fixture) - most likely a duplicate source
  // call under concurrency (log > 1 for 10 identical requests), evidence missing a provenance field, or an old snapshot's result returned for the new snapshot.
  // ROI: 2.6 (raw formula: (10 x 9 + 0 + 9) / 38) | Business Value: 10 (the part's acceptance criterion) | Frequency: 9 (core flow) | Legal: false
  // Behavior: seven-outcome scenario against real Postgres + fixture, repeated 20 times -> every outcome holds in every run; 10 simultaneous identical requests -> exactly 1 line in the fixture log
  // @category: e2e
  // @dependency: full-system (Dispatcher, FetchHandler, ToolExecutor, SourceRegistry, mcp-fixture, Postgres)
  // @complexity: high
  //
  // Verification items:
  // - Outcome 1: a `search_logs` task over the hour after the release on snapshot v1 is `succeeded`; every stored evidence has all FR-12 provenance fields (tool, normalizedArgs,
  //   snapshot, coverage, content type / hash); `outputRefs` equal exactly those evidence ids (UC-1)
  // - Outcomes 2-5 are asserted through the runtime's public ports; this test only fixes that they hold with a real MCP source underneath (no re-test of runtime internals)
  // - Outcome 6: three tasks - empty filter (succeeded, observed with 0 matches), tool_error (failed tool_error), crash_process on all occurrences (failed transport_protocol) - end in three different classes
  // - Outcome 7: same request on fixture v1 then v2 -> a new task, a new source call, evidence snapshot differs
  // - Metric 3: per run, the fixture call log has exactly 1 line for the 10 simultaneous identical requests; the check is repeated for all 20 runs
  // - All 20 runs pass independently (fresh resourceId and fresh fault / log files per run)
  describe('E2E-1: the seven-outcome acceptance scenario holds in 20 consecutive runs, with provenance on every evidence and exactly one source call for 10 identical requests', () => {
    const RUNS = Array.from({ length: 20 }, (_, index) => index + 1);
    /** Snapshot of the fixture's `v1` dataset (`fx-<version>-<8 hex of the generator parameters>`). */
    const V1_SNAPSHOT = 'fx-v1-2157485c';
    const V2_SNAPSHOT = 'fx-v2-5311fe55';
    const PROBE = 'e2e.probe';
    const REQUESTER = 'e2e-1';
    const IDENTICAL_REQUESTS = 10;
    const MAX_RETRIES = 3;
    /** Keeps the shared call open while the 10 admissions land, so all of them meet a live task. */
    const IDENTICAL_HOLD_MS = 2_000;
    /** Keeps the call of page 3 open while the first assembly closes; the stop aborts it long before. */
    const RESTART_HOLD_MS = 20_000;
    const TASK_END_MS = 60_000;
    const POLL_MS = 50;

    /** UC-1: the hour after the release, one service, on several pages. */
    const RELEASE_HOUR = { from: '2026-09-15T00:00:00.000Z', to: '2026-09-15T01:00:00.000Z', service: 'provider-adapter', pageSize: 500 };
    /** Counted from the generator: the same 665 records on `v1` and `v2`, two pages of 500. */
    const RELEASE_HOUR_MATCHES = 665;
    const RELEASE_HOUR_PAGES = 2;
    /** Each outcome has a window or filter of its own, so its calls and its fault rule are its own. */
    const IDENTICAL = { from: '2026-09-14T01:00:00.000Z', to: '2026-09-14T01:10:00.000Z', pageSize: 500 };
    const DEPENDENT = { from: '2026-09-14T02:00:00.000Z', to: '2026-09-14T02:10:00.000Z', pageSize: 500 };
    const EMPTY = { ...RELEASE_HOUR, event: 'e2e.no-such-event' };
    const TOOL_ERROR = { from: '2026-09-14T03:00:00.000Z', to: '2026-09-14T03:10:00.000Z', pageSize: 500 };
    const CRASH = { from: '2026-09-14T04:00:00.000Z', to: '2026-09-14T04:10:00.000Z', pageSize: 500 };
    /** A window of exactly 2 500 `v1` records: five pages of 500. */
    const RESTART = { from: '2026-09-14T07:00:00.000Z', to: '2026-09-14T08:00:01.000Z', pageSize: 500 };
    const RESTART_PAGE_KEYS = ['page-0001', 'page-0002', 'page-0003', 'page-0004', 'page-0005'];

    const FAULT_RULES: readonly FixtureFaultRule[] = [
      { tool: SEARCH_LOGS, argsHash: argsHash(IDENTICAL), occurrences: [1], mode: 'delay_ms', ms: IDENTICAL_HOLD_MS },
      { tool: SEARCH_LOGS, argsHash: argsHash(TOOL_ERROR), occurrences: 'all', mode: 'tool_error' },
      { tool: SEARCH_LOGS, argsHash: argsHash(CRASH), occurrences: 'all', mode: 'crash_process' },
      { tool: SEARCH_LOGS, argsHash: argsHash(RESTART), occurrences: [3], mode: 'delay_ms', ms: RESTART_HOLD_MS },
    ];

    /** What a probe task does when it runs, by the `script` of its input; set by the run that proposes it. */
    const probeScripts = new Map<string, (ctx: TaskContext) => Promise<HandlerResult>>();
    const ProbeInputSchema = z.object({ script: z.string().min(1) });
    /** A test handler beside `source.fetch`: the other side of a dependency or of a wait. */
    const probeHandler: TaskHandler = {
      workflowType: PROBE,
      workflowVersion: 1,
      inputSchema: ProbeInputSchema,
      run(ctx) {
        const { script } = ProbeInputSchema.parse(ctx.input);
        const run = probeScripts.get(script);
        if (run === undefined) throw new Error(`No probe script ${script}`);
        return run(ctx);
      },
    };
    const probeCompleted: HandlerResult = {
      kind: 'completed',
      answerOrDelta: null,
      evidenceRefs: [],
      coverage: null,
      missingEvidence: [],
      warnings: [],
      proposedTasks: [],
    };

    /** One run: its own resource, investigation, fault rules and call log. */
    interface ScenarioRun {
      readonly resourceId: string;
      readonly threadId: string;
      readonly investigationId: string;
      readonly files: FixtureFiles;
    }

    interface EvidenceRow {
      readonly evidenceId: string;
      readonly evidenceKey: string;
      readonly sha256: string;
      readonly writtenByAttempt: number;
    }

    const ended = (task: Task): boolean => ['succeeded', 'failed', 'cancelled'].includes(task.status);
    const pageKey = (index: number): string => `page-${String(index + 1).padStart(4, '0')}`;

    function assemble(files: FixtureFiles, dataset: 'v1' | 'v2'): SourcesHarness {
      return createSourcesHarness({
        sources: parseSourcesSettings({ ...TEST_SOURCES_ENV, ...files.env, FIXTURE_DATASET: dataset }),
        handlers: [probeHandler],
      });
    }

    /**
     * Runs `body` on a new assembly over the run's fixture files and closes it. A later assembly adopts the run's
     * thread. When `body` fails, the run's investigation is cancelled first, so its unfinished tasks do not reach the
     * assembly of a later run, which claims every ready task of a registered type.
     */
    async function inAssembly<T>(
      files: FixtureFiles,
      dataset: 'v1' | 'v2',
      scenario: { readonly run?: ScenarioRun },
      body: (harness: SourcesHarness) => Promise<T>,
    ): Promise<T> {
      const harness = assemble(files, dataset);
      try {
        if (scenario.run !== undefined) harness.createThread(scenario.run.resourceId, scenario.run.threadId);
        return await body(harness);
      } catch (error) {
        const { run } = scenario;
        if (run !== undefined) {
          await harness.runtime.investigations.cancel(run.investigationId, run.resourceId).catch((cancelError: unknown) => {
            throw new AggregateError([error, cancelError], `Run failed, and cancelling investigation ${run.investigationId} failed too`);
          });
        }
        throw error;
      } finally {
        await harness.close();
      }
    }

    async function openRun(harness: SourcesHarness, files: FixtureFiles): Promise<ScenarioRun> {
      const resourceId = `e2e-${randomUUID()}`;
      const threadId = harness.createThread(resourceId);
      const { investigationId } = await harness.runtime.investigations.create({
        resourceId,
        threadId,
        query: 'mcp-source E2E-1',
        budget: { maxTasks: 20, maxToolCalls: 200 },
      });
      return { resourceId, threadId, investigationId, files };
    }

    /** Polls `condition` until it yields a value; a guard on state, not an ordering sleep. */
    async function until<T>(what: string, condition: () => Promise<T | undefined>): Promise<T> {
      const startedAt = Date.now();
      for (;;) {
        const value = await condition();
        if (value !== undefined) return value;
        if (Date.now() - startedAt > TASK_END_MS) throw new Error(`No ${what} within ${TASK_END_MS} ms`);
        await delay(POLL_MS);
      }
    }

    function fetchSpec(
      run: ScenarioRun,
      args: FetchArgs,
      pin: { completeness: 'all' | 'sample'; snapshot: string; dependsOn?: readonly string[] },
    ): TaskSpec {
      return {
        investigationId: run.investigationId,
        workflowType: SOURCE_FETCH,
        workflowVersion: 1,
        input: { sourceId: FIXTURE_SOURCE_ID, toolName: SEARCH_LOGS, args: { ...args } },
        inputRefs: [{ kind: 'source', ref: FIXTURE_SOURCE_ID, snapshot: pin.snapshot }],
        expectedOutput: { description: 'fixture logs of the window', completeness: pin.completeness },
        dependsOn: [...(pin.dependsOn ?? [])],
        budget: { maxToolCalls: 10, maxRetries: MAX_RETRIES, deadlineMs: 120_000, maxTokens: 0 },
      };
    }

    function probeSpec(run: ScenarioRun, script: string, dependsOn: readonly string[]): TaskSpec {
      return {
        investigationId: run.investigationId,
        workflowType: PROBE,
        workflowVersion: 1,
        input: { script },
        inputRefs: [],
        expectedOutput: { description: 'probe', completeness: 'sample' },
        dependsOn: [...dependsOn],
        budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs: 120_000, maxTokens: 0 },
      };
    }

    function createdTask(result: ProposeResult): string {
      if (result.outcome !== 'created') throw new Error(`Expected a new task, got ${JSON.stringify(result)}`);
      return result.taskId;
    }

    async function proposeNew(harness: SourcesHarness, spec: TaskSpec): Promise<string> {
      return createdTask(await harness.runtime.scheduler.propose(spec, REQUESTER));
    }

    /** The task through the runtime's public view of the investigation. */
    async function taskView(harness: SourcesHarness, run: ScenarioRun, taskId: string): Promise<Task> {
      const investigations = await harness.runtime.investigations.listForThread(run.resourceId, run.threadId);
      const task = investigations
        .find((investigation) => investigation.investigationId === run.investigationId)
        ?.tasks?.find((known) => known.taskId === taskId);
      if (task === undefined) throw new Error(`Task ${taskId} is not in investigation ${run.investigationId}`);
      return task;
    }

    function taskEnd(harness: SourcesHarness, run: ScenarioRun, taskId: string): Promise<Task> {
      return until(`end of task ${taskId}`, async () => {
        const task = await taskView(harness, run, taskId);
        return ended(task) ? task : undefined;
      });
    }

    /** Lines of the independent counter for one query: every page of it shares the hash. */
    function callsOf(run: ScenarioRun, args: FetchArgs): CallLogLine[] {
      const hash = argsHash(args);
      return run.files.readCallLog().filter((line) => line.tool === SEARCH_LOGS && line.argsHash === hash);
    }

    /** Every evidence row of the task, by key; a page stored twice shows up as two rows. */
    async function evidenceRows(harness: SourcesHarness, taskId: string): Promise<EvidenceRow[]> {
      const { rows } = await harness.database.pool.query<EvidenceRow>(
        `SELECT e.evidence_id AS "evidenceId", e.evidence_key AS "evidenceKey", c.sha256,
                e.written_by_attempt AS "writtenByAttempt"
           FROM app.research_evidence e
           JOIN app.research_evidence_contents c ON c.evidence_id = e.evidence_id
          WHERE e.task_id = $1 ORDER BY e.evidence_key, e.written_by_attempt`,
        [taskId],
      );
      return rows;
    }

    /**
     * AC-12.1: `outputRefs` are exactly the task's evidence, one row per page, and every page carries the FR-12
     * provenance - source, tool, the arguments with the cursor that fetched it, the pinned snapshot - with its
     * coverage, media type and a hash of its bytes.
     */
    async function expectProvenance(
      harness: SourcesHarness,
      run: ScenarioRun,
      task: Task,
      expected: { args: FetchArgs; snapshot: string; pages: number },
    ): Promise<void> {
      const rows = await evidenceRows(harness, task.taskId);
      expect(rows.map((row) => row.evidenceKey)).toEqual(Array.from({ length: expected.pages }, (_, index) => pageKey(index)));
      expect(task.outputRefs).toEqual(rows.map((row) => row.evidenceId));
      let cursor: string | null = null;
      for (const evidenceId of task.outputRefs) {
        const { record, bytes } = await harness.runtime.evidence.get(evidenceId, run.resourceId);
        expect(record.provenance).toEqual({
          sourceId: 'fixture',
          toolName: 'search_logs',
          normalizedArgs: { ...expected.args, cursor },
          snapshot: expected.snapshot,
        });
        expect(record).toMatchObject({ taskId: task.taskId, mediaType: 'application/json', knowledgeStatus: 'observed' });
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.sha256);
        expect(record.coverage.truncated).toBe(record.coverage.continuation !== null);
        cursor = record.coverage.continuation;
      }
      expect(cursor).toBeNull();
    }

    /** Outcome 1 (AC-12.1, UC-1): the hour after the release on `v1`, every page with provenance. */
    async function evidenceWithProvenance(harness: SourcesHarness, run: ScenarioRun): Promise<Task> {
      const snapshot = await harness.sources.registry.currentSnapshot(FIXTURE_SOURCE_ID, AbortSignal.timeout(TASK_END_MS));
      expect(snapshot).toBe(V1_SNAPSHOT);
      const taskId = await proposeNew(harness, fetchSpec(run, RELEASE_HOUR, { completeness: 'all', snapshot }));

      const task = await taskEnd(harness, run, taskId);

      expect(task.status).toBe('succeeded');
      expect(task.coverage).toEqual({
        completeness: 'complete',
        totalMatched: RELEASE_HOUR_MATCHES,
        totalRelation: 'eq',
        returned: RELEASE_HOUR_MATCHES,
        truncated: false,
        continuation: null,
      });
      await expectProvenance(harness, run, task, { args: RELEASE_HOUR, snapshot: V1_SNAPSHOT, pages: RELEASE_HOUR_PAGES });
      expect(callsOf(run, RELEASE_HOUR)).toHaveLength(RELEASE_HOUR_PAGES);
      return task;
    }

    /** Outcome 3 (AC-06.1) and metric 3 (AC-06.2): 10 simultaneous identical requests, one task, one source call. */
    async function identicalRequestsCollapse(harness: SourcesHarness, run: ScenarioRun): Promise<void> {
      const spec = fetchSpec(run, IDENTICAL, { completeness: 'sample', snapshot: V1_SNAPSHOT });
      const requesters = Array.from({ length: IDENTICAL_REQUESTS }, (_, index) => `${REQUESTER}-requester-${index + 1}`);

      const results = await Promise.all(requesters.map((requester) => harness.runtime.scheduler.propose(spec, requester)));

      expect(results.map((result) => result.outcome).sort()).toEqual(['created', ...Array<string>(IDENTICAL_REQUESTS - 1).fill('subscribed')]);
      const taskIds = new Set(results.map((result) => (result.outcome === 'rejected' ? result.reason : result.taskId)));
      expect(taskIds.size).toBe(1);
      const [taskId] = taskIds;
      const task = await taskEnd(harness, run, taskId);
      expect(task.status).toBe('succeeded');
      expect([...task.subscribers].sort()).toEqual([...requesters].sort());
      expect(task.outputRefs).toHaveLength(1);
      // Metric 3: the independent counter has exactly one line for the 10 requests.
      expect(callsOf(run, IDENTICAL)).toHaveLength(1);
    }

    /**
     * Outcomes 2 (AC-04.1) and 4 (AC-07.1): a fetch task F depends on a probe W, and a probe R depends on F. While W
     * runs, neither F nor R starts and the source is not called; W then registers a wait on F, which closes the cycle
     * W -> F -> W and is refused; all three go on and succeed, and R starts with F succeeded and F's evidence.
     */
    async function dependencyAndRefusedCycle(harness: SourcesHarness, run: ScenarioRun): Promise<void> {
      const waiterScript = `${run.resourceId}:waiter`;
      const readerScript = `${run.resourceId}:reader`;
      let fetchId = '';
      let waiterRunning = false;
      let releaseWaiter = (): void => undefined;
      const waiterReleased = new Promise<void>((resolve) => {
        releaseWaiter = resolve;
      });
      let registered: RegisterWaitResult | undefined;
      let upstreamAtStart: UpstreamTask[] | undefined;
      probeScripts.set(waiterScript, async (ctx) => {
        waiterRunning = true;
        await waiterReleased;
        registered = await ctx.registerWait([fetchId]);
        return probeCompleted;
      });
      probeScripts.set(readerScript, async (ctx) => {
        upstreamAtStart = ctx.upstream.map((upstream) => ({ ...upstream, outputRefs: [...upstream.outputRefs] }));
        return probeCompleted;
      });
      try {
        const waiterId = await proposeNew(harness, probeSpec(run, waiterScript, []));
        fetchId = await proposeNew(
          harness,
          fetchSpec(run, DEPENDENT, { completeness: 'sample', snapshot: V1_SNAPSHOT, dependsOn: [waiterId] }),
        );
        const readerId = await proposeNew(harness, probeSpec(run, readerScript, [fetchId]));
        await until('start of the waiter', async () => (waiterRunning ? true : undefined));

        // AC-04.1: while the dependency runs, the dependents have not started and the source was not called.
        expect((await taskView(harness, run, fetchId)).status).toBe('queued');
        expect((await taskView(harness, run, readerId)).status).toBe('queued');
        expect(callsOf(run, DEPENDENT)).toEqual([]);

        releaseWaiter();
        const [waiter, fetched, reader] = await Promise.all(
          [waiterId, fetchId, readerId].map((taskId) => taskEnd(harness, run, taskId)),
        );

        // AC-07.1: the wait that closes the cycle is refused, naming the cycle from the task that asked.
        expect(registered).toEqual({ outcome: 'rejected', reason: 'wait_cycle', details: { cycle: [waiterId, fetchId] } });
        expect([waiter.status, fetched.status, reader.status]).toEqual(['succeeded', 'succeeded', 'succeeded']);
        // AC-04.1: the dependent starts after its dependency succeeded and gets its evidence.
        expect(fetched.outputRefs).toHaveLength(1);
        expect(upstreamAtStart).toEqual([
          { taskId: fetchId, kind: 'depends_on', status: 'succeeded', outputRefs: fetched.outputRefs },
        ]);
        expect(callsOf(run, DEPENDENT)).toHaveLength(1);
      } finally {
        // On a failure above, the waiter must not hold its slot through the cancel and the stop.
        releaseWaiter();
        probeScripts.delete(waiterScript);
        probeScripts.delete(readerScript);
      }
    }

    /** Outcome 6 (FR-13): an empty result, a tool error and a transport failure end in three different classes. */
    async function threeOutcomeClasses(harness: SourcesHarness, run: ScenarioRun): Promise<void> {
      const fetchToEnd = async (args: FetchArgs): Promise<Task> =>
        taskEnd(harness, run, await proposeNew(harness, fetchSpec(run, args, { completeness: 'all', snapshot: V1_SNAPSHOT })));

      const empty = await fetchToEnd(EMPTY);
      const toolError = await fetchToEnd(TOOL_ERROR);
      // Last: every attempt kills the fixture process, which the next call starts again.
      const crashed = await fetchToEnd(CRASH);

      expect(empty).toMatchObject({
        status: 'succeeded',
        failureReason: null,
        coverage: { completeness: 'complete', totalMatched: 0, totalRelation: 'eq', returned: 0, truncated: false, continuation: null },
      });
      await expectProvenance(harness, run, empty, { args: EMPTY, snapshot: V1_SNAPSHOT, pages: 1 });
      expect(callsOf(run, EMPTY)).toHaveLength(1);

      expect(toolError).toMatchObject({ status: 'failed', outputRefs: [], failureReason: { class: 'tool_error', code: 'tool_error' } });
      expect(callsOf(run, TOOL_ERROR)).toHaveLength(1);

      expect(crashed).toMatchObject({
        status: 'failed',
        outputRefs: [],
        failureReason: { class: 'transport_protocol', code: 'connection_lost' },
      });
      expect(callsOf(run, CRASH)).toHaveLength(1 + MAX_RETRIES);
    }

    /**
     * Outcome 5, first half (AC-08.1, AC-08.2): a five-page task stores pages 1-2 and holds the call of page 3; the
     * pages it stored are read before the assembly closes in the middle of the investigation.
     */
    async function stopMidTask(harness: SourcesHarness, run: ScenarioRun): Promise<{ taskId: string; stored: EvidenceRow[] }> {
      const taskId = await proposeNew(harness, fetchSpec(run, RESTART, { completeness: 'all', snapshot: V1_SNAPSHOT }));
      const stored = await until('pages 1-2 stored and the call of page 3 held', async () => {
        const rows = await evidenceRows(harness, taskId);
        return rows.length === 2 && callsOf(run, RESTART).length === 3 ? rows : undefined;
      });
      return { taskId, stored };
    }

    /** Outcome 5, second half: a new assembly finishes the task with no page lost or stored twice. */
    async function resumeAfterRestart(
      harness: SourcesHarness,
      run: ScenarioRun,
      stopped: { taskId: string; stored: EvidenceRow[] },
    ): Promise<void> {
      const task = await taskEnd(harness, run, stopped.taskId);

      expect(task).toMatchObject({
        status: 'succeeded',
        attempt: 2,
        coverage: { completeness: 'complete', totalMatched: 2_500, totalRelation: 'eq', returned: 2_500 },
      });
      const rows = await evidenceRows(harness, stopped.taskId);
      expect(rows.map((row) => row.evidenceKey)).toEqual(RESTART_PAGE_KEYS);
      expect(rows.slice(0, 2)).toEqual(stopped.stored);
      expect(rows.map((row) => row.writtenByAttempt)).toEqual([1, 1, 2, 2, 2]);
      expect(task.outputRefs).toEqual(rows.map((row) => row.evidenceId));
      // Pages 1-3 by the first fixture process (page 3 aborted), pages 3-5 by the second.
      const calls = callsOf(run, RESTART);
      expect(calls).toHaveLength(6);
      expect(new Set(calls.map((line) => line.pid)).size).toBe(2);
    }

    /** Outcome 7 (AC-06.4): the request of outcome 1 on the `v2` snapshot is a new task with a new call. */
    async function newSnapshotIsNotReused(harness: SourcesHarness, run: ScenarioRun, onV1: Task): Promise<void> {
      const snapshot = await harness.sources.registry.currentSnapshot(FIXTURE_SOURCE_ID, AbortSignal.timeout(TASK_END_MS));
      expect(snapshot).toBe(V2_SNAPSHOT);
      const callsOnV1 = callsOf(run, RELEASE_HOUR);

      const result = await harness.runtime.scheduler.propose(fetchSpec(run, RELEASE_HOUR, { completeness: 'all', snapshot }), REQUESTER);

      const taskId = createdTask(result);
      expect(taskId).not.toBe(onV1.taskId);
      const task = await taskEnd(harness, run, taskId);
      expect(task.status).toBe('succeeded');
      await expectProvenance(harness, run, task, { args: RELEASE_HOUR, snapshot: V2_SNAPSHOT, pages: RELEASE_HOUR_PAGES });
      expect(task.outputRefs.filter((evidenceId) => onV1.outputRefs.includes(evidenceId))).toEqual([]);
      const calls = callsOf(run, RELEASE_HOUR);
      expect(calls).toHaveLength(callsOnV1.length + RELEASE_HOUR_PAGES);
      expect(calls.slice(callsOnV1.length).every((line) => line.pid !== callsOnV1[0].pid)).toBe(true);
    }

    it.each(RUNS)(
      'run %i of 20: provenance, dependency, one call for 10 identical requests, refused cycle, restart, three classes, new snapshot',
      async () => {
        const files = fixtureFiles(FAULT_RULES);
        const scenario: { run?: ScenarioRun } = {};
        try {
          const { run, onV1, stopped } = await inAssembly(files, 'v1', scenario, async (harness) => {
            const opened = await openRun(harness, files);
            scenario.run = opened;
            const evidence = await evidenceWithProvenance(harness, opened);
            await identicalRequestsCollapse(harness, opened);
            await dependencyAndRefusedCycle(harness, opened);
            await threeOutcomeClasses(harness, opened);
            return { run: opened, onV1: evidence, stopped: await stopMidTask(harness, opened) };
          });
          await inAssembly(files, 'v1', scenario, (harness) => resumeAfterRestart(harness, run, stopped));
          await inAssembly(files, 'v2', scenario, (harness) => newSnapshotIsNotReused(harness, run, onV1));
        } finally {
          files.remove();
        }
      },
      300_000,
    );
  });

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2  Durability against Postgres: recovery, cancellation during a call, oversize result
  // ---------------------------------------------------------------------------------------------------------------
  // Covers:
  // AC-MS-8: "When задача восстанавливается после гибели процесса, она продолжает со страницы из checkpoint, а повторно полученная страница даёт тот же `evidenceKey` и `sha256`."
  // AC-20.2: "Given fetch-задача в `running` ждёт ответа источника, When расследование отменено, Then задача `cancelled`, а после отмены источник не вызван ни разу — ни повтором, ни следующей страницей."
  // AC-12.4: "Given результат объёмом 10 MB, Then он сохранён и читается обратно без изменений."
  // Use cases: UC-E11, UC-E9, UC-4 (EARS: When). These need the guarded UPDATE of the reservation, fencing and the evidence store, which the in-memory TaskContext cannot prove.
  //
  // Primary failure mode (turns red when): recovery restarts from page 1 or stores a re-fetched page under a different key / hash (duplicate or divergent evidence); cancel leaves
  // the task `running`/`failed` or lets a retry / next page reach the source after the cancel returns; a 10 MB page is truncated, altered, or killed by the stdio buffer (K-5) instead of stored.
  // ROI: 0.9 (raw formula: (9 x 3 + 0 + 9) / 38) | Business Value: 9 (data loss and phantom calls) | Frequency: 3 (rare paths)
  // Behavior: runtime-driven fetch task against Postgres + fixture -> kill / cancel / oversize page -> task outcome, stored evidence and fixture log match the rows
  // @category: e2e
  // @dependency: full-system (Dispatcher, FetchHandler, ToolExecutor, EvidenceReader, mcp-fixture, Postgres, process kill)
  // @complexity: high
  //
  // Table-driven rows:
  //   recovery (UC-E11, AC-MS-8)      | "all", 5 pages; apps/api killed after page 2 is stored; process restarted
  //                                    | task ends with 5 pages; keys page-0001..0005; sha256 of pages 1-2 equal to the pre-kill values; no duplicate evidence rows
  //   cancel during hang (UC-E9, AC-20.2) | fault `hang`; task is `running` waiting; investigation cancelled via cancel(investigationId, resourceId)
  //                                    | task `cancelled`; fixture log line count taken at cancel return stays unchanged after a bounded wait; no retry, no next page
  //   oversize (UC-4, AC-12.4)         | fault `oversize` to the 10 MB size from AC-12.4; evidence read through EvidenceReader.get
  //                                    | stored; bytes and sha256 equal the canonical JSON of that NormalizedPage; records equal the fixture's structuredContent
  //
  // Verification items:
  // - Recovery row compares sha256 values captured before the kill against the post-recovery rows, not recomputed from the implementation
  // - Cancel row: wait is bounded (no sleep-until-quiet loops); assert on the fixture call log, the independent counter
  // - Oversize row: the page above 1 MiB travels without the `text` duplicate and within half of the stdio buffer, so it must not close the transport
  describe('E2E-2: recovery resumes from the checkpoint with identical page keys and hashes, cancel stops all source calls, and a 10 MB page round-trips unchanged', () => {
    /** A window of exactly 2 500 `v1` records (counted from the generator): five pages of 500. */
    const FIVE_PAGES = { from: '2026-09-14T07:00:00.000Z', to: '2026-09-14T08:00:01.000Z', pageSize: 500 };
    const PAGE_KEYS = ['page-0001', 'page-0002', 'page-0003', 'page-0004', 'page-0005'];
    /** The result size of AC-12.4. */
    const TEN_MB = 10 * 1024 * 1024;
    /** Room for a retry or a next page to reach the fixture after the task ended: the backoff is 10-50 ms. */
    const BOUNDED_WAIT_MS = 500;
    const TASK_END_MS = 60_000;
    const POLL_MS = 50;

    const newResourceId = (): string => `e2e-${randomUUID()}`;
    const ended = (task: Task): boolean => ['succeeded', 'failed', 'cancelled'].includes(task.status);

    /** The in-process assembly over fixture files of its own; both are closed after `run`. */
    async function withHarness<T>(
      rules: readonly FixtureFaultRule[],
      run: (harness: SourcesHarness, files: FixtureFiles) => Promise<T>,
    ): Promise<T> {
      const files = fixtureFiles(rules);
      const harness = createSourcesHarness({ sources: parseSourcesSettings({ ...TEST_SOURCES_ENV, ...files.env }) });
      try {
        return await run(harness, files);
      } finally {
        try {
          await harness.close();
        } finally {
          files.remove();
        }
      }
    }

    /** Polls `condition` until it yields a value; a guard on state, not an ordering sleep. */
    async function until<T>(what: string, condition: () => Promise<T | undefined>): Promise<T> {
      const startedAt = Date.now();
      for (;;) {
        const value = await condition();
        if (value !== undefined) return value;
        if (Date.now() - startedAt > TASK_END_MS) throw new Error(`No ${what} within ${TASK_END_MS} ms`);
        await delay(POLL_MS);
      }
    }

    /** The task through the runtime's public view, once it ended. */
    function taskEnd(harness: SourcesHarness, request: FetchRequest, proposed: ProposedFetch): Promise<Task> {
      return until(`end of task ${proposed.taskId}`, async () => {
        const [investigation] = await harness.runtime.investigations.listForThread(request.resourceId, proposed.threadId);
        const task = investigation?.tasks?.find((known) => known.taskId === proposed.taskId);
        return task !== undefined && ended(task) ? task : undefined;
      });
    }

    /** The fixture's own answer to the call under the rule, read by a bare client of a fixture process of its own. */
    async function rawSearch(rule: FixtureFaultRule, args: FetchArgs): Promise<CallToolResult> {
      const files = fixtureFiles([rule]);
      const client = new McpSourceClient({
        serverPath: fixtureServerPath,
        fixtureEnv: { FIXTURE_DATASET: 'v1', ...files.env },
        logger: { debug: () => undefined },
      });
      try {
        const response = await client.callTool(
          { name: SEARCH_LOGS, arguments: args },
          { timeoutMs: TASK_END_MS, signal: new AbortController().signal },
        );
        if (response.kind !== 'result') throw new Error(`Raw fixture call failed: ${JSON.stringify(response)}`);
        return response.result;
      } finally {
        await client.close();
        files.remove();
      }
    }

    /** `records` of a `search_logs` result as the fixture sent it. */
    function recordsOf(result: CallToolResult): unknown {
      const structured = result.structuredContent;
      return typeof structured === 'object' && structured !== null && 'records' in structured ? structured.records : undefined;
    }

    it('recovery (UC-E11, AC-MS-8): killed after the evidence of page 2, the restarted process continues from the checkpoint; pages 1-2 keep their rows and sha256, 6 source calls', async () => {
      const run = await runFetchRecovery({ resourceId: newResourceId(), args: FIVE_PAGES });

      expect(run.firstExitCode).toBe(CRASH_EXIT_CODE);
      // The dead attempt stored pages 1-2; its checkpoint still points at page 2.
      expect(run.atKill.task).toMatchObject({ status: 'running', attempt: 1, checkpointNextPage: 2 });
      expect(run.atKill.pages.map((page) => [page.evidenceKey, page.writtenByAttempt])).toEqual([
        ['page-0001', 1],
        ['page-0002', 1],
      ]);
      // The recovered attempt ends the task with five pages, one row each; its 4 calls (pages 2-5) are the task's,
      // since a lost attempt carries no counters over (design-runtime.md, reservation rule).
      expect(run.end.task).toMatchObject({ status: 'succeeded', attempt: 2, recoveryCount: 1, toolCallsUsed: 4 });
      expect(run.end.pages.map((page) => page.evidenceKey)).toEqual(PAGE_KEYS);
      expect(run.end.task.outputRefs).toEqual(run.end.pages.map((page) => page.evidenceId));
      // Page 2 fetched again gives the same key and sha256: the rows captured before the kill are the ones kept.
      expect(run.end.pages.slice(0, 2)).toEqual(run.atKill.pages);
      expect(run.end.pages.slice(2).map((page) => page.writtenByAttempt)).toEqual([2, 2, 2]);
      // The independent counter: pages 1-2 by the dead process, pages 2-5 by the restarted one - 6 calls, not 7.
      expect(run.callLog).toHaveLength(6);
      expect(new Set(run.callLog.map((line) => line.pid)).size).toBe(2);
      expect(run.restartExitCode).toBe(0);
    }, 180_000);

    it('cancel during a hanging call (UC-E9, AC-20.2): the task ends cancelled, and the fixture log does not grow after cancel returns', async () => {
      const hang: FixtureFaultRule = { tool: SEARCH_LOGS, argsHash: '*', occurrences: 'all', mode: 'hang' };
      await withHarness([hang], async (harness, files) => {
        const request: FetchRequest = { resourceId: newResourceId(), args: FIVE_PAGES, completeness: 'all' };
        const proposed = await proposeFetch(harness, request);
        // The task is running and waits for the source: its first call reached the fixture.
        await until('first source call', async () => (files.readCallLog().length > 0 ? true : undefined));

        await harness.runtime.investigations.cancel(proposed.investigationId, request.resourceId);
        const linesAtCancel = files.readCallLog().length;

        const task = await taskEnd(harness, request, proposed);
        expect(task.status).toBe('cancelled');
        expect(task.outputRefs).toEqual([]);
        await delay(BOUNDED_WAIT_MS);
        expect(linesAtCancel).toBe(1);
        expect(files.readCallLog()).toHaveLength(linesAtCancel);
      });
    }, 120_000);

    it('oversize (UC-4, AC-12.4): a 10 MB page travels without the text duplicate, is stored, and reads back unchanged', async () => {
      const oversize: FixtureFaultRule = { tool: SEARCH_LOGS, argsHash: '*', occurrences: [1], mode: 'oversize', bytes: TEN_MB };
      const sent = await rawSearch(oversize, FIVE_PAGES);
      // Above 1 MiB the fixture leaves `content` empty, so the line stays within half of the 32 MiB stdio buffer.
      expect(sent.content).toEqual([]);

      await withHarness([oversize], async (harness, files) => {
        const request: FetchRequest = { resourceId: newResourceId(), args: FIVE_PAGES, completeness: 'sample' };
        const proposed = await proposeFetch(harness, request);

        const task = await taskEnd(harness, request, proposed);

        expect(task.status).toBe('succeeded');
        // One call: the transport stayed open, so nothing was retried.
        expect(files.readCallLog()).toHaveLength(1);
        expect(task.outputRefs).toHaveLength(1);
        const stored = await harness.runtime.evidence.get(task.outputRefs[0], request.resourceId);
        expect(stored.record.evidenceKey).toBe('page-0001');
        expect(stored.bytes.byteLength).toBe(stored.record.byteSize);
        expect(stored.bytes.byteLength).toBeGreaterThan(TEN_MB);
        expect(createHash('sha256').update(stored.bytes).digest('hex')).toBe(stored.record.sha256);
        const page = JSON.parse(new TextDecoder().decode(stored.bytes)) as { pageNumber: number; items: unknown };
        expect(page.pageNumber).toBe(1);
        expect(page.items).toEqual(recordsOf(sent));
      });
    }, 120_000);
  });
});
