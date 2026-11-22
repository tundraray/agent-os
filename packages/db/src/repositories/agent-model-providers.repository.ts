import { Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Executor, Transaction } from '../database';
import { agentModelProviders } from '../schema';

/** A row of `agent_model_providers`; `apiKey` is the key as stored. */
export type ModelProviderRow = typeof agentModelProviders.$inferSelect;

/** What creation writes; `enabled` and the times take their defaults. */
export type NewModelProviderRow = Pick<ModelProviderRow, 'name' | 'kind' | 'baseUrl' | 'apiKey'>;

/** What may change after creation: name and kind never do. */
export type ModelProviderPatch = Partial<Pick<ModelProviderRow, 'baseUrl' | 'apiKey' | 'enabled'>>;

/** The provider rows before and after a write: the audit record is built from them. */
export interface ModelProviderChange {
  readonly before: ModelProviderRow;
  readonly after: ModelProviderRow;
}

/**
 * Drizzle queries of `agent_model_providers` (repository over a transaction, ADR-0019): the registry is
 * read from the database on every use, without a cache (KD-1). No method opens a transaction or calls out
 * of the process.
 */
@Injectable()
export class AgentModelProvidersRepository {
  async find(executor: Executor, name: string): Promise<ModelProviderRow | undefined> {
    const [row] = await executor
      .select()
      .from(agentModelProviders)
      .where(eq(agentModelProviders.name, name));
    return row;
  }

  /** The registered providers among the names, in one query. */
  async findMany(executor: Executor, names: readonly string[]): Promise<ModelProviderRow[]> {
    if (names.length === 0) return [];
    return executor
      .select()
      .from(agentModelProviders)
      .where(inArray(agentModelProviders.name, [...names]));
  }

  /** All providers by name. */
  list(executor: Executor): Promise<ModelProviderRow[]> {
    return executor.select().from(agentModelProviders).orderBy(asc(agentModelProviders.name));
  }

  /** Creates the provider; `undefined` when the name is taken (its primary key). */
  async insert(
    executor: Executor,
    provider: NewModelProviderRow,
  ): Promise<ModelProviderRow | undefined> {
    const [row] = await executor
      .insert(agentModelProviders)
      .values(provider)
      .onConflictDoNothing()
      .returning();
    return row;
  }

  /** Locks the provider row and writes the patch; `undefined` when the provider is not registered. */
  async update(
    tx: Transaction,
    name: string,
    patch: ModelProviderPatch,
  ): Promise<ModelProviderChange | undefined> {
    const [before] = await tx
      .select()
      .from(agentModelProviders)
      .where(eq(agentModelProviders.name, name))
      .for('update');
    if (before === undefined) return undefined;
    const [after] = await tx
      .update(agentModelProviders)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(agentModelProviders.name, name))
      .returning();
    if (after === undefined) throw new Error(`Model provider ${name} vanished under its row lock`);
    return { before, after };
  }

  /** Removes the provider; returns the removed row. */
  async delete(executor: Executor, name: string): Promise<ModelProviderRow | undefined> {
    const [row] = await executor
      .delete(agentModelProviders)
      .where(eq(agentModelProviders.name, name))
      .returning();
    return row;
  }
}
