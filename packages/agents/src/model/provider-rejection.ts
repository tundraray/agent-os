import type { ProviderAdapter } from '../providers/adapters';

/**
 * The named reason of a provider rejection (design-core.md, «Как разбирается ошибка провайдера»;
 * runtime-fixes design-steps.md KD-4 for `context_overflow`). `provider_error` is any other status: the chat
 * reports it as `model_error`, the embeddings as it is.
 */
export type ProviderRejectionReason =
  | 'provider_key_rejected'
  | 'context_overflow'
  | 'provider_tools_rejected'
  | 'provider_unavailable'
  | 'provider_error';

/** A rejected request that is a provider error: its status (null — network error or timeout) and reason. */
export interface ProviderError {
  readonly statusCode: number | null;
  readonly reason: ProviderRejectionReason;
  /** The provider's error body as it came, for the log only (AC-04.2); `null` when there is none. */
  readonly responseBody: string | null;
}

const API_CALL_ERROR = 'AI_APICallError';
const REQUEST_TIMEOUT = 408;
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR_MIN = 500;
const KEY_REJECTED_STATUSES: ReadonlySet<number> = new Set([401, 403]);

function reasonOf(
  statusCode: number,
  body: string,
  adapter: Pick<ProviderAdapter, 'contextOverflow' | 'toolsRejected'>,
): ProviderRejectionReason {
  if (KEY_REJECTED_STATUSES.has(statusCode)) return 'provider_key_rejected';
  // Asked before the tools rule: an overflow body may name the tools too.
  if (adapter.contextOverflow(statusCode, body)) return 'context_overflow';
  if (adapter.toolsRejected(statusCode, body)) return 'provider_tools_rejected';
  if (
    statusCode === TOO_MANY_REQUESTS ||
    statusCode === REQUEST_TIMEOUT ||
    statusCode >= SERVER_ERROR_MIN
  )
    return 'provider_unavailable';
  return 'provider_error';
}

/**
 * Reads a rejection by the error's fields — `name` `AI_APICallError`, its `statusCode` and `responseBody` —
 * without importing `ai`; the context overflow and «tools not accepted» markers are the adapter's of the provider's kind. An error
 * without a status (a network failure, a request timeout) is `provider_unavailable`. Anything else is not a
 * provider error (null).
 */
export function classifyRejection(
  error: unknown,
  adapter: Pick<ProviderAdapter, 'contextOverflow' | 'toolsRejected'>,
): ProviderError | null {
  if (!(error instanceof Error) || error.name !== API_CALL_ERROR) return null;
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  const body =
    'responseBody' in error && typeof error.responseBody === 'string'
      ? error.responseBody
      : null;
  if (typeof statusCode !== 'number') {
    return {
      statusCode: null,
      reason: 'provider_unavailable',
      responseBody: body,
    };
  }
  return {
    statusCode,
    reason: reasonOf(statusCode, body ?? '', adapter),
    responseBody: body,
  };
}
