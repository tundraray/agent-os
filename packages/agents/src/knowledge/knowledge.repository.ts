import type { KnowledgeItemType } from '@agent-os/contracts';
import {
  agentKnowledgeEntities,
  agentKnowledgeRelations,
  agentKnowledgeSettings,
} from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, count, eq, or, sql } from 'drizzle-orm';

import type { StoreReader } from '../store/sessions.repository.js';

const entities = agentKnowledgeEntities;
const relations = agentKnowledgeRelations;

export type KnowledgeEntityRow = typeof entities.$inferSelect;
export type KnowledgeRelationRow = typeof relations.$inferSelect;

/** A workflow's graph as stored, each table by id. */
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

/*
 * The graph and the settings of self-learning workflows (repository over a transaction, KD-1): the
 * only code that reads and writes `agent_knowledge_entities`, `agent_knowledge_relations` and
 * `agent_knowledge_settings`. No function opens a transaction, logs or decides: the rules are the
 * pure functions' (`checkOperations`, `selectKnowledge`).
 */

/**
 * Queues the writes to one workflow's graph (Invariant 5): a PostgreSQL transaction-level advisory
 * lock, released by the commit or rollback of `tx`. The round commit and the deletions take it as
 * the first statement of their transaction and read the graph after it. The key is the 64-bit
 * `hashtextextended` of the record id's text: different workflows get different keys, and the rare
 * collision only makes two workflows wait for each other — it never lets two writers of one in.
 */
export async function lockGraph(tx: RuntimeTx, recordId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${recordId}, 0))`);
}

/** All records of the workflow's graph, outdated included, by id. */
export async function readGraph(reader: StoreReader, recordId: string): Promise<KnowledgeGraph> {
  const entityRows = await reader
    .select()
    .from(entities)
    .where(eq(entities.recordId, recordId))
    .orderBy(asc(entities.id));
  const relationRows = await reader
    .select()
    .from(relations)
    .where(eq(relations.recordId, recordId))
    .orderBy(asc(relations.id));
  return { entities: entityRows, relations: relationRows };
}

/** Adds one entity; its id answers the `ref` of the operations that point at it. */
export async function insertEntity(
  tx: RuntimeTx,
  entity: NewKnowledgeEntity,
): Promise<KnowledgeEntityRow> {
  const [row] = await tx.insert(entities).values(entity).returning();
  if (row === undefined) throw new Error('knowledge entity insert returned no row');
  return row;
}

/** Adds the relations; an empty list writes nothing. */
export async function insertRelations(
  tx: RuntimeTx,
  rows: readonly NewKnowledgeRelation[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(relations).values([...rows]);
}

/** Writes a confirmation and clears the outdated mark (FR-16). */
export async function confirmItem(
  tx: RuntimeTx,
  recordId: string,
  { item, confirmations, at, runId }: KnowledgeConfirmation,
): Promise<void> {
  const set = { confirmations, confirmedAt: at, confirmedByRunId: runId, outdated: false };
  if (item.type === 'entity') {
    await tx
      .update(entities)
      .set(set)
      .where(and(eq(entities.recordId, recordId), eq(entities.id, item.id)));
    return;
  }
  await tx
    .update(relations)
    .set(set)
    .where(and(eq(relations.recordId, recordId), eq(relations.id, item.id)));
}

/** Marks the record outdated (`mark_outdated`). */
export async function markOutdated(
  tx: RuntimeTx,
  recordId: string,
  item: KnowledgeItemRef,
): Promise<void> {
  if (item.type === 'entity') {
    await tx
      .update(entities)
      .set({ outdated: true })
      .where(and(eq(entities.recordId, recordId), eq(entities.id, item.id)));
    return;
  }
  await tx
    .update(relations)
    .set({ outdated: true })
    .where(and(eq(relations.recordId, recordId), eq(relations.id, item.id)));
}

/**
 * Deletes the entity of this workflow; its fact relations go by cascade (AC-09.2). Counted before the
 * delete: under `lockGraph` nobody adds a relation to it in between.
 */
export async function deleteEntity(
  tx: RuntimeTx,
  recordId: string,
  entityId: number,
): Promise<EntityDeletion> {
  const [ends] = await tx
    .select({ relations: count() })
    .from(relations)
    .where(
      and(
        eq(relations.recordId, recordId),
        or(eq(relations.fromEntityId, entityId), eq(relations.toEntityId, entityId)),
      ),
    );
  const deleted = await tx
    .delete(entities)
    .where(and(eq(entities.recordId, recordId), eq(entities.id, entityId)))
    .returning({ id: entities.id });
  if (deleted.length === 0) return { deleted: false, relations: 0 };
  return { deleted: true, relations: ends?.relations ?? 0 };
}

/** Deletes the relation, lesson or «searched — found nothing» of this workflow; whether it was there. */
export async function deleteRelation(
  tx: RuntimeTx,
  recordId: string,
  relationId: number,
): Promise<boolean> {
  const deleted = await tx
    .delete(relations)
    .where(and(eq(relations.recordId, recordId), eq(relations.id, relationId)))
    .returning({ id: relations.id });
  return deleted.length > 0;
}

/** The settings row, read anew on every use (settings-row.md); the migration creates it. */
export async function readKnowledgeSettings(reader: StoreReader): Promise<KnowledgeSettingsRow> {
  const [row] = await reader.select(settingsColumns).from(agentKnowledgeSettings);
  if (row === undefined) throw new Error('agent_knowledge_settings row is missing');
  return row;
}

/** Locks the row and writes the administrator's change with who and when (KD-7). */
export async function writeKnowledgeSettings(
  tx: RuntimeTx,
  change: { readonly limitTokens: number; readonly lessonsEnabled: boolean; readonly actorId: string },
): Promise<KnowledgeSettingsChange> {
  const [before] = await tx.select(settingsColumns).from(agentKnowledgeSettings).for('update');
  if (before === undefined) throw new Error('agent_knowledge_settings row is missing');
  const [after] = await tx
    .update(agentKnowledgeSettings)
    .set({
      limitTokens: change.limitTokens,
      lessonsEnabled: change.lessonsEnabled,
      updatedAt: new Date(),
      updatedBy: change.actorId,
    })
    .returning(settingsColumns);
  if (after === undefined) throw new Error('agent_knowledge_settings row is missing');
  return { before, after };
}
