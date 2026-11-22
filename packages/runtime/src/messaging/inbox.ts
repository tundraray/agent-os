import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  CHILD_FINISHED_KIND,
  RuntimeEventTypeSchema,
  TASKS_FINISHED_KIND,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import {
  Db,
  RuntimeInboxRepository,
  type RuntimeInboxRow,
  RuntimeTasksRepository,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { CrashPoints } from '../crash-points';
import { RuntimeError } from '../errors';
import { EventLog } from '../events/event-log';
import {
  isFinished,
  type TaskChange,
  type TaskRow,
} from '../tasks/guarded-transition';
import type { EnqueuedMessage, StepMessage } from '../steps/step-contract';
import type { RuntimeConfig } from '../runtime-config';
import { RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import { writeHeld } from '../tasks/task-end';
import { Tasks } from '../tasks/tasks';

/** Size of a JSON value as UTF-8 text: the measure of `INBOX_PAYLOAD_MAX_BYTES`. */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

/**
 * `PAYLOAD_TOO_LARGE` for a message payload over `maxBytes`, or `undefined`. Every writer of an
 * upper-layer message checks it before `insertMessage` (`enqueue`, `effects.enqueue`, `interrupt`);
 * the runtime's own `child_finished` is bounded by the result it carries, `tasks_finished` by
 * `TRACKER_MAX_TASKS`.
 */
export function payloadTooLarge(
  payload: unknown,
  maxBytes: number,
): RuntimeError | undefined {
  const bytes = jsonByteLength(payload);
  if (bytes <= maxBytes) return undefined;
  return new RuntimeError(
    'PAYLOAD_TOO_LARGE',
    `message payload is ${bytes} bytes, over ${maxBytes}`,
  );
}

/** Message kinds only the runtime writes. */
const RESERVED_KINDS: readonly string[] = [
  CHILD_FINISHED_KIND,
  TASKS_FINISHED_KIND,
];

/**
 * Why an upper-layer message may not have this kind, or `undefined`. Every writer of an
 * upper-layer message checks it before `insertMessage`, as {@link payloadTooLarge}.
 */
export function reservedKindProblem(kind: string): string | undefined {
  return RESERVED_KINDS.includes(kind)
    ? `message kind "${kind}" is reserved by the runtime`
    : undefined;
}

/** A message row as a step and the queue tray see it. */
export const toStepMessage = (row: RuntimeInboxRow): StepMessage => ({
  messageId: row.messageId,
  seq: row.seq,
  kind: row.kind,
  sender: row.sender,
  payload: row.payload,
  revive: row.revive,
  createdAt: row.createdAt,
});

const { queued, waiting } = TaskStatusSchema.enum;
const { messages, interrupted, tasks: tasksReason } = WaitReasonSchema.enum;
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

interface InboxDeps {
  db: Db;
  repository: RuntimeInboxRepository;
  tasks: Tasks;
  taskRows: RuntimeTasksRepository;
  events: EventLog;
  crashPoints: CrashPoints;
  logger: Logger;
  /** `INBOX_PAYLOAD_MAX_BYTES`. */
  inboxPayloadMaxBytes: number;
}

/**
 * The wake-up a message brings to its recipient (plan Notes 3, KD-3): waiting for messages or
 * interrupted → `queued`; waiting for its tasks → `queued` by its `tasks_finished` only
 * (deep-agents/design-task.md, KD-3); finished with `revive` → `queued` with its outcome cleared;
 * otherwise (waiting for a decision, queued, running, finished without `revive`) nothing changes.
 */
function wakeChange(
  recipient: TaskRow,
  message: { kind: string; revive: boolean },
): TaskChange | undefined {
  if (recipient.status === waiting) {
    const wakes =
      recipient.waitReason === messages ||
      recipient.waitReason === interrupted ||
      (recipient.waitReason === tasksReason &&
        message.kind === TASKS_FINISHED_KIND);
    return wakes ? { kind: 'set', status: queued } : undefined;
  }
  if (isFinished(recipient.status) && message.revive) {
    return {
      kind: 'set',
      status: queued,
      fields: { result: null, failure: null },
    };
  }
  return undefined;
}

/**
 * The task inbox: the only writer of `runtime_inbox` rows, through `RuntimeInboxRepository`. A message,
 * its event and the recipient's wake-up commit together.
 */
@Injectable()
export class Inbox {
  private readonly deps: InboxDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(RuntimeInboxRepository) repository: RuntimeInboxRepository,
    @Inject(Tasks) tasks: Tasks,
    @Inject(RuntimeTasksRepository) taskRows: RuntimeTasksRepository,
    @Inject(EventLog) events: EventLog,
    @Inject(CrashPoints) crashPoints: CrashPoints,
    @Inject(RUNTIME_LOGGER) logger: Logger,
    @Inject(RUNTIME_CONFIG) config: RuntimeConfig,
  ) {
    this.deps = {
      db,
      repository,
      tasks,
      taskRows,
      events,
      crashPoints,
      logger: logger.child({ service: 'inbox' }),
      inboxPayloadMaxBytes: config.inboxPayloadMaxBytes,
    };
  }

  /**
   * Puts an upper-layer message in the recipient's queue in its own transaction (design-runtime.md,
   * Очередь): `TASK_NOT_FOUND` for a missing or another owner's recipient, `PAYLOAD_TOO_LARGE` over
   * `INBOX_PAYLOAD_MAX_BYTES`; nothing is written then. `child_finished` and `tasks_finished` are
   * the runtime's own kinds.
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
      const reserved = reservedKindProblem(message.kind);
      if (reserved !== undefined) throw new Error(reserved);
      const tooLarge = payloadTooLarge(message.payload, inboxPayloadMaxBytes);
      if (tooLarge) throw tooLarge;
      const inserted = await db.transaction(() => this.insertMessage(message));
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
    const rows = await this.deps.repository.listPendingOwned(taskId, ownerId);
    return rows.map(toStepMessage);
  }

  /**
   * Takes the recipient's next message number, writes the `pending` message and `inbox.enqueued`,
   * then wakes the recipient by the wake-up rule with `task.queued`. Throws `TASK_NOT_FOUND` for a
   * missing, another owner's or a deleted recipient.
   *
   * Taking the number is the first write and it is a write of the recipient's row, so the message
   * and a step commit, a command or another message of the same task go one after the other: the
   * row it returns is the one the wake-up rule reads and writes. A step commit that came first has
   * left the task `waiting` and the message wakes it; one that comes second sees the message.
   */
  async insertMessage(message: NewMessage): Promise<InsertedMessage> {
    const { repository, tasks, taskRows, events, crashPoints } = this.deps;
    const notFound = () =>
      new RuntimeError(
        'TASK_NOT_FOUND',
        `Task ${message.recipientId} not found`,
      );
    const found = await taskRows.findOwned(
      message.recipientId,
      message.ownerId,
    );
    if (!found) throw notFound();
    const recipient = await tasks.takeMessageSeq(found.taskId);
    // Deleted while this message waited for the deletion: it must not revive the root.
    if (!recipient || recipient.deletedAt !== null) throw notFound();
    const seq = recipient.nextMessageSeq - 1;
    const messageId = randomUUID();
    const revive = message.revive ?? false;
    await repository.insert({
      messageId,
      recipientId: recipient.taskId,
      ownerId: recipient.ownerId,
      seq,
      kind: message.kind,
      sender: message.sender,
      payload: message.payload,
      revive,
    });
    await events.append({
      type: EVENT['inbox.enqueued'],
      task: recipient,
      payload: {
        messageId,
        seq,
        kind: message.kind,
        sender: message.sender,
        revive,
      },
    });
    crashPoints.hit('inbox.before-wake');

    const wake = wakeChange(recipient, { kind: message.kind, revive });
    if (wake === undefined) return { messageId, seq, recipient };
    const woken = await writeHeld(tasks, recipient, wake);
    await events.append({
      type: EVENT['task.queued'],
      task: woken,
      payload: { cause: 'message', messageId, from: recipient.status },
    });
    return { messageId, seq, recipient: woken };
  }

  /**
   * Marks the task's pending messages as delivered to step `stepNo` and writes `inbox.delivered`.
   * Call it in the step's commit transaction.
   */
  async markDelivered(
    task: TaskRow,
    messageIds: readonly string[],
    stepNo: number,
  ): Promise<void> {
    if (messageIds.length === 0) return;
    const rows = await this.deps.repository.markDelivered(
      task.taskId,
      messageIds,
      stepNo,
    );
    if (rows.length === 0) return;
    rows.sort((left, right) => left.seq - right.seq);
    await this.deps.events.append({
      type: EVENT['inbox.delivered'],
      task,
      payload: { messageIds: rows.map((row) => row.messageId), stepNo },
    });
  }

  /** The task's pending messages by `seq`. */
  loadPending(taskId: string): Promise<RuntimeInboxRow[]> {
    return this.deps.repository.listPending(taskId);
  }

  /** Whether a message with `revive` waits in the task's inbox. */
  hasPendingRevive(taskId: string): Promise<boolean> {
    return this.deps.repository.hasPendingRevive(taskId);
  }
}
