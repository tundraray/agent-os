import { type ChildProcess, fork } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AgentDefinition } from '@agent-os/agents';
import type { LogRecord } from '@agent-os/common';
import type { RunCodeArgs } from '@agent-os/contracts';
import { type FixtureFiles, type FixtureServerEntry, fixtureServersFile } from '@agent-os/mcp-fixture';
import { BACKOFFICE_SERVER, LOGS_SERVER, testDefinition } from './agentsHarness.js';
import type { ChildMessage, HarnessMessage } from './codeRunChildMain.js';
import { databaseUrl } from './database-url.js';

/**
 * Child-process harness of code-execution E2E-1: a compiled child (`codeRunChildMain.ts`, built by
 * `pnpm --filter @agent-os/agents build:child`) plays the API process with the real code executor; a
 * build older than its sources is refused before anything is spawned. The test never talks to the
 * agents inside a child: it starts one, kills it from outside while a call of the script is held on
 * the MCP fixture, starts a fresh one over the same database and fixture files, and reads the rows and
 * the child's log. One scenario serves every row: one definition, a read run and a write run.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_ENTRY = join(PACKAGE_ROOT, 'dist/test-child/test/support/codeRunChildMain.js');

/** The variable that hands the child its {@link ChildScenario}. */
export const CHILD_SCENARIO_ENV = 'CODE_RUN_CHILD_SCENARIO';

/** The default model of the child: the default of `agentsHarness.ts`, so a launch of the test process is priced in the child. */
export const CHILD_MODEL = 'anthropic/test-default';

/**
 * Runtime settings of the child, copied from `KILL_MATRIX_SETTINGS` of the runtime's E2E harness: a
 * short lease and reaper so a lost step comes back within seconds, a heartbeat well inside the lease,
 * fast polling.
 */
const KILL_MATRIX_SETTINGS: Readonly<Record<string, string>> = {
  RUNTIME_CONCURRENCY: '4',
  RUNTIME_POLL_MS: '50',
  RUNTIME_NOTIFY: 'on',
  RUNTIME_LEASE_MS: '1000',
  RUNTIME_HEARTBEAT_MS: '300',
  RUNTIME_REAPER_MS: '200',
  RUNTIME_MAX_RECOVERIES: '3',
  DB_POOL_MAX: '4',
};

/** The one definition of the scenario: both fixture servers. */
export const CODE_RUN_DEFINITION: AgentDefinition = testDefinition('code-run-restart', {
  mcpServers: [LOGS_SERVER, BACKOFFICE_SERVER],
});

/** The trace the read script reads (`get_trace` of the `logs` server). */
export const TRACE = { traceId: 'a'.repeat(32) };
/** The two notes the write script creates, in order (`create_incident_note` of the `backoffice` server). */
export const FIRST_NOTE = { orderId: 'ORD-1001', text: 'first note of the run' };
const SECOND_NOTE ={ orderId: 'ORD-1001', text: 'second note of the run' };

/** One run of the scenario: the agent's task, its `run_code` call and the report after the result. */
export interface ScenarioRun {
  readonly task: string;
  /** The agent's description at its start. */
  readonly description: string;
  readonly args: RunCodeArgs;
  readonly report: string;
}

/** A `read` run: one call of `get_trace`, then the literal result `trace read`. */
export const READ_RUN: ScenarioRun = {
  task: 'Read the trace in code',
  description: 'code reader',
  args: {
    description: 'Read one trace',
    class: 'read',
    script: [`await callTool("mcp__logs__get_trace", ${JSON.stringify(TRACE)});`, 'return "trace read";'].join('\n'),
  },
  report: 'report of the read run',
};

