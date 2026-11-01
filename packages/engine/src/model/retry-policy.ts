import type { z } from 'zod';
import type { RoleGeneration } from './role-agent.js';

/** A provider error (429, 5xx, network) or a failed count is retried this many times (DC-12). */
export const PROVIDER_RETRIES = 2;
/** An output the role schema refuses, or a refusal, is retried this many times. */
export const INVALID_OUTPUT_RETRIES = 1;
/** Delay before the n-th provider retry, through the engine `Clock`. */
const PROVIDER_RETRY_DELAYS_MS = [1_000, 3_000] as const;

export function providerRetryDelayMs(retry: number): number {
  return PROVIDER_RETRY_DELAYS_MS[
    Math.min(retry, PROVIDER_RETRY_DELAYS_MS.length) - 1
  ];
}

/**
 * What a resolved `generate` means for `ModelGateway` (design-engine.md, Error handling), once the
 * gateway has ruled out an interrupted call: `content-filter` is a refusal (`stop_reason`
 * `refusal`); otherwise the output either passes the role schema or is invalid.
 */
export type ResolvedCall<T> =
  | { readonly kind: 'answer'; readonly output: T }
  | { readonly kind: 'invalid_output' }
  | { readonly kind: 'refusal' };

export function classifyResolution<T>(
  generation: RoleGeneration,
  schema: z.ZodType<T>,
): ResolvedCall<T> {
  if (generation.finishReason === 'content-filter') return { kind: 'refusal' };
  const parsed = schema.safeParse(generation.object);
  return parsed.success
    ? { kind: 'answer', output: parsed.data }
    : { kind: 'invalid_output' };
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
    retryable:
      statusCode === TOO_MANY_REQUESTS || statusCode >= SERVER_ERROR_MIN,
  };
}
