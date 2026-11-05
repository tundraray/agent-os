import type { AddressInfo } from 'node:net';
import type { INestApplication, InjectionToken } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { DatabaseConnection } from '@agent-os/db';
import type { HandlerRegistry, Runtime } from '@agent-os/runtime';
import type { Mastra } from '@mastra/core/mastra';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { RESEARCH_ENGINE } from '../../src/engine/engine.tokens.js';
import {
  ASSISTANT_INSTRUCTIONS,
  turnModelId,
} from '../../src/mastra/agents/assistant.agent.js';
import { MASTRA } from '../../src/mastra/mastra.constants.js';
import { MastraLifecycle } from '../../src/mastra/mastra.lifecycle.js';
import { createDeepResearchTool } from '../../src/research-chat/deep-research.tool.js';
import { ResearchLaunchService } from '../../src/research-chat/research-launch.service.js';
import {
  HANDLER_REGISTRY,
  RESEARCH_DATABASE,
  RESEARCH_RUNTIME,
} from '../../src/research/research.tokens.js';
import { SOURCE_ADAPTERS } from '../../src/sources/sources.module.js';
import {
  resolveThreadMemory,
  THREAD_MEMORY,
} from '../../src/threads/thread-memory.provider.js';
import {
  createThreadTitleAgent,
  THREAD_TITLE_AGENT,
} from '../../src/threads/thread-title.agent.js';
import {
  type ChildEngine,
  crashAfterAnswerSave,
  crashPoint,
  createChildEngine,
  type HarnessMessage,
  type ReadyMessage,
} from './chatEntryDoubles.js';
import { createTestMastra } from './createTestApp.js';
import {
  DEEP_RESEARCH_TOOL,
  deepResearchCallStep,
  SCRIPTED_CHAT_MODEL_ID,
  scriptedChatModel,
  titleModel,
} from './mockModels.js';

/**
 * Entry of the chat-entry child process (E2E-1), run only compiled (`pnpm --filter api build:child` →
 * `dist/test-child/`); `dist/main.js` and `src/` never import it. It boots the real `AppModule` the way `main.ts` does
 * (listen, then the Mastra workers) with the doubled boundaries only, selected by `E2E_CHAT_ENTRY_DOUBLES=1`: the
 * scripted chat model with one `deepResearch` call, the engine port over the real runtime whose controller task the
 * harness releases over IPC, no source adapter, and the threads' `Memory` wrapped for the append crash point. It reads
 * only its environment: `DATABASE_URL` (its own scratch database), the Runtime Settings, the part's settings and
 * `CHAT_ENTRY_CRASH_AT` (the crash points of `chatEntryDoubles.ts`).
 *
 * IPC: `ready` with the port once the api accepts requests; `release` lets an investigation's controller succeed;
 * `stop` closes the app and exits 0.
 */

/** The research mode turn's goal and budget, as the scripted model calls the tool. */
const RESEARCH_GOAL = 'Почему падали платежи после релиза?';
const RESEARCH_TOKEN_BUDGET = 400_000;

function send(message: ReadyMessage): void {
  if (!process.send) throw new Error('The child process has no IPC channel');
  process.send(message);
}

async function main(): Promise<INestApplication> {
  if (process.env.E2E_CHAT_ENTRY_DOUBLES !== '1') {
    throw new Error(
      'The chat-entry child runs only with its doubles: set E2E_CHAT_ENTRY_DOUBLES=1',
    );
  }
  const hit = crashPoint(process.env.CHAT_ENTRY_CRASH_AT, process.env.NODE_ENV);
  const chatModel = scriptedChatModel();
  chatModel.script(
    deepResearchCallStep({
      goal: RESEARCH_GOAL,
      tokenBudget: RESEARCH_TOKEN_BUDGET,
    }).step,
  );
  let engine: ChildEngine | undefined;
  let resolveLaunches: (() => ResearchLaunchService) | undefined;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MASTRA)
    .useFactory({
      factory: (config: ConfigService) =>
        createTestMastra(config, {
          instructions: ASSISTANT_INSTRUCTIONS,
          // The tool resolves its service when it runs: the service needs THREAD_MEMORY, which needs MASTRA.
          tools: {
            [DEEP_RESEARCH_TOOL]: createDeepResearchTool(() => {
              if (!resolveLaunches) {
                throw new Error('deepResearch ran before the module compiled');
              }
              return resolveLaunches();
            }),
          },
          model: ({ requestContext }) =>
            chatModel.modelFor(
              turnModelId(SCRIPTED_CHAT_MODEL_ID, requestContext),
            ),
        }),
      inject: [ConfigService],
    })
    .overrideProvider(THREAD_TITLE_AGENT)
    .useValue(createThreadTitleAgent(titleModel().model))
    .overrideProvider(THREAD_MEMORY)
    .useFactory({
      factory: async (mastra: Mastra) =>
        crashAfterAnswerSave(await resolveThreadMemory(mastra), hit),
      inject: [MASTRA],
    })
    .overrideProvider(SOURCE_ADAPTERS)
    .useValue([])
    .overrideProvider(RESEARCH_ENGINE)
    .useFactory({
      factory: (runtime: Runtime, database: DatabaseConnection) => {
        engine = createChildEngine({ runtime, pool: database.pool, hit });
        return engine;
      },
      inject: [RESEARCH_RUNTIME, RESEARCH_DATABASE],
    })
    .compile();
  const get = <T>(token: InjectionToken): T =>
    moduleRef.get<T>(token, { strict: false });
  resolveLaunches = () => get<ResearchLaunchService>(ResearchLaunchService);
  if (!engine)
    throw new Error('RESEARCH_ENGINE was not resolved to the double');
  const controller = engine;
  // Before `listen` starts the workers, so the first claim of a controller task finds its handler.
  get<HandlerRegistry>(HANDLER_REGISTRY).register(controller.controllerHandler);
  process.on('message', (message: HarnessMessage) => {
    if (message.kind === 'release') controller.release(message.investigationId);
  });

  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  await app.get(MastraLifecycle).start();
  const { port } = app.getHttpServer().address() as AddressInfo;
  send({ kind: 'ready', port });
  return app;
}

const ready = main();
process.on('message', (message: HarnessMessage) => {
  if (message.kind !== 'stop') return;
  ready
    .then((app) => app.close())
    .then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Closing the chat-entry child failed', error);
        process.exit(1);
      },
    );
});
ready.catch((error: unknown) => {
  console.error('Chat-entry child failed', error);
  process.exit(1);
});
