import {
  McpErrorCode,
  type McpConnection,
  type McpServerSummary,
  type McpServerView,
  type UpdateMcpServerBody,
} from '@agent-os/contracts';

import type { ConnectTarget } from './connect-requests.js';
import type { McpAccounts, McpConnectBegin, McpConnectReturn, McpConnectStart } from './mcp-accounts.js';
import { McpError } from './mcp-errors.js';
import {
  type McpRegistry,
  type McpServerRegistration,
  type McpServerRemoval,
  type McpServerWrite,
  type McpToolsRefresh,
  credentialsCheckFailed,
  notFound,
} from './mcp-registry.js';

/** How a return from the authorization server ended for the controller and the audit. */
export interface McpConnectResult {
  readonly outcome: 'connected' | 'tools_failed' | 'connect_failed' | 'access_denied';
  /** `null` when no connection request matched the return. */
  readonly server: string | null;
  readonly target: ConnectTarget | null;
  /** The admin's account filled the tool list: «было/стало» for `admin_change`. */
  readonly change?: McpToolsRefresh;
}

/**
 * The MCP operations of the package for `apps/api` (ADR-0014, Contract «Пакет `agents`»): the admin's
 * registry and the employees' connections. A registry write returns «было/стало» without secret values; the
 * application writes the audit after it.
 */
export interface AgentsMcp {
  list(): Promise<McpServerSummary[]>;
  get(name: string): Promise<McpServerView>;
  register(input: McpServerRegistration): Promise<McpServerWrite>;
  update(name: string, patch: UpdateMcpServerBody): Promise<McpServerWrite>;
  /**
   * Reads the server's tool list anew: with the shared token, or with the account of the admin `actorId`
   * on an `oauth` server — without one, `MCP_ACCOUNT_REQUIRED`.
   */
  refreshTools(name: string, actorId: string): Promise<McpToolsRefresh>;
  remove(name: string): Promise<McpServerRemoval>;
  connections(ownerId: string): Promise<McpConnection[]>;
  /** Names of the enabled servers of any mode the employee may use, by name; none for a disabled employee. */
  usable(ownerId: string): Promise<string[]>;
  beginConnect(input: McpConnectBegin): Promise<McpConnectStart>;
  /** Stores the account; an admin's account on a server waiting for its list also fills the list (Flow 1). */
  finishConnect(input: McpConnectReturn): Promise<McpConnectResult>;
  disconnect(ownerId: string, server: string): Promise<void>;
}

/** The token was refused even after a refresh: the account it came from is lost (KD-5). */
function isRejectedToken(error: unknown): boolean {
  return (
    error instanceof McpError && error.code === McpErrorCode.MCP_SERVER_CHECK_FAILED && error.reason === 'unauthorized'
  );
}

export function createAgentsMcp(registry: McpRegistry, accounts: McpAccounts): AgentsMcp {
  async function refreshTools(name: string, actorId: string): Promise<McpToolsRefresh> {
    const credentials = await accounts.credentialsFor(name, actorId, 'admin');
    if (credentials.kind === 'server_gone') throw notFound(name);
    if (credentials.kind === 'auth_required') {
      throw new McpError(
        McpErrorCode.MCP_ACCOUNT_REQUIRED,
        `MCP server ${name} needs the account of the current admin to read its tools`,
      );
    }
    if (credentials.kind === 'failure') throw credentialsCheckFailed(credentials.reason);
    try {
      return await registry.refreshTools(name, credentials.auth);
    } catch (error) {
      if (isRejectedToken(error)) await credentials.rejected();
      throw error;
    }
  }

  /**
   * The admin's fresh account reads the list of a waiting server and switches it on; a server removed
   * meanwhile ends the connection `connect_failed`.
   */
  async function completeAdminAccount(server: string, adminId: string): Promise<McpConnectResult> {
    const ended = { server, target: 'admin' as const };
    const credentials = await accounts.credentialsFor(server, adminId, 'admin');
    if (credentials.kind === 'server_gone') return { ...ended, outcome: 'connect_failed' };
    if (credentials.kind !== 'ready') return { ...ended, outcome: 'tools_failed' };
    const token = await credentials.auth.token();
    if (token === undefined) return { ...ended, outcome: 'tools_failed' };
    const completion = await registry.completeAdminAccount(server, token);
    return completion.outcome === 'connected'
      ? { ...ended, outcome: 'connected', change: completion.change }
      : { ...ended, outcome: completion.outcome };
  }

  return {
    list: () => registry.list(),
    get: (name) => registry.get(name),
    register: (input) => registry.register(input),
    update: (name, patch) => registry.update(name, patch),
    refreshTools,
    remove: (name) => registry.remove(name),
    connections: (ownerId) => accounts.connections(ownerId),
    usable: (ownerId) => accounts.usable(ownerId),
    beginConnect: (input) => accounts.begin(input),
    async finishConnect(input) {
      const finished = await accounts.finish(input);
      const { request } = finished;
      if (finished.outcome === 'connected' && request?.target === 'admin') {
        return completeAdminAccount(request.server, input.ownerId);
      }
      return { outcome: finished.outcome, server: request?.server ?? null, target: request?.target ?? null };
    },
    disconnect: (ownerId, server) => accounts.disconnect(ownerId, server),
  };
}
