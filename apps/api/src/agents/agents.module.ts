import {
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createAgents,
  createMastraTurnClient,
  createResolveModel,
  type Agents,
  type AgentsConfig,
  type AgentTurnModelClient,
} from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import type { DatabaseConnection } from '@agent-os/db';
import type { Clock, Runtime } from '@agent-os/runtime';
import { APP_LOGGER, createAppLogger } from '../logging/app-logger.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import {
  RUNTIME,
  RUNTIME_CLOCK,
  RUNTIME_DATABASE,
} from '../runtime/runtime.tokens.js';
import { mcpServerSecrets, readAgentsSettings } from './agents-settings.js';
import {
  AGENT_TURN_CLIENT,
  AGENTS,
  AGENTS_SETTINGS,
  DELTA_PUBLISHER,
} from './agents.tokens.js';
import { AGENT_TEXT_DELTA_CHANNEL, DeltaPublisher } from './delta-publisher.js';

/**
 * Composition root of the agents package in `apps/api` (composition-root.md, design-agents.md C2 `api`,
 * design-chat.md «Сборка»): reads the settings and the servers file and assembles the package on the
 * runtime and its pool, with the model client of `AGENT_TURN_CLIENT` (the one token tests replace) and
 * the `DeltaPublisher` as the `onTextDelta` hook. The `agent` handler and the `task.failed` consumer are
 * registered in the `AGENTS` factory; upper modules register their definitions and tools in their own
 * factories injecting `AGENTS`.
 *
 * Phases: `onModuleInit` — `start()` (catalog check, MCP servers), before `RuntimeModule` starts the
 * workers in `onApplicationBootstrap`; `onApplicationShutdown` — `stop()`, after the runtime has stopped
 * its steps in `beforeApplicationShutdown`.
 */
@Module({
  imports: [RuntimeModule],
  providers: [
    {
      provide: AGENTS_SETTINGS,
      useFactory: (config: ConfigService): AgentsConfig =>
        readAgentsSettings((name) => config.get<string>(name)),
      inject: [ConfigService],
    },
    {
      provide: AGENT_TURN_CLIENT,
      useFactory: (settings: AgentsConfig): AgentTurnModelClient =>
        createMastraTurnClient(
          createResolveModel({
            anthropicBaseUrl: settings.anthropicBaseUrl,
            anthropicApiKey: settings.anthropicApiKey,
          }),
        ),
      inject: [AGENTS_SETTINGS],
    },
    {
      provide: DELTA_PUBLISHER,
      useFactory: (
        database: DatabaseConnection,
        clock: Clock,
        logger: Logger,
      ): DeltaPublisher =>
        new DeltaPublisher({
          notify: async (payload) => {
            await database.pool.query('SELECT pg_notify($1, $2)', [
              AGENT_TEXT_DELTA_CHANNEL,
              payload,
            ]);
          },
          clock,
          logger: logger.child({ service: 'agents.delta' }),
        }),
      inject: [RUNTIME_DATABASE, RUNTIME_CLOCK, APP_LOGGER],
    },
    {
      provide: AGENTS,
      useFactory: (
        settings: AgentsConfig,
        runtime: Runtime,
        database: DatabaseConnection,
        turnClient: AgentTurnModelClient,
        deltaPublisher: DeltaPublisher,
      ): Agents =>
        createAgents({
          database: database.db,
          runtime,
          // The application logger plus the servers' environment values; the provider key is among
          // the application's secrets already.
          logger: createAppLogger(process.env, mcpServerSecrets(settings)),
          config: settings,
          turnClient,
          onTextDelta: (delta) => deltaPublisher.publish(delta),
        }),
      inject: [
        AGENTS_SETTINGS,
        RUNTIME,
        RUNTIME_DATABASE,
        AGENT_TURN_CLIENT,
        DELTA_PUBLISHER,
      ],
    },
  ],
  exports: [AGENTS],
})
export class AgentsModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(AGENTS) private readonly agents: Agents) {}

  async onModuleInit(): Promise<void> {
    await this.agents.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.agents.stop();
  }
}
