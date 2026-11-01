import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createDatabase, type DatabaseConnection, researchEngineRuns, researchInvestigations } from '@agent-os/db';
import { createRuntime, parseRuntimeConfig, systemClock } from '@agent-os/runtime';
import { eq } from 'drizzle-orm';
import { assertTestDatabase, databaseUrl } from './database-url.js';
import type {
  CrashExitCode,
  EngineChildMessage,
  EngineChildScenario,
  EngineChildScenarioEnv,
  StopMessage,
} from './engineChildMain.js';
import { engineRowsOf, engineRunsOf, tasksOf } from './engineDb.js';
import { fixtureFiles } from './fixtureHarness.js';
import { newLaunchKey, newUser } from './new-user.js';

/**
 * Child-process harness of E2E-2 (NFR-03, DC-9, DC-19), modelled on `packages/runtime/test/support/runtimeChild.ts`.
 * The child runs only compiled code (`pnpm --filter @agent-os/engine build:child` → `dist/test-child/`) and imports the
 * packages by name, so it executes the same built `dist` as `apps/api`; a build older than its sources is refused before
 * anything is spawned (KD-8 of the runtime part). A run starts the scenario's investigation in a child that may die at
 * an engine crash point, reads what the dead child left, starts a fresh child that repeats the start with the same
 * `launchKey` and waits until the investigation has its answer. It synchronises only on proven states: the exit of the
 * dying child, then rows of the test database.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_ENTRY = join(PACKAGE_ROOT, 'dist/test-child/test/support/engineChildMain.js');
const SCENARIO_ENV: EngineChildScenarioEnv = 'ENGINE_CHILD_SCENARIO';

/** A build the child executes and the sources it is built from. */
interface ChildBuild {
  /** A file every build rewrites. */
  readonly output: string;
  readonly sources: string;
  readonly command: string;
}

const packageBuild = (dir: string, name: string, entry = 'dist/index.js'): ChildBuild => ({
  output: join(PACKAGE_ROOT, '..', dir, entry),
  sources: join(PACKAGE_ROOT, '..', dir, 'src'),
  command: `pnpm --filter @agent-os/${name} build`,
});

/** This package's, the runtime's, the sources', the database package's and the fixture's `dist`, and the child entry. */
const CHILD_BUILDS: readonly ChildBuild[] = [
  packageBuild('engine', 'engine'),
  packageBuild('runtime', 'runtime'),
  packageBuild('sources', 'sources'),
  packageBuild('db', 'db'),
  packageBuild('mcp-fixture', 'mcp-fixture', 'dist/server.js'),
  { output: CHILD_ENTRY, sources: join(PACKAGE_ROOT, 'test/support'), command: 'pnpm --filter @agent-os/engine build:child' },
];

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

/** Exit code of a process ended at a crash point. */
export const CRASH_EXIT_CODE: CrashExitCode = 137;
/** How long the dying child may take to boot and reach its crash point. */
const CRASH_MS = 60_000;
/** Harness timeout of the recovery: the PRD target (Reliability, AC-08.4); no latency is asserted. */
const RECOVERY_MS = 60_000;
const STOP_MS = 30_000;
const POLL_MS = 100;
const OUTPUT_TAIL_LINES = 60;
const TERMINAL = ['succeeded', 'failed', 'cancelled'];
/** Workflow types whose tasks a child claims: the engine's handlers and `source.fetch`. */
const CHILD_WORKFLOWS = ['research.controller', 'research.analyze', 'research.verify', 'research.synthesize', 'source.fetch'];

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

/** One compiled child process. */
class EngineChild {
  private readonly output: string[] = [];
  private readonly process: ChildProcess;
  /** Exit code (`null` when ended by a signal), once the process has ended. */
  readonly exited: Promise<number | null>;
  /** The IPC channel closed: every message the child sent has arrived. */
  private readonly disconnected: Promise<void>;
  /** Proposals the runtime answered in this process, in order: `[workflowType, outcome]`. */
  readonly proposals: [string, string][] = [];
  started: string | undefined;

  constructor(env: Readonly<Record<string, string>>) {
    this.process = fork(CHILD_ENTRY, [], {
      cwd: PACKAGE_ROOT,
      execArgv: ['--enable-source-maps'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...CHILD_RUNTIME_SETTINGS, ...env },
    });
    const keep = (chunk: Buffer): void => {
      this.output.push(...chunk.toString().split('\n'));
      this.output.splice(0, Math.max(this.output.length - OUTPUT_TAIL_LINES, 0));
    };
    this.process.stdout?.on('data', keep);
    this.process.stderr?.on('data', keep);
    this.process.on('message', (message: EngineChildMessage) => {
      if (message.kind === 'proposed') this.proposals.push([message.workflowType, message.outcome]);
      else this.started = message.outcome;
    });
    this.exited = new Promise((resolve) => {
      this.process.on('exit', (code) => resolve(code));
    });
    this.disconnected = new Promise((resolve) => {
      this.process.on('disconnect', () => resolve());
    });
  }

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  /** Stops the child over IPC; resolves its exit code once every message it sent has arrived. */
  async stop(): Promise<number | null> {
    if (this.running) this.process.send({ kind: 'stop' } satisfies StopMessage);
    const [code] = await within(Promise.all([this.exited, this.disconnected]), STOP_MS, () =>
      this.failure(`did not stop within ${STOP_MS} ms`),
    );
    return code;
  }

