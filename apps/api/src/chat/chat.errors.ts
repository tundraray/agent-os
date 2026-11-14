import {
  BadRequestException,
  ConflictException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AgentsError } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import type { ThreadsErrorCode } from '@agent-os/contracts';
import { RuntimeError } from '@agent-os/runtime';
import { WorkflowsError } from '@agent-os/workflows';

/**
 * The not-found codes a route answers with; a runtime `TASK_NOT_FOUND` and an agents `AGENT_NOT_FOUND`
 * become the route's own one.
 */
export type NotFoundCode = Extract<
  ThreadsErrorCode,
  'THREAD_NOT_FOUND' | 'AGENT_NOT_FOUND' | 'RUN_NOT_FOUND' | 'DECISION_NOT_FOUND'
>;

/**
 * One constant message per code: a missing and another owner's object answer with the same body
 * (NFR-06, plan rule 11), and no text of the original error reaches the client.
 */
const MESSAGES: Record<ThreadsErrorCode, string> = {
  THREAD_NOT_FOUND: 'Thread not found',
  AGENT_NOT_FOUND: 'Agent not found',
  RUN_NOT_FOUND: 'Run not found',
  DECISION_NOT_FOUND: 'Decision not found',
  VALIDATION_FAILED: 'Validation failed',
  INVALID_CURSOR: 'Invalid cursor',
  INVALID_ARGUMENTS: 'Invalid arguments',
  NOT_FINISHED: 'Agent is not finished',
  PARENT_FINISHED: 'Parent agent is finished',
};

/** The HTTP answer of one API error code: body `{ statusCode, message, error, errorCode }` (`ApiErrorSchema`). */
export function httpError(code: ThreadsErrorCode): HttpException {
  const message = MESSAGES[code];
  switch (code) {
    case 'THREAD_NOT_FOUND':
    case 'AGENT_NOT_FOUND':
    case 'RUN_NOT_FOUND':
    case 'DECISION_NOT_FOUND':
      return new NotFoundException(message, { errorCode: code });
    case 'VALIDATION_FAILED':
    case 'INVALID_CURSOR':
    case 'INVALID_ARGUMENTS':
      return new BadRequestException(message, { errorCode: code });
    case 'NOT_FINISHED':
    case 'PARENT_FINISHED':
      return new ConflictException(message, { errorCode: code });
  }
}

/** 404 THREAD_NOT_FOUND: missing, foreign and deleted threads stay indistinguishable to the client. */
export const threadNotFound = (): HttpException => httpError('THREAD_NOT_FOUND');

/** The code of an expected refusal of a package, or `undefined` for anything else. */
function codeOf(error: unknown, notFound: NotFoundCode): ThreadsErrorCode | undefined {
  if (error instanceof AgentsError) {
    switch (error.code) {
      // A tree deleted mid-read of a conversation is the conversation missing (Flow 6).
      case 'AGENT_NOT_FOUND':
        return notFound;
      case 'NOT_FINISHED':
      case 'INVALID_ARGUMENTS':
        return error.code;
      default:
        return undefined;
    }
  }
  if (error instanceof RuntimeError) {
    switch (error.code) {
      case 'TASK_NOT_FOUND':
        return notFound;
      case 'DECISION_NOT_FOUND':
      case 'PARENT_FINISHED':
        return error.code;
      default:
        return undefined;
    }
  }
  if (error instanceof WorkflowsError) return error.code;
  return undefined;
}

/**
 * Translates any error of a command into its HTTP answer: an `HttpException` (validation, cursor, the
 * service's own codes) as is, an expected refusal of `agents`, `runtime` or `workflows` into its code
 * with a constant message, anything else into a bare 500 with neither text nor stack (the caller logs
 * the original error in the field `error`).
 */
function toHttpError(
  error: unknown,
  notFound: NotFoundCode = 'AGENT_NOT_FOUND',
): HttpException {
  if (error instanceof HttpException) return error;
  const code = codeOf(error, notFound);
  return code === undefined
    ? new InternalServerErrorException()
    : httpError(code);
}

/** Identifiers of one command for its log record (logging.md); never a text of the employee. */
export type CommandFields = {
  readonly ownerId: string;
  readonly threadId?: string;
  readonly agentId?: string;
  readonly decisionId?: string;
};

/** One API command: its route, ids, the work, and the outcome fields read from the result. */
export type Command<T> = {
  readonly route: string;
  readonly fields: CommandFields;
  readonly work: () => Promise<T>;
  readonly outcomeOf?: (result: T) => Record<string, unknown>;
};

/**
 * Runs a command and writes its one log record (design-chat.md, Constraints): route, ids, outcome and
 * `durationMs`; an expected refusal is `info` with its `errorCode`, a server failure is `error` with
 * the original error in `error`. Errors leave as the `HttpException` of {@link toHttpError}.
 */
export async function runCommand<T>(
  logger: Logger,
  { route, fields, work, outcomeOf }: Command<T>,
  notFound: NotFoundCode = 'AGENT_NOT_FOUND',
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await work();
    logger.info('api command answered', {
      route,
      ...fields,
      outcome: 'ok',
      ...outcomeOf?.(result),
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    const answer = toHttpError(error, notFound);
    const status = answer.getStatus();
    if (status >= 500) {
      logger.error('api command failed', {
        route,
        ...fields,
        outcome: 'error',
        status,
        durationMs: Date.now() - startedAt,
        error,
      });
    } else {
      const body = answer.getResponse();
      logger.info('api command refused', {
        route,
        ...fields,
        outcome: 'refused',
        status,
        errorCode:
          typeof body === 'object' && 'errorCode' in body ? body.errorCode : undefined,
        durationMs: Date.now() - startedAt,
      });
    }
    throw answer;
  }
}
