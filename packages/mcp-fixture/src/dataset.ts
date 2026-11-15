import { blockSeed, mulberry32, randomHex, randomInt, type Random } from './prng.js';
import { DATASET_PARAMS, snapshotOf, type DatasetParams, type DatasetVersion } from './versions.js';

export const LOG_SERVICES = ['checkout-web', 'payment-api', 'provider-adapter', 'fraud-check', 'ledger'] as const;
type LogService = (typeof LOG_SERVICES)[number];
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_STATUSES = ['ok', 'error', 'timeout', 'late'] as const;
type LogStatus = (typeof LOG_STATUSES)[number];

/** One synthetic log record. `ts` is ISO UTC with milliseconds; `message` is at most 200 characters. */
export interface LogRecord {
  ts: string;
  service: LogService;
  level: LogLevel;
  event: string;
  traceId: string;
  spanSeq: number;
  status: LogStatus;
  durationMs: number;
  message: string;
}

/** How a payment trace ends: a provider timeout or an in-time approval. */
export type PaymentOutcome = 'provider_timeout' | 'ok';

/** The order a block's payment trace pays for, as the generator drew it; the back office is built from these. */
export interface PaymentOrder {
  orderId: string;
  traceId: string;
  /** Amount in EUR. */
  amount: number;
  /** `ts` of the trace's `checkout.submit`. */
  submittedAt: string;
  /** `ts` of the trace's `provider.request`. */
  requestedAt: string;
  /** `ts` of the trace's `payment.result`. */
  resolvedAt: string;
  outcome: PaymentOutcome;
}

/** Half-open index range `[start, end)`. */
interface IndexRange {
  start: number;
  end: number;
}

/**
 * Read-only synthetic log dataset of one version. Record `i` is a pure function of (version seed, `i`);
 * time never decreases with the index, so a time interval is an index range. Nothing is materialized up front.
 */
export interface LogDataset {
  readonly version: DatasetVersion;
  readonly snapshot: string;
  readonly recordCount: number;
  recordAt(index: number): LogRecord;
  /** Indices of records with `from <= ts < to`. */
  indexRange(from: string, to: string): IndexRange;
  /** Records of one trace in time order; empty when the trace does not exist. */
  traceRecords(traceId: string): LogRecord[];
  /** Payment orders, one per block; `submittedAt` never decreases with the index. */
  readonly orderCount: number;
  orderAt(index: number): PaymentOrder;
}

const MESSAGE_MAX_LENGTH = 200;
/** Latest offset a payment trace can reach inside its block; every block must be longer. */
const MAX_TRACE_SPAN_MS = 9_500;
const MAX_TRACE_START_MS = 500;
const PROVIDER_LATENCY_MIN_MS = 200;
const PROVIDER_LATENCY_MEAN_EXCESS_MS = 600;
const PROVIDER_LATENCY_MAX_MS = 8_000;

interface BlockLayout {
  firstBlock: number;
  blockCount: number;
  startMs: number;
  blockSpanMs: number;
}

/** A record before it is placed in time: `offsetMs` counts from the start of its block. */
interface RecordDraft extends Omit<LogRecord, 'ts'> {
  offsetMs: number;
}

/** Local `provider-adapter` timeout of a request sent at `requestMs` (absolute time). */
type TimeoutAt = (requestMs: number) => number;

interface BlockContext {
  random: Random;
  startMs: number;
  spanMs: number;
  timeoutAt: TimeoutAt;
}

