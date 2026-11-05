import { fileURLToPath } from 'node:url';
import type { InvestigationService } from '@agent-os/runtime';
import { DOUBLE_CONTROLLER_PREFIX } from './engineDouble.js';
import { query } from './wiring-handlers.js';

/**
 * Read-only snapshots for the chat-entry integration file over the test's own connections (the pool of
 * `wiring-handlers.ts`, closed by its `closeRuntimeDb`): the launch rows of `app.research_chat_launches`, the
 * investigations of a user and the stored messages of a thread with their metadata and `createdAt`. Nothing here
 * writes, apart from {@link cancelLeftovers}, which writes only through the real `InvestigationService.cancel`.
 */

/** A `research_chat_launches` row as stored. */
export interface LaunchRow {
  launchKey: string;
  resourceId: string;
  threadId: string;
  mode: string;
  goal: string;
  tokenBudget: number;
  userMessageId: string | null;
  state: string;
  investigationId: string | null;
  controllerTaskId: string | null;
  sourceMode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  answeredAt: Date | null;
  appendFailedAt: Date | null;
  nextAppendAt: Date | null;
}

const LAUNCH_COLUMNS = `launch_key AS "launchKey", resource_id AS "resourceId", thread_id AS "threadId", mode, goal,
  token_budget AS "tokenBudget", user_message_id AS "userMessageId", state, investigation_id AS "investigationId",
  controller_task_id AS "controllerTaskId", source_mode AS "sourceMode", created_at AS "createdAt",
  finished_at AS "finishedAt", answered_at AS "answeredAt", append_failed_at AS "appendFailedAt",
  next_append_at AS "nextAppendAt"`;

/** Launch rows of the thread, oldest first. */
export function launchesOf(
  resourceId: string,
  threadId: string,
): Promise<LaunchRow[]> {
  return query<LaunchRow>(
    `SELECT ${LAUNCH_COLUMNS} FROM app.research_chat_launches
      WHERE resource_id = $1 AND thread_id = $2 ORDER BY created_at, launch_key`,
    [resourceId, threadId],
  );
}

/** The launch row of `launchKey`, or `undefined` when there is none. */
export async function launchOf(
  launchKey: string,
): Promise<LaunchRow | undefined> {
  const [row] = await query<LaunchRow>(
    `SELECT ${LAUNCH_COLUMNS} FROM app.research_chat_launches WHERE launch_key = $1`,
    [launchKey],
  );
  return row;
}

/**
 * The row version (`xmin`) of every launch row of the user, keyed by `launchKey`. Two equal snapshots mean no launch
 * row of the user was written in between ("nothing changed" checks).
 */
export async function launchVersionsOf(
  resourceId: string,
): Promise<Map<string, string>> {
  const rows = await query<{ launchKey: string; version: string }>(
    `SELECT launch_key AS "launchKey", xmin::text AS version
       FROM app.research_chat_launches WHERE resource_id = $1`,
    [resourceId],
  );
  return new Map(rows.map((row) => [row.launchKey, row.version]));
}

/** An investigation of the runtime as stored. */
export interface InvestigationRow {
  investigationId: string;
  threadId: string;
  query: string;
  status: string;
  createdAt: Date;
}

/** Every investigation of the user, oldest first: "one investigation of this user in this thread" checks. */
export function investigationsOf(
  resourceId: string,
): Promise<InvestigationRow[]> {
  return query<InvestigationRow>(
    `SELECT investigation_id AS "investigationId", thread_id AS "threadId", query, status,
            created_at AS "createdAt"
       FROM app.research_investigations WHERE resource_id = $1
      ORDER BY created_at, investigation_id`,
    [resourceId],
  );
}

/** A stored message of a thread, read from `mastra_messages` past Memory and `toAISdkMessages`. */
export interface StoredMessage {
  id: string;
  role: string;
  createdAt: Date;
  /** The text parts joined in order. */
  text: string;
  /** `content.metadata` of the format-2 message (`deepResearch`, `researchDecision`, `researchAnswer`, …). */
  metadata: Record<string, unknown> | undefined;
  /** The parsed `content` column. */
  content: unknown;
}

interface StoredContent {
  parts?: { type?: string; text?: string }[];
  metadata?: Record<string, unknown>;
}

/** Messages of the thread in stored order (`createdAt`, then `id`). */
export async function storedMessagesOf(
  threadId: string,
): Promise<StoredMessage[]> {
  const rows = await query<{
    id: string;
    role: string;
    createdAt: Date;
    content: string;
  }>(
    `SELECT id, role, "createdAt", content FROM mastra_messages
      WHERE thread_id = $1 ORDER BY "createdAt", id`,
    [threadId],
  );
  return rows.map((row) => {
    const content = JSON.parse(row.content) as StoredContent;
    return {
      id: row.id,
      role: row.role,
      createdAt: row.createdAt,
      text: (content.parts ?? [])
        .flatMap((part) => (part.type === 'text' ? [part.text ?? ''] : []))
        .join(''),
      metadata: content.metadata,
      content,
    };
  });
}

/** How many of the tasks are still `queued` or `running`: a cancelled controller has ended at zero. */
export async function unfinishedTaskCount(
  taskIds: readonly string[],
): Promise<number> {
  const [row] = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM app.research_tasks
      WHERE task_id = ANY($1::uuid[]) AND status IN ('queued', 'running')`,
    [taskIds],
  );
  return row.count;
}

// ---------------------------------------------------------------------------------------------
// Leftover fence
// ---------------------------------------------------------------------------------------------

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Refuses a database that does not look like the local test one: the fence cancels investigations, so it runs only
 * against a local host on the dev test port 5433, or the CI database `agent_os`, or a name containing `test`.
 */
function assertTestDatabase(): void {
  if (!process.env.DATABASE_URL) process.loadEnvFile(ENV_FILE);
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  const { hostname, port, pathname } = new URL(url);
  const name = pathname.slice(1);
  if (
    LOCAL_HOSTS.includes(hostname) &&
    (port === '5433' || name === 'agent_os' || name.includes('test'))
  ) {
    return;
  }
  throw new Error(
    `Refusing to cancel leftover investigations in ${hostname}:${port || '5432'}/${name}: ` +
      'the chat-entry suite fences only a local test database (port 5433, or database agent_os or *test*)',
  );
}

/**
 * The fence of an assembly: every active investigation whose controller is an engine-double task — what an earlier
 * run left, for instance after a failed or killed test — is cancelled through the real `InvestigationService.cancel`,
 * so its rows never reach this run's consumer or delivery loop as live work. Returns how many were cancelled.
 */
export async function cancelLeftovers(
  investigations: Pick<InvestigationService, 'cancel'>,
): Promise<number> {
  assertTestDatabase();
  const leftovers = await query<{
    investigationId: string;
    resourceId: string;
  }>(
    `SELECT DISTINCT i.investigation_id AS "investigationId", i.resource_id AS "resourceId"
       FROM app.research_investigations i
       JOIN app.research_tasks t ON t.investigation_id = i.investigation_id
      WHERE i.status = 'active' AND t.workflow_type LIKE $1`,
    [`test-${DOUBLE_CONTROLLER_PREFIX}-%`],
  );
  for (const { investigationId, resourceId } of leftovers) {
    await investigations.cancel(investigationId, resourceId);
  }
  return leftovers.length;
}
