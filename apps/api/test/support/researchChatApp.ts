import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication, InjectionToken } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { ToolsInput } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import type { AuditEvent } from '@agent-os/contracts';
import type { SourceMode } from '@agent-os/engine';
import {
  type Clock,
  type HandlerRegistry,
  type Runtime,
  systemClock,
} from '@agent-os/runtime';
import pg from 'pg';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { AuditService } from '../../src/audit/audit.service.js';
import { configureApp } from '../../src/app.setup.js';
import {
  ENGINE_GROUP_TABLES,
  RESEARCH_ENGINE,
} from '../../src/engine/engine.tokens.js';
import {
  ASSISTANT_INSTRUCTIONS,
  turnModelId,
} from '../../src/mastra/agents/assistant.agent.js';
import { MASTRA } from '../../src/mastra/mastra.constants.js';
import { createDeepResearchTool } from '../../src/research-chat/deep-research.tool.js';
import { ResearchAnswerAppender } from '../../src/research-chat/research-answer.appender.js';
import { ResearchLaunchService } from '../../src/research-chat/research-launch.service.js';
import { createStopResearchTool } from '../../src/research-chat/stop-research.tool.js';
import {
  HANDLER_REGISTRY,
  RESEARCH_RUNTIME,
  RUNTIME_CLOCK,
} from '../../src/research/research.tokens.js';
import { SOURCE_ADAPTERS } from '../../src/sources/sources.module.js';
import { THREAD_MEMORY } from '../../src/threads/thread-memory.provider.js';
import {
  createThreadTitleAgent,
  THREAD_TITLE_AGENT,
} from '../../src/threads/thread-title.agent.js';
import {
  THREAD_RUN_MARKS,
  type ThreadRunMarks,
  ThreadRunRegistry,
} from '../../src/threads/thread-run-registry.js';
import {
  THREAD_LOCK_NAMESPACE,
  ThreadWriteLock,
} from '../../src/threads/thread-write-lock.js';
import { ThreadsService } from '../../src/threads/threads.service.js';
import { createTestMastra } from './createTestApp.js';
import {
  createEngineDouble,
  DOUBLE_LIFECYCLE_CONSUMER,
  type EngineDouble,
} from './engineDouble.js';
import {
  DEEP_RESEARCH_TOOL,
  SCRIPTED_CHAT_MODEL_ID,
  type ScriptedChatModel,
  STOP_RESEARCH_TOOL,
  scriptedChatModel,
  titleModel,
} from './mockModels.js';
import { cancelLeftovers, unfinishedTaskCount } from './researchChatDb.js';
import { newUser, seed } from './seed.js';
import { TEST_GROUP_TABLES } from './testGroupTables.js';
import { type Latch, latch, query } from './wiring-handlers.js';

/**
 * The in-process app of the chat-entry integration file (design-chat-entry.md, Test Strategy): the real `AppModule`
 * — `ChatController`, `ThreadsService` with its lock, `ThreadRunRegistry`, Mastra Memory over Postgres, the real
 * runtime with its workers on, and the part's `ResearchChatModule` — with the doubled
 * boundaries only: the scripted chat model and the engine port (`RESEARCH_ENGINE`). Around the real pieces it puts
 * observers and scripted faults: calls of `investigations.cancel`, failed writes of answer messages and of the tail
 * delete, reads of `EvidenceReader.get`, a refused thread lock, a refused move of a launch to `stopped`, the audit
 * records of the real `AuditInterceptor`, and the clock of the runtime and the delivery loop.
 *
 * Two instances (design-lifecycle.md, INT-2): `createResearchChatApp` may run twice over the one database; each app has
 * its own label, pools, clock, `ThreadRunRegistry`, doubles and runtime workers (a worker claims only the workflow types
 * its runtime registered, so neither runs the other's controller tasks). They share Postgres only — the thread lock, the
 * run marks, the launch rows, the investigations — and the environment, which stays set until the last live app closes.
 *
 * Isolation (plan rule 9): one app per file, or two for the two-instance tests (`afterAll` → `close`); `reset` in `beforeEach` and `afterEach` returns
 * every double, observer, fault and the clock to their initial state, releases the gates, restores real timers and
 * cancels the investigations a test left running. Environment variables are set for the app's lifetime and restored
 * by `close`. Each test takes its own user from `user()` (a fresh `newUser()`); `close` deletes their threads through
 * `ThreadsService.delete`, so the runtime's and the part's deletion hooks remove the investigations and launch rows.
 */

