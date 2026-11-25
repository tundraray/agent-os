import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { runtimeInbox, runtimeTasks } from '../schema';

export type RuntimeInboxRow = typeof runtimeInbox.$inferSelect;

export type NewRuntimeInboxRow = Pick<
  typeof runtimeInbox.$inferInsert,
  'messageId' | 'recipientId' | 'kind' | 'payload' | 'revive'
>;

/**
 * Drizzle queries of `runtime_inbox`. The runtime's `Inbox` is the only writer:
 * it holds the wake-up.
 */
export class RuntimeInboxRepository {
  constructor(private readonly db: Db) {}

  /** Inserts a waiting message; returns its `seq`, the insertion order. */
  async insert(message: NewRuntimeInboxRow): Promise<number> {
    const [row] = await this.db.client
      .insert(runtimeInbox)
      .values(message)
      .returning({ seq: runtimeInbox.seq });
    if (row === undefined)
      throw new Error('runtime_inbox insert returned no row');
    return row.seq;
  }

  /** The task's pending messages by `seq`. */
  listPending(taskId: string): Promise<RuntimeInboxRow[]> {
    return this.db.client
      .select()
      .from(runtimeInbox)
      .where(
        and(
          eq(runtimeInbox.recipientId, taskId),
          isNull(runtimeInbox.deliveredAt),
        ),
      )
      .orderBy(asc(runtimeInbox.seq));
  }

  /**
   * The owner's pending messages of the task by `seq`, the owner being the recipient task's; `[]` for another
   * owner's or a missing task.
   */
  async listPendingOwned(
    taskId: string,
    ownerId: string,
  ): Promise<RuntimeInboxRow[]> {
    const rows = await this.db.client
      .select({ message: runtimeInbox })
      .from(runtimeInbox)
      .innerJoin(
        runtimeTasks,
        eq(runtimeTasks.taskId, runtimeInbox.recipientId),
      )
      .where(
        and(
          eq(runtimeInbox.recipientId, taskId),
          eq(runtimeTasks.ownerId, ownerId),
          isNull(runtimeInbox.deliveredAt),
        ),
      )
      .orderBy(asc(runtimeInbox.seq));
    return rows.map((row) => row.message);
  }

  /** Marks the task's pending messages delivered (`delivered_at = now()`); returns the ones it marked. */
  markDelivered(
    taskId: string,
    messageIds: readonly string[],
  ): Promise<{ messageId: string; seq: number }[]> {
    return this.db.client
      .update(runtimeInbox)
      .set({ deliveredAt: sql`now()` })
      .where(
        and(
          eq(runtimeInbox.recipientId, taskId),
          isNull(runtimeInbox.deliveredAt),
          inArray(runtimeInbox.messageId, [...messageIds]),
        ),
      )
      .returning({ messageId: runtimeInbox.messageId, seq: runtimeInbox.seq });
  }

  /**
   * The `seq` of the last message of this kind to the recipient, delivered or not: rows are never deleted,
   * `delivered_at` only marks the delivery. `null` when it has none.
   */
  async lastSeq(recipientId: string, kind: string): Promise<number | null> {
    const [row] = await this.db.client
      .select({ seq: max(runtimeInbox.seq) })
      .from(runtimeInbox)
      .where(
        and(
          eq(runtimeInbox.recipientId, recipientId),
          eq(runtimeInbox.kind, kind),
        ),
      );
    return row?.seq ?? null;
  }

  /** Whether a message with `revive` waits in the task's inbox. */
  async hasPendingRevive(taskId: string): Promise<boolean> {
    const rows = await this.db.client
      .select({ messageId: runtimeInbox.messageId })
      .from(runtimeInbox)
      .where(
        and(
          eq(runtimeInbox.recipientId, taskId),
          isNull(runtimeInbox.deliveredAt),
          eq(runtimeInbox.revive, true),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
