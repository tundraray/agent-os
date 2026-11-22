import type { Logger } from '@agent-os/common';
import {
  EmbeddingFailureReasonSchema,
  type KnowledgeSettings,
  type KnowledgeView,
  type LastExtraction,
  LastExtractionReasonSchema,
  LastExtractionStatusSchema,
} from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { Runtime, RuntimeTx } from '@agent-os/runtime';

import type { AgentsEmbeddings } from '../embeddings/embeddings';
import { sessions } from '../store/sessions.repository';
import { graphItemsOf, registryToolAlive } from './knowledge-block';
import {
  ensureEmbeddingRow,
  findEmbeddingRow,
  type KnowledgeEmbeddingRow,
  lastExtraction,
  updateEmbeddingRow,
} from './knowledge-runs.repository';
import {
  deleteEntity,
  deleteRelation,
  type KnowledgeSettingsRow,
  lockGraph,
  readGraph,
  readKnowledgeSettings,
  writeKnowledgeSettings,
} from './knowledge.repository';
import { embedPassRequest } from './knowledge-tasks';
import { type EmbeddingState, knowledgeViewParts } from './select-knowledge';
import type { KnowledgeVectorStore } from './vector-store';

/** What `view` is asked about: the record, and its flag and subagents' servers as the library read them. */
export interface KnowledgeViewRequest {
  readonly recordId: string;
  /** The flag of the deep agent's last version. */
  readonly selfLearning: boolean;
  /** The servers of the subagents of the deep agent's last version (`*` — any): lessons' tools are judged by them. */
  readonly servers: readonly string[];
}

export interface KnowledgeEntityDelete {
  readonly recordId: string;
  readonly entityId: number;
}

export interface KnowledgeRelationDelete {
  readonly recordId: string;
  readonly relationId: number;
}

export interface KnowledgeEntityDeletion {
  /** `false` — the entity was not there (already deleted, or not of this deep agent): nothing changed (DC-10). */
  readonly deleted: boolean;
  /** Fact relations that went with the entity. */
  readonly relations: number;
}

export interface KnowledgeRelationDeletion {
  /** `false` — the relation was not there: nothing changed (DC-10). */
  readonly deleted: boolean;
}

export interface KnowledgeSettingsUpdate {
  /** The administrator, named in the log. */
  readonly actorId: string;
  /** Checked by `UpdateKnowledgeSettingsBodySchema` before the call; the CHECK is the last line. */
  readonly limitTokens: number;
  readonly lessonsEnabled: boolean;
}

/** The settings before and after an update: `apps/api` writes its `admin_change` from them (KD-7). */
export interface KnowledgeSettingsChange {
  readonly before: KnowledgeSettings;
  readonly after: KnowledgeSettings;
}

/**
 * The knowledge operations of `apps/api` (design-core.md KD-1, KD-7, Contract `Agents.knowledge`). They
 * decide nothing about who may call them — the route asks the library first — and each touches only the
 * rows of the record it is given.
 */
export interface AgentsKnowledge {
  /** The graph for the knowledge screen; reads only, no embeddings call (C3 «экран знаний»). */
  view(request: KnowledgeViewRequest): Promise<KnowledgeView>;
  /** Deletes the entity with its fact relations and queues the cleanup of their vectors. */
  deleteEntity(request: KnowledgeEntityDelete): Promise<KnowledgeEntityDeletion>;
  /** Deletes the relation, lesson or «searched — found nothing» and queues the cleanup of its vector. */
  deleteRelation(request: KnowledgeRelationDelete): Promise<KnowledgeRelationDeletion>;
  settings(): Promise<KnowledgeSettings>;
  updateSettings(update: KnowledgeSettingsUpdate): Promise<KnowledgeSettingsChange>;
}

export interface AgentsKnowledgeDeps {
  readonly database: Database;
  /** `create` of a vector pass in the deletion's transaction. */
  readonly tasks: Pick<Runtime['tasks'], 'create'>;
  /** Only `model()`: the view never calls the provider. */
  readonly embeddings: Pick<AgentsEmbeddings, 'model'>;
  /** Only `list`: which records have a vector of the current model. */
  readonly store: Pick<KnowledgeVectorStore, 'list'>;
  readonly logger: Logger;
}

/** How a deletion left the deep agent's vector pass. */
type VectorCleanup = 'pass_created' | 'pass_marked';

