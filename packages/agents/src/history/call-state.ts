import { RUN_CODE_TOOL, type ToolCallState, ToolCallStateSchema } from '@agent-os/contracts';

import { mcpToolName } from '../mcp/mcp-tool';
import type { HistoryContent, HistoryEntry } from './history';

/** One tool call of a model answer with what its records say about it. */
export interface CallState {
  readonly callId: string;
  /** `seq` of the `model_answer` that requested the call. */
  readonly answerSeq: number;
  /** Position of the call within its answer. */
  readonly position: number;
  readonly tool: string;
  /** MCP server id; null for built-in and registered tools. */
  readonly server: string | null;
  /** The arguments the call has for the model and the tool: the ones sent when the employee edited them. */
  readonly args: unknown;
  readonly state: ToolCallState;
  /** When the confirmed call went out (`tool_sent`); `null` for a call without the intent. */
  readonly sentAt: string | null;
  /**
   * The tracker tasks a sent `task` call waits for and the task of the list it names (deep-agents/design-task.md
   * KD-4, KD-8); `null` for every other call. Only the step that delivers `tasks_finished` closes such a call.
   */
  readonly delegation: CallDelegation | null;
  /** How many attempts of a `run_code` read run started. */
  readonly attempts: number;
  /** The closing record; `null` while the call is open. */
  readonly result: HistoryContent<'tool_result'> | null;
}

/** What the `tool_sent` of an accepted `task` call holds. */
export interface CallDelegation {
  readonly taskIds: readonly string[];
  readonly listTask: number | null;
}

const { requested, awaiting_confirmation: awaiting, sending, done } = ToolCallStateSchema.enum;

/** A sent `task` call: never closed as unknown or interrupted, only with its tracker's outcomes. */
export function isDelegated(call: Pick<CallState, 'delegation'>): boolean {
  return call.delegation !== null;
}

/** The name the model called: the history keeps an MCP tool as its server and raw name. */
export function requestedName(call: { readonly tool: string; readonly server: string | null }): string {
  return call.server === null ? call.tool : mcpToolName(call.server, call.tool);
}

/** A `run_code` call: the built-in tool, not an MCP tool of the same name. */
export function isRunCodeCall(call: { readonly tool: string; readonly server: string | null }): boolean {
  return call.tool === RUN_CODE_TOOL && call.server === null;
}

interface Folding {
  call: Omit<CallState, 'state'>;
  confirmationAsked: boolean;
}

function stateOf({ call, confirmationAsked }: Folding): ToolCallState {
  if (call.result !== null) return done;
  if (call.sentAt !== null) return sending;
  return confirmationAsked ? awaiting : requested;
}

/**
 * The tool calls of the given entries with their state, by answer and position — the one place a
 * call's state is derived (Invariants 1, 2): a `tool_result` closes the call; without one, a
 * `tool_sent` means the call may have reached its server; a `tool_confirmation` without the intent
 * means it waits for the employee; otherwise it is only requested. A record whose answer is not among
 * the entries is skipped. Pure: the entries are in `seq` order, each answer before its records.
 */
export function foldCalls(entries: readonly HistoryEntry[]): CallState[] {
  const calls = new Map<string, Folding>();
  const update = (callId: string, change: (folding: Folding) => void): void => {
    const folding = calls.get(callId);
    if (folding !== undefined) change(folding);
  };

  for (const entry of entries) {
    switch (entry.kind) {
      case 'model_answer':
        entry.content.toolCalls.forEach((call, position) => {
          calls.set(call.callId, {
            call: {
              ...call,
              answerSeq: entry.seq,
              position,
              sentAt: null,
              delegation: null,
              attempts: 0,
              result: null,
            },
            confirmationAsked: false,
          });
        });
        break;
      case 'tool_confirmation':
        update(entry.content.callId, (folding) => {
          folding.confirmationAsked = true;
        });
        break;
      case 'tool_sent':
        update(entry.content.callId, (folding) => {
          const { content } = entry;
          const args = content.args === undefined ? folding.call.args : content.args;
          const delegation =
            content.taskIds === undefined ? null : { taskIds: content.taskIds, listTask: content.taskId ?? null };
          folding.call = { ...folding.call, args, sentAt: content.startedAt, delegation };
        });
        break;
      case 'run_attempt':
        update(entry.content.callId, (folding) => {
          folding.call = { ...folding.call, attempts: entry.content.attempt };
        });
        break;
      case 'tool_result':
        update(entry.content.callId, (folding) => {
          folding.call = { ...folding.call, result: entry.content };
        });
        break;
      default:
        break;
    }
  }
  return [...calls.values()].map((folding) => ({ ...folding.call, state: stateOf(folding) }));
}

/** The calls that have no result yet, by answer and position. */
export function openCalls(entries: readonly HistoryEntry[]): CallState[] {
  return foldCalls(entries).filter((call) => call.state !== done);
}
