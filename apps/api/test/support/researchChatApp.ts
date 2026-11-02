import type { INestApplication, InjectionToken } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import type { ToolsInput } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
import type { SourceMode } from '@agent-os/engine';
import {
  type Clock,
  type HandlerRegistry,
  type Runtime,
  systemClock,
} from '@agent-os/runtime';
import type { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { RESEARCH_ENGINE } from '../../src/engine/engine.tokens.js';
import {
  ASSISTANT_INSTRUCTIONS,
  turnModelId,
} from '../../src/mastra/agents/assistant.agent.js';
import { MASTRA } from '../../src/mastra/mastra.constants.js';
import { createDeepResearchTool } from '../../src/research-chat/deep-research.tool.js';
import { ResearchLaunchService } from '../../src/research-chat/research-launch.service.js';
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
import { ThreadRunRegistry } from '../../src/threads/thread-run-registry.js';
import { ThreadsService } from '../../src/threads/threads.service.js';
import { createTestMastra } from './createTestApp.js';
import { createEngineDouble, type EngineDouble } from './engineDouble.js';
import {
  DEEP_RESEARCH_TOOL,
  SCRIPTED_CHAT_MODEL_ID,
  type ScriptedChatModel,
  scriptedChatModel,
  titleModel,
} from './mockModels.js';
import { cancelLeftovers, unfinishedTaskCount } from './researchChatDb.js';
import { newUser, seed } from './seed.js';
import { type Latch, latch } from './wiring-handlers.js';

/**
 * The in-process app of the chat-entry integration file (design-chat-entry.md, Test Strategy): the real `AppModule`
 * — `ChatController`, `ThreadsService` with its lock, `ThreadRunRegistry`, Mastra Memory over Postgres, the real
 * runtime with its workers on, and the part's `ResearchChatModule` — with the doubled
 * boundaries only: the scripted chat model and the engine port (`RESEARCH_ENGINE`). Around the real pieces it puts
 * observers and scripted faults: calls of `investigations.cancel`, failed writes of answer messages and of the tail
 * delete, reads of `EvidenceReader.get`, and the clock of the runtime and the delivery loop.
 *
 * Isolation (plan rule 9): one app per file (`afterAll` → `close`); `reset` in `beforeEach` and `afterEach` returns
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

/** The clock of the runtime and the delivery loop: the system time moved by `advance`. Timers stay real. */
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
}

/** Scripted failures of `THREAD_MEMORY` writes. */
export interface MemoryFaults {
  /** Calls of `saveMessages` carrying a `research-answer-*` message, failed ones included. */
  readonly answerWrites: number;
  /** Fails every write of a `research-answer-*` message with `error` (INT-2 D4, INT-3 T2); `null` heals it. */
  failAnswerWrites(error: Error | null): void;
  /** Fails the next `deleteMessages` call — the tail delete after `beforeDelete` (INT-3 T3). */
  failNextDelete(error: Error): void;
}

export interface ResearchChatApp {
  /** Initialised app with `configureApp` applied: requests go to `/api/...`. */
  readonly app: INestApplication<App>;
  /** Providers of the app (e.g. `ThreadRunRegistry`, `ThreadsService`). */
  readonly moduleRef: TestingModule;
  readonly chatModel: ScriptedChatModel;
  readonly engine: EngineDouble;
  readonly cancels: CancelObserver;
  readonly memoryFaults: MemoryFaults;
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
  /** One pass of the delivery loop (`ResearchAnswerAppender`). */
  runAppenderOnce(): Promise<void>;
  /** Back to the initial state of every double; call in `beforeEach` and `afterEach`. */
  reset(): Promise<void>;
  /** Cancels what is still running, deletes the users' threads, closes the app and restores the environment. */
  close(): Promise<void>;
}

