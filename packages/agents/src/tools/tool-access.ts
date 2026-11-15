import type { McpAccessTable } from '../config.js';

/**
 * The one access check of MCP servers (KD-5): asked both when the tool list of a session is built
 * and on every call. A server is allowed only when it is in the owner's row of `MCP_ACCESS_TABLE`;
 * an owner without a row has no servers.
 */
export function serverAllowed(
  access: McpAccessTable,
  ownerId: string,
  serverId: string,
): boolean {
  return access.get(ownerId)?.has(serverId) ?? false;
}
