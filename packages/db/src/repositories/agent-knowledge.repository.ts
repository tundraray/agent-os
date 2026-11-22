import type { KnowledgeItemType } from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, or } from 'drizzle-orm';
import { Db } from '../db';
import {
  agentKnowledgeEntities,
  agentKnowledgeRelations,
  agentKnowledgeSettings,
} from '../schema';

const entities = agentKnowledgeEntities;
const relations = agentKnowledgeRelations;

export type KnowledgeEntityRow = typeof entities.$inferSelect;
export type KnowledgeRelationRow = typeof relations.$inferSelect;

/** A deep agent's graph as stored, each table by id. */
export interface KnowledgeGraph {
  readonly entities: KnowledgeEntityRow[];
  readonly relations: KnowledgeRelationRow[];
}

/** What a round writes for a new entity; `confirmations`, `outdated` and the dates take defaults when left out. */
export type NewKnowledgeEntity = Omit<typeof entities.$inferInsert, 'id'>;
/** What a round writes for a new relation, lesson or «searched — found nothing». */
export type NewKnowledgeRelation = Omit<typeof relations.$inferInsert, 'id'>;

/** A graph record by its table and id (`e12` is `{ type: 'entity', id: 12 }`). */
export interface KnowledgeItemRef {
  readonly type: KnowledgeItemType;
  readonly id: number;
}

/** A confirmation as `checkOperations` decided it: the new count, the round's date and the run. */
export interface KnowledgeConfirmation {
  readonly item: KnowledgeItemRef;
  readonly confirmations: number;
  readonly at: Date;
  readonly runId: string;
}

export interface EntityDeletion {
  readonly deleted: boolean;
  /** Fact relations that went with the entity by cascade. */
  readonly relations: number;
}

const settingsColumns = {
  limitTokens: agentKnowledgeSettings.limitTokens,
  lessonsEnabled: agentKnowledgeSettings.lessonsEnabled,
  updatedAt: agentKnowledgeSettings.updatedAt,
};

/** The single `agent_knowledge_settings` row. */
export interface KnowledgeSettingsRow {
  readonly limitTokens: number;
  readonly lessonsEnabled: boolean;
  /** `null` while the defaults stand. */
  readonly updatedAt: Date | null;
}

/** The settings before and after a write: the `admin_change` audit is built from them. */
export interface KnowledgeSettingsChange {
  readonly before: KnowledgeSettingsRow;
  readonly after: KnowledgeSettingsRow;
}

/**
 * Drizzle queries of the graph and the settings of self-learning deep agents (KD-1): the only code that reads and writes `agent_knowledge_entities`,
 * `agent_knowledge_relations` and `agent_knowledge_settings`. No method opens a transaction, logs or
 * decides: the rules are the pure functions' (`checkOperations`, `selectKnowledge`).
 */
@Injectable()
export class AgentKnowledgeRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  /** All records of the deep agent's graph, outdated included, by id. */
  async readGraph(recordId: string): Promise<KnowledgeGraph> {
    const entityRows = await this.db.client
      .select()
      .from(entities)
      .where(eq(entities.recordId, recordId))
      .orderBy(asc(entities.id));
    const relationRows = await this.db.client
      .select()
      .from(relations)
      .where(eq(relations.recordId, recordId))
      .orderBy(asc(relations.id));
    return { entities: entityRows, relations: relationRows };
  }

  /** Adds one entity; its id answers the `ref` of the operations that point at it. */
  async insertEntity(entity: NewKnowledgeEntity): Promise<KnowledgeEntityRow> {
    const [row] = await this.db.client.insert(entities).values(entity).returning();
    if (row === undefined) throw new Error('knowledge entity insert returned no row');
    return row;
  }

  /** Adds the relations; an empty list writes nothing. */
  async insertRelations(rows: readonly NewKnowledgeRelation[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.client.insert(relations).values([...rows]);
  }

  /** Writes a confirmation and clears the outdated mark (FR-16). */
  async confirmItem(
    recordId: string,
    { item, confirmations, at, runId }: KnowledgeConfirmation,
  ): Promise<void> {
    const set = { confirmations, confirmedAt: at, confirmedByRunId: runId, outdated: false };
    if (item.type === 'entity') {
      await this.db.client
        .update(entities)
        .set(set)
        .where(and(eq(entities.recordId, recordId), eq(entities.id, item.id)));
      return;
    }
    await this.db.client
      .update(relations)
      .set(set)
      .where(and(eq(relations.recordId, recordId), eq(relations.id, item.id)));
  }

  /** Marks the record outdated (`mark_outdated`). */
  async markOutdated(recordId: string, item: KnowledgeItemRef): Promise<void> {
    if (item.type === 'entity') {
      await this.db.client
        .update(entities)
        .set({ outdated: true })
        .where(and(eq(entities.recordId, recordId), eq(entities.id, item.id)));
      return;
    }
    await this.db.client
      .update(relations)
      .set({ outdated: true })
      .where(and(eq(relations.recordId, recordId), eq(relations.id, item.id)));
  }

  /**
   * Deletes the entity of this deep agent; its fact relations go by cascade (AC-09.2). Counted before the
   * delete.
   */
  async deleteEntity(recordId: string, entityId: number): Promise<EntityDeletion> {
    const [ends] = await this.db.client
      .select({ relations: count() })
      .from(relations)
      .where(
        and(
          eq(relations.recordId, recordId),
          or(eq(relations.fromEntityId, entityId), eq(relations.toEntityId, entityId)),
        ),
      );
    const deleted = await this.db.client
      .delete(entities)
      .where(and(eq(entities.recordId, recordId), eq(entities.id, entityId)))
      .returning({ id: entities.id });
    if (deleted.length === 0) return { deleted: false, relations: 0 };
    return { deleted: true, relations: ends?.relations ?? 0 };
  }

  /** Deletes the relation, lesson or «searched — found nothing» of this deep agent; whether it was there. */
  async deleteRelation(recordId: string, relationId: number): Promise<boolean> {
    const deleted = await this.db.client
      .delete(relations)
      .where(and(eq(relations.recordId, recordId), eq(relations.id, relationId)))
      .returning({ id: relations.id });
    return deleted.length > 0;
  }

  /** The settings row, read anew on every use (settings-row.md); the migration creates it. */
  async readSettings(): Promise<KnowledgeSettingsRow> {
    const [row] = await this.db.client.select(settingsColumns).from(agentKnowledgeSettings);
    if (row === undefined) throw new Error('agent_knowledge_settings row is missing');
    return row;
  }

  /** Writes the administrator's change with its time (KD-7). */
  async writeSettings(
    change: { readonly limitTokens: number; readonly lessonsEnabled: boolean },
  ): Promise<KnowledgeSettingsChange> {
    const [before] = await this.db.client.select(settingsColumns).from(agentKnowledgeSettings);
    if (before === undefined) throw new Error('agent_knowledge_settings row is missing');
    const [after] = await this.db.client
      .update(agentKnowledgeSettings)
      .set({
        limitTokens: change.limitTokens,
        lessonsEnabled: change.lessonsEnabled,
        updatedAt: new Date(),
      })
      .returning(settingsColumns);
    if (after === undefined) throw new Error('agent_knowledge_settings row is missing');
    return { before, after };
  }
}
