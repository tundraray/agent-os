import { RecordKindSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf } from './helpers';
import { identityUsers } from './identity-users';

/** A record of any kind: an employee's (with an owner) or a system one (no owner). */
export const libraryRecords = app.table(
  'library_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    /** Null — a system record. */
    ownerId: uuid('owner_id').references(() => identityUsers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    offerInChat: boolean('offer_in_chat').notNull().default(false),
    /** Key of a built-in system record (`chat`); null for every other record. */
    builtinKey: text('builtin_key'),
    content: jsonb('content').notNull(),
    /** Grows with every edit of the record. */
    version: integer('version').notNull().default(1),
    /** When an admin closed sharing of an employee record; null — not closed. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** A name is unique per owner regardless of case and kind; system records are one group. */
    uniqueIndex('library_records_owner_name_idx')
      .on(t.ownerId, sql`lower(${t.name})`)
      .where(sql`${t.ownerId} is not null`),
    uniqueIndex('library_records_system_name_idx')
      .on(sql`lower(${t.name})`)
      .where(sql`${t.ownerId} is null`),
    uniqueIndex('library_records_builtin_key_idx').on(t.builtinKey),
    check('library_records_kind_check', isOneOf(t.kind, RecordKindSchema.options)),
    check(
      'library_records_builtin_key_check',
      sql`${t.builtinKey} is null or ${t.ownerId} is null`,
    ),
    check(
      'library_records_closed_at_check',
      sql`${t.closedAt} is null or ${t.ownerId} is not null`,
    ),
  ],
);
