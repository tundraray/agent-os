import { randomUUID } from 'node:crypto';
import type { Investigation, ProposeResult, TaskSpec } from '@agent-os/contracts';
import {
  createDatabase,
  type Database,
  researchEngineRuns,
  researchInvestigations,
  researchLlmCalls,
  researchLlmTranscripts,
  researchTasks,
} from '@agent-os/db';
import {
  createEngine,
  deepResearchProcessV3,
  type Engine,
  type EngineLogger,
  type GroupTable,
  type TokenCounter,
  type TokenCountResult,
} from '@agent-os/engine';
import {
  type AttemptGuardResult,
  type Clock,
  createRuntime,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeConfig,
  type RuntimeLogger,
  type RuntimeTx,
  systemClock,
  type TaskContext,
  type TaskHandler,
  type TaskScheduler,
  type ThreadOwnership,
} from '@agent-os/runtime';
import {
  createSources,
  parseSourcesSettings,
  type SourceAdapter,
  type SourceDeclaration,
  type Sources,
  type SourcesLogger,
  type SourcesSettings,
} from '@agent-os/sources';
import { and, asc, eq, sql } from 'drizzle-orm';
// The internal assembly and the result forms are internal to the package: the harness registers its probe forms through
// `composeEngine` from the sources (ADR-0010), as the design says; `createEngine` takes no forms.
import { type ResultForm, SHIPPED_RESULT_FORMS } from '../../src/agents/result-forms.js';
import type { ToolAccessPolicy } from '../../src/agents/tool-access-policy.js';
import type { ToolRegistryEntry } from '../../src/agents/tool-registry.js';
// The repository is internal to the package; the harness writes seeded claims through it, as the handlers do.
import { claimsRepository } from '../../src/claims/claims.repository.js';
import { composeEngine, type CreateEngineOptions } from '../../src/create-engine.js';
import type { AgentTurnCountRequest } from '../../src/model/token-counter.js';
import { COUNTING_SOURCE_IDS, type CountingSource, createCountingSource } from './countingSource.js';
import { databaseUrl } from './database-url.js';
import { cancelLeftovers, cancelNotingLeftBehind, trackInvestigationOwner } from './engineDb.js';
import { createScriptedModel, type ScriptedModel, type ScriptedModelOptions } from './scriptedModel.js';
import { agentPromptsOf, type ResearchFlowOverrides, researchFlowGroupTable, researchFlowV3Config } from './test-configs.js';
import { turnInputCharacters } from './turnCount.js';

/** The harness's rights port unless a test passes its own: every owner may call every tool and read every source. */
const ALLOW_ALL_ACCESS: ToolAccessPolicy = { decide: () => 'allowed' };

/**
 * Test assembly of the engine (design-engine.md, Test Strategy): the real `createRuntime`, `createSources` and
 * `createEngine` over the test database, without `apps/api`. Doubles stand only at the boundaries: the model port
 * `resolveModel` (the scripted model double), the `TokenCounter`, the two in-memory counting sources, the rights port,
 * the thread-ownership port, the clock and the loggers. The engine package is imported by name, as the runtime and sources harnesses import theirs.
 */

/** Budget of the shipped deep-research configuration: what a start asks `InvestigationService.create` for. */
const DEFAULT_BUDGET = { maxTasks: 300, maxToolCalls: 3_000 };

/** What may change when the engine is (re)built over the same database. */
export interface EngineBuildOptions {
  /** Process configurations as data; the shipped deep-research configuration by default. */
  processes?: readonly unknown[];
  /** Both counting sources' ids by default (`fixture` and `backoffice`, mode `sources`); `[]` for the no-source mode. */
  connectedSources?: readonly string[];
  /** The catalog models `Engine.assess` may call (`createEngine`'s `assessModels`); none by default. */
  assessModels?: readonly string[];
  /** Group tables of `createEngine` (KD-3); the shipped ones (none calibrated yet) by default. */
  groupTables?: readonly GroupTable[];
}

/**
 * A claim a test writes itself instead of a worker (a pointer across the pages of several tasks, an empty pointer): its
 * first revision, `unverified`, as the worker's revision stores it.
 */
