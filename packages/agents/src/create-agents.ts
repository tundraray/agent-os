import { type CodeRunner, createCodeRunner } from '@agent-os/code-runner';
import { createSecretMasker, type Logger } from '@agent-os/common';
import type { Database } from '@agent-os/db';
import type { Runtime } from '@agent-os/runtime';

import { type AgentsConfig, secretValuesOf } from './config.js';
import { checkCatalog, createCatalog, type DefinitionCatalog } from './definitions/catalog.js';
import { GENERAL_PURPOSE } from './definitions/definition.js';
import { createStopChildrenOnFailure } from './events/stop-children-on-failure.js';
import { ConnectRequests } from './mcp/connect-requests.js';
import { type AgentsMcp, createAgentsMcp } from './mcp/mcp.js';
import { McpAccounts, type McpServerAllowed } from './mcp/mcp-accounts.js';
import { McpClient } from './mcp/mcp-client.js';
import { McpRegistry } from './mcp/mcp-registry.js';
import type { AgentTurnModelClient } from './model/mastra-turn.js';
import { type CompleteTextRequest, createModelClient, type OnTextDelta } from './model/model-client.js';
import { type AgentSessions, createAgentSessions } from './operations/agent-sessions.js';
import type { OwnerGate } from './owner-gate.js';
import { createAgentStepHandler } from './step/agent-step.handler.js';
import { createCompactionStep } from './step/compaction-step.js';
import { createModelStep } from './step/model-step.js';
import { createToolStep } from './step/tool-step.js';
import { createBuiltinTools, createStartChild } from './tools/builtin/index.js';
import { createRunCodeTool } from './tools/builtin/run-code.js';
import { createToolRegistry, type ToolRegistry } from './tools/tool-registry.js';
import { serverAllowed } from './tools/tool-access.js';
import { createToolRunner } from './tools/tool-runner.js';

export interface AgentsOptions {
  readonly database: Database;
  readonly runtime: Runtime;
  readonly logger: Logger;
  /** Parsed by `parseAgentsConfig`: the package reads no environment (ADR-0004). */
  readonly config: AgentsConfig;
  /** The seam of the model: Mastra over Anthropic in production, a scripted double in tests (plan Notes 9). */
  readonly turnClient: AgentTurnModelClient;
  /**
   * Asked before every model and tool call of an agent and before `completeText` (KD-4 of
   * design-identity.md): a disabled or unknown owner's call does not start.
   */
  readonly ownerGate: OwnerGate;
  /**
   * Gets every text part of an agent's answer with `ownerId`, `rootId`, `agentId`, `offset` (KD-3);
   * none by default. A failure of the hook is logged and does not break the step.
   */
  readonly onTextDelta?: OnTextDelta;
  /**
   * The seam of the code executor: a double in tests; by default the real one,
   * `createCodeRunner` with `CODE_RUN_MAX_CONCURRENT`.
   */
  readonly codeRunner?: CodeRunner;
}

/** The agents package (design-agents.md, Contract «Сборка»). */
export interface Agents {
  /** The catalog of definitions; upper parts register theirs before `start()`. */
  readonly definitions: Pick<DefinitionCatalog, 'register'>;
  /** Tools of upper parts, registered before `start()`. */
  readonly tools: Pick<ToolRegistry, 'register'>;
  /** The agent operations. */
  readonly sessions: AgentSessions;
  /** The MCP registry and the employees' connections: the only MCP entry point of `apps/api` (ADR-0014). */
  readonly mcp: AgentsMcp;
  /**
   * One call of `AGENT_DEFAULT_MODEL` outside any task, without tools (the conversation title): the
   * retries and cancel of an agent's call, a token ledger row without `taskId`, no text parts to the
   * hook. A provider that keeps failing rejects.
   */
  completeText(request: CompleteTextRequest): Promise<string>;
  /**
   * Registers `general-purpose`, closes registration and checks the catalog against the tools, the form
   * of server names and `ledger.pricedModels()`. Called before the runtime workers start; no MCP connection
   * is opened (a connection lives for one call).
   */
  start(): Promise<void>;
  /** Logs the stop; nothing of MCP outlives a call, so nothing is closed. */
  stop(): Promise<void>;
}

