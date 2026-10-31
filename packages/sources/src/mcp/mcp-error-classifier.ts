import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/client';
import type { ClassificationRow, TransportFailure, TransportFailureCode } from '../source-adapter.js';
import { McpStartupError } from './mcp-startup-error.js';

/** K-3: JSON-RPC codes that mean the request or the configuration is wrong; a retry repeats the failure. */
const MISMATCH_PROTOCOL_CODES: ReadonlySet<number> = new Set([
  -32600, -32601, -32602, -32002, -32021, -32022, -32042,
]);
const INTERNAL_ERROR_CODE = -32603;

const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set([
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.NotConnected,
  SdkErrorCode.SendFailed,
]);
const MISMATCH_SDK_CODES: ReadonlySet<string> = new Set([
  SdkErrorCode.CapabilityNotSupported,
  SdkErrorCode.MethodNotSupportedByProtocolVersion,
  SdkErrorCode.EraNegotiationFailed,
  SdkErrorCode.ClientHttpAuthentication,
  SdkErrorCode.ClientHttpForbidden,
]);
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429]);

function failure(
  cause: ClassificationRow,
  code: TransportFailureCode,
  retry: { retryable: boolean; reconnect?: boolean },
): TransportFailure {
  return {
    kind: 'transport',
    failureClass: 'transport_protocol',
    code,
    retryable: retry.retryable,
    reconnect: retry.reconnect ?? false,
    cause,
  };
}

function classifyProtocolError(error: ProtocolError): TransportFailure {
  if (MISMATCH_PROTOCOL_CODES.has(error.code)) {
    return failure('K-3', 'config_or_protocol_mismatch', { retryable: false });
  }
  const code = error.code === INTERNAL_ERROR_CODE ? 'server_internal_error' : 'protocol_error';
  return failure('K-4', code, { retryable: true });
}

function isRetryableHttpStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_HTTP_STATUSES.has(status);
}

function isClientHttpStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

function classifySdkError(error: SdkError): TransportFailure {
  if (CONNECTION_LOST_CODES.has(error.code)) {
    return failure('K-5', 'connection_lost', { retryable: true, reconnect: true });
  }
  if (error.code === SdkErrorCode.RequestTimeout) {
    return failure('K-6', 'timeout', { retryable: true });
  }
  if (error.code === SdkErrorCode.InvalidResult) {
    return failure('K-7', 'invalid_result', { retryable: true });
  }
  if (error instanceof SdkHttpError && isRetryableHttpStatus(error.status)) {
    return failure('K-8', 'http_status', { retryable: true });
  }
  if (
    MISMATCH_SDK_CODES.has(error.code) ||
    (error instanceof SdkHttpError && isClientHttpStatus(error.status))
  ) {
    return failure('K-9', 'config_or_protocol_mismatch', { retryable: false });
  }
  return failure('K-13', 'unclassified_client_error', { retryable: false });
}

/**
 * Maps an error thrown by the MCP client to a transport outcome, checking the rows of
 * design-mcp-source.md, Error Handling, in order (K-3…K-9, K-13). K-1 and K-2 are decided by the
 * caller before this point; K-10…K-12 are results, not errors. Anything that is not an SDK error
 * nor a tagged startup failure is a defect (K-14) and is rethrown.
 */
export function classifyMcpError(error: unknown): TransportFailure {
  if (error instanceof ProtocolError) {
    return classifyProtocolError(error);
  }
  if (error instanceof SdkError) {
    return classifySdkError(error);
  }
  if (error instanceof McpStartupError) {
    return failure('K-9', 'config_or_protocol_mismatch', { retryable: false });
  }
  throw error;
}
