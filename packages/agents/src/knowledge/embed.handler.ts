import { createSecretMasker, type Logger } from '@agent-os/common';
import type { KnowledgeItemType } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { RuntimeTx, StepContext, StepResult, TaskHandler } from '@agent-os/runtime';

import {
  type AgentsEmbeddings,
  EMBEDDING_BATCH_SIZE,
  type EmbedUnavailable,
} from '../embeddings/embeddings';
import {
  type EmbeddingOutcome,
  findEmbeddingByPassTask,
  findEmbeddingRow,
  updateEmbeddingRow,
  writeEmbeddingOutcome,
} from './knowledge-runs.repository';
import { type KnowledgeGraph, readGraph } from './knowledge.repository';
import { KNOWLEDGE_EMBED_TASK_TYPE, KnowledgeEmbedInputSchema } from './knowledge-tasks';
import { knowledgeKey } from './knowledge-text';
import type { KnowledgeVectorKey, KnowledgeVectorStore } from './vector-store';

export interface KnowledgeEmbedHandlerDeps {
  readonly database: Database;
  readonly embeddings: Pick<AgentsEmbeddings, 'embed' | 'model'>;
  readonly store: KnowledgeVectorStore;
}

/** A graph record as the pass embeds it: its store key and kind and the masked text of its vector. */
interface PassItem {
  readonly key: string;
  readonly kind: KnowledgeItemType;
  readonly text: string;
}

/** What the store lacks against the graph for the current model. */
interface PassPlan {
  /** Records that never had a vector: charged to the pass's payer. */
  readonly fresh: readonly PassItem[];
  /** Records with a vector of another model: recomputed on the platform (FR-08). */
  readonly stale: readonly PassItem[];
}

/** How the step leaves the workflow's vector row. */
type PassNext =
  /** The batch is done and records still lack a vector: another step. */
  | 'more'
  /** Nothing lacks a vector: another step only when a new pass was asked meanwhile. */
  | 'end'
  /** Embeddings unavailable: the pass ends, the records wait for the next pass (Flow 4). */
  | 'stop';

/** The counts of the step's log line; texts are never logged. */
interface PassStats {
  payer: 'starter' | 'platform';
  payerId: string | null;
  model: string | null;
  missing: number;
  stale: number;
  embedded: number;
  deleted: number;
}

/**
 * The text of a record's vector (KD-8): an entity's name and description; a fact's start, label and end;
 * a lesson's tool, kind of question and hint; «searched — found nothing»'s tool and kind of question —
 * after masking.
 */
function passItems(graph: KnowledgeGraph, mask: (text: string) => string): PassItem[] {
  const names = new Map(graph.entities.map((entity) => [entity.id, entity.name]));
  const nameOf = (id: number | null) => (id === null ? '' : (names.get(id) ?? ''));
  const entityItems = graph.entities.map((entity) => ({
    key: knowledgeKey({ type: 'entity', id: entity.id }),
    kind: 'entity' as const,
    text: mask(`${entity.name}: ${entity.description}`),
  }));
  const relationItems = graph.relations.map((relation) => {
    const tool = `${relation.server ?? ''}.${relation.tool ?? ''}`;
    const question = relation.question ?? '';
    const text =
      relation.kind === 'fact'
        ? `${nameOf(relation.fromEntityId)} — ${relation.label ?? ''} — ${nameOf(relation.toEntityId)}`
        : relation.kind === 'lesson'
          ? `${tool} for ${question}: ${relation.hint ?? ''}`
          : `${tool} for ${question}`;
    return { key: knowledgeKey({ type: 'relation', id: relation.id }), kind: 'relation' as const, text: mask(text) };
  });
  return [...entityItems, ...relationItems];
}

/** Compares the store with the graph (Invariants 10, 11): the graph is the source of truth. */
function passPlan(items: readonly PassItem[], stored: readonly KnowledgeVectorKey[], model: string): PassPlan {
  const storedModel = new Map(stored.map((vector) => [vector.key, vector.model]));
  return {
    fresh: items.filter((item) => !storedModel.has(item.key)),
    stale: items.filter((item) => {
      const held = storedModel.get(item.key);
      return held !== undefined && held !== model;
    }),
  };
}

