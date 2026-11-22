import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Executor } from '../database';
import { agentMcpAccounts } from '../schema';

/** A row of `agent_mcp_accounts`: an employee's own credentials on a server. */
export type McpAccountRow = typeof agentMcpAccounts.$inferSelect;

/** Tokens as the authorization server issued them; stored as is. */
export interface McpTokens {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
}

/** An account a connection writes. */
export interface NewMcpAccount extends McpTokens {
  readonly ownerId: string;
  readonly server: string;
}

function accountKey(server: string, ownerId: string) {
  return and(eq(agentMcpAccounts.server, server), eq(agentMcpAccounts.ownerId, ownerId));
}

/**
 * Drizzle queries of `agent_mcp_accounts` (repository over a transaction, ADR-0014): tokens are read by
 * the pair "server — owner" only. No method opens a transaction or calls out of the process.
 */
@Injectable()
export class AgentMcpAccountsRepository {
  async find(
    executor: Executor,
    server: string,
    ownerId: string,
  ): Promise<McpAccountRow | undefined> {
    const [row] = await executor.select().from(agentMcpAccounts).where(accountKey(server, ownerId));
    return row;
  }

  /** The employee's accounts by server: the second of the two queries of a tool set. */
  listOwned(executor: Executor, ownerId: string): Promise<McpAccountRow[]> {
    return executor
      .select()
      .from(agentMcpAccounts)
      .where(eq(agentMcpAccounts.ownerId, ownerId))
      .orderBy(asc(agentMcpAccounts.server));
  }

  /** Saves a fresh connection; a reconnection replaces the tokens. */
  async upsert(executor: Executor, account: NewMcpAccount): Promise<void> {
    const connected = {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    };
    await executor
      .insert(agentMcpAccounts)
      .values({ ownerId: account.ownerId, server: account.server, ...connected })
      .onConflictDoUpdate({
        target: [agentMcpAccounts.ownerId, agentMcpAccounts.server],
        set: connected,
      });
  }

  /** Writes refreshed tokens; `false` when the account is gone (disconnected meanwhile). */
  async updateTokens(
    executor: Executor,
    server: string,
    ownerId: string,
    tokens: McpTokens,
  ): Promise<boolean> {
    const rows = await executor
      .update(agentMcpAccounts)
      .set(tokens)
      .where(accountKey(server, ownerId))
      .returning({ server: agentMcpAccounts.server });
    return rows.length > 0;
  }

  /** Removes the account; `false` when there was none. */
  async delete(executor: Executor, server: string, ownerId: string): Promise<boolean> {
    const rows = await executor
      .delete(agentMcpAccounts)
      .where(accountKey(server, ownerId))
      .returning({ server: agentMcpAccounts.server });
    return rows.length > 0;
  }
}
