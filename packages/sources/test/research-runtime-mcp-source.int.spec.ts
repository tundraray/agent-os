// research-runtime / mcp-source Integration Test Skeletons - Design Doc: docs/features/research-runtime/design-mcp-source.md
// Upstream contract consumed: docs/features/research-runtime/design-runtime.md (TaskContext, HandlerResult, Coverage, FailureReason, reservation rule)
// PRD: docs/features/research-runtime/prd.md
// Generated: 2026-10-31 | Part: mcp-source | Test type: integration, NO Postgres (runs in CI `check` via packages/sources/vitest.config.ts, include 'test/**/*.int.spec.ts')
//
// Environment (Design Doc "Test Boundaries"):
// - Real fixture process (packages/mcp-fixture, spawned over stdio by McpSourceClient). Never mocked: codes and drops are only provable on a real transport.
// - TaskContext is an in-memory fake that implements the runtime reservation rule (retry / call limits, deadline, injectable
//   `fenced` / `not_current_attempt` / `cancel_requested`). Postgres-only behaviour (guarded UPDATE, fencing, recovery) lives in
//   packages/sources/test/research-runtime-mcp-source.e2e-spec.ts.
// - Backoff jitter and clock are injected. SOURCE_CALL_TIMEOUT_MS leaves room for a process start on a loaded machine (fixtureHarness.ts,
//   PROCESS_START_TIMEOUT_MS); only rows that wait for the timeout shorten it, on a process started before the timed call.
// - Isolation (Design Doc Risks): every test builds its own fixture rules keyed by argsHash, with its own window/filter and its own
//   FIXTURE_CALL_LOG file in a temp dir. No shared journal, no test order dependency.
// - The independent counter is the fixture call log (JSONL, only `tools/call`). Assert `log lines === toolCallsUsed` wherever calls happen.
//
// Budget: integration 4 of 5 (limit 3; the 4th names a defect no other test catches - see INT-4). Pure rules are proven at unit level, see the
// "Proven at unit level" block at the end of this file; do not re-check their variants here.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandlerResultSchema, type EvidenceInput } from '@agent-os/contracts';
import { DATASET_VERSIONS, generateGroundTruth, type DatasetVersion } from '@agent-os/mcp-fixture';
import type { Clock } from '@agent-os/runtime';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AttemptStoppedError } from '../src/attempt-stopped.error.js';
import { FetchHandler } from '../src/fetch.handler.js';
import { FetchCheckpointSchema, type FetchCheckpoint } from '../src/fetch-input.js';
import { FIXTURE_SOURCE_ID, FixtureSourceAdapter } from '../src/fixture/fixture-source.adapter.js';
import {
  AggregateLogsResultSchema,
  GetTraceResultSchema,
  SearchLogsResultSchema,
  SourceInfoSchema,
} from '../src/fixture/fixture-tools.schema.js';
import type { McpRequestOptions, McpSourceClient } from '../src/mcp/mcp-source-client.js';
import { createSourceRegistry } from '../src/source-registry.js';
import type { SourcesEnv } from '../src/sources.settings.js';
import { ToolExecutor, type ToolOutcome, type ToolRequest } from '../src/tool-executor.js';
import {
  fixtureArgsHash,
  openFixtureClient,
  readGroundTruthFile,
  startFixture,
  type CallLogLine,
  type FixtureClient,
  type FixtureFaultRule,
  type FixtureHarness,
} from './support/fixtureHarness.js';
import { InMemoryTaskContext } from './support/inMemoryTaskContext.js';

const WORKFLOW_TYPE = 'source.fetch';
const SEARCH_LOGS = 'search_logs';
/** `get_trace` is a fixture tool, but `source.fetch` may not call it. */
const ALLOWLIST = { [WORKFLOW_TYPE]: [{ sourceId: FIXTURE_SOURCE_ID, toolName: SEARCH_LOGS }] };
const PAGE_SIZE = 5;
/** Metric 4: each failure class is injected 30 times. */
const METRIC_4_REPEAT = 30;
const BOUNDED_WAIT_MS = 300;

const harnesses: FixtureHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

function fixture(options: Parameters<typeof startFixture>[0]): FixtureHarness {
  const harness = startFixture(options);
  harnesses.push(harness);
  return harness;
}

/** The real clock with a fixed jitter: backoff is `random × min(cap, base × 2^n)`. */
function clockWithJitter(random: number): Clock {
  return {
    now: () => new Date(),
    random: () => random,
    setTimer: (ms, callback) => {
      const timer = setTimeout(callback, ms);
      return () => clearTimeout(timer);
    },
  };
}

function executorFor(harness: FixtureHarness, random = 0.5): ToolExecutor {
  return new ToolExecutor({
    registry: createSourceRegistry({ adapters: [harness.adapter], allowlist: ALLOWLIST }),
    settings: harness.settings,
    clock: clockWithJitter(random),
    logger: harness.logger,
  });
}

/**
 * A query of its own for each execution (`seed`): ten minutes of the v1 window, one page of five records.
 * Rules match `argsHash: '*'`, so every query counts its own occurrences in the call log.
 */
function searchArgs(seed: number): Record<string, unknown> {
  const from = new Date(Date.UTC(2026, 8, 14, 1, 0) + seed * 10 * 60_000);
  const to = new Date(from.getTime() + 10 * 60_000);
  return { from: from.toISOString(), to: to.toISOString(), pageSize: PAGE_SIZE };
}

/** Snapshot of the fixture's `v1` dataset (`fx-<version>-<8 hex of the generator parameters>`). */
const V1_SNAPSHOT = 'fx-v1-2157485c';

/** One page of a query pinned to `v1`, as INT-1 and INT-3 run it. */
function searchRequest(args: Record<string, unknown>): ToolRequest {
  return {
    workflowType: WORKFLOW_TYPE,
    sourceId: FIXTURE_SOURCE_ID,
    toolName: SEARCH_LOGS,
    args,
    pin: V1_SNAPSHOT,
    completeness: 'sample',
    resume: null,
  };
}

