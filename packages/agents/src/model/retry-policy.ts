/** A provider error (429, 5xx, network) is retried this many times (KD-6). */
export const PROVIDER_RETRIES = 2;
/** Delay before the n-th provider retry, through the runtime `Clock`. */
const PROVIDER_RETRY_DELAYS_MS = [1_000, 3_000] as const;

export function providerRetryDelayMs(retry: number): number {
  return PROVIDER_RETRY_DELAYS_MS[Math.min(retry, PROVIDER_RETRY_DELAYS_MS.length) - 1];
}

/** A rejected `generate` that is a provider error, with its status (null — network error). */
export interface ProviderError {
  readonly statusCode: number | null;
  /** 429, 5xx and network errors are retried; any other status is final. */
  readonly retryable: boolean;
}

const API_CALL_ERROR = 'AI_APICallError';
const TOO_MANY_REQUESTS = 429;
const SERVER_ERROR_MIN = 500;

/**
 * Reads a rejection by the error's fields — `name` `AI_APICallError` and its `statusCode` —
 * without importing `ai`. Anything else is not a provider error (null) and is not retried.
 */
export function classifyRejection(error: unknown): ProviderError | null {
  if (!(error instanceof Error) || error.name !== API_CALL_ERROR) return null;
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  if (typeof statusCode !== 'number') {
    return { statusCode: null, retryable: true };
  }
  return {
    statusCode,
    retryable: statusCode === TOO_MANY_REQUESTS || statusCode >= SERVER_ERROR_MIN,
  };
}
