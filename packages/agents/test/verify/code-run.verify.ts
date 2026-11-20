// code-execution / code-execution — on-demand timing checks, not part of any suite (testing-principles: timing-sensitive checks live in a separate
// script). Run: `pnpm --filter @agent-os/agents test:verify` (builds the fixture, the code runner and the package first).
// Design Doc: docs/features/code-execution/design-code-execution.md, Non-Functional Use Cases UC-N1 (NFR-01), UC-N2 (NFR-02).
// Spike baseline (Windows, Node 26.13.1): 21 000 records / 6.38 MB in 205–228 ms; empty script p95 73 ms
// (docs/features/code-execution/code-execution/20261114-feature-code-execution/analysis/spike-node-permissions.md).
//
// UC-N1 runs the whole path of the assembled feature: the agents harness (real Postgres, runtime, agents and executor process), the MCP
// fixture process over HTTP with the run's `logs` server in the registry, the scripted model asking for one `run_code`. UC-N2 measures the executor alone through `createCodeRunner`.

import { parseAgentsConfig } from '@agent-os/agents';
import { createScriptedModel } from '@agent-os/agents/testing';
import { createCodeRunner } from '@agent-os/code-runner';
import { consoleSink, createLogger } from '@agent-os/common';
import { createFixtureFiles, fixtureCallsOf } from '@agent-os/mcp-fixture';
import { describe, expect, it } from 'vitest';
import {
  createAgentsHarness,
  historyOf,
  runLogsOf,
  testRecord,
  waitForTaskStatus,
} from '../support/agentsHarness.js';
import { LOGS_SERVER } from '../support/mcp-servers.js';
import { newUser } from '../support/new-user.js';

/** NFR-01: a run over 5 MB of data ends within 30 s. */
const LARGE_RUN_TARGET_MS = 30_000;
/** NFR-02: the empty script's result arrives within 2 s, p95. */
const EMPTY_RUN_TARGET_MS = 2_000;
/** Empty scripts in a row of UC-N2. */
const EMPTY_RUNS = 50;
const MEASUREMENT_MS = 300_000;

/**
 * The first 8 h 24 min of the fixture's week (v1): the dense segment holds 2 500 records an hour, so the window is exactly
 * 2 625 blocks of 8 — 21 000 records, 42 pages of 500, about 5.0 MB of page JSON.
 */
const WINDOW = { from: '2026-09-14T00:00:00.000Z', to: '2026-09-14T08:24:00.000Z' } as const;
/**
 * What the script must return for {@link WINDOW}, counted independently of the feature from the fixture's own dataset
 * generator (`createLogDataset('v1')` and `matchingRecords` of `packages/mcp-fixture`).
 */
const EXPECTED = {
  pages: 42,
  records: 21_000,
  errorsByService: { 'checkout-web': 18, ledger: 23, 'payment-api': 18 },
} as const;
/** The page JSON the script received must be about 5 MB (NFR-01). */
const MIN_DATA_BYTES = 5_000_000;

const logger = createLogger({ sinks: [consoleSink()], secrets: [], minLevel: 'info' });

/** The nearest-rank 95th percentile. */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN;
}

const SEARCH_LOGS = `mcp__${LOGS_SERVER}__search_logs`;

/** The UC-N1 script: every page of {@link WINDOW} through `search_logs`, errors grouped by service. */
const GROUPING_SCRIPT = [
  `const query = ${JSON.stringify(WINDOW)};`,
  'const errors = {};',
  'let pages = 0;',
  'let records = 0;',
  'let bytes = 0;',
  'let cursor = null;',
  'do {',
  `  const page = await callTool("${SEARCH_LOGS}", cursor === null ? query : { ...query, cursor });`,
  '  pages += 1;',
  '  records += page.records.length;',
  '  bytes += JSON.stringify(page).length;',
  '  for (const record of page.records) {',
  '    if (record.status === "error") errors[record.service] = (errors[record.service] ?? 0) + 1;',
  '  }',
  '  cursor = page.nextCursor;',
  '} while (cursor !== null);',
  'const errorsByService = Object.fromEntries(Object.keys(errors).sort().map((service) => [service, errors[service]]));',
  'return { pages, records, bytes, errorsByService };',
].join('\n');

