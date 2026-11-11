import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskSpec } from '@agent-os/contracts';
import { createDatabase, type DatabaseConnection } from '@agent-os/db';
import { fixtureServerPath } from '@agent-os/mcp-fixture';
import {
  createRuntime,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  type RuntimeLogFields,
  type RuntimeLogger,
  systemClock,
  type TaskHandler,
  type ThreadOwnership,
} from '@agent-os/runtime';
import {
  createSources,
  FIXTURE_SOURCE_ID,
  FixtureSourceAdapter,
  type SourceDeclaration,
  type Sources,
  type SourcesLogger,
  type SourcesSettings,
} from '@agent-os/sources';
import { databaseUrl } from './database-url.js';

/**
 * Test assembly of the runtime and the sources package against Postgres (design-mcp-source.md, Test Boundaries):
 * `createDatabase`, `createRuntime` with test ports and `createSources` with a fixture adapter, without `apps/api`.
 * The packages — this one included — are imported by name, so the in-process E2E tests and the compiled recovery
 * child run the same built `dist` as `apps/api`.
 */

export const SOURCE_FETCH = 'source.fetch';
export const SEARCH_LOGS = 'search_logs';

/** The fixture with `search_logs` declared: `source.fetch` may call it and no other tool. */
const TEST_DECLARATION: SourceDeclaration = [
  {
    sourceId: FIXTURE_SOURCE_ID,
    description: 'Payment logs of the checkout services; the declaration of the sources package tests.',
    tools: [{ name: SEARCH_LOGS, description: 'Log records of a time window with optional filters, a page at a time.' }],
  },
];

/** Environment variable of the recovery child carrying its scenario as JSON (`fetchChildMain.ts`). */
export const FETCH_CHILD_SCENARIO_ENV = 'FETCH_CHILD_SCENARIO';

/**
 * Sources Settings of the tests apart from the fixture files: every variable is set, so none leaks in from the
 * environment of a child; the backoff is short so a retry would show within the bounded waits.
 */
export const TEST_SOURCES_ENV: Readonly<Record<string, string>> = {
  SOURCE_CALL_TIMEOUT_MS: '30000',
  SOURCE_RETRY_BASE_MS: '10',
  SOURCE_RETRY_CAP_MS: '50',
  SOURCE_MAX_PAGES: '1000',
  FIXTURE_DATASET: 'v1',
};

/** A `FIXTURE_FAULTS` rule (design-mcp-source.md, Отказы fixture); mode parameters sit next to `mode`. */
export interface FixtureFaultRule {
  readonly tool: string;
  readonly argsHash: string;
  readonly occurrences: 'all' | readonly number[];
  readonly mode: string;
  readonly [parameter: string]: unknown;
}

/** One line of the fixture call log: only `tools/call`, written before the call is processed. */
export interface CallLogLine {
  readonly seq: number;
  readonly tool: string;
  readonly argsHash: string;
  readonly occurrence: number;
  readonly mode: string | null;
  readonly pid: number;
}

/** The rules file and the call log of one test, in a temp dir of their own. */
export interface FixtureFiles {
  /** `FIXTURE_FAULTS` and `FIXTURE_CALL_LOG` as the assembly point reads them. */
  readonly env: { readonly FIXTURE_FAULTS: string; readonly FIXTURE_CALL_LOG: string };
  /** The call log in file order; empty before the first `tools/call`. */
  readCallLog(): CallLogLine[];
  remove(): void;
}

