import type { LogFields, LogSink } from './logger.js';

/** Writes one JSON line per record; the only place that calls `console`. */
export function consoleSink(): LogSink {
  return {
    write(record) {
      const line = JSON.stringify(record);
      if (record.level === 'error') console.error(line);
      else if (record.level === 'warn') console.warn(line);
      else console.log(line);
    },
  };
}

type SentryLogMethod = (message: string, attributes?: Record<string, unknown>) => void;

/** The part of an application's Sentry SDK (`@sentry/nestjs`, `@sentry/nextjs`) the sink uses. */
export interface SentrySdk {
  logger: {
    debug: SentryLogMethod;
    info: SentryLogMethod;
    warn: SentryLogMethod;
    error: SentryLogMethod;
  };
  captureException(error: unknown, context?: { extra?: Record<string, unknown> }): unknown;
}

/** Sends every record to Sentry Logs; a record with `error` is also sent as an exception. */
export function sentrySink(sdk: SentrySdk): LogSink {
  return {
    write(record) {
      sdk.logger[record.level](record.message, record.fields);
      if ('error' in record.fields) {
        sdk.captureException(toError(record.fields.error), { extra: record.fields });
      }
    },
  };
}

/** Rebuilds an `Error` from the already redacted expansion, never from the original value. */
function toError(expanded: unknown): Error {
  const fields = (expanded ?? {}) as LogFields;
  const error = new Error(typeof fields.message === 'string' ? fields.message : '');
  if (typeof fields.name === 'string') error.name = fields.name;
  error.stack = typeof fields.stack === 'string' ? fields.stack : undefined;
  return error;
}
