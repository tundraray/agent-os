import type {
  EmbeddingFailureReason,
  LastExtractionReason,
  LastExtractionStatus,
} from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { Executor, Transaction } from '../database';
import {
  agentKnowledgeEmbedding,
  agentKnowledgeQuestions,
  agentKnowledgeRuns,
  agentSessions,
} from '../schema';

const runs = agentKnowledgeRuns;
const questions = agentKnowledgeQuestions;
const embedding = agentKnowledgeEmbedding;

// ---------- Run rows (KD-3) ----------

export type KnowledgeRunRow = typeof runs.$inferSelect;

/** A run row with the owner of its deep agent session — the starter. */
export interface OwnedKnowledgeRunRow extends KnowledgeRunRow {
  readonly ownerId: string;
}

/** What may change on a run row besides the round outcome and the extracted-up-to mark. */
export type KnowledgeRunPatch = Partial<Pick<KnowledgeRunRow, 'extractTaskId' | 'needsRound'>>;

/** The outcome of a round, or `stopped` / `interrupted` written by the trigger. */
export interface RoundOutcome {
  readonly status: LastExtractionStatus;
  /** `null` on `done`. */
  readonly reason: LastExtractionReason | null;
  readonly added: number;
  readonly confirmed: number;
  readonly outdated: number;
  readonly model: string | null;
  readonly at: Date;
  /** The extraction task whose round committed; written to `last_extract_task_id`, left as is when absent. */
  readonly extractTaskId?: string;
}

// ---------- Session questions (KD-6) ----------

export type KnowledgeQuestionRow = typeof questions.$inferSelect;

/** The question of a session and its vector; `vector` and `model` stay null when embeddings refused. */
export type KnowledgeQuestion = Omit<typeof questions.$inferInsert, 'createdAt'>;

// ---------- Deep agent vector rows (KD-8) ----------

export type KnowledgeEmbeddingRow = typeof embedding.$inferSelect;

/** The pass in progress, the «one more pass» mark and the payer. */
export type KnowledgeEmbeddingPatch = Partial<
  Pick<KnowledgeEmbeddingRow, 'passTaskId' | 'needsPass' | 'payerId'>
>;

/** An embeddings attempt of the deep agent: the failure reason or `null`, and the model. */
export interface EmbeddingOutcome {
  readonly reason: EmbeddingFailureReason | null;
  readonly model: string | null;
}

/**
 * Drizzle queries of the run rows, session questions and deep agent vector rows of self-learning
 * (repository over a transaction, KD-3, KD-6, KD-8): the only code that reads and writes
 * `agent_knowledge_runs`, `agent_knowledge_questions` and `agent_knowledge_embedding`; besides them it
 * reads only `agent_sessions.owner_id`. No method opens a transaction, logs or decides.
 */
@Injectable()
export class AgentKnowledgeRunsRepository {
  /**
   * Creates the run row with the deep agent session (KD-2, called from `DeepAgent.sessionStarted` in its
   * transaction); a second call for the same run writes nothing.
   */
  async insertRun(
    tx: Transaction,
    run: { readonly runId: string; readonly recordId: string; readonly servers: readonly string[] },
  ): Promise<void> {
    await tx
      .insert(runs)
      .values({ runId: run.runId, recordId: run.recordId, servers: [...run.servers] })
      .onConflictDoNothing({ target: runs.runId });
  }

  /**
   * The run row matching `where`, locked: inside a transaction the trigger and the round commit decide
   * on it one at a time (Invariant 1); outside one the lock ends with the statement.
   */
  private async findRun(executor: Executor, where: SQL): Promise<OwnedKnowledgeRunRow | undefined> {
    // Two statements, not a join with `FOR UPDATE OF`: Postgres takes `OF` unqualified, drizzle writes the schema in.
    const [row] = await executor.select().from(runs).where(where).for('update');
    if (row === undefined) return undefined;
    const [session] = await executor
      .select({ ownerId: agentSessions.ownerId })
      .from(agentSessions)
      .where(eq(agentSessions.taskId, row.runId));
    if (session === undefined) return undefined;
    return { ...row, ownerId: session.ownerId };
  }

  /** The run row of the deep agent task; `undefined` when the run does not learn or is gone. */
  findRunById(executor: Executor, runId: string): Promise<OwnedKnowledgeRunRow | undefined> {
    return this.findRun(executor, eq(runs.runId, runId));
  }

  /** The run whose extraction task is in progress — how the trigger recognises its failure. */
  findRunByExtractTask(
    executor: Executor,
    taskId: string,
  ): Promise<OwnedKnowledgeRunRow | undefined> {
    return this.findRun(executor, eq(runs.extractTaskId, taskId));
  }

  /** The run whose last committed round belongs to the task — how the trigger recognises its end. */
  findRunByLastExtractTask(
    executor: Executor,
    taskId: string,
  ): Promise<OwnedKnowledgeRunRow | undefined> {
    return this.findRun(executor, eq(runs.lastExtractTaskId, taskId));
  }

  /** Sets the extraction task in progress and the «one more round» mark; an empty patch writes nothing. */
  async updateRun(tx: Transaction, runId: string, patch: KnowledgeRunPatch): Promise<void> {
    if (Object.values(patch).every((value) => value === undefined)) return;
    await tx.update(runs).set(patch).where(eq(runs.runId, runId));
  }

