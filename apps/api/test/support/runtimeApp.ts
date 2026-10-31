import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import { AppModule } from '../../src/app.module.js';
import {
  loadRuntimeConfig,
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../../src/database/runtime-config.js';
import { MASTRA } from '../../src/mastra/mastra.constants.js';
import { EvidenceReader } from '../../src/research/evidence.reader.js';
import {
  HandlerRegistry,
  type TaskHandler,
} from '../../src/research/handler.registry.js';
import { InvestigationService } from '../../src/research/investigation.service.js';
import { TaskScheduler } from '../../src/research/task-scheduler.js';
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

/**
 * The real `AppModule` against the docker-compose Postgres with the runtime's workers on,
 * whatever the environment says (the e2e harness defaults to `RUNTIME_WORKERS=off`): the parsed
 * `RuntimeConfig` is replaced, not the variable. `MASTRA` carries only the `assistant` agent's
 * Memory (threads for `InvestigationService.create`) on a mock model — no network.
 */
export async function createRuntimeApp(
  options: RuntimeAppOptions,
): Promise<RuntimeApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(RUNTIME_CONFIG)
    .useFactory({
      factory: (config: ConfigService): RuntimeConfig => ({
        ...loadRuntimeConfig(config),
        workers: true,
        concurrency: 2,
        pollMs: 50,
        dbPoolMax: 4,
        ...options.runtime,
      }),
      inject: [ConfigService],
    })
    .overrideProvider(MASTRA)
    .useFactory({ factory: createRuntimeMastra, inject: [ConfigService] })
    .overrideProvider(THREAD_TITLE_AGENT)
    .useValue(createThreadTitleAgent(titleModel().model))
    .compile();

  const registry = moduleRef.get(HandlerRegistry);
  for (const handler of options.handlers) registry.register(handler);

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
    investigations: moduleRef.get(InvestigationService),
    scheduler: moduleRef.get(TaskScheduler),
    evidence: moduleRef.get(EvidenceReader),
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
