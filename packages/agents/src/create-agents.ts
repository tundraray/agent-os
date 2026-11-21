import { type CodeRunner, createCodeRunner } from '@agent-os/code-runner';
import { createSecretMasker, type Logger } from '@agent-os/common';
import type { RecordKind } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { Runtime } from '@agent-os/runtime';

import type { AccessAudit, AccessGate } from './access-gate';
import type { AgentsConfig } from './config';
import { createEmbeddingClient, type EmbeddingClient } from './embeddings/embedding-client';
import { type AgentsEmbeddings, createEmbeddings } from './embeddings/embeddings';
import { createStopChildrenOnFailure } from './events/stop-children-on-failure';
import { createKnowledgeEmbedHandler } from './knowledge/embed.handler';
import { createKnowledgeExtractHandler } from './knowledge/extract.handler';
import { type AgentsKnowledge, createAgentsKnowledge } from './knowledge/knowledge';
import { createKnowledgeTrigger } from './knowledge/knowledge-trigger';
import { createPgvectorStore } from './knowledge/pgvector-store';
import { ConnectRequests } from './mcp/connect-requests';
import { type AgentsMcp, createAgentsMcp } from './mcp/mcp';
import { McpAccounts } from './mcp/mcp-accounts';
import { McpClient } from './mcp/mcp-client';
import { McpRegistry } from './mcp/mcp-registry';
import type { AgentTurnModelClient } from './model/mastra-turn';
import { type CompleteTextRequest, createModelClient, type OnTextDelta } from './model/model-client';
import { type AgentSessions, createAgentSessions } from './operations/agent-sessions';
import { type AgentsProviders, createProviderRegistry } from './providers/provider-registry';
import type { RecordLibrary } from './start/record-library';
import {
  auditStartRefusal,
  resolveStart,
  type StartRefusal,
  type StartRequest,
  type StartResolution,
} from './start/resolve-start';
import { createAgentStepHandler } from './step/agent-step.handler';
import { createCompactionStep } from './step/compaction-step';
import { createModelStep } from './step/model-step';
import { createToolStep } from './step/tool-step';
import { toolResults } from './store/tool-results.repository';
import { createBuiltinTools, createStartChild } from './tools/builtin/index';
import { createRunCodeTool } from './tools/builtin/run-code';
import { createToolRegistry, type ToolRegistry } from './tools/tool-registry';
import { rootMayStartRecord } from './tools/tool-gate';
import { type AgentsToolResults, createAgentsToolResults } from './tools/tool-result-settings';
import { createToolRunner } from './tools/tool-runner';

export interface AgentsOptions {
  readonly database: Database;
  readonly runtime: Runtime;
  readonly logger: Logger;
  /** Parsed by `parseAgentsConfig`: the package reads no environment (ADR-0004). */
  readonly config: AgentsConfig;
  /** The seam of the model: Mastra over Anthropic in production, a scripted double in tests (plan Notes 9). */
  readonly turnClient: AgentTurnModelClient;
  /**
   * Rights, quotas and the model catalogue (design-access.md KD-1, ADR-0015): asked before every model and
   * tool call of an agent, before `completeText`, when a tool set is built and for the connections list. A
   * refused call does not start; the package keeps no rights or prices of its own.
   */
  readonly access: AccessGate;
  /** Writes the `access_denied` record of every refused tool or model call (KD-6). */
  readonly audit: AccessAudit;
  /**
   * The library of agents and workflows (design-runtime.md, «Порт `RecordLibrary`»): every start asks it
   * for the record on behalf of the starter; `apps/api` passes `LibraryService`.
   */
  readonly library: RecordLibrary;
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
  /** The seam of the embeddings provider: `createScriptedEmbeddings().client` in tests; the real one by default. */
  readonly embeddingClient?: EmbeddingClient;
}

/** What `rootMayStart` asks: the conversation root's owner and the record the call names. */
export interface RootStartQuery {
  readonly ownerId: string;
  readonly recordId: string;
  /** The kind the calling tool starts. */
  readonly kind: RecordKind;
}

/** The agents package (design-agents.md, Contract «Сборка»). */
export interface Agents {
  /** Tools of upper parts, registered before `start()`. */
  readonly tools: Pick<ToolRegistry, 'register'>;
  /** The agent operations. */
  readonly sessions: AgentSessions;
  /**
   * The one start procedure (KD-2): the snapshot of a start on behalf of the starter, or its refusal.
   * `workflows` calls it in the `prepare` of `start_workflow`, before the commit.
   */
  resolveStart(request: StartRequest): Promise<StartResolution>;
  /**
   * Writes the `access_denied` record of a start refused for its model; nothing for any other refusal.
   * `workflows` calls it in the `execute` of `start_workflow` when that refusal is the call's outcome.
   */
  auditStartRefusal(refusal: StartRefusal): Promise<void>;
  /**
   * Whether the conversation root of `ownerId` may start the record of this kind (KD-4, AC-15.2): the
   * rule `start_agent` applies at the root, read live from the owner's library view. `workflows` asks it
   * in the `prepare` of `start_workflow`, before the commit.
   */
  rootMayStart(request: RootStartQuery): Promise<boolean>;
  /** The MCP registry and the employees' connections: the only MCP entry point of `apps/api` (ADR-0014). */
  readonly mcp: AgentsMcp;
  /** The model provider registry: the only entry point of `apps/api` to `agent_model_providers` (ADR-0019). */
  readonly providers: AgentsProviders;
  /**
   * Vectors on the default embedding model for the platform's own features (KD-6): the spend on the named
   * employee or on the platform, every refusal and failure a value.
   */
  readonly embeddings: AgentsEmbeddings;
  /**
   * The knowledge graphs of self-learning workflows and their settings (self-learning KD-1, KD-7): the only
   * entry point of `apps/api` to `agent_knowledge_*`. Who may call is the library's rule, asked first.
   */
  readonly knowledge: AgentsKnowledge;
  /**
   * The settings of large tool results (tool-result-reading R-5): the only entry point of `apps/api` to
   * `agent_tool_result_settings`. Admin-only is the route's rule.
   */
  readonly toolResults: AgentsToolResults;
  /**
   * One call of the default chat model outside any task, without tools (the conversation title): the
   * retries and cancel of an agent's call, a token ledger row without `taskId`, no text parts to the
   * hook. No default chat model rejects with `ModelNotConfiguredError`; a provider that is not ready or
   * keeps failing rejects.
   */
  completeText(request: CompleteTextRequest): Promise<string>;
  /**
   * Closes the registration of tools; records and their models are checked at each start. Called before
   * the runtime workers start; no MCP connection is opened (a connection lives for one call).
   */
  start(): Promise<void>;
  /** Logs the stop; nothing of MCP outlives a call, so nothing is closed. */
  stop(): Promise<void>;
}

