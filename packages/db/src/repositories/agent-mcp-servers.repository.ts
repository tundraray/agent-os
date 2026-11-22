import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Executor, Transaction } from '../database';
import { agentMcpServers } from '../schema';

/** A row of `agent_mcp_servers`; `tools` is read back by the registry, which owns its shape. */
export type McpServerRow = typeof agentMcpServers.$inferSelect;

/** What registration writes; `enabled`, `tools` and the times take their defaults when left out. */
export type NewMcpServerRow = Omit<typeof agentMcpServers.$inferInsert, 'createdAt' | 'updatedAt'>;

/** What may change after registration: name, address and mode never do. */
export type McpServerPatch = Partial<Pick<McpServerRow, 'enabled' | 'tools' | 'sharedToken'>>;

/** The server rows before and after a write: the audit record is built from them. */
export interface McpServerChange {
  readonly before: McpServerRow;
  readonly after: McpServerRow;
}

/**
 * Drizzle queries of `agent_mcp_servers` (repository over a transaction, ADR-0014): the registry is read
 * from the database on every use (KD-2). No method opens a transaction or calls out of the process.
 */
@Injectable()
export class AgentMcpServersRepository {
  async find(executor: Executor, name: string): Promise<McpServerRow | undefined> {
    const [row] = await executor
      .select()
      .from(agentMcpServers)
      .where(eq(agentMcpServers.name, name));
    return row;
  }

  /** The registered servers among the names, in one query. */
  async findMany(executor: Executor, names: readonly string[]): Promise<McpServerRow[]> {
    if (names.length === 0) return [];
    return executor.select().from(agentMcpServers).where(inArray(agentMcpServers.name, [...names]));
  }

  /** All registry servers by name. */
  list(executor: Executor): Promise<McpServerRow[]> {
    return executor.select().from(agentMcpServers).orderBy(asc(agentMcpServers.name));
  }

  /**
   * Enabled servers among the definition's names (`*` — all enabled), by name; an enabled server
   * always has its tool list (Invariant 2). The first of the two queries of a tool set.
   */
  async enabledWithTools(
    executor: Executor,
    names: readonly string[] | '*',
  ): Promise<McpServerRow[]> {
    if (names !== '*' && names.length === 0) return [];
    const enabled = eq(agentMcpServers.enabled, true);
    return executor
      .select()
      .from(agentMcpServers)
      .where(names === '*' ? enabled : and(enabled, inArray(agentMcpServers.name, [...names])))
      .orderBy(asc(agentMcpServers.name));
  }

  /** Registers the server; `undefined` when the name is taken. */
  async insert(executor: Executor, server: NewMcpServerRow): Promise<McpServerRow | undefined> {
    const [row] = await executor
      .insert(agentMcpServers)
      .values(server)
      .onConflictDoNothing()
      .returning();
    return row;
  }

  /** Locks the server row and writes the patch; `undefined` when the server is not registered. */
  async update(
    tx: Transaction,
    name: string,
    patch: McpServerPatch,
  ): Promise<McpServerChange | undefined> {
    const [before] = await tx
      .select()
      .from(agentMcpServers)
      .where(eq(agentMcpServers.name, name))
      .for('update');
    if (before === undefined) return undefined;
    const [after] = await tx
      .update(agentMcpServers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentMcpServers.name, name))
      .returning();
    if (after === undefined) throw new Error(`MCP server ${name} vanished under its row lock`);
    return { before, after };
  }

  /** Removes the server, and with it every account on it (cascade, AC-13.6); returns the removed row. */
  async delete(executor: Executor, name: string): Promise<McpServerRow | undefined> {
    const [row] = await executor
      .delete(agentMcpServers)
      .where(eq(agentMcpServers.name, name))
      .returning();
    return row;
  }
}
