import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '@agent-os/db';
import type pg from 'pg';
import { databaseUrl } from './database-url.js';

const SETTLE_POLL_MS = 25;

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

/**
 * The test client table of `TaskContext.withAttemptGuard` (design-runtime.md UC-E9): it stands for
 * any client package's table, and its rows go with their task (FK with cascade, as KD-9 requires).
 */
const CLIENT_TABLE = 'public.runtime_test_client_rows';

/** A row the client wrote through `withAttemptGuard`. */
export interface ClientRow {
  attempt: number;
  label: string;
}

/** (Re)creates the test client table; call from `beforeAll`. */
export async function createClientTable(): Promise<void> {
  await db().query(`DROP TABLE IF EXISTS ${CLIENT_TABLE}`);
  await db().query(
    `CREATE TABLE ${CLIENT_TABLE} (
       id serial PRIMARY KEY,
       task_id uuid NOT NULL REFERENCES app.research_tasks (task_id) ON DELETE CASCADE,
       attempt integer NOT NULL,
       label text NOT NULL)`,
  );
}

/** Drops the test client table; call from `afterAll`. */
export async function dropClientTable(): Promise<void> {
  await db().query(`DROP TABLE IF EXISTS ${CLIENT_TABLE}`);
}

/** Client rows of the task in insertion order. */
export async function clientRowsOf(taskId: string): Promise<ClientRow[]> {
  const { rows } = await db().query<ClientRow>(
    `SELECT attempt, label FROM ${CLIENT_TABLE} WHERE task_id = $1 ORDER BY id`,
    [taskId],
  );
  return rows;
}

/**
 * Waits until no investigation holding a task of these workflow types has a `running` task or a
 * pending delivery, both in one snapshot. Call before closing a runtime: closing while an event is
 * still being delivered leaves its delivery pending, and the kill matrix refuses a database with
 * pending `runtime.scheduler` deliveries.
 */
export async function runtimeWorkSettled(
  workflowTypes: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let left = { running: 0, pending: 0 };
  while (Date.now() < deadline) {
    const { rows } = await db().query<{ running: number; pending: number }>(
      `WITH suite AS (
         SELECT DISTINCT investigation_id FROM app.research_tasks
          WHERE workflow_type = ANY($1::text[]))
       SELECT (SELECT count(*)::int FROM app.research_tasks
                WHERE investigation_id IN (SELECT investigation_id FROM suite)
                  AND status = 'running') AS running,
              (SELECT count(*)::int FROM app.research_event_deliveries d
                 JOIN app.research_events e ON e.event_id = d.event_id
                WHERE e.investigation_id IN (SELECT investigation_id FROM suite)
                  AND d.status = 'pending') AS pending`,
      [workflowTypes],
    );
    left = rows[0];
    if (left.running === 0 && left.pending === 0) return;
    await delay(SETTLE_POLL_MS);
  }
  throw new Error(
    `Runtime work of ${workflowTypes.join(', ')} not settled after ${timeoutMs} ms: ` +
      `${left.running} running tasks, ${left.pending} pending deliveries`,
  );
}

export async function closeRuntimeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
