import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';

/** Why an MCP call got no answer from its server; the reason of a `transport_failure` in the history. */
export type McpFailureReason = 'timeout' | 'connection_lost' | 'protocol_error' | 'startup_failed' | 'client_error';

/**
 * A failure of `connect()` of the server process, other than the handshake timeout (that one stays a
 * `RequestTimeout`). Client 2.4.0 rejects a failed spawn with a plain `Error`, which would otherwise read
 * as a defect; the tag makes it `startup_failed`.
 */
export class McpStartupError extends Error {
  override readonly name = 'McpStartupError';

  constructor(cause: unknown) {
    super('MCP server process failed to start', { cause });
  }
}

const CONNECTION_LOST_CODES: ReadonlySet<string> = new Set([
  SdkErrorCode.ConnectionClosed,
  SdkErrorCode.NotConnected,
  SdkErrorCode.SendFailed,
]);

function sdkFailureReason(error: SdkError): McpFailureReason {
  if (CONNECTION_LOST_CODES.has(error.code)) {
    return 'connection_lost';
  }
  if (error.code === SdkErrorCode.RequestTimeout) {
    return 'timeout';
  }
  if (error.code === SdkErrorCode.InvalidResult) {
    return 'protocol_error';
  }
  return 'client_error';
}

/**
 * Maps an error thrown by the MCP client to the reason of a transport failure. Anything that is neither an
 * SDK error nor a tagged startup failure is a defect and is rethrown.
 */
export function mcpFailureReason(error: unknown): McpFailureReason {
  if (error instanceof ProtocolError) {
    return 'protocol_error';
  }
  if (error instanceof SdkError) {
    return sdkFailureReason(error);
  }
  if (error instanceof McpStartupError) {
    return 'startup_failed';
  }
  throw error;
}
