import { boolean, integer, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createdAt } from './helpers';
import { libraryRecords } from './library-records';

/** Fields of every graph record (KD-5); the runs are kept for review and confirmations, no FK. */
export const knowledgeItemFields = () => ({
  recordId: uuid('record_id')
    .notNull()
    .references(() => libraryRecords.id, { onDelete: 'cascade' }),
  confirmations: integer('confirmations').notNull().default(1),
  createdAt: createdAt(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  /** Coordinator task of the run that added the record. Kept for incident analysis; no code reads it. */
  sourceRunId: uuid('source_run_id').notNull(),
  /** Coordinator task of the run that confirmed it last. */
  confirmedByRunId: uuid('confirmed_by_run_id').notNull(),
  outdated: boolean('outdated').notNull().default(false),
});
