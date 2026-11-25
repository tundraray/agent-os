import { z } from 'zod';

/**
 * Value sets of the agents package (design-agents.md, Contract Definitions). They are exported as
 * values: the CHECK domains of the `agent_*` tables in schema `app` are built from them.
 */

/**
 * Runtime task types of the agents, one per class the runtime launches: an ordinary agent (an agent's record,
 * a deep agent's subagent), a conversation's root and a deep agent.
 */
export const AGENT_TASK_TYPE = 'agent';
export const CHAT_TASK_TYPE = 'chat';
export const DEEP_AGENT_TASK_TYPE = 'deep_agent';
/** Task type of a training's root: the trainer of one agent (self-learning design-training.md, KD-1). */
export const TRAINER_TASK_TYPE = 'trainer';

/** Every task type that is an agent: such a task has a session and a snapshot in its input. */
export const AGENT_TASK_TYPES: readonly string[] = [
  AGENT_TASK_TYPE,
  CHAT_TASK_TYPE,
  DEEP_AGENT_TASK_TYPE,
  TRAINER_TASK_TYPE,
];

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

/**
 * Event recorded in history as an entry of kind `event`; `failed` carries its reason. `forked` follows the
 * history a fork copied from its source.
 */
export const HistoryEventSchema = z.enum([
  'interrupted',
  'stopped',
  'stopped_with_parent',
  'continued',
  'failed',
  'compacted',
  'forked',
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
  /** A changing call of a training tree, recorded and never sent (self-learning design-training.md KD-3). */
  'recorded',
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
  'admin_only',
  'builtin',
  'name_taken',
  'system_name',
  'server_not_allowed',
  'all_servers_not_allowed',
  'agent_not_visible',
  'version_conflict',
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
/** The trainer's trial run of a draft script (self-learning design-training.md, trainer tools). */
export const TRY_SCRIPT_TOOL = 'try_script';

const MAX_SCRIPT_BYTES = 64 * 1024;

/**
 * What hides a script's code from the employee (KD-9): direction overrides and isolates
 * (U+202A–U+202E, U+2066–U+2069), zero-width characters (U+200B–U+200D, U+2060, U+FEFF), and the
 * line terminators a browser draws inside a line (U+2028, U+2029, a CR not followed by LF) — code
 * after one of them in a `//` comment runs, while the card shows it as part of the comment. CRLF is allowed.
 */
const HIDDEN_CHARACTER =
  /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF\u2028\u2029]|\r(?!\n)/;

function codePointLabel(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The code of a run: of `run_code` and of a saved script alike (self-learning design-scripts.md, KD-1). */
export const ScriptCodeSchema = z
  .string()
  .min(1)
  .superRefine((script, ctx) => {
    const bytes = utf8Bytes(script);
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
  });

/** Arguments of `run_code`; a violation is refused as `invalid_arguments`, like any tool's arguments. */
export const RunCodeArgsSchema = z.object({
  description: z.string().min(1).max(300),
  class: z.enum(['read', 'write']),
  script: ScriptCodeSchema,
});
export type RunCodeArgs = z.infer<typeof RunCodeArgsSchema>;

const SCRIPT_TOOL_PREFIX = 'script__';

/** The tool a saved script is to its owner's model (KD-4). */
export function scriptToolName(name: string): string {
  return `${SCRIPT_TOOL_PREFIX}${name}`;
}

/** The script's name of a call of a saved script, without the prefix; null for any other call. */
export function scriptNameOf(
  tool: string,
  server: string | null,
): string | null {
  return server === null && tool.startsWith(SCRIPT_TOOL_PREFIX)
    ? tool.slice(SCRIPT_TOOL_PREFIX.length)
    : null;
}

/** The call runs code: `run_code`, `try_script` or a saved script; an MCP server may name a tool the same. */
export function isCodeRunCall(tool: string, server: string | null): boolean {
  return (
    server === null &&
    (tool === RUN_CODE_TOOL ||
      tool === TRY_SCRIPT_TOOL ||
      scriptNameOf(tool, server) !== null)
  );
}

/** Arguments of a saved script's tool: `input` reaches the script as the global `input`. */
export const ScriptToolArgsSchema = z.object({
  input: z
    .unknown()
    .optional()
    .refine(
      (input) =>
        input === undefined ||
        utf8Bytes(JSON.stringify(input)) <= MAX_SCRIPT_BYTES,
      { message: `input is over ${MAX_SCRIPT_BYTES} bytes as JSON` },
    ),
});

/** `content` of the confirmation request of a `write` run: the "Can call" list in display order (KD-10). */
export const RunCodeConfirmationContentSchema = z.object({
  canCall: z.array(z.object({ name: z.string(), changes: z.boolean() })),
});
export type RunCodeConfirmationContent = z.infer<
  typeof RunCodeConfirmationContentSchema
>;

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
