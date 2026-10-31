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
// Cases whose task has not landed are `it.todo` (E2E-1: T4.2). Do not convert a todo into a passing stub.
//
// Budget: E2E 2 of 2. Raw-formula ROI is low for both because the formula divides by an E2E cost of 38; they are kept because the Design Doc and PRD make them the
// acceptance gates (metrics 1, 3) and nothing at a lower level can prove Postgres-backed fencing, recovery and storage.

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Task } from '@agent-os/contracts';
import { fixtureServerPath } from '@agent-os/mcp-fixture';
import { McpSourceClient, parseSourcesSettings } from '@agent-os/sources';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { CRASH_EXIT_CODE, runFetchRecovery } from './support/fetchChild.js';
import {
  createSourcesHarness,
  type FetchArgs,
  type FetchRequest,
  type FixtureFaultRule,
  type FixtureFiles,
  fixtureFiles,
  proposeFetch,
  type ProposedFetch,
  SEARCH_LOGS,
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
  it.todo(
    'E2E-1: the seven-outcome acceptance scenario holds in 20 consecutive runs, with provenance on every evidence and exactly one source call for 10 identical requests',
  );

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
