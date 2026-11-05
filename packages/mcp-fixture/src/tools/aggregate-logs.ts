import { z } from 'zod';
import type { LogRecord } from '../dataset.js';
import { defineTool } from './fixture-tool.js';
import { LogQueryShape, matchingRecords, WINDOW_ORDER_MESSAGE, windowIsOrdered } from './log-query.js';

const BUCKET_MS = { '15m': 15 * 60_000, '1h': 60 * 60_000 } as const;
const GROUP_BY_FIELDS = ['service', 'level', 'event', 'status'] as const;

const AggregateLogsArgsSchema = z
  .strictObject({
    ...LogQueryShape,
    groupBy: z.enum(GROUP_BY_FIELDS),
    bucket: z.enum(['15m', '1h']),
  })
  .refine(windowIsOrdered, { message: WINDOW_ORDER_MESSAGE, path: ['to'] });

interface Bucket {
  start: string;
  key: string;
  count: number;
}

/**
 * Counts of matching records per time bucket (aligned to UTC) and `groupBy` value. Only non-empty buckets are
 * returned, ordered by `start`, then `key`; `totalMatched` counts records, not buckets.
 */
export const aggregateLogsTool = defineTool({
  name: 'aggregate_logs',
  description:
    'Count payment logs in [from, to) per time bucket (15m or 1h, UTC-aligned) and groupBy field value, ' +
    'with the same filters as search_logs. Returns non-empty buckets ordered by start, then key.',
  argsSchema: AggregateLogsArgsSchema,
  run(args, dataset) {
    const { groupBy, bucket, ...query } = args;
    const matched = matchingRecords(dataset, query);
    return {
      snapshot: dataset.snapshot,
      buckets: countBuckets(matched, groupBy, BUCKET_MS[bucket]),
      totalMatched: matched.length,
      totalRelation: 'eq',
    };
  },
});

function countBuckets(records: LogRecord[], groupBy: (typeof GROUP_BY_FIELDS)[number], bucketMs: number): Bucket[] {
  const counts = new Map<string, Bucket>();
  for (const record of records) {
    const startMs = Math.floor(Date.parse(record.ts) / bucketMs) * bucketMs;
    const key = record[groupBy];
    const id = `${startMs}\u0000${key}`;
    const bucket = counts.get(id);
    if (bucket === undefined) {
      counts.set(id, { start: new Date(startMs).toISOString(), key, count: 1 });
    } else {
      bucket.count += 1;
    }
  }
  return [...counts.values()].sort(
    (left, right) => compareText(left.start, right.start) || compareText(left.key, right.key),
  );
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}
