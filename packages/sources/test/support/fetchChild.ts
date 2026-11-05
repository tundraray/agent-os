import { type ChildProcess, fork } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import { databaseUrl } from './database-url.js';
import type { FetchChildScenario, StopMessage } from './fetchChildMain.js';
import {
  type CallLogLine,
  FETCH_CHILD_SCENARIO_ENV,
  type FetchArgs,
  fixtureFiles,
  SOURCE_FETCH,
  TEST_SOURCES_ENV,
} from './runtimeHarness.js';

/**
 * Child-process harness of the recovery row of E2E-2 (UC-E11, AC-MS-8). The child runs only compiled code
 * (`pnpm --filter @agent-os/sources build:child` → `dist/test-child/`) and imports the packages by name, so it
 * executes the same built `dist` as `apps/api`; a build older than its sources is refused before anything is
 * spawned (KD-8 of the runtime part).
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_ENTRY = join(PACKAGE_ROOT, 'dist/test-child/test/support/fetchChildMain.js');

/** A build the child executes and the sources it is built from. */
interface ChildBuild {
  /** A file every build rewrites. */
  readonly output: string;
  readonly sources: string;
  readonly command: string;
}

/** This package's, the runtime's, the database package's and the fixture's `dist`, and the child's own entry. */
const CHILD_BUILDS: readonly ChildBuild[] = [
  { output: join(PACKAGE_ROOT, 'dist/index.js'), sources: join(PACKAGE_ROOT, 'src'), command: 'pnpm --filter @agent-os/sources build' },
  {
    output: join(PACKAGE_ROOT, '../runtime/dist/index.js'),
    sources: join(PACKAGE_ROOT, '../runtime/src'),
    command: 'pnpm --filter @agent-os/runtime build',
  },
  { output: join(PACKAGE_ROOT, '../db/dist/index.js'), sources: join(PACKAGE_ROOT, '../db/src'), command: 'pnpm --filter @agent-os/db build' },
  {
    output: join(PACKAGE_ROOT, '../mcp-fixture/dist/server.js'),
    sources: join(PACKAGE_ROOT, '../mcp-fixture/src'),
    command: 'pnpm --filter @agent-os/mcp-fixture build',
  },
  { output: CHILD_ENTRY, sources: join(PACKAGE_ROOT, 'test/support'), command: 'pnpm --filter @agent-os/sources build:child' },
];

/** The crash point of the dying start: right after the evidence of page 2 commits, before its checkpoint. */
const RECOVERY_CRASH_AT = 'handler.after-evidence:2';
/** Exit code of a process ended at a crash point. */
export const CRASH_EXIT_CODE = 137;

/** Runtime Settings of the children: short lease and reaper, fast polling — as the runtime's kill matrix. */
const CHILD_RUNTIME_SETTINGS: Readonly<Record<string, string>> = {
  RUNTIME_CONCURRENCY: '2',
  RUNTIME_POLL_MS: '50',
  RUNTIME_NOTIFY: 'on',
  RUNTIME_LEASE_MS: '1000',
  RUNTIME_HEARTBEAT_MS: '300',
  RUNTIME_REAPER_MS: '200',
  DB_POOL_MAX: '4',
};

/** How long the dying child may take to boot, propose and reach its crash point. */
const CRASH_MS = 60_000;
/** How long the restarted child may take to recover the task and end it: the PRD recovery target (AC-08.4). */
const RECOVERY_MS = 60_000;
const STOP_MS = 30_000;
const POLL_MS = 100;
const OUTPUT_TAIL_LINES = 40;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];

function newestMtime(dir: string): { file: string; mtimeMs: number } {
  let newest = { file: dir, mtimeMs: 0 };
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = join(dir, String(entry));
    const { mtimeMs } = statSync(file);
    if (mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
  }
  return newest;
}

/** Throws, naming the build command, when a build the child executes is missing or older than its sources. */
function assertChildBuildFresh(): void {
  for (const build of CHILD_BUILDS) {
    let builtMs: number;
    try {
      builtMs = statSync(build.output).mtimeMs;
    } catch {
      throw new Error(`Child build ${build.output} is missing; run \`${build.command}\``);
    }
    const newest = newestMtime(build.sources);
    if (newest.mtimeMs > builtMs) {
      throw new Error(`Child build ${build.output} is older than ${newest.file}; run \`${build.command}\``);
    }
  }
}

