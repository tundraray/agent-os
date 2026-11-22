import {
  McpErrorCode,
  type McpConnection,
  type McpServerSummary,
  type McpServerView,
  type UpdateMcpServerBody,
} from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';

import type { ConnectTarget } from './connect-requests';
import {
  McpAccounts,
  type McpConnectBegin,
  type McpConnectReturn,
  type McpConnectStart,
  type UsableMcpServer,
} from './mcp-accounts';
import { McpError } from './mcp-errors';
import {
  McpRegistry,
  type McpServerRegistration,
  type McpServerRemoval,
  type McpServerWrite,
  type McpToolsRefresh,
  credentialsCheckFailed,
  notFound,
} from './mcp-registry';

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
@Injectable()
export class AgentsMcp {
  constructor(
    @Inject(McpRegistry) private readonly registry: McpRegistry,
    @Inject(McpAccounts) private readonly accounts: McpAccounts,
  ) {}

  list(): Promise<McpServerSummary[]> {
    return this.registry.list();
  }

  get(name: string): Promise<McpServerView> {
    return this.registry.get(name);
  }

  register(input: McpServerRegistration): Promise<McpServerWrite> {
    return this.registry.register(input);
  }

  update(name: string, patch: UpdateMcpServerBody): Promise<McpServerWrite> {
    return this.registry.update(name, patch);
  }

  /**
   * Reads the server's tool list anew: with the shared token, or with the account of the admin `actorId`
   * on an `oauth` server — without one, `MCP_ACCOUNT_REQUIRED`.
   */
  async refreshTools(name: string, actorId: string): Promise<McpToolsRefresh> {
    const credentials = await this.accounts.credentialsFor(name, actorId, 'admin');
    if (credentials.kind === 'server_gone') throw notFound(name);
    if (credentials.kind === 'auth_required') {
      throw new McpError(
        McpErrorCode.MCP_ACCOUNT_REQUIRED,
        `MCP server ${name} needs the account of the current admin to read its tools`,
      );
    }
    if (credentials.kind === 'failure') throw credentialsCheckFailed(credentials.reason);
    try {
      return await this.registry.refreshTools(name, credentials.auth);
    } catch (error) {
      if (isRejectedToken(error)) await credentials.rejected();
      throw error;
    }
  }

  remove(name: string): Promise<McpServerRemoval> {
    return this.registry.remove(name);
  }

  connections(ownerId: string): Promise<McpConnection[]> {
    return this.accounts.connections(ownerId);
  }

  /** Names of the enabled servers of any mode the employee may use, by name; none for a disabled employee. */
  usable(ownerId: string): Promise<string[]> {
    return this.accounts.usable(ownerId);
  }

  /**
   * The servers of `usable` with the names of the tools `AccessGate.tools` allows the employee: a server
   * without an allowed tool is not among them; none for a disabled employee (deep-agents KD-3, DC-7).
   */
  usableTools(ownerId: string): Promise<UsableMcpServer[]> {
    return this.accounts.usableTools(ownerId);
  }

  beginConnect(input: McpConnectBegin): Promise<McpConnectStart> {
    return this.accounts.begin(input);
  }

  /** Stores the account; an admin's account on a server waiting for its list also fills the list (Flow 1). */
  async finishConnect(input: McpConnectReturn): Promise<McpConnectResult> {
    const finished = await this.accounts.finish(input);
    const { request } = finished;
    if (finished.outcome === 'connected' && request?.target === 'admin') {
      return this.completeAdminAccount(request.server, input.ownerId);
    }
    return { outcome: finished.outcome, server: request?.server ?? null, target: request?.target ?? null };
  }

  disconnect(ownerId: string, server: string): Promise<void> {
    return this.accounts.disconnect(ownerId, server);
  }

  /**
   * The admin's fresh account reads the list of a waiting server and switches it on; a server removed
   * meanwhile ends the connection `connect_failed`.
   */
  private async completeAdminAccount(server: string, adminId: string): Promise<McpConnectResult> {
    const ended = { server, target: 'admin' as const };
    const credentials = await this.accounts.credentialsFor(server, adminId, 'admin');
    if (credentials.kind === 'server_gone') return { ...ended, outcome: 'connect_failed' };
    if (credentials.kind !== 'ready') return { ...ended, outcome: 'tools_failed' };
    const token = await credentials.auth.token();
    if (token === undefined) return { ...ended, outcome: 'tools_failed' };
    const completion = await this.registry.completeAdminAccount(server, token);
    return completion.outcome === 'connected'
      ? { ...ended, outcome: 'connected', change: completion.change }
      : { ...ended, outcome: completion.outcome };
  }
}

/** The token was refused even after a refresh: the account it came from is lost (KD-5). */
function isRejectedToken(error: unknown): boolean {
  return (
    error instanceof McpError && error.code === McpErrorCode.MCP_SERVER_CHECK_FAILED && error.reason === 'unauthorized'
  );
}
