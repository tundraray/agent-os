import { z } from 'zod';
import { LOG_LEVELS, LOG_SERVICES, LOG_STATUSES, type LogDataset, type LogRecord } from '../dataset.js';

/** Time window and optional record filters shared by `search_logs` and `aggregate_logs`. */
export const LogQueryShape = {
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  service: z.enum(LOG_SERVICES).optional(),
  level: z.enum(LOG_LEVELS).optional(),
  event: z.string().min(1).max(200).optional(),
  status: z.enum(LOG_STATUSES).optional(),
};

/** `from < to`, checked after both are valid ISO times. */
export function windowIsOrdered(query: { from: string; to: string }): boolean {
  return Date.parse(query.from) < Date.parse(query.to);
}
export const WINDOW_ORDER_MESSAGE = '`from` must be earlier than `to`';

export interface LogQuery {
  from: string;
  to: string;
  service?: LogRecord['service'];
  level?: LogRecord['level'];
  event?: string;
  status?: LogRecord['status'];
}

/** Records with `from <= ts < to` that pass every given filter, in dataset (time) order. */
export function matchingRecords(dataset: LogDataset, query: LogQuery): LogRecord[] {
  const { start, end } = dataset.indexRange(query.from, query.to);
  const matched: LogRecord[] = [];
  for (let index = start; index < end; index += 1) {
    const record = dataset.recordAt(index);
    if (passesFilters(record, query)) {
      matched.push(record);
    }
  }
  return matched;
}

function passesFilters(record: LogRecord, query: LogQuery): boolean {
  return (
    (query.service === undefined || record.service === query.service) &&
    (query.level === undefined || record.level === query.level) &&
    (query.event === undefined || record.event === query.event) &&
    (query.status === undefined || record.status === query.status)
  );
}
