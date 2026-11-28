import { ScheduleStateSchema } from '@agent-os/contracts';
import { and, asc, desc, eq, lt, lte, or, sql } from 'drizzle-orm';
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
    | 'conversationId'
    | 'access'
  >
>;

/** A schedule with the title and deletion mark of the conversation it was created in. */
export type OwnedScheduleRow = {
  readonly schedule: ScheduleRow;
  /** Null without a conversation; empty while it has no title. */
  readonly conversationTitle: string | null;
  readonly conversationDeletedAt: Date | null;
};

/** A history row with the deletion mark of its conversation. */
export type ScheduleRunListRow = {
  readonly run: ScheduleRunRow;
  readonly conversationDeletedAt: Date | null;
};

const { active, paused } = ScheduleStateSchema.enum;

/** Active by the next term, then paused, then completed (design-schedules.md, «Маршруты»). */
const listOrder = sql`case ${schedules.state} when ${active} then 0 when ${paused} then 1 else 2 end`;

/** The `runtime_tasks` row of a schedule's conversation, for its deletion mark. */
const scheduleConversationTask = sql`${runtimeTasks.taskId} = ${schedules.conversationId}`;

/**
 * Drizzle queries of `schedules` and `schedule_runs` (schedules-search-memory design-schedules.md, Data Model).
 * The service holds the claim of a term: its first write is `hold` (rule 5); a history row is only inserted
 * (rule 3).
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

  /** The owner's schedule changed last: the zone and language of a schedule the chat creates (chat-scheduling KD-5). */
  async latestOwned(ownerId: string): Promise<ScheduleRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(schedules)
      .where(eq(schedules.ownerId, ownerId))
      .orderBy(desc(schedules.updatedAt), desc(schedules.id))
      .limit(1);
    return row;
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
   * Writes the schedule's row without changing it and returns it fresh: the first write of a manual trigger and
   * of a claim of a due term, so claims of one schedule go one after the other (rule 5).
   */
  async hold(id: string): Promise<ScheduleRow | undefined> {
    const [row] = await this.db.client
      .update(schedules)
      .set({ id: sql`${schedules.id}` })
      .where(eq(schedules.id, id))
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

  // ---------- History ----------

  /** Writes a history row; a second row of a term of a schedule breaks the unique index (rule 1). */
  async insertRun(row: NewScheduleRunRow): Promise<ScheduleRunRow> {
    const [inserted] = await this.db.client
      .insert(scheduleRuns)
      .values(row)
      .returning();
    if (inserted === undefined)
      throw new Error('schedule_runs insert returned no row');
    return inserted;
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