/** One compiled child process. */
class FetchChild {
  private readonly output: string[] = [];
  private readonly process: ChildProcess;
  /** Exit code (`null` when ended by a signal), once the process has ended. */
  readonly exited: Promise<number | null>;

  constructor(scenario: FetchChildScenario, env: Readonly<Record<string, string>>, crashAt: string | undefined) {
    this.process = fork(CHILD_ENTRY, [], {
      cwd: PACKAGE_ROOT,
      execArgv: ['--enable-source-maps'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ...CHILD_RUNTIME_SETTINGS,
        ...TEST_SOURCES_ENV,
        ...env,
        // The child is the assembly point of its test and reads only its environment.
        DATABASE_URL: databaseUrl(),
        NODE_ENV: 'test',
        RUNTIME_WORKERS: 'on',
        // Empty means unset, also over a value inherited from the environment.
        RUNTIME_CRASH_AT: crashAt ?? '',
        [FETCH_CHILD_SCENARIO_ENV]: JSON.stringify(scenario),
      },
    });
    const keep = (chunk: Buffer): void => {
      this.output.push(...chunk.toString().split('\n'));
      this.output.splice(0, Math.max(this.output.length - OUTPUT_TAIL_LINES, 0));
    };
    this.process.stdout?.on('data', keep);
    this.process.stderr?.on('data', keep);
    this.exited = new Promise((resolve) => {
      this.process.on('exit', (code) => resolve(code));
    });
  }

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  /** Stops the child's runtime and sources over IPC and waits for the exit code. */
  async stop(): Promise<number | null> {
    if (this.running) this.process.send({ kind: 'stop' } satisfies StopMessage);
    return within(this.exited, STOP_MS, () => this.failure(`did not stop within ${STOP_MS} ms`));
  }

  /** Ends the process without a graceful close (cleanup after a failed run). */
  kill(): void {
    if (this.running) this.process.kill('SIGKILL');
  }

  failure(what: string): Error {
    return new Error(`Fetch child ${what}; its last output:\n${this.output.join('\n')}`);
  }
}

/** `promise`, or the error of `failure` after `ms`: a guard, not a delay. */
async function within<T>(promise: Promise<T>, ms: number, failure: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(failure()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------------------------------------
// State of the task, read by the test's own connection
// -------------------------------------------------------------------------------------------

/** The `source.fetch` task of the investigation of `resourceId`. */
export interface FetchTaskRow {
  readonly taskId: string;
  readonly status: string;
  readonly attempt: number;
  readonly recoveryCount: number;
  readonly toolCallsUsed: number;
  readonly outputRefs: readonly string[];
  /** `nextPage` of the saved checkpoint; null without one. */
  readonly checkpointNextPage: number | null;
}

/** One stored page of the task. */
export interface PageRow {
  readonly evidenceId: string;
  readonly evidenceKey: string;
  readonly sha256: string;
  readonly writtenByAttempt: number;
}

type Pool = DatabaseConnection['pool'];

async function taskOf(pool: Pool, resourceId: string): Promise<FetchTaskRow | undefined> {
  const { rows } = await pool.query<FetchTaskRow>(
    `SELECT t.task_id AS "taskId", t.status, t.attempt, t.recovery_count AS "recoveryCount",
            t.tool_calls_used AS "toolCallsUsed", t.output_refs::text[] AS "outputRefs",
            (t.checkpoint->>'nextPage')::int AS "checkpointNextPage"
       FROM app.research_tasks t
       JOIN app.research_investigations i ON i.investigation_id = t.investigation_id
      WHERE i.resource_id = $1`,
    [resourceId],
  );
  if (rows.length > 1) throw new Error(`Expected one task of ${resourceId}, found ${rows.length}`);
  return rows[0];
}

/** Every evidence row of the task, by key; a page stored twice shows up as two rows. */
async function pagesOf(pool: Pool, taskId: string): Promise<PageRow[]> {
  const { rows } = await pool.query<PageRow>(
    `SELECT e.evidence_id AS "evidenceId", e.evidence_key AS "evidenceKey", c.sha256,
            e.written_by_attempt AS "writtenByAttempt"
       FROM app.research_evidence e
       JOIN app.research_evidence_contents c ON c.evidence_id = e.evidence_id
      WHERE e.task_id = $1 ORDER BY e.evidence_key, e.written_by_attempt`,
    [taskId],
  );
  return rows;
}

/**
 * Crash points count their passes over the whole process, and the dispatcher of a child claims every ready
 * `source.fetch` task: one left queued, or running with an expired lease, by another investigation would spend the
 * pass the row aims at. Fails before the first start, naming what is left.
 */
async function assertNoForeignFetchWork(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ claimable: number }>(
    `SELECT count(*)::int AS claimable FROM app.research_tasks
      WHERE workflow_type = $1
        AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))`,
    [SOURCE_FETCH],
  );
  const [{ claimable }] = rows;
  if (claimable === 0) return;
  throw new Error(
    `The recovery row needs a database free of other investigations' source.fetch work, but ${claimable} ` +
      `queued or lease-expired running source.fetch tasks are left (a run killed before its end leaves them); ` +
      `finish or remove them, or run against a fresh database.`,
  );
}

/** Polls `condition` until it yields a value, failing with the child's output when it dies or `ms` passes. */
async function until<T>(child: FetchChild, condition: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = await condition();
    if (value !== undefined) return value;
    if (!child.running) throw child.failure(`exited while waiting for ${what}`);
    if (Date.now() - startedAt > ms) throw child.failure(`did not reach ${what} within ${ms} ms`);
    await delay(POLL_MS);
  }
}