/**
 * Builds the agents package from the database, the runtime, the logger and the parsed settings. The
 * `agent` task handler and the `task.failed` consumer are registered in the runtime at once (plan
 * Notes 8). In memory it keeps only the catalog, the tool registry, the open MCP connection requests and
 * the token refreshes in flight; the MCP registry and accounts are in Postgres (ADR-0001).
 */
export function createAgents(options: AgentsOptions): Agents {
  const { database, runtime, config } = options;
  const logger = options.logger.child({ component: 'agents' });

  const catalog = createCatalog();
  const mcpLogger = logger.child({ service: 'agents.mcp' });
  const allowed: McpServerAllowed = (ownerId, server) => serverAllowed(config.mcpAccess, ownerId, server);
  const mcpClient = new McpClient();
  const accounts = new McpAccounts({
    database,
    requests: new ConnectRequests(),
    serverAllowed: allowed,
    logger: mcpLogger,
    callTimeoutMs: config.mcpCallTimeoutMs,
    allowHttp: config.allowHttpUrls,
  });
  const mcpRegistry = new McpRegistry({
    database,
    client: mcpClient,
    logger: mcpLogger,
    callTimeoutMs: config.mcpCallTimeoutMs,
    allowHttp: config.allowHttpUrls,
  });
  const startChildDeps = {
    catalog,
    maxDepth: config.maxDepth,
    defaultModel: config.defaultModel,
    pricedModels: () => runtime.ledger.pricedModels(),
  };
  const runner = createToolRunner({
    client: mcpClient,
    accounts,
    serverAllowed: allowed,
    callTimeoutMs: config.mcpCallTimeoutMs,
    toolResultMaxBytes: config.toolResultMaxBytes,
    startChildFor: createStartChild(startChildDeps),
    ownerGate: options.ownerGate,
  });
  const codeRunner =
    options.codeRunner ??
    createCodeRunner({
      maxConcurrent: config.codeRun.maxConcurrent,
      logger: logger.child({ service: 'agents.code-runner' }),
    });
  const runCode = createRunCodeTool({
    codeRunner,
    database,
    catalog,
    // `run_code` is in the registry, so it reads the registry lazily (no build cycle).
    registry: () => registry,
    runner,
    codeRun: config.codeRun,
    toolResultMaxBytes: config.toolResultMaxBytes,
    maskSecrets: createSecretMasker(secretValuesOf(config)),
  });
  const registry: ToolRegistry = createToolRegistry({
    builtins: createBuiltinTools({ ...startChildDeps, tasks: runtime.tasks, database }),
    runCode,
    catalog,
    database,
    serverAllowed: allowed,
  });
  const modelClient = createModelClient({
    turnClient: options.turnClient,
    ledger: runtime.ledger,
    config,
    logger: logger.child({ service: 'agents.model' }),
    ownerGate: options.ownerGate,
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
    definitions: { register: (definition) => catalog.register(definition) },
    tools: { register: (tool) => registry.register(tool) },
    sessions,
    mcp: createAgentsMcp(mcpRegistry, accounts),
    completeText: (request) => modelClient.completeText(request),
    async start() {
      const startedAt = Date.now();
      catalog.register(GENERAL_PURPOSE);
      catalog.seal();
      registry.seal();
      checkCatalog({
        definitions: catalog.all(),
        toolNames: registry.toolNames(),
        pricedModels: runtime.ledger.pricedModels(),
        defaultModel: config.defaultModel,
      });
      logger.info('agents started', {
        definitions: catalog.all().map((definition) => definition.name),
        tools: registry.toolNames(),
        allowHttpUrls: config.allowHttpUrls,
        durationMs: Date.now() - startedAt,
      });
    },
    async stop() {
      logger.info('agents stopped');
    },
  };
}
