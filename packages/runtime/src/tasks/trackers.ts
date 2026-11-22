import {
  type TaskStatus,
  TaskStatusSchema,
  type TrackerStatus,
  TrackerStatusSchema,
} from '@agent-os/contracts';
import { DATABASE, type Database, RuntimeTrackersRepository } from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import type { TaskFailure } from './guarded-transition';

/** A task of a tracker as `trackers.list` returns it. */
export interface TrackerTask {
  readonly taskId: string;
  readonly status: TaskStatus;
  /** The outcome of a `completed` task. */
  readonly result: unknown;
  /** The reason of a `failed` task. */
  readonly failure: TaskFailure | null;
}

/** A tracker with its tasks in the order the step gave them (deep-agents/design-task.md). */
export interface Tracker {
  readonly trackerId: string;
  readonly status: TrackerStatus;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly tasks: readonly TrackerTask[];
}

/** Task trackers as their owner reads them, over the queries of `RuntimeTrackersRepository`. */
@Injectable()
export class Trackers {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(RuntimeTrackersRepository) private readonly rows: RuntimeTrackersRepository,
  ) {}

  /**
   * The trackers of the owner's task, oldest first, each with its tasks and their outcomes. Another
   * owner's, a deleted or a missing task gives `[]`.
   */
  async list(taskId: string, ownerId: string): Promise<Tracker[]> {
    const trackers = await this.rows.listOwned(this.db, taskId, ownerId);
    if (trackers.length === 0) return [];

    const tasks = await this.rows.listTasks(
      this.db,
      trackers.map((tracker) => tracker.trackerId),
    );

    return trackers.map((tracker) => ({
      trackerId: tracker.trackerId,
      status: TrackerStatusSchema.parse(tracker.status),
      createdAt: tracker.createdAt,
      finishedAt: tracker.finishedAt,
      tasks: tasks
        .filter((task) => task.trackerId === tracker.trackerId)
        .map((task) => ({
          taskId: task.taskId,
          status: TaskStatusSchema.parse(task.status),
          result: task.result,
          failure: task.failure as TaskFailure | null,
        })),
    }));
  }
}
