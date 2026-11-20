import {
  Inject,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createAgents,
  createEmbeddingClient,
  createMastraTurnClient,
  type AccessAudit,
  type Agents,
  type AgentsConfig,
  type AgentTurnModelClient,
  type EmbeddingClient,
} from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import type { DatabaseConnection } from '@agent-os/db';
import type { Clock, Runtime } from '@agent-os/runtime';
import { AccessModule } from '../access/access.module.js';
import { AccessService } from '../access/access.service.js';
import { AuditLog } from '../audit/audit-log.js';
import { IdentityModule } from '../identity/identity.module.js';
import { LibraryModule } from '../library/library.module.js';
import { LibraryService } from '../library/library.service.js';
import { APP_LOGGER, createAppLogger } from '../logging/app-logger.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import {
  RUNTIME,
  RUNTIME_CLOCK,
  RUNTIME_DATABASE,
} from '../runtime/runtime.tokens.js';
import { AdminMcpServersController } from './admin-mcp-servers.controller.js';
import { AdminModelProvidersController } from './admin-model-providers.controller.js';
import { AdminToolResultsController } from './admin-tool-results.controller.js';
import { readAgentsSettings } from './agents-settings.js';
import {
  AGENT_TURN_CLIENT,
  AGENTS,
  AGENTS_SETTINGS,
  DELTA_PUBLISHER,
  EMBEDDING_CLIENT,
} from './agents.tokens.js';
import { AGENT_TEXT_DELTA_CHANNEL, DeltaPublisher } from './delta-publisher.js';
import { McpConnectionsController } from './mcp-connections.controller.js';

/**
 * The agents' audit hook (design-access.md KD-6): an `access_denied` record by its own insert, outside any
 * transaction. A failed write is logged with the record and thrown, so the step that refused is repeated
 * (plan Notes 3) — a refusal is never left out of the audit silently.
 */
function accessAudit(auditLog: AuditLog, logger: Logger): AccessAudit {
  return async (entry) => {
    try {
      await auditLog.record(null, entry);
    } catch (error) {
      logger.error('access_denied audit record not written', {
        ...entry,
        error,
      });
      throw error;
    }
  };
}

/**
 * Composition root of the agents package in `apps/api` (composition-root.md, design-agents.md C2 `api`,
 * design-chat.md «Сборка»): reads the settings and assembles the package on the
 * runtime and its pool, with the model client of `AGENT_TURN_CLIENT` and the embedding client of
 * `EMBEDDING_CLIENT` (the tokens tests replace), the `DeltaPublisher` as the `onTextDelta` hook,
 * `AccessService` as the `AccessGate` port, `AuditLog` behind the `audit` hook (design-access.md KD-1, KD-6) and `LibraryService` as the `RecordLibrary` port
 * (design-runtime.md, port-module-split.md: `LibraryModule` does not import this module). The `agent`
 * handler and the `task.failed` consumer are registered in the `AGENTS` factory; upper modules register
 * their tools in their own factories injecting `AGENTS`.
 *
 * Phases: `onModuleInit` — `start()` (closes the tool registration), before `RuntimeModule` starts the
 * workers in `onApplicationBootstrap`; `onApplicationShutdown` — `stop()`, after the runtime has stopped
 * its steps in `beforeApplicationShutdown`.
 *
 * Its controllers are the HTTP layer of `Agents.mcp` (an employee's MCP accounts and the admin's registry),
 * of `Agents.providers` (the admin's model provider registry) and of `Agents.toolResults` (the admin's
 * settings of large tool results).
 */
@Module({
  imports: [RuntimeModule, IdentityModule, AccessModule, LibraryModule],
  controllers: [
    McpConnectionsController,
    AdminMcpServersController,
    AdminToolResultsController,
    AdminModelProvidersController,
  ],
  providers: [
    {
      provide: AGENTS_SETTINGS,
      useFactory: (config: ConfigService): AgentsConfig =>
        readAgentsSettings((name) => config.get<string>(name)),
      inject: [ConfigService],
    },
    {
      provide: AGENT_TURN_CLIENT,
      useFactory: (): AgentTurnModelClient => createMastraTurnClient(),
    },
    {
      provide: EMBEDDING_CLIENT,
      useFactory: (): EmbeddingClient => createEmbeddingClient(),
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
        embeddingClient: EmbeddingClient,
        deltaPublisher: DeltaPublisher,
        access: AccessService,
        auditLog: AuditLog,
        library: LibraryService,
        appLogger: Logger,
      ): Agents =>
        createAgents({
          database: database.db,
          runtime,
          // Provider keys reach the mask through the process's secret memory, not a list (KD-7).
          logger: createAppLogger(process.env),
          config: settings,
          turnClient,
          embeddingClient,
          access,
          audit: accessAudit(
            auditLog,
            appLogger.child({ service: 'agents.audit' }),
          ),
          library,
          onTextDelta: (delta) => deltaPublisher.publish(delta),
        }),
      inject: [
        AGENTS_SETTINGS,
        RUNTIME,
        RUNTIME_DATABASE,
        AGENT_TURN_CLIENT,
        EMBEDDING_CLIENT,
        DELTA_PUBLISHER,
        AccessService,
        AuditLog,
        LibraryService,
        APP_LOGGER,
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
