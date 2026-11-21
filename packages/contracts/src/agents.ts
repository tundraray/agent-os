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
  'tool_confirmation',
  'tool_decision',
  'tool_sent',
  'run_attempt',
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

/**
 * Kinds that record the state of one tool call and are keyed by its `callId`. A call is the item of a
 * `model_answer`; its state is which of these records exist (`foldCalls` of the agents package).
 */
export const CALL_RECORD_KINDS = [
  'tool_confirmation',
  'tool_decision',
  'tool_sent',
  'run_attempt',
  'tool_result',
] as const satisfies readonly HistoryEntryKind[];

/** Call records a call has at most one of; a `run_code` read run may have two `run_attempt` records. */
export const SINGLE_CALL_RECORD_KINDS = [
  'tool_confirmation',
  'tool_decision',
  'tool_sent',
  'tool_result',
] as const satisfies readonly HistoryEntryKind[];

/** State of a tool call, derived from its records; `done` is a call with a `tool_result`. */
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
  'auth_required',
]);
export type ToolOutcome = z.infer<typeof ToolOutcomeSchema>;

/** Why a tool call was refused (outcome `refused`). */
export const ToolRefusalReasonSchema = z.enum([
  'tool_not_in_definition',
  'no_access',
  'not_allowed',
  'depth_limit',
  'model_not_connected',
  'model_not_allowed',
  'model_not_configured',
  'provider_missing',
  'provider_disabled',
  'provider_key_missing',
  'unknown_agent',
  'invalid_arguments',
  'not_callable_from_code',
  'changing_in_read_run',
  'not_in_confirmed_script',
  'record_unavailable',
  'run_limit',
  'read_only',
  'shared',
  'repeated_call',
]);
export type ToolRefusalReason = z.infer<typeof ToolRefusalReasonSchema>;

/**
 * Why an agent failed by itself (`failureReason` of its view): its turn limit, the provider, or a refusal
 * of the access gate. `provider_*` name a provider state or rejection; `model_error` is any other
 * provider error. The runtime's own reasons are `RuntimeFailureReason`.
 */
export const AgentFailureReasonSchema = z.enum([
  'turn_limit',
  'model_error',
  'provider_missing',
  'provider_disabled',
  'provider_key_missing',
  'provider_key_rejected',
  'provider_unavailable',
  'provider_tools_rejected',
  'owner_disabled',
  'quota_exhausted',
  'model_not_connected',
  'model_not_allowed',
  'no_models_allowed',
]);
export type AgentFailureReason = z.infer<typeof AgentFailureReasonSchema>;

/** Built-in tool that runs a model-written script (design-code-execution.md, RunCodeArgs). */
export const RUN_CODE_TOOL = 'run_code';

const MAX_SCRIPT_BYTES = 64 * 1024;

/**
 * What hides a script's code from the employee (KD-9): direction overrides and isolates
 * (U+202A–U+202E, U+2066–U+2069), zero-width characters (U+200B–U+200D, U+2060, U+FEFF), and the
 * line terminators a browser draws inside a line (U+2028, U+2029, a CR not followed by LF) — code
 * after one of them in a `//` comment runs, while the card shows it as part of the comment. CRLF is allowed.
 */
const HIDDEN_CHARACTER = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF\u2028\u2029]|\r(?!\n)/;

function codePointLabel(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Arguments of `run_code`; a violation is refused as `invalid_arguments`, like any tool's arguments. */
export const RunCodeArgsSchema = z.object({
  description: z.string().min(1).max(300),
  class: z.enum(['read', 'write']),
  script: z
    .string()
    .min(1)
    .superRefine((script, ctx) => {
      const bytes = new TextEncoder().encode(script).length;
      if (bytes > MAX_SCRIPT_BYTES) {
        ctx.addIssue({
          code: 'custom',
          message: `script is ${bytes} bytes in UTF-8; the limit is ${MAX_SCRIPT_BYTES}`,
        });
      }
      const hidden = HIDDEN_CHARACTER.exec(script);
      if (hidden) {
        ctx.addIssue({
          code: 'custom',
          message: `script contains the hidden character ${codePointLabel(hidden[0])}; remove it or write it as an escape`,
        });
      }
    }),
});
export type RunCodeArgs = z.infer<typeof RunCodeArgsSchema>;

/** `content` of the confirmation request of a `write` run: the "Can call" list in display order (KD-10). */
export const RunCodeConfirmationContentSchema = z.object({
  canCall: z.array(z.object({ name: z.string(), changes: z.boolean() })),
});
export type RunCodeConfirmationContent = z.infer<typeof RunCodeConfirmationContentSchema>;

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
