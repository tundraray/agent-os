import 'reflect-metadata';
import { type CodeRunner, createCodeRunner } from '@agent-os/code-runner';
import { createSecretMasker, LOGGER, type Logger } from '@agent-os/common';
import {
  type DynamicModule,
  type FactoryProvider,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';

import { AgentDeps } from './agent/agent-deps';
import { AgentFactory } from './agent/agent-factory';
import {
  AgentsRegistration,
  SystemToolsRegistration,
} from './agents-registration';
import {
  AGENT_TURN_CLIENT,
  AGENTS_CONFIG,
  AGENTS_LOGGER,
  CODE_RUNNER,
  EMBEDDING_CLIENT,
  MASK_SECRETS,
} from './agents.tokens';
import type { AgentsConfig } from './config';
import { createEmbeddingClient } from './embeddings/embedding-client';
import { AgentsEmbeddings } from './embeddings/embeddings';
import { ConnectRequests } from './mcp/connect-requests';
import { AgentsMcp } from './mcp/mcp';
import { McpAccounts } from './mcp/mcp-accounts';
import { McpClient } from './mcp/mcp-client';
import { McpRegistry } from './mcp/mcp-registry';
import { createMastraTurnClient } from './model/mastra-turn';
import { ModelClient } from './model/model-client';
import { ControlOperations } from './operations/control-operations';
import { StartOperations } from './operations/start-operations';
import { TrainingOperations } from './operations/training-operations';
import { ViewOperations } from './operations/view-operations';
import { AgentsProviders } from './providers/provider-registry';
import { CallRecords } from './store/call-records';
import { History } from './store/history';
import { Sessions } from './store/sessions';
import { RunCodeTool } from './tools/external/run-code';
import { ToolRegistry } from './tools/tool-registry';
import { ToolRunner } from './tools/tool-runner';
import { TrainingBudget } from './training/training-budget';

/**
 * Where the composition root gets the agents settings from (parsed by `parseAgentsConfig`), the modules that
 * export the ports it implements (`ACCESS_GATE`, `ACCESS_AUDIT`, `RECORD_LIBRARY` and, when it listens to the
 * text parts, `ON_TEXT_DELTA`), and the logger of the package when it is not the application's `LOGGER`.
 */
type AgentsModuleOptions = Pick<ModuleMetadata, 'imports'> &
  Pick<
    FactoryProvider<AgentsConfig | Promise<AgentsConfig>>,
    'inject' | 'useFactory'
  > & {
    readonly logger?: () => Logger;
  };

/** What the modules above the agents inject. */
const PUBLIC_SERVICES = [
  // Tools of upper parts are registered in it in `onModuleInit`.
  ToolRegistry,
  // The agent operations.
  StartOperations,
  ControlOperations,
  ViewOperations,
  // The start of a training (self-learning design-training.md, KD-1).
  TrainingOperations,
  // The MCP registry and the employees' connections: the only MCP entry point of `apps/api` (ADR-0014).
  AgentsMcp,
  // The model provider registry: the only entry point of `apps/api` to `model_providers` (ADR-0019).
  AgentsProviders,
  // Vectors on the default embedding model for the platform's own features (KD-6).
  AgentsEmbeddings,
  // `completeText`: one call of the default chat model outside any task (the conversation title).
  ModelClient,
];

/**
 * The agents package (design-agents.md, Contract «Сборка»). It works over the pool and the repositories of
 * `DbModule` and the services of `RuntimeModule`, both global; the package reads no environment (ADR-0004).
 *
 * In memory it keeps only the tool registry, the open MCP connection requests and the token refreshes in
 * flight — the agent objects are the runtime's (`LiveTasks`), a cache over the database; the MCP registry, the
 * accounts and every run's version are in Postgres (ADR-0001, ADR-0017).
 *
 * `onModuleInit` — the registrations in the runtime and in the tools library (`AgentsRegistration`,
 * `SystemToolsRegistration`, `RunCodeTool`, `AgentFactory`); `onApplicationBootstrap` — the tools library closes.
 */
@Module({})
export class AgentsModule {
  static forRootAsync(options: AgentsModuleOptions): DynamicModule {
    return {
      module: AgentsModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: AGENTS_CONFIG,
          inject: options.inject ?? [],
          useFactory: options.useFactory,
        },
        {
          provide: AGENTS_LOGGER,
          inject: [LOGGER],
          useFactory: (logger: Logger): Logger =>
            (options.logger?.() ?? logger).child({ component: 'agents' }),
        },
        // Keys come only from the process's secret memory: the provider registry remembers each one it reads (KD-7).
        { provide: MASK_SECRETS, useFactory: () => createSecretMasker([]) },
        { provide: AGENT_TURN_CLIENT, useFactory: createMastraTurnClient },
        { provide: EMBEDDING_CLIENT, useFactory: createEmbeddingClient },
        {
          provide: CODE_RUNNER,
          inject: [AGENTS_CONFIG, AGENTS_LOGGER],
          useFactory: (config: AgentsConfig, logger: Logger): CodeRunner =>
            createCodeRunner({
              maxConcurrent: config.codeRun.maxConcurrent,
              logger: logger.child({ service: 'agents.code-runner' }),
            }),
        },
        Sessions,
        History,
        CallRecords,
        McpClient,
        ConnectRequests,
        McpAccounts,
        McpRegistry,
        ToolRunner,
        TrainingBudget,
        RunCodeTool,
        AgentDeps,
        AgentFactory,
        SystemToolsRegistration,
        AgentsRegistration,
        ...PUBLIC_SERVICES,
      ],
      exports: PUBLIC_SERVICES,
    };
  }
}
