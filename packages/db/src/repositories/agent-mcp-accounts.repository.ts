import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { Db } from '../db';
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
  return and(
    eq(agentMcpAccounts.server, server),
    eq(agentMcpAccounts.ownerId, ownerId),
  );
}

/**
 * Drizzle queries of `agent_mcp_accounts` (ADR-0014): tokens are read by
 * the pair "server — owner" only. No method opens a transaction or calls out of the process.
 */
@Injectable()
export class AgentMcpAccountsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async find(
    server: string,
    ownerId: string,
  ): Promise<McpAccountRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(agentMcpAccounts)
      .where(accountKey(server, ownerId));
    return row;
  }

  /** The employee's accounts by server: the second of the two queries of a tool set. */
  listOwned(ownerId: string): Promise<McpAccountRow[]> {
    return this.db.client
      .select()
      .from(agentMcpAccounts)
      .where(eq(agentMcpAccounts.ownerId, ownerId))
      .orderBy(asc(agentMcpAccounts.server));
  }

  /** Saves a fresh connection; a reconnection replaces the tokens. */
  async upsert(account: NewMcpAccount): Promise<void> {
    const connected = {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    };
    await this.db.client
      .insert(agentMcpAccounts)
      .values({
        ownerId: account.ownerId,
        server: account.server,
        ...connected,
      })
      .onConflictDoUpdate({
        target: [agentMcpAccounts.ownerId, agentMcpAccounts.server],
        set: connected,
      });
  }

  /** Writes refreshed tokens; `false` when the account is gone (disconnected meanwhile). */
  async updateTokens(
    server: string,
    ownerId: string,
    tokens: McpTokens,
  ): Promise<boolean> {
    const rows = await this.db.client
      .update(agentMcpAccounts)
      .set(tokens)
      .where(accountKey(server, ownerId))
      .returning({ server: agentMcpAccounts.server });
    return rows.length > 0;
  }

  /** Removes the account; `false` when there was none. */
  async delete(server: string, ownerId: string): Promise<boolean> {
    const rows = await this.db.client
      .delete(agentMcpAccounts)
      .where(accountKey(server, ownerId))
      .returning({ server: agentMcpAccounts.server });
    return rows.length > 0;
  }
}
