import { type ChildProcess, fork } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { databaseUrl } from './database-url.js';
import { newUser } from './new-user.js';
import { query } from './runtimeDb.js';
import type {
  HarnessMessage,
  ModeMessage,
  ModeScenario,
} from './runtimeChildMain.js';
import {
  CHILD_SCENARIO_ENV,
  latch,
  SCENARIO_STEPS,
  uniqueWorkflowType,
  within,
} from './testHandlers.js';

/**
 * Child-process harness of the kill matrix (E2E-1) and of the on-demand recovery measurement
 * (UC-N2). The child runs only compiled code (`pnpm --filter @agent-os/runtime build:child` →
 * `dist/test-child/`) and imports the packages by name, so it executes the same built `dist` as
 * `apps/api` (KD-8): a build older than its sources is refused before anything is spawned.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_ENTRY = join(
  PACKAGE_ROOT,
  'dist/test-child/test/support/runtimeChildMain.js',
);

/** A build the child executes and the sources it is built from. */
interface ChildBuild {
  /** A file every build rewrites. */
  output: string;
  sources: string;
  command: string;
}

/** The runtime's and the database package's `dist`, and the child's own entry. */
const CHILD_BUILDS: readonly ChildBuild[] = [
  {
    output: join(PACKAGE_ROOT, 'dist/index.js'),
    sources: join(PACKAGE_ROOT, 'src'),
    command: 'pnpm --filter @agent-os/runtime build',
  },
  {
    output: join(PACKAGE_ROOT, '../db/dist/index.js'),
    sources: join(PACKAGE_ROOT, '../db/src'),
    command: 'pnpm --filter @agent-os/db build',
  },
  {
    output: CHILD_ENTRY,
    sources: join(PACKAGE_ROOT, 'test/support'),
    command: 'pnpm --filter @agent-os/runtime build:child',
  },
];

/** How long a child may take to boot and create its investigation. */
const BOOT_MS = 60_000;
/** How long the dying child may take to reach its crash point. */
const CRASH_MS = 60_000;
/** Harness timeout of the recovery: the PRD target (Reliability, AC-08.4). */
export const RECOVERY_TARGET_MS = 60_000;
const STOP_MS = 30_000;
const POLL_MS = 100;
const OUTPUT_TAIL_LINES = 40;

/** Runtime Settings of the kill matrix: short lease and reaper, fast polling. */
const KILL_MATRIX_SETTINGS: Readonly<Record<string, string>> = {
  RUNTIME_CONCURRENCY: '2',
  RUNTIME_POLL_MS: '50',
  RUNTIME_NOTIFY: 'on',
  RUNTIME_LEASE_MS: '1000',
  RUNTIME_HEARTBEAT_MS: '300',
  RUNTIME_REAPER_MS: '200',
  DB_POOL_MAX: '4',
};

/**
 * Runtime Settings of the two-instance row: the kill-matrix settings with a heartbeat slower than
 * the first instance's admission of all its tasks. Nothing dies in this row, and a heartbeat that
 * beats while an early task waits for the admission to end bumps its `state_version` past the
 * uninterrupted run's; the lease stays well above the heartbeat.
 */
const TWO_INSTANCE_SETTINGS: Readonly<Record<string, string>> = {
  ...KILL_MATRIX_SETTINGS,
  RUNTIME_LEASE_MS: '15000',
  RUNTIME_HEARTBEAT_MS: '5000',
};

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

/**
 * Throws, naming the build command, when a build the child executes is missing or older than its
 * sources.
 */
function assertChildBuildFresh(): void {
  for (const build of CHILD_BUILDS) {
    let builtMs: number;
    try {
      builtMs = statSync(build.output).mtimeMs;
    } catch {
      throw new Error(
        `Child build ${build.output} is missing; run \`${build.command}\``,
      );
    }
    const newest = newestMtime(build.sources);
    if (newest.mtimeMs > builtMs) {
      throw new Error(
        `Child build ${build.output} is older than ${newest.file}; run \`${build.command}\``,
      );
    }
  }
}

