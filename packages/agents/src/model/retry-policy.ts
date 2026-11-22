import type { Clock } from '@agent-os/runtime';

import type { ProviderAdapter } from '../providers/adapters';

/** A provider error (408, 429, 5xx, network) is retried this many times (KD-6). */
export const PROVIDER_RETRIES = 2;
/** Delay before the n-th provider retry, through the runtime `Clock`. */
const PROVIDER_RETRY_DELAYS_MS = [1_000, 3_000] as const;

export function providerRetryDelayMs(retry: number): number {
  return PROVIDER_RETRY_DELAYS_MS[
    Math.min(retry, PROVIDER_RETRY_DELAYS_MS.length) - 1
  ];
}

/**
 * The named reason of a provider rejection (design-core.md, «Как разбирается ошибка провайдера»).
 * `provider_error` is any other status: the chat reports it as `model_error`, the embeddings as it is.
 */
export type ProviderRejectionReason =
  | 'provider_key_rejected'
  | 'provider_tools_rejected'
  | 'provider_unavailable'
  | 'provider_error';

/** A rejected request that is a provider error: its status (null — network error or timeout), retry and reason. */
export interface ProviderError {
  readonly statusCode: number | null;
  readonly retryable: boolean;
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
  adapter: Pick<ProviderAdapter, 'toolsRejected'>,
): { readonly retryable: boolean; readonly reason: ProviderRejectionReason } {
  if (KEY_REJECTED_STATUSES.has(statusCode))
    return { retryable: false, reason: 'provider_key_rejected' };
  if (adapter.toolsRejected(statusCode, body))
    return { retryable: false, reason: 'provider_tools_rejected' };
  if (
    statusCode === REQUEST_TIMEOUT ||
    statusCode === TOO_MANY_REQUESTS ||
    statusCode >= SERVER_ERROR_MIN
  ) {
    return { retryable: true, reason: 'provider_unavailable' };
  }
  return { retryable: false, reason: 'provider_error' };
}

/**
 * Reads a rejection by the error's fields — `name` `AI_APICallError`, its `statusCode` and `responseBody` —
 * without importing `ai`; the «tools not accepted» marker is the adapter's of the provider's kind. An error
 * without a status (a network failure, a request timeout) is `provider_unavailable` and retried. Anything
 * else is not a provider error (null) and is not retried.
 */
export function classifyRejection(
  error: unknown,
  adapter: Pick<ProviderAdapter, 'toolsRejected'>,
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
      retryable: true,
      reason: 'provider_unavailable',
      responseBody: body,
    };
  }
  return {
    statusCode,
    ...reasonOf(statusCode, body ?? '', adapter),
    responseBody: body,
  };
}

/** Waits on the clock; a cancel or stop ends the wait with the signal's reason. */
export function pause(
  clock: Clock,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      cancelTimer();
      reject(signal.reason);
    };
    const cancelTimer = clock.setTimer(ms, () => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
