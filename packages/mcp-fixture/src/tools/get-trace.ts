import { z } from 'zod';
import { LOG_LEVELS, LOG_SERVICES, LOG_STATUSES } from '../dataset';
import { defineTool } from './fixture-tool';

const GetTraceArgsSchema = z.strictObject({
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/, 'traceId must be 32 lowercase hex characters')
    .meta({ title: 'Трасса' }),
});

const LogRecordSchema = z.strictObject({
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

const GetTraceResultSchema = z.strictObject({
  snapshot: z.string(),
  records: z.array(LogRecordSchema),
  totalMatched: z.int(),
});

/** Every record of one trace in time order (span order on equal time); an unknown trace gives 0 records. */
export const getTraceTool = defineTool({
  name: 'get_trace',
  title: 'Показать трассу',
  description: 'Get every log record of one trace (traceId: 32 lowercase hex characters) in time order.',
  readOnly: true,
  argsSchema: GetTraceArgsSchema,
  resultSchema: GetTraceResultSchema,
  run(args, dataset) {
    const records = dataset
      .traceRecords(args.traceId)
      .sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts) || left.spanSeq - right.spanSeq);
    return { snapshot: dataset.snapshot, records, totalMatched: records.length };
  },
});
