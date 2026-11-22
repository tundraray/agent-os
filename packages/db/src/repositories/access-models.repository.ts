import { Injectable } from '@nestjs/common';
import { asc, count, eq, like, sql } from 'drizzle-orm';
import type { Executor, Transaction } from '../database';
import { accessModelDefaults, accessModels } from '../schema';

/** A row of `access_models`; the api reads it into a catalogue model by its purpose. */
export type AccessModelRow = typeof accessModels.$inferSelect;

/** The columns a write sets, all but the id and the times. */
export type AccessModelColumns = Omit<
  typeof accessModels.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;

const defaultsColumns = {
  chatModel: accessModelDefaults.chatModel,
  embeddingModel: accessModelDefaults.embeddingModel,
  updatedAt: accessModelDefaults.updatedAt,
  updatedBy: accessModelDefaults.updatedBy,
};

/** The single `access_model_defaults` row; a model id is `null` while none is chosen. */
export interface AccessModelDefaultsRow {
  chatModel: string | null;
  embeddingModel: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/**
 * Drizzle queries of `access_models` and the single `access_model_defaults` row (repository over a
 * transaction): each takes the caller's transaction or the plain client first.
 */
@Injectable()
export class AccessModelsRepository {
  async find(executor: Executor, id: string): Promise<AccessModelRow | undefined> {
    const [row] = await executor.select().from(accessModels).where(eq(accessModels.id, id));
    return row;
  }

  /** The catalogue by name, then id. */
  list(executor: Executor): Promise<AccessModelRow[]> {
    return executor.select().from(accessModels).orderBy(asc(accessModels.name), asc(accessModels.id));
  }

  /** How many catalogue models name the provider as the first part of their id (`MODEL_PROVIDER_HAS_MODELS`). */
  async countByProvider(executor: Executor, provider: string): Promise<number> {
    // A provider name holds only `[a-z0-9-]`, so it has no LIKE wildcard to escape.
    const [row] = await executor
      .select({ models: count() })
      .from(accessModels)
      .where(like(accessModels.id, `${provider}/%`));
    return row?.models ?? 0;
  }

  /** Adds the model; `undefined` when the id is taken. */
  async insert(
    executor: Executor,
    id: string,
    columns: AccessModelColumns,
  ): Promise<AccessModelRow | undefined> {
    const [row] = await executor
      .insert(accessModels)
      .values({ id, ...columns })
      .onConflictDoNothing({ target: accessModels.id })
      .returning();
    return row;
  }

  /** The model locked for an update in the caller's transaction; `undefined` for a missing model. */
  async lock(tx: Transaction, id: string): Promise<AccessModelRow | undefined> {
    const [row] = await tx.select().from(accessModels).where(eq(accessModels.id, id)).for('update');
    return row;
  }

  /** Writes the model's columns (the id stays); returns the stored row. */
  async update(executor: Executor, id: string, columns: AccessModelColumns): Promise<AccessModelRow> {
    const [row] = await executor
      .update(accessModels)
      .set({ ...columns, updatedAt: sql`now()` })
      .where(eq(accessModels.id, id))
      .returning();
    if (row === undefined) throw new Error('access_models update returned no row');
    return row;
  }

  /** Deletes the model (its grants go by cascade, a default on it is cleared); the deleted row, or `undefined` for a missing one. */
  async delete(executor: Executor, id: string): Promise<AccessModelRow | undefined> {
    const [row] = await executor.delete(accessModels).where(eq(accessModels.id, id)).returning();
    return row;
  }

  /** The migration creates the row, so its absence is a fault. */
  async readDefaults(executor: Executor): Promise<AccessModelDefaultsRow> {
    const [row] = await executor.select(defaultsColumns).from(accessModelDefaults);
    if (row === undefined) throw new Error('access_model_defaults row is missing');
    return row;
  }

  /** Writes the administrator's choice with who and when; returns the row after it. */
  async writeDefaults(
    executor: Executor,
    models: { chatModel: string | null; embeddingModel: string | null },
    actorId: string,
  ): Promise<AccessModelDefaultsRow> {
    const [row] = await executor
      .update(accessModelDefaults)
      .set({ ...models, updatedAt: new Date(), updatedBy: actorId })
      .returning(defaultsColumns);
    if (row === undefined) throw new Error('access_model_defaults row is missing');
    return row;
  }

  /** The catalogue row of the default embedding model; `undefined` while none is chosen. */
  async findDefaultEmbedding(executor: Executor): Promise<AccessModelRow | undefined> {
    const [row] = await executor
      .select({ model: accessModels })
      .from(accessModelDefaults)
      .innerJoin(accessModels, eq(accessModels.id, accessModelDefaults.embeddingModel));
    return row?.model;
  }
}
