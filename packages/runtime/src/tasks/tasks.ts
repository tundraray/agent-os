import { type TaskStatus, TaskStatusSchema } from '@agent-os/contracts';
import {
  type NewRuntimeTaskRow,
  runtimeTasks,
  RuntimeTasksRepository,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { RuntimeError } from '../errors';
import {
  assertAllowed,
  isFinished,
  type TaskChange,
  type TaskGuard,
  type TaskRow,
} from './guarded-transition';

const { running, waiting } = TaskStatusSchema.enum;

const nextAttempt = sql`${runtimeTasks.attempt} + 1`;

/** Columns that follow a new status: no wait reason, `finished_at` only when finished. */
function leaveStatus(status: TaskStatus): PgUpdateSetSource<typeof runtimeTasks> {
  return {
    status,
    waitReason: null,
    finishedAt: isFinished(status) ? sql`now()` : null,
  };
}

function changeColumns(change: TaskChange): PgUpdateSetSource<typeof runtimeTasks> {
  switch (change.kind) {
    case 'claim':
      return {
        status: running,
        attempt: nextAttempt,
        stepClaims: sql`${runtimeTasks.stepClaims} + 1`,
      };
    case 'wait':
      return {
        ...change.fields,
        ...leaveStatus(waiting),
        waitReason: change.reason,
        ...(change.fence ? { attempt: nextAttempt } : {}),
      };
    case 'set':
      return {
        ...change.fields,
        ...(change.status === undefined ? {} : leaveStatus(change.status)),
        ...(change.fence ? { attempt: nextAttempt } : {}),
      };
  }
}

/**
 * The writes of a task row: the rules of the state diagram over the queries of
 * `RuntimeTasksRepository`. Reads go to the repository directly.
 */
@Injectable()
export class Tasks {
  constructor(@Inject(RuntimeTasksRepository) private readonly rows: RuntimeTasksRepository) {}

  /** Inserts a task in `queued`. An id already taken is `TASK_EXISTS`. */
  async insert(task: NewRuntimeTaskRow): Promise<TaskRow> {
    const row = await this.rows.insert(task);
    if (row === undefined) {
      throw new RuntimeError('TASK_EXISTS', `Task ${task.taskId} exists`);
    }
    return row;
  }

  /**
   * The only change of a task row besides {@link insert} and the deletion mark: one UPDATE guarded
   * by the allowed source statuses and, when given, by the attempt (fencing, ADR-0001) and the wait
   * reason. Returns the updated row, or `undefined` when the guard matched nothing — the write is
   * fenced and dropped.
   */
  async transition(guard: TaskGuard, change: TaskChange): Promise<TaskRow | undefined> {
    assertAllowed(guard, change);
    return this.rows.updateGuarded(guard, changeColumns(change));
  }
}
