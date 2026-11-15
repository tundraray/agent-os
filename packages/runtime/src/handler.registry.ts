import type { Logger } from '@agent-os/common';
import type { z } from 'zod';
import type { RuntimeTx } from './runtime-tx.js';

/**
 * Why the step's `signal` was aborted; it is the signal's `reason`. After the signal a next step of
 * the same task may already run (design-runtime.md, Invariant 1).
 */
export type StepSignalReason =
  | 'interrupted'
  | 'stopped'
  | 'shutdown'
  | 'lease_lost'
  | 'step_timeout';

/** A message that waited in the task's inbox when the step began. */
export interface StepMessage {
  readonly messageId: string;
  /** Position in the recipient's queue; messages come in this order. */
  readonly seq: number;
  /** Message kind of the upper layer; `child_finished` is the runtime's own. */
  readonly kind: string;
  /** Task or employee that sent the message. */
  readonly sender: string;
  readonly payload: unknown;
  readonly revive: boolean;
  readonly createdAt: Date;
}

/** The decision request the task waited for, with its resolution; handed to one step. */
export interface StepDecision {
  readonly decisionId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly resolution: unknown;
}

/** Result of `StepContext.guard`: `work` committed, or the attempt is not current and nothing was written. */
export type GuardResult<T> =
  | { outcome: 'committed'; value: T }
  | { outcome: 'fenced' };

/** What the handler knows about the step (design-runtime.md, StepContext). */
export interface StepContext {
  readonly taskId: string;
  readonly rootId: string;
  /** `null` for a root task. */
  readonly parentId: string | null;
  readonly ownerId: string;
  /** 0 for a root task. */
  readonly depth: number;
  readonly type: string;
  /** Checked by the handler's `inputSchema` when the task was created. */
  readonly input: unknown;
  /** How many steps of the task are committed already. */
  readonly stepNo: number;
  /** The previous attempt of this step ended without a commit (crash, interrupt or sweeper requeue). */
  readonly resumedAfterLoss: boolean;
  /** Messages pending at the start of the step, by `seq`; the step's commit marks them delivered. */
  readonly messages: readonly StepMessage[];
  /** The resolved request the task waited for, or `null`. */
  readonly decision: StepDecision | null;
  /** Aborted with a {@link StepSignalReason} as `signal.reason`. */
  readonly signal: AbortSignal;
  /** Bound to `taskId`, `rootId`, `ownerId`, `stepNo` and the attempt. */
  readonly logger: Logger;
  /**
   * Runs `work` — the handler's writes to its own tables, no model or external call — in a short
   * transaction of its own, if the attempt is still current and the task is not interrupted or
   * stopped. `fenced` means nothing was written.
   */
  guard<T>(work: (tx: RuntimeTx) => Promise<T>): Promise<GuardResult<T>>;
}

/** A message to put in an inbox, by the rules of `inbox.enqueue`; the owner is the task's. */
export interface EnqueueMessage {
  readonly recipientId: string;
  /** Upper-layer kind; `child_finished` is reserved by the runtime. */
  readonly kind: string;
  /** Task or employee that sends the message. */
  readonly sender: string;
  /** JSON up to `INBOX_PAYLOAD_MAX_BYTES`. */
  readonly payload: unknown;
  /** Queue a finished recipient again. */
  readonly revive?: boolean;
}

/** A message put in an inbox. */
export interface EnqueuedMessage {
  readonly messageId: string;
  readonly seq: number;
}

/** Writes of the runtime a step may add to its commit transaction. */
export interface StepEffects {
  /**
   * Creates a child task in `queued` with the same owner and root and one level deeper, and returns
   * its `taskId` at once.
   */
  spawn(child: { type: string; input: unknown }): Promise<string>;
  /** Puts a message in an inbox by the rules of `inbox.enqueue`. */
  enqueue(message: EnqueueMessage): Promise<EnqueuedMessage>;
  /**
   * Writes an upper-layer event; its type carries the package prefix (`agents.`), never `task.`,
   * `inbox.` or `decision.`.
   */
  emit(type: string, payload: unknown): Promise<void>;
}

/** The outcome of a step (design-runtime.md, StepResult). */
export type StepOutcome =
  /** Another step is needed: the task becomes `queued`. */
  | { outcome: 'continue' }
  /** Nothing to do until the next message: `waiting` (`messages`), or `queued` when one already waits. */
  | { outcome: 'wait' }
  /** Opens a decision request: `waiting` (`decision`). */
  | { outcome: 'await_decision'; kind: string; payload: unknown }
  /** The task is `completed`; the parent is notified with `result`. */
  | { outcome: 'complete'; result: unknown }
  /** The task is `failed` with the upper layer's reason; the parent is notified. */
  | { outcome: 'fail'; reason: string; message: string };

/** Result of a step: its outcome and, optionally, the handler's writes inside the commit transaction. */
export type StepResult = StepOutcome & {
  commit?: (tx: RuntimeTx, effects: StepEffects) => Promise<void>;
};

/**
 * Handler port of one task type (design-runtime.md, Порт обработчика). An exception of `step`
 * fails the task with `handler_error`.
 */
export interface TaskHandler {
  /** Unique in the process. */
  readonly type: string;
  /** Checks `input` when a task of this type is created. */
  readonly inputSchema: z.ZodType;
  step(ctx: StepContext): Promise<StepResult>;
}

/**
 * Handlers of this process, registered before `Runtime.start()`. Creation accepts and the
 * dispatcher claims only the types registered here.
 */
export class HandlerRegistry {
  private readonly handlers = new Map<string, TaskHandler>();

  /** Throws on a second handler of the same type, which stops the start. */
  register(handler: TaskHandler): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`Handler of task type "${handler.type}" is already registered`);
    }
    this.handlers.set(handler.type, handler);
  }

  get(type: string): TaskHandler | undefined {
    return this.handlers.get(type);
  }

  /** Registered task types. */
  types(): string[] {
    return [...this.handlers.keys()];
  }
}