describe('UC-N1: a script over 21 000 log records (about 5 MB) ends within 30 s', () => {
  it(
    'pages through search_logs from code, groups the errors by service and returns the right totals in time',
    async () => {
      // Given: an agent of a fresh owner who may use `logs`, whose model asks for one read run of the grouping script
      const ownerId = newUser();
      const prompt = 'Group the errors of the payment logs by service';
      const model = createScriptedModel();
      const script = model.script({ task: prompt }, [
        { calls: [{ tool: 'run_code', args: { description: 'Ошибки по сервисам', class: 'read', script: GROUPING_SCRIPT } }] },
        { text: 'Ошибки сгруппированы' },
      ]);
      const fixture = createFixtureFiles('code-run-verify');
      const harness = await createAgentsHarness({
        model,
        fixture,
        access: { [ownerId]: [LOGS_SERVER] },
        root: testRecord('n1-reader', { servers: [LOGS_SERVER] }),
      });
      try {
        // When: the agent works to the end of its turn
        const startedAt = Date.now();
        const { agentId } = await harness.sessions.start({ ownerId, prompt, description: 'n1 reader' });
        await script.called(2);
        await waitForTaskStatus(harness, agentId, ownerId, 'waiting');
        const turnMs = Date.now() - startedAt;

        const runCallId = script.calls[0]?.toolCallIds[0];
        if (runCallId === undefined) throw new Error('the model made no run_code call');
        const ended = runLogsOf(harness, runCallId).find((record) => record.message === 'code run ended');
        const runMs = Number(ended?.fields.durationMs);
        const history = await historyOf(harness, agentId, ownerId);
        const runEntry = history.find((entry) => entry.kind === 'tool_result' && entry.content.callId === runCallId);
        const text = runEntry?.kind === 'tool_result' ? runEntry.content.text : null;
        const { bytes, ...totals } = JSON.parse(text ?? 'null') as { bytes: number } & Record<string, unknown>;
        logger.info('UC-N1: a run over the log window', {
          runMs,
          turnMs,
          records: totals.records,
          pages: totals.pages,
          dataBytes: bytes,
          targetMs: LARGE_RUN_TARGET_MS,
        });

        // Then: the run succeeded with the totals counted from the fixture's dataset, every page reached the server once,
        // and the run took no more than 30 s (NFR-01)
        expect([ended?.fields.outcome, ended?.fields.calls]).toEqual(['success', EXPECTED.pages]);
        expect(totals).toEqual(EXPECTED);
        expect(bytes).toBeGreaterThanOrEqual(MIN_DATA_BYTES);
        expect(fixtureCallsOf(fixture.callLog, { tool: 'search_logs' })).toHaveLength(EXPECTED.pages);
        expect(runMs).toBeLessThanOrEqual(LARGE_RUN_TARGET_MS);
      } finally {
        await harness.close();
      }
    },
    MEASUREMENT_MS,
  );
});

describe('UC-N2: the empty script returns within 2 s (p95)', () => {
  it(
    'runs 50 empty scripts in a row on the real executor and measures from run to result',
    async () => {
      // Given: the executor with its production flags and the run limits at their defaults (design Runtime settings)
      const defaults = parseAgentsConfig({});
      const runner = createCodeRunner({ maxConcurrent: defaults.codeRun.maxConcurrent, logger });
      const limits = {
        timeoutMs: defaults.codeRun.timeoutMs,
        memoryMb: defaults.codeRun.memoryMb,
        resultMaxBytes: defaults.toolResultMaxBytes,
      };

      // When: 50 empty scripts run one after another
      const durations: number[] = [];
      for (let run = 1; run <= EMPTY_RUNS; run += 1) {
        const startedAt = performance.now();
        const outcome = await runner.run({
          script: '',
          limits,
          onRequest: () => Promise.reject(new Error('the empty script makes no request')),
          logger: logger.child({ run }),
        });
        durations.push(performance.now() - startedAt);
        expect(outcome).toEqual({ status: 'returned', value: null, output: '' });
      }
      const sorted = [...durations].sort((a, b) => a - b);
      logger.info('UC-N2: empty script from run to result', {
        runs: EMPTY_RUNS,
        minMs: Math.round(sorted[0] ?? Number.NaN),
        p50Ms: Math.round(sorted[Math.ceil(sorted.length / 2) - 1] ?? Number.NaN),
        p95Ms: Math.round(p95(durations)),
        maxMs: Math.round(sorted.at(-1) ?? Number.NaN),
        targetMs: EMPTY_RUN_TARGET_MS,
      });

      // Then: p95 is within 2 s (NFR-02)
      expect(p95(durations)).toBeLessThanOrEqual(EMPTY_RUN_TARGET_MS);
    },
    MEASUREMENT_MS,
  );
});