/** Runtime settings of the assembly (design-runtime.md variables), over the e2e harness default `RUNTIME_WORKERS=off`. */
const RUNTIME_ENV = {
  RUNTIME_WORKERS: 'on',
  RUNTIME_CONCURRENCY: '2',
  RUNTIME_POLL_MS: '50',
  DB_POOL_MAX: '6',
} as const;

/** How long `reset` and `close` wait for cancelled controller tasks to end, and how often they look. */
const SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_POLL_MS = 50;

/** Id prefix of answer messages (`research-answer-<investigationId>`, design-chat-entry.md KD-4). */
const ANSWER_MESSAGE_PREFIX = 'research-answer-';

/** Instruction and tools of the test `assistant` agent. */
export interface TestAgentDefinition {
  instructions?: string;
  tools?: ToolsInput;
}

/** A provider of the compiled app; it throws when called before the module has compiled. */
export type ResolveProvider = <T>(token: InjectionToken) => T;

export interface ResearchChatAppOptions {
  /** Label of the instance in the harness's failure messages (two instances over one database); default `app`. */
  instance?: string;
  /**
   * Variables set before the module compiles and kept until `close` (the part's `RESEARCH_APPEND_GIVE_UP_MS`,
   * `RESEARCH_LAUNCH_RECOVERY_MS`, runtime settings over {@link RUNTIME_ENV}); `undefined` unsets one.
   */
  env?: Record<string, string | undefined>;
  /**
   * Instruction and tools of the test `assistant` agent, or a function of `resolve` building them. Default: the
   * production chat agent's instruction and its `deepResearch` tool over the app's `ResearchLaunchService`.
   */
  agent?:
    TestAgentDefinition | ((resolve: ResolveProvider) => TestAgentDefinition);
  /** The double's `Engine.sourceMode` at the start and after every `reset`; default `sources`. */
  sourceMode?: SourceMode;
  /** Composes the app with no source adapter (INT-1 A6): `SOURCE_ADAPTERS` is empty. */
  withoutSourceAdapters?: boolean;
}

/** The clock of the runtime, the delivery loop and the run marks: the system time moved by `advance`. Timers stay real. */
export interface TestClock extends Clock {
  /** Moves `now()` forward by `ms` (give-up window, launch recovery, retry pause). */
  advance(ms: number): void;
}

/** Calls of `RESEARCH_RUNTIME.investigations.cancel` and a scripted refusal of them. */
export interface CancelObserver {
  /** Every call in order, refused ones included. */
  readonly calls: readonly { investigationId: string; resourceId: string }[];
  /** Refuses the following calls with `error` (INT-1 A3 `stop_failed`, INT-3 T3); `null` lets them through. */
  refuse(error: Error | null): void;
  /**
   * Runs `hook` before each following call goes on, after it is recorded: work that cancels under the thread lock
   * (a stop, the tail selection of a regenerate) holds the lock while the hook runs (INT-2). `null` removes it.
   */
  beforeCancel(hook: (() => Promise<void>) | null): void;
}

/** Scripted failures of `THREAD_MEMORY` writes. */
export interface MemoryFaults {
  /** Calls of `saveMessages` carrying a `research-answer-*` message, failed ones included. */
  readonly answerWrites: number;
  /** Fails every write of a `research-answer-*` message with `error` (INT-2 D4, INT-3 T2); `null` heals it. */
  failAnswerWrites(error: Error | null): void;
  /** Fails the next `deleteMessages` call — the tail delete after `beforeDelete` (INT-3 T3). */
  failNextDelete(error: Error): void;
  /**
   * Holds every write of a `research-answer-*` message until `gate` settles, after it is counted: a delivery pass
   * holds the thread lock meanwhile (INT-2 M2). `null` stops holding.
   */
  holdAnswerWrites(gate: Promise<void> | null): void;
}

/** Scripted refusals of a stop (design-lifecycle.md, INT-1 S3), each healed by `null`, `reset` and `close`. */
export interface StopFaults {
  /**
   * Refuses `ThreadWriteLock.run` for `threadId` with an error, as a lock not obtained in time; the hook sits on the
   * lock's `run`, so it holds whatever implementation the lock has.
   */
  refuseThreadLock(threadId: string | null): void;
  /**
   * Refuses, at the database, every write of `state = 'stopped'` to the launch row of `launchKey`: a test trigger on
   * `app.research_chat_launches` raises an exception (not `RETURN NULL`: a skipped row would read as a lost race).
   */
  refuseStopTransition(launchKey: string | null): Promise<void>;
}

