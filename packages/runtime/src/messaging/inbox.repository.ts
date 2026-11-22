import { MessageStatusSchema } from '@agent-os/contracts';
import { type Executor, runtimeInbox, type Transaction } from '@agent-os/db';
import { and, asc, eq, inArray } from 'drizzle-orm';

export type MessageRow = typeof runtimeInbox.$inferSelect;

export type NewMessageRow = Pick<
  typeof runtimeInbox.$inferInsert,
  'messageId' | 'recipientId' | 'ownerId' | 'seq' | 'kind' | 'sender' | 'payload' | 'revive'
>;

const { pending, delivered } = MessageStatusSchema.enum;

/**
 * Drizzle queries of `runtime_inbox` (repository over a transaction). `Inbox` is the only writer:
 * it holds the recipient's lock, its sequence and its wake-up.
 */
export class InboxRepository {
  /** Inserts a `pending` message. */
  async insert(tx: Transaction, message: NewMessageRow): Promise<void> {
    await tx.insert(runtimeInbox).values({ ...message, status: pending });
  }

  /** The task's pending messages by `seq`. */
  listPending(executor: Executor, taskId: string): Promise<MessageRow[]> {
    return executor
      .select()
      .from(runtimeInbox)
      .where(and(eq(runtimeInbox.recipientId, taskId), eq(runtimeInbox.status, pending)))
      .orderBy(asc(runtimeInbox.seq));
  }

  /** The owner's pending messages of the task by `seq`; `[]` for another owner's or a missing task. */
  listPendingOwned(executor: Executor, taskId: string, ownerId: string): Promise<MessageRow[]> {
    return executor
      .select()
      .from(runtimeInbox)
      .where(
        and(
          eq(runtimeInbox.recipientId, taskId),
          eq(runtimeInbox.ownerId, ownerId),
          eq(runtimeInbox.status, pending),
        ),
      )
      .orderBy(asc(runtimeInbox.seq));
  }

  /** Marks the task's pending messages as delivered to step `stepNo`; returns the ones it marked. */
  markDelivered(
    tx: Transaction,
    taskId: string,
    messageIds: readonly string[],
    stepNo: number,
  ): Promise<{ messageId: string; seq: number }[]> {
    return tx
      .update(runtimeInbox)
      .set({ status: delivered, deliveredStep: stepNo })
      .where(
        and(
          eq(runtimeInbox.recipientId, taskId),
          eq(runtimeInbox.status, pending),
          inArray(runtimeInbox.messageId, [...messageIds]),
        ),
      )
      .returning({ messageId: runtimeInbox.messageId, seq: runtimeInbox.seq });
  }

  /** Whether a message with `revive` waits in the task's inbox. */
  async hasPendingRevive(tx: Transaction, taskId: string): Promise<boolean> {
    const rows = await tx
      .select({ messageId: runtimeInbox.messageId })
      .from(runtimeInbox)
      .where(
        and(
          eq(runtimeInbox.recipientId, taskId),
          eq(runtimeInbox.status, pending),
          eq(runtimeInbox.revive, true),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
