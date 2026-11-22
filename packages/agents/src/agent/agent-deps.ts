import type { Database } from '@agent-os/db';
import type { Runtime } from '@agent-os/runtime';

import type { AccessAudit, AccessGate } from '../access-gate';
import type { AgentsEmbeddings } from '../embeddings/embeddings';
import type { KnowledgeVectorStore } from '../knowledge/vector-store';
import type { ModelClient } from '../model/model-client';
import type { ToolRegistry } from '../tools/tool-registry';
import type { ToolRunner } from '../tools/tool-runner';

/** What an agent works with, given once to its constructor by the composition root (`create-agents.ts`). */
export interface AgentDeps {
  /** Reads the session and its history outside the commit: only steps of this agent write them, one at a time. */
  readonly database: Database;
  /**
   * The tools library: the session's tools for the task's owner and the agent's declaration — for the model call
   * and for the check of its calls; `toolOf` keeps the log rule of a tool the session was not offered.
   */
  readonly registry: Pick<ToolRegistry, 'toolsFor' | 'checkTools' | 'toolOf'>;
  readonly runner: ToolRunner;
  /** Asked once per tool step before the calls: the pairs `check` refuses with (design-access.md KD-1). */
  readonly access: Pick<AccessGate, 'tools'>;
  /**
   * Gets the `access_denied` record of a refused model call and of each `no_access` the tool step's check
   * decides, and the `tool_call_refused` record of each MCP call it refuses for its arguments (KD-6).
   */
  readonly audit: AccessAudit;
  readonly modelClient: Pick<ModelClient, 'call'>;
  /** Children of the agent: the end of a turn waits for the unfinished ones (DC-3). */
  readonly tasks: Pick<Runtime['tasks'], 'listTree'>;
  /** `child_finished` notices still pending in the agent's queue (plan Notes 6). */
  readonly inbox: Pick<Runtime['inbox'], 'listPending'>;
  /** Closeness of the graph's records to the session's question, for the knowledge block (KD-6). */
  readonly vectorStore: KnowledgeVectorStore;
  /** The question vector of a session that learns (self-learning KD-6); the only caller in a run. */
  readonly embeddings: Pick<AgentsEmbeddings, 'embed'>;
  /** `AGENT_COMPACT_AT_TOKENS`. */
  readonly compactAtTokens: number;
}