/** The thread lock held from outside the app instances; `release` frees it and closes its connection. */
export interface HeldThreadLock {
  release(): Promise<void>;
}

export interface ResearchChatApp {
  /** The instance label of {@link ResearchChatAppOptions.instance}. */
  readonly instance: string;
  /** Initialised app with `configureApp` applied: requests go to `/api/...`. */
  readonly app: INestApplication<App>;
  /** Providers of the app (e.g. `ThreadRunRegistry`, `ThreadsService`). */
  readonly moduleRef: TestingModule;
  readonly chatModel: ScriptedChatModel;
  readonly engine: EngineDouble;
  readonly cancels: CancelObserver;
  readonly memoryFaults: MemoryFaults;
  readonly stopFaults: StopFaults;
  /** Events the real `AuditInterceptor` recorded since the last reset, in order (`AuditService` is a recorder). */
  readonly auditRecords: readonly AuditEvent[];
  /** Calls of `EvidenceReader.get` since the last reset. */
  readonly evidenceReads: number;
  readonly clock: TestClock;
  /** A fresh user (`newUser()`), whose threads `close` deletes. */
  user(): string;
  /** A new empty thread of `resourceId`; returns its id. */
  createThread(resourceId: string): Promise<string>;
  /**
   * A latch released by the next `reset` or `close` at the latest (a held model step, a held start). With `threadId`
   * the latch holds a chat run of that thread: `reset` returns only once the thread has no registered run.
   */
  gate(threadId?: string): Latch;
  /**
   * Takes the thread lock of `threadId` through a `ThreadWriteLock` of its own over a connection of its own — outside
   * every app instance — and resolves once it is held. `reset` and `close` release a lock still held.
   */
  holdThreadLock(threadId: string): Promise<HeldThreadLock>;
  /**
   * Holds the next task of this instance for `threadId` before it asks for the thread lock, until `until` settles (use
   * a `gate`, which `reset` releases); resolves once a task has reached that point (INT-2 M3: a delivery pass that has
   * already read its launch and found no run mark).
   */
  holdLockEntry(threadId: string, until: Promise<void>): Promise<void>;
  /**
   * One pass of the delivery loop (`ResearchAnswerAppender.runOnce`), once the relay has delivered every pending
   * closure of the double's investigations. The timed loop runs only while the assembly checks that it starts after
   * the runtime; from then on passes happen only here.
   */
  runAppenderOnce(): Promise<void>;
  /**
   * Stops renewing the run marks of this instance, as after a crash (INT-2 M5): a mark keeps the lease of its last
   * write. Its run still ends normally and deletes its mark. `reset` and `close` renew again.
   */
  pauseMarkRenewal(): void;
  /** Back to the initial state of every double; call in `beforeEach` and `afterEach`. */
  reset(): Promise<void>;
  /** Cancels what is still running, deletes the users' threads, closes the app and restores the environment. */
  close(): Promise<void>;
}

/**
 * Waits until no closure of an investigation by the double's lifecycle consumer is pending and due at `clock`. The
 * end of a controller task is delivered to that consumer and to the part's consumer separately, in no fixed order: a
 * single pass taken between the two would find a launch waiting for its answer and its investigation still `active`.
 * Production retries that write after a pause (design-lifecycle.md, invariant 4); a test's single pass is taken after
 * the closure instead.
 */
