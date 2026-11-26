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

/**
 * The text a search reads: its first 100 000 characters (conversation-search KD-3). The limit is a SQL
 * literal, not a parameter, so a query reads the same expression its index is built on.
 */
export const searchedText = (text: AnyPgColumn | SQL): SQL =>
  sql`left(${text}, 100000)`;

/** The text search configuration of every search index and query (KD-2), as a SQL literal. */
export const SEARCH_CONFIG = sql.raw(`'russian'::regconfig`);

/** The words of a searched text; every search index and query is built on this one expression. */
export const searchVector = (text: AnyPgColumn | SQL): SQL =>
  sql`to_tsvector(${SEARCH_CONFIG}, ${searchedText(text)})`;
