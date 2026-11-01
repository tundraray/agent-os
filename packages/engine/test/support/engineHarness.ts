import { randomUUID } from 'node:crypto';
import type { Investigation } from '@agent-os/contracts';
import { createDatabase, type Database, researchEngineRuns, researchInvestigations, researchTasks } from '@agent-os/db';
import {
  createEngine,
  deepResearchProcessV1,
  type Engine,
  type EngineLogger,
  type SignalKind,
  type TokenCounter,
  type TokenCountRequest,
  type TokenCountResult,
} from '@agent-os/engine';
import {
  type Clock,
  createRuntime,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  type RuntimeLogger,
  systemClock,
  type TaskContext,
  type TaskHandler,
  type ThreadOwnership,
} from '@agent-os/runtime';
import { createSources, parseSourcesSettings, type Sources, type SourcesLogger } from '@agent-os/sources';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { COUNTING_SOURCE_ID, type CountingSource, createCountingSource } from './countingSource.js';
import { databaseUrl } from './database-url.js';
import { createScriptedModel, type ScriptedModel } from './scriptedModel.js';

/**
 * Test assembly of the engine (design-engine.md, Test Strategy): the real `createRuntime`, `createSources` and
 * `createEngine` over the test database, without `apps/api`. Doubles stand only at the boundaries: the model port
 * `resolveModel` (the scripted model double), the `TokenCounter`, the in-memory counting source, the thread-ownership
 * port, the clock and the loggers. The engine package is imported by name, as the runtime and sources harnesses import theirs.
 */

/** Budget of the shipped deep-research configuration: what a start asks `InvestigationService.create` for. */
const DEFAULT_BUDGET = { maxTasks: 300, maxToolCalls: 3_000 };

/** The signal kind every harness engine registers (UC-5): a note with its text. */
export const TEST_NOTE_KIND: SignalKind = { kind: 'test.note', payloadSchema: z.object({ note: z.string() }) };

/** What may change when the engine is (re)built over the same database. */
export interface EngineBuildOptions {
  /** Process configurations as data; the shipped deep-research configuration by default. */
  processes?: readonly unknown[];
  /** The counting source's id by default (mode `sources`); `[]` for the no-source mode. */
  connectedSources?: readonly string[];
  /** Signal kinds of `createEngine`; `[TEST_NOTE_KIND]` by default. */
  signalKinds?: readonly SignalKind[];
}

export interface EngineHarnessOptions extends EngineBuildOptions {
  /** Runtime Settings over the test defaults (workers on, 2 slots, 50 ms poll, pool of 4); `workers: false` builds without workers. */
  runtime?: Partial<RuntimeConfig>;
  /** The clock of the runtime and the sources; the system clock by default. */
  clock?: Clock;
}

/** One recorded log call. */
export type LogLine = [message: string, fields: unknown];

/** Calls of a test logger by level, in order; a test may empty them. */
export interface LogLines {
  log: LogLine[];
  warn: LogLine[];
  error: LogLine[];
}

/**
 * Deterministic `TokenCounter`: one token per character of the instructions and the messages, plus `offset` — set it
 * to make the counted input differ from what the model double reports (DC-13).
 */
export interface OffsetTokenCounter extends TokenCounter {
  offset: number;
  /** Every request counted, in order. */
  readonly requests: TokenCountRequest[];
  /**
   * Consulted before each count: it may hold the count (a latch or a barrier) and may answer a count of its own; with
   * `undefined` the request is counted as usual. A test that sets it sets it back to `undefined` before it ends.
   */
  intercept: ((request: TokenCountRequest) => Promise<number | undefined> | number | undefined) | undefined;
}

/**
 * The clock the engine is built with: the harness clock moved by `offsetMs` (0 by default). Moving it puts the engine past
 * a `notAfter` while the runtime's leases and deadlines keep the harness clock. A test that moves it sets it back to 0
 * before it ends.
 */
export interface ShiftedClock extends Clock {
  offsetMs: number;
}

/**
 * A point an attempt of an engine handler reaches: `run` before the handler starts, `checkpoint` after a
 * `saveCheckpoint` returned, `guarded` after a `withAttemptGuard` returned, `end` after the handler returned its result
 * and before the runtime gets it.
 */