export interface SeededClaim {
  readonly text: string;
  readonly atoms: readonly { readonly kind: 'text' | 'number' | 'time'; readonly value: string }[];
  /** Stored as given, its pages in `evidenceIds`. */
  readonly pointer: readonly { readonly pageId: string; readonly records: readonly number[] }[];
}

/**
 * A revision a test appends to a seeded claim instead of a check task (INT-2): the status, group and basis a check
 * would store, with the claim's text unchanged.
 */
export interface SeededRevision {
  readonly claimId: string;
  readonly text: string;
  readonly status: 'supported' | 'causal' | 'insufficient';
  /** The group of a `supported` revision; null for the other statuses. */
  readonly confidence: 'very_high' | 'high' | 'medium' | 'low' | null;
  /** The basis of the check: the pages its status rests on. */
  readonly evidenceIds: readonly string[];
}

/** A source the assemblies connect instead of the counting source (E2E-1: the real fixture process). */
export interface HarnessSource {
  readonly settings: SourcesSettings;
  /** Every source of `adapter` and `extraAdapters`, with descriptions. */
  readonly declaration: SourceDeclaration;
  /** A new adapter per assembly: stopping an assembly closes its adapter with its sources. */
  adapter(logger: SourcesLogger): SourceAdapter;
  /** Further adapters of the same assembly, for a process with several sources (UC-16). */
  extraAdapters?(logger: SourcesLogger): readonly SourceAdapter[];
}

/** The agent settings of `createEngine` (design-agent-core.md, Runtime Settings); the engine's defaults without them. */
export interface AgentHarnessSettings {
  /** `AGENT_TURN_MS`. */
  readonly turnMs?: number;
  /** `AGENT_DEADLINE_MARGIN_MS`. */
  readonly deadlineMarginMs?: number;
  /** `AGENT_ATTEMPT_SLICE_MS`. */
  readonly attemptSliceMs?: number;
  /** `AGENT_BUSY_WAIT_MS`. */
  readonly busyWaitMs?: number;
  /** `RUNTIME_LEASE_MS` as the engine gets it: a child's `notAfter` is its parent's minus this (DC-27). */
  readonly leaseMs?: number;
}

export interface EngineHarnessOptions extends EngineBuildOptions {
  /** Runtime Settings over the test defaults (workers on, 2 slots, 50 ms poll, pool of 4); `workers: false` builds without workers. */
  runtime?: Partial<RuntimeConfig>;
  /** The clock of the runtime and the sources; the system clock by default. */
  clock?: Clock;
  /** The sources of every assembly; both counting sources by default (with one given, `countingSource` gets no call). */
  source?: HarnessSource;
  /** Options of the model double, such as the program that answers a call no scripted step is left for. */
  model?: ScriptedModelOptions;
  /**
   * Result forms beside the shipped ones: with them the engine is built through the internal `composeEngine` from the
   * package's sources (ADR-0010); without them through the public `createEngine` of the built package, as before.
   */
  resultForms?: readonly ResultForm[];
  /** Tool entries beside the engine's; like `resultForms`, they build the engine through `composeEngine`. */
  agentTools?: readonly ToolRegistryEntry[];
  /**
   * The rights port of the catalog at start and of agent tool calls: a test's table of rights (accessDouble.ts) or any
   * policy; every request is allowed by default ({@link ALLOW_ALL_ACCESS}).
   */
  toolAccessPolicy?: ToolAccessPolicy;
  /** The agent settings of `createEngine`. */
  agent?: AgentHarnessSettings;
}

/** One recorded log call. */
export type LogLine = [message: string, fields: unknown];

/**
 * How a transcript reads (design-self-check.md, Contract `Transcript`): the stored outcome of a closed call, `abandoned`
 * when the call's ledger row was closed `abandoned` before an answer, `open` while the call goes on.
 */
export type TranscriptReadOutcome = 'answered' | 'invalid_output' | 'provider_error' | 'abandoned' | 'open';