/** Keys of the store with no record in the graph. */
function danglingKeys(items: readonly PassItem[], stored: readonly KnowledgeVectorKey[]): string[] {
  const keys = new Set(items.map((item) => item.key));
  return stored.filter((vector) => !keys.has(vector.key)).map((vector) => vector.key);
}

/** The reason kept on the row; `owner_disabled` is one employee's refusal and goes to the log only (Flow 4). */
function recordedOutcome(result: EmbedUnavailable): EmbeddingOutcome | null {
  return result.reason === 'owner_disabled' ? null : { reason: result.reason, model: result.model };
}

/**
 * Builds the handler of `knowledge.embed` (design-core.md KD-8, Flow 4): one pass per workflow, held by
 * `pass_task_id` of its vector row (Invariant 13). A step deletes the store's keys without a graph record,
 * embeds up to `EMBEDDING_BATCH_SIZE` records lacking a vector of the current model — records that never had
 * one in a call charged to the row's payer (the platform when only deletions asked for the pass), records
 * with an old model's vector in a separate call charged to the platform — and writes each call's vectors
 * before the next call. The store shares no transaction with the graph; a vector written for a record
 * deleted meanwhile is dangling until the next step or pass removes it, and the selection drops it anyway.
 * A lost step repeats from the start and pays again at most for the one call whose vectors were not written.
 * The step never returns `fail`: unavailable embeddings end the pass as completed with the reason on the row.
 */