async function closuresDelivered(clock: Clock): Promise<void> {
  // Polled on the timers of `node:timers/promises`: `vi.waitFor` would move faked timers and `Date` (INT-2 D4).
  for (let tries = SETTLE_TIMEOUT_MS / SETTLE_POLL_MS; ; tries -= 1) {
    const [row] = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app.research_event_deliveries
        WHERE consumer = $1 AND status = 'pending' AND next_attempt_at <= $2`,
      [DOUBLE_LIFECYCLE_CONSUMER, clock.now()],
    );
    const pending = row?.count ?? 0;
    if (pending === 0) return;
    if (tries <= 0) {
      throw new Error(
        `${pending} closures of the engine double still pending after ${SETTLE_TIMEOUT_MS} ms`,
      );
    }
    await delay(SETTLE_POLL_MS);
  }
}

/** Values the variables had before the first live app set them; restored when the last live app closes. */
const envBeforeApps = new Map<string, string | undefined>();
let liveApps = 0;

function assignEnv(values: Iterable<[string, string | undefined]>): void {
  for (const [name, value] of values) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * Sets `variables` in `process.env` for the app's lifetime; returns the function ending it. The environment is one per
 * process, so the values before any app are kept once and restored only when no app is live: two instances close in
 * any order without leaving one's variables behind or taking the other's away.
 */
function overrideEnv(
  variables: Record<string, string | undefined>,
): () => void {
  for (const name of Object.keys(variables)) {
    if (!envBeforeApps.has(name)) envBeforeApps.set(name, process.env[name]);
  }
  liveApps += 1;
  assignEnv(Object.entries(variables));
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    liveApps -= 1;
    if (liveApps > 0) return;
    assignEnv(envBeforeApps);
    envBeforeApps.clear();
  };
}

/**
 * The runtime shares this clock: its recovery sweeper and heartbeats compare lease expiry with `now()`, so moving it
 * while `heldController()` is true would fake a lease expiry of that attempt; `advance` refuses then.
 */
function testClock(
  heldController: () => boolean,
): TestClock & { reset(): void } {
  let offsetMs = 0;
  return {
    now: () => new Date(Date.now() + offsetMs),
    random: () => Math.random(),
    setTimer: (ms, callback) => systemClock.setTimer(ms, callback),
    advance: (ms) => {
      if (heldController()) {
        throw new Error(
          'clock.advance: a controller attempt of the engine double is held; moving the shared runtime clock now ' +
            'would expire its lease. Settle the controller (succeed, fail or cancel) before advancing the clock.',
        );
      }
      offsetMs += ms;
    },
    reset: () => {
      offsetMs = 0;
    },
  };
}

/** Wraps `cancel` of the runtime's `InvestigationService` in place; the original stays reachable for cleanup. */
function observeCancels(runtime: Runtime) {
  const { investigations } = runtime;
  const original = investigations.cancel.bind(investigations);
  const calls: { investigationId: string; resourceId: string }[] = [];
  let refusal: Error | null = null;
  let before: (() => Promise<void>) | null = null;
  investigations.cancel = async (investigationId, resourceId) => {
    calls.push({ investigationId, resourceId });
    await before?.();
    if (refusal) throw refusal;
    return original(investigationId, resourceId);
  };
  return {
    original,
    observer: {
      calls,
      refuse: (error: Error | null) => {
        refusal = error;
      },
      beforeCancel: (hook: (() => Promise<void>) | null) => {
        before = hook;
      },
    } satisfies CancelObserver,
    reset: () => {
      calls.length = 0;
      refusal = null;
      before = null;
    },
  };
}

/** Wraps `saveMessages` and `deleteMessages` of the threads' `Memory` in place. */
function injectMemoryFaults(memory: Memory) {
  const save = memory.saveMessages.bind(memory);
  const remove = memory.deleteMessages.bind(memory);
  let answerWrites = 0;
  let answerWriteError: Error | null = null;
  let deleteError: Error | null = null;
  let answerWriteGate: Promise<void> | null = null;
  memory.saveMessages = async (args) => {
    if (
      args.messages.some((message) =>
        message.id.startsWith(ANSWER_MESSAGE_PREFIX),
      )
    ) {
      answerWrites += 1;
      await answerWriteGate;
      if (answerWriteError) throw answerWriteError;
    }
    return save(args);
  };
  memory.deleteMessages = (input) => {
    const error = deleteError;
    deleteError = null;
    return error ? Promise.reject(error) : remove(input);
  };
  return {
    faults: {
      get answerWrites() {
        return answerWrites;
      },
      failAnswerWrites: (error: Error | null) => {
        answerWriteError = error;
      },
      failNextDelete: (error: Error) => {
        deleteError = error;
      },
      holdAnswerWrites: (gate: Promise<void> | null) => {
        answerWriteGate = gate;
      },
    } satisfies MemoryFaults,
    reset: () => {
      answerWrites = 0;
      answerWriteError = null;
      deleteError = null;
      answerWriteGate = null;
    },
  };
}

/**
 * Wraps `run` of the app's `ThreadWriteLock` in place: a refused thread's tasks are rejected without running; the
 * next task of a held thread enters the lock only once its gate settles.
 */
function injectLockFaults(lock: ThreadWriteLock) {
  const run = lock.run.bind(lock);
  let refused: string | null = null;
  let held: {
    threadId: string;
    until: Promise<void>;
    reached: () => void;
  } | null = null;
  lock.run = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (key === refused) {
      return Promise.reject(new Error('scripted: thread lock not obtained'));
    }
    if (held?.threadId !== key) return run(key, fn);
    const { until, reached } = held;
    held = null;
    reached();
    return until.then(() => run(key, fn));
  };
  return {
    refuse: (threadId: string | null) => {
      refused = threadId;
    },
    holdEntry: (threadId: string, until: Promise<void>): Promise<void> => {
      const entered = latch();
      held = { threadId, until, reached: () => entered.release() };
      return entered.promise;
    },
    reset: () => {
      refused = null;
      held = null;
    },
  };
}

/** Takes the thread lock through a `ThreadWriteLock` over a one-connection pool of its own; resolves once it is held. */
async function holdLockOutside(threadId: string): Promise<HeldThreadLock> {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
  });
  const held = latch();
  const gate = latch();
  const run = new ThreadWriteLock(pool).run(threadId, async () => {
    held.release();
    await gate.promise;
  });
  try {
    await Promise.race([held.promise, run]);
  } catch (error) {
    await pool.end();
    throw error;
  }
  let released: Promise<void> | undefined;
  return {
    release: () => {
      gate.release();
      released ??= run.finally(() => pool.end());
      return released;
    },
  };
}

/**
 * Sessions of the thread lock of `threadId` in Postgres (`pg_locks`), granted or waiting. The key is the one
 * `ThreadWriteLock` asks for — `THREAD_LOCK_NAMESPACE` and `hashtext(threadId)` — as `pg_locks` shows a two-key
 * advisory lock: `classid`, `objid` (the int4 as oid), `objsubid` 2.
 */
async function threadLockSessions(
  threadId: string,
  granted: boolean,
): Promise<number> {
  const [row] = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_locks
      WHERE locktype = 'advisory' AND granted = $3 AND objsubid = 2
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = $1::bigint::oid AND objid = (hashtext($2)::bigint & 4294967295)::oid`,
    [THREAD_LOCK_NAMESPACE, threadId, granted],
  );
  return row?.count ?? 0;
}