  /** Ends the process without a graceful close (cleanup after a failed run). */
  kill(): void {
    if (this.running) this.process.kill('SIGKILL');
  }

  failure(what: string): Error {
    return new Error(`Engine child ${what}; its last output:\n${this.output.join('\n')}`);
  }
}

// -------------------------------------------------------------------------------------------
// State of the scenario's investigation, read by the test's own connections
// -------------------------------------------------------------------------------------------

type Pool = DatabaseConnection['pool'];

/**
 * The fence of a run, as the in-process harness fences its assembly: every active investigation with an engine row — what
 * an earlier run left, for instance after a failed test — is cancelled through the real `InvestigationService.cancel`
 * of a runtime without workers, so a child never claims a foreign controller task that would spend its crash pass.
 */
async function cancelLeftovers(connection: DatabaseConnection): Promise<void> {
  assertTestDatabase(databaseUrl());
  const runtime = createRuntime({
    database: connection,
    config: parseRuntimeConfig({ RUNTIME_WORKERS: 'off' }),
    threads: {
      withOwnedThread: () => Promise.reject(new Error('the fence of E2E-2 owns no thread')),
    },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    clock: systemClock,
  });
  const leftovers = await connection.db
    .select({ investigationId: researchInvestigations.investigationId, resourceId: researchInvestigations.resourceId })
    .from(researchInvestigations)
    .innerJoin(researchEngineRuns, eq(researchEngineRuns.investigationId, researchInvestigations.investigationId))
    .where(eq(researchInvestigations.status, 'active'));
  for (const { investigationId, resourceId } of leftovers) {
    await runtime.investigations.cancel(investigationId, resourceId);
  }
}

/**
 * Crash points count their passes over the whole process, and the dispatcher of a child claims every ready task of the
 * engine's types and of `source.fetch`: such work the fence does not reach (a task of an investigation without an engine
 * row) would be run by the child and spend the pass the row aims at. Fails before the first start, naming what is left.
 */
async function assertNoForeignEngineWork(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ claimable: number }>(
    `SELECT count(*)::int AS claimable FROM app.research_tasks
      WHERE workflow_type = ANY($1)
        AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))`,
    [CHILD_WORKFLOWS],
  );
  const [{ claimable }] = rows;
  if (claimable === 0) return;
  throw new Error(
    `E2E-2 needs a database free of other investigations' engine work, but ${claimable} queued or lease-expired ` +
      `running tasks of the engine's types or of source.fetch are left (a run killed before its end leaves them); ` +
      `finish or remove them, or run against a fresh database.`,
  );
}

async function investigationsOf(pool: Pool, resourceId: string): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM app.research_investigations WHERE resource_id = $1',
    [resourceId],
  );
  return rows[0]?.count ?? 0;
}

type Rows = Awaited<ReturnType<typeof engineRowsOf>>;
type TaskRows = Awaited<ReturnType<typeof tasksOf>>;

/** What a run left in the database: the user's investigations and engine rows, and the rows of its investigation. */
export interface RunRows {
  readonly investigationId: string;
  /** Investigations of the user (one per run: a run has its own user). */
  readonly investigations: number;
  /** Engine rows of the user. */
  readonly engineRuns: number;
  readonly tasks: TaskRows;
  readonly rows: Rows;
}

async function rowsOf(pool: Pool, resourceId: string): Promise<RunRows | undefined> {
  const runs = await engineRunsOf(resourceId);
  const [run] = runs;
  if (run === undefined) return undefined;
  return {
    investigationId: run.investigationId,
    investigations: await investigationsOf(pool, resourceId),
    engineRuns: runs.length,
    tasks: await tasksOf(run.investigationId),
    rows: await engineRowsOf(run.investigationId),
  };
}

/**
 * The end of the investigation free of ids and of what a recovery adds by design (attempts, recovery counts, the
 * abandoned reservation of a killed call): comparable with the uninterrupted reference run.
 */
export interface EndState {
  /** `[workflowType, status, failure class]` in creation order. */
  readonly tasks: [string, string, string | null][];
  /** `[step, callIndex, status, kind, workflow types of the proposed tasks]`. */
  readonly decisions: [number, number, string, string | null, string[]][];
  readonly planRevisions: number;
  /** `[workflow type of the writing task, claimIndex, status, text]` of every revision. */
  readonly claims: [string, number, string, string][];
  readonly answer: { readonly outcome: unknown; readonly stopReason: unknown } | null;
  /** `[role, status]` of every model call that was not abandoned, in order. */
  readonly calls: [string, string][];
}