/** Sets `variables` in `process.env`; returns the function restoring the previous values. */
function overrideEnv(
  variables: Record<string, string | undefined>,
): () => void {
  const previous = Object.fromEntries(
    Object.keys(variables).map((name) => [name, process.env[name]]),
  );
  const assign = (values: Record<string, string | undefined>) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(variables);
  return () => assign(previous);
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
  investigations.cancel = (investigationId, resourceId) => {
    calls.push({ investigationId, resourceId });
    return refusal
      ? Promise.reject(refusal)
      : original(investigationId, resourceId);
  };
  return {
    original,
    observer: {
      calls,
      refuse: (error: Error | null) => {
        refusal = error;
      },
    } satisfies CancelObserver,
    reset: () => {
      calls.length = 0;
      refusal = null;
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
  memory.saveMessages = (args) => {
    if (
      args.messages.some((message) =>
        message.id.startsWith(ANSWER_MESSAGE_PREFIX),
      )
    ) {
      answerWrites += 1;
      if (answerWriteError) return Promise.reject(answerWriteError);
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
    } satisfies MemoryFaults,
    reset: () => {
      answerWrites = 0;
      answerWriteError = null;
      deleteError = null;
    },
  };
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

/** The production chat agent's instruction and `deepResearch` tool; the tool resolves its service when it runs. */
function productionAgent(resolve: ResolveProvider): TestAgentDefinition {
  return {
    instructions: ASSISTANT_INSTRUCTIONS,
    tools: {
      [DEEP_RESEARCH_TOOL]: createDeepResearchTool(() =>
        resolve<ResearchLaunchService>(ResearchLaunchService),
      ),
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
  },
): Promise<TestingModule> {
  const { chatModel, clock, engine, resolve } = assembly;
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
    .overrideProvider(RESEARCH_ENGINE)
    .useFactory({ factory: engine, inject: [RESEARCH_RUNTIME] });
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
  let moduleRef: TestingModule;
  try {
    moduleRef = await compile(options, {
      chatModel,
      clock,
      resolve,
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
  const memory = moduleRef.get<Memory>(THREAD_MEMORY, { strict: false });
  const cancels = observeCancels(runtime);
  const memoryFaults = injectMemoryFaults(memory);
  const evidenceReads = countEvidenceReads(runtime);

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  try {
    await app.init();
    await cancelLeftovers({ cancel: cancels.original });
  } catch (error) {
    await app.close();
    restoreEnv();
    throw error;
  }

  const owners = new Set<string>();
  const gates: Latch[] = [];
  const heldThreads = new Set<string>();
  const runs = moduleRef.get(ThreadRunRegistry, { strict: false });
  /** Releases every gate and waits until the chat runs they held have ended (their threads have no run). */
  const releaseGates = async () => {
    for (const open of gates.splice(0)) open.release();
    const threadIds = [...heldThreads];
    heldThreads.clear();
    if (threadIds.length === 0) return;
    await vi.waitFor(
      () => {
        const running = threadIds.filter((threadId) => runs.hasRuns(threadId));
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
    app,
    moduleRef,
    chatModel,
    engine,
    cancels: cancels.observer,
    memoryFaults: memoryFaults.faults,
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
    runAppenderOnce: () =>
      Promise.reject(
        new Error(
          'runAppenderOnce: the delivery loop (ResearchAnswerAppender) does not exist yet — task-12 wires it here',
        ),
      ),
    reset: async () => {
      vi.useRealTimers();
      await releaseGates();
      // Held starts land first, so `takeUnsettled` below sees their investigations.
      await engine.reset();
      chatModel.reset();
      cancels.reset();
      memoryFaults.reset();
      evidenceReads.reset();
      clock.reset();
      await cancelUnsettled();
    },
    close: async () => {
      try {
        vi.useRealTimers();
        await releaseGates();
        await engine.reset();
        cancels.reset();
        memoryFaults.reset();
        clock.reset();
        await cancelUnsettled();
        await deleteThreadsOf(moduleRef, memory, owners);
      } finally {
        try {
          await app.close();
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
