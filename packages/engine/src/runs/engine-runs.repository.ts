import { type Database, researchEngineRuns, researchInvestigations, researchTasks } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, eq, inArray } from 'drizzle-orm';
import { AGENT_ROOT_WORKFLOW } from '../agents/agent-task-spec.js';
import type { DefinitionMemorySnapshot } from '../agents/definition-memory.js';
import type { AgentProcessConfig } from '../config/agent-config.schema.js';
import type { SourceMode } from '../config/source-check.js';
import type { SourceCatalog } from './source-catalog.js';

export type EngineRunRow = typeof researchEngineRuns.$inferSelect;

/** The fields of a new engine row; the counters, the controller task and the answer start empty. */
export interface NewEngineRun {
  readonly investigationId: string;
  readonly resourceId: string;
  readonly launchKey: string;
  readonly config: AgentProcessConfig;
  readonly sourceMode: SourceMode;
  readonly tokenBudget: number;
  /** The investigation's catalog with the slices read at start; written once, with the row (KD-1). */
  readonly sourceCatalog: SourceCatalog;
  /** The definition memory snapshot of the start (DC-24). */
  readonly definitionMemorySnapshot: DefinitionMemorySnapshot;
}

/** An engine row with the investigation's status, which the view's status is derived from. */
export interface EngineRunStatus {
  readonly run: EngineRunRow;
  readonly investigationStatus: string;
}

/**
 * Queries of `research_engine_runs` (ADR-0003: drizzle-orm). The engine writes only its own table; the runtime's
 * `research_investigations` is only read, for the status of the view, and `research_tasks` for the root check.
 */
export const engineRunsRepository = {
  /** The engine row with the investigation's thread and query; `undefined` without an engine row. */
  async readRun(db: Database, investigationId: string) {
    const [row] = await db
      .select({ run: researchEngineRuns, threadId: researchInvestigations.threadId, query: researchInvestigations.query })
      .from(researchEngineRuns)
      .innerJoin(researchInvestigations, eq(researchInvestigations.investigationId, researchEngineRuns.investigationId))
      .where(eq(researchEngineRuns.investigationId, investigationId));
    return row;
  },

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
        sourceCatalog: run.sourceCatalog,
        definitionMemorySnapshot: run.definitionMemorySnapshot,
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

  /**
   * Whether `taskId` is the main task of an engine investigation, read in the caller's transaction (the delivery
   * transaction of `engine.lifecycle`): the `agent.root` task of that investigation, which has an engine row
   * (design-agent-core.md, KD-1). Decided by the task row, not by `controller_task_id`: a root that ends before the
   * start records its id still closes the investigation. The runtime's `research_tasks` is only read, by its key.
   */
  async isControllerTask(tx: RuntimeTx, investigationId: string, taskId: string): Promise<boolean> {
    const [row] = await tx
      .select({ taskId: researchTasks.taskId })
      .from(researchTasks)
      .innerJoin(researchEngineRuns, eq(researchEngineRuns.investigationId, researchTasks.investigationId))
      .where(
        and(
          eq(researchTasks.taskId, taskId),
          eq(researchTasks.investigationId, investigationId),
          eq(researchTasks.workflowType, AGENT_ROOT_WORKFLOW),
        ),
      );
    return row !== undefined;
  },

  /** The question of the investigation, as its start recorded it. */
  async readQuery(db: Database, investigationId: string): Promise<string> {
    const [row] = await db
      .select({ query: researchInvestigations.query })
      .from(researchInvestigations)
      .where(eq(researchInvestigations.investigationId, investigationId));
    if (row === undefined) throw new Error(`investigation ${investigationId} is missing`);
    return row.query;
  },

  /** The owner's engine row with its investigation's status; `undefined` for another owner. */
  async readStatus(db: Database, investigationId: string, resourceId: string): Promise<EngineRunStatus | undefined> {
    const [row] = await db
      .select({
        run: researchEngineRuns,
        investigationStatus: researchInvestigations.status,
      })
      .from(researchEngineRuns)
      .innerJoin(
        researchInvestigations,
        eq(researchInvestigations.investigationId, researchEngineRuns.investigationId),
      )
      .where(
        and(eq(researchEngineRuns.investigationId, investigationId), eq(researchEngineRuns.resourceId, resourceId)),
      );
    return row;
  },
};