export function createKnowledgeEmbedHandler(deps: KnowledgeEmbedHandlerDeps): TaskHandler {
  const { database, embeddings, store } = deps;

  /** The pass is not this task's any more: the record was deleted (its row with it) or the row moved on. */
  function notCurrent(logger: Logger, startedAt: number): StepResult {
    logger.info('knowledge embed pass ended: not current', {
      outcome: 'not_current',
      durationMs: Date.now() - startedAt,
    });
    return { outcome: 'complete', result: { outcome: 'not_current' } };
  }

  /**
   * The step's writes to the vector row in a short guarded transaction, under the row's lock, so a pass asked
   * meanwhile by the trigger is either seen here (`needs_pass`) or finds the pass released and queues a new one.
   */
  async function settle(
    ctx: StepContext,
    recordId: string,
    outcome: EmbeddingOutcome | null,
    next: PassNext,
  ): Promise<'continue' | 'complete' | 'not_current' | 'fenced'> {
    const settled = await ctx.guard(async (tx: RuntimeTx) => {
      const row = await findEmbeddingByPassTask(tx, ctx.taskId);
      if (row?.recordId !== recordId) return 'not_current' as const;
      if (outcome !== null) await writeEmbeddingOutcome(tx, recordId, outcome);
      if (next === 'more') return 'continue' as const;
      if (next === 'end' && row.needsPass) {
        await updateEmbeddingRow(tx, recordId, { needsPass: false });
        return 'continue' as const;
      }
      await updateEmbeddingRow(tx, recordId, { passTaskId: null, payerId: null, needsPass: false });
      return 'complete' as const;
    });
    return settled.outcome === 'fenced' ? 'fenced' : settled.value;
  }

  /** Settles the row and logs the step: counts, model, payer and outcome or reason, never a text. */
  async function finish(
    ctx: StepContext,
    logger: Logger,
    end: { recordId: string; outcome: EmbeddingOutcome | null; next: PassNext; stats: PassStats; startedAt: number },
    reason: string | null,
  ): Promise<StepResult> {
    const settled = await settle(ctx, end.recordId, end.outcome, end.next);
    if (settled === 'not_current') return notCurrent(logger, end.startedAt);
    const fields = { ...end.stats, outcome: settled, reason, durationMs: Date.now() - end.startedAt };
    if (settled === 'fenced') {
      logger.info('knowledge embed step abandoned without writes', fields);
      return { outcome: 'continue' };
    }
    if (reason === null) logger.info('knowledge embed step done', fields);
    else logger.warn('knowledge embed pass stopped: embeddings unavailable', fields);
    if (settled === 'continue') return { outcome: 'continue' };
    return { outcome: 'complete', result: { outcome: reason === null ? 'done' : 'unavailable', reason } };
  }

  /**
   * Writes a call's vectors. A foreign key failure because the workflow was deleted meanwhile ends the pass
   * quietly (`false`); any other store failure throws.
   */
  async function writeVectors(
    ctx: StepContext,
    recordId: string,
    items: readonly PassItem[],
    result: { vectors: readonly (readonly number[])[]; model: string },
  ): Promise<boolean> {
    const vectors = items.map((item, index) => {
      const vector = result.vectors[index];
      if (vector === undefined) throw new Error(`Embeddings gave no vector for knowledge key ${item.key}`);
      return { key: item.key, kind: item.kind, model: result.model, vector };
    });
    try {
      await store.upsert(recordId, vectors);
      return true;
    } catch (error) {
      const row = await findEmbeddingRow(database, recordId);
      if (row?.passTaskId !== ctx.taskId) return false;
      throw error;
    }
  }

  async function step(ctx: StepContext): Promise<StepResult> {
    const startedAt = Date.now();
    const { recordId } = KnowledgeEmbedInputSchema.parse(ctx.input);
    const logger = ctx.logger.child({ recordId });

    const row = await findEmbeddingRow(database, recordId);
    if (row === undefined || row.passTaskId !== ctx.taskId) return notCurrent(logger, startedAt);
    const payerId = row.payerId;
    const stats: PassStats = {
      payer: payerId === null ? 'platform' : 'starter',
      payerId,
      model: null,
      missing: 0,
      stale: 0,
      embedded: 0,
      deleted: 0,
    };
    const end = (outcome: EmbeddingOutcome | null, next: PassNext) => ({ recordId, outcome, next, stats, startedAt });

    const items = passItems(await readGraph(database, recordId), createSecretMasker([]));
    const stored = await store.list(recordId);
    // Deleted first: the pass removes vectors of deleted records even when embeddings are unavailable (AC-19.1).
    const dangling = danglingKeys(items, stored);
    if (dangling.length > 0) {
      await store.delete(recordId, dangling);
      stats.deleted = dangling.length;
    }

    const choice = await embeddings.model();
    if (choice.kind === 'unavailable') {
      return finish(ctx, logger, end({ reason: choice.reason, model: null }, 'stop'), choice.reason);
    }
    stats.model = choice.model;

    const plan = passPlan(items, stored, choice.model);
    stats.missing = plan.fresh.length;
    stats.stale = plan.stale.length;

    const fresh = plan.fresh.slice(0, EMBEDDING_BATCH_SIZE);
    const calls = [
      { items: fresh, ownerId: payerId },
      { items: plan.stale.slice(0, EMBEDDING_BATCH_SIZE - fresh.length), ownerId: null },
    ];
    for (const call of calls) {
      if (call.items.length === 0) continue;
      const result = await embeddings.embed({
        texts: call.items.map((item) => item.text),
        inputType: 'document',
        ownerId: call.ownerId,
        taskId: ctx.taskId,
        signal: ctx.signal,
        logger,
      });
      if (result.kind === 'unavailable') {
        return finish(ctx, logger, end(recordedOutcome(result), 'stop'), result.reason);
      }
      if (!(await writeVectors(ctx, recordId, call.items, result))) return notCurrent(logger, startedAt);
      stats.embedded += call.items.length;
    }

    const more = stats.embedded < plan.fresh.length + plan.stale.length;
    return finish(ctx, logger, end({ reason: null, model: choice.model }, more ? 'more' : 'end'), null);
  }

  return { type: KNOWLEDGE_EMBED_TASK_TYPE, inputSchema: KnowledgeEmbedInputSchema, step };
}
