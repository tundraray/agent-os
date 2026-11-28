import type { Logger } from '@agent-os/common';
import { AGENT_TASK_TYPES } from '@agent-os/contracts';
import {
  AgentsRepository,
  ConversationsRepository,
  DocumentsRepository,
  MemoriesRepository,
  MessagesRepository,
  ConversationTasksRepository,
  ToolResultsRepository,
  SettingsRepository,
  TrainingsRepository,
} from '@agent-os/db';
import {
  HandlerRegistry,
  TaskControl,
  TaskEndHooks,
  TaskInterruptHooks,
} from '@agent-os/runtime';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import type { AccessAudit, AccessGate } from './access-gate';
import { AgentFactory } from './agent/agent-factory';
import { writePartialAnswer } from './agent/partial-answer';
import {
  ACCESS_AUDIT,
  ACCESS_GATE,
  AGENTS_CONFIG,
  AGENTS_LOGGER,
  MASK_SECRETS,
  RECORD_LIBRARY,
} from './agents.tokens';
import type { AgentsConfig } from './config';
import { ModelClient } from './model/model-client';
import { createStartDeepAgentTool } from './deep/start-deep-agent';
import { createTaskTool } from './deep/task-delegation';
import { AgentsProviders } from './providers/provider-registry';
import type { RecordLibrary } from './start/record-library';
import { auditStartRefusal, resolveNamedStart } from './start/resolve-start';
import { History } from './store/history';
import { MemoryRecords } from './store/memory-records';
import { AgentTaskInputSchema, Sessions } from './store/sessions';
import { createSystemTools } from './tools/system/index';
import { createMemoryTools } from './tools/system/memory-tools';
import { createNotepadTools } from './tools/system/notepad-tools';
import { createTaskListTools } from './tools/system/task-list-tools';
import { RunCodeTool } from './tools/external/run-code';
import { ToolRegistry } from './tools/tool-registry';
import { createProposeVersionTool } from './training/propose-version';
import { createTrainerTools } from './training/trainer-tools';
import { createTryScriptTool } from './training/try-script';

/**
 * Registers the system tools in the tools library (design-agents.md, «Инструменты»): the library knows none of
 * them by name, and they reach a session by its agent's declaration. Upper parts register their own tools the
 * same way, in their `onModuleInit`.
 */
@Injectable()
export class SystemToolsRegistration implements OnModuleInit {
  constructor(
    @Inject(ToolRegistry)
    private readonly registry: Pick<
      ToolRegistry,
      'register' | 'declaredMcpTools'
    >,
    @Inject(Sessions) private readonly sessions: Sessions,
    @Inject(MessagesRepository)
    private readonly messageRows: MessagesRepository,
    @Inject(History) private readonly history: History,
    @Inject(ToolResultsRepository)
    private readonly toolResultRows: ToolResultsRepository,
    @Inject(SettingsRepository)
    private readonly settingsRows: SettingsRepository,
    @Inject(ConversationTasksRepository)
    private readonly sessionTaskRows: ConversationTasksRepository,
    @Inject(MemoriesRepository)
    private readonly memoryRows: MemoriesRepository,
    @Inject(MemoryRecords) private readonly memoryRecords: MemoryRecords,
    @Inject(DocumentsRepository)
    private readonly documentRows: DocumentsRepository,
    @Inject(TrainingsRepository)
    private readonly trainingRows: TrainingsRepository,
    @Inject(AgentsRepository)
    private readonly agentRows: AgentsRepository,
    @Inject(ConversationsRepository)
    private readonly conversationRows: ConversationsRepository,
    @Inject(RunCodeTool) private readonly runCode: RunCodeTool,
    @Inject(MASK_SECRETS)
    private readonly maskSecrets: (text: string) => string,
    @Inject(TaskControl)
    private readonly tasks: Pick<TaskControl, 'get' | 'listTree' | 'stop'>,
    @Inject(RECORD_LIBRARY) private readonly library: RecordLibrary,
    @Inject(ACCESS_GATE) private readonly access: AccessGate,
    @Inject(AgentsProviders)
    private readonly providers: Pick<AgentsProviders, 'connection'>,
    @Inject(ACCESS_AUDIT) private readonly audit: AccessAudit,
    @Inject(AGENTS_CONFIG)
    private readonly config: Pick<AgentsConfig, 'maxDepth'>,
    @Inject(AGENTS_LOGGER) private readonly logger: Logger,
  ) {}

