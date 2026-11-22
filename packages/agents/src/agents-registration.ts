import type { Logger } from '@agent-os/common';
import { AGENT_TASK_TYPE, CHAT_TASK_TYPE, DEEP_AGENT_TASK_TYPE } from '@agent-os/contracts';
import {
  AgentCodeCallsRepository,
  AgentKnowledgeRepository,
  AgentKnowledgeRunsRepository,
  AgentKnowledgeVectorsRepository,
  AgentMcpServersRepository,
  AgentMessagesRepository,
  AgentSessionsRepository,
  AgentSessionTasksRepository,
  AgentToolResultsRepository,
  Db,
} from '@agent-os/db';
import { EventConsumerRegistry, HandlerRegistry, TaskControl } from '@agent-os/runtime';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import type { AccessAudit, AccessGate } from './access-gate';
import { AgentFactory } from './agent/agent-factory';
import { ACCESS_AUDIT, ACCESS_GATE, AGENTS_CONFIG, AGENTS_LOGGER, RECORD_LIBRARY } from './agents.tokens';
import type { AgentsConfig } from './config';
import { createStartDeepAgentTool } from './deep/start-deep-agent';
import { createTaskTool } from './deep/task-delegation';
import { AgentsEmbeddings } from './embeddings/embeddings';
import { createStopChildrenOnFailure } from './events/stop-children-on-failure';
import { createKnowledgeEmbedHandler } from './knowledge/embed.handler';
import { createKnowledgeExtractHandler } from './knowledge/extract.handler';
import { createKnowledgeTrigger } from './knowledge/knowledge-trigger';
import type { KnowledgeVectorStore } from './knowledge/vector-store';
import { ModelClient } from './model/model-client';
import { AgentsProviders } from './providers/provider-registry';
import type { RecordLibrary } from './start/record-library';
import { auditStartRefusal, resolveStart } from './start/resolve-start';
import { AgentTaskInputSchema, Sessions } from './store/sessions';
import { createSystemTools } from './tools/system/index';
import { createTaskListTools } from './tools/system/task-list-tools';
import { rootMayStartRecord } from './tools/system/tool-gate';
import { ToolRegistry } from './tools/tool-registry';

/**
 * Registers the system tools in the tools library (design-agents.md, «Инструменты»): the library knows none of
 * them by name, and they reach a session by its agent's declaration. Upper parts register their own tools the
 * same way, in their `onModuleInit`.
 */
@Injectable()
export class SystemToolsRegistration implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry) private readonly registry: Pick<ToolRegistry, 'register'>,
    @Inject(Sessions) private readonly sessions: Sessions,
    @Inject(AgentMessagesRepository) private readonly messageRows: AgentMessagesRepository,
    @Inject(AgentToolResultsRepository) private readonly toolResultRows: AgentToolResultsRepository,
    @Inject(AgentSessionTasksRepository) private readonly sessionTaskRows: AgentSessionTasksRepository,
    @Inject(TaskControl) private readonly tasks: Pick<TaskControl, 'listTree' | 'stop'>,
    @Inject(RECORD_LIBRARY) private readonly library: RecordLibrary,
    @Inject(ACCESS_GATE) private readonly access: AccessGate,
    @Inject(AgentsProviders) private readonly providers: Pick<AgentsProviders, 'connection'>,
    @Inject(ACCESS_AUDIT) private readonly audit: AccessAudit,
    @Inject(AGENTS_CONFIG) private readonly config: Pick<AgentsConfig, 'maxDepth'>,
    @Inject(AGENTS_LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    const { library, access, providers, audit, logger } = this;
    const startDeps = { library, access, providers, audit };
    const tools = [
      ...createSystemTools({
        ...startDeps,
        maxDepth: this.config.maxDepth,
        logger,
        sessions: this.sessions,
        messageRows: this.messageRows,
        toolResultRows: this.toolResultRows,
        tasks: this.tasks,
      }),
      // Declared by an agent that keeps a task list (design-task-list.md KD-2).
      ...createTaskListTools({ sessionTaskRows: this.sessionTaskRows, logger }),
      // The deep agent's tools: the root's `start_deep_agent` (deep-agents KD-2) and a deep agent's `task`.
      createStartDeepAgentTool({
        resolveStart: (request) => resolveStart(request, startDeps),
        auditStartRefusal: (refusal) => auditStartRefusal(audit, refusal),
        rootMayStart: async (ownerId, recordId) =>
          rootMayStartRecord(await library.listVisible(ownerId), 'deep_agent', recordId),
        logger,
      }),
      createTaskTool(),
    ];
    for (const tool of tools) this.registry.register(tool);
  }
}

