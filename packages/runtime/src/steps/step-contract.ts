import type { Logger } from '@agent-os/common';
import type { z } from 'zod';
import type { SavepointResult } from '../tasks/transaction-retry';

/**
 * Why the step's `signal` was aborted; it is the signal's `reason`. After the signal a next step of
 * the same task may already run (design-runtime.md, Invariant 1).
 */
export type StepSignalReason =
  'interrupted' | 'stopped' | 'shutdown' | 'step_timeout';

/** A message that waited in the task's inbox when the step began. */
export interface StepMessage {
  readonly messageId: string;
  /** Insertion order over the whole queue; a recipient's messages come in this order. */
  readonly seq: number;
  /** Message kind of the upper layer; `child_finished` is the runtime's own. */
  readonly kind: string;
  readonly payload: unknown;
  readonly revive: boolean;
  readonly createdAt: Date;
}

/** Result of `StepContext.guard`: `work` committed, or the attempt is not current and nothing was written. */
export type GuardResult<T> =
  { outcome: 'committed'; value: T } | { outcome: 'fenced' };

/** What the handler knows about the step (design-runtime.md, StepContext). */
export interface StepContext {
  readonly taskId: string;
  readonly rootId: string;
  /** `null` for a root task. */
  readonly parentId: string | null;
  /** `null` for the platform's own work (`knowledge.embed`). */
  readonly ownerId: string | null;
  /** 0 for a root task. */
  readonly depth: number;
  readonly type: string;
  /** Checked by the handler's `inputSchema` when the task was created. */
  readonly input: unknown;
  /** How many steps of the task are committed already. */
  readonly stepNo: number;
  /**
   * The step continues one the recovery sweeper found lost (`recoveries > 0`); false after an
   * interrupt and after a requeue on shutdown.
   */
  readonly resumedAfterLoss: boolean;
  /**
   * Messages pending at the start of the step, by `seq`; the step's commit marks them delivered.
   * The answer to a question is its `child_finished` here.
   */
  readonly messages: readonly StepMessage[];
  /** Aborted with a {@link StepSignalReason} as `signal.reason`. */
  readonly signal: AbortSignal;
  /** Bound to `taskId`, `rootId`, `ownerId`, `stepNo` and the attempt. */
  readonly logger: Logger;
  /**
   * Runs `work` — the handler's writes to its own tables, no model or external call — in a short
   * transaction of its own, if the attempt is still current and the task is not interrupted or
   * stopped. `fenced` means nothing was written.
   */
  guard<T>(work: () => Promise<T>): Promise<GuardResult<T>>;
}

