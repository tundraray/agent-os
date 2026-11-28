import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  CHILD_FINISHED_KIND,
  type ChildFinishedPayload,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import {
  Db,
  RuntimeInboxRepository,
  type RuntimeInboxRow,
  RuntimeTasksRepository,
  type RuntimeTaskRow,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { RuntimeError } from '../errors';
import { isFinished, type TaskChange } from '../tasks/guarded-transition';
import {
  type EnqueuedMessage,
  QUESTION_TASK_TYPE,
  type StepMessage,
} from '../steps/step-contract';
import type { RuntimeConfig } from '../runtime-config';
import { RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import { taskLogFields, writeHeld } from '../tasks/task-end';
import { Tasks } from '../tasks/tasks';
import { withTxRetry } from '../tasks/transaction-retry';

/** Size of a JSON value as UTF-8 text: the measure of `INBOX_PAYLOAD_MAX_BYTES`. */
export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

/**
 * `PAYLOAD_TOO_LARGE` for a message payload over `maxBytes`, or `undefined`. Every writer of an
 * upper-layer message checks it before `insertMessage` (`enqueue`, `effects.enqueue`, `interrupt`);
 * the runtime's own `child_finished` is bounded by the result it carries.
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
const RESERVED_KINDS: readonly string[] = [CHILD_FINISHED_KIND];

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
  payload: row.payload,
  revive: row.revive,
  createdAt: row.createdAt,
});

const { queued, waiting, completed } = TaskStatusSchema.enum;
const { messages, children } = WaitReasonSchema.enum;

/** A message to write; the caller has checked its kind and payload size. */
export interface NewMessage {
  recipientId: string;
  /** Owner of the recipient; another owner's task is as absent as a missing one. `null` between platform tasks. */
  ownerId: string | null;
  kind: string;
  payload: unknown;
  /** Queue a finished recipient again; a `child_finished` notice never has it. */
  revive?: boolean;
  /** Set by the end of a child on its `child_finished` only: what the wake-up rule reads (KD-2). */
  finishedChild?: FinishedChild;
}

/** The ended child of a `child_finished`. */
export interface FinishedChild {
  /** The parent's `step_no` that awaits the child; null for a background child. */
  awaitedStep: number | null;
  status: ChildFinishedPayload['status'];
}

export interface InsertedMessage {
  messageId: string;
  seq: number;
  /** The recipient after the message, woken or not. */
  recipient: RuntimeTaskRow;
  /** The message moved the recipient to `queued`. */
  woken: boolean;
}

interface InboxDeps {
  db: Db;
  repository: RuntimeInboxRepository;
  tasks: Tasks;
  taskRows: RuntimeTasksRepository;
  logger: Logger;
  /** `INBOX_PAYLOAD_MAX_BYTES`. */
  inboxPayloadMaxBytes: number;
}

/**
 * The wake-up a message brings to its recipient (data-model/design-runtime.md, «Правило
 * пробуждения»): waiting for messages → `queued`; waiting for its children →
 * `queued` by the `child_finished` of an awaited child (`awaited_step` = the recipient's `step_no`)
 * that did not complete, or that completed while no awaited child is unfinished any more — counted
 * after the recipient's row was written, so two children that end at once count one after the
 * other; finished with `revive` → `queued` with its outcome cleared; otherwise (queued, running,
 * finished without `revive`, any other message to a task waiting for its children) nothing changes
 * and the message waits. A question task gets no message at all ({@link Inbox.insertMessage}).
 */
async function wakeChange(
  taskRows: RuntimeTasksRepository,
  recipient: RuntimeTaskRow,
  message: { revive: boolean; finishedChild?: FinishedChild },
): Promise<TaskChange | undefined> {
  const wake: TaskChange = { kind: 'set', status: queued };
  if (recipient.status === waiting) {
    if (recipient.waitReason === messages) return wake;
    if (recipient.waitReason !== children) return undefined;
    const child = message.finishedChild;
    if (child === undefined || child.awaitedStep !== recipient.stepNo) {
      return undefined;
    }
    if (child.status !== completed) return wake;
    // Relies on READ COMMITTED: this statement takes a fresh snapshot after the parent's row was
    // written here (waiting for any other writer of it), so a sibling that ended in a transaction
    // that held the parent's row first is already counted finished.
    const unfinished = await taskRows.countUnfinishedAwaited(
      recipient.taskId,
      recipient.stepNo,
    );
    return unfinished === 0 ? wake : undefined;
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
 * The task inbox: the only writer of `runtime_inbox` rows, through `RuntimeInboxRepository`. A message
 * and the recipient's wake-up commit together.
 */
@Injectable()
export class Inbox {
  private readonly deps: InboxDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(RuntimeInboxRepository) repository: RuntimeInboxRepository,
    @Inject(Tasks) tasks: Tasks,
    @Inject(RuntimeTasksRepository) taskRows: RuntimeTasksRepository,
    @Inject(RUNTIME_LOGGER) logger: Logger,
    @Inject(RUNTIME_CONFIG) config: RuntimeConfig,
  ) {
    this.deps = {
      db,
      repository,
      tasks,
      taskRows,
      logger: logger.child({ service: 'inbox' }),
      inboxPayloadMaxBytes: config.inboxPayloadMaxBytes,
    };
  }

  /**
   * Puts an upper-layer message in the recipient's queue in its own transaction (design-runtime.md,
   * Очередь): `TASK_NOT_FOUND` for a missing or another owner's recipient, `PAYLOAD_TOO_LARGE` over
   * `INBOX_PAYLOAD_MAX_BYTES`; nothing is written then. `child_finished` is the runtime's own
   * kind, and only the end of a child names the finished child the wake-up rule reads.
   */
  async enqueue(
    message: Omit<NewMessage, 'finishedChild'>,
  ): Promise<EnqueuedMessage> {
    const { db, logger, inboxPayloadMaxBytes } = this.deps;
    const startedAt = Date.now();
    const fields = {
      taskId: message.recipientId,
      ownerId: message.ownerId,
      kind: message.kind,
      revive: message.revive ?? false,
    };
    try {
      const reserved = reservedKindProblem(message.kind);
      if (reserved !== undefined) throw new Error(reserved);
      const tooLarge = payloadTooLarge(message.payload, inboxPayloadMaxBytes);
      if (tooLarge) throw tooLarge;
      const inserted = await withTxRetry(
        {
          db,
          logger,
          operation: 'inbox.enqueue',
          taskId: message.recipientId,
        },
        () => this.insertMessage(message),
      );
      logger.info('message enqueued', {
        ...fields,
        ...taskLogFields(inserted.recipient),
        messageId: inserted.messageId,
        seq: inserted.seq,
        status: inserted.recipient.status,
        woken: inserted.woken,
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
   * Holds the recipient's row, writes the waiting message, then wakes the recipient by the wake-up
   * rule. Throws `TASK_NOT_FOUND` for a missing, another owner's or a deleted recipient, and for a
   * question task: nobody but `TaskControl.answer` ends it, so no agent can answer or revive it
   * (KD-3).
   *
   * Holding the row (`Tasks.hold`, any status) is the first write (design-runtime.md, «Правило
   * пробуждения»), so the message and a step commit, a command or another message of the same task
   * go one after the other: the row it returns is the one the wake-up rule reads and writes. A step
   * commit that came first has left the task `waiting` and the message wakes it; one that comes
   * second sees the message. The message's `seq` is the table's insertion order, so the messages of
   * one recipient keep the order of these held writes.
   */
  async insertMessage(message: NewMessage): Promise<InsertedMessage> {
    const { repository, tasks, taskRows } = this.deps;
    const notFound = () =>
      new RuntimeError(
        'TASK_NOT_FOUND',
        `Task ${message.recipientId} not found`,
      );
    const found = await taskRows.findOwned(
      message.recipientId,
      message.ownerId,
    );
    if (!found || found.type === QUESTION_TASK_TYPE) throw notFound();
    const recipient = await tasks.hold({
      taskId: found.taskId,
      from: TaskStatusSchema.options,
    });
    // Deleted while this message waited for the deletion: it must not revive the root.
    if (!recipient || recipient.deletedAt !== null) throw notFound();
    const messageId = randomUUID();
    const revive = message.revive ?? false;
    const seq = await repository.insert({
      messageId,
      recipientId: recipient.taskId,
      kind: message.kind,
      payload: message.payload,
      revive,
    });
    await tasks.signal(recipient);

    const wake = await wakeChange(taskRows, recipient, {
      revive,
      finishedChild: message.finishedChild,
    });
    if (wake === undefined) return { messageId, seq, recipient, woken: false };
    const woken = await writeHeld(tasks, recipient, wake);
    return { messageId, seq, recipient: woken, woken: true };
  }

  /**
   * Marks the task's pending messages delivered (`delivered_at`).
   * Call it in the step's commit transaction.
   */
  async markDelivered(
    task: RuntimeTaskRow,
    messageIds: readonly string[],
  ): Promise<void> {
    if (messageIds.length === 0) return;
    const rows = await this.deps.repository.markDelivered(
      task.taskId,
      messageIds,
    );
    if (rows.length === 0) return;
    await this.deps.tasks.signal(task);
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
