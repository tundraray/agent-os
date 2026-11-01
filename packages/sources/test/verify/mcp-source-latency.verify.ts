// research-runtime / mcp-source — on-demand timing checks, not part of any suite (testing-principles: timing-sensitive
// checks live in a separate script). Run: `pnpm --filter @agent-os/sources test:verify` with Postgres up.
// Design Doc: docs/features/research-runtime/design-mcp-source.md, Non-Functional Use Cases UC-N1, UC-N2.
// PRD targets (Performance): ToolExecutor overhead per call, source time excluded — p95 <= 100 ms (NFR-02);
// fixture response to a search page — p95 <= 500 ms over 100 requests (NFR-03).
// p95 is nearest-rank: sorted[ceil(0.95n) - 1], after a warm-up that is not measured.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Task, TaskSpec } from '@agent-os/contracts';
import { fixtureServerPath } from '@agent-os/mcp-fixture';
import type { TaskHandler } from '@agent-os/runtime';
import { FIXTURE_SOURCE_ID, McpSourceClient, parseSourcesSettings, type SourceAdapter } from '@agent-os/sources';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSourcesHarness, SEARCH_LOGS, SOURCE_FETCH, type SourcesHarness, TEST_SOURCES_ENV } from '../support/runtimeHarness.js';

const EXECUTOR_OVERHEAD_TARGET_MS = 100;
const PAGE_RESPONSE_TARGET_MS = 500;
const MEASURED = 100;
const WARM_UP = 10;
const PAGE_SIZE = 500;
const MEASUREMENT_MS = 600_000;
const SETUP_MS = 120_000;
const TASK_END_MS = 60_000;
const POLL_MS = 10;
const CALL_TIMEOUT_MS = 30_000;
/** A test workflow type that runs the registered `source.fetch` handler and times it. */
const TIMED_FETCH = 'verify.timed-fetch';
const WINDOW_START_MS = Date.parse('2026-09-14T00:00:00.000Z');
const WINDOW_STEP_MS = 10 * 60_000;
const WINDOW_MS = 60 * 60_000;

/** The nearest-rank 95th percentile. */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summary(values: readonly number[]): string {
  return `p95=${p95(values).toFixed(1)} ms, median=${median(values).toFixed(1)} ms, max=${Math.max(...values).toFixed(1)} ms`;
}

/**
 * Request `index`: an hour of every service of `v1`, a window of its own (so no request is a duplicate of another),
 * well over 500 records — the first page is full.
 */
function searchArgs(index: number): { from: string; to: string; pageSize: number } {
  const from = WINDOW_START_MS + index * WINDOW_STEP_MS;
  return { from: new Date(from).toISOString(), to: new Date(from + WINDOW_MS).toISOString(), pageSize: PAGE_SIZE };
}

