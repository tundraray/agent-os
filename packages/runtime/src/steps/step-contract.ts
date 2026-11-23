import type { Logger } from '@agent-os/common';
import type { z } from 'zod';

/**
 * Why the step's `signal` was aborted; it is the signal's `reason`. After the signal a next step of
 * the same task may already run (design-runtime.md, Invariant 1).
 */
export type StepSignalReason =
  'interrupted' | 'stopped' | 'shutdown' | 'step_timeout';

/** A message that waited in the task's inbox when the step began. */
export interface StepMessage {
  readonly messageId: string;
  /** Position in the recipient's queue; messages come in this order. */
  readonly seq: number;
  /** Message kind of the upper layer; `child_finished` and `tasks_finished` are the runtime's own. */
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
  /** The previous attempt of this step ended without a commit (crash, interrupt or shutdown). */
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
  guard<T>(work: () => Promise<T>): Promise<GuardResult<T>>;
}

/** A message to put in an inbox, by the rules of `inbox.enqueue`; the owner is the task's. */
export interface EnqueueMessage {
  readonly recipientId: string;
  /** Upper-layer kind; `child_finished` and `tasks_finished` are reserved by the runtime. */
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

/** Most tasks one tracker takes (deep-agents/design-task.md, KD-6): a limit of the runtime. */
export const TRACKER_MAX_TASKS = 100;

/** A child task to create, by the rules of `spawn`. */
export interface ChildTask {
  readonly type: string;
  readonly input: unknown;
}

/** A tracker opened by a step's commit: its id and the ids of its tasks in the order given. */
export interface OpenedTracker {
  readonly trackerId: string;
  readonly taskIds: readonly string[];
}

/** Writes of the runtime a step may add to its commit transaction. */
export interface StepEffects {
  /**
   * Creates a child task in `queued` with the same owner and root and one level deeper, and returns
   * its `taskId` at once.
   */
  spawn(child: ChildTask): Promise<string>;
  /**
   * Opens a tracker (deep-agents/design-task.md, KD-1): creates from one to
   * {@link TRACKER_MAX_TASKS} tasks as `spawn` does, each linked to a new tracker. Only with the
   * outcome `wait` and once per commit: the task then waits for its tasks (`tasks`), and one
   * `tasks_finished` wakes it when the last of them ends. A broken rule is `invalid_step_result`.
   */
  openTracker(tasks: readonly ChildTask[]): Promise<OpenedTracker>;
  /** Puts a message in an inbox by the rules of `inbox.enqueue`. */
  enqueue(message: EnqueueMessage): Promise<EnqueuedMessage>;
  /**
   * Writes an upper-layer event; its type carries the package prefix (`agents.`), never `task.`,
   * `inbox.` or `decision.`.
   */
  emit(type: string, payload: unknown): Promise<void>;
  /**
   * Hands over the ready object of a task of a live type spawned in this commit: the runtime keeps
   * it once the commit succeeds, and the task's first step runs on it instead of a `restore`. An
   * id not spawned in this commit or of a stateless type is `invalid_step_result`.
   */
  adopt(taskId: string, object: LiveTask): void;
}

/** The outcome of a step (design-runtime.md, StepResult). */
export type StepOutcome =
  /** Another step is needed: the task becomes `queued`. */
  | { outcome: 'continue' }
  /**
   * Nothing to do until the next message: `waiting` (`messages`), or `queued` when one already
   * waits. After `openTracker`: `waiting` (`tasks`) whatever waits.
   */
  | { outcome: 'wait' }
  /** Opens a decision request: `waiting` (`decision`). */
  | { outcome: 'await_decision'; kind: string; payload: unknown }
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
