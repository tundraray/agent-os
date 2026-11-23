import type {
  EmbeddingFailureReason,
  LastExtractionReason,
  LastExtractionStatus,
} from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import { Db } from '../db';
import {
  agentKnowledgeEmbedding,
  agentKnowledgeQuestions,
  agentKnowledgeRuns,
  conversations,
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
export type KnowledgeRunPatch = Partial<
  Pick<KnowledgeRunRow, 'extractTaskId' | 'needsRound'>
>;

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
export type KnowledgeQuestion = Omit<
  typeof questions.$inferInsert,
  'createdAt'
>;

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
 * (KD-3, KD-6, KD-8): the only code that reads and writes
 * `agent_knowledge_runs`, `agent_knowledge_questions` and `agent_knowledge_embedding`; besides them it
 * reads only `conversations.owner_id`. No method opens a transaction, logs or decides.
 */
@Injectable()
export class AgentKnowledgeRunsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /**
   * Creates the run row with the deep agent session (KD-2, called from `DeepAgent.sessionStarted` in its
   * transaction); a second call for the same run writes nothing.
   */
  async insertRun(run: {
    readonly runId: string;
    readonly recordId: string;
    readonly servers: readonly string[];
  }): Promise<void> {
    await this.db.client
      .insert(runs)
      .values({
        runId: run.runId,
        recordId: run.recordId,
        servers: [...run.servers],
      })
      .onConflictDoNothing({ target: runs.runId });
  }

  /**
   * The run row matching `where` with the owner of its session, read by an UPDATE that changes nothing:
   * inside a transaction the other writers of the row wait until it ends, so the trigger and the round
   * commit decide on the row one at a time (Invariant 1).
   */
  private async findRun(where: SQL): Promise<OwnedKnowledgeRunRow | undefined> {
    const [row] = await this.db.client
      .update(runs)
      .set({ needsRound: sql`${runs.needsRound}` })
      .where(where)
      .returning();
    if (row === undefined) return undefined;
    const [session] = await this.db.client
      .select({ ownerId: conversations.ownerId })
      .from(conversations)
      .where(eq(conversations.id, row.runId));
    if (session === undefined) return undefined;
    return { ...row, ownerId: session.ownerId };
  }

  /** The run row of the deep agent task; `undefined` when the run does not learn or is gone. */
  findRunById(runId: string): Promise<OwnedKnowledgeRunRow | undefined> {
    return this.findRun(eq(runs.runId, runId));
  }

  /** The run whose extraction task is in progress — how the trigger recognises its failure. */
  findRunByExtractTask(
    taskId: string,
  ): Promise<OwnedKnowledgeRunRow | undefined> {
    return this.findRun(eq(runs.extractTaskId, taskId));
  }

  /** The run whose last committed round belongs to the task — how the trigger recognises its end. */
  findRunByLastExtractTask(
    taskId: string,
  ): Promise<OwnedKnowledgeRunRow | undefined> {
    return this.findRun(eq(runs.lastExtractTaskId, taskId));
  }

  /** Sets the extraction task in progress and the «one more round» mark; an empty patch writes nothing. */
  async updateRun(runId: string, patch: KnowledgeRunPatch): Promise<void> {
    if (Object.values(patch).every((value) => value === undefined)) return;
    await this.db.client.update(runs).set(patch).where(eq(runs.runId, runId));
  }

  /** Writes the last round's outcome. */
  async writeRoundOutcome(runId: string, outcome: RoundOutcome): Promise<void> {
    await this.db.client
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
  async advanceExtractedUpTo(runId: string, at: Date): Promise<void> {
    await this.db.client
      .update(runs)
      .set({
        extractedUpTo: sql`greatest(${runs.extractedUpTo}, ${at.toISOString()}::timestamptz)`,
      })
      .where(eq(runs.runId, runId));
  }

  /** The run row of the deep agent with the latest round outcome; `undefined` before any round. */
  async lastExtraction(recordId: string): Promise<KnowledgeRunRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(runs)
      .where(and(eq(runs.recordId, recordId), isNotNull(runs.lastAt)))
      .orderBy(desc(runs.lastAt))
      .limit(1);
    return row;
  }

  /** The question row of the session; `undefined` before its first question. */
  async readQuestion(
    taskId: string,
  ): Promise<KnowledgeQuestionRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(questions)
      .where(eq(questions.taskId, taskId));
    return row;
  }

  /** Writes the session's current question, replacing the previous one (`ON CONFLICT (task_id)`). */
  async writeQuestion(question: KnowledgeQuestion): Promise<void> {
    const current = {
      source: question.source,
      model: question.model ?? null,
      vector: question.vector ?? null,
      createdAt: new Date(),
    };
    await this.db.client
      .insert(questions)
      .values({ taskId: question.taskId, ...current })
      .onConflictDoUpdate({ target: questions.taskId, set: current });
  }

  /** The deep agent's vector row; `undefined` before its first pass or question outcome. */
  async findEmbeddingRow(
    recordId: string,
  ): Promise<KnowledgeEmbeddingRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(embedding)
      .where(eq(embedding.recordId, recordId));
    return row;
  }

  /**
   * The vector row whose pass is the task — how the trigger recognises a failed pass. Read by an UPDATE
   * that changes nothing: the other writers of the row wait until the transaction ends.
   */
  async findEmbeddingByPassTask(
    taskId: string,
  ): Promise<KnowledgeEmbeddingRow | undefined> {
    const [row] = await this.db.client
      .update(embedding)
      .set({ needsPass: sql`${embedding.needsPass}` })
      .where(eq(embedding.passTaskId, taskId))
      .returning();
    return row;
  }

  /**
   * The deep agent's vector row, created when missing, in one statement that writes the row either way:
   * the other writers of the row wait until the transaction ends. The row is the one row per deep agent,
   * so a transaction that starts with it has the deep agent's graph to itself (Invariant 5).
   */
  async ensureEmbeddingRow(recordId: string): Promise<KnowledgeEmbeddingRow> {
    const [row] = await this.db.client
      .insert(embedding)
      .values({ recordId })
      .onConflictDoUpdate({ target: embedding.recordId, set: { recordId } })
      .returning();
    if (row === undefined)
      throw new Error(`knowledge embedding row of ${recordId} is missing`);
    return row;
  }

  /** Sets the pass in progress, the «one more pass» mark and the payer; an empty patch writes nothing. */
  async updateEmbeddingRow(
    recordId: string,
    patch: KnowledgeEmbeddingPatch,
  ): Promise<void> {
    if (Object.values(patch).every((value) => value === undefined)) return;
    await this.db.client
      .update(embedding)
      .set(patch)
      .where(eq(embedding.recordId, recordId));
  }

  private async upsertOutcome(
    recordId: string,
    outcome: EmbeddingOutcome,
    setWhere?: SQL,
  ): Promise<void> {
    const attempt = {
      lastReason: outcome.reason,
      lastModel: outcome.model,
      lastAt: new Date(),
    };
    await this.db.client
      .insert(embedding)
      .values({ recordId, ...attempt })
      .onConflictDoUpdate({
        target: embedding.recordId,
        set: attempt,
        setWhere,
      });
  }

  /** Writes the outcome of a pass attempt. */
  writeEmbeddingOutcome(
    recordId: string,
    outcome: EmbeddingOutcome,
  ): Promise<void> {
    return this.upsertOutcome(recordId, outcome);
  }

  /** Writes the outcome of a session question's embedding, only when it differs from the stored one. */
  writeQuestionOutcome(
    recordId: string,
    outcome: EmbeddingOutcome,
  ): Promise<void> {
    return this.upsertOutcome(
      recordId,
      outcome,
      sql`${embedding.lastReason} is distinct from excluded.last_reason
      or ${embedding.lastModel} is distinct from excluded.last_model`,
    );
  }
}