  /** Writes the last round's outcome. */
  async writeRoundOutcome(tx: Transaction, runId: string, outcome: RoundOutcome): Promise<void> {
    await tx
      .update(runs)
      .set({
        lastStatus: outcome.status,
        lastReason: outcome.reason,
        lastAdded: outcome.added,
        lastConfirmed: outcome.confirmed,
        lastOutdated: outcome.outdated,
        lastModel: outcome.model,
        lastAt: outcome.at,
        lastExtractTaskId: outcome.extractTaskId,
      })
      .where(eq(runs.runId, runId));
  }

  /** Moves «extracted up to» to `at` unless it is already later: the mark never goes back (Invariant 2). */
  async advanceExtractedUpTo(tx: Transaction, runId: string, at: Date): Promise<void> {
    await tx
      .update(runs)
      .set({ extractedUpTo: sql`greatest(${runs.extractedUpTo}, ${at.toISOString()}::timestamptz)` })
      .where(eq(runs.runId, runId));
  }

  /** The run row of the deep agent with the latest round outcome; `undefined` before any round. */
  async lastExtraction(executor: Executor, recordId: string): Promise<KnowledgeRunRow | undefined> {
    const [row] = await executor
      .select()
      .from(runs)
      .where(and(eq(runs.recordId, recordId), isNotNull(runs.lastAt)))
      .orderBy(desc(runs.lastAt))
      .limit(1);
    return row;
  }

  /** The question row of the session; `undefined` before its first question. */
  async readQuestion(executor: Executor, taskId: string): Promise<KnowledgeQuestionRow | undefined> {
    const [row] = await executor.select().from(questions).where(eq(questions.taskId, taskId));
    return row;
  }

  /** Writes the session's current question, replacing the previous one (`ON CONFLICT (task_id)`). */
  async writeQuestion(tx: Transaction, question: KnowledgeQuestion): Promise<void> {
    const current = {
      source: question.source,
      model: question.model ?? null,
      vector: question.vector ?? null,
      createdAt: new Date(),
    };
    await tx
      .insert(questions)
      .values({ taskId: question.taskId, ...current })
      .onConflictDoUpdate({ target: questions.taskId, set: current });
  }

  /** The deep agent's vector row; `undefined` before its first pass or question outcome. */
  async findEmbeddingRow(
    executor: Executor,
    recordId: string,
  ): Promise<KnowledgeEmbeddingRow | undefined> {
    const [row] = await executor.select().from(embedding).where(eq(embedding.recordId, recordId));
    return row;
  }

  /** The vector row whose pass is the task, locked — how the trigger recognises a failed pass. */
  async findEmbeddingByPassTask(
    executor: Executor,
    taskId: string,
  ): Promise<KnowledgeEmbeddingRow | undefined> {
    const [row] = await executor
      .select()
      .from(embedding)
      .where(eq(embedding.passTaskId, taskId))
      .for('update');
    return row;
  }

  /**
   * The deep agent's vector row, created when missing and locked, so that two requests for a pass see
   * each other (Invariant 13).
   */
  async ensureEmbeddingRow(tx: Transaction, recordId: string): Promise<KnowledgeEmbeddingRow> {
    await tx
      .insert(embedding)
      .values({ recordId })
      .onConflictDoNothing({ target: embedding.recordId });
    const [row] = await tx
      .select()
      .from(embedding)
      .where(eq(embedding.recordId, recordId))
      .for('update');
    if (row === undefined) throw new Error(`knowledge embedding row of ${recordId} is missing`);
    return row;
  }

  /** Sets the pass in progress, the «one more pass» mark and the payer; an empty patch writes nothing. */
  async updateEmbeddingRow(
    tx: Transaction,
    recordId: string,
    patch: KnowledgeEmbeddingPatch,
  ): Promise<void> {
    if (Object.values(patch).every((value) => value === undefined)) return;
    await tx.update(embedding).set(patch).where(eq(embedding.recordId, recordId));
  }

  private async upsertOutcome(
    tx: Transaction,
    recordId: string,
    outcome: EmbeddingOutcome,
    setWhere?: SQL,
  ): Promise<void> {
    const attempt = { lastReason: outcome.reason, lastModel: outcome.model, lastAt: new Date() };
    await tx
      .insert(embedding)
      .values({ recordId, ...attempt })
      .onConflictDoUpdate({ target: embedding.recordId, set: attempt, setWhere });
  }

  /** Writes the outcome of a pass attempt. */
  writeEmbeddingOutcome(tx: Transaction, recordId: string, outcome: EmbeddingOutcome): Promise<void> {
    return this.upsertOutcome(tx, recordId, outcome);
  }

  /** Writes the outcome of a session question's embedding, only when it differs from the stored one. */
  writeQuestionOutcome(tx: Transaction, recordId: string, outcome: EmbeddingOutcome): Promise<void> {
    return this.upsertOutcome(
      tx,
      recordId,
      outcome,
      sql`${embedding.lastReason} is distinct from excluded.last_reason
      or ${embedding.lastModel} is distinct from excluded.last_model`,
    );
  }
}
