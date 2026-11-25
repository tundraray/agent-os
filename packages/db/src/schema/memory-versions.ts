import { MemoryVersionKindSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  integer,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { isOneOf, literal } from './helpers';
import { identityUsers } from './identity-users';
import { memories } from './memories';

/**
 * An immutable version of a memory record (memory-hygiene KD-1): rows are never updated, and go only with their
 * record by cascade. Numbers run from 1 without gaps; the record's current version has the greatest one.
 */
export const memoryVersions = app.table(
  'memory_versions',
  {
    memoryId: uuid('memory_id')
      .notNull()
      .references((): AnyPgColumn => memories.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    kind: text('kind').notNull(),
    /** Null only for `deleted`. */
    text: text('text'),
    changedAt: timestamp('changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The person who made it (a revert); null — the agent made it (KD-6). */
    authorId: uuid('author_id').references(() => identityUsers.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.version] }),
    check(
      'memory_versions_kind_check',
      isOneOf(t.kind, MemoryVersionKindSchema.options),
    ),
    check(
      'memory_versions_text_check',
      sql`(${t.text} is null) = (${t.kind} = ${literal(MemoryVersionKindSchema.enum.deleted)})`,
    ),
  ],
);
