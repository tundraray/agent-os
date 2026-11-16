import type { McpCheckFailureReason, McpErrorCode } from '@agent-os/contracts';

/**
 * Codes of an `McpError`: those of the mcp-connect part, and `VALIDATION_FAILED` for a request the body
 * schema cannot refuse alone (a shared token for an `oauth` server) — the controller answers it with 400.
 */
export type McpRefusalCode = McpErrorCode | 'VALIDATION_FAILED';

/**
 * An expected refusal of a registry or connection operation (design-mcp-connect.md, Error handling); the
 * controller maps `code` to its status and passes `reason` of a failed server check to the body.
 */
export class McpError extends Error {
  override readonly name = 'McpError';

  constructor(
    readonly code: McpRefusalCode,
    message: string,
    readonly reason?: McpCheckFailureReason,
  ) {
    super(message);
  }
}
