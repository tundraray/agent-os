import { z } from 'zod';

/**
 * Argument and result contracts of the fixture tools (design-mcp-source.md, Fixture MCP). Production code does not
 * import the fixture package, so the contract is restated here; INT-1 and INT-4 prove it against the real process.
 */

const LOG_SERVICES = ['checkout-web', 'payment-api', 'provider-adapter', 'fraud-check', 'ledger'] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const LOG_STATUSES = ['ok', 'error', 'timeout', 'late'] as const;
const GROUP_BY_FIELDS = ['service', 'level', 'event', 'status'] as const;
const SEARCH_PAGE_SIZE_MAX = 500;
const SNAPSHOT_MAX_LENGTH = 200;

const LogQueryShape = {
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  service: z.enum(LOG_SERVICES).optional(),
  level: z.enum(LOG_LEVELS).optional(),
  event: z.string().min(1).max(200).optional(),
  status: z.enum(LOG_STATUSES).optional(),
};

function windowIsOrdered(query: { from: string; to: string }): boolean {
  return Date.parse(query.from) < Date.parse(query.to);
}
const WINDOW_ORDER = { message: '`from` must be earlier than `to`', path: ['to'] };

/** Arguments without the cursor: the cursor travels in `SourceCall.cursor`. */
export const SearchLogsArgsSchema = z
  .strictObject({
    ...LogQueryShape,
    pageSize: z.int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE_MAX),
  })
  .refine(windowIsOrdered, WINDOW_ORDER);

export const AggregateLogsArgsSchema = z
  .strictObject({
    ...LogQueryShape,
    groupBy: z.enum(GROUP_BY_FIELDS),
    bucket: z.enum(['15m', '1h']),
  })
  .refine(windowIsOrdered, WINDOW_ORDER);

export const GetTraceArgsSchema = z.strictObject({
  traceId: z.string().regex(/^[0-9a-f]{32}$/, 'traceId must be 32 lowercase hex characters'),
});

const SnapshotSchema = z.string().min(1).max(SNAPSHOT_MAX_LENGTH);

const LogRecordSchema = z.object({
  ts: z.string(),
  service: z.enum(LOG_SERVICES),
  level: z.enum(LOG_LEVELS),
  event: z.string(),
  traceId: z.string(),
  spanSeq: z.int(),
  status: z.enum(LOG_STATUSES),
  durationMs: z.number(),
  message: z.string(),
});

/**
 * Totals are optional in every result: the `unknown_total` fault drops both, and the source may not report a total.
 * One of the pair without the other is a contract violation.
 */
const TotalShape = {
  totalMatched: z.int().min(0).optional(),
  totalRelation: z.enum(['eq', 'gte']).optional(),
};
function totalIsPaired(result: { totalMatched?: number; totalRelation?: string }): boolean {
  return (result.totalMatched === undefined) === (result.totalRelation === undefined);
}
const TOTAL_PAIRED = { message: '`totalMatched` and `totalRelation` come together', path: ['totalRelation'] };

export const SearchLogsResultSchema = z
  .object({
    snapshot: SnapshotSchema,
    records: z.array(LogRecordSchema),
    ...TotalShape,
    nextCursor: z.string().min(1).nullable(),
  })
  .refine(totalIsPaired, TOTAL_PAIRED);

export const AggregateLogsResultSchema = z
  .object({
    snapshot: SnapshotSchema,
    buckets: z.array(z.object({ start: z.string(), key: z.string(), count: z.int().min(1) })),
    ...TotalShape,
  })
  .refine(totalIsPaired, TOTAL_PAIRED);

export const GetTraceResultSchema = z.object({
  snapshot: SnapshotSchema,
  records: z.array(LogRecordSchema),
  totalMatched: z.int().min(0).optional(),
});

/** Resource `fixture://source-info`. */
export const SourceInfoSchema = z.object({
  snapshot: SnapshotSchema,
  datasetVersion: z.string(),
  recordCount: z.int().min(0),
});

/* Back-office tools (`FIXTURE_SOURCE=backoffice`): orders and payments of the same dataset as the logs. */

const ORDER_STATUSES = ['paid', 'failed'] as const;
const PAYMENT_METHODS = ['card', 'paypal', 'sepa_debit'] as const;
const ORDER_ID = /^ord-[0-9a-f]{8}$/;

/** Arguments without the cursor: the cursor travels in `SourceCall.cursor`. */
export const SearchOrdersArgsSchema = z
  .strictObject({
    from: LogQueryShape.from,
    to: LogQueryShape.to,
    status: z.enum(ORDER_STATUSES).optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    pageSize: z.int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE_MAX),
  })
  .refine(windowIsOrdered, WINDOW_ORDER);

export const GetOrderArgsSchema = z.strictObject({
  orderId: z.string().regex(ORDER_ID, 'orderId must be ord- and 8 lowercase hex characters'),
});

const OrderShape = {
  orderId: z.string().regex(ORDER_ID),
  createdAt: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.enum(ORDER_STATUSES),
  paymentMethod: z.enum(PAYMENT_METHODS),
};

const PaymentSchema = z.object({
  paymentId: z.string(),
  traceId: z.string(),
  amount: z.number(),
  currency: z.string(),
  status: z.enum(['authorized', 'failed']),
  failureReason: z.string().nullable(),
  requestedAt: z.string(),
  resolvedAt: z.string(),
});

export const SearchOrdersResultSchema = z
  .object({
    snapshot: SnapshotSchema,
    orders: z.array(z.object(OrderShape)),
    ...TotalShape,
    nextCursor: z.string().min(1).nullable(),
  })
  .refine(totalIsPaired, TOTAL_PAIRED);

/** `order` is null when no order has the requested id. */
export const GetOrderResultSchema = z.object({
  snapshot: SnapshotSchema,
  order: z.object({ ...OrderShape, payments: z.array(PaymentSchema) }).nullable(),
});