interface Investigation {
  investigationId: string;
  threadId: string;
}

/** One compiled child process running the scenario. */
class RuntimeChild {
  private readonly output: string[] = [];
  private readonly process: ChildProcess;
  private readonly investigationLatch = latch();
  private investigationValue: Investigation | undefined;
  /** Exit code (`null` when ended by a signal), once the process has ended. */
  readonly exited: Promise<number | null>;
  admitted = false;
  /** `cancel` mode: the investigation the scenario cancels, once the child created it. */
  cancelInvestigation: Investigation | undefined;
  /** `two-instances` mode: tasks whose handler this process called, one entry per call. */
  readonly executed: string[] = [];

  constructor(
    scenario: ModeScenario,
    settings: Readonly<Record<string, string>>,
    crashAt: string | undefined,
  ) {
    this.process = fork(CHILD_ENTRY, [], {
      cwd: PACKAGE_ROOT,
      execArgv: ['--enable-source-maps'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ...settings,
        // The child is the composition root of its runtime and reads only its environment.
        DATABASE_URL: databaseUrl(),
        NODE_ENV: 'test',
        // Whatever the environment says: the child is a worker.
        RUNTIME_WORKERS: 'on',
        // Empty means unset, also over a value inherited from the environment.
        RUNTIME_CRASH_AT: crashAt ?? '',
        [CHILD_SCENARIO_ENV]: JSON.stringify(scenario),
      },
    });
    const keep = (chunk: Buffer) => {
      this.output.push(...chunk.toString().split('\n'));
      this.output.splice(
        0,
        Math.max(this.output.length - OUTPUT_TAIL_LINES, 0),
      );
    };
    this.process.stdout?.on('data', keep);
    this.process.stderr?.on('data', keep);
    this.process.on('message', (message: ModeMessage) => {
      switch (message.kind) {
        case 'investigation':
          this.investigationValue = {
            investigationId: message.investigationId,
            threadId: message.threadId,
          };
          this.investigationLatch.release();
          return;
        case 'cancel-investigation':
          this.cancelInvestigation = {
            investigationId: message.investigationId,
            threadId: message.threadId,
          };
          return;
        case 'executed':
          this.executed.push(message.taskId);
          return;
        case 'admitted':
          this.admitted = true;
      }
    });
    this.exited = new Promise((resolve) => {
      this.process.on('exit', (code) => resolve(code));
    });
  }

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  /** The child's investigation, once it has created or opened it. */
  async investigation(): Promise<Investigation> {
    await within(
      Promise.race([this.investigationLatch.promise, this.exited]),
      BOOT_MS,
      'the child to open its investigation',
    );
    if (!this.investigationValue) {
      throw this.failure('exited before opening its investigation');
    }
    return this.investigationValue;
  }

  /** Stops the child's runtime over IPC and waits for the exit code. */
  async stop(): Promise<number | null> {
    this.send({ kind: 'stop' });
    return within(this.exited, STOP_MS, 'the child to stop');
  }

  send(message: HarnessMessage): void {
    if (this.running) this.process.send(message);
  }

  /** Ends the process without a graceful close (cleanup after a failed run). */
  kill(): void {
    if (this.running) this.process.kill('SIGKILL');
  }

  failure(what: string): Error {
    return new Error(
      `Runtime child ${what}; its last output:\n${this.output.join('\n')}`,
    );
  }
}

// -------------------------------------------------------------------------------------------
// State of the scenario's investigation
// -------------------------------------------------------------------------------------------

interface TaskRow {
  taskId: string;
  step: string;
  status: string;
  attempt: number;
  failureClass: string | null;
  stateVersion: number;
  recoveryCount: number;
  outputRefs: string[];
}

interface EventRow {
  seq: number;
  eventId: string;
  type: string;
  taskId: string | null;
  reason: string | null;
}

