import type { Logger } from '@agent-os/common';
import { TaskStatusSchema } from '@agent-os/contracts';
import type { Db, RuntimeInboxRow, RuntimeTaskRow } from '@agent-os/db';
import type { CrashPoints } from '../crash-points';
import type { Inbox } from '../messaging/inbox';
import type { Tasks } from '../tasks/tasks';
import { withTxRetry } from '../tasks/transaction-retry';
import type { GuardResult, StepContext, StepMessage } from './step-contract';
import { toStepMessage } from '../messaging/inbox';

const { running } = TaskStatusSchema.enum;

/** Services a step context writes through. */
export interface StepContextDeps {
  db: Db;
  tasks: Tasks;
  inbox: Inbox;
  crashPoints: CrashPoints;
  /** The runtime's logger; the step's logger is its child. */
  logger: Logger;
}

/** What the claim knows about the step. */
export interface ClaimedStep {
  /** The task row right after the claim (`running`, its new attempt). */
  task: RuntimeTaskRow;
  /** Messages pending at the start of the step, read in the claim transaction. */
  messages: readonly RuntimeInboxRow[];
  signal: AbortSignal;
}

/**
 * The context of one claimed step (design-runtime.md, StepContext). Besides the handler's view it
 * carries what the step's commit needs: the attempt (the fencing token) and the messages it took.
 */
export class TaskStepContext implements StepContext {
  readonly taskId: string;
  readonly rootId: string;
  readonly parentId: string | null;
  readonly ownerId: string | null;
  readonly depth: number;
  readonly type: string;
  readonly input: unknown;
  readonly stepNo: number;
  readonly resumedAfterLoss: boolean;
  readonly messages: readonly StepMessage[];
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** The claim's attempt: only it may write (Invariant 1). */
  readonly attempt: number;

  constructor(
    private readonly deps: StepContextDeps,
    claimed: ClaimedStep,
  ) {
    const { task } = claimed;
    this.taskId = task.taskId;
    this.rootId = task.rootId;
    this.parentId = task.parentId;
    this.ownerId = task.ownerId;
    this.depth = task.depth;
    this.type = task.type;
    this.input = task.input;
    this.stepNo = task.stepNo;
    this.attempt = task.attempt;
    // Only the recovery sweeper counts a loss; an interrupt and a shutdown requeue reset it.
    this.resumedAfterLoss = task.recoveries > 0;
    this.messages = [...claimed.messages]
      .sort((left, right) => left.seq - right.seq)
      .map(toStepMessage);
    this.signal = claimed.signal;
    this.logger = deps.logger.child({
      taskId: task.taskId,
      rootId: task.rootId,
      ownerId: task.ownerId,
      type: task.type,
      stepNo: task.stepNo,
      attempt: task.attempt,
    });
  }

  /** Ids of the messages the step took; its commit marks them delivered. */
  get messageIds(): string[] {
    return this.messages.map((message) => message.messageId);
  }

  /**
   * One short transaction: `work` runs only if the task is `running` with this attempt, checked by
   * a write of the task row (`Tasks.hold`), so a stop or an interrupt waits for `work`'s commit.
   * An interrupt, a stop or a requeue raises the attempt, so `fenced` follows from it; nothing is
   * written then.
   */
  guard<T>(work: () => Promise<T>): Promise<GuardResult<T>> {
    return this.guarded('step.guard', () => work());
  }

  /**
   * As {@link guard}; after `work` the same transaction marks the step's messages delivered, in the
   * order of the step's commit (the task row, the handler's rows, the inbox).
   */
  async guardWithDelivery<T>(work: () => Promise<T>): Promise<GuardResult<T>> {
    const result = await this.guarded(
      'step.guardWithDelivery',
      async (task) => {
        const value = await work();
        await this.deps.inbox.markDelivered(task, this.messageIds);
        return value;
      },
    );
    if (result.outcome === 'committed') {
      this.logger.info('step messages delivered by guard', {
        messageIds: this.messageIds,
      });
    }
    return result;
  }

  private async guarded<T>(
    operation: string,
    work: (task: RuntimeTaskRow) => Promise<T>,
  ): Promise<GuardResult<T>> {
    const startedAt = Date.now();
    try {
      const result = await withTxRetry(
        {
          db: this.deps.db,
          logger: this.logger,
          operation,
          taskId: this.taskId,
        },
        async (): Promise<GuardResult<T>> => {
          const own = await this.deps.tasks.hold({
            taskId: this.taskId,
            from: [running],
            attempt: this.attempt,
          });
          if (!own) return { outcome: 'fenced' };
          return { outcome: 'committed', value: await work(own) };
        },
      );
      const durationMs = Date.now() - startedAt;
      if (result.outcome === 'fenced') {
        this.logger.warn('guard fenced: the attempt is no longer current', {
          operation,
          outcome: 'fenced',
          durationMs,
        });
        return result;
      }
      this.logger.debug('guard committed', {
        operation,
        outcome: 'committed',
        durationMs,
      });
      this.deps.crashPoints.hit('step.after-guard');
      return result;
    } catch (error) {
      this.logger.warn('guard rolled back', {
        operation,
        outcome: 'error',
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }
}
