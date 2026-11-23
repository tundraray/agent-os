import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ModelDefaultsSchema } from '@agent-os/contracts';
import type { DatabaseConnection } from '@agent-os/db';
import type { App } from 'supertest/types.js';
import { expectBody } from './api';
import { apiRequest, type Session } from './session';

/**
 * The knowledge graph of the tests (self-learning design-core.md, Test Strategy UC-8): graph rows written straight
 * into `app.agent_knowledge_*` for a workflow record — the extraction pipeline is not exercised by the API suite —
 * and the default embedding model taken away for a file. The graph rows go with their workflow (cascade from
 * `agents`), so a suite removes them by removing its employees (`removeRunRows`).
 */

type Pool = DatabaseConnection['pool'];

/** The type of the vector pass a deletion queues (`KNOWLEDGE_EMBED_TASK_TYPE` of `@agent-os/agents`, not exported). */
const KNOWLEDGE_EMBED_TASK_TYPE = 'knowledge.embed';

/** A seeded entity as the view shows it. */
export interface SeededEntity {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly confirmations: number;
  /** ISO `confirmed_at`: the item's `date`. */
  readonly date: string;
}

/** A seeded fact relation `from` → `to`. */
export interface SeededRelation {
  readonly id: number;
  readonly label: string;
  readonly confirmations: number;
  readonly date: string;
}

/** The graph `seedKnowledge` wrote: two entities and the fact relation between them. */
export interface SeededGraph {
  readonly from: SeededEntity;
  readonly to: SeededEntity;
  readonly relation: SeededRelation;
}

/**
 * Writes two entities and a fact relation between them into the graph of `recordId`, with the run columns
 * (`source_run_id`, `confirmed_by_run_id`) set as an extraction sets them; every text carries a random marker,
 * so an assertion on its absence cannot pass by accident. Confirmations and dates differ, so the common order
 * is fixed: `from` (2 confirmations), then `relation` (newer), then `to`.
 */
export async function seedKnowledge(
  pool: Pool,
  recordId: string,
): Promise<SeededGraph> {
  const marker = randomUUID().slice(0, 8);
  const runId = randomUUID();
  const from = await insertEntity(pool, recordId, runId, {
    name: `Платёжный шлюз ${marker}`,
    description: `Принимает оплату картой ${marker}`,
    confirmations: 2,
    date: '2026-11-01T10:00:00.000Z',
  });
  const to = await insertEntity(pool, recordId, runId, {
    name: `Банк-эквайер ${marker}`,
    description: `Проводит платежи шлюза ${marker}`,
    confirmations: 1,
    date: '2026-11-02T10:00:00.000Z',
  });
  const relationFields = {
    label: `отправляет платежи в ${marker}`,
    confirmations: 1,
    date: '2026-11-03T10:00:00.000Z',
  };
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO app.agent_knowledge_relations
       (record_id, confirmations, confirmed_at, source_run_id, confirmed_by_run_id, kind, from_entity_id, to_entity_id, label)
     VALUES ($1, $2, $3, $4, $4, 'fact', $5, $6, $7) RETURNING id`,
    [
      recordId,
      relationFields.confirmations,
      relationFields.date,
      runId,
      from.id,
      to.id,
      relationFields.label,
    ],
  );
  return { from, to, relation: { id: idOf(rows), ...relationFields } };
}

async function insertEntity(
  pool: Pool,
  recordId: string,
  runId: string,
  entity: Omit<SeededEntity, 'id'>,
): Promise<SeededEntity> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO app.agent_knowledge_entities
       (record_id, confirmations, confirmed_at, source_run_id, confirmed_by_run_id, name, description)
     VALUES ($1, $2, $3, $4, $4, $5, $6) RETURNING id`,
    [
      recordId,
      entity.confirmations,
      entity.date,
      runId,
      entity.name,
      entity.description,
    ],
  );
  return { id: idOf(rows), ...entity };
}

function idOf(rows: readonly { id: number }[]): number {
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('The graph insert returned no row');
  return id;
}

/**
 * Sets the platform's default embedding model to `null` (not chosen) through `PUT /api/admin/model-defaults`,
 * keeping the chat model. Call it after `useRunModels`: its restore, run in `afterAll`, puts back the embedding
 * model it read before, so this needs no restore of its own.
 */
export async function clearEmbeddingModel(
  app: INestApplication<App>,
  admin: Session,
): Promise<void> {
  const current = await expectBody(
    apiRequest(app, admin, 'get', '/admin/model-defaults'),
    200,
    ModelDefaultsSchema,
  );
  await expectBody(
    apiRequest(app, admin, 'put', '/admin/model-defaults', {
      chatModel: current.chatModel,
      embeddingModel: null,
    }),
    200,
    ModelDefaultsSchema,
  );
}

/**
 * Deletes the vector passes a graph deletion queued for `recordIds` (owned by the platform, so `removeRunRows`
 * does not find them); with the workers off they are never run.
 */
export async function removeKnowledgeTasks(
  pool: Pool,
  recordIds: readonly string[],
): Promise<void> {
  await pool.query(
    `DELETE FROM app.runtime_tasks WHERE type = $1 AND input->>'recordId' = ANY($2::text[])`,
    [KNOWLEDGE_EMBED_TASK_TYPE, recordIds],
  );
}
