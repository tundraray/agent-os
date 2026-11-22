import { HttpException } from '@nestjs/common';
import type { LogFields, Logger } from '@agent-os/common';

/** One call of a route: its name, the caller's ids, the work, and the outcome fields read from the result. */
export interface RouteCall<T> {
  readonly route: string;
  /** Ids and counts only, never a text of the employee. */
  readonly fields: LogFields;
  readonly work: () => Promise<T>;
  readonly outcomeOf?: (result: T) => LogFields;
}

/** How a family of routes names its log records and answers an error. */
export interface RouteStyle {
  /** The first words of the record's name: `route` gives `route answered`, `route refused`, `route failed`. */
  readonly subject: string;
  /** The HTTP answer of an error of the work; absent — the error leaves as it came. */
  readonly toHttpError?: (error: unknown) => HttpException;
}

const PLAIN_ROUTE: RouteStyle = { subject: 'route' };

/**
 * Runs one route and writes its one log record: the route, the caller's fields, the outcome and
 * `durationMs`. An answer below 500 is `info` with its `status` and `errorCode`; anything else is
 * `error` with the `status` and the original error in `error`.
 */
export async function loggedRoute<T>(
  logger: Logger,
  { route, fields, work, outcomeOf }: RouteCall<T>,
  { subject, toHttpError }: RouteStyle = PLAIN_ROUTE,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    logger.info(`${subject} answered`, {
      route,
      ...fields,
      outcome: 'ok',
      ...outcomeOf?.(result),
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const answer: unknown = toHttpError ? toHttpError(error) : error;
    const status = answer instanceof HttpException ? answer.getStatus() : 500;
    if (answer instanceof HttpException && status < 500) {
      const body = answer.getResponse();
      logger.info(`${subject} refused`, {
        route,
        ...fields,
        outcome: 'refused',
        status,
        errorCode:
          typeof body === 'object' && 'errorCode' in body
            ? body.errorCode
            : undefined,
        durationMs: Date.now() - startedAt,
      });
    } else {
      logger.error(`${subject} failed`, {
        route,
        ...fields,
        outcome: 'error',
        status,
        durationMs: Date.now() - startedAt,
        error,
      });
    }
    throw answer;
  }
}
