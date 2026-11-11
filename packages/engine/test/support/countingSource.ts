import { z } from 'zod';
import type { CallOutcome, SourceAdapter, SourceCall, SourceDeclaration, SourceSchema } from '@agent-os/sources';

/**
 * The in-memory sources of the integration files (design-engine.md, design-catalog-planning.md, Test Strategy): they
 * answer `source.fetch` with the records a test gives them and count every call and every slice read per source — the
 * independent counter of "source called". They impersonate the two training sources, `fixture` (the logs) and
 * `backoffice` (orders and payments), with their tool names and the declaration's descriptions, so the shipped
 * deep-research configuration passes the DC-14 check unchanged.
 */

export const COUNTING_SOURCE_ID = 'fixture';
export const BACKOFFICE_COUNTING_SOURCE_ID = 'backoffice';
/** Both counting sources: the ids a harness connects by default. */
export const COUNTING_SOURCE_IDS: readonly string[] = [COUNTING_SOURCE_ID, BACKOFFICE_COUNTING_SOURCE_ID];

/**
 * The declaration of both sources: the literals of `apps/api/src/sources/sources.config.ts` (`SOURCES_DECLARATION`),
 * copied because the engine package does not import `apps/api`. A transcript check compares against these texts, so
 * they change together with the declaration.
 */
const COUNTING_DECLARATION: SourceDeclaration = [
  {
    sourceId: COUNTING_SOURCE_ID,
    description:
      'Payment logs: one record per log line of the checkout and payment services, with time, service, level, ' +
      'event, status, traceId, duration and message. Answers what failed, when, how often and in which service. ' +
      'Holds no order amounts or payment methods; order numbers appear only inside messages; times are UTC.',
    tools: [
      {
        name: 'search_logs',
        description:
          'Log records in a time window, filtered by service, level, event or status, oldest first and paged by ' +
          'cursor. Use it to read the failing lines themselves; for example records, gather it with completeness sample ' +
          'and pageSize 50 or less.',
      },
      {
        name: 'aggregate_logs',
        description:
          'Counts of log records in a time window per 15-minute or hourly bucket and per value of one field. ' +
          'Use it to see when a failure started, peaked and stopped, and to learn the values of a field before ' +
          'filtering by it.',
      },
      {
        name: 'get_trace',
        description:
          'All log records of one request, by its traceId, oldest first. Use it to follow one payment through ' +
          'every service.',
      },
    ],
  },
  {
    sourceId: BACKOFFICE_COUNTING_SOURCE_ID,
    description:
      'Back office: the orders of the shop with amount, status (paid or failed) and payment method, and every ' +
      'payment attempt with its outcome and failure reason. Answers which orders a failure hit, how much money ' +
      'was at stake and why a payment was declined. Holds no log lines; each payment names the traceId of its logs.',
    tools: [
      {
        name: 'search_orders',
        description:
          'Orders created in a time window, filtered by status or payment method, oldest first and paged by ' +
          'cursor. Use it to count and list the orders a failure affected.',
      },
      {
        name: 'get_order',
        description:
          'One order by its number (ord-…) with all its payment attempts, their outcomes, failure reasons and ' +
          'traceIds. Use it to explain what happened to a given order.',
      },
    ],
  },
];

function declaredSource(sourceId: string): SourceDeclaration[number] {
  const declared = COUNTING_DECLARATION.find((source) => source.sourceId === sourceId);
  if (declared === undefined) throw new Error(`no counting source ${sourceId}`);
  return declared;
}

/** The description of a counting source as declared: what a transcript check looks for, or must not find. */
export function countingSourceDescription(sourceId: string): string {
  return declaredSource(sourceId).description;
}

/** The declared tools of a counting source with their descriptions, in declaration order. */
export function countingSourceTools(sourceId: string): readonly { readonly name: string; readonly description: string }[] {
  return declaredSource(sourceId).tools;
}

/** The slice each counting source reports. */
const SNAPSHOTS: Readonly<Record<string, string>> = {
  [COUNTING_SOURCE_ID]: 'counting-v1',
  [BACKOFFICE_COUNTING_SOURCE_ID]: 'counting-backoffice-v1',
};

/** Any arguments: a zod schema, since the engine describes each tool's arguments to the model as JSON schema. */
const anyArgs = z.record(z.string(), z.unknown());
/** Accepts any value: the tool's arguments are the test's business, the adapter only counts and answers. */
const anyValue: SourceSchema = { safeParse: (value) => ({ success: true, data: value }) };

/** A recorded call, without the signal. */
export interface RecordedSourceCall {
  /** The counting source that received the call. */
  readonly sourceId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly cursor: string | null;
}

