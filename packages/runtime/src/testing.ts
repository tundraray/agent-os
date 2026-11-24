import { type ChildProcess, fork } from 'node:child_process';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';

import { LOGGER, type Logger } from '@agent-os/common';
import { DbModule } from '@agent-os/db';
import { databaseUrl } from '@agent-os/db/testing';
import { type DynamicModule, Module } from '@nestjs/common';

import type { RuntimeConfig } from './runtime-config';
import { RuntimeModule } from './runtime.module';

/**
 * Test support of the suites that build a runtime (`@agent-os/runtime/testing`): the Nest modules of a test
 * process and the harness of a child process that runs a runtime with workers on. The child processes load
 * this file under plain `tsx`, outside Vitest: it imports nothing of Vitest.
 */

@Module({})
class LoggerModule {}

/**
 * The modules a test process builds its runtime from, as `apps/api` does: `LOGGER` for every module,
 * `DbModule` over its own pool and `RuntimeModule`.
 */
export function runtimeModules(
  logger: Logger,
  connectionString: string,
  config: RuntimeConfig,
): DynamicModule[] {
  return [
    {
      module: LoggerModule,
      global: true,
      providers: [{ provide: LOGGER, useValue: logger }],
      exports: [LOGGER],
    },
    DbModule.forRootAsync({
      useFactory: () => ({ connectionString, poolMax: config.dbPoolMax }),
    }),
    RuntimeModule.forRootAsync({ useFactory: () => config }),
  ];
}

/** Messages of a child to its harness. */
type ChildMessage = { kind: 'ready' };
/** Messages of the harness to a child. */
type HarnessMessage = { kind: 'stop' };

/**
 * The child's side of the harness protocol, called once the child's context runs: `{ kind: 'stop' }`
 * closes `app` — the workers stop, then the pool closes — and exits 0; then the child sends
 * `{ kind: 'ready' }`. `name` names the child in the log record of a failed stop.
 */
export function serveHarness(
  app: { close(): Promise<void> },
  logger: Logger,
  name: string,
): void {
  process.on('message', (message: HarnessMessage) => {
    if (message.kind !== 'stop') return;
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error(`${name} stop failed`, { error });
        process.exit(1);
      },
    );
  });
  if (!process.send) throw new Error('The child process has no IPC channel');
  const ready: ChildMessage = { kind: 'ready' };
  process.send(ready);
}

/**
 * Runtime settings of the kill matrix: a short sweeper period so a lost step comes back within
 * seconds, fast polling.
 */
const KILL_MATRIX_SETTINGS: Readonly<Record<string, string>> = {
  RUNTIME_CONCURRENCY: '4',
  RUNTIME_POLL_MS: '50',
  RUNTIME_NOTIFY: 'on',
  RUNTIME_REAPER_MS: '200',
  RUNTIME_MAX_RECOVERIES: '3',
  DB_POOL_MAX: '4',
};

/** How long a child may take to boot. */
const BOOT_MS = 60_000;
const STOP_MS = 30_000;
const POLL_MS = 50;
const OUTPUT_TAIL_LINES = 60;

export interface TestChildOptions {
  /** Names the child in a failure: `Runtime child`. */
  readonly name: string;
  /** The child's entry file, run from source. */
  readonly entry: string;
  readonly cwd: string;
  /** Node options of the child: the `tsx` loader of the calling package, and its own flags. */
  readonly execArgv: readonly string[];
  /** Variables over the process environment and {@link KILL_MATRIX_SETTINGS}. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * One child process running a runtime with workers on: plain Node running its entry and the packages
 * from source. The harness never talks to the runtime inside a child: it starts it, waits, stops or
 * kills it, and keeps the tail of its output for failures.
 */
export class TestChild {
  private readonly tail: string[] = [];
  private readonly process: ChildProcess;
  private readonly name: string;
  private readyValue = false;
  /** Exit code (`null` when ended by a signal), once the process has ended. */
  readonly exited: Promise<number | null>;

  constructor(options: TestChildOptions) {
    this.name = options.name;
    this.process = fork(options.entry, [], {
      cwd: options.cwd,
      execArgv: [...options.execArgv],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ...KILL_MATRIX_SETTINGS,
        DATABASE_URL: databaseUrl(),
        NODE_ENV: 'test',
        // Whatever the environment says: the child is a worker.
        RUNTIME_WORKERS: 'on',
        // Empty means unset, also over a value inherited from the environment.
        RUNTIME_CRASH_AT: '',
        ...options.env,
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

  /** Splits a stream into whole lines: the tail for failures, and {@link line} for each. */
  private read(stream: Readable): void {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    stream.on('data', (chunk: Buffer) => {
      const lines = (pending + decoder.write(chunk)).split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        this.tail.push(line);
        this.line(line);
      }
      this.tail.splice(0, Math.max(this.tail.length - OUTPUT_TAIL_LINES, 0));
    });
  }

  /** Gets every whole line of the child's output; nothing by default. */
  protected line(_line: string): void {}

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  /** Resolves once the child's workers run; fails when it exits first. */
  async ready(): Promise<void> {
    await this.until(async () => this.readyValue, {
      what: 'its workers to start',
      timeoutMs: BOOT_MS,
    });
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
      if (!this.running)
        throw this.failure(`exited while waiting for ${options.what}`);
      if (Date.now() - startedAt > options.timeoutMs) {
        throw this.failure(
          `did not reach ${options.what} within ${options.timeoutMs} ms`,
        );
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
        throw this.failure(
          `did not reach ${options.what} within ${options.timeoutMs} ms`,
        );
      }
      await delay(POLL_MS);
    }
  }

  /** Stops the child over IPC (steps in flight get `shutdown`) and waits for exit 0. */
  async stop(): Promise<void> {
    if (!this.running) return;
    const message: HarnessMessage = { kind: 'stop' };
    this.process.send(message);
    const code = await within(this.exited, STOP_MS, () =>
      this.failure(`did not stop within ${STOP_MS} ms`),
    );
    if (code !== 0)
      throw this.failure(`stopped with exit code ${String(code)}`);
  }

  /** Kills the process outright, as a server that dies without shutdown, and waits for its end. */
  async kill(): Promise<void> {
    if (this.running) this.process.kill('SIGKILL');
    await this.exited;
  }

  failure(what: string): Error {
    return new Error(
      `${this.name} ${what}; its last output:\n${this.tail.join('\n')}`,
    );
  }
}

/** `promise`, or the error of `onTimeout` after `ms`. */
export async function within<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  const controller = new AbortController();
  const timeout = delay(ms, undefined, { signal: controller.signal }).then(
    () => {
      throw onTimeout();
    },
  );
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    controller.abort();
    timeout.catch(() => undefined);
  }
}