/**
 * Builds the agents package from the database, the runtime, the logger and the parsed settings. The
 * `agent`, `knowledge.extract` and `knowledge.embed` task handlers and the `task.failed` and knowledge
 * trigger consumers are registered in the runtime at once (plan Notes 8). In memory it keeps only the tool registry, the open MCP connection requests and the token
 * refreshes in flight; the MCP registry, the accounts and every run's snapshot are in Postgres (ADR-0001,
 * ADR-0017).
 */
export function createAgents(options: AgentsOptions): Agents {
  const { database, runtime, config, access, audit, library } = options;
  const logger = options.logger.child({ component: 'agents' });

  const mcpLogger = logger.child({ service: 'agents.mcp' });
  const mcpClient = new McpClient();
  const accounts = new McpAccounts({
    database,
    requests: new ConnectRequests(),
    access,
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
  const providers = createProviderRegistry({
    database,
    logger: logger.child({ service: 'agents.providers' }),
  });
  const startDeps = { library, access, providers, audit };
  // Keys come only from the process's secret memory: the provider registry remembers each one it reads (KD-7).
  const maskSecrets = createSecretMasker([]);
  const runner = createToolRunner({
    client: mcpClient,
    accounts,
    access,
    audit,
    callTimeoutMs: config.mcpCallTimeoutMs,
    resultSettings: () => toolResults.readSettings(database),
    maskSecrets,
    startChildFor: createStartChild({ maxDepth: config.maxDepth }),
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
    // `run_code` is in the registry, so it reads the registry lazily (no build cycle).
    registry: () => registry,
    runner,
    codeRun: config.codeRun,
    maskSecrets,
  });
  const registry: ToolRegistry = createToolRegistry({
    builtins: createBuiltinTools({
      ...startDeps,
      maxDepth: config.maxDepth,
      logger,
      database,
      tasks: runtime.tasks,
    }),
    runCode,
    database,
    access,
    library,
    logger,
  });
  const modelClient = createModelClient({
    turnClient: options.turnClient,
    ledger: runtime.ledger,
    config,
    logger: logger.child({ service: 'agents.model' }),
    access,
    providers,
    audit,
    ...(options.onTextDelta === undefined ? {} : { onTextDelta: options.onTextDelta }),
  });
  const embeddings = createEmbeddings({
    client: options.embeddingClient ?? createEmbeddingClient(),
    access,
    providers,
    ledger: runtime.ledger,
  });
  // One store of the knowledge vectors for every reader and writer (self-learning KD-8).
  const vectorStore = createPgvectorStore(database);

  runtime.handlers.register(
    createAgentStepHandler({
      database,
      toolStep: createToolStep({ registry, runner, access, audit }),
      modelStep: createModelStep({
        database,
        registry,
        modelClient,
        audit,
        tasks: runtime.tasks,
        inbox: runtime.inbox,
        vectorStore,
      }),
      compactionStep: createCompactionStep({ database, registry, modelClient, audit, vectorStore }),
      compactAtTokens: config.compactAtTokens,
      embeddings,
    }),
  );
  runtime.handlers.register(
    createKnowledgeExtractHandler({
      database,
      tasks: runtime.tasks,
      modelClient,
      embeddings,
      store: vectorStore,
    }),
  );
  runtime.handlers.register(
    createKnowledgeEmbedHandler({ database, embeddings, store: vectorStore }),
  );
  runtime.eventConsumers.register(createStopChildrenOnFailure({ tasks: runtime.tasks, logger }));
  runtime.eventConsumers.register(createKnowledgeTrigger({ tasks: runtime.tasks, logger }));

  const sessions = createAgentSessions({ database, runtime, registry, ...startDeps, logger });

  return {
    tools: { register: (tool) => registry.register(tool) },
    sessions,
    resolveStart: (request) => resolveStart(request, startDeps),
    auditStartRefusal: (refusal) => auditStartRefusal(audit, refusal),
    rootMayStart: async ({ ownerId, recordId, kind }) =>
      rootMayStartRecord(await library.listVisible(ownerId), kind, recordId),
    mcp: createAgentsMcp(mcpRegistry, accounts),
    providers,
    embeddings,
    knowledge: createAgentsKnowledge({
      database,
      tasks: runtime.tasks,
      embeddings,
      store: vectorStore,
      logger,
    }),
    toolResults: createAgentsToolResults({ database, logger }),
    completeText: (request) => modelClient.completeText(request),
    async start() {
      const startedAt = Date.now();
      registry.seal();
      logger.info('agents started', {
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
