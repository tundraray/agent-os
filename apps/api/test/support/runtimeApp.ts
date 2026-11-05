import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import type {
  EvidenceReader,
  HandlerRegistry,
  InvestigationService,
  Runtime,
  RuntimeConfig,
  TaskHandler,
  TaskScheduler,
} from '@agent-os/runtime';
import { AppModule } from '../../src/app.module.js';
import { MASTRA } from '../../src/mastra/mastra.constants.js';
import {
  HANDLER_REGISTRY,
  RESEARCH_RUNTIME,
} from '../../src/research/research.tokens.js';
import {
  createThreadTitleAgent,
  THREAD_TITLE_AGENT,
} from '../../src/threads/thread-title.agent.js';
import { assistantModel, titleModel } from './mockModels.js';
import { cleanupUsers, seed } from './seed.js';

export interface RuntimeAppOptions {
  /** Test handlers, registered before the workers start. */
  handlers: readonly TaskHandler[];
  /** Runtime Settings over the test defaults (workers on, 2 slots, 50 ms poll, pool of 4). */
  runtime?: Partial<RuntimeConfig>;
  /** Providers replaced by a value, e.g. the engine's model and token counter doubles. */
  overrides?: readonly ProviderOverride[];
}

/** A provider of `AppModule` and the value that replaces it. */
export interface ProviderOverride {
  token: symbol;
  value: unknown;
}

export interface RuntimeApp {
  app: INestApplication;
  investigations: InvestigationService;
  scheduler: TaskScheduler;
  evidence: EvidenceReader;
  /** A new thread of `resourceId` (removed again by `close`); returns its id. */
  createThread(resourceId: string): Promise<string>;
  /**
   * Removes the created threads, then closes the app (workers and pool) — the app is closed even
   * when the cleanup fails.
   */
  close(): Promise<void>;
}

/** Variable of Runtime Settings behind each `RuntimeConfig` field (design-runtime.md). */
const SETTING_VARIABLES: Record<keyof RuntimeConfig, string> = {
  workers: 'RUNTIME_WORKERS',
  concurrency: 'RUNTIME_CONCURRENCY',
  pollMs: 'RUNTIME_POLL_MS',
  notify: 'RUNTIME_NOTIFY',
  leaseMs: 'RUNTIME_LEASE_MS',
  heartbeatMs: 'RUNTIME_HEARTBEAT_MS',
  reaperMs: 'RUNTIME_REAPER_MS',
  maxRecoveries: 'RUNTIME_MAX_RECOVERIES',
  deliveryMaxAttempts: 'RUNTIME_DELIVERY_MAX_ATTEMPTS',
  shutdownGraceMs: 'RUNTIME_SHUTDOWN_GRACE_MS',
  dbPoolMax: 'DB_POOL_MAX',
  crashAt: 'RUNTIME_CRASH_AT',
  nodeEnv: 'NODE_ENV',
};

/** The settings as the variables `ResearchModule` reads; `undefined` leaves a variable unset. */
function settingVariables(
  settings: Partial<RuntimeConfig>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(settings).map(([field, value]) => [
      SETTING_VARIABLES[field as keyof RuntimeConfig],
      typeof value === 'boolean' ? (value ? 'on' : 'off') : value?.toString(),
    ]),
  );
}

/**
 * Sets `variables` in `process.env` and returns the function restoring the previous values.
 */
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
 * The real `AppModule` against the docker-compose Postgres with the runtime's workers on,
 * whatever the environment says (the e2e harness defaults to `RUNTIME_WORKERS=off`): the test
 * settings are the variables `ResearchModule` reads, set in `process.env` while the module
 * compiles — the only time they are read — and restored right after. Test handlers are
 * registered through `HANDLER_REGISTRY` before `app.init()` starts the workers. `MASTRA` carries
 * only the `assistant` agent's Memory (threads for `InvestigationService.create`) on a mock
 * model — no network.
 */
export async function createRuntimeApp(
  options: RuntimeAppOptions,
): Promise<RuntimeApp> {
  const restoreEnv = overrideEnv(
    settingVariables({
      workers: true,
      concurrency: 2,
      pollMs: 50,
      dbPoolMax: 4,
      ...options.runtime,
    }),
  );
  let moduleRef: TestingModule;
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MASTRA)
      .useFactory({ factory: createRuntimeMastra, inject: [ConfigService] })
      .overrideProvider(THREAD_TITLE_AGENT)
      .useValue(createThreadTitleAgent(titleModel().model));
    for (const { token, value } of options.overrides ?? []) {
      builder = builder.overrideProvider(token).useValue(value);
    }
    moduleRef = await builder.compile();
  } finally {
    restoreEnv();
  }

  const registry = moduleRef.get<HandlerRegistry>(HANDLER_REGISTRY);
  for (const handler of options.handlers) registry.register(handler);
  const runtime = moduleRef.get<Runtime>(RESEARCH_RUNTIME);

  const app = moduleRef.createNestApplication();
  await app.init();
  let memory: Memory;
  try {
    memory = await threadMemory(moduleRef.get<Mastra>(MASTRA));
  } catch (error) {
    await app.close();
    throw error;
  }
  const owners = new Set<string>();
  return {
    app,
    investigations: runtime.investigations,
    scheduler: runtime.scheduler,
    evidence: runtime.evidence,
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
    close: async () => {
      try {
        await cleanupUsers(memory, owners);
      } finally {
        await app.close();
      }
    },
  };
}

function createRuntimeMastra(config: ConfigService): Mastra {
  return new Mastra({
    agents: {
      assistant: new Agent({
        id: 'assistant',
        name: 'Assistant',
        instructions: 'You are a test assistant.',
        model: assistantModel(),
        memory: new Memory({ options: { lastMessages: 20 } }),
      }),
    },
    storage: new PostgresStore({
      id: 'agent-os-e2e-runtime',
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
    }),
  });
}

/** The agent's memory once Mastra has injected its storage (fails fast otherwise). */
async function threadMemory(mastra: Mastra): Promise<Memory> {
  const memory = await mastra.getAgent('assistant').getMemory();
  if (!(memory instanceof Memory)) {
    throw new Error(
      'Runtime test assistant agent has no @mastra/memory Memory',
    );
  }
  return memory;
}
