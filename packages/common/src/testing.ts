import type { LogRecord, LogSink } from './logger.js';

export interface MemorySink extends LogSink {
  readonly records: LogRecord[];
}

/** Keeps processed records in memory for tests. */
export function memorySink(): MemorySink {
  const records: LogRecord[] = [];
  return {
    records,
    write(record) {
      records.push(record);
    },
  };
}
