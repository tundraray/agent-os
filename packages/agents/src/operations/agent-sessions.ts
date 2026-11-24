import type {
  ChipRecord,
  ConfirmationStatus,
  ToolCallState,
} from '@agent-os/contracts';
import type { RootPosition } from '@agent-os/db';

import type { PageEntry } from '../store/history';
import type { ToolDisplay } from '../tools/tool';

/**
 * The requests and results of the agent operations over the runtime (design-agents.md, Contract «Операции
 * агентов», Security; plan Notes 1, 2): `StartOperations`, `ControlOperations` and `ViewOperations`. Each
 * operation calls a runtime operation with `ownerId` first — it checks the owner — and reads `agent_*`
 * only after it, so another owner's agent answers exactly as a missing one (AC-13.3, NFR-06). Every
 * operation is logged with its ids and outcome.
 */

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
      readonly content: {
        readonly text: string;
        readonly toolCalls: readonly AnswerToolCall[];
      };
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
  readonly status: ConfirmationStatus;
  /** Set when `resolved`: the decision and the arguments the call ran with (edited or requested). */
  readonly resolution: {
    readonly approve: boolean;
    readonly args: unknown;
  } | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}