/** Records of an answer; the default answers every call with no records. */
export type RecordsOf = (call: RecordedSourceCall) => readonly unknown[];

export interface CountingSource {
  /** The adapters of both sources, in declaration order: what an assembly with {@link declaration} connects. */
  readonly adapters: readonly SourceAdapter[];
  /** Both sources and every one of their tools, with the declaration's descriptions: `source.fetch` may call each tool. */
  readonly declaration: SourceDeclaration;
  /** Calls of both sources in arrival order; a test may empty it. */
  readonly calls: RecordedSourceCall[];
  /** The calls one source received, in arrival order. */
  callsOf(sourceId: string): readonly RecordedSourceCall[];
  /** How many times the slice of one source was read (`currentSnapshot`), failed reads included; never reset. */
  snapshotReadsOf(sourceId: string): number;
  /** Sets the records each following call returns; the call names its source, so one function answers both. */
  answerWith(records: RecordsOf): void;
  /**
   * A connected source that stops answering (AC-25.3): every call is a lost connection and the snapshot read
   * fails, until set back. `fixture` unless another source is named.
   */
  setUnavailable(unavailable: boolean, sourceId?: string): void;
  /**
   * A connected source whose every call matched by `which` is a lost connection while its snapshot still reads
   * (AC-25.3, DC-10: the fetch task exists and fails); `null` sets it back.
   */
  failCalls(which: ((call: RecordedSourceCall) => boolean) | null): void;
  /** The next call of either source is recorded at once and answers when `until` settles (INT-2 A: the second request meets a live one). */
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

/**
 * An order as the real back office's `search_orders` returns it (the order shape of the fixture tools' schemas): the
 * records of a double keep the real source's shape (research-flow UC-R1: a double whose records differ hides the defect).
 */
export interface SourceOrder {
  readonly orderId: string;
  readonly createdAt: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: 'paid' | 'failed';
  readonly paymentMethod: 'card' | 'paypal' | 'sepa_debit';
}

/** An order of the incident of {@link sourceLogLine}: failed, by card. */
export function sourceOrder(fields: Partial<SourceOrder> = {}): SourceOrder {
  return {
    orderId: 'ord-4bf92f35',
    createdAt: '2026-09-15T19:04:10.000Z',
    amount: 129.9,
    currency: 'EUR',
    status: 'failed',
    paymentMethod: 'card',
    ...fields,
  };
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
  const snapshotReads = new Map<string, number>();
  const unavailable = new Set<string>();
  let recordsOf: RecordsOf = () => [];
  let failing: ((call: RecordedSourceCall) => boolean) | null = null;
  let heldUntil: Promise<void> | null = null;

  const adapterOf = ({ sourceId, tools }: SourceDeclaration[number]): SourceAdapter => {
    const snapshot = SNAPSHOTS[sourceId] ?? `counting-${sourceId}`;
    return {
      descriptor: {
        sourceId,
        tools: tools.map(({ name }) => ({
          name,
          paginated: false,
          readOnly: true,
          argsSchema: anyArgs,
          resultSchema: anyValue,
        })),
      },
      async call(call: SourceCall): Promise<CallOutcome> {
        const recorded: RecordedSourceCall = { sourceId, toolName: call.toolName, args: call.args, cursor: call.cursor };
        calls.push(recorded);
        const hold = heldUntil;
        heldUntil = null;
        await hold;
        if (unavailable.has(sourceId) || failing?.(recorded) === true) {
          return connectionLost;
        }
        const items = recordsOf(recorded);
        return {
          kind: 'page',
          page: {
            snapshot,
            items,
            returned: items.length,
            totalMatched: items.length,
            totalRelation: 'eq',
            nextCursor: null,
            exhausted: true,
          },
        };
      },
      currentSnapshot: () => {
        snapshotReads.set(sourceId, (snapshotReads.get(sourceId) ?? 0) + 1);
        return unavailable.has(sourceId)
          ? Promise.reject(new Error(`counting source ${sourceId} is unavailable`))
          : Promise.resolve(snapshot);
      },
      close: () => Promise.resolve(),
    };
  };

  return {
    adapters: COUNTING_DECLARATION.map(adapterOf),
    declaration: COUNTING_DECLARATION,
    calls,
    callsOf: (sourceId) => calls.filter((call) => call.sourceId === sourceId),
    snapshotReadsOf: (sourceId) => snapshotReads.get(sourceId) ?? 0,
    answerWith: (records) => {
      recordsOf = records;
    },
    setUnavailable: (value, sourceId = COUNTING_SOURCE_ID) => {
      if (value) unavailable.add(sourceId);
      else unavailable.delete(sourceId);
    },
    failCalls: (which) => {
      failing = which;
    },
    holdNextCall: (until) => {
      heldUntil = until;
    },
  };
}
