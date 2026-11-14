import type { Logger } from '@agent-os/common';
import type { Database } from '@agent-os/db';
import type { Runtime } from '@agent-os/runtime';

import type { AgentsConfig } from './config.js';
import { checkCatalog, createCatalog, type DefinitionCatalog } from './definitions/catalog.js';
import { GENERAL_PURPOSE } from './definitions/definition.js';
import { createStopChildrenOnFailure } from './events/stop-children-on-failure.js';
import { createMcpClients } from './mcp/mcp-clients.js';
import {
  type AgentTurnModelClient,
  createMastraTurnClient,
  createResolveModel,
} from './model/mastra-turn.js';
import { type CompleteTextRequest, createModelClient, type OnTextDelta } from './model/model-client.js';
import { type AgentSessions, createAgentSessions } from './operations/agent-sessions.js';
import { createAgentStepHandler } from './step/agent-step.handler.js';
import { createCompactionStep } from './step/compaction-step.js';
import { createModelStep } from './step/model-step.js';
import { createToolStep } from './step/tool-step.js';
import { createBuiltinTools, createStartChild, describeStartAgent } from './tools/builtin/index.js';
import { createToolRegistry, type ToolRegistry } from './tools/tool-registry.js';
import { createToolRunner } from './tools/tool-runner.js';

export interface AgentsOptions {
  readonly database: Database;
  readonly runtime: Runtime;
  readonly logger: Logger;
  /** Parsed by `parseAgentsConfig`: the package reads no environment (ADR-0004). */
  readonly config: AgentsConfig;
  /** The seam of the model; Mastra over Anthropic by default, a scripted double in tests (plan Notes 9). */
  readonly turnClient?: AgentTurnModelClient;
  /**
   * Gets every text part of an agent's answer with `ownerId`, `rootId`, `agentId`, `offset` (KD-3);
   * none by default. A failure of the hook is logged and does not break the step.
   */
  readonly onTextDelta?: OnTextDelta;
}

/** The agents package (design-agents.md, Contract «Сборка»). */
export interface Agents {
  /** The catalog of definitions; upper parts register theirs before `start()`. */
  readonly definitions: Pick<DefinitionCatalog, 'register' | 'list'>;
  /** Tools of upper parts, registered before `start()`. */
  readonly tools: Pick<ToolRegistry, 'register'>;
  /** The agent operations. */
  readonly sessions: AgentSessions;
  /**
   * One call of `AGENT_DEFAULT_MODEL` outside any task, without tools (the conversation title): the
   * retries and cancel of an agent's call, a token ledger row without `taskId`, no text parts to the
   * hook. A provider that keeps failing rejects.
   */
  completeText(request: CompleteTextRequest): Promise<string>;
  /**
   * Registers `general-purpose` unless present, closes registration, checks the catalog against the
   * tools, the servers and `ledger.pricedModels()`, then starts the MCP servers. Called before the
   * runtime workers start.
   */
  start(): Promise<void>;
  /** Closes the MCP server processes. */
  stop(): Promise<void>;
}

/**
 * Builds the agents package from the database, the runtime, the logger and the parsed settings. The
 * `agent` task handler and the `task.failed` consumer are registered in the runtime at once (plan
 * Notes 8). In memory it keeps only the catalog, the tool registry with the MCP tool lists, and the MCP
 * processes (ADR-0001: Postgres owns the state).
 */
export function createAgents(options: AgentsOptions): Agents {
  const { database, runtime, config } = options;
  const logger = options.logger.child({ component: 'agents' });

  const catalog = createCatalog();
  const serverIds = config.mcpServers.map((server) => server.id);
  const mcpClients = createMcpClients({
    servers: config.mcpServers,
    logger: logger.child({ service: 'agents.mcp' }),
    callTimeoutMs: config.mcpCallTimeoutMs,
  });
  const startChildDeps = {
    catalog,
    maxDepth: config.maxDepth,
    defaultModel: config.defaultModel,
    pricedModels: () => runtime.ledger.pricedModels(),
  };
  const registry = createToolRegistry({
    builtins: createBuiltinTools({ ...startChildDeps, tasks: runtime.tasks, database }),
    describeStartAgent,
    mcpClients,
    catalog,
    access: config.mcpAccess,
    serverIds,
  });
  const runner = createToolRunner({
    mcpClients,
    access: config.mcpAccess,
    toolResultMaxBytes: config.toolResultMaxBytes,
    startChildFor: createStartChild(startChildDeps),
  });
  const modelClient = createModelClient({
    turnClient: options.turnClient ?? createMastraTurnClient(createResolveModel(config)),
    ledger: runtime.ledger,
    config,
    logger: logger.child({ service: 'agents.model' }),
    ...(options.onTextDelta === undefined ? {} : { onTextDelta: options.onTextDelta }),
  });

  runtime.handlers.register(
    createAgentStepHandler({
      database,
      toolStep: createToolStep({ catalog, registry, runner }),
      modelStep: createModelStep({
        database,
        catalog,
        registry,
        modelClient,
        tasks: runtime.tasks,
        inbox: runtime.inbox,
      }),
      compactionStep: createCompactionStep({ database, catalog, registry, modelClient }),
      compactAtTokens: config.compactAtTokens,
    }),
  );
  runtime.eventConsumers.register(createStopChildrenOnFailure({ tasks: runtime.tasks, logger }));

  const sessions = createAgentSessions({
    database,
    runtime,
    catalog,
    registry,
    config,
    logger,
  });

  return {
    definitions: { register: (definition) => catalog.register(definition), list: () => catalog.list() },
    tools: { register: (tool) => registry.register(tool) },
    sessions,
    completeText: (request) => modelClient.completeText(request),
    async start() {
      const startedAt = Date.now();
      if (catalog.get(GENERAL_PURPOSE.name) === undefined) catalog.register(GENERAL_PURPOSE);
      catalog.seal();
      registry.seal();
      checkCatalog({
        definitions: catalog.all(),
        toolNames: registry.toolNames(),
        serverIds,
        pricedModels: runtime.ledger.pricedModels(),
        defaultModel: config.defaultModel,
      });
      await mcpClients.start();
      logger.info('agents started', {
        definitions: catalog.list().map((header) => header.name),
        tools: registry.toolNames(),
        servers: serverIds,
        durationMs: Date.now() - startedAt,
      });
    },
    async stop() {
      await mcpClients.stop();
      logger.info('agents stopped', { servers: serverIds });
    },
  };
}
