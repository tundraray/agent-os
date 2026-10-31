import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { EvidenceInput, TaskSpec } from '@agent-os/contracts';
import type {
  HandlerResult,
  TaskContext,
  TaskHandler,
} from '@agent-os/runtime';
import pg from 'pg';
import { z } from 'zod';

/**
 * The single source of helpers for `apps/api` tests that run the runtime's workers (wiring of
 * `ResearchModule`): test handlers, latches and read-only snapshots of `research_*` rows over the
 * test's own connections. The runtime package keeps its own copies under `packages/runtime/test`;
 * `apps/api` never imports files of another package (ADR-0004). Ordering is driven by latches the
 * test releases, never by sleeps.
 */

// ---------------------------------------------------------------------------------------------
// Test handlers
// ---------------------------------------------------------------------------------------------

/** Version of every test workflow. */
const TEST_WORKFLOW_VERSION = 1;

/** A one-shot gate: `promise` resolves on the first `release()`. */
export interface Latch {
  readonly promise: Promise<void>;
  release(): void;
}

export function latch(): Latch {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * `promise`, or a failure naming `what` after `ms`: a latch that never opens fails the test
 * with a reason instead of hanging it. A guard, not a delay — nothing waits for it to elapse.
 */
export async function within<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${ms} ms waiting for ${what}`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A workflow type unique to one test: workers of other tests never claim its tasks. */
export function uniqueWorkflowType(label: string): string {
  return `test-${label}-${randomUUID()}`;
}

/** A handler of `workflowType` running `run`; `input` is any JSON object. */
export function testHandler(
  workflowType: string,
  run: (ctx: TaskContext) => Promise<HandlerResult>,
): TaskHandler {
  return {
    workflowType,
    workflowVersion: TEST_WORKFLOW_VERSION,
    inputSchema: z.record(z.string(), z.unknown()),
    run,
  };
}

/** A `completed` result; fields not given are empty. */
export function completed(
  fields: Partial<Omit<HandlerResult, 'kind'>> = {},
): HandlerResult {
  return {
    kind: 'completed',
    answerOrDelta: null,
    evidenceRefs: [],
    coverage: null,
    missingEvidence: [],
    warnings: [],
    proposedTasks: [],
    ...fields,
  };
}

/** Evidence of one fixture page with the given content. */
export function evidenceInput(
  evidenceKey: string,
  bytes: Uint8Array<ArrayBuffer>,
): EvidenceInput {
  return {
    evidenceKey,
    provenance: {
      sourceId: 'test-fixture',
      toolName: 'fixture.read',
      normalizedArgs: { key: evidenceKey },
      snapshot: 'snapshot-1',
    },
    coverage: {
      completeness: 'complete',
      totalMatched: 1,
      totalRelation: 'eq',
      returned: 1,
      truncated: false,
      continuation: null,
    },
    content: { mediaType: 'application/octet-stream', bytes },
  };
}

/** A spec of a test workflow task: budget of 2 tool calls, no retries, a 60 s deadline. */
export function taskSpec(spec: {
  investigationId: string;
  workflowType: string;
  input: Record<string, string>;
  dependsOn?: string[];
}): TaskSpec {
  return {
    investigationId: spec.investigationId,
    workflowType: spec.workflowType,
    workflowVersion: TEST_WORKFLOW_VERSION,
    input: spec.input,
    inputRefs: [],
    expectedOutput: { description: 'test output', completeness: 'all' },
    dependsOn: spec.dependsOn ?? [],
    budget: {
      maxToolCalls: 2,
      maxRetries: 0,
      deadlineMs: 60_000,
      maxTokens: 0,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Row snapshots over the test's own connections
// ---------------------------------------------------------------------------------------------

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

let pool: pg.Pool | undefined;

/** `DATABASE_URL` as the app sees it: the process environment first, otherwise `apps/api/.env`. */
function databaseUrl(): string {
  if (!process.env.DATABASE_URL) process.loadEnvFile(ENV_FILE);
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  return url;
}

/** The test's own connections, apart from the app's pool. */
function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: databaseUrl(), max: 2 });
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

/**
 * Tasks of the investigation by `taskId`.
 * @public for the wiring tests of other parts (mcp-source `sources-wiring`)
 */
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

/**
 * Events of the investigation in `seq` order.
 * @public for the wiring tests of other parts (mcp-source `sources-wiring`)
 */
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

/**
 * Knowledge status of every evidence of the investigation, by `evidenceId`.
 * @public for the wiring tests of other parts (mcp-source `sources-wiring`)
 */
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
