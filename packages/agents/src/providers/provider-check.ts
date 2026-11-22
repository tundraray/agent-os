import { createSecretMasker } from '@agent-os/common';
import type { ModelProviderCheck } from '@agent-os/contracts';

import { providerAdapter } from './adapters';
import type { ProviderConnection } from './provider-registry';

/** No answer within this time is «the address is unreachable» (DC-12). */
const CHECK_TIMEOUT_MS = 10_000;

/** The bound of `ModelProviderCheck.message` in `contracts`, which does not export it. */
const MESSAGE_MAX_LENGTH = 500;

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;

export type CheckFetch = (url: string, init: RequestInit) => Promise<Response>;

interface ProviderCheckOptions {
  readonly fetch?: CheckFetch;
  readonly timeoutMs?: number;
}

/** What a provider's non-2xx answer to the check means: the key is refused, or the address does not work. */
function rejectedCheckResult(status: number): ModelProviderCheck['result'] {
  return status === UNAUTHORIZED || status === FORBIDDEN
    ? 'key_rejected'
    : 'unreachable';
}

/** The message of a failed check: masked by the secret memory, cut to the contract's bound. */
function checkMessage(text: string): string {
  return createSecretMasker([])(text).slice(0, MESSAGE_MAX_LENGTH);
}

/**
 * Checks the connection with one request of its kind on the stored address and key (FR-15, AC-15.1): 2xx is
 * `works`, 401 and 403 `key_rejected`; any other status, a network error or no answer in 10 seconds is
 * `unreachable`. It writes neither a ledger row nor an audit entry, and logs nothing — the request headers
 * carry the key; the caller logs the result.
 */
export async function checkProvider(
  connection: ProviderConnection,
  {
    fetch = globalThis.fetch,
    timeoutMs = CHECK_TIMEOUT_MS,
  }: ProviderCheckOptions = {},
): Promise<ModelProviderCheck> {
  const request = providerAdapter(connection.kind).checkRequest(connection);
  try {
    const response = await fetch(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return { result: 'works', message: null };
    const body = await response.text();
    return {
      result: rejectedCheckResult(response.status),
      message: checkMessage(`${response.status} ${body}`),
    };
  } catch (error) {
    return {
      result: 'unreachable',
      message: checkMessage(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}