function tasksOf(investigationId: string): Promise<TaskRow[]> {
  return query<TaskRow>(
    `SELECT task_id AS "taskId", input->>'step' AS step, status, attempt,
            failure_reason->>'class' AS "failureClass", state_version AS "stateVersion",
            recovery_count AS "recoveryCount", output_refs::text[] AS "outputRefs"
       FROM app.research_tasks WHERE investigation_id = $1`,
    [investigationId],
  );
}

function eventsOf(investigationId: string): Promise<EventRow[]> {
  return query<EventRow>(
    `SELECT seq::int AS seq, event_id AS "eventId", type, task_id AS "taskId",
            payload->>'reason' AS reason
       FROM app.research_events WHERE investigation_id = $1 ORDER BY seq`,
    [investigationId],
  );
}

async function deliveryCounts(
  investigationId: string,
): Promise<Record<string, number>> {
  const rows = await query<{ status: string; count: number }>(
    `SELECT d.status, count(*)::int AS count
       FROM app.research_event_deliveries d
       JOIN app.research_events e ON e.event_id = d.event_id
      WHERE e.investigation_id = $1 GROUP BY d.status`,
    [investigationId],
  );
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

async function evidenceOf(
  investigationId: string,
): Promise<{ evidenceId: string; taskId: string; evidenceKey: string }[]> {
  return query(
    `SELECT evidence_id AS "evidenceId", task_id AS "taskId", evidence_key AS "evidenceKey"
       FROM app.research_evidence WHERE investigation_id = $1`,
    [investigationId],
  );
}

async function subscribersOf(
  investigationId: string,
): Promise<{ taskId: string; key: string; notifiedEventId: string | null }[]> {
  return query(
    `SELECT s.task_id AS "taskId", s.subscriber_key AS key, s.notified_event_id AS "notifiedEventId"
       FROM app.research_task_subscribers s
       JOIN app.research_tasks t ON t.task_id = s.task_id
      WHERE t.investigation_id = $1`,
    [investigationId],
  );
}

/** What the dead child left behind, before the restart touches anything. */
export interface KillSnapshot {
  tasks: number;
  started: number;
  running: number;
  evidence: number;
  terminal: number;
  pendingDeliveries: number;
  doneDeliveries: number;
  /** Sum of `recovery_count`: attempts a reaper took back so far. */
  recovered: number;
}

async function killSnapshot(investigationId: string): Promise<KillSnapshot> {
  const [tasks, events, evidence, deliveries] = await Promise.all([
    tasksOf(investigationId),
    eventsOf(investigationId),
    evidenceOf(investigationId),
    deliveryCounts(investigationId),
  ]);
  return {
    tasks: tasks.length,
    started: events.filter((event) => event.type === 'TaskStarted').length,
    running: tasks.filter((task) => task.status === 'running').length,
    evidence: evidence.length,
    terminal: tasks.filter((task) => TERMINAL.includes(task.status)).length,
    pendingDeliveries: deliveries.pending ?? 0,
    doneDeliveries: deliveries.done ?? 0,
    recovered: tasks.reduce((sum, task) => sum + task.recoveryCount, 0),
  };
}

/** How a subscriber of a task was notified. */
type Notification = 'terminal event' | 'other event' | 'not notified';

/**
 * End of one task, free of ids and of what recovery adds by design: each recovery adds one
 * `TaskQueued (recovered)`, one `TaskStarted` and two state versions.
 */
export interface TaskEnd {
  status: string;
  failureClass: string | null;
  /** One entry per stored evidence row, sorted. */
  evidenceKeys: string[];
  /** `output_refs` are exactly the task's evidence ids. */
  outputRefsAreEvidence: boolean;
  queuedOverRecoveries: number;
  startedOverRecoveries: number;
  evidenceEvents: number;
  terminalEvents: number;
  stateVersionOverRecoveries: number;
  subscribers: Record<string, Notification>;
}

/** End state of the scenario's investigation, comparable across runs. */
export interface EndState {
  /** By the step of the task's input. */
  tasks: Record<string, TaskEnd>;
  /** B's first `TaskStarted` comes after A's `TaskSucceeded`. */
  bStartedAfterASucceeded: boolean;
  deliveries: Record<string, number>;
}

const TERMINAL_EVENTS = ['TaskSucceeded', 'TaskFailed', 'TaskCancelled'];

async function endState(
  investigationId: string,
): Promise<{ end: EndState; recoveries: number }> {
  const [tasks, events, evidence, subscribers, deliveries] = await Promise.all([
    tasksOf(investigationId),
    eventsOf(investigationId),
    evidenceOf(investigationId),
    subscribersOf(investigationId),
    deliveryCounts(investigationId),
  ]);
  const eventsOfTask = (taskId: string, types: string[]) =>
    events.filter((e) => e.taskId === taskId && types.includes(e.type));
  const end: EndState = {
    tasks: {},
    bStartedAfterASucceeded: false,
    deliveries,
  };
  for (const task of tasks) {
    const own = evidence.filter((row) => row.taskId === task.taskId);
    const terminal = eventsOfTask(task.taskId, TERMINAL_EVENTS);
    const notification = (eventId: string | null): Notification => {
      if (eventId === null) return 'not notified';
      return terminal.some((e) => e.eventId === eventId)
        ? 'terminal event'
        : 'other event';
    };
    end.tasks[task.step] = {
      status: task.status,
      failureClass: task.failureClass,
      evidenceKeys: own.map((row) => row.evidenceKey).sort(),
      outputRefsAreEvidence:
        [...task.outputRefs].sort().join() ===
        own
          .map((row) => row.evidenceId)
          .sort()
          .join(),
      queuedOverRecoveries:
        eventsOfTask(task.taskId, ['TaskQueued']).length - task.recoveryCount,
      startedOverRecoveries:
        eventsOfTask(task.taskId, ['TaskStarted']).length - task.recoveryCount,
      evidenceEvents: eventsOfTask(task.taskId, ['EvidenceStored']).length,
      terminalEvents: terminal.length,
      stateVersionOverRecoveries: task.stateVersion - 2 * task.recoveryCount,
      subscribers: Object.fromEntries(
        subscribers
          .filter((row) => row.taskId === task.taskId)
          .sort((a, b) => a.key.localeCompare(b.key))
          .map((row) => [row.key, notification(row.notifiedEventId)]),
      ),
    };
  }
  const byStep = new Map(tasks.map((task) => [task.step, task.taskId]));
  const aSucceeded = events.find(
    (e) => e.taskId === byStep.get('A') && e.type === 'TaskSucceeded',
  );
  const bStarted = events.find(
    (e) => e.taskId === byStep.get('B') && e.type === 'TaskStarted',
  );
  end.bStartedAfterASucceeded =
    aSucceeded !== undefined &&
    bStarted !== undefined &&
    bStarted.seq > aSucceeded.seq;
  const recoveries = tasks.reduce((sum, task) => sum + task.recoveryCount, 0);
  return { end, recoveries };
}

/** All `taskCount` tasks of the investigation ended, and no delivery of it left pending. */
async function settled(
  investigationId: string,
  taskCount: number,
): Promise<boolean> {
  const [tasks, deliveries] = await Promise.all([
    tasksOf(investigationId),
    deliveryCounts(investigationId),
  ]);
  return (
    tasks.length === taskCount &&
    tasks.every((task) => TERMINAL.includes(task.status)) &&
    (deliveries.pending ?? 0) === 0
  );
}

/**
 * Polls `condition` until it holds, failing with the child's output when the child dies or
 * `timeoutMs` passes; resolves the elapsed time. A guard on database state, not an ordering sleep.
 */
async function until(
  child: RuntimeChild,
  condition: () => Promise<boolean>,
  options: { timeoutMs: number; what: string },
): Promise<number> {
  const startedAt = Date.now();
  for (;;) {
    if (await condition()) return Date.now() - startedAt;
    if (!child.running)
      throw child.failure(`exited while waiting for ${options.what}`);
    if (Date.now() - startedAt > options.timeoutMs) {
      throw child.failure(
        `did not reach ${options.what} within ${options.timeoutMs} ms`,
      );
    }
    await delay(POLL_MS);
  }
}

/** Children of one run; `cleanup` kills what is left of them. */
class Children {
  private readonly started: RuntimeChild[] = [];

  constructor(private readonly settings: Readonly<Record<string, string>>) {}

  start(scenario: ModeScenario, crashAt?: string): RuntimeChild {
    const child = new RuntimeChild(scenario, this.settings, crashAt);
    this.started.push(child);
    return child;
  }

  /**
   * The threads live only in each child's ownership double; the investigations stay, as in the
   * other suites.
   */
  cleanup(): void {
    for (const child of this.started) child.kill();
  }
}

/**
 * Crash points count their passes over the whole process, and the relay and the reaper of a child
 * are not scoped to its investigation: a `runtime.scheduler` delivery left pending, or a `running`
 * task whose lease expired, by another investigation would be delivered or requeued by the dying
 * child and spend the passes the row aims at. Fails before the first start, naming what is left.
 */
async function assertNoForeignRuntimeWork(): Promise<void> {
  const [left] = await query<{
    pendingDeliveries: number;
    expiredRunning: number;
  }>(
    `SELECT (SELECT count(*)::int FROM app.research_event_deliveries
              WHERE status = 'pending' AND consumer = 'runtime.scheduler') AS "pendingDeliveries",
            (SELECT count(*)::int FROM app.research_tasks
              WHERE status = 'running' AND lease_expires_at < now()) AS "expiredRunning"`,
    [],
  );
  if (left.pendingDeliveries === 0 && left.expiredRunning === 0) return;
  throw new Error(
    `The kill matrix needs a database free of other investigations' runtime work, but ` +
      `${left.pendingDeliveries} pending runtime.scheduler deliveries and ${left.expiredRunning} ` +
      `running tasks with an expired lease are left (a run killed before its end leaves them). ` +
      `A child would deliver or requeue them and spend its crash passes there; ` +
      `finish or remove them, or run against a fresh database.`,
  );
}

function newScenario(
  mode: ModeScenario['mode'],
  taskCount?: number,
): ModeScenario {
  return {
    mode,
    workflowType: uniqueWorkflowType('e2e1'),
    resourceId: newUser(),
    ...(taskCount !== undefined && { taskCount }),
  };
}

// -------------------------------------------------------------------------------------------
// One run of the scenario
// -------------------------------------------------------------------------------------------

export interface ScenarioOptions {
  /** `RUNTIME_CRASH_AT` of the first child; without it the run is the reference run. */
  crashAt?: string;
  /**
   * `RUNTIME_CRASH_AT` of the restarted child (with `crashAt`): it dies too, and a third child
   * ends the run.
   */
  thenCrashAt?: string;
  /** The scenario also cancels an unrelated investigation whose one task is running. */
  cancel?: boolean;
  /** Runtime Settings of all children; {@link KILL_MATRIX_SETTINGS} by default. */
  settings?: Readonly<Record<string, string>>;
  /** Wait for the end state after the restart; the PRD recovery target by default. */
  recoveryTimeoutMs?: number;
}

/** End of the investigation the `cancel` scenario cancels. */
export interface CancelledEnd {
  investigationStatus: string;
  end: EndState;
}

export interface ScenarioRun {
  /** Exit code of the first child (137 at a crash point, 0 after a stop). */
  firstExitCode: number | null;
  /** State left by the dead child; absent in the reference run. */
  atKill?: KillSnapshot;
  /** With `thenCrashAt`: exit code of the restarted child and the state it left. */
  restartExitCode?: number | null;
  atRestartKill?: KillSnapshot;
  end: EndState;
  /** With `cancel`: the end of the cancelled investigation. */
  cancelled?: CancelledEnd;
  /** With `cancel` and `crashAt`: the cancelled investigation's task as the dead child left it. */
  cancelledAtKill?: CancelledTaskAtKill;
  /** Sum of `recovery_count`: attempts the reaper took back from the dead children. */
  recoveries: number;
  /** From the last start's spawn to the end state; absent in the reference run. */
  recoveryMs?: number;
}

interface Kill {
  exitCode: number | null;
  atKill: KillSnapshot;
}

/** Waits for the exit of a child started with a crash point; the state it left behind. */
async function crashed(
  child: RuntimeChild,
  crashAt: string,
  investigationId: string,
): Promise<Kill> {
  const exitCode = await within(
    child.exited,
    CRASH_MS,
    `the child to exit at ${crashAt}`,
  ).catch(() => {
    throw child.failure(`did not exit at ${crashAt} within ${CRASH_MS} ms`);
  });
  return { exitCode, atKill: await killSnapshot(investigationId) };
}

/** The task of the cancelled investigation, read after the first death. */
export interface CancelledTaskAtKill {
  status: string;
  cancelRequested: boolean;
}

async function cancelledTaskAtKill(
  investigationId: string,
): Promise<CancelledTaskAtKill> {
  const [row] = await query<CancelledTaskAtKill>(
    `SELECT status, cancel_requested_at IS NOT NULL AS "cancelRequested"
       FROM app.research_tasks WHERE investigation_id = $1`,
    [investigationId],
  );
  return row;
}

async function cancelledEnd(investigationId: string): Promise<CancelledEnd> {
  const [[row], { end }] = await Promise.all([
    query<{ status: string }>(
      'SELECT status FROM app.research_investigations WHERE investigation_id = $1',
      [investigationId],
    ),
    endState(investigationId),
  ]);
  return { investigationStatus: row.status, end };
}

/**
 * Runs the scenario in compiled children: without `crashAt`, to its end in one child (the
 * reference run); with it, until the child exits at the crash point — with `thenCrashAt`, until
 * the restarted child exits at that one too — then in a fresh child without a crash point, to
 * the end.
 */
export async function runScenario(
  options: ScenarioOptions = {},
): Promise<ScenarioRun> {
  assertChildBuildFresh();
  await assertNoForeignRuntimeWork();
  const scenario = newScenario(options.cancel ? 'cancel' : 'kill-matrix');
  const children = new Children(options.settings ?? KILL_MATRIX_SETTINGS);
  try {
    const crashes = [options.crashAt, options.thenCrashAt].filter(
      (point): point is string => point !== undefined,
    );
    let child = children.start(scenario, crashes[0]);
    const investigation = await child.investigation();
    const { investigationId } = investigation;
    const kills: Kill[] = [];
    let cancelInvestigation: Investigation | undefined;
    let cancelledAtKill: CancelledTaskAtKill | undefined;
    for (const [index, crashAt] of crashes.entries()) {
      kills.push(await crashed(child, crashAt, investigationId));
      cancelInvestigation ??= child.cancelInvestigation;
      if (index === 0 && cancelInvestigation) {
        cancelledAtKill = await cancelledTaskAtKill(
          cancelInvestigation.investigationId,
        );
      }
      child = children.start(
        { ...scenario, investigation, cancelInvestigation },
        crashes[index + 1],
      );
    }

    const last = child;
    const ended = async () => {
      if (!last.admitted) return false;
      if (!(await settled(investigationId, SCENARIO_STEPS.length))) {
        return false;
      }
      if (!options.cancel) return true;
      const cancelled = cancelInvestigation ?? last.cancelInvestigation;
      return cancelled !== undefined && settled(cancelled.investigationId, 1);
    };
    const recoveryMs = await until(last, ended, {
      timeoutMs: options.recoveryTimeoutMs ?? RECOVERY_TARGET_MS,
      what:
        crashes.length === 0
          ? 'the end of the reference run'
          : `the end state after the restart (${crashes.join(', ')})`,
    });
    cancelInvestigation ??= last.cancelInvestigation;
    const lastExitCode = await last.stop();

    const [first, restart] = kills;
    return {
      firstExitCode: first ? first.exitCode : lastExitCode,
      ...(first && { atKill: first.atKill, recoveryMs }),
      ...(restart && {
        restartExitCode: restart.exitCode,
        atRestartKill: restart.atKill,
      }),
      ...(await endState(investigationId)),
      ...(cancelInvestigation && {
        cancelled: await cancelledEnd(cancelInvestigation.investigationId),
      }),
      ...(cancelledAtKill && { cancelledAtKill }),
    };
  } finally {
    children.cleanup();
  }
}

// -------------------------------------------------------------------------------------------
// Two instances
// -------------------------------------------------------------------------------------------

/** Ready tasks of the two-instance row. */
export const TWO_INSTANCE_TASKS = 20;

export interface TwoInstanceRun {
  /** Exit codes of both children after their stop. */
  exitCodes: (number | null)[];
  end: EndState;
  /** `attempt` of each task, by step. */
  attempts: Record<string, number>;
  /** Handler calls of each task over both instances, by step. */
  handlerCalls: Record<string, number>;
  /** Deliveries of the investigation counted by `<status>/<attempts>`. */
  deliveryAttempts: Record<string, number>;
  /** Handler calls made by each instance. */
  callsPerInstance: number[];
}

async function deliveryAttemptsOf(
  investigationId: string,
): Promise<Record<string, number>> {
  const rows = await query<{ key: string; count: number }>(
    `SELECT d.status || '/' || d.attempts AS key, count(*)::int AS count
       FROM app.research_event_deliveries d
       JOIN app.research_events e ON e.event_id = d.event_id
      WHERE e.investigation_id = $1 GROUP BY 1`,
    [investigationId],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.count]));
}

