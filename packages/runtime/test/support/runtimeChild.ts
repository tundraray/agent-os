import { type ChildProcess, fork } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { databaseUrl } from './database-url.js';
import { type ChildTypes, CHILD_TYPES_ENV } from './runtimeChildHandlers.js';
import type { ChildMessage, HarnessMessage } from './runtimeChildMain.js';

/**
 * Child-process harness of E2E-1 and of the on-demand measurements. A child runs only compiled
 * code (`dist/test-child/`, built by `pnpm --filter @agent-os/runtime build:child`) over the
 * packages' built `dist`; a build older than its sources is refused before anything is spawned. The
 * harness never talks to the runtime inside a child: it starts it, waits for it to die at its crash
 * point or stops it, and reads the rows it left. A restart is a fresh child without
 * `RUNTIME_CRASH_AT`.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_ENTRY = join(PACKAGE_ROOT, 'dist/test-child/test/support/runtimeChildMain.js');

/** Exit code of a crash point (the code of a process killed by SIGKILL). */
const CRASH_EXIT_CODE = 137;

/**
 * Runtime settings of the kill matrix: a short lease and reaper so a lost step comes back within
 * seconds, a heartbeat well inside the lease, fast polling.
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

/** Runtime settings at their design defaults (design-runtime.md, Runtime settings). */
export const DEFAULT_SETTINGS: Readonly<Record<string, string>> = {
  RUNTIME_CONCURRENCY: '16',
  RUNTIME_POLL_MS: '500',
  RUNTIME_NOTIFY: 'on',
  RUNTIME_LEASE_MS: '30000',
  RUNTIME_HEARTBEAT_MS: '10000',
  RUNTIME_REAPER_MS: '5000',
  RUNTIME_MAX_RECOVERIES: '3',
  DB_POOL_MAX: '10',
};

/** How long a child may take to boot. */
const BOOT_MS = 60_000;
/** How long a dying child may take to reach its crash point. */
const CRASH_MS = 60_000;
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
      throw new Error(
        `Child build ${build.output} is older than ${newest.file}; run \`${build.command}\``,
      );
    }
  }
}

export interface ChildOptions {
  /** Task types the child registers; it claims only these. */
  types: ChildTypes;
  /** `RUNTIME_CRASH_AT` (`<point>[:n]`); unset for a child that must not crash. */
  crashAt?: string;
  /** Runtime settings; {@link KILL_MATRIX_SETTINGS} by default. */
  settings?: Readonly<Record<string, string>>;
}

/** One compiled child process running a runtime with workers on. */
export class RuntimeChild {
  private readonly output: string[] = [];
  private readonly process: ChildProcess;
  private readyValue = false;
  /** Exit code (`null` when ended by a signal), once the process has ended. */
  readonly exited: Promise<number | null>;

  constructor(options: ChildOptions) {
    this.process = fork(CHILD_ENTRY, [], {
      cwd: PACKAGE_ROOT,
      execArgv: ['--enable-source-maps'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ...(options.settings ?? KILL_MATRIX_SETTINGS),
        DATABASE_URL: databaseUrl(),
        NODE_ENV: 'test',
        // Whatever the environment says: the child is a worker.
        RUNTIME_WORKERS: 'on',
        // Empty means unset, also over a value inherited from the environment.
        RUNTIME_CRASH_AT: options.crashAt ?? '',
        [CHILD_TYPES_ENV]: JSON.stringify(options.types),
      },
    });
    const keep = (chunk: Buffer) => {
      this.output.push(...chunk.toString().split('\n'));
      this.output.splice(0, Math.max(this.output.length - OUTPUT_TAIL_LINES, 0));
    };
    this.process.stdout?.on('data', keep);
    this.process.stderr?.on('data', keep);
    this.process.on('message', (message: ChildMessage) => {
      if (message.kind === 'ready') this.readyValue = true;
    });
    this.exited = new Promise((resolve) => {
      this.process.on('exit', (code) => resolve(code));
    });
  }

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  /** Resolves once the child's workers run; fails when it exits first. */
  async ready(): Promise<void> {
    await this.until(async () => this.readyValue, { what: 'its workers to start', timeoutMs: BOOT_MS });
  }

  /** Waits for the exit of a crash point and fails on any other exit code. */
  async crashed(): Promise<void> {
    const code = await within(this.exited, CRASH_MS, () =>
      this.failure(`did not reach its crash point within ${CRASH_MS} ms`),
    );
    if (code !== CRASH_EXIT_CODE) {
      throw this.failure(`exited with ${String(code)} instead of the crash code ${CRASH_EXIT_CODE}`);
    }
  }

  /**
   * Polls `condition` while the child lives; fails with the child's output when it exits first or
   * `timeoutMs` passes. Resolves the elapsed milliseconds.
   */
  async until(
    condition: () => Promise<boolean>,
    options: { what: string; timeoutMs: number },
  ): Promise<number> {
    const startedAt = Date.now();
    for (;;) {
      if (await condition()) return Date.now() - startedAt;
      if (!this.running) throw this.failure(`exited while waiting for ${options.what}`);
      if (Date.now() - startedAt > options.timeoutMs) {
        throw this.failure(`did not reach ${options.what} within ${options.timeoutMs} ms`);
      }
      await delay(POLL_MS);
    }
  }

  /**
   * Polls until `condition` holds or the child exits, whichever comes first; fails after
   * `timeoutMs`. For the rows where either end is expected.
   */
  async untilOrExit(
    condition: () => Promise<boolean>,
    options: { what: string; timeoutMs: number },
  ): Promise<'condition' | 'exited'> {
    const startedAt = Date.now();
    for (;;) {
      if (await condition()) return 'condition';
      if (!this.running) return 'exited';
      if (Date.now() - startedAt > options.timeoutMs) {
        throw this.failure(`did not reach ${options.what} within ${options.timeoutMs} ms`);
      }
      await delay(POLL_MS);
    }
  }

  /** Stops the child's runtime over IPC (steps in flight get `shutdown`) and waits for exit 0. */
  async stop(): Promise<void> {
    if (!this.running) return;
    const message: HarnessMessage = { kind: 'stop' };
    this.process.send(message);
    const code = await within(this.exited, STOP_MS, () =>
      this.failure(`did not stop within ${STOP_MS} ms`),
    );
    if (code !== 0) throw this.failure(`stopped with exit code ${String(code)}`);
  }

  /** Kills the process outright, as a server that dies without shutdown, and waits for its end. */
  async kill(): Promise<void> {
    if (this.running) this.process.kill('SIGKILL');
    await this.exited;
  }

  failure(what: string): Error {
    return new Error(`Runtime child ${what}; its last output:\n${this.output.join('\n')}`);
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
export class Children {
  private readonly started: RuntimeChild[] = [];

  constructor() {
    assertChildBuildFresh();
  }

  /** Starts a child; a child without `crashAt` is awaited until its workers run. */
  async start(options: ChildOptions): Promise<RuntimeChild> {
    const child = new RuntimeChild(options);
    this.started.push(child);
    if (options.crashAt === undefined) await child.ready();
    return child;
  }

  /** Kills every child still alive: cleanup after a passed or failed test. */
  async killAll(): Promise<void> {
    await Promise.all(this.started.map((child) => child.kill()));
  }
}