/** How many requests of either instance wait in Postgres for the thread lock of `threadId`. */
export function threadLockWaiters(threadId: string): Promise<number> {
  return threadLockSessions(threadId, false);
}

const REFUSE_STOP_FUNCTION = 'app.test_refuse_stop_transition';
const REFUSE_STOP_TRIGGER = 'test_refuse_stop_transition';

/** Whether {@link refuseStopTransition} installed its trigger since the last heal. */
let stopTransitionRefused = false;

/** Drops the trigger and function of {@link refuseStopTransition}; nothing happens when none was installed. */
async function healStopTransition(): Promise<void> {
  if (!stopTransitionRefused) return;
  stopTransitionRefused = false;
  await query(
    `DROP TRIGGER IF EXISTS ${REFUSE_STOP_TRIGGER} ON app.research_chat_launches`,
    [],
  );
  await query(`DROP FUNCTION IF EXISTS ${REFUSE_STOP_FUNCTION}()`, []);
}

/** Installs a trigger raising on every write of `state = 'stopped'` to the launch row of `launchKey`. */
async function refuseStopTransition(launchKey: string): Promise<void> {
  await healStopTransition();
  stopTransitionRefused = true;
  await query(
    `CREATE FUNCTION ${REFUSE_STOP_FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF NEW.launch_key = TG_ARGV[0] AND NEW.state = 'stopped' THEN
         RAISE EXCEPTION 'scripted: the move of launch % to stopped is refused', NEW.launch_key;
       END IF;
       RETURN NEW;
     END $$`,
    [],
  );
  // A trigger argument is a literal, not a parameter: the key is quoted as one.
  await query(
    `CREATE TRIGGER ${REFUSE_STOP_TRIGGER} BEFORE UPDATE ON app.research_chat_launches
       FOR EACH ROW EXECUTE FUNCTION ${REFUSE_STOP_FUNCTION}('${launchKey.replaceAll("'", "''")}')`,
    [],
  );
}