/** One `research_llm_transcripts` row of an investigation with the outcome it reads as. */
export type HarnessTranscript = Omit<typeof researchLlmTranscripts.$inferSelect, 'outcome'> & {
  readonly outcome: TranscriptReadOutcome;
};

/** Calls of a test logger by level, in order; a test may empty them. */
export interface LogLines {
  log: LogLine[];
  warn: LogLine[];
  error: LogLine[];
}

/**
 * Deterministic `TokenCounter`: one token per character of what a turn sends, plus `offset` — set it to make the
 * counted input differ from what the model double reports (DC-13).
 */
export interface OffsetTokenCounter extends TokenCounter {
  offset: number;
  /**
   * Every agent-turn request counted (DC-30), in order, over the harness's whole life: the harness never clears it, so a
   * test that reads it empties it first. An agent turn counts one token per character of its system block, its messages
   * and its tool schemas, plus `offset`.
   */
  readonly turnRequests: AgentTurnCountRequest[];
  /**
   * Consulted before each turn's count: it may hold the count and may answer a count of its own (UC-E15 answers
   * by the order of the requests inside a turn); with `undefined` the request is counted as usual. A test that sets it
   * sets it back to `undefined` before it ends.
   */
  interceptTurn: ((request: AgentTurnCountRequest) => Promise<number | undefined> | number | undefined) | undefined;
}

/** A timer of the engine clock the test fires itself (see {@link ShiftedClock.holdTimers}). */
export interface HeldTimer {
  readonly ms: number;
  /** Runs the timer's callback now and drops it from `heldTimers`. */
  fire(): void;
}

/**
 * The clock the engine is built with: the harness clock moved by `offsetMs` (0 by default). Moving it puts the engine past
 * a `notAfter` while the runtime's leases and deadlines keep the harness clock. A test that moves it sets it back to 0
 * before it ends.
 */
export interface ShiftedClock extends Clock {
  offsetMs: number;
  /**
   * Which engine timers the test fires itself, by their delay: a timer it accepts waits in {@link heldTimers} instead of
   * running on the harness clock — a wait of the engine (the 2-second reserve wait, INT-3) without a sleep. Moving
   * `offsetMs` fires no timer. A test that sets it sets it back to `undefined` before it ends.
   */
  holdTimers: ((ms: number) => boolean) | undefined;
  /** The held timers not fired or cancelled yet, in the order they were set. */
  readonly heldTimers: HeldTimer[];
  /**
   * Every value `now()` returned, in ms, in order: a test derives what the engine computed from the exact instant it
   * read, never by comparing the engine clock with a database timestamp (two clock sources).
   */
  readonly reads: number[];
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

/**
 * Holds the engine after a proposal of the `TaskScheduler` it was built with returned and before the engine goes on —
 * the gap between `propose` and the guarded write that records a child's task id (agent-core INT-4 B3).
 */
export interface SchedulerHold {
  /** Awaited after each proposal; a test that sets it sets it back to `undefined` before it ends. */
  afterPropose: ((spec: TaskSpec, result: ProposeResult) => Promise<void> | void) | undefined;
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
  readonly schedulerHold: SchedulerHold;
  /**
   * The lease of the task's running `attempt` runs out now on the harness clock, as if its worker had stopped beating:
   * the recovery sweeper requeues the task and the next attempt takes it (runtime INT-3). Throws when that attempt
   * is not the task's running one.
   */
  expireLease(taskId: string, attempt: number): Promise<void>;
  /**
   * Clears the investigation's recorded `controller_task_id`, as if its controller had ended before the start recorded
   * it: the state `engine.lifecycle` must close from all the same.
   */
  unrecordControllerTask(investigationId: string): Promise<void>;
  /** A new thread of `resourceId` known to the ownership double; returns its id. */
  createThread(resourceId: string): Promise<string>;
  /**
   * Writes the first revision of each claim through the claims repository's worker write, as written by `taskId` (a task
   * of the investigation that writes no claims of its own, such as its controller task), numbered in the given order;
   * returns the new claim ids in that order.
   */
  seedClaims(seed: { readonly investigationId: string; readonly taskId: string; readonly claims: readonly SeededClaim[] }): Promise<string[]>;
  /**
   * Appends a revision to each seeded claim through the claims repository's check write, as appended by `taskId` (a task
   * of the investigation that writes no claims of its own and is not the one of {@link seedClaims}), numbered in the
   * given order. The pointer of each revision is one record of each basis page.
   */
  seedRevisions(seed: { readonly investigationId: string; readonly taskId: string; readonly revisions: readonly SeededRevision[] }): Promise<void>;
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
  /**
   * Deletes the thread's investigations through the real `InvestigationService.purgeThread` (a deleted conversation) and
   * drops them from the starts {@link cancelStarted} cancels.
   */
  purgeThread(resourceId: string, threadId: string): Promise<void>;
  /**
   * The transcripts of the investigation in call order (creation time, ties by `callId`), read only when `ownerId` owns
   * it — another owner reads none. `abandoned` is read from the call's ledger row, which never stores it on the transcript.
   */
  readTranscriptsOf(investigationId: string, ownerId: string): Promise<HarnessTranscript[]>;
  /**
   * Moves `created_at` of the investigation's transcripts (of the one call `only.callId` when given) `days` back, as if
   * they had been written that much earlier: the age a retention term sees, without a sleep. The shift adds up over calls.
   */
  ageTranscripts(investigationId: string, days: number, only?: { readonly callId: string }): Promise<void>;
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
    turnRequests: [],
    interceptTurn: undefined,
    async countTurnInputTokens(request): Promise<TokenCountResult> {
      counter.turnRequests.push(request);
      const intercepted = await counter.interceptTurn?.(request);
      if (intercepted !== undefined) {
        return { outcome: 'counted', inputTokens: intercepted };
      }
      return { outcome: 'counted', inputTokens: turnInputCharacters(request) + counter.offset };
    },
  };
  return counter;
}

