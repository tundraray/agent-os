import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { Db } from '../db';
import { modelProviders } from '../schema';

/** A row of `model_providers`; `apiKey` is the key as stored. */
export type ModelProviderRow = typeof modelProviders.$inferSelect;

/** What creation writes; `enabled` and the times take their defaults. */
export type NewModelProviderRow = Pick<
  ModelProviderRow,
  'name' | 'kind' | 'baseUrl' | 'apiKey'
>;

/** What may change after creation: name and kind never do. */
export type ModelProviderPatch = Partial<
  Pick<ModelProviderRow, 'baseUrl' | 'apiKey' | 'enabled'>
>;

/** The provider rows before and after a write: the audit record is built from them. */
export interface ModelProviderChange {
  readonly before: ModelProviderRow;
  readonly after: ModelProviderRow;
}

/**
 * Drizzle queries of `model_providers` (ADR-0019): the registry is
 * read from the database on every use, without a cache (KD-1). No method opens a transaction or calls out
 * of the process.
 */
@Injectable()
export class ModelProvidersRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async find(name: string): Promise<ModelProviderRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.name, name));
    return row;
  }

  /** The registered providers among the names, in one query. */
  async findMany(names: readonly string[]): Promise<ModelProviderRow[]> {
    if (names.length === 0) return [];
    return this.db.client
      .select()
      .from(modelProviders)
      .where(inArray(modelProviders.name, [...names]));
  }

  /** All providers by name. */
  list(): Promise<ModelProviderRow[]> {
    return this.db.client
      .select()
      .from(modelProviders)
      .orderBy(asc(modelProviders.name));
  }

  /** Creates the provider; `undefined` when the name is taken (its primary key). */
  async insert(
    provider: NewModelProviderRow,
  ): Promise<ModelProviderRow | undefined> {
    const [row] = await this.db.client
      .insert(modelProviders)
      .values(provider)
      .onConflictDoNothing()
      .returning();
    return row;
  }

  /** Writes the patch; `undefined` when the provider is not registered. */
  async update(
    name: string,
    patch: ModelProviderPatch,
  ): Promise<ModelProviderChange | undefined> {
    const [before] = await this.db.client
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.name, name));
    if (before === undefined) return undefined;
    const [after] = await this.db.client
      .update(modelProviders)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(modelProviders.name, name))
      .returning();
    if (after === undefined)
      throw new Error(`Model provider ${name} vanished during its update`);
    return { before, after };
  }

  /** Removes the provider; returns the removed row. */
  async delete(name: string): Promise<ModelProviderRow | undefined> {
    const [row] = await this.db.client
      .delete(modelProviders)
      .where(eq(modelProviders.name, name))
      .returning();
    return row;
  }
}