/** A message to put in an inbox, by the rules of `inbox.enqueue`; the owner is the task's. */
export interface EnqueueMessage {
  readonly recipientId: string;
  /** Upper-layer kind; `child_finished` is reserved by the runtime. */
  readonly kind: string;
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

/** Most awaited children one commit creates (data-model/design-runtime.md, «Итог шага…»). */
export const AWAITED_CHILDREN_MAX = 100;

/**
 * The task type of a question to a human (data-model/design-runtime.md, KD-3, «Тип вопроса»):
 * reserved by the runtime, no handler runs it. Its task waits in `waiting` (`human`) until
 * `TaskControl.answer` completes it with the answer as its `result`, or a stop ends it.
 */
export const QUESTION_TASK_TYPE = 'runtime.question';

/** What `effects.ask` asks; it is the input of the question task. */
export interface Question {
  /** The upper layer's kind of question. */
  readonly kind: string;
  /** JSON up to `INBOX_PAYLOAD_MAX_BYTES`. */
  readonly payload: unknown;
}

/** A child task to create, by the rules of `spawn`. */
export interface ChildTask {
  readonly type: string;
  readonly input: unknown;
  /**
   * The parent waits for this child (KD-2): only with the outcome `wait`, at most
   * {@link AWAITED_CHILDREN_MAX} per commit. The child gets `awaited_step`, the `step_no` this
   * commit writes to the parent.
   */
  readonly awaited?: boolean;
}

/** Writes of the runtime a step may add to its commit transaction. */
export interface StepEffects {
  /**
   * Creates a child task in `queued` with the same owner and root and one level deeper, and returns
   * its `taskId` at once. An awaited child makes the outcome `wait` wait for the children
   * (`children`); a broken rule of {@link ChildTask.awaited} is `invalid_step_result`.
   */
  spawn(child: ChildTask): Promise<string>;
  /**
   * Asks a human (KD-3): creates a child of the {@link QUESTION_TASK_TYPE} in `waiting` (`human`)
   * with `awaited_step`, as an awaited child, and the question as its input, and returns its
   * `taskId`. Only with the outcome `wait`, at most one per commit, the payload within
   * `INBOX_PAYLOAD_MAX_BYTES`; otherwise `invalid_step_result`. The task then waits for its
   * children (`children`), and the answer comes as the question's `child_finished`.
   */
  ask(question: Question): Promise<string>;
  /**
   * Puts a message in an inbox by the rules of `inbox.enqueue`; a message to a question task is
   * `TASK_NOT_FOUND`.
   */
  enqueue(message: EnqueueMessage): Promise<EnqueuedMessage>;
  /**
   * Hands over the ready object of a task of a live type spawned in this commit: the runtime keeps
   * it once the commit succeeds, and the task's first step runs on it instead of a `restore`. An
   * id not spawned in this commit or of a stateless type is `invalid_step_result`.
   */
  adopt(taskId: string, object: LiveTask): void;
  /**
   * Runs `fn` in a savepoint of the commit: an error of `fn` rolls back its writes and everything
   * it did through these effects (children, adopted objects, messages, a question), and comes back
   * as the result; an error after which the transaction cannot go on is thrown, so the commit
   * repeats whole. A broken rule of the effects stays: the commit still fails as
   * `invalid_step_result`.
   */
  savepoint<T>(fn: () => Promise<T>): Promise<SavepointResult<T>>;
}

/** The outcome of a step (design-runtime.md, StepResult). */
export type StepOutcome =
  /** Another step is needed: the task becomes `queued`. */
  | { outcome: 'continue' }
  /**
   * Nothing to do until the next message: `waiting` (`messages`), or `queued` when one already
   * waits. With awaited children or a question of this commit: `waiting` (`children`) whatever
   * waits.
   */
  | { outcome: 'wait' }
  /** The task is `completed`; the parent is notified with `result`. */
  | { outcome: 'complete'; result: unknown }
  /** The task is `failed` with the upper layer's reason; the parent is notified. */
  | { outcome: 'fail'; reason: string; message: string };

/** Result of a step: its outcome and, optionally, the handler's writes inside the commit transaction. */
export type StepResult = StepOutcome & {
  commit?: (effects: StepEffects) => Promise<void>;
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

/** What `restore` knows about a task: the fields of {@link StepContext} that never change. */
export type LiveTaskIdentity = Pick<
  StepContext,
  'taskId' | 'rootId' | 'parentId' | 'ownerId' | 'depth' | 'type' | 'input'
>;

/**
 * The object of one task of a live type, kept in memory between the task's steps by the one
 * process that executes steps. The database stays the source of truth: the object is dropped on
 * every end of a step other than a commit, and the next step gets a restored one.
 */
export interface LiveTask {
  /** As `TaskHandler.step`; one step at a time, except a cut-off step that has not ended yet. */
  step(ctx: StepContext): Promise<StepResult>;
  /**
   * Called after the step's commit succeeded and before the task's next step: the place to take
   * the committed state in. An exception, or a call longer than 30 s, drops the object.
   */
  committed?(ctx: StepContext): Promise<void>;
  /**
   * The runtime let the object go. A step that was cut off, timed out or shut down may still be
   * running on it.
   */
  dispose?(): void;
}

/** A task type whose tasks are {@link LiveTask} objects; registered with `registerLive`. */
export interface LiveTaskType {
  /** Unique in the process, among live and stateless types together. */
  readonly type: string;
  /** Checks `input` when a task of this type is created. */
  readonly inputSchema: z.ZodType;
  /** Builds the task's object from the database. A failure fails the step with `handler_error`. */
  restore(task: LiveTaskIdentity): Promise<LiveTask>;
}