/** Wraps `renew` of the app's run marks in place: while paused, a renewal writes nothing. */
function injectRenewalPause(marks: ThreadRunMarks) {
  const renew = marks.renew.bind(marks);
  let paused = false;
  marks.renew = (runId, leaseExpiresAt) =>
    paused ? Promise.resolve() : renew(runId, leaseExpiresAt);
  return {
    pause: () => {
      paused = true;
    },
    reset: () => {
      paused = false;
    },
  };
}

/** The run marks of `threadId` in `app.chat_thread_runs`, of any instance, live or expired. */
export function runMarksOf(
  threadId: string,
): Promise<{ runId: string; leaseExpiresAt: Date }[]> {
  return query(
    `SELECT run_id AS "runId", lease_expires_at AS "leaseExpiresAt" FROM app.chat_thread_runs
      WHERE thread_id = $1 ORDER BY lease_expires_at`,
    [threadId],
  );
}

/** Counts `EvidenceReader.get` calls in place. */
function countEvidenceReads(runtime: Runtime) {
  const { evidence } = runtime;
  const get = evidence.get.bind(evidence);
  let reads = 0;
  evidence.get = (evidenceId, resourceId) => {
    reads += 1;
    return get(evidenceId, resourceId);
  };
  return {
    count: () => reads,
    reset: () => {
      reads = 0;
    },
  };
}

type Phase =
  'runtime.start' | 'runtime.stop' | 'appender.start' | 'appender.stop';

/**
 * Records, in place, when the runtime and the delivery loop start and stop, so the assembly checks the order of the
 * Nest hooks (design-chat-entry.md, KD-4): the loop starts after `Runtime.start` and stops before `Runtime.stop`.
 */
function recordPhases(
  runtime: Runtime,
  appender: ResearchAnswerAppender,
  instance: string,
) {
  const phases: Phase[] = [];
  const startRuntime = runtime.start.bind(runtime);
  const stopRuntime = runtime.stop.bind(runtime);
  const startAppender = appender.start.bind(appender);
  const stopAppender = appender.stop.bind(appender);
  runtime.start = () => {
    phases.push('runtime.start');
    startRuntime();
  };
  runtime.stop = () => {
    phases.push('runtime.stop');
    return stopRuntime();
  };
  appender.start = () => {
    phases.push('appender.start');
    startAppender();
  };
  appender.stop = () => {
    phases.push('appender.stop');
    return stopAppender();
  };
  return {
    /** Throws unless the phases recorded since the last check are `expected`; starts a new record. */
    expect(expected: readonly Phase[], what: string): void {
      const recorded = phases.splice(0);
      if (recorded.join() !== expected.join()) {
        throw new Error(
          `${what} of the chat-entry app ${instance} ran ${recorded.join(' → ') || 'nothing'}, expected ${expected.join(' → ')}`,
        );
      }
    },
    clear: () => {
      phases.length = 0;
    },
  };
}

/** The production chat agent's instruction and tools, as `mastraProvider` registers them; each resolves its service when it runs. */
function productionAgent(resolve: ResolveProvider): TestAgentDefinition {
  const launches = () => resolve<ResearchLaunchService>(ResearchLaunchService);
  return {
    instructions: ASSISTANT_INSTRUCTIONS,
    tools: {
      [DEEP_RESEARCH_TOOL]: createDeepResearchTool(launches),
      [STOP_RESEARCH_TOOL]: createStopResearchTool(launches),
    },
  };
}

async function compile(
  options: ResearchChatAppOptions,
  assembly: {
    chatModel: ScriptedChatModel;
    clock: TestClock;
    engine: (runtime: Runtime) => EngineDouble;
    resolve: ResolveProvider;
    audit: Pick<AuditService, 'record'>;
  },
): Promise<TestingModule> {
  const { chatModel, clock, engine, resolve, audit } = assembly;
  // A function of `resolve` lets a tool reach providers when it executes, not while MASTRA is built: this avoids the
  // DI cycle of the deepResearch tool (its service needs THREAD_MEMORY, which needs MASTRA).
  const agent =
    typeof options.agent === 'function'
      ? options.agent(resolve)
      : (options.agent ?? productionAgent(resolve));
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MASTRA)
    .useFactory({
      factory: (config: ConfigService) =>
        createTestMastra(config, {
          ...agent,
          // The turn's model follows its requestContext through the production choice (design-chat-entry.md, KD-9);
          // each model id the choice returns is a scripted model reporting that id in its call records.
          model: ({ requestContext }) =>
            chatModel.modelFor(
              turnModelId(SCRIPTED_CHAT_MODEL_ID, requestContext),
            ),
        }),
      inject: [ConfigService],
    })
    .overrideProvider(THREAD_TITLE_AGENT)
    .useValue(createThreadTitleAgent(titleModel().model))
    .overrideProvider(RUNTIME_CLOCK)
    .useValue(clock)
    .overrideProvider(AuditService)
    .useValue(audit)
    .overrideProvider(RESEARCH_ENGINE)
    .useFactory({ factory: engine, inject: [RESEARCH_RUNTIME] })
    .overrideProvider(ENGINE_GROUP_TABLES)
    .useValue(TEST_GROUP_TABLES);
  if (options.withoutSourceAdapters) {
    builder = builder.overrideProvider(SOURCE_ADAPTERS).useValue([]);
  }
  return builder.compile();
}

