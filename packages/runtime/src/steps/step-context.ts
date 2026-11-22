import type { Logger } from '@agent-os/common';
import { TaskStatusSchema } from '@agent-os/contracts';
import type { Db, RuntimeDecisionRow, RuntimeInboxRow } from '@agent-os/db';
import type { CrashPoints } from '../crash-points';
import type { TaskRow } from '../tasks/guarded-transition';
import type { Tasks } from '../tasks/tasks';
import type {
  GuardResult,
  StepContext,
  StepDecision,
  StepMessage,
} from './step-contract';
import { toStepMessage } from '../messaging/inbox';

const { running } = TaskStatusSchema.enum;

/** Services a step context writes through. */
export interface StepContextDeps {
  db: Db;
  tasks: Tasks;
  crashPoints: CrashPoints;
  /** The runtime's logger; the step's logger is its child. */
  logger: Logger;
}

/** What the claim knows about the step. */
export interface ClaimedStep {
  /** The task row right after the claim (`running`, its new attempt). */
  task: TaskRow;
  /** Messages pending at the start of the step, read in the claim transaction. */
  messages: readonly RuntimeInboxRow[];
  /**
   * The resolved request no committed step has received yet, read in the claim transaction; the
   * step's commit marks it delivered, so it comes in exactly one committed step.
   */
  decision: RuntimeDecisionRow | undefined;
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
  readonly ownerId: string;
  readonly depth: number;
  readonly type: string;
  readonly input: unknown;
  readonly stepNo: number;
  readonly resumedAfterLoss: boolean;
  readonly messages: readonly StepMessage[];
  readonly decision: StepDecision | null;
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
    // The claim counts itself: more than one claim of this step means an earlier one was lost.
    this.resumedAfterLoss = task.stepClaims > 1;
    this.messages = [...claimed.messages]
      .sort((left, right) => left.seq - right.seq)
      .map(toStepMessage);
    const { decision } = claimed;
    this.decision = decision
      ? {
          decisionId: decision.decisionId,
          kind: decision.kind,
          payload: decision.payload,
          resolution: decision.resolution,
        }
      : null;
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
  async guard<T>(work: () => Promise<T>): Promise<GuardResult<T>> {
    const startedAt = Date.now();
    try {
      const result = await this.deps.db.transaction(async (): Promise<GuardResult<T>> => {
        const own = await this.deps.tasks.hold({
          taskId: this.taskId,
          from: [running],
          attempt: this.attempt,
        });
        if (!own) return { outcome: 'fenced' };
        return { outcome: 'committed', value: await work() };
      });
      const durationMs = Date.now() - startedAt;
      if (result.outcome === 'fenced') {
        this.logger.warn('guard fenced: the attempt is no longer current', {
          outcome: 'fenced',
          durationMs,
        });
        return result;
      }
      this.logger.debug('guard committed', { outcome: 'committed', durationMs });
      this.deps.crashPoints.hit('step.after-guard');
      return result;
    } catch (error) {
      this.logger.warn('guard rolled back', {
        outcome: 'error',
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }
}