describe('UC-N1: ToolExecutor overhead per call against a real runtime and Postgres, fixture delay 0', () => {
  /** One `source.fetch` run and the source calls made inside it. */
  interface RunTiming {
    runMs: number;
    callMs: number[];
  }

  let harness: SourcesHarness | undefined;
  let current: RunTiming | null = null;
  const timings: RunTiming[] = [];

  function assembled(): SourcesHarness {
    if (harness === undefined) throw new Error('The runtime is not assembled');
    return harness;
  }

  function fetchHandler(): TaskHandler {
    const handler = assembled().runtime.handlers.get(SOURCE_FETCH, 1);
    if (handler === undefined) throw new Error(`${SOURCE_FETCH} is not registered`);
    return handler;
  }

  /**
   * Runs the registered `source.fetch` handler — `FetchInput` parse, then `ToolExecutor.execute` — and times the run.
   * The executor checks the allowlist of `source.fetch` whatever the task's type, so the run is the production one.
   */
  const timedFetch: TaskHandler = {
    workflowType: TIMED_FETCH,
    workflowVersion: 1,
    get inputSchema() {
      return fetchHandler().inputSchema;
    },
    async run(ctx) {
      const timing: RunTiming = { runMs: 0, callMs: [] };
      current = timing;
      const startedAt = performance.now();
      try {
        return await fetchHandler().run(ctx);
      } finally {
        timing.runMs = performance.now() - startedAt;
        current = null;
        timings.push(timing);
      }
    },
  };

  /** Times every `call` of the fixture adapter, which is what the executor waits on the source for. */
  function timeSourceCalls(adapter: SourceAdapter): void {
    const call = adapter.call.bind(adapter);
    adapter.call = async (sourceCall) => {
      const startedAt = performance.now();
      try {
        return await call(sourceCall);
      } finally {
        current?.callMs.push(performance.now() - startedAt);
      }
    };
  }

  beforeAll(() => {
    harness = createSourcesHarness({
      sources: parseSourcesSettings({ ...TEST_SOURCES_ENV, SOURCE_CALL_TIMEOUT_MS: String(CALL_TIMEOUT_MS) }),
      handlers: [timedFetch],
    });
    const resolved = harness.sources.registry.resolveTool({
      workflowType: SOURCE_FETCH,
      sourceId: FIXTURE_SOURCE_ID,
      toolName: SEARCH_LOGS,
    });
    if (resolved === null) throw new Error(`${SEARCH_LOGS} is not allowlisted for ${SOURCE_FETCH}`);
    timeSourceCalls(resolved.adapter);
  }, SETUP_MS);

  afterAll(async () => {
    await harness?.close();
  }, SETUP_MS);

  async function taskEnd(resourceId: string, threadId: string, taskId: string): Promise<Task> {
    const startedAt = Date.now();
    for (;;) {
      const [investigation] = await assembled().runtime.investigations.listForThread(resourceId, threadId);
      const task = investigation?.tasks?.find((known) => known.taskId === taskId);
      if (task !== undefined && ['succeeded', 'failed', 'cancelled'].includes(task.status)) return task;
      if (Date.now() - startedAt > TASK_END_MS) throw new Error(`Task ${taskId} did not end within ${TASK_END_MS} ms`);
      await delay(POLL_MS);
    }
  }

  it(
    `p95 of run minus source call over ${MEASURED} one-page calls is within the PRD target (${EXECUTOR_OVERHEAD_TARGET_MS} ms)`,
    async () => {
      const { runtime, sources } = assembled();
      const resourceId = `verify-${randomUUID()}`;
      const threadId = assembled().createThread(resourceId);
      const total = WARM_UP + MEASURED;
      const { investigationId } = await runtime.investigations.create({
        resourceId,
        threadId,
        query: 'mcp-source UC-N1',
        budget: { maxTasks: total, maxToolCalls: 2 * total },
      });
      const snapshot = await sources.registry.currentSnapshot(FIXTURE_SOURCE_ID, AbortSignal.timeout(CALL_TIMEOUT_MS));

      // One task at a time, so each run is timed alone; `sample` stores exactly one page.
      for (let index = 0; index < total; index += 1) {
        const spec: TaskSpec = {
          investigationId,
          workflowType: TIMED_FETCH,
          workflowVersion: 1,
          input: { sourceId: FIXTURE_SOURCE_ID, toolName: SEARCH_LOGS, args: searchArgs(index) },
          inputRefs: [{ kind: 'source', ref: FIXTURE_SOURCE_ID, snapshot }],
          expectedOutput: { description: 'one page of fixture logs', completeness: 'sample' },
          dependsOn: [],
          budget: { maxToolCalls: 2, maxRetries: 0, deadlineMs: TASK_END_MS, maxTokens: 0 },
        };
        const proposed = await runtime.scheduler.propose(spec, 'verify-uc-n1');
        if (proposed.outcome !== 'created') throw new Error(`Task not created: ${JSON.stringify(proposed)}`);
        const task = await taskEnd(resourceId, threadId, proposed.taskId);
        expect(task.status).toBe('succeeded');
      }

      const measured = timings.slice(WARM_UP);
      expect(measured).toHaveLength(MEASURED);
      // Delay 0 and no faults: every run made exactly one source call, so the difference is the executor's alone.
      expect(measured.every((timing) => timing.callMs.length === 1)).toBe(true);
      const overheads = measured.map((timing) => timing.runMs - timing.callMs[0]);
      const value = p95(overheads);
      console.log(
        `UC-N1 ToolExecutor overhead, ${MEASURED} one-page calls of ${PAGE_SIZE} records: ${summary(overheads)}; ` +
          `run ${summary(measured.map((timing) => timing.runMs))}; source call ${summary(measured.map((timing) => timing.callMs[0]))}`,
      );
      expect(value).toBeLessThanOrEqual(EXECUTOR_OVERHEAD_TARGET_MS);
    },
    MEASUREMENT_MS,
  );
});

describe('UC-N2: fixture response to a search page, warmed v1 process', () => {
  const client = new McpSourceClient({
    serverPath: fixtureServerPath,
    fixtureEnv: { FIXTURE_DATASET: 'v1' },
    logger: { debug: () => undefined },
  });

  afterAll(async () => {
    await client.close();
  }, SETUP_MS);

  async function searchPage(index: number): Promise<number> {
    const startedAt = performance.now();
    const response = await client.callTool(
      { name: SEARCH_LOGS, arguments: searchArgs(index) },
      { timeoutMs: CALL_TIMEOUT_MS, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) },
    );
    const elapsedMs = performance.now() - startedAt;
    if (response.kind !== 'result' || response.result.isError === true) {
      throw new Error(`search_logs ${index} failed: ${JSON.stringify(response)}`);
    }
    const structured = response.result.structuredContent as { records?: unknown[] } | undefined;
    expect(structured?.records).toHaveLength(PAGE_SIZE);
    return elapsedMs;
  }

  it(
    `p95 over ${MEASURED} search_logs pages of ${PAGE_SIZE} records is within the PRD target (${PAGE_RESPONSE_TARGET_MS} ms)`,
    async () => {
      // The warm-up starts the process and warms its code paths; it is not measured.
      for (let index = 0; index < WARM_UP; index += 1) await searchPage(index);
      const latencies: number[] = [];
      for (let index = WARM_UP; index < WARM_UP + MEASURED; index += 1) latencies.push(await searchPage(index));

      const value = p95(latencies);
      console.log(`UC-N2 fixture search_logs page, ${MEASURED} requests of ${PAGE_SIZE} records: ${summary(latencies)}`);
      expect(value).toBeLessThanOrEqual(PAGE_RESPONSE_TARGET_MS);
    },
    MEASUREMENT_MS,
  );
});
