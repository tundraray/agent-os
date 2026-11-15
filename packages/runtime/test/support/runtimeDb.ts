import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '@agent-os/db';
import type pg from 'pg';
import { databaseUrl } from './database-url.js';
import { HANDLER_ROWS_TABLE } from './testHandlers.js';

/**
 * Read-only snapshots of the rows the runtime and the test handlers wrote, over the test's own
 * connections apart from any runtime's pool. Nothing here writes.
 */

const SETTLE_POLL_MS = 25;

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
  sender: string;
  payload: unknown;
  revive: boolean;
  status: string;
  deliveredStep: number | null;
}

/** Every message of the recipient, delivered or not, by `seq`. */
export function inboxOf(recipientId: string): Promise<MessageSnapshot[]> {
  return select<MessageSnapshot>(
    `SELECT message_id AS "messageId", seq, kind, sender, payload, revive, status,
            delivered_step AS "deliveredStep"
       FROM app.runtime_inbox WHERE recipient_id = $1 ORDER BY seq`,
    [recipientId],
  );
}

/** An event about one task as stored. */
export interface EventSnapshot {
  type: string;
  payload: Record<string, unknown>;
}

/** Events about the task, by `seq`. */
export function eventsOf(taskId: string): Promise<EventSnapshot[]> {
  return select<EventSnapshot>(
    `SELECT type, payload FROM app.runtime_events WHERE task_id = $1 ORDER BY seq`,
    [taskId],
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
export function handlerRowsOf(taskIds: readonly string[]): Promise<HandlerRow[]> {
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

/** A stored row of a tree with its version: `xmin` changes on every update of the row. */
export interface RowVersion {
  table: string;
  id: string;
  version: string;
}

/**
 * Every task, message, decision request and event of the tree with its row version, by table and
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
     UNION ALL
     SELECT 'decisions', decision_id::text, xmin::text
       FROM app.runtime_decisions WHERE root_id = $1
     UNION ALL
     SELECT 'events', event_id::text, xmin::text
       FROM app.runtime_events WHERE root_id = $1
     ORDER BY 1, 2`,
    [rootId],
  );
}

/**
 * Polls `read` until `done` holds and returns that value; fails naming `what` and the last value
 * after `timeoutMs`. Tests synchronise on rows with it, never on sleeps.
 */
export async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs} ms waiting for ${what}; last: ${JSON.stringify(
          value instanceof Map ? [...value] : value,
        )}`,
      );
    }
    await delay(SETTLE_POLL_MS);
    value = await read();
  }
  return value;
}

/** Closes the test's own connections; call from `afterAll`. */
export async function closeRuntimeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
