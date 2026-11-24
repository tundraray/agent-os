import { modelProvider } from '@agent-os/contracts';
import { asc, count, eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { models } from '../schema';

/** A row of `models`; the api reads it into a catalogue model by its purpose. */
export type ModelRow = typeof models.$inferSelect;

/** The columns a write sets, all but the id, its provider and the times. */
export type ModelColumns = Omit<
  typeof models.$inferInsert,
  'id' | 'provider' | 'createdAt' | 'updatedAt'
>;

/**
 * Drizzle queries of `models`.
 */
export class ModelsRepository {
  constructor(private readonly db: Db) {}

  async find(id: string): Promise<ModelRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(models)
      .where(eq(models.id, id));
    return row;
  }

  /** The catalogue by name, then id. */
  list(): Promise<ModelRow[]> {
    return this.db.client
      .select()
      .from(models)
      .orderBy(asc(models.name), asc(models.id));
  }

  /** How many catalogue models the provider has (`MODEL_PROVIDER_HAS_MODELS`). */
  async countByProvider(provider: string): Promise<number> {
    const [row] = await this.db.client
      .select({ models: count() })
      .from(models)
      .where(eq(models.provider, provider));
    return row?.models ?? 0;
  }

  /** Adds the model with its provider, the first part of its id; `undefined` when the id is taken. */
  async insert(
    id: string,
    columns: ModelColumns,
  ): Promise<ModelRow | undefined> {
    const [row] = await this.db.client
      .insert(models)
      .values({ id, provider: modelProvider(id), ...columns })
      .onConflictDoNothing({ target: models.id })
      .returning();
    return row;
  }

  /** Writes the model's columns (the id stays); returns the stored row. */
  async update(id: string, columns: ModelColumns): Promise<ModelRow> {
    const [row] = await this.db.client
      .update(models)
      .set({ ...columns, updatedAt: sql`now()` })
      .where(eq(models.id, id))
      .returning();
    if (row === undefined) throw new Error('models update returned no row');
    return row;
  }

  /** Deletes the model (its grants go by cascade); the deleted row, or `undefined` for a missing one. */
  async delete(id: string): Promise<ModelRow | undefined> {
    const [row] = await this.db.client
      .delete(models)
      .where(eq(models.id, id))
      .returning();
    return row;
  }
}