export function createLogDataset(version: DatasetVersion): LogDataset {
  const params = DATASET_PARAMS[version];
  const releaseMs = Date.parse(params.releaseAt);
  const { beforeRelease, afterRelease } = params.providerTimeoutMs;
  const timeoutAt: TimeoutAt = (requestMs) => (requestMs >= releaseMs ? afterRelease : beforeRelease);
  const layouts = blockLayouts(params);
  const blockCount = layouts.reduce((sum, layout) => sum + layout.blockCount, 0);
  const recordCount = blockCount * params.recordsPerBlock;
  let cached: ({ blockIndex: number } & GeneratedBlock) | undefined;
  let traceIndex: Map<string, number> | undefined;

  function generated(blockIndex: number): GeneratedBlock {
    if (cached?.blockIndex !== blockIndex) {
      cached = { blockIndex, ...generateBlock(params, layoutOf(layouts, blockIndex), blockIndex, timeoutAt) };
    }
    return cached;
  }

  function block(blockIndex: number): LogRecord[] {
    return generated(blockIndex).records;
  }

  function orderAt(index: number): PaymentOrder {
    if (!Number.isInteger(index) || index < 0 || index >= blockCount) {
      throw new RangeError(`order index ${index} is outside [0, ${blockCount})`);
    }
    return generated(index).order;
  }

  function recordAt(index: number): LogRecord {
    if (!Number.isInteger(index) || index < 0 || index >= recordCount) {
      throw new RangeError(`record index ${index} is outside [0, ${recordCount})`);
    }
    return block(Math.floor(index / params.recordsPerBlock))[index % params.recordsPerBlock];
  }

  function firstIndexAtOrAfter(timeMs: number): number {
    let low = 0;
    let high = recordCount;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (Date.parse(recordAt(middle).ts) < timeMs) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  function traceRecords(traceId: string): LogRecord[] {
    traceIndex ??= buildTraceIndex(blockCount, block);
    const blockIndex = traceIndex.get(traceId);
    return blockIndex === undefined ? [] : block(blockIndex).filter((record) => record.traceId === traceId);
  }

  return {
    version: params.version,
    snapshot: snapshotOf(params),
    recordCount,
    recordAt,
    indexRange: (from, to) => {
      const start = firstIndexAtOrAfter(Date.parse(from));
      return { start, end: Math.max(start, firstIndexAtOrAfter(Date.parse(to))) };
    },
    traceRecords,
    orderCount: blockCount,
    orderAt,
  };
}

function blockLayouts(params: DatasetParams): BlockLayout[] {
  let firstBlock = 0;
  return params.segments.map((segment) => {
    if (segment.records % params.recordsPerBlock !== 0) {
      throw new Error(`segment ${segment.start}: ${segment.records} records do not fill whole blocks`);
    }
    const startMs = Date.parse(segment.start);
    const blockCount = segment.records / params.recordsPerBlock;
    const blockSpanMs = (Date.parse(segment.end) - startMs) / blockCount;
    if (blockSpanMs <= MAX_TRACE_SPAN_MS) {
      throw new Error(`segment ${segment.start}: block span ${blockSpanMs} ms cannot hold a trace`);
    }
    const layout = { firstBlock, blockCount, startMs, blockSpanMs };
    firstBlock += blockCount;
    return layout;
  });
}

function layoutOf(layouts: BlockLayout[], blockIndex: number): BlockLayout {
  const layout = layouts.find(
    (candidate) => blockIndex >= candidate.firstBlock && blockIndex < candidate.firstBlock + candidate.blockCount,
  );
  if (layout === undefined) {
    throw new RangeError(`block ${blockIndex} is outside the dataset`);
  }
  return layout;
}

function buildTraceIndex(blockCount: number, block: (blockIndex: number) => LogRecord[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex += 1) {
    for (const record of block(blockIndex)) {
      index.set(record.traceId, blockIndex);
    }
  }
  return index;
}

interface GeneratedBlock {
  records: LogRecord[];
  order: PaymentOrder;
}

function generateBlock(
  params: DatasetParams,
  layout: BlockLayout,
  blockIndex: number,
  timeoutAt: TimeoutAt,
): GeneratedBlock {
  const context: BlockContext = {
    random: mulberry32(blockSeed(params.seed, blockIndex)),
    startMs: Math.floor(layout.startMs + (blockIndex - layout.firstBlock) * layout.blockSpanMs),
    spanMs: Math.floor(layout.blockSpanMs),
    timeoutAt,
  };
  const { drafts, order } = paymentTrace(context);
  const at = (offsetMs: number): string => new Date(context.startMs + offsetMs).toISOString();
  while (drafts.length < params.recordsPerBlock) {
    drafts.push(backgroundRecord(context));
  }
  const records = drafts
    .sort((left, right) => left.offsetMs - right.offsetMs)
    .map(({ offsetMs, ...record }) => ({
      ...record,
      ts: at(offsetMs),
      message: record.message.slice(0, MESSAGE_MAX_LENGTH),
    }));
  const { submitAt, requestAt, resultAt, ...drawn } = order;
  return {
    records,
    order: { ...drawn, submittedAt: at(submitAt), requestedAt: at(requestAt), resolvedAt: at(resultAt) },
  };
}

/**
 * checkout-web -> payment-api -> provider-adapter -> provider. Each request gets its provider latency and local
 * timeout; a reply slower than the timeout becomes `provider.timeout` + late `provider.response`.
 */
function paymentTrace(context: BlockContext): { drafts: RecordDraft[]; order: OrderDraft } {
  const { random } = context;
  const traceId = randomHex(random, 16);
  const orderId = `ord-${randomHex(random, 4)}`;
  const amount = randomInt(random, 5, 900);
  const submitAt = randomInt(random, 0, MAX_TRACE_START_MS);
  const authorizeAt = submitAt + randomInt(random, 5, 30);
  const requestAt = authorizeAt + randomInt(random, 5, 50);
  const latencyMs = providerLatency(random);
  const timeoutMs = context.timeoutAt(context.startMs + requestAt);
  const timedOut = latencyMs > timeoutMs;
  const resolvedAt = requestAt + (timedOut ? timeoutMs : latencyMs);
  const resultAt = resolvedAt + randomInt(random, 1, 20);
  const outcome: PaymentOutcome = timedOut ? 'provider_timeout' : 'ok';
  const failed = outcome !== 'ok';

  const span = (seq: number, draft: Omit<RecordDraft, 'traceId' | 'spanSeq'>): RecordDraft => ({
    ...draft,
    traceId,
    spanSeq: seq,
  });
  const drafts: RecordDraft[] = [
    span(0, {
      offsetMs: submitAt,
      service: 'checkout-web',
      level: 'info',
      event: 'checkout.submit',
      status: failed ? 'error' : 'ok',
      durationMs: resultAt - submitAt,
      message: `checkout submitted for order ${orderId}`,
    }),
    span(1, {
      offsetMs: authorizeAt,
      service: 'payment-api',
      level: 'info',
      event: 'payment.authorize',
      status: 'ok',
      durationMs: 0,
      message: `authorize ${amount} EUR for order ${orderId}`,
    }),
    span(2, {
      offsetMs: requestAt,
      service: 'provider-adapter',
      level: 'info',
      event: 'provider.request',
      status: 'ok',
      durationMs: 0,
      message: `request sent to payment provider, local timeout ${timeoutMs} ms`,
    }),
  ];
  if (timedOut) {
    drafts.push(
      span(3, {
        offsetMs: requestAt + timeoutMs,
        service: 'provider-adapter',
        level: 'error',
        event: 'provider.timeout',
        status: 'timeout',
        durationMs: timeoutMs,
        message: `no provider response within local timeout ${timeoutMs} ms, request abandoned`,
      }),
      span(4, {
        offsetMs: requestAt + latencyMs,
        service: 'provider-adapter',
        level: 'warn',
        event: 'provider.response',
        status: 'late',
        durationMs: latencyMs,
        message: `provider responded in ${latencyMs} ms, after local timeout ${timeoutMs} ms; response discarded`,
      }),
    );
  } else {
    drafts.push(
      span(3, {
        offsetMs: requestAt + latencyMs,
        service: 'provider-adapter',
        level: 'info',
        event: 'provider.response',
        status: 'ok',
        durationMs: latencyMs,
        message: `provider responded in ${latencyMs} ms`,
      }),
    );
  }
  drafts.push(
    span(drafts.length, {
      offsetMs: resultAt,
      service: 'payment-api',
      level: failed ? 'error' : 'info',
      event: 'payment.result',
      status: failed ? 'error' : 'ok',
      durationMs: resultAt - authorizeAt,
      message: failed
        ? `payment failed for order ${orderId}: provider timeout`
        : `payment authorized for order ${orderId}`,
    }),
  );
  return { drafts, order: { orderId, traceId, amount, submitAt, requestAt, resultAt, outcome } };
}

/** A payment order before it is placed in time: offsets count from the start of its block. */
interface OrderDraft extends Omit<PaymentOrder, 'submittedAt' | 'requestedAt' | 'resolvedAt'> {
  submitAt: number;
  requestAt: number;
  resultAt: number;
}

/** Shifted exponential, capped so a trace always fits in its block. */
function providerLatency(random: Random): number {
  const excess = Math.floor(-Math.log(1 - random()) * PROVIDER_LATENCY_MEAN_EXCESS_MS);
  return Math.min(PROVIDER_LATENCY_MAX_MS, PROVIDER_LATENCY_MIN_MS + excess);
}

function backgroundRecord(context: BlockContext): RecordDraft {
  const { random } = context;
  const offsetMs = randomInt(random, 0, context.spanMs - 1);
  const traceId = randomHex(random, 16);
  const kind = randomInt(random, 0, 2);
  if (kind === 0) {
    const score = randomInt(random, 0, 99);
    return {
      offsetMs,
      traceId,
      spanSeq: 0,
      service: 'fraud-check',
      level: 'info',
      event: 'fraud.score',
      status: 'ok',
      durationMs: randomInt(random, 5, 80),
      message: `fraud score ${score} for session s-${randomHex(random, 4)}`,
    };
  }
  if (kind === 1) {
    const failed = random() < 0.01;
    return {
      offsetMs,
      traceId,
      spanSeq: 0,
      service: 'ledger',
      level: failed ? 'error' : 'info',
      event: 'ledger.write',
      status: failed ? 'error' : 'ok',
      durationMs: randomInt(random, 2, 40),
      message: failed ? 'ledger write failed: row lock not acquired' : `ledger entry written for batch b-${randomHex(random, 3)}`,
    };
  }
  return {
    offsetMs,
    traceId,
    spanSeq: 0,
    service: 'checkout-web',
    level: 'debug',
    event: 'page.view',
    status: 'ok',
    durationMs: randomInt(random, 20, 400),
    message: `page /checkout/${['cart', 'shipping', 'payment'][randomInt(random, 0, 2)]} rendered`,
  };
}
