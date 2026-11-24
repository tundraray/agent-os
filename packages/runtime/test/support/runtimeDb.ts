import { createDatabase } from '@agent-os/db';
import type pg from 'pg';
import { databaseUrl } from '@agent-os/db/testing';
import { HANDLER_ROWS_TABLE } from './testHandlers';

/**
 * Read-only snapshots of the rows the runtime and the test handlers wrote, over the test's own
 * connections apart from any runtime's pool. Nothing here writes.
 */

let pool: pg.Pool | undefined;

function db(): pg.Pool {
  pool ??= createDatabase({ connectionString: databaseUrl(), poolMax: 2 }).pool;
  return pool;
}

async function select<Row extends pg.QueryResultRow>(
  text: string,
  values: unknown[],
): Promise<Row[]> {
  const { rows } = await db().query<Row>(text, values);
  return rows;
}

/** A message of a task's inbox as stored. */
export interface MessageSnapshot {
  messageId: string;
  seq: number;
  kind: string;
  payload: unknown;
  revive: boolean;
  /** `delivered_at` is set: a committed step received the message. */
  delivered: boolean;
  deliveredAt: Date | null;
}

/** Every message of the recipient, delivered or not, by `seq` (the table's insertion order). */
export function inboxOf(recipientId: string): Promise<MessageSnapshot[]> {
  return select<MessageSnapshot>(
    `SELECT message_id AS "messageId", seq::float8 AS seq, kind, payload, revive,
            delivered_at IS NOT NULL AS delivered, delivered_at AS "deliveredAt"
       FROM app.runtime_inbox WHERE recipient_id = $1 ORDER BY seq`,
    [recipientId],
  );
}

/** A row a test handler wrote in a step's commit. */
export interface HandlerRow {
  taskId: string;
  stepNo: number;
  attempt: number;
  resumedAfterLoss: boolean;
  note: string | null;
}

/** Handler rows of the tasks, by task, step number and attempt. */
export function handlerRowsOf(
  taskIds: readonly string[],
): Promise<HandlerRow[]> {
  return select<HandlerRow>(
    `SELECT task_id AS "taskId", step_no AS "stepNo", attempt,
            resumed_after_loss AS "resumedAfterLoss", note
       FROM ${HANDLER_ROWS_TABLE} WHERE task_id = ANY($1::uuid[])
      ORDER BY task_id, step_no, attempt`,
    [taskIds],
  );
}

/** Status of each task by `taskId`. */
export async function statusesOf(
  taskIds: readonly string[],
): Promise<Map<string, string>> {
  const rows = await select<{ taskId: string; status: string }>(
    `SELECT task_id AS "taskId", status FROM app.runtime_tasks WHERE task_id = ANY($1::uuid[])`,
    [taskIds],
  );
  return new Map(rows.map((row) => [row.taskId, row.status]));
}

/** `recoveries` of each task by `taskId`: how many times its step in work was lost and requeued. */
export async function recoveriesOf(
  taskIds: readonly string[],
): Promise<Map<string, number>> {
  const rows = await select<{ taskId: string; recoveries: number }>(
    `SELECT task_id AS "taskId", recoveries FROM app.runtime_tasks WHERE task_id = ANY($1::uuid[])`,
    [taskIds],
  );
  return new Map(rows.map((row) => [row.taskId, row.recoveries]));
}

/** A child task as stored: its status, `awaited_step` and row version (`xmin`, changed by every update). */
export interface ChildRow {
  taskId: string;
  status: string;
  awaitedStep: number | null;
  version: string;
}

/** Every child of the parent, in creation order. */
export function childRowsOf(parentId: string): Promise<ChildRow[]> {
  return select<ChildRow>(
    `SELECT task_id AS "taskId", status, awaited_step AS "awaitedStep", xmin::text AS version
       FROM app.runtime_tasks WHERE parent_id = $1 ORDER BY created_seq`,
    [parentId],
  );
}

/** A stored row of a tree with its version: `xmin` changes on every update of the row. */
export interface RowVersion {
  table: string;
  id: string;
  version: string;
}

/**
 * Every task (questions among them) and message of the tree with its row version, by table and
 * id: two equal snapshots mean no row of the tree was inserted, updated or deleted between them.
 */
export function rowVersionsOf(rootId: string): Promise<RowVersion[]> {
  return select<RowVersion>(
    `SELECT 'tasks' AS "table", task_id::text AS id, xmin::text AS version
       FROM app.runtime_tasks WHERE root_id = $1
     UNION ALL
     SELECT 'inbox', message_id::text, i.xmin::text
       FROM app.runtime_inbox i JOIN app.runtime_tasks t ON t.task_id = i.recipient_id
      WHERE t.root_id = $1
     ORDER BY 1, 2`,
    [rootId],
  );
}

/** Closes the test's own connections; call from `afterAll`. */
export async function closeRuntimeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
