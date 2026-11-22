import { DeliveryStatusSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { isOneOf, literal } from './helpers';
import { runtimeEvents } from './runtime-events';

export const runtimeEventDeliveries = app.table(
  'runtime_event_deliveries',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => runtimeEvents.eventId, { onDelete: 'cascade' }),
    consumer: text('consumer').notNull(),
    status: text('status').notNull().default(DeliveryStatusSchema.enum.pending),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastError: text('last_error'),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.consumer] }),
    check(
      'runtime_event_deliveries_status_check',
      isOneOf(t.status, DeliveryStatusSchema.options),
    ),
    index('runtime_event_deliveries_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = ${literal(DeliveryStatusSchema.enum.pending)}`),
  ],
);
