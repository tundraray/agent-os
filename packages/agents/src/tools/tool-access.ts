import type { McpAccessTable } from '../config.js';

/** Row id of `MCP_ACCESS_TABLE` whose servers every employee has. */
const EVERY_EMPLOYEE = '*';

/**
 * The one access check of MCP servers (KD-5): asked both when the tool list of a session is built
 * and on every call. A server is allowed when it is in the owner's row of `MCP_ACCESS_TABLE` or in
 * the `*` row, which gives servers to every employee.
 */
export function serverAllowed(
  access: McpAccessTable,
  ownerId: string,
  serverId: string,
): boolean {
  return [ownerId, EVERY_EMPLOYEE].some((rowId) => access.get(rowId)?.has(serverId) ?? false);
}
