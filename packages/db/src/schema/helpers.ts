import { type SQL, sql } from 'drizzle-orm';
import { type AnyPgColumn, timestamp } from 'drizzle-orm/pg-core';

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

/** SQL string literal of a code constant (enum value). */
export const literal = (value: string): SQL =>
  sql.raw(`'${value.replaceAll("'", "''")}'`);

/** `column IN (...)` over the values of a contract enum. */
export const isOneOf = (column: AnyPgColumn, values: readonly string[]): SQL =>
  sql`${column} in (${sql.join(values.map(literal), sql`, `)})`;

/** `column BETWEEN min AND max` over code constants. */
export const isWithin = (column: AnyPgColumn, min: number, max: number): SQL =>
  sql`${column} between ${sql.raw(String(min))} and ${sql.raw(String(max))}`;