export function createAgentsKnowledge(deps: AgentsKnowledgeDeps): AgentsKnowledge {
  const { database, embeddings, store } = deps;
  const logger = deps.logger.child({ service: 'agents.knowledge' });

  /**
   * The cleanup of a deleted record's vector (KD-8, Flow 3): in the deletion's transaction, under the vector
   * row's lock. No pass in progress — a new pass the platform pays for (`payer_id` `null`: only a deletion
   * asked for it); a pass in progress — only «one more pass», its payer unchanged. The pass removes every key
   * without a graph record, so no vector of the deleted record is found after it (Invariant 10).
   */
  async function queueVectorCleanup(tx: RuntimeTx, recordId: string): Promise<VectorCleanup> {
    const row = await ensureEmbeddingRow(tx, recordId);
    if (row.passTaskId !== null) {
      await updateEmbeddingRow(tx, recordId, { needsPass: true });
      return 'pass_marked';
    }
    const passTaskId = await deps.tasks.create(embedPassRequest(recordId), tx);
    await updateEmbeddingRow(tx, recordId, { passTaskId, payerId: null });
    return 'pass_created';
  }

  /**
   * One deletion: the graph lock first, so it never interleaves with a round's commit (Invariant 5), then
   * the delete, then — only when something was deleted — the vector cleanup, all in one transaction.
   */
  async function deleteUnderLock<T extends { readonly deleted: boolean }>(
    recordId: string,
    remove: (tx: RuntimeTx) => Promise<T>,
  ): Promise<{ readonly result: T; readonly cleanup: VectorCleanup | null }> {
    return database.transaction(async (tx) => {
      await lockGraph(tx, recordId);
      const result = await remove(tx);
      const cleanup = result.deleted ? await queueVectorCleanup(tx, recordId) : null;
      return { result, cleanup };
    });
  }

  return {
    async view({ recordId, selfLearning, servers }) {
      const startedAt = Date.now();
      const settings = await readKnowledgeSettings(database);
      const items = graphItemsOf(await readGraph(database, recordId));
      const toolAlive = await registryToolAlive(database, servers);
      const embedding = await embeddingState(database, embeddings, store, recordId);
      const parts = knowledgeViewParts({ items, settings, toolAlive, selfLearning, embedding });
      const last = await lastExtractionOf(database, recordId);
      logger.info('knowledge view read', {
        recordId,
        selfLearning,
        graphItems: items.length,
        selection: parts.selection.state,
        ...parts.counts,
        lastExtraction: last?.status ?? null,
        durationMs: Date.now() - startedAt,
      });
      return {
        selfLearning,
        lessonsEnabled: settings.lessonsEnabled,
        selection: parts.selection,
        counts: parts.counts,
        items: parts.items,
        lastExtraction: last,
      };
    },

    async deleteEntity({ recordId, entityId }) {
      const startedAt = Date.now();
      const { result, cleanup } = await deleteUnderLock(recordId, (tx) =>
        deleteEntity(tx, recordId, entityId),
      );
      logger.info('knowledge entity delete', {
        recordId,
        entityId,
        deleted: result.deleted,
        relations: result.relations,
        vectorCleanup: cleanup,
        durationMs: Date.now() - startedAt,
      });
      return result;
    },

    async deleteRelation({ recordId, relationId }) {
      const startedAt = Date.now();
      const { result, cleanup } = await deleteUnderLock(recordId, async (tx) => ({
        deleted: await deleteRelation(tx, recordId, relationId),
      }));
      logger.info('knowledge relation delete', {
        recordId,
        relationId,
        deleted: result.deleted,
        vectorCleanup: cleanup,
        durationMs: Date.now() - startedAt,
      });
      return result;
    },

    async settings() {
      return settingsView(await readKnowledgeSettings(database));
    },

    async updateSettings({ actorId, limitTokens, lessonsEnabled }) {
      const startedAt = Date.now();
      const change = await database.transaction((tx) =>
        writeKnowledgeSettings(tx, { limitTokens, lessonsEnabled }),
      );
      const before = settingsView(change.before);
      const after = settingsView(change.after);
      logger.info('knowledge settings updated', {
        actorId,
        before: { limitTokens: before.limitTokens, lessonsEnabled: before.lessonsEnabled },
        after: { limitTokens: after.limitTokens, lessonsEnabled: after.lessonsEnabled },
        durationMs: Date.now() - startedAt,
      });
      return { before, after };
    },
  };
}

function settingsView(row: KnowledgeSettingsRow): KnowledgeSettings {
  return {
    limitTokens: row.limitTokens,
    lessonsEnabled: row.lessonsEnabled,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/**
 * What the screen needs of selection by meaning (Contract `KnowledgeSelection`): the current model without
 * a provider request, the deep agent's last embedding attempt and the store's keys — no `embed` call.
 */
async function embeddingState(
  database: Database,
  embeddings: Pick<AgentsEmbeddings, 'model'>,
  store: Pick<KnowledgeVectorStore, 'list'>,
  recordId: string,
): Promise<EmbeddingState> {
  const choice = await embeddings.model();
  const row = await findEmbeddingRow(database, recordId);
  const vectors = await store.list(recordId);
  return {
    model: choice.kind === 'model' ? choice.model : null,
    lastFailure: lastFailureOf(row),
    vectors,
  };
}

/** The deep agent's last embedding attempt when it failed with a model; a success or no attempt — `null`. */
function lastFailureOf(row: KnowledgeEmbeddingRow | undefined): EmbeddingState['lastFailure'] {
  if (row?.lastReason == null || row.lastModel === null) return null;
  return { reason: EmbeddingFailureReasonSchema.parse(row.lastReason), model: row.lastModel };
}

/**
 * The last round of any run of the deep agent (Contract `LastExtraction`), or `null`. A round the trigger
 * ended (`stopped`, `interrupted`) has no model of its own; the extraction runs on the deep agent's model
 * (KD-4), so the run's session names it — the run row lives exactly as long as that session.
 */
async function lastExtractionOf(
  database: Database,
  recordId: string,
): Promise<LastExtraction | null> {
  const row = await lastExtraction(database, recordId);
  if (row?.lastAt == null) return null;
  const model = row.lastModel ?? (await sessions.get(database, row.runId))?.model;
  if (model === undefined)
    throw new Error(`knowledge run ${row.runId} has no model and no session`);
  return {
    at: row.lastAt.toISOString(),
    model,
    status: LastExtractionStatusSchema.parse(row.lastStatus),
    added: row.lastAdded ?? 0,
    confirmed: row.lastConfirmed ?? 0,
    outdated: row.lastOutdated ?? 0,
    reason: LastExtractionReasonSchema.nullable().parse(row.lastReason),
  };
}