/** How many times each value occurs in `values`. */
function countsOf(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/**
 * Two compiled children with one handler type compete for {@link TWO_INSTANCE_TASKS} ready
 * tasks: the first creates the investigation and admits the tasks once the second has started
 * its workers; both run until every task ended and no delivery is pending.
 */
export async function runTwoInstances(): Promise<TwoInstanceRun> {
  assertChildBuildFresh();
  const scenario = newScenario('two-instances', TWO_INSTANCE_TASKS);
  const children = new Children(TWO_INSTANCE_SETTINGS);
  try {
    const first = children.start(scenario);
    const investigation = await first.investigation();
    const { investigationId } = investigation;
    const second = children.start({ ...scenario, investigation });
    await until(second, async () => second.admitted, {
      timeoutMs: BOOT_MS,
      what: 'the second instance to start its workers',
    });
    first.send({ kind: 'go' });
    await until(
      first,
      async () => {
        if (!second.running) {
          throw second.failure('exited while both instances were running');
        }
        return first.admitted && settled(investigationId, TWO_INSTANCE_TASKS);
      },
      { timeoutMs: RECOVERY_TARGET_MS, what: 'the end of both instances' },
    );
    const exitCodes = [await first.stop(), await second.stop()];

    const [tasks, { end }, deliveryAttempts] = await Promise.all([
      tasksOf(investigationId),
      endState(investigationId),
      deliveryAttemptsOf(investigationId),
    ]);
    const calls = countsOf([...first.executed, ...second.executed]);
    return {
      exitCodes,
      end,
      attempts: Object.fromEntries(
        tasks.map((task) => [task.step, task.attempt]),
      ),
      handlerCalls: Object.fromEntries(
        tasks.map((task) => [task.step, calls.get(task.taskId) ?? 0]),
      ),
      deliveryAttempts,
      callsPerInstance: [first.executed.length, second.executed.length],
    };
  } finally {
    children.cleanup();
  }
}
