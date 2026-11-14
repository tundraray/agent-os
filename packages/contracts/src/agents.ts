import { z } from 'zod';

/**
 * Value sets of the agents package (design-agents.md, Contract Definitions). They are exported as
 * values: the CHECK domains of the `agent_*` tables in schema `app` are built from them.
 */

/** Runtime task type of an agent. */
export const AGENT_TASK_TYPE = 'agent';

/** Event written in every transaction that appended to an agent's history. */
export const AGENTS_HISTORY_APPENDED = 'agents.history_appended';

/** Decision kind of a tool call that waits for the employee's confirmation. */
export const AGENTS_TOOL_CONFIRMATION = 'agents.tool_confirmation';

/** Kind of a history entry. */
export const HistoryEntryKindSchema = z.enum([
  'task',
  'user_message',
  'agent_message',
  'child_report',
  'model_answer',
  'tool_result',
  'notice',
  'event',
  'compaction',
]);
export type HistoryEntryKind = z.infer<typeof HistoryEntryKindSchema>;

/** Event recorded in history as an entry of kind `event`; `failed` carries its reason. */
export const HistoryEventSchema = z.enum([
  'interrupted',
  'stopped',
  'stopped_with_parent',
  'continued',
  'failed',
  'compacted',
]);
export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

/** State of a tool call; the outcome is set exactly when the state is `done`. */
export const ToolCallStateSchema = z.enum([
  'requested',
  'awaiting_confirmation',
  'sending',
  'done',
]);
export type ToolCallState = z.infer<typeof ToolCallStateSchema>;

/** Outcome of a finished tool call. */
export const ToolOutcomeSchema = z.enum([
  'success',
  'empty',
  'tool_error',
  'transport_failure',
  'refused',
  'rejected',
  'interrupted',
  'unknown',
]);
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;

/** Why a tool call was refused (outcome `refused`). */
export const ToolRefusalReasonSchema = z.enum([
  'tool_not_in_definition',
  'no_access',
  'not_allowed',
  'depth_limit',
  'unknown_model',
  'unknown_agent',
  'invalid_arguments',
]);
export type ToolRefusalReason = z.infer<typeof ToolRefusalReasonSchema>;

/** Status of an agent for the employee, derived from the runtime task status and the session marks. */
export const AgentStatusSchema = z.enum([
  'working',
  'awaiting_confirmation',
  'interrupted',
  'completed',
  'failed',
  'stopped',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** Kinds of inbox messages the agents package sends; `child_finished` comes from the runtime. */
export const AgentMessageKindSchema = z.enum([
  'user_message',
  'agent_message',
  'interrupt',
]);
export type AgentMessageKind = z.infer<typeof AgentMessageKindSchema>;
