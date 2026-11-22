import type { Logger } from '@agent-os/common';
import {
  EmbeddingFailureReasonSchema,
  type KnowledgeSettings,
  type KnowledgeView,
  type LastExtraction,
  LastExtractionReasonSchema,
  LastExtractionStatusSchema,
} from '@agent-os/contracts';
import {
  AgentKnowledgeRepository,
  AgentKnowledgeRunsRepository,
  AgentKnowledgeVectorsRepository,
  AgentMcpServersRepository,
  Db,
  type KnowledgeEmbeddingRow,
  type KnowledgeSettingsRow,
} from '@agent-os/db';
import { TaskControl } from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';

import { AGENTS_LOGGER } from '../agents.tokens';
import { AgentsEmbeddings } from '../embeddings/embeddings';
import { Sessions } from '../store/sessions';
import { graphItemsOf, registryToolAlive } from './knowledge-block';
import { embedPassRequest, holdKnowledgeOf } from './knowledge-tasks';
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

/** How a deletion left the deep agent's vector pass. */
type VectorCleanup = 'pass_created' | 'pass_marked';

/**
 * The knowledge operations of `apps/api` (design-core.md KD-1, KD-7, Contract `Agents.knowledge`). They
 * decide nothing about who may call them — the route asks the library first — and each touches only the
 * rows of the record it is given.
 */
