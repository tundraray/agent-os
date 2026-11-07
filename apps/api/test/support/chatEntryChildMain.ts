import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { INestApplication, InjectionToken } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { DatabaseConnection } from '@agent-os/db';
import type { HandlerRegistry, Runtime } from '@agent-os/runtime';
import type { Mastra } from '@mastra/core/mastra';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import {
  ENGINE_GROUP_TABLES,
  ENGINE_PROCESSES,
  ENGINE_RESOLVE_MODEL,
  ENGINE_TOKEN_COUNTER,
  RESEARCH_ENGINE,
} from '../../src/engine/engine.tokens.js';
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
  type ChatCallsMessage,
  type ChatCallsRequest,
  createEngineScriptedRoles,
  ENGINE_FILES_VARIABLES,
  ENGINE_JOURNEY,
  type StartFailedMessage,
} from './engineScriptedRoles.js';
import {
  DEEP_RESEARCH_TOOL,
  deepResearchCallStep,
  SCRIPTED_CHAT_MODEL_ID,
  type ScriptedChatModel,
  scriptedChatModel,
  textStep,
  titleModel,
} from './mockModels.js';
import { TEST_GROUP_TABLES } from './testGroupTables.js';

/**
 * Entry of the chat-entry child process, run only compiled (`pnpm --filter api build:child` → `dist/test-child/`);
 * `dist/main.js` and `src/` never import it. It boots the real `AppModule` the way `main.ts` does (listen, then the
 * Mastra workers) with the scripted chat model and the test group table, in one of two modes:
 *
 * - `E2E_CHAT_ENTRY_DOUBLES=1` (deep-research / chat-entry E2E-1): one `deepResearch` call, the engine port over the
 *   real runtime whose controller task the harness releases over IPC, no source adapter, and the threads' `Memory`
 *   wrapped for the append crash point of `CHAT_ENTRY_CRASH_AT` (the crash points of `chatEntryDoubles.ts`);
 * - `E2E_ENGINE_SCRIPTED_ROLES=1` (agent-quality / engine E2E-1): the real engine and the real fixture source; only
 *   `ENGINE_RESOLVE_MODEL` and `ENGINE_TOKEN_COUNTER` are the scripted roles of `engineScriptedRoles.ts`. The chat model
 *   makes the `deepResearch` call, then answers the plain turns of {@link ENGINE_JOURNEY}. With the variables of
 *   `ENGINE_FILES_VARIABLES` (agent-quality / engine E2E-2) `ENGINE_PROCESSES` holds only the configuration of that
 *   file and `ENGINE_GROUP_TABLES` the tables `calibrate` wrote into that directory, read as they are on disk, so the
 *   start check (`requireCalibration`, DC-2) runs on them.
 *
 * It reads only its environment: `DATABASE_URL` (its own scratch database), the Runtime Settings, the part's settings,
 * the mode, the engine files and `CHAT_ENTRY_CRASH_AT`.
 *
 * IPC: `ready` with the port once the api accepts requests; `release` lets an investigation's controller succeed (the
 * engine double) or the held synthesis call answer (the scripted roles); `chatCalls` sends back the input of every
 * chat model call; `stop` closes the app and exits 0. A failed start sends `startFailed` with the error's code and
 * message, then exits 1.
 */

/** The research mode turn's goal and budget, as the scripted model calls the tool in the doubles mode. */
const RESEARCH_GOAL = 'Почему падали платежи после релиза?';
const RESEARCH_TOKEN_BUDGET = 400_000;

type ChildMode = 'engine-double' | 'scripted-roles';

/** IPC of the harness to the child, in either mode. */
type ChildRequest = HarnessMessage | ChatCallsRequest;

function send(message: ReadyMessage | ChatCallsMessage): void {
  if (!process.send) throw new Error('The child process has no IPC channel');
  process.send(message);
}

function modeOf(env: NodeJS.ProcessEnv): ChildMode {
  const doubles = env.E2E_CHAT_ENTRY_DOUBLES === '1';
  const roles = env.E2E_ENGINE_SCRIPTED_ROLES === '1';
  if (doubles === roles) {
    throw new Error(
      'The chat-entry child runs in exactly one mode: set E2E_CHAT_ENTRY_DOUBLES=1 (engine double) or ' +
        'E2E_ENGINE_SCRIPTED_ROLES=1 (real engine, scripted roles)',
    );
  }
  return doubles ? 'engine-double' : 'scripted-roles';
}

/**
 * The engine's process configurations and group tables: the files of {@link ENGINE_FILES_VARIABLES} when both are set
 * (in the scripted-roles mode only), otherwise the shipped configuration and the test table.
 */
