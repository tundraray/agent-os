import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  CHILD_FINISHED_KIND,
  MessageStatusSchema,
  RuntimeEventTypeSchema,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { type Database, runtimeInbox } from '@agent-os/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { CrashPoints } from './crash-points.js';
import { RuntimeError } from './errors.js';
import type { EventLog } from './event-log.js';
import {
  isFinished,
  type TaskChange,
  type TaskRow,
} from './guarded-transition.js';
import type { EnqueuedMessage, StepMessage } from './handler.registry.js';
import { retryingTransaction, type RuntimeTx } from './runtime-tx.js';
import type { TaskRepository } from './task.repository.js';

export type MessageRow = typeof runtimeInbox.$inferSelect;

/** Size of a JSON value as UTF-8 text: the measure of `INBOX_PAYLOAD_MAX_BYTES`. */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

/**
 * `PAYLOAD_TOO_LARGE` for a message payload over `maxBytes`, or `undefined`. Every writer of an
 * upper-layer message checks it before `insertMessage` (`enqueue`, `effects.enqueue`, `interrupt`);
 * the runtime's own `child_finished` is bounded by the result it carries.
 */
export function payloadTooLarge(payload: unknown, maxBytes: number): RuntimeError | undefined {
  const bytes = jsonByteLength(payload);
  if (bytes <= maxBytes) return undefined;
  return new RuntimeError(
    'PAYLOAD_TOO_LARGE',
    `message payload is ${bytes} bytes, over ${maxBytes}`,
  );
}

/** A message row as a step and the queue tray see it. */
export const toStepMessage = (row: MessageRow): StepMessage => ({
  messageId: row.messageId,
  seq: row.seq,
  kind: row.kind,
  sender: row.sender,
  payload: row.payload,
  revive: row.revive,
  createdAt: row.createdAt,
});

const { pending, delivered } = MessageStatusSchema.enum;
const { queued, waiting } = TaskStatusSchema.enum;
const { messages, interrupted } = WaitReasonSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;

/** A message to write; the caller has checked its kind and payload size. */
export interface NewMessage {
  recipientId: string;
  /** Owner of the recipient; another owner's task is as absent as a missing one. */
  ownerId: string;
  kind: string;
  /** Task or employee that sends the message. */
  sender: string;
  payload: unknown;
  /** Queue a finished recipient again; a `child_finished` notice never has it. */
  revive?: boolean;
}

export interface InsertedMessage {
  messageId: string;
  seq: number;
  /** The recipient after the message, woken or not. */
  recipient: TaskRow;
}

export interface InboxDeps {
  db: Database;
  tasks: TaskRepository;
  events: EventLog;
  crashPoints: CrashPoints;
  logger: Logger;
  /** `INBOX_PAYLOAD_MAX_BYTES`. */
  inboxPayloadMaxBytes: number;
}

/**
 * The wake-up a message brings to its recipient (plan Notes 3, KD-3): waiting for messages or
 * interrupted → `queued`; finished with `revive` → `queued` with its outcome cleared; otherwise
 * (waiting for a decision, queued, running, finished without `revive`) nothing changes.
 */
function wakeChange(recipient: TaskRow, revive: boolean): TaskChange | undefined {
  if (recipient.status === waiting) {
    const wakes =
      recipient.waitReason === messages || recipient.waitReason === interrupted;
    return wakes ? { kind: 'set', status: queued } : undefined;
  }
  if (isFinished(recipient.status) && revive) {
    return { kind: 'set', status: queued, fields: { result: null, failure: null } };
  }
  return undefined;
}

/**
 * The task inbox inside the caller's transaction: the only writer of `runtime_inbox` rows. A
 * message, its event and the recipient's wake-up commit together, under the recipient's lock.
 */
export class Inbox {
  constructor(protected readonly deps: InboxDeps) {}

