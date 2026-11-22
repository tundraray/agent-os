import { Inject, Injectable } from '@nestjs/common';
import { asc, count, eq, like, sql } from 'drizzle-orm';
import { Db } from '../db';
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
 * Drizzle queries of `access_models` and the single `access_model_defaults` row.
 */
@Injectable()
export class AccessModelsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async find(id: string): Promise<AccessModelRow | undefined> {
    const [row] = await this.db.client.select().from(accessModels).where(eq(accessModels.id, id));
    return row;
  }

  /** The catalogue by name, then id. */
  list(): Promise<AccessModelRow[]> {
    return this.db.client.select().from(accessModels).orderBy(asc(accessModels.name), asc(accessModels.id));
  }

  /** How many catalogue models name the provider as the first part of their id (`MODEL_PROVIDER_HAS_MODELS`). */
  async countByProvider(provider: string): Promise<number> {
    // A provider name holds only `[a-z0-9-]`, so it has no LIKE wildcard to escape.
    const [row] = await this.db.client
      .select({ models: count() })
      .from(accessModels)
      .where(like(accessModels.id, `${provider}/%`));
    return row?.models ?? 0;
  }

  /** Adds the model; `undefined` when the id is taken. */
  async insert(
    id: string,
    columns: AccessModelColumns,
  ): Promise<AccessModelRow | undefined> {
    const [row] = await this.db.client
      .insert(accessModels)
      .values({ id, ...columns })
      .onConflictDoNothing({ target: accessModels.id })
      .returning();
    return row;
  }

  /** Writes the model's columns (the id stays); returns the stored row. */
  async update(id: string, columns: AccessModelColumns): Promise<AccessModelRow> {
    const [row] = await this.db.client
      .update(accessModels)
      .set({ ...columns, updatedAt: sql`now()` })
      .where(eq(accessModels.id, id))
      .returning();
    if (row === undefined) throw new Error('access_models update returned no row');
    return row;
  }

  /** Deletes the model (its grants go by cascade, a default on it is cleared); the deleted row, or `undefined` for a missing one. */
  async delete(id: string): Promise<AccessModelRow | undefined> {
    const [row] = await this.db.client.delete(accessModels).where(eq(accessModels.id, id)).returning();
    return row;
  }

  /** The migration creates the row, so its absence is a fault. */
  async readDefaults(): Promise<AccessModelDefaultsRow> {
    const [row] = await this.db.client.select(defaultsColumns).from(accessModelDefaults);
    if (row === undefined) throw new Error('access_model_defaults row is missing');
    return row;
  }

  /** Writes the administrator's choice with who and when; returns the row after it. */
  async writeDefaults(
    models: { chatModel: string | null; embeddingModel: string | null },
    actorId: string,
  ): Promise<AccessModelDefaultsRow> {
    const [row] = await this.db.client
      .update(accessModelDefaults)
      .set({ ...models, updatedAt: new Date(), updatedBy: actorId })
      .returning(defaultsColumns);
    if (row === undefined) throw new Error('access_model_defaults row is missing');
    return row;
  }

  /** The catalogue row of the default embedding model; `undefined` while none is chosen. */
  async findDefaultEmbedding(): Promise<AccessModelRow | undefined> {
    const [row] = await this.db.client
      .select({ model: accessModels })
      .from(accessModelDefaults)
      .innerJoin(accessModels, eq(accessModels.id, accessModelDefaults.embeddingModel));
    return row?.model;
  }
}
