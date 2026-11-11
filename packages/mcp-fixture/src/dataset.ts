import { blockSeed, mulberry32, randomHex, randomInt, type Random } from './prng.js';
import {
  DATASET_PARAMS,
  snapshotOf,
  type DatasetVersion,
  type GeneratorParams,
  type LogDatasetVersion,
} from './versions.js';

export const LOG_SERVICES = ['checkout-web', 'payment-api', 'provider-adapter', 'fraud-check', 'ledger'] as const;
export type LogService = (typeof LOG_SERVICES)[number];
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_STATUSES = ['ok', 'error', 'timeout', 'late'] as const;
export type LogStatus = (typeof LOG_STATUSES)[number];

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

/** How a payment trace ends: a provider timeout, a provider decline or the settlement after an in-time approval. */
export type PaymentOutcome = 'provider_timeout' | 'provider_declined' | Settlement;

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
export interface IndexRange {
  start: number;
  end: number;
}

/**
 * Read-only synthetic log dataset of one version. Record `i` is a pure function of (version seed, `i`);
 * time never decreases with the index, so a time interval is an index range. Nothing is materialized up front.
 */
export interface LogDataset {
  readonly version: LogDatasetVersion;
  readonly snapshot: string;
  readonly recordCount: number;
  /** Moment of the change the data carries: the release of `v1`/`v2` or a scenario's moment of change. */
  readonly releaseAt: string;
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
export interface RecordDraft extends Omit<LogRecord, 'ts'> {
  offsetMs: number;
}

/** Time span of one block; records planted into it take offsets in `[0, spanMs)`. */
export interface BlockSpan {
  startMs: number;
  spanMs: number;
}

interface BlockContext extends BlockSpan {
  random: Random;
}

/** Provider latency and the local `provider-adapter` timeout of one request. */
export interface ProviderCall {
  latencyMs: number;
  timeoutMs: number;
  /** The provider replies in time but declines the authorization; absent means it approves. */
  declined?: boolean;
}

/** How a payment whose provider replied in time settles. */
export type Settlement = 'ok' | 'ledger_error' | 'unexplained_error';

/**
 * How payment traces unfold; `requestMs` is the absolute time the request to the provider is sent and `traceId` the
 * trace of the payment, already drawn, so reading it draws no random number.
 */
export interface PaymentModel {
  provider(random: Random, requestMs: number, traceId: string): ProviderCall;
  /** Settlement after an in-time provider reply; absent keeps the pinned trace shape without a `ledger.write` span. */
  settlement?(random: Random, requestMs: number): Settlement;
}

/** Everything a generated dataset is built from; `params` alone name the snapshot. */
export interface GenerationPlan {
  params: GeneratorParams;
  /** Moment of the change the data carries, reported as `LogDataset.releaseAt`. */
  changeAt: string;
  payment: PaymentModel;
  /** Records placed into a block besides its payment trace, at most `PLANTED_PER_BLOCK_MAX`. */
  planted?(block: BlockSpan): RecordDraft[];
}

/** Room a block keeps for planted records next to its longest payment trace. */
export const PLANTED_PER_BLOCK_MAX = 2;

export function createLogDataset(version: DatasetVersion): LogDataset {
  const params = DATASET_PARAMS[version];
  const releaseMs = Date.parse(params.releaseAt);
  const { beforeRelease, afterRelease } = params.providerTimeoutMs;
  return createGeneratedDataset({
    params,
    changeAt: params.releaseAt,
    payment: {
      provider: (random, requestMs) => ({
        latencyMs: providerLatency(random),
        timeoutMs: requestMs >= releaseMs ? afterRelease : beforeRelease,
      }),
    },
  });
}

/** A dataset generated block by block from `plan`; the shared engine of the pinned versions and the scenarios. */
export function createGeneratedDataset(plan: GenerationPlan): LogDataset {
  const { params } = plan;
  const layouts = blockLayouts(params);
  const blockCount = layouts.reduce((sum, layout) => sum + layout.blockCount, 0);
  const recordCount = blockCount * params.recordsPerBlock;
  let cached: ({ blockIndex: number } & GeneratedBlock) | undefined;
  let traceIndex: Map<string, number> | undefined;

  function generated(blockIndex: number): GeneratedBlock {
    if (cached?.blockIndex !== blockIndex) {
      cached = { blockIndex, ...generateBlock(plan, layoutOf(layouts, blockIndex), blockIndex) };
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
    releaseAt: plan.changeAt,
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

function blockLayouts(params: GeneratorParams): BlockLayout[] {
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

function generateBlock(plan: GenerationPlan, layout: BlockLayout, blockIndex: number): GeneratedBlock {
  const { params } = plan;
  const context: BlockContext = {
    random: mulberry32(blockSeed(params.seed, blockIndex)),
    startMs: Math.floor(layout.startMs + (blockIndex - layout.firstBlock) * layout.blockSpanMs),
    spanMs: Math.floor(layout.blockSpanMs),
  };
  const { drafts, order } = paymentTrace(context, plan.payment);
  const at = (offsetMs: number): string => new Date(context.startMs + offsetMs).toISOString();
  const planted = plan.planted?.({ startMs: context.startMs, spanMs: context.spanMs }) ?? [];
  if (planted.length > PLANTED_PER_BLOCK_MAX) {
    throw new RangeError(`block ${blockIndex}: ${planted.length} planted records exceed ${PLANTED_PER_BLOCK_MAX}`);
  }
  drafts.push(...planted);
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
 * checkout-web -> payment-api -> provider-adapter -> provider [-> ledger]. The model gives each request its provider
 * latency and local timeout; a reply slower than the timeout becomes `provider.timeout` + late `provider.response`.
 * Without a settlement model the trace keeps the pinned `v1`/`v2` shape and draws exactly the same random numbers.
 */
function paymentTrace(context: BlockContext, model: PaymentModel): { drafts: RecordDraft[]; order: OrderDraft } {
  const { random } = context;
  const traceId = randomHex(random, 16);
  const orderId = `ord-${randomHex(random, 4)}`;
  const amount = randomInt(random, 5, 900);
  const submitAt = randomInt(random, 0, MAX_TRACE_START_MS);
  const authorizeAt = submitAt + randomInt(random, 5, 30);
  const requestAt = authorizeAt + randomInt(random, 5, 50);
  const { latencyMs, timeoutMs, declined: declinedReply } = model.provider(random, context.startMs + requestAt, traceId);
  const timedOut = latencyMs > timeoutMs;
  const declined = !timedOut && declinedReply === true;
  const resolvedAt = requestAt + (timedOut ? timeoutMs : latencyMs);
  const ledger =
    timedOut || declined || model.settlement === undefined
      ? undefined
      : ledgerStep(random, model.settlement(random, context.startMs + requestAt), resolvedAt);
  const resultAt = (ledger === undefined ? resolvedAt : ledger.offsetMs + ledger.durationMs) + randomInt(random, 1, 20);
  const outcome: PaymentOutcome = timedOut ? 'provider_timeout' : declined ? 'provider_declined' : (ledger?.settlement ?? 'ok');
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
  } else if (declined) {
    drafts.push(
      span(3, {
        offsetMs: requestAt + latencyMs,
        service: 'provider-adapter',
        level: 'warn',
        event: 'provider.response',
        status: 'error',
        durationMs: latencyMs,
        message: `provider declined the authorization in ${latencyMs} ms`,
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
  if (ledger !== undefined) {
    drafts.push(span(drafts.length, ledgerDraft(ledger, orderId)));
  }
  drafts.push(
    span(drafts.length, {
      offsetMs: resultAt,
      service: 'payment-api',
      level: failed ? 'error' : 'info',
      event: 'payment.result',
      status: failed ? 'error' : 'ok',
      durationMs: resultAt - authorizeAt,
      message: PAYMENT_RESULT_MESSAGE[outcome](orderId),
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

const PAYMENT_RESULT_MESSAGE: Readonly<Record<PaymentOutcome, (orderId: string) => string>> = {
  ok: (orderId) => `payment authorized for order ${orderId}`,
  provider_timeout: (orderId) => `payment failed for order ${orderId}: provider timeout`,
  provider_declined: (orderId) => `payment failed for order ${orderId}: authorization declined by provider`,
  ledger_error: (orderId) => `payment failed for order ${orderId}: ledger write failed`,
  unexplained_error: (orderId) => `payment failed for order ${orderId}`,
};

interface LedgerStep {
  settlement: Settlement;
  offsetMs: number;
  durationMs: number;
}

function ledgerStep(random: Random, settlement: Settlement, resolvedAt: number): LedgerStep {
  const offsetMs = resolvedAt + randomInt(random, 1, 10);
  return { settlement, offsetMs, durationMs: randomInt(random, 2, 40) };
}

function ledgerDraft(ledger: LedgerStep, orderId: string): Omit<RecordDraft, 'traceId' | 'spanSeq'> {
  const failed = ledger.settlement === 'ledger_error';
  return {
    offsetMs: ledger.offsetMs,
    service: 'ledger',
    level: failed ? 'error' : 'info',
    event: 'ledger.write',
    status: failed ? 'error' : 'ok',
    durationMs: ledger.durationMs,
    message: failed
      ? `ledger write failed for order ${orderId}: row lock not acquired`
      : `ledger entry written for order ${orderId}`,
  };
}

/** Shifted exponential, capped so a trace always fits in its block; a slower provider passes a larger mean excess. */
export function providerLatency(random: Random, meanExcessMs: number = PROVIDER_LATENCY_MEAN_EXCESS_MS): number {
  const excess = Math.floor(-Math.log(1 - random()) * meanExcessMs);
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