  onModuleInit(): void {
    const { library, access, providers, audit, history, logger } = this;
    const startDeps = { library, access, providers, audit };
    const tools = [
      ...createSystemTools({
        ...startDeps,
        maxDepth: this.config.maxDepth,
        logger,
        sessions: this.sessions,
        messageRows: this.messageRows,
        history,
        toolResultRows: this.toolResultRows,
        settingsRows: this.settingsRows,
        tasks: this.tasks,
      }),
      // Declared by an agent that keeps a task list (design-task-list.md KD-2).
      ...createTaskListTools({ sessionTaskRows: this.sessionTaskRows, logger }),
      // Declared by a deep agent with self-learning on and each of its subagents (design-memory.md KD-4).
      ...createMemoryTools({
        records: this.memoryRecords,
        maskSecrets: this.maskSecrets,
        logger,
      }),
      // Declared by every deep agent and its subagents (design-notepad.md KD-3).
      ...createNotepadTools({
        documentRows: this.documentRows,
        settingsRows: this.settingsRows,
        logger,
      }),
      // The deep agent's tools: the root's `start_deep_agent` (deep-agents KD-2) and a deep agent's `task`.
      createStartDeepAgentTool({
        resolveNamedStart: (request) => resolveNamedStart(request, startDeps),
        answeredChip: (agentId, callId) =>
          history.answeredChip(agentId, callId),
        auditStartRefusal: (refusal) => auditStartRefusal(audit, refusal),
        logger,
      }),
      createTaskTool(),
      // Declared by the trainer only (design-training.md KD-1); `test_results` by its test-run mode.
      ...createTrainerTools({
        trainingRows: this.trainingRows,
        agentRows: this.agentRows,
        conversationRows: this.conversationRows,
        memoryRows: this.memoryRows,
        documentRows: this.documentRows,
        settingsRows: this.settingsRows,
        history,
        tasks: this.tasks,
        access,
        registry: this.registry,
        maskSecrets: this.maskSecrets,
        logger,
      }),
      createProposeVersionTool({
        trainingRows: this.trainingRows,
        agentRows: this.agentRows,
        sessionTaskRows: this.sessionTaskRows,
        logger,
      }),
      createTryScriptTool({
        trainingRows: this.trainingRows,
        agentRows: this.agentRows,
        runCode: this.runCode,
        registry: this.registry,
      }),
    ];
    for (const tool of tools) this.registry.register(tool);
  }
}

/**
 * Registers the package in the runtime (plan Notes 8): the agents (`ChatAgent`, `Agent`, `DeepAgent`, `Trainer`)
 * as the live task types of `AGENT_TASK_TYPES` — one object per task, made by `AgentFactory` — and the partial
 * answer (runtime-fixes KD-1) as the interrupt hook and as a task end hook that acts only on a `stopped` end.
 * Once every module has registered its tools it closes the tools library.
 */
/** The name of the partial answer's hooks in the runtime. */
const PARTIAL_ANSWER_HOOK = 'agents.partial-answer';

@Injectable()
export class AgentsRegistration
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  constructor(
    @Inject(HandlerRegistry) private readonly handlers: HandlerRegistry,
    @Inject(AgentFactory)
    private readonly factory: Pick<AgentFactory, 'restore'>,
    @Inject(ToolRegistry)
    private readonly registry: Pick<ToolRegistry, 'seal' | 'toolNames'>,
    @Inject(AGENTS_CONFIG)
    private readonly config: Pick<AgentsConfig, 'allowHttpUrls'>,
    @Inject(AGENTS_LOGGER) private readonly logger: Logger,
    @Inject(TaskInterruptHooks)
    private readonly interruptHooks: Pick<TaskInterruptHooks, 'register'>,
    @Inject(TaskEndHooks)
    private readonly endHooks: Pick<TaskEndHooks, 'register'>,
    @Inject(ModelClient) private readonly modelClient: ModelClient,
    @Inject(History) private readonly history: History,
  ) {}

  onModuleInit(): void {
    const partialAnswer = {
      modelClient: this.modelClient,
      history: this.history,
      logger: this.logger.child({ service: 'agents.partial-answer' }),
    };
    this.interruptHooks.register(PARTIAL_ANSWER_HOOK, (task) =>
      writePartialAnswer(partialAnswer, task, 'interrupt'),
    );
    this.endHooks.register(PARTIAL_ANSWER_HOOK, async (end) => {
      if (end.status === 'stopped')
        await writePartialAnswer(partialAnswer, end, 'stop');
    });
    // The agent classes the runtime launches, each a live task type: one object per task, from the factory.
    for (const type of AGENT_TASK_TYPES) {
      this.handlers.registerLive({
        type,
        inputSchema: AgentTaskInputSchema,
        restore: (task) => this.factory.restore(task),
      });
    }
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
