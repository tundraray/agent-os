import { McpError, type McpRefusalCode } from '@agent-os/agents';
import { apiError } from '../common/api-error.js';

/** HTTP status of each refusal of `Agents.mcp` (design-mcp-connect.md, Error handling). */
const STATUS_OF: Record<McpRefusalCode, number> = {
  MCP_SERVER_NOT_FOUND: 404,
  MCP_SERVER_NAME_TAKEN: 409,
  MCP_SERVER_CHECK_FAILED: 422,
  MCP_SERVER_INCOMPLETE: 409,
  MCP_ACCOUNT_REQUIRED: 409,
  // A shared token sent for an `oauth` server: a body the schema alone cannot refuse.
  VALIDATION_FAILED: 400,
};

/**
 * Runs an `Agents.mcp` operation and answers its `McpError` with its status, body `ApiErrorSchema`; a
 * failed server check carries its `reason`. Any other error leaves as it came.
 */
export async function mcpAnswer<T>(operation: Promise<T>): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    if (!(error instanceof McpError)) throw error;
    throw apiError(
      STATUS_OF[error.code],
      error.code,
      error.message,
      error.reason,
    );
  }
}
