import { type ChildProcess, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '@agent-os/db';
import pg from 'pg';
import type {
  ChatEntryCrashPoint,
  HarnessMessage,
  ReadyMessage,
} from './chatEntryDoubles.js';

/**
 * Child-process harness of E2E-1 (NFR-03, UC-5, UC-E6), modelled on the engine's `engineChild.ts` and on the api boot
 * rows of `research-runtime-boot.e2e-spec.ts`. The child runs only compiled code (`pnpm --filter api build:child` →
 * `dist/test-child/`) over the packages' built `dist`; a build older than its sources is refused before anything is
 * spawned. Every run has its own scratch database (`CREATE DATABASE`, migrations through the entry of `@agent-os/db`,
 * dropped afterwards), so a killed process leaves no row for a neighbour. The harness synchronises only on proven
 * states: the child's `ready` message, its exit code, then rows of the scratch database.
 */

const API_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = join(API_ROOT, '../..');
const CHILD_ENTRY = join(
  API_ROOT,
  'dist/test-child/test/support/chatEntryChildMain.js',
);
const ENV_FILE = join(API_ROOT, '.env');
/** Scratch databases of this harness; the leftover fence drops what an earlier run left by this prefix. */
const DATABASE_PREFIX = 'e2e_chat_entry_';

/** A build the child executes and the sources it is built from. */
interface ChildBuild {
  /** A file every build rewrites. */
  readonly output: string;
  readonly sources: readonly string[];
  readonly command: string;
}

const packageBuild = (dir: string, name: string): ChildBuild => ({
  output: join(REPO_ROOT, 'packages', dir, 'dist/index.js'),
  sources: [join(REPO_ROOT, 'packages', dir, 'src')],
  command: `pnpm --filter @agent-os/${name} build`,
});

/** The packages the api imports by name, and the child entry built from the api's `src` and the test support. */
const CHILD_BUILDS: readonly ChildBuild[] = [
  packageBuild('contracts', 'contracts'),
  packageBuild('db', 'db'),
  packageBuild('runtime', 'runtime'),
  packageBuild('engine', 'engine'),
  packageBuild('sources', 'sources'),
  {
    output: CHILD_ENTRY,
    sources: [join(API_ROOT, 'src'), join(API_ROOT, 'test/support')],
    command: 'pnpm --filter api build:child',
  },
];

/**
 * Settings of every child: workers on with fast polling, and a short `RESEARCH_LAUNCH_RECOVERY_MS`, so the loop of a
 * restarted process takes a row a dead one left in `launching` within a second.
 */
const CHILD_SETTINGS: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
  E2E_CHAT_ENTRY_DOUBLES: '1',
  RUNTIME_WORKERS: 'on',
  RUNTIME_CONCURRENCY: '2',
  RUNTIME_POLL_MS: '50',
  DB_POOL_MAX: '4',
  RESEARCH_LAUNCH_RECOVERY_MS: '1000',
  // Empty means unset, also over a value inherited from the environment: the runtime's points stay off.
  RUNTIME_CRASH_AT: '',
};

/** How long a child may take to boot, to stop, or a run's step to reach its state: harness guards, not latencies. */
const BOOT_MS = 60_000;
const STOP_MS = 30_000;
const STATE_MS = 30_000;
const POLL_MS = 100;
const OUTPUT_TAIL_LINES = 80;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

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
      throw new Error(
        `Child build ${build.output} is missing; run \`${build.command}\``,
      );
    }
    for (const sources of build.sources) {
      const newest = newestMtime(sources);
      if (newest.mtimeMs > builtMs) {
        throw new Error(
          `Child build ${build.output} is older than ${newest.file}; run \`${build.command}\``,
        );
      }
    }
  }
}

/** `DATABASE_URL` as the app sees it: the process environment first, otherwise `apps/api/.env`. */
function sharedDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) process.loadEnvFile(ENV_FILE);
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  }
  return url;
}

/**
 * Refuses a server that does not look like the local test one: the harness creates and drops databases, so it runs
 * only against a local host on the dev test port 5433, or the CI database `agent_os`, or a name containing `test`.
 */
function assertTestDatabase(url: string): void {
  const { hostname, port, pathname } = new URL(url);
  const name = pathname.slice(1);
  if (
    LOCAL_HOSTS.includes(hostname) &&
    (port === '5433' || name === 'agent_os' || name.includes('test'))
  ) {
    return;
  }
  throw new Error(
    `Refusing to create or drop databases on ${hostname}:${port || '5432'}/${name}: ` +
      'the chat-entry E2E runs only against a local test server (port 5433, or database agent_os or *test*)',
  );
}

