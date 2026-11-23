import { MessageStatusSchema } from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Db } from '../db';
import { runtimeInbox, runtimeTasks } from '../schema';

export type RuntimeInboxRow = typeof runtimeInbox.$inferSelect;

export type NewRuntimeInboxRow = Pick<
  typeof runtimeInbox.$inferInsert,
  'messageId' | 'recipientId' | 'seq' | 'kind' | 'sender' | 'payload' | 'revive'
>;

const { pending, delivered } = MessageStatusSchema.enum;

/**
 * Drizzle queries of `runtime_inbox`. The runtime's `Inbox` is the only writer:
 * it holds its sequence and its wake-up.
 */
@Injectable()
export class RuntimeInboxRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** Inserts a `pending` message. */
  async insert(message: NewRuntimeInboxRow): Promise<void> {
    await this.db.client
      .insert(runtimeInbox)
      .values({ ...message, status: pending });
  }

  /** The task's pending messages by `seq`. */
  listPending(taskId: string): Promise<RuntimeInboxRow[]> {
    return this.db.client
      .select()
      .from(runtimeInbox)
      .where(
        and(
          eq(runtimeInbox.recipientId, taskId),
          eq(runtimeInbox.status, pending),
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
          eq(runtimeInbox.status, pending),
        ),
      )
      .orderBy(asc(runtimeInbox.seq));
    return rows.map((row) => row.message);
  }

  /** Marks the task's pending messages as delivered to step `stepNo`; returns the ones it marked. */
  markDelivered(
    taskId: string,
    messageIds: readonly string[],
    stepNo: number,
  ): Promise<{ messageId: string; seq: number }[]> {
    return this.db.client
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
  async hasPendingRevive(taskId: string): Promise<boolean> {
    const rows = await this.db.client
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
