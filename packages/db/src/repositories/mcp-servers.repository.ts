import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import { mcpServers } from '../schema';

/** A row of `mcp_servers`; `tools` is read back by the registry, which owns its shape. */
export type McpServerRow = typeof mcpServers.$inferSelect;

/** What registration writes; `enabled`, `tools` and the times take their defaults when left out. */
export type NewMcpServerRow = Omit<
  typeof mcpServers.$inferInsert,
  'createdAt' | 'updatedAt'
>;

/** What may change after registration: name, address and mode never do. */
export type McpServerPatch = Partial<
  Pick<
    McpServerRow,
    'enabled' | 'tools' | 'sharedToken' | 'toolSettings' | 'newTools'
  >
>;

/** The server rows before and after a write: the audit record is built from them. */
export interface McpServerChange {
  readonly before: McpServerRow;
  readonly after: McpServerRow;
}

/**
 * Drizzle queries of `mcp_servers` (ADR-0014): the registry is read
 * from the database on every use (KD-2). No method opens a transaction or calls out of the process.
 */
export class McpServersRepository {
  constructor(private readonly db: Db) {}

  async find(name: string): Promise<McpServerRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, name));
    return row;
  }

  /**
   * The server's row held until the caller's transaction ends: a second reader of the same server waits and
   * then reads what the first wrote, so a read-then-write of one jsonb column loses no update.
   */
  async findForUpdate(name: string): Promise<McpServerRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, name))
      .for('update');
    return row;
  }

  /** The registered servers among the names, in one query. */
  async findMany(names: readonly string[]): Promise<McpServerRow[]> {
    if (names.length === 0) return [];
    return this.db.client
      .select()
      .from(mcpServers)
      .where(inArray(mcpServers.name, [...names]));
  }

  /** All registry servers by name. */
  list(): Promise<McpServerRow[]> {
    return this.db.client
      .select()
      .from(mcpServers)
      .orderBy(asc(mcpServers.name));
  }

  /**
   * Enabled servers among the definition's names (`*` — all enabled), by name; an enabled server
   * always has its tool list (Invariant 2). The first of the two queries of a tool set.
   */
  async enabledWithTools(
    names: readonly string[] | '*',
  ): Promise<McpServerRow[]> {
    if (names !== '*' && names.length === 0) return [];
    const enabled = eq(mcpServers.enabled, true);
    return this.db.client
      .select()
      .from(mcpServers)
      .where(
        names === '*'
          ? enabled
          : and(enabled, inArray(mcpServers.name, [...names])),
      )
      .orderBy(asc(mcpServers.name));
  }

  /** Registers the server; `undefined` when the name is taken. */
  async insert(server: NewMcpServerRow): Promise<McpServerRow | undefined> {
    const [row] = await this.db.client
      .insert(mcpServers)
      .values(server)
      .onConflictDoNothing()
      .returning();
    return row;
  }

  /** Writes the patch; `undefined` when the server is not registered. */
  async update(
    name: string,
    patch: McpServerPatch,
  ): Promise<McpServerChange | undefined> {
    const [before] = await this.db.client
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, name));
    if (before === undefined) return undefined;
    const [after] = await this.db.client
      .update(mcpServers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(mcpServers.name, name))
      .returning();
    if (after === undefined)
      throw new Error(`MCP server ${name} vanished during its update`);
    return { before, after };
  }

  /** Removes the server, and with it every account on it (cascade, AC-13.6); returns the removed row. */
  async delete(name: string): Promise<McpServerRow | undefined> {
    const [row] = await this.db.client
      .delete(mcpServers)
      .where(eq(mcpServers.name, name))
      .returning();
    return row;
  }
}
