import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import type { LogFields, Logger } from '@agent-os/common';
import { APP_LOGGER } from './app-logger.js';

/**
 * Nest's `LoggerService` over the application logger (logging.md): framework records and every
 * `new Logger(context)` go through the same redaction and sinks. Nest passes the context as the last
 * string argument and, for `error`, the stack trace before it.
 */
@Injectable()
export class NestLoggerAdapter implements LoggerService {
  constructor(@Inject(APP_LOGGER) private readonly logger: Logger) {}

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.writeError(message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.writeError(message, optionalParams);
  }

  private write(
    level: 'debug' | 'info' | 'warn',
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const { context, rest } = splitContext(optionalParams);
    this.logger[level](
      ...toRecord(message, { ...contextField(context), ...extraField(rest) }),
    );
  }

  private writeError(message: unknown, optionalParams: unknown[]): void {
    // A lone stack trace without a context is not a context (Nest's ConsoleLogger reads it the same way).
    const { context, rest } =
      optionalParams.length === 1 && isStack(optionalParams[0])
        ? { context: undefined, rest: optionalParams }
        : splitContext(optionalParams);
    const [stack, ...extra] = rest;
    const stackField = typeof stack === 'string' ? { stack } : {};
    const remaining = typeof stack === 'string' ? extra : rest;
    this.logger.error(
      ...toRecord(message, {
        ...contextField(context),
        ...stackField,
        ...extraField(remaining),
      }),
    );
  }
}

function splitContext(params: unknown[]): {
  context?: string;
  rest: unknown[];
} {
  const last = params.at(-1);
  if (typeof last === 'string')
    return { context: last, rest: params.slice(0, -1) };
  return { rest: params };
}

function isStack(value: unknown): boolean {
  return typeof value === 'string' && /^(.)+\n\s+at .+:\d+:\d+/.test(value);
}

function contextField(context: string | undefined): LogFields {
  return context === undefined ? {} : { context };
}

function extraField(rest: unknown[]): LogFields {
  return rest.length === 0 ? {} : { params: rest };
}

/** A string is the message; an `Error` goes whole into `error`; anything else into `value`. */
function toRecord(message: unknown, fields: LogFields): [string, LogFields] {
  if (typeof message === 'string') return [message, fields];
  if (message instanceof Error)
    return [message.message, { ...fields, error: message }];
  return ['', { ...fields, value: message }];
}