/** A `write` run: two notes, one after the other, then the literal result `notes created`. */
export const WRITE_RUN: ScenarioRun = {
  task: 'Write two notes in code',
  description: 'code writer',
  args: {
    description: 'Create two incident notes',
    class: 'write',
    script: [
      `await callTool("mcp__backoffice__create_incident_note", ${JSON.stringify(FIRST_NOTE)});`,
      `await callTool("mcp__backoffice__create_incident_note", ${JSON.stringify(SECOND_NOTE)});`,
      'return "notes created";',
    ].join('\n'),
  },
  report: 'report of the write run',
};

/** What a child gets from the test: the agents settings and the servers file, both over the test's fixture files. */
export interface ChildScenario {
  readonly variables: Readonly<Record<string, string>>;
  readonly mcpServers: readonly FixtureServerEntry[];
}

/** The scenario of a test: its access table, and the fixture servers logging into its call log under its fault rules. */
export function childScenario(
  fixture: FixtureFiles,
  access: Readonly<Record<string, readonly string[]>>,
): ChildScenario {
  return {
    variables: {
      AGENT_DEFAULT_MODEL: CHILD_MODEL,
      MCP_ACCESS_TABLE: JSON.stringify(access),
      MCP_CALL_TIMEOUT_MS: '90000',
    },
    mcpServers: fixtureServersFile(fixture, [
      { id: LOGS_SERVER, source: 'logs' },
      { id: BACKOFFICE_SERVER, source: 'backoffice' },
    ]),
  };
}

/** How long a child may take to boot. */
const BOOT_MS = 60_000;
const STOP_MS = 30_000;
const POLL_MS = 50;
const OUTPUT_TAIL_LINES = 60;

/** A build the child executes and the sources it is built from. */
interface ChildBuild {
  /** A file every build rewrites. */
  output: string;
  sources: string;
  command: string;
}

const CHILD_BUILDS: readonly ChildBuild[] = [
  {
    output: join(PACKAGE_ROOT, 'dist/index.js'),
    sources: join(PACKAGE_ROOT, 'src'),
    command: 'pnpm --filter @agent-os/agents build',
  },
  {
    output: join(PACKAGE_ROOT, '../code-runner/dist/index.js'),
    sources: join(PACKAGE_ROOT, '../code-runner/src'),
    command: 'pnpm --filter @agent-os/code-runner build',
  },
  {
    output: join(PACKAGE_ROOT, '../runtime/dist/index.js'),
    sources: join(PACKAGE_ROOT, '../runtime/src'),
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
    command: 'pnpm --filter @agent-os/agents build:child',
  },
];

function newestMtime(dir: string): { file: string; mtimeMs: number } {
  let newest = { file: dir, mtimeMs: 0 };
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = join(dir, String(entry));
    const { mtimeMs } = statSync(file);
    if (mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
  }
  return newest;
}

/** Throws, naming the build command, when a build the child runs is missing or older than its sources. */
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

/** A console line of the child as a log record; `undefined` for any other output. */
function logRecordOf(line: string): LogRecord | undefined {
  try {
    const value = JSON.parse(line) as Partial<LogRecord> | null;
    if (typeof value?.message !== 'string' || typeof value.fields !== 'object' || value.fields === null) {
      return undefined;
    }
    return value as LogRecord;
  } catch {
    return undefined;
  }
}

/** One compiled child process: an API process with workers on and the real code executor. */
export class CodeRunChild {
  private readonly tail: string[] = [];
  private readonly records: LogRecord[] = [];
  private readonly process: ChildProcess;
  private readyValue = false;
  /** Exit code (`null` when ended by a signal), once the process has ended. */
  readonly exited: Promise<number | null>;

