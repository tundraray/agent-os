import { jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';

export const auditEvents = app.table('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  /** Employee id or `system`. */
  actor: text('actor').notNull(),
  objectType: text('object_type'),
  objectId: text('object_id'),
  /** Secrets and passwords are already masked by `AuditLog`. */
  before: jsonb('before'),
  after: jsonb('after'),
  outcome: text('outcome').notNull(),
  reason: text('reason'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});