export interface HandlerPoint {
  readonly at: 'run' | 'checkpoint' | 'guarded' | 'end';
  readonly workflowType: string;
  readonly taskId: string;
  readonly attempt: number;
  /** At `checkpoint`: the value saved. */
  readonly checkpoint?: unknown;
}

/** Holds the engine's handlers at their points (a zombie attempt kept alive, INT-4). */
export interface HandlerHold {
  /**
   * Awaited at every {@link HandlerPoint}: the attempt goes on when it settles. A test that sets it sets it back to
   * `undefined` before it ends.
   */
  at: ((point: HandlerPoint) => Promise<void> | void) | undefined;
}

export interface EngineHarness {
  /** The Drizzle client of the harness pool. */
  readonly db: Database;
  /** Replaced by {@link rebuildEngine}. */
  readonly runtime: Runtime;
  /** Replaced by {@link rebuildEngine}; its starts are recorded for {@link cancelStarted}. */
  readonly engine: Engine;
  readonly countingSource: CountingSource;
  readonly tokenCounter: OffsetTokenCounter;
  /** The engine's clock; it survives {@link rebuildEngine}. */
  readonly engineClock: ShiftedClock;
  /** The model double behind `resolveModel`; it survives {@link rebuildEngine}. */
  readonly model: ScriptedModel;
  readonly clock: Clock;
  readonly logs: { readonly runtime: LogLines; readonly engine: LogLines; readonly sources: LogLines };
  /**
   * Attempts of the engine's handlers whose `run` has returned or thrown, in order. The runtime settles a cancelled
   * attempt without waiting for its handler; this tells a test when the handler itself is done. A test may empty it.
   */
  readonly endedRuns: { readonly taskId: string; readonly attempt: number }[];
  readonly handlerHold: HandlerHold;
  /**
   * The lease of the task's running `attempt` runs out now on the harness clock, as if its worker had stopped beating:
   * the recovery sweeper requeues the task and the next attempt takes it (runtime INT-3). Throws when that attempt
   * is not the task's running one.
   */
  expireLease(taskId: string, attempt: number): Promise<void>;
  /** A new thread of `resourceId` known to the ownership double; returns its id. */
  createThread(resourceId: string): Promise<string>;
  /**
   * The state a start killed between `InvestigationService.create` and the engine row leaves (KD-9): an investigation
   * created by the real service, with no engine row and no task. The deep-research budget by default.
   */
  seedShell(shell: {
    resourceId: string;
    threadId: string;
    query: string;
    budget?: Investigation['budget'];
  }): Promise<Investigation>;
  /**
   * Stops the runtime and builds a new runtime, sources and engine over the same database and threads — a restart of
   * the process with other configurations or `connectedSources` (UC-10, UC-11). Returns the new engine. By default the
   * new assembly fences the leftovers like the first one; `fence: false` keeps the tasks a test parked before the
   * rebuild, which the restarted workers then resume (C6).
   */
  rebuildEngine(options?: EngineBuildOptions, rebuild?: { fence?: boolean }): Promise<Engine>;
  /**
   * Cancels, through the real `InvestigationService.cancel`, every investigation started through {@link engine} that is
   * still active — call in `afterEach`, so a test that failed midway leaves no controller task to the next one.
   */
  cancelStarted(): Promise<void>;
  /** Stops the runtime and closes the sources, then the pool — the pool even when the stop fails. */
  close(): Promise<void>;
}

function recordingLogs(): LogLines {
  return { log: [], warn: [], error: [] };
}

/** A logger of the engine or the runtime writing into `lines`. */
function recordingLogger(lines: LogLines): EngineLogger & RuntimeLogger {
  const record =
    (level: keyof LogLines) =>
    (message: string, fields?: unknown): void => {
      lines[level].push([message, fields]);
    };
  return { log: record('log'), warn: record('warn'), error: record('error') };
}