  constructor(scenario: ChildScenario) {
    this.process = fork(CHILD_ENTRY, [], {
      cwd: PACKAGE_ROOT,
      // The API process starts with `--disable-sigusr1`: a script's executor cannot open its inspector.
      execArgv: ['--disable-sigusr1', '--enable-source-maps'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ...KILL_MATRIX_SETTINGS,
        DATABASE_URL: databaseUrl(),
        NODE_ENV: 'test',
        // Whatever the environment says: the child is a worker that never crashes on its own.
        RUNTIME_WORKERS: 'on',
        RUNTIME_CRASH_AT: '',
        [CHILD_SCENARIO_ENV]: JSON.stringify(scenario),
      },
    });
    if (this.process.stdout) this.read(this.process.stdout);
    if (this.process.stderr) this.read(this.process.stderr);
    this.process.on('message', (message: ChildMessage) => {
      if (message.kind === 'ready') this.readyValue = true;
    });
    this.exited = new Promise((resolve) => {
      this.process.on('exit', (code) => resolve(code));
    });
  }

  /** Splits a stream into whole lines: the tail for failures, and every log record. */
  private read(stream: Readable): void {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    stream.on('data', (chunk: Buffer) => {
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        this.tail.push(line);
        const record = logRecordOf(line);
        if (record !== undefined) this.records.push(record);
      }
      this.tail.splice(0, Math.max(this.tail.length - OUTPUT_TAIL_LINES, 0));
    });
  }

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  /** The child's log records of one `run_code` run (its `runId` is the run's `callId`) with this message. */
  runLogs(runId: string, message: string): LogRecord[] {
    return this.records.filter((record) => record.fields.runId === runId && record.message === message);
  }

  /** The pids of the executor processes this child started for the run, in start order. */
  executorPids(runId: string): number[] {
    return this.runLogs(runId, 'code executor started').map((record) => Number(record.fields.pid));
  }

  /** Resolves once the child's workers run; fails when it exits first. */
  async ready(): Promise<void> {
    await this.until(async () => this.readyValue, { what: 'its workers to start', timeoutMs: BOOT_MS });
  }

  /**
   * Polls `condition` while the child lives; fails with the child's output when it exits first or
   * `timeoutMs` passes.
   */
  async until(condition: () => Promise<boolean>, options: { what: string; timeoutMs: number }): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      if (await condition()) return;
      if (!this.running) throw this.failure(`exited while waiting for ${options.what}`);
      if (Date.now() - startedAt > options.timeoutMs) {
        throw this.failure(`did not reach ${options.what} within ${options.timeoutMs} ms`);
      }
      await delay(POLL_MS);
    }
  }

  /** Stops the child over IPC (workers, MCP processes, pool) and waits for exit 0. */
  async stop(): Promise<void> {
    if (!this.running) return;
    const message: HarnessMessage = { kind: 'stop' };
    this.process.send(message);
    const code = await within(this.exited, STOP_MS, () => this.failure(`did not stop within ${STOP_MS} ms`));
    if (code !== 0) throw this.failure(`stopped with exit code ${String(code)}`);
  }

  /** Kills the process outright, as a server that dies without shutdown, and waits for its end. */
  async kill(): Promise<void> {
    if (this.running) this.process.kill('SIGKILL');
    await this.exited;
  }

  failure(what: string): Error {
    return new Error(`Code-run child ${what}; its last output:\n${this.tail.join('\n')}`);
  }
}

/** `promise`, or the error of `onTimeout` after `ms`. */
async function within<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  const controller = new AbortController();
  const timeout = delay(ms, undefined, { signal: controller.signal }).then(() => {
    throw onTimeout();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    controller.abort();
    timeout.catch(() => undefined);
  }
}

/** Children of one test; {@link killAll} ends whatever is left of them. */
export class CodeRunChildren {
  private readonly started: CodeRunChild[] = [];

  constructor() {
    assertChildBuildFresh();
  }

  /** Starts a child and waits until its workers run. */
  async start(scenario: ChildScenario): Promise<CodeRunChild> {
    const child = new CodeRunChild(scenario);
    this.started.push(child);
    await child.ready();
    return child;
  }

  /** Kills every child still alive: cleanup after a passed or failed test. */
  async killAll(): Promise<void> {
    await Promise.all(this.started.map((child) => child.kill()));
  }
}