export function fixtureFiles(rules: readonly FixtureFaultRule[] = []): FixtureFiles {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-sources-e2e-'));
  const faultsPath = join(dir, 'faults.json');
  const callLogPath = join(dir, 'calls.jsonl');
  writeFileSync(faultsPath, JSON.stringify(rules), 'utf8');
  return {
    env: { FIXTURE_FAULTS: faultsPath, FIXTURE_CALL_LOG: callLogPath },
    readCallLog() {
      if (!existsSync(callLogPath)) return [];
      return readFileSync(callLogPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CallLogLine);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

export interface SourcesHarnessOptions {
  /** Sources Settings, `FIXTURE_FAULTS` and `FIXTURE_CALL_LOG` included. */
  readonly sources: SourcesSettings;
  /** Runtime Settings over the test defaults (workers on, 2 slots, 50 ms poll, pool of 4). */
  readonly runtime?: Partial<RuntimeConfig>;
  /** Also print every log line (the child process, whose output its harness keeps on failure). */
  readonly echoLogs?: boolean;
  /** Test handlers registered next to `source.fetch`, before the workers start. */
  readonly handlers?: readonly TaskHandler[];
}

export interface SourcesHarness {
  readonly runtime: Runtime;
  readonly sources: Sources;
  readonly database: DatabaseConnection;
  /**
   * A thread of `resourceId` known to the ownership double; returns its id. A new id by default, or `threadId` —
   * a thread an earlier assembly created — so a later assembly reads the same investigation.
   */
  createThread(resourceId: string, threadId?: string): string;
  /** Stops the runtime, then closes the sources (their processes), then the pool — each even when one before fails. */
  close(): Promise<void>;
}

/** Ownership double of the threads the harness created: a missing or foreign thread is refused. */
function threadOwnershipDouble(owners: ReadonlyMap<string, string>): ThreadOwnership {
  return {
    async withOwnedThread(threadId, resourceId, fn) {
      if (owners.get(threadId) !== resourceId) {
        throw new Error(`Thread ${threadId} of ${resourceId} not found`);
      }
      return fn();
    },
  };
}

/** Both logger ports over one sink: the runtime's and the sources'. */
function testLoggers(echo: boolean): { runtime: RuntimeLogger; sources: SourcesLogger } {
  const write = (level: string, message: string, fields: unknown): void => {
    if (echo) console.log(`[${level}] ${message}`, fields ?? '');
  };
  return {
    runtime: {
      log: (message: string, fields?: RuntimeLogFields) => write('runtime log', message, fields),
      warn: (message: string, fields?: RuntimeLogFields) => write('runtime warn', message, fields),
      error: (message: string, fields?: RuntimeLogFields) => write('runtime error', message, fields),
    },
    sources: {
      debug: (message, fields) => write('sources debug', message, fields),
      warn: (message, fields) => write('sources warn', message, fields),
      error: (message, fields) => write('sources error', message, fields),
    },
  };
}

/** Builds the runtime with `source.fetch` over the fixture against the test database and starts its workers. */
export function createSourcesHarness(options: SourcesHarnessOptions): SourcesHarness {
  const config: RuntimeConfig = {
    ...parseRuntimeConfig({}),
    workers: true,
    concurrency: 2,
    pollMs: 50,
    dbPoolMax: 4,
    ...options.runtime,
  };
  const loggers = testLoggers(options.echoLogs ?? false);
  const owners = new Map<string, string>();
  const database = createDatabase({ connectionString: databaseUrl(), poolMax: config.dbPoolMax });
  const runtime = createRuntime({
    database,
    config,
    threads: threadOwnershipDouble(owners),
    logger: loggers.runtime,
    clock: systemClock,
  });
  const sources = createSources({
    handlers: runtime.handlers,
    adapters: [new FixtureSourceAdapter({ serverPath: fixtureServerPath, settings: options.sources, logger: loggers.sources })],
    declaration: TEST_DECLARATION,
    settings: options.sources,
    clock: systemClock,
    logger: loggers.sources,
  });
  for (const handler of options.handlers ?? []) runtime.handlers.register(handler);
  runtime.start();

  return {
    runtime,
    sources,
    database,
    createThread(resourceId, threadId = `thread-${randomUUID()}`) {
      owners.set(threadId, resourceId);
      return threadId;
    },
    async close() {
      try {
        await runtime.stop();
      } finally {
        try {
          await sources.close();
        } finally {
          await database.close();
        }
      }
    },
  };
}

/** `search_logs` arguments as the tests write them: JSON scalars, as `TaskSpec.input` stores them. */
export type FetchArgs = Readonly<Record<string, string | number>>;

/** What one `source.fetch` task asks the fixture for. */
export interface FetchRequest {
  readonly resourceId: string;
  readonly args: FetchArgs;
  readonly completeness: 'all' | 'sample';
}

/** The investigation and the `source.fetch` task {@link proposeFetch} created. */
export interface ProposedFetch {
  readonly investigationId: string;
  readonly threadId: string;
  readonly taskId: string;
}

/**
 * Creates an investigation of its own and proposes one `search_logs` task in it, pinned to the fixture's current
 * snapshot through its input reference, as `deep-research` proposes it (KD-5).
 */
export async function proposeFetch(harness: SourcesHarness, request: FetchRequest): Promise<ProposedFetch> {
  const { runtime, sources } = harness;
  const threadId = harness.createThread(request.resourceId);
  const { investigationId } = await runtime.investigations.create({
    resourceId: request.resourceId,
    threadId,
    query: 'mcp-source E2E-2',
    budget: { maxTasks: 1, maxToolCalls: 10 },
  });
  const snapshot = await sources.registry.currentSnapshot(FIXTURE_SOURCE_ID, AbortSignal.timeout(60_000));
  const spec: TaskSpec = {
    investigationId,
    workflowType: SOURCE_FETCH,
    workflowVersion: 1,
    input: { sourceId: FIXTURE_SOURCE_ID, toolName: SEARCH_LOGS, args: { ...request.args } },
    inputRefs: [{ kind: 'source', ref: FIXTURE_SOURCE_ID, snapshot }],
    expectedOutput: { description: 'fixture logs of the window', completeness: request.completeness },
    dependsOn: [],
    budget: { maxToolCalls: 10, maxRetries: 3, deadlineMs: 120_000, maxTokens: 0 },
  };
  const result = await runtime.scheduler.propose(spec, 'e2e-2');
  if (result.outcome === 'rejected') {
    throw new Error(`source.fetch rejected: ${JSON.stringify(result)}`);
  }
  return { investigationId, threadId, taskId: result.taskId };
}