/**
 * Boots the app against the docker-compose Postgres (`pnpm db:up`) with the runtime's workers on. The double's
 * controller handler is registered before `app.init()` starts the workers, and the leftover fence cancels what an
 * earlier run of the file left before the first test.
 */
export async function createResearchChatApp(
  options: ResearchChatAppOptions = {},
): Promise<ResearchChatApp> {
  const instance = options.instance ?? 'app';
  const chatModel = scriptedChatModel();
  let double: EngineDouble | undefined;
  const clock = testClock(() => double?.hasRunningController() ?? false);
  let compiled: TestingModule | undefined;
  const resolve: ResolveProvider = <T>(token: InjectionToken): T => {
    if (!compiled) {
      throw new Error(`${String(token)} resolved before the module compiled`);
    }
    return compiled.get<T>(token, { strict: false });
  };
  const restoreEnv = overrideEnv({ ...RUNTIME_ENV, ...options.env });
  const auditRecords: AuditEvent[] = [];
  let moduleRef: TestingModule;
  try {
    moduleRef = await compile(options, {
      chatModel,
      clock,
      resolve,
      audit: { record: (event) => void auditRecords.push(event) },
      engine: (runtime) => {
        double = createEngineDouble(
          () => runtime,
          options.sourceMode ?? 'sources',
        );
        return double;
      },
    });
    compiled = moduleRef;
  } catch (error) {
    restoreEnv();
    throw error;
  }
  if (!double)
    throw new Error('RESEARCH_ENGINE was not resolved to the engine double');
  const engine = double;

  const runtime = moduleRef.get<Runtime>(RESEARCH_RUNTIME, { strict: false });
  moduleRef
    .get<HandlerRegistry>(HANDLER_REGISTRY, { strict: false })
    .register(engine.controllerHandler);
  runtime.eventConsumers.register(engine.lifecycleConsumer);
  const memory = moduleRef.get<Memory>(THREAD_MEMORY, { strict: false });
  const cancels = observeCancels(runtime);
  const memoryFaults = injectMemoryFaults(memory);
  const lockFaults = injectLockFaults(
    moduleRef.get(ThreadWriteLock, { strict: false }),
  );
  const evidenceReads = countEvidenceReads(runtime);
  const renewal = injectRenewalPause(
    moduleRef.get<ThreadRunMarks>(THREAD_RUN_MARKS, { strict: false }),
  );
  const appender = moduleRef.get(ResearchAnswerAppender, { strict: false });
  const phases = recordPhases(runtime, appender, instance);

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  try {
    await app.init();
    phases.expect(['runtime.start', 'appender.start'], 'start');
    // Passes are driven by `runAppenderOnce` from here on: no timed pass races a test's steps.
    await appender.stop();
    await cancelLeftovers({ cancel: cancels.original });
  } catch (error) {
    await app.close();
    restoreEnv();
    throw error;
  }

  const owners = new Set<string>();
  const gates: Latch[] = [];
  const heldLocks = new Set<HeldThreadLock>();
  const releaseHeldLocks = async () => {
    const held = [...heldLocks];
    heldLocks.clear();
    await Promise.all(held.map((lock) => lock.release()));
  };
  const heldThreads = new Set<string>();
  const runs = moduleRef.get(ThreadRunRegistry, { strict: false });
  /** Releases every gate and waits until the chat runs they held have ended (their threads have no run). */
  const releaseGates = async () => {
    for (const open of gates.splice(0)) open.release();
    const threadIds = [...heldThreads];
    heldThreads.clear();
    if (threadIds.length === 0) return;
    await vi.waitFor(
      async () => {
        const marked = await Promise.all(
          threadIds.map((threadId) => runs.hasRuns(threadId)),
        );
        const running = threadIds.filter((_threadId, i) => marked[i]);
        if (running.length > 0) {
          throw new Error(`chat runs still registered: ${running.join(', ')}`);
        }
      },
      { timeout: SETTLE_TIMEOUT_MS, interval: SETTLE_POLL_MS },
    );
  };
  /**
   * Cancels the investigations whose controller is still held and waits until those controller tasks have ended
   * (rule 9 b): the next test never meets a running controller of this one.
   */
  const cancelUnsettled = async () => {
    const unsettled = engine.takeUnsettled();
    for (const start of unsettled) {
      await cancels.original(start.investigationId, start.input.resourceId);
    }
    if (unsettled.length === 0) return;
    const taskIds = unsettled.map((start) => start.controllerTaskId);
    await vi.waitFor(
      async () => {
        const count = await unfinishedTaskCount(taskIds);
        if (count > 0)
          throw new Error(`${count} cancelled controllers still run`);
      },
      { timeout: SETTLE_TIMEOUT_MS, interval: SETTLE_POLL_MS },
    );
  };

  return {
    instance,
    app,
    moduleRef,
    chatModel,
    engine,
    cancels: cancels.observer,
    memoryFaults: memoryFaults.faults,
    stopFaults: {
      refuseThreadLock: lockFaults.refuse,
      refuseStopTransition: (launchKey) =>
        launchKey === null
          ? healStopTransition()
          : refuseStopTransition(launchKey),
    },
    auditRecords,
    get evidenceReads() {
      return evidenceReads.count();
    },
    clock,
    user: () => {
      const resourceId = newUser();
      owners.add(resourceId);
      return resourceId;
    },
    createThread: async (resourceId) => {
      owners.add(resourceId);
      const { ids } = await seed(memory, {
        resourceId,
        threads: [{ updatedAt: new Date() }],
      });
      const threadId = ids.get(1);
      if (!threadId) throw new Error('seed created no thread');
      return threadId;
    },
    gate: (threadId) => {
      const gate = latch();
      gates.push(gate);
      if (threadId !== undefined) heldThreads.add(threadId);
      return gate;
    },
    holdLockEntry: lockFaults.holdEntry,
    holdThreadLock: async (threadId) => {
      const held = await holdLockOutside(threadId);
      heldLocks.add(held);
      return held;
    },
    runAppenderOnce: async () => {
      await closuresDelivered(clock);
      await appender.runOnce();
    },
    pauseMarkRenewal: renewal.pause,
    reset: async () => {
      await healStopTransition();
      vi.useRealTimers();
      renewal.reset();
      await releaseHeldLocks();
      await releaseGates();
      // Held starts land first, so `takeUnsettled` below sees their investigations.
      await engine.reset();
      chatModel.reset();
      cancels.reset();
      memoryFaults.reset();
      lockFaults.reset();
      auditRecords.length = 0;
      evidenceReads.reset();
      clock.reset();
      await cancelUnsettled();
    },
    close: async () => {
      try {
        await healStopTransition();
        vi.useRealTimers();
        await releaseHeldLocks();
        await releaseGates();
        await engine.reset();
        cancels.reset();
        memoryFaults.reset();
        lockFaults.reset();
        renewal.reset();
        clock.reset();
        await cancelUnsettled();
        await deleteThreadsOf(moduleRef, memory, owners);
      } finally {
        try {
          phases.clear();
          await app.close();
          phases.expect(['appender.stop', 'runtime.stop'], 'shutdown');
        } finally {
          restoreEnv();
        }
      }
    },
  };
}

/** Deletes every thread of the users through `ThreadsService.delete`, so the deletion hooks clean up after them. */
async function deleteThreadsOf(
  moduleRef: TestingModule,
  memory: Memory,
  owners: Iterable<string>,
): Promise<void> {
  const threads = moduleRef.get(ThreadsService, { strict: false });
  for (const resourceId of owners) {
    const { threads: owned } = await memory.listThreads({
      filter: { resourceId },
      perPage: false,
    });
    for (const thread of owned) await threads.delete(thread.id, resourceId);
  }
}
