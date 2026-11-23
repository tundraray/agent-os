import { and, asc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import { mcpAccounts } from '../schema';

/** A row of `mcp_accounts`: an employee's own credentials on a server. */
export type McpAccountRow = typeof mcpAccounts.$inferSelect;

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
  return and(eq(mcpAccounts.server, server), eq(mcpAccounts.ownerId, ownerId));
}

/**
 * Drizzle queries of `mcp_accounts` (ADR-0014): tokens are read by
 * the pair "server — owner" only. No method opens a transaction or calls out of the process.
 */
export class McpAccountsRepository {
  constructor(private readonly db: Db) {}

  async find(
    server: string,
    ownerId: string,
  ): Promise<McpAccountRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(mcpAccounts)
      .where(accountKey(server, ownerId));
    return row;
  }

  /** The employee's accounts by server: the second of the two queries of a tool set. */
  listOwned(ownerId: string): Promise<McpAccountRow[]> {
    return this.db.client
      .select()
      .from(mcpAccounts)
      .where(eq(mcpAccounts.ownerId, ownerId))
      .orderBy(asc(mcpAccounts.server));
  }

  /** Saves a fresh connection; a reconnection replaces the tokens. */
  async upsert(account: NewMcpAccount): Promise<void> {
    const connected = {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    };
    await this.db.client
      .insert(mcpAccounts)
      .values({
        ownerId: account.ownerId,
        server: account.server,
        ...connected,
      })
      .onConflictDoUpdate({
        target: [mcpAccounts.ownerId, mcpAccounts.server],
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
      .update(mcpAccounts)
      .set(tokens)
      .where(accountKey(server, ownerId))
      .returning({ server: mcpAccounts.server });
    return rows.length > 0;
  }

  /** Removes the account; `false` when there was none. */
  async delete(server: string, ownerId: string): Promise<boolean> {
    const rows = await this.db.client
      .delete(mcpAccounts)
      .where(accountKey(server, ownerId))
      .returning({ server: mcpAccounts.server });
    return rows.length > 0;
  }
}
