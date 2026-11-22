import type { AgentTasksView, ChipRecord, DecisionStatus, ToolCallState } from '@agent-os/contracts';
import type { ResolveOutcome } from '@agent-os/runtime';

import type { AgentView } from '../agent-view';
import type { DeepAgentRun } from '../deep/deep-agent-run';
import type { RunSnapshot } from '../start/snapshot';
import type { PageEntry } from '../store/history.repository';
import type { RootPosition, RootSession } from '../store/sessions.repository';
import type { ToolDisplay } from '../tools/tool';

/** The root of a conversation (design-runtime.md, «Операции `agents`»): it runs the `chat` record. */
export interface StartRequest {
  /** The id of the new root, a UUID; a new one when absent. A taken id is the runtime's `TASK_EXISTS`. */
  readonly agentId?: string;
  readonly ownerId: string;
  readonly prompt: string;
  readonly description: string;
  /** The chip of the conversation's first message: it stays on the root's `task` entry. */
  readonly record?: ChipRecord;
}

export interface AgentRef {
  readonly agentId: string;
  readonly ownerId: string;
}

export interface SendRequest extends AgentRef {
  readonly text: string;
  /** The message's chip (KD-4): the model and the history get it with the text. */
  readonly record?: ChipRecord;
}

/** A page of the owner's root sessions: strictly after `after`, at most `limit`; all without either. */
export interface RootsRequest {
  readonly ownerId: string;
  readonly after?: RootPosition;
  readonly limit?: number;
}

export interface HistoryRequest extends AgentRef {
  /** Entries with a greater `seq`; 0 by default. */
  readonly afterSeq?: number;
  /** At most this many entries. */
  readonly limit: number;
}

export interface ResolveConfirmationRequest {
  readonly decisionId: string;
  readonly ownerId: string;
  readonly approve: boolean;
  /** The employee's edit of the arguments; only a tool that allows it accepts one. */
  readonly args?: unknown;
}

/** One tool call of a model answer as `history` shows it; an open call carries its state. */
export interface AnswerToolCall extends ToolDisplay {
  readonly callId: string;
  readonly tool: string;
  /** MCP server id; null for built-in and registered tools. */
  readonly server: string | null;
  readonly args: unknown;
  readonly state: ToolCallState;
}

export type StoredResult = Extract<PageEntry, { kind: 'tool_result' }>;

/** A `tool_result` as `history` shows it: without the started child's id, kept for incident analysis only. */
export type ShownResult = Omit<StoredResult, 'content'> & {
  readonly content: Omit<StoredResult['content'], 'childTaskId'>;
};

/**
 * An entry of `history` (design-agents.md, HistoryEntry): as stored, except that each tool call of a
 * `model_answer` carries its state, folded from the call's records, which are not entries of their own.
 */
export type AgentHistoryEntry =
  | Exclude<PageEntry, { kind: 'model_answer' | 'tool_result' }>
  | ShownResult
  | {
      readonly seq: number;
      readonly kind: 'model_answer';
      readonly createdAt: Date;
      readonly content: { readonly text: string; readonly toolCalls: readonly AnswerToolCall[] };
    };

/** A confirmation request of a tree in any status (design-chat.md, Confirmation; KD-6). */
export interface AgentConfirmation extends ToolDisplay {
  readonly decisionId: string;
  readonly agentId: string;
  /** The agent's description. */
  readonly description: string;
  /** Decision kind: `agents.tool_confirmation` or the kind of an upper part's tool. */
  readonly kind: string;
  readonly tool: string;
  readonly server: string | null;
  /** The arguments the model requested. */
  readonly args: unknown;
  /** The card content: the tool's `confirmation.content(args)`, or `{ toolDescription }`. */
  readonly content: unknown;
  readonly status: DecisionStatus;
  /** Set when `resolved`: the decision and the arguments the call ran with (edited or requested). */
  readonly resolution: { readonly approve: boolean; readonly args: unknown } | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

/**
 * The operations of agents (design-agents.md, «Операции агентов»; plan Notes 1, 2): the contract
 * `createAgentSessions` implements from `start-operations`, `control-operations` and `view-operations`.
 */
export interface AgentSessions {
  start(request: StartRequest): Promise<{ agentId: string }>;
  send(request: SendRequest): Promise<{ messageId: string }>;
  /** Marks the agent «прерван»: it closes its open calls and waits for a message (KD-3). */
  interrupt(request: AgentRef): Promise<'interrupted' | 'not_active'>;
  stop(request: AgentRef): Promise<string[]>;
  restart(request: AgentRef): Promise<{ agentId: string }>;
  /** The run's snapshot, for the view of a run; `null` when the task is not an agent. */
  snapshot(agentId: string, ownerId: string): Promise<RunSnapshot | null>;
  /**
   * The run view of a deep agent (deep-agents KD-2): its record, brief, team, steps and limit refusals.
   * A missing agent, another owner's and one that is not a deep agent are alike `RUN_NOT_FOUND`.
   */
  run(agentId: string, ownerId: string): Promise<DeepAgentRun>;
  /**
   * The task list of the session by number (design-task-list.md, `GET /api/agents/:agentId/tasks`), the root
   * included, and the tasks of its trackers in order (design-task.md, «Запись и маршрут»); each empty when there
   * is none. A missing and another owner's agent are alike `AGENT_NOT_FOUND`.
   */
  taskList(agentId: string, ownerId: string): Promise<AgentTasksView>;
  get(agentId: string, ownerId: string): Promise<AgentView>;
  list(rootId: string, ownerId: string): Promise<AgentView[]>;
  history(request: HistoryRequest): Promise<AgentHistoryEntry[]>;
  confirmations(rootId: string, ownerId: string): Promise<AgentConfirmation[]>;
  resolveConfirmation(request: ResolveConfirmationRequest): Promise<ResolveOutcome>;
  /**
   * The owner's root session — the conversation the employee sees; `undefined` for a missing one,
   * another owner's and a session that is not a root.
   */
  root(rootId: string, ownerId: string): Promise<RootSession | undefined>;
  /** The owner of a root session, whoever it is: for a signal of a tree that carries no owner. */
  rootOwner(rootId: string): Promise<string | undefined>;
  /** The owner's root sessions, last changed first (`updatedAt` DESC, then `rootId` DESC). */
  roots(request: RootsRequest): Promise<RootSession[]>;
  /** Moves the owner's root session to the top of the list. */
  touchRoot(rootId: string, ownerId: string): Promise<void>;
  /** Sets the title and moves the root session up; `undefined` as in `root`. */
  renameRoot(rootId: string, ownerId: string, title: string): Promise<RootSession | undefined>;
  /** Writes a generated title only into an empty one; `true` when it was written. */
  titleRootIfEmpty(rootId: string, ownerId: string, title: string): Promise<boolean>;
  /**
   * Stops the conversation's tree and marks it and its root session deleted, in one transaction: from
   * then on the conversation answers as a missing one everywhere. The rows stay. `AGENT_NOT_FOUND` for
   * a missing, another owner's or an already deleted root.
   */
  deleteRoot(rootId: string, ownerId: string): Promise<void>;
}