async function onServer<T>(use: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = sharedDatabaseUrl();
  assertTestDatabase(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/**
 * The leftover fence: drops the scratch databases an earlier run of this file left (a run killed before its cleanup).
 * FORCE: a killed child may leave its connections behind for a moment.
 */
export async function dropLeftoverDatabases(): Promise<void> {
  await onServer(async (client) => {
    const { rows } = await client.query<{ name: string }>(
      'SELECT datname AS name FROM pg_database WHERE datname LIKE $1',
      [`${DATABASE_PREFIX}%`],
    );
    for (const { name } of rows) {
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  });
}

/** One compiled child process. */
export class ChatEntryChild {
  private readonly output: string[] = [];
  private readonly process: ChildProcess;
  /** Exit code (`null` when ended by a signal), once the process has ended. */
  readonly exited: Promise<number | null>;
  /** The port the api listens on, once `ready`. */
  readonly ready: Promise<number>;

  constructor(env: Readonly<Record<string, string>>) {
    this.process = fork(CHILD_ENTRY, [], {
      cwd: API_ROOT,
      execArgv: ['--enable-source-maps'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...CHILD_SETTINGS, ...env },
    });
    const keep = (chunk: Buffer): void => {
      this.output.push(...chunk.toString().split('\n'));
      this.output.splice(
        0,
        Math.max(this.output.length - OUTPUT_TAIL_LINES, 0),
      );
    };
    this.process.stdout?.on('data', keep);
    this.process.stderr?.on('data', keep);
    this.exited = new Promise((resolve) => {
      this.process.on('exit', (code) => resolve(code));
    });
    this.ready = new Promise((resolve, reject) => {
      this.process.on('message', (message: ReadyMessage) => {
        if (message.kind === 'ready') resolve(message.port);
      });
      void this.exited.then((code) =>
        reject(this.failure(`exited ${code} before it was ready`)),
      );
    });
    // A child that dies after `ready` leaves the promise settled; this keeps an unread rejection quiet.
    this.ready.catch(() => undefined);
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  get running(): boolean {
    return this.process.exitCode === null && this.process.signalCode === null;
  }

  /** Lets the controller of the investigation succeed in this process. */
  release(investigationId: string): void {
    this.send({ kind: 'release', investigationId });
  }

  /** The exit code of a child expected to end by itself (at its crash point). */
  exit(): Promise<number | null> {
    return within(this.exited, STATE_MS, () =>
      this.failure(`did not exit within ${STATE_MS} ms`),
    );
  }

  /** Closes the app over IPC; resolves the exit code. */
  async stop(): Promise<number | null> {
    if (this.running) this.send({ kind: 'stop' });
    return within(this.exited, STOP_MS, () =>
      this.failure(`did not stop within ${STOP_MS} ms`),
    );
  }

  /** Ends the process without a graceful close (cleanup after a failed run); resolves once it has ended. */
  async kill(): Promise<void> {
    if (this.running) this.process.kill('SIGKILL');
    await this.exited;
  }

  failure(what: string): Error {
    return new Error(
      `Chat-entry child ${what}; its last output:\n${this.output.join('\n')}`,
    );
  }

  private send(message: HarnessMessage): void {
    if (!this.running) throw this.failure('is not running');
    this.process.send(message);
  }
}

/** `promise`, or the error of `failure` after `ms`: a guard, not a delay. */
async function within<T>(
  promise: Promise<T>,
  ms: number,
  failure: () => Error,
): Promise<T> {
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

/** A request to a child's api as `user`: JSON body, the user in `x-user-id`. */
export type ChildApi = (
  user: string,
  path: string,
  init?: { method?: string; body?: string },
) => Promise<Response>;

/** A run of the scenario in its own scratch database: its children and its rows. */
export interface ChatEntrySession {
  /** Starts a child on the scratch database, with `crashAt` as its `CHAT_ENTRY_CRASH_AT`; resolves once it is ready. */
  start(
    crashAt?: ChatEntryCrashPoint,
  ): Promise<{ readonly child: ChatEntryChild; readonly api: ChildApi }>;
  /** A statement on the scratch database, over the test's own connection. */
  query<Row extends pg.QueryResultRow>(
    text: string,
    values: unknown[],
  ): Promise<Row[]>;
  /**
   * Polls `read` until it returns a value; fails when `child` exits meanwhile or after the harness guard. Waits only
   * for a state the database proves.
   */
  until<T>(
    what: string,
    child: ChatEntryChild,
    read: () => Promise<T | undefined>,
  ): Promise<T>;
}

/** Pids of every child the harness started; a finished suite expects none of them alive. */
const spawned: number[] = [];

/** Children the harness started that are still alive (orphans once the suite is over). */
export function aliveChildren(): number[] {
  return spawned.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Creates a migrated scratch database, gives `use` a session over it, then kills whatever child is left, waits for
 * its exit and drops the database.
 */
export async function withChatEntrySession<T>(
  use: (session: ChatEntrySession) => Promise<T>,
): Promise<T> {
  assertChildBuildFresh();
  const name = `${DATABASE_PREFIX}${randomBytes(6).toString('hex')}`;
  await onServer((client) => client.query(`CREATE DATABASE "${name}"`));
  const url = new URL(sharedDatabaseUrl());
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  const children: ChatEntryChild[] = [];
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await applyMigrations(databaseUrl);
    return await use({
      start: async (crashAt) => {
        const child = new ChatEntryChild({
          DATABASE_URL: databaseUrl,
          CHAT_ENTRY_CRASH_AT: crashAt ?? '',
        });
        children.push(child);
        if (child.pid !== undefined) spawned.push(child.pid);
        const port = await within(child.ready, BOOT_MS, () =>
          child.failure(`was not ready within ${BOOT_MS} ms`),
        );
        return {
          child,
          api: (user, path, init = {}) =>
            fetch(`http://127.0.0.1:${port}${path}`, {
              ...init,
              headers: {
                'content-type': 'application/json',
                'x-user-id': user,
              },
            }),
        };
      },
      query: async (text, values) => (await pool.query(text, values)).rows,
      until: async (what, child, read) => {
        const startedAt = Date.now();
        for (;;) {
          const value = await read();
          if (value !== undefined) return value;
          if (!child.running) throw child.failure(`exited before ${what}`);
          if (Date.now() - startedAt > STATE_MS) {
            throw child.failure(`did not reach ${what} within ${STATE_MS} ms`);
          }
          await delay(POLL_MS);
        }
      },
    });
  } finally {
    for (const child of children) await child.kill();
    await pool.end();
    await onServer((client) =>
      client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    );
  }
}
