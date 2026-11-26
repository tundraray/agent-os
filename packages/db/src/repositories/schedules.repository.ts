import {
  type ScheduleRunStatus,
  type ScheduleSkipReason,
  SchedulePauseReasonSchema,
  ScheduleRunOutcomeSchema,
  type ScheduleState,
  ScheduleStateSchema,
  ScheduleTargetSchema,
} from '@agent-os/contracts';
import { and, asc, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import {
  conversations,
  runtimeTasks,
  scheduleRuns,
  schedules,
} from '../schema';

export type ScheduleRow = typeof schedules.$inferSelect;
export type ScheduleRunRow = typeof scheduleRuns.$inferSelect;

export type NewScheduleRow = Omit<
  typeof schedules.$inferInsert,
  'id' | 'createdAt' | 'updatedAt'
>;

export type NewScheduleRunRow = Omit<
  typeof scheduleRuns.$inferInsert,
  'createdAt'
>;

/** The fields a change of a schedule writes. */
export type ScheduleChange = Partial<
  Pick<
    ScheduleRow,
    | 'name'
    | 'instruction'
    | 'agentId'
    | 'rule'
    | 'timeZone'
    | 'language'
    | 'target'
    | 'state'
    | 'pausedBecause'
    | 'nextRunAt'
    | 'ruleSetAt'
  >
>;

/** A schedule with the title and deletion mark of the conversation it was created in. */
export type OwnedScheduleRow = {
  readonly schedule: ScheduleRow;
  /** Null without a conversation; empty while it has no title. */
  readonly conversationTitle: string | null;
  readonly conversationDeletedAt: Date | null;
};

/** A history row with the deletion mark of its run's conversation. */
export type ScheduleRunListRow = {
  readonly run: ScheduleRunRow;
  readonly conversationDeletedAt: Date | null;
};

/** A `starting` row with its schedule. */
export type StartingRunRow = {
  readonly run: ScheduleRunRow;
  readonly schedule: ScheduleRow;
};

const { active, paused } = ScheduleStateSchema.enum;
const { starting, started, skipped } = ScheduleRunOutcomeSchema.enum;

/** Active by the next term, then paused, then completed (design-schedules.md, «Маршруты»). */
const listOrder = sql`case ${schedules.state} when ${active} then 0 when ${paused} then 1 else 2 end`;

/** The `runtime_tasks` row of a schedule's conversation, for its deletion mark. */
const scheduleConversationTask = sql`${runtimeTasks.taskId} = ${schedules.conversationId}`;

/**
 * Drizzle queries of `schedules` and `schedule_runs` (schedules-search-memory design-schedules.md, Data Model).
 * The service holds the claim of a term: its first write is `hold` or `claimDue` (rule 5), and a history row
 * changes only from `starting` (rule 3).
 */
export class SchedulesRepository {
  constructor(private readonly db: Db) {}

  async insert(row: NewScheduleRow): Promise<ScheduleRow> {
    const [inserted] = await this.db.client
      .insert(schedules)
      .values(row)
      .returning();
    if (inserted === undefined)
      throw new Error('schedules insert returned no row');
    return inserted;
  }

  /** The owner's schedule with its conversation; another owner's is as absent as a missing one. */
  async findOwned(
    id: string,
    ownerId: string,
  ): Promise<OwnedScheduleRow | undefined> {
    const [row] = await this.owned().where(
      and(eq(schedules.id, id), eq(schedules.ownerId, ownerId)),
    );
    return row;
  }

  /** Every schedule of the owner in the list order. */
  listOwned(ownerId: string): Promise<OwnedScheduleRow[]> {
    return this.owned()
      .where(eq(schedules.ownerId, ownerId))
      .orderBy(
        listOrder,
        asc(schedules.nextRunAt),
        desc(schedules.createdAt),
        desc(schedules.id),
      );
  }

  /** Changes the owner's schedule; `undefined` for another owner's or a missing one. */
  async update(
    id: string,
    ownerId: string,
    change: ScheduleChange,
  ): Promise<ScheduleRow | undefined> {
    const [row] = await this.db.client
      .update(schedules)
      .set({ ...change, updatedAt: sql`now()` })
      .where(and(eq(schedules.id, id), eq(schedules.ownerId, ownerId)))
      .returning();
    return row;
  }

  /** Deletes the owner's schedule with its history; false for another owner's or a missing one. */
  async delete(id: string, ownerId: string): Promise<boolean> {
    const deleted = await this.db.client
      .delete(schedules)
      .where(and(eq(schedules.id, id), eq(schedules.ownerId, ownerId)))
      .returning({ id: schedules.id });
    return deleted.length > 0;
  }

  /**
   * Writes the schedule's row without changing it: the first write of a manual run, so claims of one schedule
   * go one after the other (rule 5).
   */
  async hold(id: string): Promise<ScheduleRow | undefined> {
    const [row] = await this.db.client
      .update(schedules)
      .set({ id: sql`${schedules.id}` })
      .where(eq(schedules.id, id))
      .returning();
    return row;
  }

  /**
   * Moves an active schedule from the term `expectedDueAt` to `next`, only while it still waits for that term
   * (KD-1); `undefined` — a claim came first, or the schedule changed.
   */
  async claimDue(
    id: string,
    expectedDueAt: Date,
    next: { readonly nextRunAt: Date | null; readonly state: ScheduleState },
  ): Promise<ScheduleRow | undefined> {
    const [row] = await this.db.client
      .update(schedules)
      .set({ ...next, updatedAt: sql`now()` })
      .where(
        and(
          eq(schedules.id, id),
          eq(schedules.state, active),
          eq(schedules.nextRunAt, expectedDueAt),
        ),
      )
      .returning();
    return row;
  }

  /** Active schedules whose term has come, earliest first. */
  listDue(now: Date, limit: number): Promise<ScheduleRow[]> {
    return this.db.client
      .select()
      .from(schedules)
      .where(and(eq(schedules.state, active), lte(schedules.nextRunAt, now)))
      .orderBy(asc(schedules.nextRunAt), asc(schedules.id))
      .limit(limit);
  }

  /**
   * Pauses the owner's `this_conversation` schedules created in the conversation, active or paused, with the
   * reason `conversation_deleted`; returns the ones it changed.
   */
  pauseForConversation(
    conversationId: string,
    ownerId: string,
  ): Promise<ScheduleRow[]> {
    return this.db.client
      .update(schedules)
      .set({
        state: paused,
        pausedBecause: SchedulePauseReasonSchema.enum.conversation_deleted,
        nextRunAt: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(schedules.conversationId, conversationId),
          eq(schedules.ownerId, ownerId),
          eq(schedules.target, ScheduleTargetSchema.enum.this_conversation),
          inArray(schedules.state, [active, paused]),
        ),
      )
      .returning();
  }

  // ---------- History ----------

  /** Writes history rows; a second row of a term of a schedule breaks the unique index (rule 1). */
  /** The inserted rows as the database wrote them. */
  async insertRuns(
    rows: readonly NewScheduleRunRow[],
  ): Promise<ScheduleRunRow[]> {
    if (rows.length === 0) return [];
    return this.db.client
      .insert(scheduleRuns)
      .values([...rows])
      .returning();
  }

  /** Every `starting` row with its schedule. */
  listStarting(): Promise<StartingRunRow[]> {
    return this.db.client
      .select({ run: scheduleRuns, schedule: schedules })
      .from(scheduleRuns)
      .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
      .where(eq(scheduleRuns.outcome, starting))
      .orderBy(asc(scheduleRuns.dueAt), asc(scheduleRuns.id));
  }

  /** A page of the schedule's history after `after`, latest terms first (`due_at` DESC, `id` DESC). */
  runsPage(
    scheduleId: string,
    limit: number,
    after?: { readonly dueAt: Date; readonly id: string },
  ): Promise<ScheduleRunListRow[]> {
    return this.runs()
      .where(
        and(
          eq(scheduleRuns.scheduleId, scheduleId),
          after === undefined
            ? undefined
            : or(
                lt(scheduleRuns.dueAt, after.dueAt),
                and(
                  eq(scheduleRuns.dueAt, after.dueAt),
                  lt(scheduleRuns.id, after.id),
                ),
              ),
        ),
      )
      .orderBy(desc(scheduleRuns.dueAt), desc(scheduleRuns.id))
      .limit(limit);
  }

  /** The schedule's latest history row. */
  async lastRun(scheduleId: string): Promise<ScheduleRunListRow | undefined> {
    const [row] = await this.runsPage(scheduleId, 1);
    return row;
  }

  /** The schedule's latest run that started or is starting. */
  async lastStarted(
    scheduleId: string,
  ): Promise<ScheduleRunListRow | undefined> {
    const [row] = await this.runs()
      .where(
        and(
          eq(scheduleRuns.scheduleId, scheduleId),
          inArray(scheduleRuns.outcome, [starting, started]),
        ),
      )
      .orderBy(desc(scheduleRuns.dueAt), desc(scheduleRuns.id))
      .limit(1);
    return row;
  }

  /** `starting` → `started` with its conversation, only from `starting`; false otherwise. */
  async markStarted(id: string, conversationId: string): Promise<boolean> {
    const changed = await this.db.client
      .update(scheduleRuns)
      .set({ outcome: started, conversationId })
      .where(and(eq(scheduleRuns.id, id), eq(scheduleRuns.outcome, starting)))
      .returning({ id: scheduleRuns.id });
    return changed.length > 0;
  }

  /** `starting` → `skipped` with its reason, only from `starting`; false otherwise. */
  async markSkipped(id: string, reason: ScheduleSkipReason): Promise<boolean> {
    const changed = await this.db.client
      .update(scheduleRuns)
      .set({ outcome: skipped, skipReason: reason })
      .where(and(eq(scheduleRuns.id, id), eq(scheduleRuns.outcome, starting)))
      .returning({ id: scheduleRuns.id });
    return changed.length > 0;
  }

  /** Writes a started run's final status once; false when it is written already. */
  async setFinalStatus(
    id: string,
    status: ScheduleRunStatus,
  ): Promise<boolean> {
    const changed = await this.db.client
      .update(scheduleRuns)
      .set({ finalStatus: status })
      .where(
        and(
          eq(scheduleRuns.id, id),
          eq(scheduleRuns.outcome, started),
          sql`${scheduleRuns.finalStatus} is null`,
        ),
      )
      .returning({ id: scheduleRuns.id });
    return changed.length > 0;
  }

  private owned() {
    return this.db.client
      .select({
        schedule: schedules,
        conversationTitle: conversations.title,
        conversationDeletedAt: runtimeTasks.deletedAt,
      })
      .from(schedules)
      .leftJoin(conversations, eq(conversations.id, schedules.conversationId))
      .leftJoin(runtimeTasks, scheduleConversationTask)
      .$dynamic();
  }

  private runs() {
    return this.db.client
      .select({
        run: scheduleRuns,
        conversationDeletedAt: runtimeTasks.deletedAt,
      })
      .from(scheduleRuns)
      .leftJoin(
        runtimeTasks,
        eq(runtimeTasks.taskId, scheduleRuns.conversationId),
      )
      .$dynamic();
  }
}
