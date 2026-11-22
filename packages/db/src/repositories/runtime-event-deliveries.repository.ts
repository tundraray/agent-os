import { DeliveryStatusSchema } from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import { Db } from '../db';
import { runtimeEventDeliveries, runtimeEvents } from '../schema';

export type RuntimeEventDeliveryRow =
  typeof runtimeEventDeliveries.$inferSelect;

/** One delivery row: the event and the consumer it is owed to. */
export interface RuntimeEventDeliveryKey {
  eventId: string;
  consumer: string;
}

const { pending } = DeliveryStatusSchema.enum;

/**
 * Drizzle queries of `runtime_event_deliveries`. The rows are
 * inserted by the runtime's `EventLog` with their event; the relay reads and updates them.
 */
@Injectable()
export class RuntimeEventDeliveriesRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Inserts one `pending` delivery of the event per named consumer. */
  async insert(eventId: string, consumers: readonly string[]): Promise<void> {
    await this.db.client
      .insert(runtimeEventDeliveries)
      .values(consumers.map((consumer) => ({ eventId, consumer })));
  }

  /** The oldest due `pending` deliveries of the named consumers, at most `limit`. */
  listDue(
    consumers: readonly string[],
    now: Date,
    limit: number,
  ): Promise<RuntimeEventDeliveryKey[]> {
    return this.db.client
      .select({
        eventId: runtimeEventDeliveries.eventId,
        consumer: runtimeEventDeliveries.consumer,
      })
      .from(runtimeEventDeliveries)
      .innerJoin(
        runtimeEvents,
        eq(runtimeEvents.eventId, runtimeEventDeliveries.eventId),
      )
      .where(
        and(
          eq(runtimeEventDeliveries.status, pending),
          lte(runtimeEventDeliveries.nextAttemptAt, now),
          inArray(runtimeEventDeliveries.consumer, [...consumers]),
        ),
      )
      .orderBy(
        asc(runtimeEventDeliveries.nextAttemptAt),
        asc(runtimeEvents.seq),
        // Only for determinism: the deliveries of one event share `next_attempt_at` and `seq`.
        desc(runtimeEventDeliveries.consumer),
      )
      .limit(limit);
  }

  /** The delivery when it is still `pending` and due; `undefined` otherwise. */
  async findDue(
    key: RuntimeEventDeliveryKey,
    now: Date,
  ): Promise<RuntimeEventDeliveryRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(runtimeEventDeliveries)
      .where(
        and(
          eq(runtimeEventDeliveries.eventId, key.eventId),
          eq(runtimeEventDeliveries.consumer, key.consumer),
          eq(runtimeEventDeliveries.status, pending),
          lte(runtimeEventDeliveries.nextAttemptAt, now),
        ),
      );
    return row;
  }

  async update(
    key: RuntimeEventDeliveryKey,
    fields: Partial<
      Pick<
        RuntimeEventDeliveryRow,
        'status' | 'attempts' | 'nextAttemptAt' | 'lastError'
      >
    >,
  ): Promise<void> {
    await this.db.client
      .update(runtimeEventDeliveries)
      .set(fields)
      .where(
        and(
          eq(runtimeEventDeliveries.eventId, key.eventId),
          eq(runtimeEventDeliveries.consumer, key.consumer),
        ),
      );
  }
}