// -------------------------------------------------------------------------------------------
// The recovery run
// -------------------------------------------------------------------------------------------

export interface RecoveryRun {
  /** Exit code of the first child: {@link CRASH_EXIT_CODE} at the crash point. */
  readonly firstExitCode: number | null;
  /** The task and its pages as the dead child left them, read before the restart. */
  readonly atKill: { readonly task: FetchTaskRow; readonly pages: readonly PageRow[] };
  /** The task and its pages after the restarted child ended it. */
  readonly end: { readonly task: FetchTaskRow; readonly pages: readonly PageRow[] };
  /** Exit code of the restarted child after its stop. */
  readonly restartExitCode: number | null;
  /** The fixture call log of both children. */
  readonly callLog: readonly CallLogLine[];
}

/**
 * Proposes one `source.fetch` "all" task in a compiled child that dies at {@link RECOVERY_CRASH_AT}, reads what it
 * left, then starts a fresh child without a crash point and waits until the task ends. Both children share the
 * test's fixture call log; nothing of the test's database is cleaned (isolation by `resourceId`).
 */
export async function runFetchRecovery(options: {
  readonly resourceId: string;
  readonly args: FetchArgs;
}): Promise<RecoveryRun> {
  assertChildBuildFresh();
  const reader = createDatabase({ connectionString: databaseUrl(), poolMax: 2 });
  const files = fixtureFiles();
  const children: FetchChild[] = [];
  const start = (proposed: boolean, crashAt?: string): FetchChild => {
    const scenario: FetchChildScenario = { mode: 'fetch-recovery', resourceId: options.resourceId, args: options.args, proposed };
    const child = new FetchChild(scenario, files.env, crashAt);
    children.push(child);
    return child;
  };
  try {
    await assertNoForeignFetchWork(reader.pool);
    const dying = start(false, RECOVERY_CRASH_AT);
    const firstExitCode = await within(dying.exited, CRASH_MS, () =>
      dying.failure(`did not exit at ${RECOVERY_CRASH_AT} within ${CRASH_MS} ms`),
    );
    const killedTask = await taskOf(reader.pool, options.resourceId);
    if (killedTask === undefined) throw dying.failure('exited before proposing its task');
    const atKill = { task: killedTask, pages: await pagesOf(reader.pool, killedTask.taskId) };

    const restarted = start(true);
    const endTask = await until(
      restarted,
      async () => {
        const task = await taskOf(reader.pool, options.resourceId);
        return task !== undefined && TERMINAL.includes(task.status) ? task : undefined;
      },
      RECOVERY_MS,
      'the end of the recovered task',
    );
    const restartExitCode = await restarted.stop();
    return {
      firstExitCode,
      atKill,
      end: { task: endTask, pages: await pagesOf(reader.pool, endTask.taskId) },
      restartExitCode,
      callLog: files.readCallLog(),
    };
  } finally {
    for (const child of children) child.kill();
    await reader.close();
    files.remove();
  }
}
