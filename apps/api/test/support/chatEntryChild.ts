import { type ChildProcess, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from '@agent-os/db';
import { BACKOFFICE_SOURCE_ID } from '@agent-os/sources';
import pg from 'pg';
import { SOURCES_DECLARATION } from '../../src/sources/sources.config.js';
import type {
  ChatEntryCrashPoint,
  HarnessMessage,
  ReadyMessage,
} from './chatEntryDoubles.js';
import {
  type ChatCallsMessage,
  type ChatCallsRequest,
  ENGINE_FILES_VARIABLES,
  ENGINE_JOURNEY_VARIABLE,
  ENGINE_PATH_VARIABLE,
  type EngineFiles,
  type EngineJourneyName,
  fixtureScenarioOf,
  RESEARCH_FLOW_PATH,
  type StartFailedMessage,
} from './engineScriptedRoles.js';
import { assertTestDatabase } from './testDatabaseGuard.js';

/**
 * Child-process harness of the chat-entry E2E-1 (NFR-03, UC-5, UC-E6) and of the agent-runtime / research-flow E2E-2 (the
 * real engine with scripted agents, {@link ChatEntryChildMode}), modelled on the engine's `engineChild.ts` and on the api boot
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

/** The fixture process the real sources start: only the mode with the real engine connects it. */
const FIXTURE_BUILD = packageBuild('mcp-fixture', 'mcp-fixture');

/**
 * What the child runs: `engine-double` — the engine port double and no source (`E2E_CHAT_ENTRY_DOUBLES=1`);
 * `research-flow` — the real engine and both fixture processes (`logs`, `backoffice`) with the shipped v3 as the server
 * loads it, its agents scripted, the launch without a budget.
 */
export type ChatEntryChildMode = 'engine-double' | 'research-flow';

const MODE_SETTINGS: Readonly<
  Record<ChatEntryChildMode, Readonly<Record<string, string>>>
> = {
  'engine-double': {
    E2E_CHAT_ENTRY_DOUBLES: '1',
    E2E_ENGINE_SCRIPTED_ROLES: '',
    [ENGINE_PATH_VARIABLE]: '',
  },
  'research-flow': {
    E2E_CHAT_ENTRY_DOUBLES: '',
    E2E_ENGINE_SCRIPTED_ROLES: '1',
    [ENGINE_PATH_VARIABLE]: RESEARCH_FLOW_PATH,
  },
};

/**
 * Settings of every child: workers on with fast polling, and a short `RESEARCH_LAUNCH_RECOVERY_MS`, so the loop of a
 * restarted process takes a row a dead one left in `launching` within a second.
 */
const CHILD_SETTINGS: Readonly<Record<string, string>> = {
  NODE_ENV: 'test',
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
function assertChildBuildFresh(mode: ChatEntryChildMode): void {
  const builds =
    mode === 'engine-double' ? CHILD_BUILDS : [...CHILD_BUILDS, FIXTURE_BUILD];
  for (const build of builds) {
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

async function onServer<T>(use: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = sharedDatabaseUrl();
  assertTestDatabase(url, 'chat-entry E2E');
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
  /** What the child reported of a failed start, once its IPC channel has closed; null when it reported none. */
  readonly startFailure: Promise<StartFailedMessage | null>;
  /** Resolves once the process has ended and its output streams are read to the end. */
  readonly drained: Promise<void>;
  private listening = false;

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
    this.drained = new Promise((resolve) => {
      this.process.on('close', () => resolve());
    });
    let startFailed: StartFailedMessage | null = null;
    this.process.on('message', (message: ChildMessage) => {
      if (message.kind === 'startFailed') startFailed = message;
    });
    // Every message is emitted before `disconnect`: the channel closes after the last one is read.
    this.startFailure = new Promise((resolve) => {
      this.process.on('disconnect', () => resolve(startFailed));
    });
    this.ready = new Promise((resolve, reject) => {
      this.process.on('message', (message: ChildMessage) => {
        if (message.kind !== 'ready') return;
        this.listening = true;
        resolve(message.port);
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

  /** Whether the child ever reported `ready`: its api accepted requests. */
  get listened(): boolean {
    return this.listening;
  }

  /** The child's last output lines, as far as they have arrived. */
  get log(): string {
    return this.output.join('\n');
  }

  /** Lets the controller of the investigation succeed in this process. */
  release(investigationId: string): void {
    this.send({ kind: 'release', investigationId });
  }

  /** The messages of every chat model call the child received so far, in arrival order (research-flow mode). */
  chatCalls(): Promise<ChatCallsMessage['calls']> {
    const reply = new Promise<ChatCallsMessage['calls']>((resolve) => {
      const listener = (message: ChildMessage): void => {
        if (message.kind !== 'chatCalls') return;
        this.process.off('message', listener);
        resolve(message.calls);
      };
      this.process.on('message', listener);
    });
    this.send({ kind: 'chatCalls' });
    return within(reply, STATE_MS, () =>
      this.failure(`sent no chat calls within ${STATE_MS} ms`),
    );
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

  private send(message: HarnessMessage | ChatCallsRequest): void {
    if (!this.running) throw this.failure('is not running');
    this.process.send(message);
  }
}

/** IPC of the child to the harness. */
type ChildMessage = ReadyMessage | ChatCallsMessage | StartFailedMessage;

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

/**
 * What the session's children read besides the mode and the engine files; {@link ChatEntrySession.start} may override
 * either for one child (a restart of the same session with a narrower table, source-planning E2E-1 S2).
 */
export interface ChatEntrySettings {
  /**
   * `SOURCE_ACCESS_TABLE` of the child (`{"<user id>": ["<sourceId>", …]}`). Empty (the default) keeps the allow-all
   * double of the rights port; any other value is the server's own table, so a user absent from it reads no source.
   */
  readonly sourceAccessTable?: string;
  /** What the scripted agents and the chat model play (research-flow mode); `provider-adapter` by default. */
  readonly journey?: EngineJourneyName;
}

/** One `tools/call` a fixture process of the session received, from the call log both processes share. */
export interface FixtureCall {
  /** 1-based order in the log, across both processes and across restarts. */
  readonly seq: number;
  readonly tool: string;
  /** The fixture process that received it. */
  readonly pid: number;
}

/** The tools of `backoffice` as declared: a call of the shared log is the back office's when its tool is one of them. */
export const BACKOFFICE_TOOLS: ReadonlySet<string> = new Set(
  SOURCES_DECLARATION.find(
    (source) => source.sourceId === BACKOFFICE_SOURCE_ID,
  )?.tools.map((tool) => tool.name) ?? [],
);

/** A run of the scenario in its own scratch database: its children and its rows. */
export interface ChatEntrySession {
  /**
   * Starts a child on the scratch database, with `crashAt` as its `CHAT_ENTRY_CRASH_AT` and the session's settings
   * with `overrides` over them; resolves once it is ready.
   */
  start(
    crashAt?: ChatEntryCrashPoint,
    overrides?: ChatEntrySettings,
  ): Promise<{ readonly child: ChatEntryChild; readonly api: ChildApi }>;
  /** `DATABASE_URL` of the scratch database, for the readers of `selfCheckDb.ts` (transcripts, agent runs). */
  readonly databaseUrl: string;
  /** Every `tools/call` the fixture processes of the session received so far, in log order (research-flow mode). */
  fixtureCalls(): FixtureCall[];
  /** Starts a child expected to refuse its start; resolves once it has exited, with what it reported. */
  startRefused(): Promise<RefusedStart>;
  /** The log of the child started last: its last output lines, read to the end after {@link startRefused}. */
  lastChildLog(): string;
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

/** How a child that was expected to refuse its start ended. */
export interface RefusedStart {
  /** Null when the process was ended by a signal. */
  readonly exitCode: number | null;
  /** Whether it reported `ready` before it exited. */
  readonly listened: boolean;
  /** The error it reported (`startFailed`); null when it reported none. */
  readonly failure: Pick<StartFailedMessage, 'code' | 'message'> | null;
}

/** Pids of the children the harness started and has not seen exit; a finished suite expects none of them. */
const spawned = new Set<number>();

/** Children the harness started that are still alive (orphans once the suite is over). */
export function aliveChildren(): number[] {
  return [...spawned].filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
}

/** The fixture call log at `path`; empty while no process has written it. */
function readFixtureCalls(path: string): FixtureCall[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const { seq, tool, pid } = JSON.parse(line) as FixtureCall;
      return { seq, tool, pid };
    });
}

/**
 * Creates a migrated scratch database, gives `use` a session over it, then kills whatever child is left, waits for
 * its exit and drops the database. Every child of the session runs in `mode`, the engine port double by default. With
 * `engineFiles`, in the research-flow mode, `processFile` replaces the shipped configuration and `groupTablesDir` is the
 * server's `RESEARCH_GROUP_TABLES_DIR`, each on its own. `settings` are the rights table and the journey of every child
 * ({@link ChatEntrySettings}). In the research-flow mode both fixture processes of every child serve the journey's
 * `FIXTURE_SCENARIO` and write one call log of the session, which outlives a restart and is deleted with the session.
 */
export async function withChatEntrySession<T>(
  use: (session: ChatEntrySession) => Promise<T>,
  mode: ChatEntryChildMode = 'engine-double',
  engineFiles?: Partial<EngineFiles>,
  settings: ChatEntrySettings = {},
): Promise<T> {
  assertChildBuildFresh(mode);
  const name = `${DATABASE_PREFIX}${randomBytes(6).toString('hex')}`;
  await onServer((client) => client.query(`CREATE DATABASE "${name}"`));
  const url = new URL(sharedDatabaseUrl());
  url.pathname = `/${name}`;
  const databaseUrl = url.toString();
  const children: ChatEntryChild[] = [];
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const groupTablesDir = engineFiles?.groupTablesDir ?? '';
  const researchFlow = mode === 'research-flow';
  const callLogPath = join(tmpdir(), `${name}-fixture-calls.jsonl`);
  /** Variables of the rights, the sources and the journey; outside the research-flow mode no source is connected. */
  const sourceSettings = (child: ChatEntrySettings): Record<string, string> => {
    const journey = child.journey ?? 'provider-adapter';
    if (!researchFlow && journey !== 'provider-adapter') {
      throw new Error(`The journey ${journey} needs the research-flow mode`);
    }
    return {
      SOURCE_ACCESS_TABLE: child.sourceAccessTable ?? '',
      [ENGINE_JOURNEY_VARIABLE]: researchFlow ? journey : '',
      FIXTURE_SCENARIO: researchFlow ? fixtureScenarioOf(journey) : '',
      FIXTURE_CALL_LOG: researchFlow ? callLogPath : '',
    };
  };
  const spawnChild = (
    crashAt?: ChatEntryCrashPoint,
    overrides: ChatEntrySettings = {},
  ): ChatEntryChild => {
    const child = new ChatEntryChild({
      ...MODE_SETTINGS[mode],
      DATABASE_URL: databaseUrl,
      CHAT_ENTRY_CRASH_AT: crashAt ?? '',
      [ENGINE_FILES_VARIABLES.processFile]: engineFiles?.processFile ?? '',
      RESEARCH_GROUP_TABLES_DIR: researchFlow ? groupTablesDir : '',
      ...sourceSettings({ ...settings, ...overrides }),
    });
    children.push(child);
    const { pid } = child;
    if (pid !== undefined) {
      spawned.add(pid);
      void child.exited.then(() => spawned.delete(pid));
    }
    return child;
  };
  try {
    await applyMigrations(databaseUrl);
    return await use({
      start: async (crashAt, overrides) => {
        const child = spawnChild(crashAt, overrides);
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
      startRefused: async () => {
        const child = spawnChild();
        const exitCode = await within(child.exited, BOOT_MS, () =>
          child.failure(`did not exit within ${BOOT_MS} ms`),
        );
        const reported = await within(child.startFailure, STOP_MS, () =>
          child.failure(`kept its IPC channel open after the exit`),
        );
        await within(child.drained, STOP_MS, () =>
          child.failure(`kept its output open after the exit`),
        );
        return {
          exitCode,
          listened: child.listened,
          failure:
            reported === null
              ? null
              : { code: reported.code, message: reported.message },
        };
      },
      databaseUrl,
      fixtureCalls: () => readFixtureCalls(callLogPath),
      lastChildLog: () => children.at(-1)?.log ?? '',
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
    rmSync(callLogPath, { force: true });
    await onServer((client) =>
      client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    );
  }
}