function engineFilesOf(
  env: NodeJS.ProcessEnv,
  mode: ChildMode,
): { processes: unknown[]; groupTables: unknown[] } | null {
  const processFile = env[ENGINE_FILES_VARIABLES.processFile] ?? '';
  const groupTablesDir = env[ENGINE_FILES_VARIABLES.groupTablesDir] ?? '';
  if (processFile === '' && groupTablesDir === '') return null;
  if (
    processFile === '' ||
    groupTablesDir === '' ||
    mode !== 'scripted-roles'
  ) {
    throw new Error(
      `The chat-entry child loads engine files only in the scripted-roles mode and with both ` +
        `${ENGINE_FILES_VARIABLES.processFile} and ${ENGINE_FILES_VARIABLES.groupTablesDir}`,
    );
  }
  const readJson = (file: string): unknown =>
    JSON.parse(readFileSync(file, 'utf8')) as unknown;
  return {
    processes: [readJson(processFile)],
    groupTables: readdirSync(groupTablesDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => readJson(join(groupTablesDir, name))),
  };
}

function scriptChat(chatModel: ScriptedChatModel, mode: ChildMode): void {
  if (mode === 'engine-double') {
    chatModel.script(
      deepResearchCallStep({
        goal: RESEARCH_GOAL,
        tokenBudget: RESEARCH_TOKEN_BUDGET,
      }).step,
    );
    return;
  }
  chatModel.script(
    deepResearchCallStep({
      goal: ENGINE_JOURNEY.goal,
      tokenBudget: ENGINE_JOURNEY.tokenBudget,
    }).step,
    ...ENGINE_JOURNEY.replies.map((reply) => textStep(reply)),
  );
}

async function main(): Promise<INestApplication> {
  const mode = modeOf(process.env);
  const hit = crashPoint(process.env.CHAT_ENTRY_CRASH_AT, process.env.NODE_ENV);
  const chatModel = scriptedChatModel();
  scriptChat(chatModel, mode);
  let engine: ChildEngine | undefined;
  let resolveLaunches: (() => ResearchLaunchService) | undefined;
  const roles = createEngineScriptedRoles();
  const engineFiles = engineFilesOf(process.env, mode);
  const builder = Test.createTestingModule({ imports: [AppModule] })
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
    .overrideProvider(ENGINE_GROUP_TABLES)
    .useValue(engineFiles?.groupTables ?? TEST_GROUP_TABLES);
  if (engineFiles !== null) {
    builder.overrideProvider(ENGINE_PROCESSES).useValue(engineFiles.processes);
  }
  const moduleRef = await (
    mode === 'engine-double'
      ? builder
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
              engine = createChildEngine({
                runtime,
                pool: database.pool,
                hit,
              });
              return engine;
            },
            inject: [RESEARCH_RUNTIME, RESEARCH_DATABASE],
          })
      : builder
          .overrideProvider(ENGINE_RESOLVE_MODEL)
          .useValue(roles.resolveModel)
          .overrideProvider(ENGINE_TOKEN_COUNTER)
          .useValue(roles.tokenCounter)
  ).compile();
  const get = <T>(token: InjectionToken): T =>
    moduleRef.get<T>(token, { strict: false });
  resolveLaunches = () => get<ResearchLaunchService>(ResearchLaunchService);
  if (mode === 'engine-double') {
    if (!engine)
      throw new Error('RESEARCH_ENGINE was not resolved to the double');
    // Before `listen` starts the workers, so the first claim of a controller task finds its handler and the end of the
    // task finds the consumer that closes its investigation.
    get<HandlerRegistry>(HANDLER_REGISTRY).register(engine.controllerHandler);
    get<Runtime>(RESEARCH_RUNTIME).eventConsumers.register(
      engine.lifecycleConsumer,
    );
  }
  const controller = engine;
  process.on('message', (message: ChildRequest) => {
    if (message.kind === 'release') {
      if (controller) controller.release(message.investigationId);
      else roles.release();
    }
    if (message.kind === 'chatCalls') {
      send({
        kind: 'chatCalls',
        calls: chatModel.calls.map((call) => call.messages),
      });
    }
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
process.on('message', (message: ChildRequest) => {
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
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  const failed: StartFailedMessage = {
    kind: 'startFailed',
    code,
    message: error instanceof Error ? error.message : String(error),
  };
  // Exit once the message is written, so the harness reads it before the exit.
  if (process.send) process.send(failed, () => process.exit(1));
  else process.exit(1);
});
