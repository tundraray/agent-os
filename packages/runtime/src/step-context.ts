import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from '@agent-os/common';
import { TaskStatusSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import { sql } from 'drizzle-orm';
import type { CrashPoints } from './crash-points.js';
import type { TaskRow } from './guarded-transition.js';
import type {
  GuardResult,
  StepContext,
  StepDecision,
  StepMessage,
} from './handler.registry.js';
import type { DecisionRow } from './decisions.js';
import { type MessageRow, toStepMessage } from './inbox.js';
import type { RuntimeTx } from './runtime-tx.js';
import type { TaskRepository } from './task.repository.js';

const { running } = TaskStatusSchema.enum;

/** Services a step context writes through. */
export interface StepContextDeps {
  db: Database;
  tasks: TaskRepository;
  crashPoints: CrashPoints;
  /** The runtime's logger; the step's logger is its child. */
  logger: Logger;
  /** `RUNTIME_LEASE_MS`: the bound of a `guard` transaction. */
  leaseMs: number;
}

/** What the claim knows about the step. */
export interface ClaimedStep {
  /** The task row right after the claim (`running`, its new attempt). */
  task: TaskRow;
  /** Messages pending at the start of the step, read in the claim transaction. */
  messages: readonly MessageRow[];
  /**
   * The resolved request no committed step has received yet, read in the claim transaction; the
   * step's commit marks it delivered, so it comes in exactly one committed step.
   */
  decision: DecisionRow | undefined;
  signal: AbortSignal;
}

/**
 * Bounds both timeouts of the current transaction by `ms` for this transaction only (`set_config`
 * with `true`, the value as a parameter — ADR-0003), so that a stuck holder of the task row lock
 * does not outlive the lease.
 */
export async function boundTransaction(tx: RuntimeTx, ms: number): Promise<void> {
  const timeout = String(ms);
  await tx.execute(
    sql`select set_config('statement_timeout', ${timeout}, true), set_config('idle_in_transaction_session_timeout', ${timeout}, true)`,
  );
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
  /** Set inside the `work` of an open {@link guard}, in that async context only. */
  private readonly guardedWork = new AsyncLocalStorage<true>();

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
   * One short transaction: the task row FOR UPDATE — held to the commit, so neither a command nor
   * the step's own commit changes the task meanwhile — then `work` only if the task is `running`
   * with this attempt. An interrupt, a stop or a requeue raises the attempt, so `fenced` follows
   * from it; nothing is written then.
   */
  async guard<T>(work: (tx: RuntimeTx) => Promise<T>): Promise<GuardResult<T>> {
    if (this.guardedWork.getStore()) {
      // The nested transaction would wait on the row lock the outer one holds.
      throw new Error(
        `guard of task ${this.taskId} attempt ${this.attempt} called inside guard work`,
      );
    }
    const startedAt = Date.now();
    try {
      const result = await this.deps.db.transaction(
        async (tx): Promise<GuardResult<T>> => {
          await boundTransaction(tx, this.deps.leaseMs);
          const own = await this.deps.tasks.lock(tx, this.taskId);
          if (own?.status !== running || own.attempt !== this.attempt) {
            return { outcome: 'fenced' };
          }
          const value = await this.guardedWork.run(true, () => work(tx));
          return { outcome: 'committed', value };
        },
      );
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
