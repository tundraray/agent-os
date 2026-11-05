import { type Database, researchEngineRuns, researchInvestigations, researchTasks } from '@agent-os/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { SourceMode } from '../config/source-check.js';

export type EngineRunRow = typeof researchEngineRuns.$inferSelect;

/** The fields of a new engine row; the counters, the controller task and the answer start empty. */
export interface NewEngineRun {
  readonly investigationId: string;
  readonly resourceId: string;
  readonly launchKey: string;
  readonly config: ProcessConfig;
  readonly sourceMode: SourceMode;
  readonly tokenBudget: number;
}

/** An engine row with the statuses the view is derived from. */
export interface EngineRunStatus {
  readonly run: EngineRunRow;
  readonly investigationStatus: string;
  /** Null while no controller task is recorded. */
  readonly controllerTaskStatus: string | null;
}

/**
 * Queries of `research_engine_runs` (ADR-0003: drizzle-orm). The engine writes only its own table; the runtime's
 * `research_investigations` and `research_tasks` are only read, for the statuses of the view.
 */
export const engineRunsRepository = {
  async findByLaunchKey(db: Database, resourceId: string, launchKey: string): Promise<EngineRunRow | undefined> {
    const [row] = await db
      .select()
      .from(researchEngineRuns)
      .where(and(eq(researchEngineRuns.resourceId, resourceId), eq(researchEngineRuns.launchKey, launchKey)));
    return row;
  },

  /** Which of the investigations already have their engine row. */
  async withEngineRow(db: Database, investigationIds: readonly string[]): Promise<Set<string>> {
    if (investigationIds.length === 0) {
      return new Set();
    }
    const rows = await db
      .select({ investigationId: researchEngineRuns.investigationId })
      .from(researchEngineRuns)
      .where(inArray(researchEngineRuns.investigationId, [...investigationIds]));
    return new Set(rows.map((row) => row.investigationId));
  },

  /**
   * Inserts the row; `undefined` when a row of the same `launchKey` of the user or of the same investigation already
   * exists (ON CONFLICT DO NOTHING over both unique keys) — the caller tells the two apart (KD-9).
   */
  async insert(db: Database, run: NewEngineRun): Promise<EngineRunRow | undefined> {
    const [row] = await db
      .insert(researchEngineRuns)
      .values({
        investigationId: run.investigationId,
        resourceId: run.resourceId,
        launchKey: run.launchKey,
        processId: run.config.processId,
        processVersion: run.config.version,
        processConfig: run.config,
        sourceMode: run.sourceMode,
        tokenBudget: run.tokenBudget,
      })
      .onConflictDoNothing()
      .returning();
    return row;
  },

  async setControllerTask(db: Database, investigationId: string, controllerTaskId: string): Promise<void> {
    await db
      .update(researchEngineRuns)
      .set({ controllerTaskId })
      .where(eq(researchEngineRuns.investigationId, investigationId));
  },

  /** The owner's engine row with its investigation's and controller task's statuses; `undefined` for another owner. */
  async readStatus(db: Database, investigationId: string, resourceId: string): Promise<EngineRunStatus | undefined> {
    const [row] = await db
      .select({
        run: researchEngineRuns,
        investigationStatus: researchInvestigations.status,
        controllerTaskStatus: researchTasks.status,
      })
      .from(researchEngineRuns)
      .innerJoin(
        researchInvestigations,
        eq(researchInvestigations.investigationId, researchEngineRuns.investigationId),
      )
      .leftJoin(researchTasks, eq(researchTasks.taskId, researchEngineRuns.controllerTaskId))
      .where(
        and(eq(researchEngineRuns.investigationId, investigationId), eq(researchEngineRuns.resourceId, resourceId)),
      );
    return row;
  },
};