function sourcesLogger(lines: LogLines): SourcesLogger {
  return {
    debug: () => undefined,
    warn: (message, fields) => lines.warn.push([message, fields]),
    error: (message, fields) => lines.error.push([message, fields]),
  };
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

function offsetTokenCounter(): OffsetTokenCounter {
  const counter: OffsetTokenCounter = {
    offset: 0,
    requests: [],
    intercept: undefined,
    async countInputTokens(request): Promise<TokenCountResult> {
      counter.requests.push(request);
      const intercepted = await counter.intercept?.(request);
      if (intercepted !== undefined) {
        return { outcome: 'counted', inputTokens: intercepted };
      }
      const characters =
        request.system.length + request.messages.reduce((sum, message) => sum + message.content.length, 0);
      return { outcome: 'counted', inputTokens: characters + counter.offset };
    },
  };
  return counter;
}

function shiftedClock(base: Clock): ShiftedClock {
  const clock: ShiftedClock = {
    offsetMs: 0,
    now: () => new Date(base.now().getTime() + clock.offsetMs),
    random: () => base.random(),
    setTimer: (ms, callback) => base.setTimer(ms, callback),
  };
  return clock;
}

/** `ctx` with `hold` awaited after each guarded write and after each saved checkpoint. */
function heldContext(ctx: TaskContext, hold: (at: 'checkpoint' | 'guarded', checkpoint?: unknown) => Promise<void>): TaskContext {
  const guarded: Pick<TaskContext, 'withAttemptGuard' | 'saveCheckpoint'> = {
    withAttemptGuard: async (work) => {
      const result = await ctx.withAttemptGuard(work);
      await hold('guarded');
      return result;
    },
    saveCheckpoint: async (checkpoint) => {
      await ctx.saveCheckpoint(checkpoint);
      await hold('checkpoint', checkpoint);
    },
  };
  return new Proxy(ctx, {
    get(target, property) {
      if (property === 'withAttemptGuard' || property === 'saveCheckpoint') return guarded[property];
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Builds the database, runtime, sources and engine, and starts the runtime's workers unless they are off. */
export async function createEngineHarness(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  const config: RuntimeConfig = {
    ...parseRuntimeConfig({}),
    workers: true,
    concurrency: 2,
    pollMs: 50,
    dbPoolMax: 4,
    ...options.runtime,
  };
  const clock = options.clock ?? systemClock;
  const engineClock = shiftedClock(clock);
  const logs = { runtime: recordingLogs(), engine: recordingLogs(), sources: recordingLogs() };
  const owners = new Map<string, string>();
  const endedRuns: { taskId: string; attempt: number }[] = [];
  const handlerHold: HandlerHold = { at: undefined };
  /** The engine's handlers as registered, held at their points by `handlerHold`, with every end of `run` recorded in `endedRuns`. */
  const observed = (handler: TaskHandler): TaskHandler => ({
    ...handler,
    run: async (ctx) => {
      const hold = async (at: HandlerPoint['at'], checkpoint?: unknown): Promise<void> => {
        const point = { at, workflowType: handler.workflowType, taskId: ctx.taskId, attempt: ctx.attempt };
        await handlerHold.at?.(at === 'checkpoint' ? { ...point, checkpoint } : point);
      };
      try {
        await hold('run');
        const result = await handler.run(heldContext(ctx, hold));
        await hold('end');
        return result;
      } finally {
        endedRuns.push({ taskId: ctx.taskId, attempt: ctx.attempt });
      }
    },
  });
  const database = createDatabase({ connectionString: databaseUrl(), poolMax: config.dbPoolMax });
  const countingSource = createCountingSource();
  const tokenCounter = offsetTokenCounter();
  const model = createScriptedModel();
  const sourcesSettings = parseSourcesSettings({ SOURCE_RETRY_BASE_MS: '10', SOURCE_RETRY_CAP_MS: '50' });
  let build: EngineBuildOptions = {
    processes: options.processes ?? [deepResearchProcessV1],
    connectedSources: options.connectedSources ?? [COUNTING_SOURCE_ID],
    signalKinds: options.signalKinds ?? [TEST_NOTE_KIND],
  };

  /**
   * The fence of an assembly: before the workers start, every active investigation with an engine row — what an earlier
   * run of the file left, for instance after a failed test — is cancelled through the real service, so the new workers
   * never claim a foreign controller task that would consume the script. Apart from {@link EngineHarness.expireLease},
   * rows are never edited by the harness.
   */
  async function cancelLeftovers(runtime: Runtime): Promise<void> {
    const leftovers = await database.db
      .select({ investigationId: researchInvestigations.investigationId, resourceId: researchInvestigations.resourceId })
      .from(researchInvestigations)
      .innerJoin(researchEngineRuns, eq(researchEngineRuns.investigationId, researchInvestigations.investigationId))
      .where(eq(researchInvestigations.status, 'active'));
    for (const { investigationId, resourceId } of leftovers) {
      await runtime.investigations.cancel(investigationId, resourceId);
    }
  }

  /**
   * createEngine runs before the workers start, as in the composition root (handlers registered before a claim);
   * `fence` cancels the leftovers in between.
   */
  async function assemble(fence: boolean): Promise<{ runtime: Runtime; sources: Sources; engine: Engine }> {
    const runtime = createRuntime({
      database,
      config,
      threads: threadOwnershipDouble(owners),
      logger: recordingLogger(logs.runtime),
      clock,
    });
    const sources = createSources({
      handlers: runtime.handlers,
      adapters: [countingSource.adapter],
      allowlist: countingSource.allowlist,
      settings: sourcesSettings,
      clock,
      logger: sourcesLogger(logs.sources),
    });
    const engine = createEngine({
      database: database.db,
      runtime: {
        scheduler: runtime.scheduler,
        investigations: runtime.investigations,
        evidence: runtime.evidence,
        handlers: { register: (handler) => runtime.handlers.register(observed(handler)) },
      },
      sourceRegistry: sources.registry,
      connectedSources: build.connectedSources ?? [],
      processes: build.processes ?? [],
      signalKinds: build.signalKinds ?? [],
      resolveModel: model.resolveModel,
      tokenCounter,
      clock: engineClock,
      logger: recordingLogger(logs.engine),
    });
    if (fence) {
      await cancelLeftovers(runtime);
    }
    runtime.start();
    return { runtime, sources, engine };
  }

  let current = await assemble(true);
  /** Investigations started through the harness engine, with their owner. */
  const started = new Map<string, string>();
  const recordStarts = (engine: Engine): Engine => ({
    get sourceMode() {
      return engine.sourceMode;
    },
    readInvestigation: (input) => engine.readInvestigation(input),
    recordSignal: (input) => engine.recordSignal(input),
    startInvestigation: async (input) => {
      const result = await engine.startInvestigation(input);
      if (result.outcome !== 'rejected') {
        started.set(result.investigationId, input.resourceId);
      }
      return result;
    },
  });
  const stop = async (): Promise<void> => {
    try {
      await current.runtime.stop();
    } finally {
      await current.sources.close();
    }
  };

  return {
    db: database.db,
    get runtime() {
      return current.runtime;
    },
    get engine() {
      return recordStarts(current.engine);
    },
    countingSource,
    tokenCounter,
    engineClock,
    model,
    clock,
    logs,
    endedRuns,
    handlerHold,
    expireLease: async (taskId, attempt) => {
      const expired = await database.db
        .update(researchTasks)
        .set({ leaseExpiresAt: new Date(clock.now().getTime() - 1_000) })
        .where(and(eq(researchTasks.taskId, taskId), eq(researchTasks.status, 'running'), eq(researchTasks.attempt, attempt)))
        .returning({ taskId: researchTasks.taskId });
      if (expired.length !== 1) {
        throw new Error(`task ${taskId} is not running attempt ${attempt}`);
      }
    },
    createThread: async (resourceId) => {
      const threadId = `thread-${randomUUID()}`;
      owners.set(threadId, resourceId);
      return threadId;
    },
    seedShell: ({ resourceId, threadId, query, budget = DEFAULT_BUDGET }) =>
      current.runtime.investigations.create({ resourceId, threadId, query, budget }),
    rebuildEngine: async (next = {}, { fence = true } = {}) => {
      await stop();
      build = { ...build, ...next };
      current = await assemble(fence);
      return recordStarts(current.engine);
    },
    cancelStarted: async () => {
      for (const [investigationId, resourceId] of started) {
        await current.runtime.investigations.cancel(investigationId, resourceId);
      }
      started.clear();
    },
    close: async () => {
      try {
        await stop();
      } finally {
        await database.close();
      }
    },
  };
}
