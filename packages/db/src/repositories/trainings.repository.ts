import {
  type Comparison,
  TaskStatusSchema,
  type TestRunPlan,
  type TestRunTest,
} from '@agent-os/contracts';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
} from 'drizzle-orm';
import type { Db } from '../db';
import { conversations, runtimeTasks, trainings } from '../schema';

/** A row of `trainings`. */
export type TrainingRow = typeof trainings.$inferSelect;

/** A row whose agent is set: every training, and a test run once its agent is created. */
export type AgentTrainingRow = TrainingRow & {
  readonly agentId: string;
  readonly baseVersionId: string;
};

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

  /** The owner's test run whose root task has not finished, with its conversation's title (KD-8). */
  async runningTestRun(
    ownerId: string,
  ): Promise<{ id: string; title: string | null } | undefined> {
    const [row] = await this.db.client
      .select({ id: trainings.id, title: conversations.title })
      .from(trainings)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, trainings.id))
      .innerJoin(conversations, eq(conversations.id, trainings.id))
      .where(
        and(
          eq(runtimeTasks.ownerId, ownerId),
          isNotNull(trainings.description),
          inArray(runtimeTasks.status, unfinished),
        ),
      )
      .limit(1);
    return row;
  }

  /** The agent's latest finished training outside a deleted tree; test runs left out. */
  async latestFinished(agentId: string): Promise<TrainingRow | undefined> {
    const [row] = await this.db.client
      .select({ training: trainings })
      .from(trainings)
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, trainings.id))
      .where(
        and(
          eq(trainings.agentId, agentId),
          isNull(trainings.description),
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

  /** Sets a test run's agent once; false when it already had one. */
  async setAgent(
    id: string,
    agent: { readonly agentId: string; readonly baseVersionId: string },
  ): Promise<boolean> {
    const changed = await this.db.client
      .update(trainings)
      .set(agent)
      .where(and(eq(trainings.id, id), isNull(trainings.agentId)))
      .returning({ id: trainings.id });
    return changed.length > 0;
  }

  /** Replaces a test run's whole list of tests. */
  async writeTests(id: string, tests: TestRunTest[]): Promise<void> {
    await this.db.client
      .update(trainings)
      .set({ tests })
      .where(eq(trainings.id, id));
  }

  /** Writes a test run's plan and the tests it names. */
  async setPlan(
    id: string,
    plan: TestRunPlan,
    tests: TestRunTest[],
  ): Promise<void> {
    await this.db.client
      .update(trainings)
      .set({ plan, tests })
      .where(eq(trainings.id, id));
  }

  /** Records the agent the trainer offered, only while there is no plan; false when there is one. */
  async setOffered(id: string, agentId: string): Promise<boolean> {
    const changed = await this.db.client
      .update(trainings)
      .set({ offeredAgentId: agentId })
      .where(and(eq(trainings.id, id), isNull(trainings.plan)))
      .returning({ id: trainings.id });
    return changed.length > 0;
  }

  /** Takes the offered agent once; false when the test run was taken already. */
  async take(id: string): Promise<boolean> {
    const changed = await this.db.client
      .update(trainings)
      .set({ takenAgentId: trainings.offeredAgentId })
      .where(and(eq(trainings.id, id), isNull(trainings.takenAgentId)))
      .returning({ id: trainings.id });
    return changed.length > 0;
  }

  async setTakenThread(id: string, threadId: string): Promise<void> {
    await this.db.client
      .update(trainings)
      .set({ takenThreadId: threadId })
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

  /** Records the latest switch of a test run's version: who and when, at every activation. */
  async markActivated(id: string, userId: string): Promise<void> {
    await this.db.client
      .update(trainings)
      .set({ activatedAt: new Date(), activatedBy: userId })
      .where(eq(trainings.id, id));
  }
}
