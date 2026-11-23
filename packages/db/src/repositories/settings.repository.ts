import type { SettingsKey } from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { Db } from '../db';
import { settings } from '../schema';

/** The row of a settings key; `value` is parsed by the key's schema in the service that reads it. */
export interface SettingsRow {
  readonly key: SettingsKey;
  readonly value: unknown;
  /** Null while the defaults of the migration stand. */
  readonly updatedAt: Date | null;
  readonly updatedBy: string | null;
}

/** An administrator's write of a key. */
export interface SettingsWrite {
  readonly key: SettingsKey;
  readonly value: unknown;
  readonly actorId: string;
}

/** A write that happens only while the key still holds the value read before it. */
export interface SettingsReplace {
  readonly key: SettingsKey;
  readonly expected: unknown;
  readonly value: unknown;
}

const rowColumns = {
  key: settings.key,
  value: settings.value,
  updatedAt: settings.updatedAt,
  updatedBy: settings.updatedBy,
};

const jsonbOf = (value: unknown) => sql`${JSON.stringify(value)}::jsonb`;

/**
 * Drizzle queries of `settings` (data-model design-schema.md KD-3). The migration creates the row of every key,
 * so a missing row is a fault.
 */
@Injectable()
export class SettingsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async read(key: SettingsKey): Promise<SettingsRow> {
    const [row] = await this.db.client
      .select(rowColumns)
      .from(settings)
      .where(eq(settings.key, key));
    if (row === undefined) throw new Error(`settings row ${key} is missing`);
    return { ...row, key };
  }

  /** Writes the administrator's value with the time and the author; returns the row after it. */
  async write({ key, value, actorId }: SettingsWrite): Promise<SettingsRow> {
    const [row] = await this.db.client
      .update(settings)
      .set({ value, updatedAt: sql`now()`, updatedBy: actorId })
      .where(eq(settings.key, key))
      .returning(rowColumns);
    if (row === undefined) throw new Error(`settings row ${key} is missing`);
    return { ...row, key };
  }

  /**
   * Writes the value only while the stored one equals `expected` (jsonb equality), leaving the time and the author
   * as they are; false when another write came first.
   */
  async replaceIf({ key, expected, value }: SettingsReplace): Promise<boolean> {
    const written = await this.db.client
      .update(settings)
      .set({ value })
      .where(and(eq(settings.key, key), eq(settings.value, jsonbOf(expected))))
      .returning({ key: settings.key });
    return written.length > 0;
  }
}
