import { type TaskStatus, TaskStatusSchema } from '@agent-os/contracts';
import {
  type NewRuntimeTaskRow,
  type RuntimeTaskRow,
  type RuntimeTaskRowGuard,
  RuntimeTasksRepository,
  type RuntimeTaskWrite,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { RuntimeError } from '../errors';
import {
  assertAllowed,
  isFinished,
  type TaskChange,
} from './guarded-transition';

const { running, waiting } = TaskStatusSchema.enum;

/**
 * The `LISTEN` channel of the runtime: one notification with `{"rootId"}` per committed transaction
 * that changed a task's status or its queue. The web and the dispatcher's loop learn by it that a
 * tree changed; it carries nothing else.
 */
export const RUNTIME_TREE_CHANNEL = 'runtime_tree';

/** A new status: no wait reason, `finished_at` only when finished. */
const leaveStatus = (status: TaskStatus): RuntimeTaskWrite => ({
  status,
  finishedNow: isFinished(status),
});

function changeColumns(change: TaskChange): RuntimeTaskWrite {
  switch (change.kind) {
    case 'claim':
      return { status: running, nextAttempt: true };
    case 'wait':
      return {
        ...change.fields,
        ...leaveStatus(waiting),
        waitReason: change.reason,
        nextAttempt: change.fence,
      };
    case 'set':
      return {
        ...change.fields,
        ...(change.status !== undefined && leaveStatus(change.status)),
        nextAttempt: change.fence,
      };
  }
}

/**
 * The writes of a task row: the rules of the state diagram over the queries of
 * `RuntimeTasksRepository`. Reads go to the repository directly.
 */
@Injectable()
export class Tasks {
  constructor(
    @Inject(RuntimeTasksRepository)
    private readonly rows: RuntimeTasksRepository,
  ) {}

  /**
   * Inserts a task in `queued` and signals its tree. An id already taken is `TASK_EXISTS`; an
   * exclusive key held by an unfinished task of the type is `null`. Neither leaves a failed
   * statement behind: the open transaction goes on.
   */
  insert(
    task: NewRuntimeTaskRow & { exclusiveKey?: null },
  ): Promise<RuntimeTaskRow>;
  insert(task: NewRuntimeTaskRow): Promise<RuntimeTaskRow | null>;
  async insert(task: NewRuntimeTaskRow): Promise<RuntimeTaskRow | null> {
    const row = await this.rows.insert(task);
    if (row === undefined) {
      if (task.exclusiveKey == null || (await this.rows.exists(task.taskId))) {
        throw new RuntimeError('TASK_EXISTS', `Task ${task.taskId} exists`);
      }
      return null;
    }
    await this.signal(row.rootId);
    return row;
  }

  /** The tree's signal on {@link RUNTIME_TREE_CHANNEL}, sent when the open transaction commits. */
  signal(rootId: string): Promise<void> {
    return this.rows.notify(RUNTIME_TREE_CHANNEL, rootId);
  }

  /**
   * The only change of a task row besides {@link insert} and the deletion mark: one UPDATE guarded
   * by the allowed source statuses and, when given, by the attempt (fencing, ADR-0001) and the wait
   * reason. Returns the updated row, or `undefined` when the guard matched nothing — the write is
   * fenced and dropped. A written change of status signals the tree.
   */
  async transition(
    guard: RuntimeTaskRowGuard,
    change: TaskChange,
  ): Promise<RuntimeTaskRow | undefined> {
    assertAllowed(guard, change);
    const write = changeColumns(change);
    const row = await this.rows.updateGuarded(guard, write);
    if (row !== undefined && write.status !== undefined) {
      await this.signal(row.rootId);
    }
    return row;
  }

  /**
   * The first statement of a transaction that goes on to write the task: one UPDATE that changes
   * only `updated_at`, guarded as {@link transition}. Returns the row as it is now, or `undefined`
   * when the guard matches nothing. Postgres makes every other writer of the row wait for this
   * transaction, so the returned row stays current until it ends and the guarded writes after it
   * match; a writer that waited sees the row this transaction left.
   */
  hold(guard: RuntimeTaskRowGuard): Promise<RuntimeTaskRow | undefined> {
    return this.rows.updateGuarded(guard, {});
  }
}
