import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Agent, type ToolsInput } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import type { RequestContext } from '@mastra/core/request-context';
import { createTool } from '@mastra/core/tools';
import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';
import type { MockLanguageModelV4 } from 'ai/test';
import type { App } from 'supertest/types.js';
import { z } from 'zod';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { ENGINE_GROUP_TABLES } from '../../src/engine/engine.tokens.js';
import { MASTRA } from '../../src/mastra/mastra.constants.js';
import {
  createThreadTitleAgent,
  THREAD_TITLE_AGENT,
} from '../../src/threads/thread-title.agent.js';
import {
  assistantModel as scriptedAssistantModel,
  FAILING_TOOL,
  titleModel as defaultTitleModel,
  type TitleModel,
  WEATHER_TOOL,
} from './mockModels.js';
import { TEST_GROUP_TABLES } from './testGroupTables.js';

export interface TestAppOptions {
  /** Mock model of the `assistant` agent; default — one with no scripted responses. */
  assistantModel?: MockLanguageModelV4;
  /** Mock model of the title agent; default — one answering `'Тестовый заголовок'`. */
  titleModel?: TitleModel;
}

export interface TestApp {
  /** Initialised app with `configureApp` applied: requests go to `/api/...`. */
  app: INestApplication<App>;
  mastra: Mastra;
  /** The `assistant` agent's memory (shared `PostgresStore`), for `seed` / `cleanupUsers`. */
  memory: Memory;
  /** The title agent's mock model (calls, scenario switch). */
  titleModel: TitleModel;
}

const getWeather = createTool({
  id: WEATHER_TOOL,
  description: 'Returns the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) =>
    Promise.resolve({ city, temperatureC: 21, conditions: 'sunny' }),
});

const failing = createTool({
  id: FAILING_TOOL,
  description: 'Always fails.',
  inputSchema: z.object({}),
  execute: () => Promise.reject(new Error('boom')),
});

/** The test `assistant` agent: its mock model, and the instruction and tools that replace the defaults. */
export interface TestAgentOptions {
  /** A mock model, or a function of the turn's `requestContext` picking one (an agent whose model follows the turn). */
  model:
    | MockLanguageModelV4
    | ((turn: { requestContext: RequestContext }) => MockLanguageModelV4);
  /** Default `'You are a test assistant.'`. */
  instructions?: string;
  /** Default: `getWeather` and `failing`. */
  tools?: ToolsInput;
}

/**
 * `Mastra` with the test `assistant` agent on a mock model and the shared `PostgresStore` — the `MASTRA` of every
 * e2e app that runs chat turns.
 */
export function createTestMastra(
  config: ConfigService,
  agent: TestAgentOptions,
): Mastra {
  return new Mastra({
    agents: {
      assistant: new Agent({
        id: 'assistant',
        name: 'Assistant',
        instructions: agent.instructions ?? 'You are a test assistant.',
        model: agent.model,
        // Storage is inherited from the Mastra instance, as in production.
        memory: new Memory({ options: { lastMessages: 20 } }),
        tools: agent.tools ?? {
          [WEATHER_TOOL]: getWeather,
          [FAILING_TOOL]: failing,
        },
      }),
    },
    storage: new PostgresStore({
      id: 'agent-os-e2e',
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
    }),
  });
}

/**
 * Boots the real `AppModule` against the docker-compose Postgres (`pnpm db:up`)
 * with `MASTRA` replaced by a test instance whose `assistant` agent runs on a
 * `MockLanguageModelV4` — no network, no provider keys. `THREAD_TITLE_AGENT` is
 * always replaced too — the production factory on the mock title model — so no reply ever
 * triggers a network title model.
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestApp> {
  const model = options.assistantModel ?? scriptedAssistantModel();
  const title = options.titleModel ?? defaultTitleModel();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MASTRA)
    .useFactory({
      factory: (config: ConfigService) => createTestMastra(config, { model }),
      inject: [ConfigService],
    })
    .overrideProvider(THREAD_TITLE_AGENT)
    .useValue(createThreadTitleAgent(title.model))
    .overrideProvider(ENGINE_GROUP_TABLES)
    .useValue(TEST_GROUP_TABLES)
    .compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  const mastra = moduleRef.get<Mastra>(MASTRA);
  return {
    app,
    mastra,
    memory: await assistantMemory(mastra),
    titleModel: title,
  };
}

/** The agent's memory once Mastra has injected its storage (fails fast otherwise). */
async function assistantMemory(mastra: Mastra): Promise<Memory> {
  const memory = await mastra.getAgent('assistant').getMemory();
  if (!(memory instanceof Memory)) {
    throw new Error('Test assistant agent has no @mastra/memory Memory');
  }
  return memory;
}
