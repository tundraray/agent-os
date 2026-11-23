import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { runtimeEvents, runtimeTasks } from '../schema';

export type NewRuntimeEventRow = Pick<
  typeof runtimeEvents.$inferInsert,
  'eventId' | 'type' | 'schemaVersion' | 'rootId' | 'taskId' | 'payload'
>;

/**
 * Drizzle queries of `runtime_events`. The runtime's `EventLog` is
 * the only writer: it adds the deliveries and the NOTIFY ({@link notify}) of an event in the same
 * transaction.
 */
export class RuntimeEventsRepository {
  constructor(private readonly db: Db) {}

  /** Inserts the event; returns what the log assigns to it. */
  async insert(
    event: NewRuntimeEventRow,
  ): Promise<{ seq: number; createdAt: Date }> {
    const [row] = await this.db.client
      .insert(runtimeEvents)
      .values(event)
      .returning({
        seq: runtimeEvents.seq,
        createdAt: runtimeEvents.createdAt,
      });
    return row;
  }

  /**
   * Events of the owner's tree with `seq > afterSeq`, by `seq`, at most `limit`. Another owner's or
   * a missing tree gives `[]`.
   */
  listAfter(rootId: string, ownerId: string, afterSeq: number, limit: number) {
    return this.db.client
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
      .where(
        and(eq(runtimeEvents.rootId, rootId), gt(runtimeEvents.seq, afterSeq)),
      )
      .orderBy(asc(runtimeEvents.seq))
      .limit(limit);
  }

  /** The event by its id, as its consumers receive it. */
  async find(eventId: string) {
    const [row] = await this.db.client
      .select({
        eventId: runtimeEvents.eventId,
        seq: runtimeEvents.seq,
        type: runtimeEvents.type,
        schemaVersion: runtimeEvents.schemaVersion,
        rootId: runtimeEvents.rootId,
        taskId: runtimeEvents.taskId,
        payload: runtimeEvents.payload,
        createdAt: runtimeEvents.createdAt,
      })
      .from(runtimeEvents)
      .where(eq(runtimeEvents.eventId, eventId));
    return row;
  }

  /** `pg_notify` in the open transaction: listeners get it when the transaction commits. */
  async notify(channel: string, payload: string): Promise<void> {
    await this.db.client.execute(sql`select pg_notify(${channel}, ${payload})`);
  }
}