/**
 * Registers the package in the runtime (plan Notes 8): the agents (`ChatAgent`, `Agent`, `DeepAgent`) as the
 * live task types `chat`, `agent` and `deep_agent` — one object per task, made by `AgentFactory` —, the
 * `knowledge.extract` and `knowledge.embed` task handlers and the `task.failed` and knowledge trigger consumers.
 * Once every module has registered its tools it closes the tools library.
 */
@Injectable()
export class AgentsRegistration implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(HandlerRegistry) private readonly handlers: HandlerRegistry,
    @Inject(EventConsumerRegistry) private readonly eventConsumers: EventConsumerRegistry,
    @Inject(AgentFactory) private readonly factory: Pick<AgentFactory, 'restore'>,
    @Inject(ToolRegistry) private readonly registry: Pick<ToolRegistry, 'seal' | 'toolNames'>,
    @Inject(Db) private readonly db: Db,
    @Inject(Sessions) private readonly sessions: Sessions,
    @Inject(AgentSessionsRepository) private readonly sessionRows: AgentSessionsRepository,
    @Inject(AgentMessagesRepository) private readonly messageRows: AgentMessagesRepository,
    @Inject(AgentCodeCallsRepository) private readonly codeCallRows: AgentCodeCallsRepository,
    @Inject(AgentMcpServersRepository) private readonly mcpServerRows: AgentMcpServersRepository,
    @Inject(AgentKnowledgeRepository) private readonly knowledgeRows: AgentKnowledgeRepository,
    @Inject(AgentKnowledgeRunsRepository) private readonly knowledgeRunRows: AgentKnowledgeRunsRepository,
    // One store of the knowledge vectors for every reader and writer (self-learning KD-8).
    @Inject(AgentKnowledgeVectorsRepository) private readonly vectorStore: KnowledgeVectorStore,
    @Inject(TaskControl) private readonly tasks: TaskControl,
    @Inject(ModelClient) private readonly modelClient: Pick<ModelClient, 'call'>,
    @Inject(AgentsEmbeddings) private readonly embeddings: Pick<AgentsEmbeddings, 'embed' | 'model'>,
    @Inject(AGENTS_CONFIG) private readonly config: Pick<AgentsConfig, 'allowHttpUrls'>,
    @Inject(AGENTS_LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    const { sessions, knowledgeRows, knowledgeRunRows, tasks, embeddings, logger } = this;
    // The three agent classes the runtime launches, each a live task type: one object per task, from the factory.
    for (const type of [CHAT_TASK_TYPE, AGENT_TASK_TYPE, DEEP_AGENT_TASK_TYPE]) {
      this.handlers.registerLive({
        type,
        inputSchema: AgentTaskInputSchema,
        restore: (task) => this.factory.restore(task),
      });
    }
    this.handlers.register(
      createKnowledgeExtractHandler({
        db: this.db,
        sessions,
        knowledgeRows,
        knowledgeRunRows,
        mcpServerRows: this.mcpServerRows,
        messageRows: this.messageRows,
        codeCallRows: this.codeCallRows,
        tasks,
        modelClient: this.modelClient,
        embeddings,
        store: this.vectorStore,
      }),
    );
    this.handlers.register(
      createKnowledgeEmbedHandler({ knowledgeRows, knowledgeRunRows, embeddings, store: this.vectorStore }),
    );
    this.eventConsumers.register(createStopChildrenOnFailure({ tasks, sessions, logger }));
    this.eventConsumers.register(
      createKnowledgeTrigger({ db: this.db, tasks, sessionRows: this.sessionRows, knowledgeRunRows, logger }),
    );
  }

  /**
   * Closes the registration of tools: every module has registered its own in `onModuleInit`. Records and their
   * models are checked at each start; no MCP connection is opened (a connection lives for one call).
   */
  onApplicationBootstrap(): void {
    const startedAt = Date.now();
    this.registry.seal();
    this.logger.info('agents started', {
      tools: this.registry.toolNames(),
      allowHttpUrls: this.config.allowHttpUrls,
      durationMs: Date.now() - startedAt,
    });
  }

  /** Logs the stop; nothing of MCP outlives a call, so nothing is closed. */
  onApplicationShutdown(): void {
    this.logger.info('agents stopped');
  }
}
