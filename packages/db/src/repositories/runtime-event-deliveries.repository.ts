import { DeliveryStatusSchema } from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Executor, Transaction } from '../database';
import { runtimeEventDeliveries, runtimeEvents } from '../schema';

export type RuntimeEventDeliveryRow = typeof runtimeEventDeliveries.$inferSelect;

/** One delivery row: the event and the consumer it is owed to. */
export interface RuntimeEventDeliveryKey {
  eventId: string;
  consumer: string;
}

const { pending } = DeliveryStatusSchema.enum;

/**
 * Drizzle queries of `runtime_event_deliveries` (repository over a transaction). The rows are
 * inserted by the runtime's `EventLog` with their event; the relay reads and updates them.
 */
@Injectable()
export class RuntimeEventDeliveriesRepository {
  /** Inserts one `pending` delivery of the event per named consumer. */
  async insert(tx: Transaction, eventId: string, consumers: readonly string[]): Promise<void> {
    await tx
      .insert(runtimeEventDeliveries)
      .values(consumers.map((consumer) => ({ eventId, consumer })));
  }

  /** The oldest due `pending` deliveries of the named consumers, at most `limit`. */
  listDue(
    executor: Executor,
    consumers: readonly string[],
    now: Date,
    limit: number,
  ): Promise<RuntimeEventDeliveryKey[]> {
    return executor
      .select({
        eventId: runtimeEventDeliveries.eventId,
        consumer: runtimeEventDeliveries.consumer,
      })
      .from(runtimeEventDeliveries)
      .innerJoin(runtimeEvents, eq(runtimeEvents.eventId, runtimeEventDeliveries.eventId))
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

  /**
   * Locks the delivery FOR UPDATE SKIP LOCKED when it is still `pending` and due; `undefined`
   * otherwise, also when another relay holds it.
   */
  async lockDue(tx: Transaction, key: RuntimeEventDeliveryKey, now: Date): Promise<RuntimeEventDeliveryRow | undefined> {
    const [row] = await tx
      .select()
      .from(runtimeEventDeliveries)
      .where(
        and(
          eq(runtimeEventDeliveries.eventId, key.eventId),
          eq(runtimeEventDeliveries.consumer, key.consumer),
          // Checked again under the lock: a done delivery is never applied twice.
          eq(runtimeEventDeliveries.status, pending),
          lte(runtimeEventDeliveries.nextAttemptAt, now),
        ),
      )
      .for('update', { skipLocked: true });
    return row;
  }

  async update(
    tx: Transaction,
    key: RuntimeEventDeliveryKey,
    fields: Partial<Pick<RuntimeEventDeliveryRow, 'status' | 'attempts' | 'nextAttemptAt' | 'lastError'>>,
  ): Promise<void> {
    await tx
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
