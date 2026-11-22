import {
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
import { Inbox, TaskControl } from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';

import type { AccessAudit, AccessGate } from '../access-gate';
import { ACCESS_AUDIT, ACCESS_GATE, AGENTS_CONFIG } from '../agents.tokens';
import type { AgentsConfig } from '../config';
import { AgentsEmbeddings } from '../embeddings/embeddings';
import type { KnowledgeVectorStore } from '../knowledge/vector-store';
import { ModelClient } from '../model/model-client';
import { CallRecords } from '../store/call-records';
import { History } from '../store/history';
import { Sessions } from '../store/sessions';
import { ToolRegistry } from '../tools/tool-registry';
import { ToolRunner } from '../tools/tool-runner';

/** What an agent works with: one holder shared by every agent object, handed to each by `AgentFactory`. */
@Injectable()
export class AgentDeps {
  /** `AGENT_COMPACT_AT_TOKENS`. */
  readonly compactAtTokens: number;

  constructor(
    /** The savepoint of a learning session's question outcome (`ensureQuestionVector`). */
    @Inject(Db) readonly db: Db,
    /** The session of the agent, made from its snapshot and read back; `sessionRows` — its other reads and writes. */
    @Inject(Sessions) readonly sessions: Sessions,
    @Inject(AgentSessionsRepository) readonly sessionRows: AgentSessionsRepository,
    /** The session's history as entries; `messageRows` — the reads that give no entry. */
    @Inject(History) readonly history: History,
    @Inject(AgentMessagesRepository) readonly messageRows: AgentMessagesRepository,
    /** The closings of the step's calls. */
    @Inject(CallRecords) readonly callRecords: CallRecords,
    /** The full result of a direct MCP call, written with its closing. */
    @Inject(AgentToolResultsRepository) readonly toolResultRows: AgentToolResultsRepository,
    /** The session's task list, read for the task block of every model call. */
    @Inject(AgentSessionTasksRepository) readonly sessionTaskRows: AgentSessionTasksRepository,
    /** The graph, its settings, the question row and the registry of a session that learns (self-learning KD-6). */
    @Inject(AgentKnowledgeRepository) readonly knowledgeRows: AgentKnowledgeRepository,
    @Inject(AgentKnowledgeRunsRepository) readonly knowledgeRunRows: AgentKnowledgeRunsRepository,
    @Inject(AgentMcpServersRepository) readonly mcpServerRows: AgentMcpServersRepository,
    /**
     * The tools library: the session's tools for the task's owner and the agent's declaration — for the model call
     * and for the check of its calls; `toolOf` keeps the log rule of a tool the session was not offered.
     */
    @Inject(ToolRegistry) readonly registry: Pick<ToolRegistry, 'toolsFor' | 'checkTools' | 'toolOf'>,
    @Inject(ToolRunner) readonly runner: ToolRunner,
    /** Asked once per tool step before the calls: the pairs `check` refuses with (design-access.md KD-1). */
    @Inject(ACCESS_GATE) readonly access: Pick<AccessGate, 'tools'>,
    /**
     * Gets the `access_denied` record of a refused model call and of each `no_access` the tool step's check
     * decides, and the `tool_call_refused` record of each MCP call it refuses for its arguments (KD-6).
     */
    @Inject(ACCESS_AUDIT) readonly audit: AccessAudit,
    @Inject(ModelClient) readonly modelClient: Pick<ModelClient, 'call'>,
    /** Children of the agent: the end of a turn waits for the unfinished ones (DC-3). */
    @Inject(TaskControl) readonly tasks: Pick<TaskControl, 'listTree'>,
    /** `child_finished` notices still pending in the agent's queue (plan Notes 6). */
    @Inject(Inbox) readonly inbox: Pick<Inbox, 'listPending'>,
    /** Closeness of the graph's records to the session's question, for the knowledge block (KD-6). */
    @Inject(AgentKnowledgeVectorsRepository) readonly vectorStore: KnowledgeVectorStore,
    /** The question vector of a session that learns (self-learning KD-6); the only caller in a run. */
    @Inject(AgentsEmbeddings) readonly embeddings: Pick<AgentsEmbeddings, 'embed'>,
    @Inject(AGENTS_CONFIG) config: Pick<AgentsConfig, 'compactAtTokens'>,
  ) {
    this.compactAtTokens = config.compactAtTokens;
  }
}