function linesOf(harness: FixtureHarness, args: Record<string, unknown>): CallLogLine[] {
  return harness.readCallLog().filter((line) => line.argsHash === fixtureArgsHash(args));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failureOf(outcome: ToolOutcome): { class: string; code: string } | null {
  return outcome.kind === 'failed' ? { class: outcome.failure.class, code: outcome.failure.code } : null;
}

/** Codes of the retry warnings of one task, in order. */
function retryCodes(harness: FixtureHarness, ctx: InMemoryTaskContext): unknown[] {
  return harness.logger.records
    .filter((record) => record.level === 'warn' && record.fields.taskId === ctx.taskId)
    .map((record) => record.fields.code);
}

describe('research-runtime / mcp-source - integration (fixture process, in-memory TaskContext)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Failure-class matrix against the real fixture
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original ACs, verbatim from prd.md / design-mcp-source.md):
  // AC-11.1: "Given инструмент не входит в allowlist типа workflow задачи, Then вызов отклонён без обращения к источнику, исход записан как отказ allowlist."
  // AC-11.2: "Given аргументы не проходят схему инструмента, Then вызов отклонён без обращения к источнику, исход записан как ошибка валидации."
  // AC-13.2: "Given источник вернул ошибку инструмента, Then задача `failed` с классом «ошибка инструмента» и текстом ошибки; автоматического повтора нет."
  // AC-13.3: "Given соединение с источником оборвано, Then исход записан классом «сбой транспорта/протокола» и обрабатывается по FR-14."
  // AC-13.4: "Given источник вернул ответ, который не разбирается или нарушает контракт инструмента, Then этот вызов записан классом «сбой транспорта/протокола»
  //          и никогда не записан как пустой результат: evidence «не найдено в области» по нему не создаётся."
  // AC-14.1: "Given источник даёт 2 временных сбоя транспорта подряд, а затем ответ, лимит повторов задачи 3 и лимит вызовов 5, Then задача `succeeded` после 3 вызовов."
  // AC-14.2: "Given источник даёт временный сбой транспорта на каждый вызов, лимит повторов 2 и лимит вызовов 5, Then задача `failed` с классом «сбой транспорта/протокола», источник вызван ровно 3 раза."
  // AC-14.3: "Given источник даёт временный сбой транспорта на каждый вызов, лимит повторов 5 и лимит вызовов 2, Then задача `failed` с классом «сбой транспорта/протокола», источник вызван ровно 2 раза."
  // AC-14.4: "Given источник отвечает ошибкой протокола JSON-RPC «неизвестный инструмент» или «некорректный запрос», лимит повторов 3 и лимит вызовов 5, Then источник вызван ровно 1 раз,
  //          задача `failed` с классом «сбой транспорта/протокола» и причиной «несоответствие конфигурации или протокола». Given источник отклоняет аргументы результатом
  //          инструмента с `isError` при тех же лимитах, Then источник вызван ровно 1 раз, задача `failed` с классом «ошибка инструмента» (AC-13.2)."
  // AC-15.4: "Given тестовый режим отказа (сбой транспорта, ошибка инструмента, ошибка инструмента при проверке аргументов, некорректный ответ, ошибка протокола
  //          «неизвестный инструмент» или «некорректный запрос», задержка), Then fixture воспроизводит выбранный отказ на заданных вызовах."
  // AC-MS-2: "If `structuredContent` отсутствует или нарушает контракт результата, then вызов записан `transport_protocol` с кодом `result_contract_violation`,
  //          повторяется по FR-14 и не даёт evidence «не найдено»."
  // AC-MS-5: "When соединение оборвалось, следующий вызов идёт по новому соединению; рукопожатие не входит ни в `toolCallsUsed`, ни в журнал вызовов fixture."
  // AC-MS-7: "While fixture перезапускается после `crash_process`, номер вхождения правила отказа продолжает считаться по журналу вызовов."
  // PRD metric 4: "100 % внедрённых отказов fixture записаны своим классом, 0 повторов вне бюджета, 0 повторов несоответствия конфигурации или протокола" (30 calls per class).
  // Use cases: UC-E1, UC-E3, UC-E4, UC-E5, UC-E6, UC-E7 (EARS: If-then - branch per failure class).
  //
  // Primary failure mode (turns red when): a local client error is classified as a server one (or the reverse), a K-3 / K-9 / K-13 outcome is retried,
  // a retry is issued without `reserveToolCall(retry: true)`, a malformed / contract-violating reply is stored as an empty "not found" result, or the
  // fixture call log disagrees with `toolCallsUsed` (e.g. the initialize handshake is counted).
  // ROI: 7.4 (raw formula: (9 x 8 + 0 + 9) / 11) | Business Value: 9 (a wrong class drives wrong retries and false "not found") | Frequency: 8 (every fetch)
  // Behavior: fault rule on (tool, argsHash, occurrence) -> ToolExecutor.execute against the real fixture -> ToolOutcome class/code, retries, and the call-log count match the table
  // @category: core-functionality
  // @dependency: ToolExecutor, FixtureSourceAdapter, McpSourceClient, mcp-fixture process, in-memory TaskContext, FIXTURE_FAULTS, FIXTURE_CALL_LOG
  // @complexity: high
  //
  // Table-driven rows (one row = one fault rule; fixed limits in brackets are retries / calls):
  //   pre-call, no fault rule      | get_trace not in source.fetch allowlist          | failed allowlist_rejected (tool_not_allowlisted) | log 0, toolCallsUsed 0   (UC-E1)
  //   pre-call, no fault rule      | search_logs pageSize 0                           | failed validation_rejected (tool_args_invalid)   | log 0, toolCallsUsed 0   (UC-E1)
  //   tool_error                   | [3/5] occurrence 1                               | failed tool_error, message = server text         | log 1                    (UC-E3, AC-13.2)
  //   tool_error_args              | [3/5] occurrence 1                               | failed tool_error                                | log 1                    (UC-E3, AC-14.4 second half)
  //   jsonrpc_error -32601         | [3/5] occurrence 1                               | failed transport_protocol config_or_protocol_mismatch | log 1               (UC-E5, AC-14.4)
  //   jsonrpc_error -32602         | [3/5] occurrence 1                               | same as above                                    | log 1                    (UC-E5)
  //   jsonrpc_error -32600         | [3/5] occurrence 1                               | same as above                                    | log 1                    (UC-E5)
  //   crash_process                | [3/5] occurrences 1-2, then success              | succeeded after 3 calls (new pid on call 2 and 3) | log 3 == toolCallsUsed 3 (UC-E4, AC-14.1, AC-MS-5, AC-MS-7)
  //   crash_process                | [2/5] occurrences all                            | failed transport_protocol connection_lost        | log 3 == toolCallsUsed 3 (UC-E4, AC-14.2)
  //   crash_process                | [5/2] occurrences all                            | failed transport_protocol connection_lost        | log 2 == toolCallsUsed 2 (UC-E4, AC-14.3)
  //   malformed_json               | occurrence 1, then success                       | first call transport_protocol timeout, 2nd succeeds | no "not found" evidence (UC-E6, AC-MS-2/13.4)
  //   invalid_result               | occurrence 1, then success                       | first call transport_protocol invalid_result      | no "not found" evidence (UC-E6, AC-13.4)
  //   contract_violation           | occurrence 1, then success                       | first call transport_protocol result_contract_violation | no "not found" evidence (UC-E6, AC-MS-2)
  //   rest of the mode catalogue   | drop_connection, jsonrpc_error -32603, late_response, delay_ms vs timeout, empty (K-12) | each lands in its class from the Error Handling table
  //                                  | 0 retries outside a reservation, 0 retries of K-3 / K-9 / K-13                                   (UC-E7, AC-15.4)
  // Metric 4 acceptance run: each class repeated 30 times (a `repeat` column or loop around the row); the short-timeout setting of the timeout rows keeps this fast.
  //
  // Verification items:
  // - Row outcome: kind, FailureReason.class, FailureReason.code, message truncated to the FailureReason limit
  // - Retries only after reserveToolCall(retry: true) (the in-memory TaskContext records every reservation)
  // - Fixture call log line count equals toolCallsUsed; handshake never appears in the log
  // - On crash rows: the `pid` column of the log changes between calls, `occurrence` keeps counting 1, 2, 3 across the restart
  // - No evidence with 0 matches exists for any malformed / invalid / contract-violation row
  describe('INT-1: every injected fault lands in its class, retries stay inside the reservation rule, and the fixture log equals toolCallsUsed', () => {
    it.each([
      {
        name: 'get_trace is not in the source.fetch allowlist (UC-E1, AC-11.1)',
        toolName: 'get_trace',
        args: { traceId: '0123456789abcdef0123456789abcdef' },
        expected: { class: 'allowlist_rejected', code: 'tool_not_allowlisted' },
      },
      {
        name: 'search_logs with pageSize 0 breaks argsSchema (UC-E1, AC-11.2)',
        toolName: SEARCH_LOGS,
        args: { ...searchArgs(0), pageSize: 0 },
        expected: { class: 'validation_rejected', code: 'tool_args_invalid' },
      },
    ])('pre-call: $name - no reservation, no source call', async ({ toolName, args, expected }) => {
      const harness = fixture({});
      const ctx = new InMemoryTaskContext({ maxRetries: 3, maxToolCalls: 5 });

      const outcome = await executorFor(harness).execute(ctx, { ...searchRequest(args), toolName });

      expect(failureOf(outcome)).toEqual(expected);
      expect(ctx.reservations).toEqual([]);
      expect(harness.readCallLog()).toEqual([]);
    });

    interface FaultRow {
      readonly name: string;
      readonly rule: Pick<FixtureFaultRule, 'occurrences' | 'mode'> & Readonly<Record<string, unknown>>;
      readonly limits: { readonly maxRetries: number; readonly maxToolCalls: number };
      /** Executions, each with its own query; 30 is the metric 4 run of the row's class. */
      readonly repeat: number;
      /** `SOURCE_CALL_TIMEOUT_MS` of a row that waits for the call timeout; the process is started before the row. */
      readonly env?: SourcesEnv;
      /** Crash rows run one execution at a time: a crash drops every call in flight on the shared process. */
      readonly sequential?: boolean;
      readonly expected: {
        readonly failure: { readonly class: string; readonly code: string } | null;
        readonly message?: string;
        /** Source calls: fixture log lines of the query, granted reservations and `toolCallsUsed`. */
        readonly calls: number;
        /** Codes of the failures that were retried, in order. */
        readonly retried: readonly string[];
        /** `returned` of the stored page; absent when no evidence may exist. */
        readonly returned?: number;
        /** K-3 / K-9 / K-13 are logged at `error`. */
        readonly errorLogged?: boolean;
      };
    }

    const CONFIG_MISMATCH = { class: 'transport_protocol', code: 'config_or_protocol_mismatch' };
    const CONNECTION_LOST = { class: 'transport_protocol', code: 'connection_lost' };
    const LIMITS_3_5 = { maxRetries: 3, maxToolCalls: 5 };
    /** A row waits for this call timeout on a started process; a process start never has to fit into it. */
    const SHORT_CALL_TIMEOUT = { SOURCE_CALL_TIMEOUT_MS: '1000' };
    const LATE_MS = 3_000;

    const rows: FaultRow[] = [
      {
        name: 'tool_error [3/5] (UC-E3, AC-13.2)',
        rule: { occurrences: [1], mode: 'tool_error', message: 'fixture says no' },
        limits: LIMITS_3_5,
        repeat: METRIC_4_REPEAT,
        expected: {
          failure: { class: 'tool_error', code: 'tool_error' },
          message: 'fixture says no',
          calls: 1,
          retried: [],
        },
      },
      {
        name: 'tool_error_args [3/5] (UC-E3, AC-14.4 second half)',
        rule: { occurrences: [1], mode: 'tool_error_args' },
        limits: LIMITS_3_5,
        repeat: 1,
        expected: { failure: { class: 'tool_error', code: 'tool_error' }, calls: 1, retried: [] },
      },
      {
        name: 'jsonrpc_error -32601 [3/5] (UC-E5, AC-14.4)',
        rule: { occurrences: [1], mode: 'jsonrpc_error', code: -32601 },
        limits: LIMITS_3_5,
        repeat: METRIC_4_REPEAT,
        expected: { failure: CONFIG_MISMATCH, calls: 1, retried: [], errorLogged: true },
      },
      {
        name: 'jsonrpc_error -32602 [3/5] (UC-E5)',
        rule: { occurrences: [1], mode: 'jsonrpc_error', code: -32602 },
        limits: LIMITS_3_5,
        repeat: 1,
        expected: { failure: CONFIG_MISMATCH, calls: 1, retried: [], errorLogged: true },
      },
      {
        name: 'jsonrpc_error -32600 [3/5] (UC-E5)',
        rule: { occurrences: [1], mode: 'jsonrpc_error', code: -32600 },
        limits: LIMITS_3_5,
        repeat: 1,
        expected: { failure: CONFIG_MISMATCH, calls: 1, retried: [], errorLogged: true },
      },
      {
        name: 'crash_process on occurrences 1-2, then success [3/5] (UC-E4, AC-14.1, AC-MS-5, AC-MS-7)',
        rule: { occurrences: [1, 2], mode: 'crash_process' },
        limits: LIMITS_3_5,
        repeat: METRIC_4_REPEAT,
        sequential: true,
        expected: { failure: null, calls: 3, retried: ['connection_lost', 'connection_lost'], returned: PAGE_SIZE },
      },
      {
        name: 'crash_process on every call [2/5] (UC-E4, AC-14.2)',
        rule: { occurrences: 'all', mode: 'crash_process' },
        limits: { maxRetries: 2, maxToolCalls: 5 },
        repeat: 1,
        sequential: true,
        expected: { failure: CONNECTION_LOST, calls: 3, retried: ['connection_lost', 'connection_lost'] },
      },
      {
        name: 'crash_process on every call [5/2] (UC-E4, AC-14.3)',
        rule: { occurrences: 'all', mode: 'crash_process' },
        limits: { maxRetries: 5, maxToolCalls: 2 },
        repeat: 1,
        sequential: true,
        expected: { failure: CONNECTION_LOST, calls: 2, retried: ['connection_lost'] },
      },
      {
        name: 'malformed_json, then success (UC-E6, AC-MS-2, AC-13.4)',
        rule: { occurrences: [1], mode: 'malformed_json' },
        env: SHORT_CALL_TIMEOUT,
        limits: LIMITS_3_5,
        repeat: METRIC_4_REPEAT,
        expected: { failure: null, calls: 2, retried: ['timeout'], returned: PAGE_SIZE },
      },
      {
        name: 'invalid_result, then success (UC-E6, AC-13.4)',
        rule: { occurrences: [1], mode: 'invalid_result' },
        limits: LIMITS_3_5,
        repeat: METRIC_4_REPEAT,
        expected: { failure: null, calls: 2, retried: ['invalid_result'], returned: PAGE_SIZE },
      },
      {
        name: 'contract_violation, then success (UC-E6, AC-MS-2)',
        rule: { occurrences: [1], mode: 'contract_violation' },
        limits: LIMITS_3_5,
        repeat: METRIC_4_REPEAT,
        expected: { failure: null, calls: 2, retried: ['result_contract_violation'], returned: PAGE_SIZE },
      },
      {
        name: 'contract_violation with no retry left [0/5]: failed, and no "not found" evidence (AC-MS-2)',
        rule: { occurrences: 'all', mode: 'contract_violation' },
        limits: { maxRetries: 0, maxToolCalls: 5 },
        repeat: 1,
        expected: { failure: { class: 'transport_protocol', code: 'result_contract_violation' }, calls: 1, retried: [] },
      },
      {
        name: 'drop_connection, then success (UC-E7, AC-15.4)',
        rule: { occurrences: [1], mode: 'drop_connection' },
        limits: LIMITS_3_5,
        repeat: 1,
        sequential: true,
        expected: { failure: null, calls: 2, retried: ['connection_lost'], returned: PAGE_SIZE },
      },
      {
        name: 'jsonrpc_error -32603, then success (UC-E7)',
        rule: { occurrences: [1], mode: 'jsonrpc_error', code: -32603 },
        limits: LIMITS_3_5,
        repeat: METRIC_4_REPEAT,
        expected: { failure: null, calls: 2, retried: ['server_internal_error'], returned: PAGE_SIZE },
      },
      {
        name: 'late_response after the call timeout, then success (UC-E7)',
        rule: { occurrences: [1], mode: 'late_response', ms: LATE_MS },
        env: SHORT_CALL_TIMEOUT,
        limits: LIMITS_3_5,
        repeat: 1,
        expected: { failure: null, calls: 2, retried: ['timeout'], returned: PAGE_SIZE },
      },
      {
        name: 'delay_ms below the call timeout (UC-E7)',
        rule: { occurrences: [1], mode: 'delay_ms', ms: 50 },
        env: SHORT_CALL_TIMEOUT,
        limits: LIMITS_3_5,
        repeat: 1,
        expected: { failure: null, calls: 1, retried: [], returned: PAGE_SIZE },
      },
      {
        name: 'delay_ms above the call timeout, then success (UC-E7)',
        rule: { occurrences: [1], mode: 'delay_ms', ms: LATE_MS },
        env: SHORT_CALL_TIMEOUT,
        limits: LIMITS_3_5,
        repeat: 1,
        expected: { failure: null, calls: 2, retried: ['timeout'], returned: PAGE_SIZE },
      },
      {
        name: 'empty page: K-12, stored with 0 matches (UC-E7)',
        rule: { occurrences: [1], mode: 'empty' },
        limits: LIMITS_3_5,
        repeat: METRIC_4_REPEAT,
        expected: { failure: null, calls: 1, retried: [], returned: 0 },
      },
    ];

    it.each(rows)(
      '$name',
      async ({ rule, env, limits, repeat, sequential, expected }) => {
        const harness = fixture({ rules: [{ tool: SEARCH_LOGS, argsHash: '*', ...rule }], env });
        if (env !== undefined) await harness.warmUp();
        const executor = executorFor(harness);
        const runOne = async (seed: number) => {
          const ctx = new InMemoryTaskContext(limits);
          const args = searchArgs(seed);
          const outcome = await executor.execute(ctx, searchRequest(args));
          return { ctx, args, outcome };
        };
        const seeds = Array.from({ length: repeat }, (_, seed) => seed);
        const runs: Awaited<ReturnType<typeof runOne>>[] = [];
        if (sequential === true) {
          for (const seed of seeds) runs.push(await runOne(seed));
        } else {
          runs.push(...(await Promise.all(seeds.map(runOne))));
        }

        for (const { ctx, args, outcome } of runs) {
          expect(failureOf(outcome)).toEqual(expected.failure);
          if (expected.message !== undefined) {
            expect(outcome.kind === 'failed' ? outcome.failure.message : null).toBe(expected.message);
          }
          // A retry only after reserveToolCall(retry: true); every granted reservation is one logged source call.
          expect(ctx.reservations.filter((record) => record.grant.granted).map((record) => record.retry)).toEqual(
            Array.from({ length: expected.calls }, (_, call) => call > 0),
          );
          expect(ctx.toolCalls).toBe(expected.calls);
          expect(linesOf(harness, args)).toHaveLength(expected.calls);
          expect(retryCodes(harness, ctx)).toEqual(expected.retried);
          // A malformed, invalid or contract-violating reply is never stored, not even as "not found".
          expect(ctx.evidence.map((record) => [record.input.evidenceKey, record.input.coverage.returned])).toEqual(
            expected.returned === undefined ? [] : [['page-0001', expected.returned]],
          );
          const errors = harness.logger.records.filter(
            (record) => record.level === 'error' && record.fields.taskId === ctx.taskId,
          );
          expect(errors.map((record) => record.fields.code)).toEqual(
            expected.errorLogged === true ? [expected.failure?.code] : [],
          );
        }
        // Logs carry identifiers and classes only: no arguments and no text of isError.
        const logged = JSON.stringify(harness.logger.records.filter((record) => record.level !== 'debug'));
        expect(logged).not.toContain(String(searchArgs(0).from));
        expect(logged).not.toContain('fixture says no');
      },
      // Not a timing check: the 30 sequential crash executions start 60 processes, ~14 s idle and ~100 s with the
      // cores oversubscribed twice (PROCESS_START_TIMEOUT_MS in fixtureHarness.ts).
      300_000,
    );

    it('crash_process: the next call goes to a new process, the handshake is not logged, and occurrences keep counting (AC-MS-5, AC-MS-7)', async () => {
      const harness = fixture({
        rules: [{ tool: SEARCH_LOGS, argsHash: '*', occurrences: [1, 2], mode: 'crash_process' }],
      });
      const ctx = new InMemoryTaskContext({ maxRetries: 3, maxToolCalls: 5 });
      const args = searchArgs(0);
      expect(harness.readCallLog()).toEqual([]);

      const outcome = await executorFor(harness).execute(ctx, searchRequest(args));

      expect(outcome.kind).toBe('completed');
      const lines = linesOf(harness, args);
      expect(lines.map((line) => [line.occurrence, line.mode])).toEqual([
        [1, 'crash_process'],
        [2, 'crash_process'],
        [3, null],
      ]);
      expect(new Set(lines.map((line) => line.pid)).size).toBe(3);
      expect(harness.readCallLog()).toHaveLength(ctx.toolCalls);
    }, 30_000);

    it('two calls in flight through one adapter share one restart after crash_process (Failure Mode: shared-state dependency)', async () => {
      const args = searchArgs(0);
      const harness = fixture({
        rules: [{ tool: SEARCH_LOGS, argsHash: fixtureArgsHash(args), occurrences: [1], mode: 'crash_process' }],
      });
      // Both calls go over one running process, so the crash drops both and both reconnect at once.
      await harness.adapter.currentSnapshot(new AbortController().signal);
      const executor = executorFor(harness);
      const contexts = [0, 1].map(() => new InMemoryTaskContext({ maxRetries: 3, maxToolCalls: 5 }));

      const outcomes = await Promise.all(contexts.map((ctx) => executor.execute(ctx, searchRequest(args))));

      expect(outcomes.map((outcome) => outcome.kind)).toEqual(['completed', 'completed']);
      const lines = harness.readCallLog();
      const crashAt = lines.findIndex((line) => line.mode === 'crash_process');
      const afterCrash = lines.slice(crashAt + 1);
      expect(afterCrash).toHaveLength(2);
      expect(new Set(afterCrash.map((line) => line.pid)).size).toBe(1);
      expect(afterCrash[0].pid).not.toBe(lines[crashAt].pid);
    }, 30_000);

    it('a process start that outlives the call timeout is K-6 timeout, retried, and the retry starts a new process (K-6, AC-MS-5)', async () => {
      const harness = fixture({});
      const ctx = new InMemoryTaskContext(LIMITS_3_5);
      const args = searchArgs(0);
      // The first call's timeout fits no process start (spawn and initialize), as on an overloaded machine; the retry's does.
      const settings = {
        ...harness.settings,
        get callTimeoutMs() {
          return ctx.toolCalls <= 1 ? 1 : harness.settings.callTimeoutMs;
        },
      };
      const executor = new ToolExecutor({
        registry: createSourceRegistry({ adapters: [harness.adapter], allowlist: ALLOWLIST }),
        settings,
        clock: clockWithJitter(0.5),
        logger: harness.logger,
      });

      const outcome = await executor.execute(ctx, searchRequest(args));

      expect(outcome.kind).toBe('completed');
      expect(ctx.reservations.map((record) => record.retry)).toEqual([false, true]);
      expect(retryCodes(harness, ctx)).toEqual(['timeout']);
      // The timed-out start never reached tools/call; the retry went to a process started afresh.
      expect(linesOf(harness, args)).toHaveLength(1);
    }, 30_000);

    it('a source process whose entry script does not exist is K-9, not retried, and logged at error (K-9)', async () => {
      const harness = fixture({});
      const missing = new FixtureSourceAdapter({
        serverPath: join(tmpdir(), 'agent-os-no-such-mcp-server.js'),
        settings: harness.settings,
        logger: harness.logger,
      });
      const executor = new ToolExecutor({
        registry: createSourceRegistry({ adapters: [missing], allowlist: ALLOWLIST }),
        settings: harness.settings,
        clock: clockWithJitter(0.5),
        logger: harness.logger,
      });
      const ctx = new InMemoryTaskContext(LIMITS_3_5);

      try {
        const outcome = await executor.execute(ctx, searchRequest(searchArgs(0)));

        expect(failureOf(outcome)).toEqual(CONFIG_MISMATCH);
        expect(ctx.reservations.map((record) => record.retry)).toEqual([false]);
        const errors = harness.logger.records.filter((record) => record.level === 'error');
        expect(errors.map((record) => record.fields.code)).toEqual(['config_or_protocol_mismatch']);
      } finally {
        await missing.close();
      }
    }, 30_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Pagination, coverage and stop conditions of a fetch task
  // ---------------------------------------------------------------------------------------------------------------
  // Covers:
  // AC-12.2: "Given совпадений больше, чем помещается в одну страницу, Then признак усечения выставлен, `returned` меньше `totalMatched`, а состояние пагинации позволяет получить следующую страницу."
  // AC-12.3: "Given источник не сообщает общее число совпадений, Then `totalMatched` помечен как неизвестный, а не записан нулём."
  // AC-13.1: "Given источник вернул пустой результат, Then задача `succeeded`, evidence `observed` с нулём совпадений и областью поиска; это «не найдено в области», а не ошибка."
  // AC-17.1: "Given 2 500 совпадений при странице 500 и достаточном бюджете, Then задача получила 5 страниц, усечения нет."
  // AC-17.2: "Given бюджет позволяет 3 страницы, Then задача `succeeded` с признаком неполного охвата и состоянием пагинации для продолжения."
  // AC-MS-4: "If срез страницы отличается от закреплённого, then задача `failed` `snapshot_changed`, страница не сохранена, прежние страницы в `outputRefs` не входят."
  // AC-MS-6: "If `putEvidence` или резерв вернули `fenced`/`not_current_attempt`, then исполнитель больше не вызывает источник в этой попытке."
  // AC-MS-9: "When задача сохранила `SOURCE_MAX_PAGES` страниц, а курсор не исчерпан, then она `succeeded` с охватом `partial` и курсором следующей страницы в `continuation`, без следующего вызова."
  // Use cases: UC-2, UC-3, UC-E10, UC-E12 (EARS: When / If-then - the loop's exits).
  //
  // Primary failure mode (turns red when): the page loop stops or continues on the wrong condition - a complete status for an unconfirmed count, a lost or wrong
  // `continuation` cursor, a page of a different snapshot saved (or kept in outputRefs), an extra source call after `fenced` / `not_current_attempt` or after the page cap,
  // an empty page treated as an error or `totalMatched` null recorded as 0.
  // ROI: 6.5 (raw formula: (8 x 8 + 0 + 8) / 11) | Business Value: 8 (coverage drives "is the answer complete" downstream) | Frequency: 8 (every "all" fetch)
  // Behavior: fetch task with a fixture query over 2 500 matches (page 500) -> FetchHandler/ToolExecutor loop -> per-page evidence page-NNNN, checkpoint, coverage and call count match the table
  // @category: core-functionality
  // @dependency: FetchHandler, ToolExecutor, FixtureSourceAdapter, mcp-fixture process, in-memory TaskContext (reservation limits, injectable fenced / not_current_attempt)
  // @complexity: high
  //
  // Table-driven rows (2 500-match window, pageSize 500 unless stated):
  //   "sample"                         | 1 page, truncated, continuation = cursor of page 2, coverage partial                   | 1 call   (UC-2)
  //   "all", call limit 10             | 5 pages page-0001..page-0005, no truncation, coverage complete, outputRefs in order      | 5 calls  (UC-2, AC-17.1)
  //   "all", call limit 3              | succeeded, partial, 3 pages, continuation = cursor of page 4                            | 3 calls  (UC-2, AC-17.2)
  //   "all", SOURCE_MAX_PAGES 2        | succeeded, partial, 2 pages, continuation = cursor of page 3, no third call             | 2 calls  (UC-2, AC-MS-9)
  //   filter with no matches           | succeeded, evidence observed with 0 matches and the search scope in normalizedArgs, complete | 1 call (UC-3, AC-13.1)
  //   unknown_total                    | succeeded, partial, totalMatched null (not 0)                                           | (UC-3, AC-12.3)
  //   snapshot_flip after occurrence 2 | failed snapshot_changed; 2 evidence stored, outputRefs empty, no 3rd page saved          | (UC-E10, AC-MS-4)
  //   fenced from putEvidence of page 1| stopped (AttemptStoppedError), 1 source call in the log                                 | (UC-E12, AC-MS-6)
  //   not_current_attempt from the reservation of page 2 | stopped, 1 source call in the log                              | (UC-E12, AC-MS-6)
  //
  // Verification items:
  // - Each row asserts: task outcome, coverage {status, truncated, continuation, returned, totalMatched}, evidence keys, outputRefs, call-log count
  // - Evidence provenance.snapshot equals the pinned snapshot on every stored page; `outputRefs` lists stored pages in order, and is empty for snapshot_changed
  // - The completeness rule (eq / gte / null / exhausted / source_ended_early) is NOT re-tested here - one unit table owns it (see unit list at the end)
  describe('INT-2: the page loop ends on the right condition with the right coverage, continuation and call count, and makes no call after a fence or a snapshot change', () => {
    const PAGE_500 = 500;

    /**
     * A window of exactly 2 500 `v1` records (counted from the generator): `hour` hours after 2026-09-14T00:00Z,
     * `seconds` long. Each case takes its own window.
     */
    function window2500(hour: number, seconds: number): Record<string, unknown> {
      const from = new Date(Date.UTC(2026, 8, 14, hour));
      const to = new Date(from.getTime() + seconds * 1_000);
      return { from: from.toISOString(), to: to.toISOString(), pageSize: PAGE_500 };
    }

    /** Offset of the next record a fixture cursor points at (base64url JSON; design-mcp-source.md, Пагинация и охват). */
    function cursorOffset(cursor: unknown): number | null {
      if (typeof cursor !== 'string') return null;
      return (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset: number }).offset;
    }

    function contentOf(input: EvidenceInput): { pageNumber: number; nextCursor: string | null } {
      return JSON.parse(new TextDecoder().decode(input.content.bytes)) as { pageNumber: number; nextCursor: string | null };
    }

    interface FetchContextOptions {
      readonly maxToolCalls: number;
      readonly completeness: 'all' | 'sample';
      readonly denyFrom?: { readonly reservation: number; readonly reason: 'not_current_attempt' };
      readonly fencedWrites?: boolean;
      readonly checkpoint?: FetchCheckpoint;
      /** False: the task has no input reference of the source. */
      readonly pinned?: false;
    }

    /** A `source.fetch` task pinned to `v1` through its input reference, as `deep-research` proposes it. */
    function fetchContext(args: Record<string, unknown>, options: FetchContextOptions): InMemoryTaskContext {
      return new InMemoryTaskContext({
        ...options,
        maxRetries: 3,
        // The JSON the runtime stores as `TaskSpec.input`.
        input: JSON.parse(JSON.stringify({ sourceId: FIXTURE_SOURCE_ID, toolName: SEARCH_LOGS, args })),
        inputRefs: options.pinned === false ? [] : [{ kind: 'source', ref: FIXTURE_SOURCE_ID, snapshot: V1_SNAPSHOT }],
      });
    }

    /** The handler's result, or the error it threw. */
    async function settle(promise: Promise<unknown>): Promise<{ result?: unknown; error?: unknown }> {
      return promise.then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    }

    type ExpectedOutcome =
      | {
          readonly kind: 'completed';
          readonly coverage: {
            readonly completeness: 'complete' | 'partial';
            readonly totalMatched: number | null;
            readonly totalRelation: 'eq' | 'gte' | null;
            readonly returned: number;
            readonly truncated: boolean;
          };
          /** Offset of the record the `continuation` cursor points at; null for no continuation. */
          readonly continuationOffset: number | null;
        }
      | { readonly kind: 'failed'; readonly failure: { readonly class: string; readonly code: string } }
      | { readonly kind: 'stopped'; readonly reason: string };

    interface PageLoopRow {
      readonly name: string;
      readonly args: Record<string, unknown>;
      readonly context: FetchContextOptions;
      readonly env?: Readonly<Record<string, string>>;
      readonly rules?: readonly FixtureFaultRule[];
      readonly expected: {
        readonly outcome: ExpectedOutcome;
        /** Stored evidence: `page-0001` … `page-<pages>`. */
        readonly pages: number;
        /** Source calls: fixture log lines of the query, granted reservations and `toolCallsUsed`. */
        readonly calls: number;
        /** Reservations asked for, granted or refused. */
        readonly reservations: number;
        /** `nextPage` of each saved checkpoint, in order. */
        readonly checkpoints: readonly number[];
      };
    }

    const all = (maxToolCalls: number): FetchContextOptions => ({ maxToolCalls, completeness: 'all' });
    const EXACT_2500 = { totalMatched: 2_500, totalRelation: 'eq' } as const;

    const rows: PageLoopRow[] = [
      {
        name: '"sample": one page, truncated, continuation = cursor of page 2 (UC-2, AC-12.2)',
        args: window2500(4, 3_595),
        context: { maxToolCalls: 10, completeness: 'sample' },
        expected: {
          outcome: {
            kind: 'completed',
            coverage: { completeness: 'partial', ...EXACT_2500, returned: 500, truncated: true },
            continuationOffset: 500,
          },
          pages: 1,
          calls: 1,
          reservations: 1,
          checkpoints: [],
        },
      },
      {
        name: '"all", call limit 10: five pages, complete, no truncation (UC-2, AC-17.1)',
        args: window2500(7, 3_601),
        context: all(10),
        expected: {
          outcome: {
            kind: 'completed',
            coverage: { completeness: 'complete', ...EXACT_2500, returned: 2_500, truncated: false },
            continuationOffset: null,
          },
          pages: 5,
          calls: 5,
          reservations: 5,
          checkpoints: [2, 3, 4, 5],
        },
      },
      {
        name: '"all", call limit 3: succeeded partial after three pages, continuation = cursor of page 4 (UC-2, AC-17.2)',
        args: window2500(8, 3_596),
        context: all(3),
        expected: {
          outcome: {
            kind: 'completed',
            coverage: { completeness: 'partial', ...EXACT_2500, returned: 1_500, truncated: true },
            continuationOffset: 1_500,
          },
          pages: 3,
          calls: 3,
          reservations: 4,
          checkpoints: [2, 3, 4],
        },
      },
      {
        name: '"all", SOURCE_MAX_PAGES 2: partial after two pages, no third reservation or call (UC-2, AC-MS-9)',
        args: window2500(9, 3_601),
        context: all(10),
        env: { SOURCE_MAX_PAGES: '2' },
        expected: {
          outcome: {
            kind: 'completed',
            coverage: { completeness: 'partial', ...EXACT_2500, returned: 1_000, truncated: true },
            continuationOffset: 1_000,
          },
          pages: 2,
          calls: 2,
          reservations: 2,
          checkpoints: [2, 3],
        },
      },
      {
        name: 'filter with no matches: succeeded, one evidence with 0 matches and the filter in normalizedArgs, complete (UC-3, AC-13.1)',
        args: { ...window2500(16, 3_595), event: 'no.such.event' },
        context: all(10),
        expected: {
          outcome: {
            kind: 'completed',
            coverage: { completeness: 'complete', totalMatched: 0, totalRelation: 'eq', returned: 0, truncated: false },
            continuationOffset: null,
          },
          pages: 1,
          calls: 1,
          reservations: 1,
          checkpoints: [],
        },
      },
      {
        name: 'unknown_total: succeeded partial, totalMatched null and not 0 (UC-3, AC-12.3)',
        args: window2500(18, 3_595),
        context: all(10),
        rules: [{ tool: SEARCH_LOGS, argsHash: '*', occurrences: 'all', mode: 'unknown_total' }],
        expected: {
          outcome: {
            kind: 'completed',
            coverage: { completeness: 'partial', totalMatched: null, totalRelation: null, returned: 2_500, truncated: false },
            continuationOffset: null,
          },
          pages: 5,
          calls: 5,
          reservations: 5,
          checkpoints: [2, 3, 4, 5],
        },
      },
      {
        name: 'snapshot_flip after occurrence 2: failed snapshot_changed, page 3 not stored, outputRefs empty (UC-E10, AC-MS-4)',
        args: window2500(19, 3_601),
        context: all(10),
        rules: [{ tool: SEARCH_LOGS, argsHash: '*', occurrences: [2], mode: 'snapshot_flip' }],
        expected: {
          outcome: { kind: 'failed', failure: { class: 'snapshot_changed', code: 'snapshot_changed' } },
          pages: 2,
          calls: 3,
          reservations: 3,
          checkpoints: [2, 3],
        },
      },
      {
        name: 'fenced from putEvidence of page 1: stopped (AttemptStoppedError), no further call (UC-E12, AC-MS-6)',
        args: window2500(21, 3_601),
        context: { ...all(10), fencedWrites: true },
        expected: { outcome: { kind: 'stopped', reason: 'fenced' }, pages: 0, calls: 1, reservations: 1, checkpoints: [] },
      },
      {
        name: 'not_current_attempt from the reservation of page 2: stopped, one source call (UC-E12, AC-MS-6)',
        args: window2500(30, 3_595),
        context: { ...all(10), denyFrom: { reservation: 2, reason: 'not_current_attempt' } },
        expected: {
          outcome: { kind: 'stopped', reason: 'not_current_attempt' },
          pages: 1,
          calls: 1,
          reservations: 2,
          checkpoints: [2],
        },
      },
      {
        name: 'no input reference of the source: failed snapshot_pin_missing before any reservation (Failure Mode: missing config)',
        args: window2500(35, 3_601),
        context: { ...all(10), pinned: false },
        expected: {
          outcome: { kind: 'failed', failure: { class: 'validation_rejected', code: 'snapshot_pin_missing' } },
          pages: 0,
          calls: 0,
          reservations: 0,
          checkpoints: [],
        },
      },
    ];

    it.each(rows)(
      '$name',
      async ({ args, context, env, rules, expected }) => {
        const harness = fixture({ rules, env });
        const ctx = fetchContext(args, context);

        const { result, error } = await settle(new FetchHandler(executorFor(harness)).run(ctx));

        const { outcome } = expected;
        const stored = ctx.evidence.map((record) => record.ref.evidenceId);
        if (outcome.kind === 'stopped') {
          expect(error).toBeInstanceOf(AttemptStoppedError);
          expect((error as AttemptStoppedError).reason).toBe(outcome.reason);
        } else {
          expect(error).toBeUndefined();
          const handlerResult = HandlerResultSchema.parse(result);
          expect(handlerResult.kind).toBe(outcome.kind);
          if (outcome.kind === 'completed') {
            expect({ ...handlerResult.coverage, continuation: undefined }).toEqual({ ...outcome.coverage, continuation: undefined });
            expect(cursorOffset(handlerResult.coverage?.continuation)).toBe(outcome.continuationOffset);
            // outputRefs: every stored page, in page order.
            expect(handlerResult.evidenceRefs).toEqual(stored);
            for (const record of ctx.evidence) {
              expect(record.input.coverage.totalMatched).toBe(outcome.coverage.totalMatched);
            }
          } else {
            expect(handlerResult.failure).toMatchObject(outcome.failure);
            // Pages stored before the change stay unreferenced (rollback-only visibility).
            expect(handlerResult.evidenceRefs).toEqual([]);
          }
        }

        expect(ctx.evidence.map((record) => record.input.evidenceKey)).toEqual(
          Array.from({ length: expected.pages }, (_, index) => `page-000${index + 1}`),
        );
        // Every stored page is of the pinned snapshot; its normalizedArgs carry the query and the cursor it was read with.
        let cursor: string | null = null;
        for (const record of ctx.evidence) {
          expect(record.input.provenance.snapshot).toBe(V1_SNAPSHOT);
          expect(record.input.provenance.normalizedArgs).toEqual({ ...args, cursor });
          cursor = contentOf(record.input).nextCursor;
        }
        // The last stored page's nextCursor is the continuation of a partial result.
        if (outcome.kind === 'completed' && outcome.continuationOffset !== null) {
          expect(cursorOffset(cursor)).toBe(outcome.continuationOffset);
        }

        const checkpoints = ctx.checkpoints.map((checkpoint) => FetchCheckpointSchema.parse(checkpoint));
        expect(checkpoints.map((checkpoint) => checkpoint.nextPage)).toEqual(expected.checkpoints);
        for (const checkpoint of checkpoints) {
          expect(checkpoint.evidenceIds).toEqual(stored.slice(0, checkpoint.nextPage - 1));
          expect(cursorOffset(checkpoint.cursor)).toBe((checkpoint.nextPage - 1) * PAGE_500);
        }

        expect(ctx.reservations).toHaveLength(expected.reservations);
        expect(ctx.toolCalls).toBe(expected.calls);
        await delay(BOUNDED_WAIT_MS);
        expect(linesOf(harness, args)).toHaveLength(expected.calls);
      },
      30_000,
    );

    it('a new attempt continues from the checkpoint: stored pages are not fetched again and outputRefs keep page order (Flow 1, Failure Mode: no-op)', async () => {
      const harness = fixture({});
      const args = window2500(31, 3_601);
      const first = fetchContext(args, all(3));
      await new FetchHandler(executorFor(harness)).run(first);
      const checkpoint = FetchCheckpointSchema.parse(first.checkpoints.at(-1));
      expect(checkpoint.nextPage).toBe(4);

      const second = fetchContext(args, { ...all(10), checkpoint });
      const result = HandlerResultSchema.parse(await new FetchHandler(executorFor(harness)).run(second));

      expect(second.evidence.map((record) => record.input.evidenceKey)).toEqual(['page-0004', 'page-0005']);
      expect(second.evidence[0].input.provenance.normalizedArgs).toEqual({ ...args, cursor: checkpoint.cursor });
      expect(result.evidenceRefs).toEqual(
        [...first.evidence, ...second.evidence].map((record) => record.ref.evidenceId),
      );
      expect(result.coverage).toEqual({
        completeness: 'complete',
        ...EXACT_2500,
        returned: 2_500,
        truncated: false,
        continuation: null,
      });
      expect(second.toolCalls).toBe(2);
      expect(linesOf(harness, args)).toHaveLength(5);
    }, 30_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Deadline and cancellation take precedence over error classification
  // ---------------------------------------------------------------------------------------------------------------
  // Covers:
  // AC-19.3: "Given fetch-задача прервана по дедлайну, а лимиты повторов и вызовов не исчерпаны, Then повтора нет: источник больше не вызван, исход записан причиной «дедлайн»,
  //          а не классом «сбой транспорта/протокола»."
  // AC-MS-1: "If вызов завершился любой ошибкой, а `ctx.signal` уже прерван, then исход берётся из `signal.reason.kind` и не повторяется."
  // AC-MS-3: "If очередная задержка backoff не меньше остатка дедлайна, then задача `failed` с классом `deadline` без следующего вызова."
  // Use cases: UC-E8 (and the executor side of UC-E9) (EARS: If-then - signal true / false).
  //
  // Primary failure mode (turns red when): an aborted signal surfaces from the SDK as RequestTimeout / ConnectionClosed and is recorded as transport_protocol and retried,
  // or a retry delay that would outlive the deadline is slept and followed by another call.
  // ROI: 2.9 (raw formula: (8 x 3 + 0 + 8) / 11) | Business Value: 8 (a deadline mislabelled as a source failure misleads the investigation) | Frequency: 3 (only on deadline / cancel)
  // Behavior: `hang` call (or retryable fault with a backoff delay >= remaining deadline) -> signal aborts with reason deadline / cancelled -> ToolOutcome class from signal.reason.kind, no further source call
  // @category: edge-case
  // @dependency: ToolExecutor, McpSourceClient, mcp-fixture process (hang), in-memory TaskContext (signal, deadline), injected clock and jitter
  // @complexity: medium
  //
  // Rows:
  //   hang, abort reason deadline            | failed deadline (K-1, not transport_protocol); retries/calls remain; log 1 call    (UC-E8, AC-19.3, AC-MS-1)
  //   hang, call timeout cut to deadline rest| failed deadline_in_call (K-2)                                                      (UC-E8)
  //   retryable fault, backoff >= remaining  | failed deadline with NO next call; log shows only the first call                  (UC-E8, AC-MS-3)
  //   hang, abort reason cancelled           | cancelled outcome from signal.reason.kind; no retry; log does not grow after abort (AC-MS-1; Postgres cancel path is E2E-2)
  //
  // Verification items:
  // - FailureReason.class is `deadline` (never `transport_protocol`) for the three deadline rows
  // - Fixture call log count unchanged after the abort (wait a bounded interval, re-read the log)
  // - The late response of an aborted `hang` call is dropped (no evidence, no outcome change)
  describe('INT-3: a deadline or cancellation during a call is reported by signal.reason, not as a transport failure, and is never retried', () => {
    /** A long call timeout: only the signal or the deadline can end a `hang` call early. */
    const LONG_CALL_TIMEOUT = { SOURCE_CALL_TIMEOUT_MS: '30000' };
    const HANG = { tool: SEARCH_LOGS, argsHash: '*', occurrences: 'all', mode: 'hang' } as const;

    /** Starts the process before the timed part: an abort during the process start never reaches the fixture. */
    async function warmed(harness: FixtureHarness): Promise<FixtureHarness> {
      await harness.warmUp();
      return harness;
    }

    it.each([
      { name: 'deadline (UC-E8, AC-19.3, AC-MS-1)', kind: 'deadline', expected: { class: 'deadline', code: 'deadline_exceeded' } },
      { name: 'cancelled (AC-MS-1)', kind: 'cancelled', expected: { class: 'cancelled', code: 'cancel_requested' } },
    ] as const)('hang, abort reason $name: the outcome comes from signal.reason, no retry', async ({ kind, expected }) => {
      const harness = await warmed(fixture({ rules: [HANG], env: LONG_CALL_TIMEOUT }));
      const ctx = new InMemoryTaskContext({ maxRetries: 3, maxToolCalls: 5 });
      const args = searchArgs(0);

      const pending = executorFor(harness).execute(ctx, searchRequest(args));
      await delay(200);
      ctx.abort(kind);
      const outcome = await pending;

      expect(failureOf(outcome)).toEqual(expected);
      expect(ctx.reservations.map((record) => record.retry)).toEqual([false]);
      await delay(BOUNDED_WAIT_MS);
      expect(linesOf(harness, args)).toHaveLength(1);
    }, 15_000);

    it('hang with the call timeout cut to the rest of the deadline: failed deadline_in_call (K-2), no retry (UC-E8)', async () => {
      const harness = await warmed(fixture({ rules: [HANG], env: LONG_CALL_TIMEOUT }));
      const ctx = new InMemoryTaskContext({ maxRetries: 3, maxToolCalls: 5, deadlineInMs: 400 });
      const args = searchArgs(0);

      const outcome = await executorFor(harness).execute(ctx, searchRequest(args));

      expect(failureOf(outcome)).toEqual({ class: 'deadline', code: 'deadline_in_call' });
      expect(ctx.reservations.map((record) => record.retry)).toEqual([false]);
      expect(linesOf(harness, args)).toHaveLength(1);
    }, 15_000);

    it('retryable fault whose backoff is not shorter than the rest of the deadline: failed deadline with no next call (UC-E8, AC-MS-3)', async () => {
      const harness = await warmed(
        fixture({
          rules: [{ tool: SEARCH_LOGS, argsHash: '*', occurrences: 'all', mode: 'jsonrpc_error', code: -32603 }],
          env: { SOURCE_RETRY_BASE_MS: '10000', SOURCE_RETRY_CAP_MS: '10000' },
        }),
      );
      // Jitter 0.9 of 10 000 ms against a 5 000 ms deadline.
      const ctx = new InMemoryTaskContext({ maxRetries: 3, maxToolCalls: 5, deadlineInMs: 5_000 });
      const args = searchArgs(0);
      const startedAt = Date.now();

      const outcome = await executorFor(harness, 0.9).execute(ctx, searchRequest(args));

      expect(failureOf(outcome)).toEqual({ class: 'deadline', code: 'deadline_before_retry' });
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(ctx.reservations.map((record) => record.retry)).toEqual([false]);
      await delay(BOUNDED_WAIT_MS);
      expect(linesOf(harness, args)).toHaveLength(1);
    }, 15_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Fixture dataset: determinism, scenario signal, ground truth, versions
  // ---------------------------------------------------------------------------------------------------------------
  // Why a 4th integration test (limit 3, up to 5): nothing else detects a drifting generator. If the fixture is non-deterministic, loses the post-release timeout
  // rise, or its ground truth falls out of step with regenerated data, the PRD acceptance scenario (metric 1, 3) and every other test built on the fixture silently
  // test the wrong data. This is its only test.
  // Covers:
  // AC-15.1: "Given одна версия данных и один запрос, Then ответы двух вызовов совпадают байт в байт."
  // AC-15.2: "Given агрегат timeout платёжного сервиса до и после релиза, Then после релиза значение выше; Given записи затронутого `traceId`, Then время внешнего ответа позже локального timeout."
  // AC-15.3: "Given объём данных fixture, Then в ней не меньше 100 000 записей логов, и ни один инструмент не меняет данные."
  // AC-15.5: "Given fixture переключена на новую версию данных с дополнительными записями, Then срез данных в provenance меняется (основа для AC-06.4)."
  // AC-21.1: "Given сгенерированные данные, Then рядом лежит эталон с причиной и списком `traceId`, и каждый `traceId` из эталона находится инструментом получения по `traceId`."
  // PRD metric 5: "100 % совпадение ответов при одной версии данных (AC-15.1)", 100 requests.
  // Use cases: UC-5, UC-6 (EARS: Given/Then - basic functionality).
  //
  // Primary failure mode (turns red when): two processes of the same dataset version answer one query differently (even one byte), the timeout aggregate does not rise after the release,
  // an affected trace's provider response is not later than the local timeout, ground-truth/<version>.json differs from regeneration or lists a traceId `get_trace` cannot find,
  // `recordCount` < 100 000, `v2` keeps the `v1` snapshot, or a tool mutates data.
  // ROI: 4.5 (raw formula: (7 x 6 + 0 + 7) / 11) | Business Value: 7 (foundation of every fixture-based acceptance run) | Frequency: 6 (every acceptance run)
  // Behavior: two fixture processes `v1` -> 100 identical queries each -> byte-equal; aggregates before/after release; affected traces; regeneration vs ground truth; then `v2` process -> snapshot and totalMatched differ
  // @category: core-functionality
  // @dependency: mcp-fixture (process x2), packages/mcp-fixture generator, ground-truth/<version>.json, McpSourceClient (read-only use)
  // @complexity: medium
  //
  // Rows / steps:
  //   determinism   | 2 processes v1, 100 identical search_logs requests each | `result` byte-equal pairwise                                    (UC-5, AC-15.1, metric 5)
  //   scenario      | aggregate_logs groupBy status=timeout, hourly, before vs after release | after-release count higher (both from the fixture)  (UC-5, AC-15.2)
  //   late response | get_trace for each affectedTraceIds entry                 | provider response later than the local timeout; trace found     (UC-5, AC-15.2, AC-21.1)
  //   ground truth  | regenerate ground truth for v1 and compare with the file  | equal; every traceId found; aggregate and trace fetches complete (UC-5, AC-21.1)
  //   size          | fixture://source-info                                    | recordCount >= 100 000                                          (UC-5, AC-15.3)
  //   versions      | process v1 then process v2; currentSnapshot + one query over the v2 window | snapshots differ; totalMatched(v2) > totalMatched(v1) (UC-6, AC-15.5)
  //
  // Verification items:
  // - Byte-equality compares the serialized `result`, not a parsed-and-reserialized copy
  // - The 100 000 floor is read from the fixture's own resource, not recomputed
  describe('INT-4: one dataset version answers byte-identically, the release shows the timeout signal, and ground truth matches regeneration', () => {
    const V1_WINDOW = { from: '2026-09-14T00:00:00.000Z', to: '2026-09-16T00:00:00.000Z' };
    /** The hour `v2` appends after the `v1` window: 2 000 records. */
    const V2_EXTRA_HOUR = { from: '2026-09-16T00:00:00.000Z', to: '2026-09-16T01:00:00.000Z' };
    const RELEASE_AT_MS = Date.parse('2026-09-15T00:00:00.000Z');
    /** Metric 5: 100 requests of one dataset version. */
    const DETERMINISM_REQUESTS = 100;
    /** AC-15.3 floor; the count itself is read from `fixture://source-info`. */
    const RECORD_COUNT_FLOOR = 100_000;
    const LOCAL_TIMEOUT_AFTER_RELEASE_MS = 1_500;
    const GROUND_TRUTH_WORKFLOW = 'test.ground_truth';
    /** A test allowlist: `source.fetch` may not call these tools, the ground-truth check does. */
    const GROUND_TRUTH_ALLOWLIST = {
      [GROUND_TRUTH_WORKFLOW]: [
        { sourceId: FIXTURE_SOURCE_ID, toolName: 'aggregate_logs' },
        { sourceId: FIXTURE_SOURCE_ID, toolName: 'get_trace' },
      ],
    };
    /** Whole-window aggregates and the first trace lookup (which indexes every trace) outlast the short call timeout. */
    const LONG_CALL_TIMEOUT_MS = 30_000;

    const clients: FixtureClient[] = [];
    afterEach(async () => {
      await Promise.all(clients.splice(0).map((client) => client.close()));
    });

    /** Another fixture process serving `dataset`, started on its first request. */
    function processOf(dataset: DatasetVersion): McpSourceClient {
      const opened = openFixtureClient(dataset);
      clients.push(opened);
      return opened.client;
    }

    function rawOptions(): McpRequestOptions {
      return { timeoutMs: LONG_CALL_TIMEOUT_MS, signal: new AbortController().signal };
    }

    async function callRaw(client: McpSourceClient, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
      const response = await client.callTool({ name, arguments: args }, rawOptions());
      if (response.kind !== 'result') {
        throw new Error(`${name} failed in transport: ${response.code}`);
      }
      return response.result;
    }

    /** The `result` exactly as the fixture serialized it: the JSON text block, not a re-serialized `structuredContent`. */
    function serialized(result: CallToolResult): string {
      const [block] = result.content;
      if (block?.type !== 'text') {
        throw new Error('the fixture returned no JSON text block');
      }
      return block.text;
    }

    async function sourceInfo(client: McpSourceClient): Promise<ReturnType<typeof SourceInfoSchema.parse>> {
      const resource = await client.readResource('fixture://source-info', rawOptions());
      const [content] = resource.contents;
      if (content === undefined || !('text' in content)) {
        throw new Error('fixture://source-info returned no text content');
      }
      return SourceInfoSchema.parse(JSON.parse(content.text));
    }

    /** Request `index` of the determinism run: its own 30 minutes of the `v1` window, every second one filtered. */
    function determinismArgs(index: number): Record<string, unknown> {
      const from = new Date(Date.parse(V1_WINDOW.from) + index * 28 * 60_000);
      const to = new Date(from.getTime() + 30 * 60_000);
      const filter = index % 2 === 0 ? {} : { service: 'provider-adapter' };
      return { from: from.toISOString(), to: to.toISOString(), pageSize: 50, ...filter };
    }

    /** A fetch through the executor that must complete; returns the items of its single stored page. */
    async function fetchComplete(harness: FixtureHarness, toolName: string, args: Record<string, unknown>): Promise<unknown> {
      const executor = new ToolExecutor({
        registry: createSourceRegistry({ adapters: [harness.adapter], allowlist: GROUND_TRUTH_ALLOWLIST }),
        settings: harness.settings,
        clock: clockWithJitter(0.5),
        logger: harness.logger,
      });
      const ctx = new InMemoryTaskContext({ maxRetries: 0, maxToolCalls: 1, completeness: 'all' });
      const outcome = await executor.execute(ctx, {
        workflowType: GROUND_TRUTH_WORKFLOW,
        sourceId: FIXTURE_SOURCE_ID,
        toolName,
        args,
        pin: V1_SNAPSHOT,
        completeness: 'all',
        resume: null,
      });
      const [page] = ctx.evidence;
      if (outcome.kind !== 'completed' || outcome.coverage.completeness !== 'complete' || page === undefined) {
        throw new Error(`${toolName} ${JSON.stringify(args)} did not complete: ${JSON.stringify(outcome)}`);
      }
      const content = JSON.parse(new TextDecoder().decode(page.input.content.bytes)) as { items: unknown };
      return content.items;
    }

    it('determinism: two v1 processes answer 100 identical search_logs requests byte-identically, and no call changes the data (UC-5, AC-15.1, AC-15.3, metric 5)', async () => {
      const first = processOf('v1');
      const second = processOf('v1');
      const firstArgs = determinismArgs(0);
      const before = serialized(await callRaw(first, SEARCH_LOGS, firstArgs));
      const mismatches: number[] = [];
      let recordsSeen = 0;

      for (let index = 0; index < DETERMINISM_REQUESTS; index += 1) {
        const args = determinismArgs(index);
        const [left, right] = await Promise.all([callRaw(first, SEARCH_LOGS, args), callRaw(second, SEARCH_LOGS, args)]);
        if (serialized(left) !== serialized(right)) {
          mismatches.push(index);
        }
        recordsSeen += SearchLogsResultSchema.parse(left.structuredContent).records.length;
      }

      expect(mismatches).toEqual([]);
      expect(recordsSeen).toBeGreaterThan(0);
      // Read-only data: the first request answers the same after the other 200 calls.
      expect(serialized(await callRaw(first, SEARCH_LOGS, firstArgs))).toBe(before);
    }, 60_000);

    it('size and versions: v1 holds at least 100 000 records under a fx-v1-<8 hex> snapshot; v2 adds the hour after the window and changes the snapshot (UC-6, AC-15.3, AC-15.5)', async () => {
      const v1 = processOf('v1');
      const v2 = processOf('v2');
      const extraHour = { ...V2_EXTRA_HOUR, pageSize: 1 };

      const [v1Info, v2Info] = await Promise.all([sourceInfo(v1), sourceInfo(v2)]);
      const [v1Extra, v2Extra] = await Promise.all([callRaw(v1, SEARCH_LOGS, extraHour), callRaw(v2, SEARCH_LOGS, extraHour)]);
      // The snapshot provenance records, read the way the executor pins it: through the adapter of a v2 source.
      const v2Snapshot = await fixture({ env: { FIXTURE_DATASET: 'v2' } }).adapter.currentSnapshot(new AbortController().signal);

      expect(v1Info.recordCount).toBeGreaterThanOrEqual(RECORD_COUNT_FLOOR);
      expect({ v1: v1Info.recordCount, v2: v2Info.recordCount }).toEqual({ v1: 120_000, v2: 122_000 });
      expect(v1Info.snapshot).toMatch(/^fx-v1-[0-9a-f]{8}$/);
      expect(v1Info.snapshot).toBe(V1_SNAPSHOT);
      expect(v2Info.snapshot).toMatch(/^fx-v2-[0-9a-f]{8}$/);
      expect(v2Snapshot).toBe(v2Info.snapshot);
      expect({
        v1: SearchLogsResultSchema.parse(v1Extra.structuredContent).totalMatched,
        v2: SearchLogsResultSchema.parse(v2Extra.structuredContent).totalMatched,
      }).toEqual({ v1: 0, v2: 2_000 });
    }, 30_000);

    it('scenario: provider timeouts rise after the release, counted from aggregate_logs fetched complete (UC-5, AC-15.2)', async () => {
      const harness = fixture({ env: { SOURCE_CALL_TIMEOUT_MS: String(LONG_CALL_TIMEOUT_MS) } });

      const items = await fetchComplete(harness, 'aggregate_logs', {
        ...V1_WINDOW,
        service: 'provider-adapter',
        status: 'timeout',
        groupBy: 'status',
        bucket: '1h',
      });

      const timeouts = { beforeRelease: 0, afterRelease: 0 };
      for (const bucket of AggregateLogsResultSchema.shape.buckets.parse(items)) {
        timeouts[Date.parse(bucket.start) < RELEASE_AT_MS ? 'beforeRelease' : 'afterRelease'] += bucket.count;
      }
      expect(timeouts.beforeRelease).toBeGreaterThan(0);
      expect(timeouts.afterRelease).toBeGreaterThan(timeouts.beforeRelease);
    }, 30_000);

    it('ground truth: ground-truth/<version>.json equals regeneration, and every affected trace is found complete with a provider response later than the local timeout (UC-5, AC-15.2, AC-21.1)', async () => {
      for (const version of DATASET_VERSIONS) {
        expect(readGroundTruthFile(version), `ground-truth/${version}.json`).toEqual(generateGroundTruth(version));
      }
      const groundTruth = generateGroundTruth('v1');
      expect(groundTruth.snapshot).toBe(V1_SNAPSHOT);
      expect(groundTruth.affectedTraceIds.length).toBeGreaterThan(0);
      const harness = fixture({ env: { SOURCE_CALL_TIMEOUT_MS: String(LONG_CALL_TIMEOUT_MS) } });
      const violations: string[] = [];

      for (const traceId of groundTruth.affectedTraceIds) {
        const records = GetTraceResultSchema.shape.records.parse(await fetchComplete(harness, 'get_trace', { traceId }));
        const timeout = records.find((record) => record.event === 'provider.timeout');
        const late = records.find((record) => record.event === 'provider.response' && record.status === 'late');
        const lateAfterTimeout =
          timeout !== undefined &&
          late !== undefined &&
          timeout.durationMs === LOCAL_TIMEOUT_AFTER_RELEASE_MS &&
          late.durationMs > timeout.durationMs &&
          Date.parse(late.ts) > Date.parse(timeout.ts);
        if (!lateAfterTimeout) {
          violations.push(traceId);
        }
      }

      expect(violations).toEqual([]);
    }, 120_000);
  });
});

// -----------------------------------------------------------------------------------------------------------------
// Proven at unit level (provenAt: unit). Named for the plan; NOT part of the integration budget; do not re-check their variants above.
// -----------------------------------------------------------------------------------------------------------------
// - sources.registry.spec.ts (SourceRegistry factory, table-driven): AC-11.3 / UC-E2 - allowlisted tool with readOnly: false, pair missing from the descriptor,
//   duplicate sourceId, FIXTURE_FAULTS set without FIXTURE_CALL_LOG -> each throws with sourceId and toolName; the fixture process is never spawned
//   (spawn spy at the process boundary). `readOnlyHint` from the server is not read.
// - tool-executor.spec.ts (ToolExecutor + non-MCP stub adapter + in-memory TaskContext): AC-16.1 / UC-7 - a stub adapter with its own descriptor, currentSnapshot and
//   allowlist row yields a succeeded fetch with the same provenance format, with no change to ToolExecutor or runtime. Needs no Postgres or process;
//   the Design Doc lists it under e2e-runtime, but nothing in it depends on the database (pushed down).
// - completeness.spec.ts (pagination-and-coverage rule, table): complete only when nextCursor null AND (totalRelation eq with sum(returned) == totalMatched OR exhausted);
//   gte / null totals never complete; eq with a shortfall -> partial + warning source_ended_early; page_cap and total_cap shapes. INT-2 proves only the wiring.
// - mcp-error-classifier.spec.ts (McpSourceClient classifier, table over synthetic SDK errors): K-3..K-9, K-13, K-14 including codes the fixture cannot emit
//   (SdkHttpError 5xx/408/429, CapabilityNotSupported, spawn error, unknown SdkError code, non-SDK exception). INT-1 proves the real-client rows.
// - backoff.spec.ts (full jitter, injected random): delay in [0, min(cap, base x 2^n)], interruptible by signal.
//
// Not automated in the suite: UC-N1 / UC-N2 (p95 executor overhead and fixture page latency) - timing-sensitive, run on demand by a separate script
// (p95 = sorted[ceil(0.95 n) - 1] after warm-up), per testing-principles.
