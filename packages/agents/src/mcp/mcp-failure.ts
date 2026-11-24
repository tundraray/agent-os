import type { McpServerMode } from '@agent-os/contracts';
import {
  OAuthError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { z } from 'zod';

/** Why an MCP call got no answer from its server; the reason of a `transport_failure` in the history. */
export type McpFailureReason =
  | 'timeout'
  | 'connection_lost'
  | 'protocol_error'
  | 'unauthorized'
  | 'client_error';

/**
 * A call that got no result: the employee has to connect the account (`auth_required`, KD-5), or the
 * transport failed for the reason given.
 */
export type McpFailure =
  | { readonly kind: 'auth_required' }
  | { readonly kind: 'failure'; readonly reason: McpFailureReason };

const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set([
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.NotConnected,
  SdkErrorCode.SendFailed,
]);

/** Codes of a response the client could not use: a non-OK HTTP status, a wrong body or content type. */
const PROTOCOL_ERROR_CODES: ReadonlySet<string> = new Set([
  SdkErrorCode.InvalidResult,
  SdkErrorCode.UnsupportedResultType,
  SdkErrorCode.ClientHttpNotImplemented,
  SdkErrorCode.ClientHttpUnexpectedContent,
  SdkErrorCode.ClientHttpFailedToOpenStream,
]);

/**
 * Messages of the `TypeError` that Node's `fetch` throws when the request itself fails: refused connection,
 * DNS, TLS (`fetch failed`) or a body cut while it is read (`terminated`). The SDK passes them on as is.
 */
const FETCH_FAILURE_MESSAGES: ReadonlySet<string> = new Set([
  'fetch failed',
  'terminated',
]);

/** A 401 that the token could not get past: no refresh hook, or the retry after the refresh got 401 again. */
function isUnauthorized(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (error instanceof SdkError &&
      error.code === SdkErrorCode.ClientHttpAuthentication)
  );
}

/** A timeout of the call or the step's abort that reached the client as the signal's own reason. */
function isAbort(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  );
}

function sdkFailureReason(error: SdkError): McpFailureReason {
  if (CONNECTION_LOST_CODES.has(error.code)) {
    return 'connection_lost';
  }
  if (error.code === SdkErrorCode.RequestTimeout) {
    return 'timeout';
  }
  if (PROTOCOL_ERROR_CODES.has(error.code)) {
    return 'protocol_error';
  }
  return 'client_error';
}

/**
 * An error for the log: its class with the OAuth or SDK code and the HTTP status, never its message — that
 * of the SDK carries the server's response body.
 */
export function failureName(error: unknown): string {
  if (error instanceof SdkHttpError)
    return `${error.name}:${error.code}:${error.status}`;
  if (error instanceof OAuthError || error instanceof SdkError)
    return `${error.name}:${error.code}`;
  return error instanceof Error ? error.name : typeof error;
}

/** Why a request failed in transport, or `undefined` for an error outside the client's and `fetch`'s classes. */
export function transportFailureReason(
  error: unknown,
): McpFailureReason | undefined {
  if (error instanceof SdkError) {
    return sdkFailureReason(error);
  }
  if (error instanceof TypeError && FETCH_FAILURE_MESSAGES.has(error.message)) {
    return 'connection_lost';
  }
  if (isAbort(error)) {
    return 'timeout';
  }
  // An `OAuthError` is the authorization server's own refusal of a token request (other than the
  // `invalid_grant` that loses an account, which `McpAccounts` handles first).
  if (
    error instanceof ProtocolError ||
    error instanceof OAuthError ||
    error instanceof SyntaxError ||
    error instanceof z.core.$ZodError
  ) {
    return 'protocol_error';
  }
  return undefined;
}

/**
 * Maps an error thrown by the MCP client to the outcome of the call (DC-10, KD-5). A rejected token is
 * `auth_required` for personal OAuth — the employee fixes it — and `transport_failure`/`unauthorized` for
 * a shared token — the admin does. Anything outside the client's error classes is a defect and is rethrown.
 */
export function mcpFailureReason(
  error: unknown,
  mode: McpServerMode,
): McpFailure {
  if (isUnauthorized(error)) {
    return mode === 'oauth'
      ? { kind: 'auth_required' }
      : { kind: 'failure', reason: 'unauthorized' };
  }
  const reason = transportFailureReason(error);
  if (reason === undefined) {
    throw error;
  }
  return { kind: 'failure', reason };
}
