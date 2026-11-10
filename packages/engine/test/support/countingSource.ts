import { z } from 'zod';
import type { CallOutcome, SourceAdapter, SourceAllowlist, SourceCall, SourceSchema } from '@agent-os/sources';

/**
 * The in-memory source of the integration file (design-engine.md, Test Strategy): it answers `source.fetch` with the
 * records a test gives it and counts every call — the independent counter for "no source call". It impersonates the
 * fixture's source and tool names, so the shipped deep-research configuration passes the DC-14 check unchanged.
 */

export const COUNTING_SOURCE_ID = 'fixture';
const TOOL_NAMES = ['search_logs', 'aggregate_logs', 'get_trace'] as const;
const SNAPSHOT = 'counting-v1';

/** Accepts any value: the tool's arguments are the test's business, the adapter only counts and answers. */
/** Any arguments: a zod schema, since the engine describes each tool's arguments to the model as JSON schema. */
const anyArgs = z.record(z.string(), z.unknown());
const anyValue: SourceSchema = { safeParse: (value) => ({ success: true, data: value }) };

/** A recorded call, without the signal. */
export interface RecordedSourceCall {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly cursor: string | null;
}

/** Records of an answer; the default answers every call with no records. */
export type RecordsOf = (call: RecordedSourceCall) => readonly unknown[];

export interface CountingSource {
  readonly adapter: SourceAdapter;
  /** `source.fetch` may call every tool of the source. */
  readonly allowlist: SourceAllowlist;
  /** Calls in arrival order; a test may empty it. */
  readonly calls: RecordedSourceCall[];
  /** Sets the records each following call returns. */
  answerWith(records: RecordsOf): void;
  /**
   * A connected source that stops answering (AC-25.3): every call is a lost connection and the snapshot read
   * fails, until set back.
   */
  setUnavailable(unavailable: boolean): void;
  /**
   * A connected source whose every call matched by `which` is a lost connection while its snapshot still reads
   * (AC-25.3, DC-10: the fetch task exists and fails); `null` sets it back.
   */
  failCalls(which: ((call: RecordedSourceCall) => boolean) | null): void;
  /** The next call is recorded at once and answers when `until` settles (INT-2 A: the second request meets a live one). */
  holdNextCall(until: Promise<void>): void;
}

/** A log line as the real source's `search_logs` and `get_trace` return it. */
export interface SourceLogLine {
  readonly ts: string;
  readonly service: string;
  readonly level: string;
  readonly event: string;
  readonly traceId: string;
  readonly spanSeq: number;
  readonly status: string;
  readonly durationMs: number;
  readonly message: string;
}

/** A record of the shape the real source returns: the pointer rules and `checkAtoms` see what they see in production. */
export function sourceLogLine(fields: Partial<SourceLogLine> = {}): SourceLogLine {
  return {
    ts: '2026-09-15T19:04:12.000Z',
    service: 'payment-api',
    level: 'error',
    event: 'payment.failed',
    traceId: '4bf92f3577b34da6',
    spanSeq: 1,
    status: 'timeout',
    durationMs: 5_012,
    message: 'provider did not answer in time',
    ...fields,
  };
}

/** A count group as the real source's `aggregate_logs` returns it, one per time bucket and value. */
export function sourceCountGroup(
  key: string,
  count: number,
  start = '2026-09-15T19:00:00.000Z',
): { readonly start: string; readonly key: string; readonly count: number } {
  return { start, key, count };
}

/** What the fixture adapter answers when its process is gone (row K-5 of the mcp-source classification). */
const connectionLost: CallOutcome = {
  kind: 'transport',
  failureClass: 'transport_protocol',
  code: 'connection_lost',
  retryable: true,
  reconnect: true,
  cause: 'K-5',
};

export function createCountingSource(): CountingSource {
  const calls: RecordedSourceCall[] = [];
  let recordsOf: RecordsOf = () => [];
  let unavailable = false;
  let failing: ((call: RecordedSourceCall) => boolean) | null = null;
  let heldUntil: Promise<void> | null = null;

  const adapter: SourceAdapter = {
    descriptor: {
      sourceId: COUNTING_SOURCE_ID,
      tools: TOOL_NAMES.map((name) => ({
        name,
        paginated: false,
        readOnly: true,
        argsSchema: anyArgs,
        resultSchema: anyValue,
      })),
    },
    async call(call: SourceCall): Promise<CallOutcome> {
      const recorded = { toolName: call.toolName, args: call.args, cursor: call.cursor };
      calls.push(recorded);
      const hold = heldUntil;
      heldUntil = null;
      await hold;
      if (unavailable || failing?.(recorded) === true) {
        return connectionLost;
      }
      const items = recordsOf(recorded);
      return {
        kind: 'page',
        page: {
          snapshot: SNAPSHOT,
          items,
          returned: items.length,
          totalMatched: items.length,
          totalRelation: 'eq',
          nextCursor: null,
          exhausted: true,
        },
      };
    },
    currentSnapshot: () =>
      unavailable ? Promise.reject(new Error('counting source is unavailable')) : Promise.resolve(SNAPSHOT),
    close: () => Promise.resolve(),
  };

  return {
    adapter,
    allowlist: {
      'source.fetch': TOOL_NAMES.map((toolName) => ({ sourceId: COUNTING_SOURCE_ID, toolName })),
    },
    calls,
    answerWith: (records) => {
      recordsOf = records;
    },
    setUnavailable: (value) => {
      unavailable = value;
    },
    failCalls: (which) => {
      failing = which;
    },
    holdNextCall: (until) => {
      heldUntil = until;
    },
  };
}