function shiftedClock(base: Clock): ShiftedClock {
  const drop = (timer: HeldTimer): void => {
    const index = clock.heldTimers.indexOf(timer);
    if (index >= 0) clock.heldTimers.splice(index, 1);
  };
  const clock: ShiftedClock = {
    offsetMs: 0,
    reads: [],
    holdTimers: undefined,
    heldTimers: [],
    now: () => {
      const now = base.now().getTime() + clock.offsetMs;
      clock.reads.push(now);
      return new Date(now);
    },
    random: () => base.random(),
    setTimer: (ms, callback) => {
      if (clock.holdTimers?.(ms) !== true) return base.setTimer(ms, callback);
      const timer: HeldTimer = {
        ms,
        fire: () => {
          drop(timer);
          callback();
        },
      };
      clock.heldTimers.push(timer);
      return () => drop(timer);
    },
  };
  return clock;
}

/** `ctx` with `hold` awaited after each guarded write and after each saved checkpoint. */
function heldContext(ctx: TaskContext, hold: (at: 'checkpoint' | 'guarded', checkpoint?: unknown) => Promise<void>): TaskContext {
  /** The guard in either mode, held after it returned. */
  function withAttemptGuard<T>(work: (tx: RuntimeTx) => Promise<T>): Promise<AttemptGuardResult<T>>;
  function withAttemptGuard<T>(
    work: (tx: RuntimeTx) => Promise<T>,
    options: { readonly requireActive: true },
  ): Promise<AttemptGuardResult<T, true>>;
  async function withAttemptGuard<T>(
    work: (tx: RuntimeTx) => Promise<T>,
    options?: { readonly requireActive: true },
  ): Promise<AttemptGuardResult<T, true>> {
    const result = options === undefined ? await ctx.withAttemptGuard(work) : await ctx.withAttemptGuard(work, options);
    await hold('guarded');
    return result;
  }
  const guarded: Pick<TaskContext, 'withAttemptGuard' | 'saveCheckpoint'> = {
    withAttemptGuard,
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

/** What a research-flow scenario changes in its assembly: the shipped numbers, the sources, the options of any harness. */
export interface ResearchFlowHarnessOptions extends EngineHarnessOptions {
  /** The named numbers of `researchFlowV3Config`; the shipped v3 without them. */
  readonly overrides?: ResearchFlowOverrides;
  /** No source connected: the investigation starts in `model_knowledge` mode. */
  readonly noSources?: boolean;
}

/**
 * The assembly of the research-flow and catalog-planning scenarios (design-research-flow.md, design-catalog-planning.md,
 * Test Strategy): the shipped v3 on the two-source ceiling, its test group table by the loaded `verifier`, and both
 * counting sources connected.
 */
export function createResearchFlowHarness({ overrides, noSources, ...options }: ResearchFlowHarnessOptions = {}): Promise<EngineHarness> {
  const config = researchFlowV3Config(overrides);
  return createEngineHarness({
    processes: [config],
    groupTables: [researchFlowGroupTable(config)],
    ...(noSources === true ? { connectedSources: [] } : {}),
    ...options,
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
  const schedulerHold: SchedulerHold = { afterPropose: undefined };
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
  const model = createScriptedModel(options.model);
  const sourcesSettings = options.source?.settings ?? parseSourcesSettings({ SOURCE_RETRY_BASE_MS: '10', SOURCE_RETRY_CAP_MS: '50' });
  let build: EngineBuildOptions = {
    processes: options.processes ?? [deepResearchProcessV3],
    connectedSources: options.connectedSources ?? COUNTING_SOURCE_IDS,
    assessModels: options.assessModels ?? [],
    // Uncalibrated unless a test passes tables: the shipped tables must not change what a test asserts.
    groupTables: options.groupTables ?? [],
  };

  /**
   * createEngine runs before the workers start, as in the composition root (handlers registered before a claim);
   * `fence` cancels the leftovers in between ({@link cancelLeftovers}). Apart from {@link EngineHarness.expireLease},
   * {@link EngineHarness.unrecordControllerTask} and {@link EngineHarness.ageTranscripts}, rows are never edited by the
   * harness.
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
      adapters:
        options.source === undefined
          ? countingSource.adapters
          : [options.source.adapter(sourcesLogger(logs.sources)), ...(options.source.extraAdapters?.(sourcesLogger(logs.sources)) ?? [])],
      declaration: options.source?.declaration ?? countingSource.declaration,
      settings: sourcesSettings,
      clock,
      logger: sourcesLogger(logs.sources),
    });
    const scheduler: Pick<TaskScheduler, 'propose'> = {
      propose: async (spec, requesterKey) => {
        const result = await runtime.scheduler.propose(spec, requesterKey);
        await schedulerHold.afterPropose?.(spec, result);
        return result;
      },
    };
    const engineOptions: CreateEngineOptions = {
      database: database.db,
      runtime: {
        scheduler,
        investigations: runtime.investigations,
        handlers: { register: (handler) => runtime.handlers.register(observed(handler)) },
        eventConsumers: runtime.eventConsumers,
      },
      sourceRegistry: sources.registry,
      connectedSources: build.connectedSources ?? [],
      processes: build.processes ?? [],
      assessModels: build.assessModels ?? [],
      ...(build.groupTables === undefined ? {} : { groupTables: build.groupTables }),
      resolveModel: model.resolveModel,
      tokenCounter,
      clock: engineClock,
      logger: recordingLogger(logs.engine),
      ...options.agent,
      toolAccessPolicy: options.toolAccessPolicy ?? ALLOW_ALL_ACCESS,
    };
    const engine =
      options.resultForms === undefined && options.agentTools === undefined
        ? createEngine(engineOptions)
        : composeEngine(engineOptions, {
            resultForms: [...SHIPPED_RESULT_FORMS, ...(options.resultForms ?? [])],
            ...(options.agentTools === undefined ? {} : { tools: options.agentTools }),
          });
    model.recognizeAgents((build.processes ?? []).flatMap(agentPromptsOf));
    if (fence) {
      await cancelLeftovers(database.db, runtime.investigations);
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
    readAnswerMessage: (input) => engine.readAnswerMessage(input),
    assess: (request) => engine.assess(request),
    writeDefinitionMemory: (input) => engine.writeDefinitionMemory(input),
    removeDefinitionMemory: (input) => engine.removeDefinitionMemory(input),
    listDefinitionMemory: (input) => engine.listDefinitionMemory(input),
    readAgentTree: (input) => engine.readAgentTree(input),
    assessAgent: (request) => engine.assessAgent(request),
    checkCalibration: () => engine.checkCalibration(),
    startInvestigation: async (input) => {
      trackInvestigationOwner(input.resourceId);
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
    schedulerHold,
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
    unrecordControllerTask: async (investigationId) => {
      const cleared = await database.db
        .update(researchEngineRuns)
        .set({ controllerTaskId: null })
        .where(eq(researchEngineRuns.investigationId, investigationId))
        .returning({ investigationId: researchEngineRuns.investigationId });
      if (cleared.length !== 1) {
        throw new Error(`investigation ${investigationId} has no engine row`);
      }
    },
    createThread: async (resourceId) => {
      const threadId = `thread-${randomUUID()}`;
      owners.set(threadId, resourceId);
      return threadId;
    },
    seedClaims: ({ investigationId, taskId, claims }) =>
      database.db.transaction((tx) =>
        claimsRepository.writeTaskClaims(tx, {
          investigationId,
          taskId,
          coverage: null,
          claims: claims.map(({ text, atoms, pointer }) => ({
            text,
            atoms: [...atoms],
            pointer: pointer.map((entry) => ({ pageId: entry.pageId, records: [...entry.records] })),
          })),
        }),
      ),
    seedRevisions: ({ investigationId, taskId, revisions }) =>
      database.db.transaction((tx) =>
        claimsRepository.appendRevisions(tx, {
          investigationId,
          taskId,
          revisions: revisions.map(({ claimId, text, status, confidence, evidenceIds }) => ({
            claimId,
            text,
            atoms: [],
            evidenceIds,
            coverage: null,
            status,
            pointer: evidenceIds.map((pageId) => ({ pageId, records: [0] })),
            claimType: status === 'causal' ? 'causal' : 'observation',
            assessment: null,
            confidence,
          })),
        }),
      ),
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
        await cancelNotingLeftBehind(database.db, current.runtime.investigations, { investigationId, resourceId });
      }
      started.clear();
    },
    purgeThread: async (resourceId, threadId) => {
      const purged = await current.runtime.investigations.listForThread(resourceId, threadId);
      await current.runtime.investigations.purgeThread({ resourceId, threadId });
      for (const { investigationId } of purged) started.delete(investigationId);
    },
    readTranscriptsOf: async (investigationId, ownerId) => {
      const rows = await database.db
        .select({ transcript: researchLlmTranscripts, ledgerStatus: researchLlmCalls.status })
        .from(researchLlmTranscripts)
        .innerJoin(researchInvestigations, eq(researchInvestigations.investigationId, researchLlmTranscripts.investigationId))
        .leftJoin(researchLlmCalls, eq(researchLlmCalls.callId, researchLlmTranscripts.llmCallId))
        .where(and(eq(researchLlmTranscripts.investigationId, investigationId), eq(researchInvestigations.resourceId, ownerId)))
        .orderBy(asc(researchLlmTranscripts.createdAt), asc(researchLlmTranscripts.callId));
      return rows.map(({ transcript, ledgerStatus }) => ({
        ...transcript,
        outcome: (transcript.outcome as TranscriptReadOutcome | null) ?? (ledgerStatus === 'abandoned' ? 'abandoned' : 'open'),
      }));
    },
    ageTranscripts: async (investigationId, days, only) => {
      const aged = await database.db
        .update(researchLlmTranscripts)
        .set({ createdAt: sql`${researchLlmTranscripts.createdAt} - make_interval(days => ${days})` })
        .where(
          and(
            eq(researchLlmTranscripts.investigationId, investigationId),
            only === undefined ? undefined : eq(researchLlmTranscripts.callId, only.callId),
          ),
        )
        .returning({ callId: researchLlmTranscripts.callId });
      if (aged.length === 0) {
        throw new Error(`investigation ${investigationId} has no transcript to age`);
      }
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
