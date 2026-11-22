import { Injectable } from '@nestjs/common';
import { and, asc, eq, gt } from 'drizzle-orm';
import type { Executor, Transaction } from '../database';
import { runtimeEvents, runtimeTasks } from '../schema';

export type NewRuntimeEventRow = Pick<
  typeof runtimeEvents.$inferInsert,
  | 'eventId'
  | 'type'
  | 'schemaVersion'
  | 'rootId'
  | 'taskId'
  | 'causationId'
  | 'stateRevision'
  | 'payload'
>;

/**
 * Drizzle queries of `runtime_events` (repository over a transaction). The runtime's `EventLog` is
 * the only writer: it adds the deliveries and the NOTIFY of an event in the same transaction.
 */
@Injectable()
export class RuntimeEventsRepository {
  /** Inserts the event; returns what the log assigns to it. */
  async insert(
    tx: Transaction,
    event: NewRuntimeEventRow,
  ): Promise<{ seq: number; createdAt: Date }> {
    const [row] = await tx
      .insert(runtimeEvents)
      .values(event)
      .returning({ seq: runtimeEvents.seq, createdAt: runtimeEvents.createdAt });
    return row;
  }

  /**
   * Events of the owner's tree with `seq > afterSeq`, by `seq`, at most `limit`. Another owner's or
   * a missing tree gives `[]`.
   */
  listAfter(executor: Executor, rootId: string, ownerId: string, afterSeq: number, limit: number) {
    return executor
      .select({
        seq: runtimeEvents.seq,
        type: runtimeEvents.type,
        taskId: runtimeEvents.taskId,
        createdAt: runtimeEvents.createdAt,
        payload: runtimeEvents.payload,
      })
      .from(runtimeEvents)
      .innerJoin(
        runtimeTasks,
        and(
          eq(runtimeTasks.taskId, runtimeEvents.rootId),
          eq(runtimeTasks.ownerId, ownerId),
        ),
      )
      .where(and(eq(runtimeEvents.rootId, rootId), gt(runtimeEvents.seq, afterSeq)))
      .orderBy(asc(runtimeEvents.seq))
      .limit(limit);
  }

  /** The event by its id, as its consumers receive it. */
  async find(tx: Transaction, eventId: string) {
    const [row] = await tx
      .select({
        eventId: runtimeEvents.eventId,
        seq: runtimeEvents.seq,
        type: runtimeEvents.type,
        schemaVersion: runtimeEvents.schemaVersion,
        rootId: runtimeEvents.rootId,
        taskId: runtimeEvents.taskId,
        causationId: runtimeEvents.causationId,
        stateRevision: runtimeEvents.stateRevision,
        payload: runtimeEvents.payload,
        createdAt: runtimeEvents.createdAt,
      })
      .from(runtimeEvents)
      .where(eq(runtimeEvents.eventId, eventId));
    return row;
  }
}