export function endStateOf({ tasks, rows }: RunRows): EndState {
  const typeOf = new Map(tasks.map((task) => [task.taskId, task.workflowType]));
  const failureClass = (reason: unknown): string | null => (reason as { class?: string } | null)?.class ?? null;
  const answer = rows.run?.answer as { outcome: unknown; stopReason: unknown } | null | undefined;
  return {
    tasks: tasks.map((task) => [task.workflowType, task.status, failureClass(task.failureReason)]),
    decisions: rows.decisions.map((row) => [
      row.step,
      row.callIndex,
      row.status,
      row.kind,
      row.proposedTaskIds.map((taskId) => typeOf.get(taskId) ?? 'unknown'),
    ]),
    planRevisions: rows.planRevisions.length,
    claims: rows.claims.map((row) => [typeOf.get(row.taskId) ?? 'unknown', row.claimIndex, row.status, row.text]),
    answer: answer ? { outcome: answer.outcome, stopReason: answer.stopReason } : null,
    calls: rows.llmCalls.filter((row) => row.status !== 'abandoned').map((row) => [row.role, row.status]),
  };
}

// -------------------------------------------------------------------------------------------
// One run of the scenario
// -------------------------------------------------------------------------------------------

export interface ScenarioOptions {
  /** `ENGINE_CRASH_AT` of the first child; without it the run is the reference run. */
  readonly crashAt?: string;
  /** Runtime Settings of the restarted child over the children's defaults. */
  readonly restartSettings?: Readonly<Record<string, string>>;
}

export interface ScenarioRun {
  /** Exit code of the first child: {@link CRASH_EXIT_CODE} at the crash point, 0 after the stop of the reference run. */
  readonly firstExitCode: number | null;
  /** What the dead child left, read before the restart; absent in the reference run. */
  readonly atKill?: RunRows;
  /** The start and the proposals of the child that ran the investigation to its end. */
  readonly last: { readonly started: string | undefined; readonly proposals: readonly [string, string][] };
  readonly end: RunRows;
  /** `tool argsHash` of every fixture `tools/call` of the run's children. */
  readonly callLog: string[];
}

/** The investigation has its answer and every task of it ended. */
function answered(rows: RunRows | undefined): RunRows | undefined {
  if (rows?.rows.run?.answer == null) return undefined;
  return rows.tasks.every((task) => TERMINAL.includes(task.status)) ? rows : undefined;
}

/**
 * Starts the scenario's investigation in a compiled child: without `crashAt`, to its end in that child (the reference
 * run); with it, until the child exits at the crash point, then in a fresh child that repeats the start with the same
 * `launchKey`, to the end. Each run has its own user, thread, launch key and fixture call log; nothing of the test's
 * database is cleaned (isolation by `resourceId`).
 */
export async function runScenario(options: ScenarioOptions = {}): Promise<ScenarioRun> {
  assertChildBuildFresh();
  const reader = createDatabase({ connectionString: databaseUrl(), poolMax: 2 });
  const files = fixtureFiles();
  const scenario: EngineChildScenario = {
    resourceId: newUser(),
    threadId: `thread-${randomUUID()}`,
    launchKey: newLaunchKey(),
    query: 'Why did the payments fail after the release?',
  };
  const children: EngineChild[] = [];
  const start = (crashAt: string | undefined, settings: Readonly<Record<string, string>> = {}): EngineChild => {
    const child = new EngineChild({
      ...files.env,
      ...settings,
      // The child is the assembly point of its test and reads only its environment.
      DATABASE_URL: databaseUrl(),
      NODE_ENV: 'test',
      RUNTIME_WORKERS: 'on',
      // Empty means unset, also over a value inherited from the environment.
      RUNTIME_CRASH_AT: '',
      ENGINE_CRASH_AT: crashAt ?? '',
      [SCENARIO_ENV]: JSON.stringify(scenario),
    });
    children.push(child);
    return child;
  };
  try {
    await cancelLeftovers(reader);
    await assertNoForeignEngineWork(reader.pool);
    let child = start(options.crashAt);
    let firstExitCode: number | null = null;
    let atKill: RunRows | undefined;
    if (options.crashAt !== undefined) {
      const dying = child;
      firstExitCode = await within(dying.exited, CRASH_MS, () =>
        dying.failure(`did not exit at ${options.crashAt} within ${CRASH_MS} ms`),
      );
      atKill = await rowsOf(reader.pool, scenario.resourceId);
      child = start(undefined, options.restartSettings);
    }

    const last = child;
    const startedAt = Date.now();
    let end: RunRows | undefined;
    for (;;) {
      end = answered(await rowsOf(reader.pool, scenario.resourceId));
      if (end !== undefined) break;
      if (!last.running) throw last.failure('exited before the investigation was answered');
      if (Date.now() - startedAt > RECOVERY_MS) throw last.failure(`did not answer within ${RECOVERY_MS} ms`);
      await delay(POLL_MS);
    }
    const lastExitCode = await last.stop();
    return {
      firstExitCode: options.crashAt === undefined ? lastExitCode : firstExitCode,
      ...(atKill && { atKill }),
      last: { started: last.started, proposals: last.proposals },
      end,
      callLog: files.readCallLog().map((line) => `${line.tool} ${line.argsHash}`),
    };
  } finally {
    for (const started of children) started.kill();
    await reader.close();
    files.remove();
  }
}
