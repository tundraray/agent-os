import { randomUUID } from 'node:crypto';
import type { Logger } from '@agent-os/common';
import {
  type DecisionStatus,
  DecisionStatusSchema,
  RuntimeEventTypeSchema,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import {
  Db,
  RuntimeDecisionsRepository,
  type RuntimeDecisionRow,
  type RuntimeDecisionView,
  RuntimeTasksRepository,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { RuntimeError } from '../errors';
import { EventLog } from '../events/event-log';
import type { TaskRow } from '../tasks/guarded-transition';
import { RUNTIME_LOGGER } from '../runtime.tokens';
import { writeHeld } from '../tasks/task-end';
import { Tasks } from '../tasks/tasks';

/** A request of a tree, in any status, as `listTree` returns it. */
export interface TreeDecision {
  readonly decisionId: string;
  readonly taskId: string;
  readonly rootId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly status: DecisionStatus;
  /** The employee's resolution; null until `resolved`. */
  readonly resolution: unknown;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

/** What `resolve` did: wrote the resolution, or found the request no longer open. */
export type ResolveOutcome = 'resolved' | 'already_resolved';

/** What an `await_decision` step asks. */
export interface DecisionRequest {
  kind: string;
  payload: unknown;
}

interface DecisionsDeps {
  db: Db;
  repository: RuntimeDecisionsRepository;
  tasks: Tasks;
  taskRows: RuntimeTasksRepository;
  events: EventLog;
  logger: Logger;
}

const { open } = DecisionStatusSchema.enum;
const { queued, waiting } = TaskStatusSchema.enum;
const EVENT = RuntimeEventTypeSchema.enum;

/**
 * Decision requests (design-runtime.md, Запросы решений; KD-2, Invariant 3): a step opens one with
 * `await_decision`, the employee resolves it once, and the resolution is handed to exactly one
 * committed step — the one whose commit sets `delivered_step`.
 */
@Injectable()
export class Decisions {
  private readonly deps: DecisionsDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(RuntimeDecisionsRepository) repository: RuntimeDecisionsRepository,
    @Inject(Tasks) tasks: Tasks,
    @Inject(RuntimeTasksRepository) taskRows: RuntimeTasksRepository,
    @Inject(EventLog) events: EventLog,
    @Inject(RUNTIME_LOGGER) logger: Logger,
  ) {
    this.deps = {
      db,
      repository,
      tasks,
      taskRows,
      events,
      logger: logger.child({ service: 'decisions' }),
    };
  }

  /**
   * Opens the request of an `await_decision` step with `decision.requested`, in the step's commit
   * transaction. The caller puts the task in `waiting` (`decision`).
   */
  async open(task: TaskRow, request: DecisionRequest): Promise<RuntimeDecisionRow> {
    const row = await this.deps.repository.insert({
      decisionId: randomUUID(),
      taskId: task.taskId,
      rootId: task.rootId,
      ownerId: task.ownerId,
      kind: request.kind,
      payload: request.payload ?? null,
    });
    await this.deps.events.append({
      type: EVENT['decision.requested'],
      task,
      payload: { decisionId: row.decisionId, kind: row.kind },
    });
    return row;
  }

  /** The task's resolved request that no committed step has received yet; read by the claim. */
  loadUndelivered(taskId: string): Promise<RuntimeDecisionRow | undefined> {
    return this.deps.repository.findUndelivered(taskId);
  }

  /** Hands the request to step `stepNo`, in that step's commit transaction. */
  markDelivered(decisionId: string, stepNo: number): Promise<void> {
    return this.deps.repository.markDelivered(decisionId, stepNo);
  }

  /**
   * Writes the resolution once and queues the waiting task, with `decision.resolved` and
   * `task.queued`. A request that is `resolved` or `cancelled` (a stop closed it) gives
   * `already_resolved` and changes nothing. Throws `DECISION_NOT_FOUND` for a missing or another
   * owner's request, or one of a deleted tree.
   */
  async resolve(
    decisionId: string,
    ownerId: string,
    resolution: unknown,
  ): Promise<ResolveOutcome> {
    const { db, logger } = this.deps;
    const startedAt = Date.now();
    const fields = { decisionId, ownerId };
    try {
      const outcome = await db.transaction(() =>
        this.resolveIn(decisionId, ownerId, resolution),
      );
      logger.info('decision resolve answered', {
        ...fields,
        taskId: outcome.taskId,
        rootId: outcome.rootId,
        outcome: outcome.outcome,
        durationMs: Date.now() - startedAt,
      });
      return outcome.outcome;
    } catch (error) {
      logger.warn('decision not resolved', {
        ...fields,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /** The owner's request in any status; `undefined` for a missing or another owner's one. */
  async get(decisionId: string, ownerId: string): Promise<TreeDecision | undefined> {
    const row = await this.deps.repository.findOwned(decisionId, ownerId);
    return row === undefined ? undefined : toTreeDecision(row);
  }

  /**
   * All requests of the owner's tree in any status, in creation order; `[]` for another owner's
   * or no tree.
   */
  async listTree(rootId: string, ownerId: string): Promise<TreeDecision[]> {
    const rows = await this.deps.repository.listTree(rootId, ownerId);
    return rows.map(toTreeDecision);
  }

  private async resolveIn(
    decisionId: string,
    ownerId: string,
    resolution: unknown,
  ): Promise<{ outcome: ResolveOutcome; taskId: string; rootId: string }> {
    const { repository, tasks, taskRows, events } = this.deps;
    const found = await repository.findTaskAndOwner(decisionId);
    if (found?.ownerId !== ownerId) {
      throw new RuntimeError('DECISION_NOT_FOUND', `Decision ${decisionId} not found`);
    }
    const task = await taskRows.find(found.taskId);
    const request = await repository.find(decisionId);
    // A request of a deleted tree answers as a missing one: the stop cancelled it, and
    // `already_resolved` would tell the deleted tree apart.
    if (!task || task.deletedAt !== null || !request) {
      throw new RuntimeError('DECISION_NOT_FOUND', `Decision ${decisionId} not found`);
    }
    const answered = { outcome: 'already_resolved', taskId: task.taskId, rootId: task.rootId } as const;
    if (request.status !== open) return answered;

    // The task row first, as a stop writes them. A stop or another resolve that came first has
    // taken the task out of its wait and closed the request (Invariant 3): nothing to do then.
    const held = await tasks.hold({
      taskId: task.taskId,
      from: [waiting],
      waitReason: WaitReasonSchema.enum.decision,
    });
    if (!held || !(await repository.resolve(decisionId, resolution))) return answered;
    const woken = await writeHeld(tasks, held, { kind: 'set', status: queued });
    await events.append({
      type: EVENT['decision.resolved'],
      task: woken,
      payload: { decisionId },
    });
    await events.append({
      type: EVENT['task.queued'],
      task: woken,
      payload: { cause: 'decision', decisionId, from: waiting },
    });
    return { outcome: 'resolved', taskId: task.taskId, rootId: task.rootId };
  }
}

function toTreeDecision(row: RuntimeDecisionView): TreeDecision {
  return { ...row, status: DecisionStatusSchema.parse(row.status) };
}
