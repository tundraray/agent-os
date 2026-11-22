import { STATUS_CODES } from 'node:http';
import { HttpException, InternalServerErrorException } from '@nestjs/common';
import { AgentsError, type StartRefusalDetail } from '@agent-os/agents';
import type { StartRefusedError, ThreadsErrorCode } from '@agent-os/contracts';
import { RuntimeError } from '@agent-os/runtime';
import { apiError } from '../common/api-error';
import type { RouteCall, RouteStyle } from '../common/logged-route';

/**
 * The not-found codes a route answers with; a runtime `TASK_NOT_FOUND` and an agents `AGENT_NOT_FOUND`
 * become the route's own one.
 */
export type NotFoundCode = Extract<
  ThreadsErrorCode,
  | 'THREAD_NOT_FOUND'
  | 'AGENT_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'DECISION_NOT_FOUND'
>;

/**
 * One constant message per code: a missing and another owner's object answer with the same body
 * (NFR-06, plan rule 11), and no text of the original error reaches the client.
 */
const ANSWERS: Record<ThreadsErrorCode, { status: number; message: string }> = {
  THREAD_NOT_FOUND: { status: 404, message: 'Thread not found' },
  AGENT_NOT_FOUND: { status: 404, message: 'Agent not found' },
  RUN_NOT_FOUND: { status: 404, message: 'Run not found' },
  DECISION_NOT_FOUND: { status: 404, message: 'Decision not found' },
  VALIDATION_FAILED: { status: 400, message: 'Validation failed' },
  INVALID_CURSOR: { status: 400, message: 'Invalid cursor' },
  INVALID_ARGUMENTS: { status: 400, message: 'Invalid arguments' },
  NOT_FINISHED: { status: 409, message: 'Agent is not finished' },
  PARENT_FINISHED: { status: 409, message: 'Parent agent is finished' },
  START_REFUSED: { status: 409, message: 'Start refused' },
};

/** The HTTP answer of one API error code, body `ApiErrorSchema`. */
export function httpError(code: ThreadsErrorCode): HttpException {
  const { status, message } = ANSWERS[code];
  return apiError(status, code, message);
}

/**
 * 409 START_REFUSED of the first message and of a restart (design-runtime.md, Error handling): the
 * reason — a model refusal, `model_not_configured` or a provider refusal (`provider_missing`,
 * `provider_disabled`, `provider_key_missing`) — and the refused model, `null` on
 * `record_unavailable` and `model_not_configured`.
 */
function startRefused(refusal: StartRefusalDetail): HttpException {
  const { status, message } = ANSWERS.START_REFUSED;
  const body = {
    statusCode: status,
    error: STATUS_CODES[status],
    errorCode: 'START_REFUSED',
    message,
    reason: refusal.reason,
    model: refusal.model,
  } satisfies StartRefusedError;
  return new HttpException(body, status);
}

/** 404 THREAD_NOT_FOUND: missing, foreign and deleted threads stay indistinguishable to the client. */
export const threadNotFound = (): HttpException =>
  httpError('THREAD_NOT_FOUND');

/** The code of an expected refusal of a package, or `undefined` for anything else. */
function codeOf(
  error: unknown,
  notFound: NotFoundCode,
): ThreadsErrorCode | undefined {
  if (error instanceof AgentsError) {
    switch (error.code) {
      // A tree deleted mid-read of a conversation is the conversation missing (Flow 6).
      case 'AGENT_NOT_FOUND':
        return notFound;
      case 'NOT_FINISHED':
      case 'INVALID_ARGUMENTS':
      case 'RUN_NOT_FOUND':
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
  return undefined;
}

/**
 * Translates any error of a command into its HTTP answer: an `HttpException` (validation, cursor, the
 * service's own codes) as is, a refused start into 409 START_REFUSED with its reason and model, an
 * expected refusal of `agents` or `runtime` into its code with a constant message, anything else into a
 * bare 500 with neither text nor stack (the caller logs the original error in the field `error`).
 */
function toHttpError(error: unknown, notFound: NotFoundCode): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof AgentsError && error.code === 'START_REFUSED' && error.refusal !== null) {
    return startRefused(error.refusal);
  }
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
  /** The record chip of a message. */
  readonly recordId?: string;
};

/** One API command: its route, ids, the work, and the outcome fields read from the result. */
export type Command<T> = RouteCall<T> & { readonly fields: CommandFields };

/**
 * How the chat's routes log and answer (design-chat.md, Constraints): one `api command …` record per
 * command, and every error leaves as the `HttpException` of {@link toHttpError}.
 */
export function chatRoute(notFound: NotFoundCode = 'AGENT_NOT_FOUND'): RouteStyle {
  return {
    subject: 'api command',
    toHttpError: (error) => toHttpError(error, notFound),
  };
}