  /**
   * Puts an upper-layer message in the recipient's queue in its own transaction (design-runtime.md,
   * Очередь): `TASK_NOT_FOUND` for a missing or another owner's recipient, `PAYLOAD_TOO_LARGE` over
   * `INBOX_PAYLOAD_MAX_BYTES`; nothing is written then. `child_finished` is the runtime's own kind.
   */
  async enqueue(message: NewMessage): Promise<EnqueuedMessage> {
    const { db, logger, inboxPayloadMaxBytes } = this.deps;
    const startedAt = Date.now();
    const fields = {
      taskId: message.recipientId,
      ownerId: message.ownerId,
      kind: message.kind,
      sender: message.sender,
      revive: message.revive ?? false,
    };
    try {
      if (message.kind === CHILD_FINISHED_KIND) {
        throw new Error(`message kind "${CHILD_FINISHED_KIND}" is reserved by the runtime`);
      }
      const tooLarge = payloadTooLarge(message.payload, inboxPayloadMaxBytes);
      if (tooLarge) throw tooLarge;
      const inserted = await retryingTransaction(db, logger, 'inbox.enqueue', (tx) =>
        this.insertMessage(tx, message),
      );
      logger.info('message enqueued', {
        ...fields,
        messageId: inserted.messageId,
        seq: inserted.seq,
        rootId: inserted.recipient.rootId,
        status: inserted.recipient.status,
        durationMs: Date.now() - startedAt,
      });
      return { messageId: inserted.messageId, seq: inserted.seq };
    } catch (error) {
      logger.warn('message not enqueued', {
        ...fields,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /** The task's pending messages by `seq`; `[]` for another owner's or a missing task. */
  async listPending(taskId: string, ownerId: string): Promise<StepMessage[]> {
    const rows = await this.deps.db
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
    return rows.map(toStepMessage);
  }

  /**
   * Locks the recipient FOR UPDATE, takes its `next_message_seq`, writes the `pending` message and
   * `inbox.enqueued`, then wakes the recipient by the wake-up rule with `task.queued`. Throws
   * `TASK_NOT_FOUND` for a missing or another owner's recipient.
   */
  async insertMessage(tx: RuntimeTx, message: NewMessage): Promise<InsertedMessage> {
    const { tasks, events, crashPoints } = this.deps;
    const locked = await tasks.lockOwned(tx, message.recipientId, message.ownerId);
    if (!locked) {
      throw new RuntimeError(
        'TASK_NOT_FOUND',
        `Task ${message.recipientId} not found`,
      );
    }
    const seq = locked.nextMessageSeq;
    const recipient = await this.write(tx, locked, {
      kind: 'set',
      fields: { nextMessageSeq: seq + 1 },
    });
    const messageId = randomUUID();
    const revive = message.revive ?? false;
    await tx.insert(runtimeInbox).values({
      messageId,
      recipientId: recipient.taskId,
      ownerId: recipient.ownerId,
      seq,
      kind: message.kind,
      sender: message.sender,
      payload: message.payload,
      revive,
      status: pending,
    });
    await events.append(tx, {
      type: EVENT['inbox.enqueued'],
      task: recipient,
      payload: { messageId, seq, kind: message.kind, sender: message.sender, revive },
    });
    crashPoints.hit('inbox.before-wake');

    const wake = wakeChange(recipient, revive);
    if (wake === undefined) return { messageId, seq, recipient };
    const woken = await this.write(tx, recipient, wake);
    await events.append(tx, {
      type: EVENT['task.queued'],
      task: woken,
      payload: { cause: 'message', messageId, from: recipient.status },
    });
    return { messageId, seq, recipient: woken };
  }

  /**
   * Marks the task's pending messages as delivered to step `stepNo` and writes `inbox.delivered`.
   * Call it in the step's commit transaction, under the task's lock.
   */
  async markDelivered(
    tx: RuntimeTx,
    task: TaskRow,
    messageIds: readonly string[],
    stepNo: number,
  ): Promise<void> {
    if (messageIds.length === 0) return;
    const rows = await tx
      .update(runtimeInbox)
      .set({ status: delivered, deliveredStep: stepNo, deliveredAt: sql`now()` })
      .where(
        and(
          eq(runtimeInbox.recipientId, task.taskId),
          eq(runtimeInbox.status, pending),
          inArray(runtimeInbox.messageId, [...messageIds]),
        ),
      )
      .returning({ messageId: runtimeInbox.messageId, seq: runtimeInbox.seq });
    if (rows.length === 0) return;
    rows.sort((left, right) => left.seq - right.seq);
    await this.deps.events.append(tx, {
      type: EVENT['inbox.delivered'],
      task,
      payload: { messageIds: rows.map((row) => row.messageId), stepNo },
    });
  }

  /** The task's pending messages by `seq`. */
  loadPending(tx: RuntimeTx, taskId: string): Promise<MessageRow[]> {
    return tx
      .select()
      .from(runtimeInbox)
      .where(
        and(eq(runtimeInbox.recipientId, taskId), eq(runtimeInbox.status, pending)),
      )
      .orderBy(asc(runtimeInbox.seq));
  }

  /** A guarded write of the locked recipient; it cannot be fenced while the lock is held. */
  private async write(
    tx: RuntimeTx,
    recipient: TaskRow,
    change: TaskChange,
  ): Promise<TaskRow> {
    const row = await this.deps.tasks.transition(
      tx,
      {
        taskId: recipient.taskId,
        from: [TaskStatusSchema.parse(recipient.status)],
        attempt: recipient.attempt,
      },
      change,
    );
    if (!row) {
      throw new Error(`Write of locked task ${recipient.taskId} matched no row`);
    }
    return row;
  }
}