@Injectable()
export class AgentsKnowledge {
  private readonly logger: Logger;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Sessions) private readonly sessions: Sessions,
    @Inject(AgentKnowledgeRepository)
    private readonly knowledgeRows: AgentKnowledgeRepository,
    @Inject(AgentKnowledgeRunsRepository)
    private readonly knowledgeRunRows: AgentKnowledgeRunsRepository,
    @Inject(AgentMcpServersRepository)
    private readonly mcpServerRows: AgentMcpServersRepository,
    /** `create` of a vector pass in the deletion's transaction. */
    @Inject(TaskControl) private readonly tasks: Pick<TaskControl, 'create'>,
    /** Only `model()`: the view never calls the provider. */
    @Inject(AgentsEmbeddings)
    private readonly embeddings: Pick<AgentsEmbeddings, 'model'>,
    /** Only `list`: which records have a vector of the current model. */
    @Inject(AgentKnowledgeVectorsRepository)
    private readonly store: Pick<KnowledgeVectorStore, 'list'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.knowledge' });
  }

  /** The graph for the knowledge screen; reads only, no embeddings call (C3 «экран знаний»). */
  async view({
    recordId,
    selfLearning,
    servers,
  }: KnowledgeViewRequest): Promise<KnowledgeView> {
    const startedAt = Date.now();
    const settings = await this.knowledgeRows.readSettings();
    const items = graphItemsOf(await this.knowledgeRows.readGraph(recordId));
    const toolAlive = await registryToolAlive(
      { mcpServerRows: this.mcpServerRows },
      servers,
    );
    const embedding = await this.embeddingState(recordId);
    const parts = knowledgeViewParts({
      items,
      settings,
      toolAlive,
      selfLearning,
      embedding,
    });
    const last = await this.lastExtractionOf(recordId);
    this.logger.info('knowledge view read', {
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
  }

  /** Deletes the entity with its fact relations and queues the cleanup of their vectors. */
  async deleteEntity({
    recordId,
    entityId,
  }: KnowledgeEntityDelete): Promise<KnowledgeEntityDeletion> {
    const startedAt = Date.now();
    const { result, cleanup } = await this.deleteWithCleanup(recordId, () =>
      this.knowledgeRows.deleteEntity(recordId, entityId),
    );
    this.logger.info('knowledge entity delete', {
      recordId,
      entityId,
      deleted: result.deleted,
      relations: result.relations,
      vectorCleanup: cleanup,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  /** Deletes the relation, lesson or «searched — found nothing» and queues the cleanup of its vector. */
  async deleteRelation({
    recordId,
    relationId,
  }: KnowledgeRelationDelete): Promise<KnowledgeRelationDeletion> {
    const startedAt = Date.now();
    const { result, cleanup } = await this.deleteWithCleanup(
      recordId,
      async () => ({
        deleted: await this.knowledgeRows.deleteRelation(recordId, relationId),
      }),
    );
    this.logger.info('knowledge relation delete', {
      recordId,
      relationId,
      deleted: result.deleted,
      vectorCleanup: cleanup,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  async settings(): Promise<KnowledgeSettings> {
    return settingsView(await this.knowledgeRows.readSettings());
  }

  async updateSettings({
    actorId,
    limitTokens,
    lessonsEnabled,
  }: KnowledgeSettingsUpdate): Promise<KnowledgeSettingsChange> {
    const startedAt = Date.now();
    const change = await this.db.transaction(async () =>
      this.knowledgeRows.writeSettings({ limitTokens, lessonsEnabled }),
    );
    const before = settingsView(change.before);
    const after = settingsView(change.after);
    this.logger.info('knowledge settings updated', {
      actorId,
      before: {
        limitTokens: before.limitTokens,
        lessonsEnabled: before.lessonsEnabled,
      },
      after: {
        limitTokens: after.limitTokens,
        lessonsEnabled: after.lessonsEnabled,
      },
      durationMs: Date.now() - startedAt,
    });
    return { before, after };
  }

  /**
   * The cleanup of a deleted record's vector (KD-8, Flow 3): in the deletion's transaction, by the vector row
   * it started with.
   * No pass in progress — a new pass the platform pays for (`payer_id` `null`: only a deletion
   * asked for it); a pass in progress — only «one more pass», its payer unchanged. The pass removes every key
   * without a graph record, so no vector of the deleted record is found after it (Invariant 10).
   */
  private async queueVectorCleanup(
    recordId: string,
    row: KnowledgeEmbeddingRow,
  ): Promise<VectorCleanup> {
    if (row.passTaskId !== null) {
      await this.knowledgeRunRows.updateEmbeddingRow(recordId, {
        needsPass: true,
      });
      return 'pass_marked';
    }
    const passTaskId = await this.tasks.create(embedPassRequest(recordId));
    await this.knowledgeRunRows.updateEmbeddingRow(recordId, {
      passTaskId,
      payerId: null,
    });
    return 'pass_created';
  }

  /**
   * One deletion: the deep agent's vector row first, so it never interleaves with a round's commit or the
   * trigger (Invariant 5), then the delete, then — only when something was deleted — the vector cleanup, all
   * in one transaction.
   */
  private async deleteWithCleanup<T extends { readonly deleted: boolean }>(
    recordId: string,
    remove: () => Promise<T>,
  ): Promise<{ readonly result: T; readonly cleanup: VectorCleanup | null }> {
    return this.db.transaction(async () => {
      const row = await holdKnowledgeOf(
        this.db,
        this.knowledgeRunRows,
        recordId,
      );
      const result = await remove();
      const cleanup =
        result.deleted && row !== undefined
          ? await this.queueVectorCleanup(recordId, row)
          : null;
      return { result, cleanup };
    });
  }

  /**
   * What the screen needs of selection by meaning (Contract `KnowledgeSelection`): the current model without
   * a provider request, the deep agent's last embedding attempt and the store's keys — no `embed` call.
   */
  private async embeddingState(recordId: string): Promise<EmbeddingState> {
    const choice = await this.embeddings.model();
    const row = await this.knowledgeRunRows.findEmbeddingRow(recordId);
    const vectors = await this.store.list(recordId);
    return {
      model: choice.kind === 'model' ? choice.model : null,
      lastFailure: lastFailureOf(row),
      vectors,
    };
  }

  /**
   * The last round of any run of the deep agent (Contract `LastExtraction`), or `null`. A round the trigger
   * ended (`stopped`, `interrupted`) has no model of its own; the extraction runs on the deep agent's model
   * (KD-4), so the run's session names it — the run row lives exactly as long as that session.
   */
  private async lastExtractionOf(
    recordId: string,
  ): Promise<LastExtraction | null> {
    const row = await this.knowledgeRunRows.lastExtraction(recordId);
    if (row?.lastAt == null) return null;
    const model = row.lastModel ?? (await this.sessions.get(row.runId))?.model;
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
}

function settingsView(row: KnowledgeSettingsRow): KnowledgeSettings {
  return {
    limitTokens: row.limitTokens,
    lessonsEnabled: row.lessonsEnabled,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/** The deep agent's last embedding attempt when it failed with a model; a success or no attempt — `null`. */
function lastFailureOf(
  row: KnowledgeEmbeddingRow | undefined,
): EmbeddingState['lastFailure'] {
  if (row?.lastReason == null || row.lastModel === null) return null;
  return {
    reason: EmbeddingFailureReasonSchema.parse(row.lastReason),
    model: row.lastModel,
  };
}
