import { createDatabase } from '@agent-os/db';
import type pg from 'pg';
import { databaseUrl } from './database-url.js';

let pool: pg.Pool | undefined;

/** The test's own connections, apart from the runtime's pool. */
function db(): pg.Pool {
  pool ??= createDatabase({ connectionString: databaseUrl(), poolMax: 2 }).pool;
  return pool;
}

/** A task row as the runtime stored it. */
export interface TaskSnapshot {
  taskId: string;
  status: string;
  attempt: number;
  outputRefs: string[];
}

/** A stored event with the serialized size of its payload. */
export interface EventSnapshot {
  seq: number;
  eventId: string;
  type: string;
  taskId: string | null;
  causationId: string | null;
  correlationId: string;
  payloadRef: string | null;
  payloadBytes: number;
}

/** Tasks of the investigation by `taskId`. */
export async function tasksOf(
  investigationId: string,
): Promise<Map<string, TaskSnapshot>> {
  const { rows } = await db().query<TaskSnapshot>(
    `SELECT task_id AS "taskId", status, attempt, output_refs::text[] AS "outputRefs"
       FROM app.research_tasks WHERE investigation_id = $1`,
    [investigationId],
  );
  return new Map(rows.map((row) => [row.taskId, row]));
}

/** Events of the investigation in `seq` order. */
export async function eventsOf(
  investigationId: string,
): Promise<EventSnapshot[]> {
  const { rows } = await db().query<EventSnapshot>(
    `SELECT seq::int AS seq, event_id AS "eventId", type, task_id AS "taskId",
            causation_id AS "causationId", correlation_id AS "correlationId",
            payload_ref AS "payloadRef", octet_length(payload::text) AS "payloadBytes"
       FROM app.research_events WHERE investigation_id = $1 ORDER BY seq`,
    [investigationId],
  );
  return rows;
}

/** Knowledge status of every evidence of the investigation, by `evidenceId`. */
export async function knowledgeStatusesOf(
  investigationId: string,
): Promise<Map<string, string>> {
  const { rows } = await db().query<{
    evidenceId: string;
    knowledgeStatus: string;
  }>(
    `SELECT evidence_id AS "evidenceId", knowledge_status AS "knowledgeStatus"
       FROM app.research_evidence WHERE investigation_id = $1`,
    [investigationId],
  );
  return new Map(rows.map((row) => [row.evidenceId, row.knowledgeStatus]));
}

/** A statement outside the runtime, e.g. a write the schema must reject. */
export async function query<Row extends pg.QueryResultRow>(
  text: string,
  values: unknown[],
): Promise<Row[]> {
  const { rows } = await db().query<Row>(text, values);
  return rows;
}

/** Closes the test's connections; call from `afterAll`. */
export async function closeRuntimeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
