import { type Comparison, TaskStatusSchema } from '@agent-os/contracts';
import { and, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type { Db } from '../db';
import { runtimeTasks, trainings } from '../schema';

/** A row of `trainings`. */
export type TrainingRow = typeof trainings.$inferSelect;

const { queued, running, waiting } = TaskStatusSchema.enum;
const unfinished = [queued, running, waiting];

/**
 * Drizzle queries of `trainings` (self-learning design-training.md, KD-6): whether a training runs is the
 * status of its root task, whose id is the training's.
 */
export class TrainingsRepository {
  constructor(private readonly db: Db) {}

  async insert(row: typeof trainings.$inferInsert): Promise<void> {
    await this.db.client.insert(trainings).values(row);
  }

  async find(id: string): Promise<TrainingRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(trainings)
      .where(eq(trainings.id, id));
    return row;
  }

  /** The agent's training whose root task has not finished. */
  async running(agentId: string): Promise<TrainingRow | undefined> {
    const [row] = await this.db.client
      .select({ training: trainings })
      .from(trainings)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, trainings.id))
      .where(
        and(
          eq(trainings.agentId, agentId),
          inArray(runtimeTasks.status, unfinished),
        ),
      );
    return row?.training;
  }

  /** The agent's latest finished training outside a deleted tree. */
  async latestFinished(agentId: string): Promise<TrainingRow | undefined> {
    const [row] = await this.db.client
      .select({ training: trainings })
      .from(trainings)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, trainings.id))
      .where(
        and(
          eq(trainings.agentId, agentId),
          notInArray(runtimeTasks.status, unfinished),
          isNull(runtimeTasks.deletedAt),
        ),
      )
      .orderBy(desc(runtimeTasks.createdSeq))
      .limit(1);
    return row?.training;
  }

  /** Replaces the whole list; only the trainer's step writes it. */
  async writeComparisons(id: string, comparisons: Comparison[]): Promise<void> {
    await this.db.client
      .update(trainings)
      .set({ comparisons })
      .where(eq(trainings.id, id));
  }

  async setChanges(id: string, changes: string): Promise<void> {
    await this.db.client
      .update(trainings)
      .set({ changes })
      .where(eq(trainings.id, id));
  }

  /** Marks the stop at the cap once; false when it was already marked. */
  async markCapped(id: string): Promise<boolean> {
    const changed = await this.db.client
      .update(trainings)
      .set({ cappedAt: new Date() })
      .where(and(eq(trainings.id, id), isNull(trainings.cappedAt)))
      .returning({ id: trainings.id });
    return changed.length > 0;
  }

  /** Records who switched the proposed version on and when, once; false when it was already on. */
  async activate(id: string, userId: string): Promise<boolean> {
    const changed = await this.db.client
      .update(trainings)
      .set({ activatedAt: new Date(), activatedBy: userId })
      .where(and(eq(trainings.id, id), isNull(trainings.activatedAt)))
      .returning({ id: trainings.id });
    return changed.length > 0;
  }
}
