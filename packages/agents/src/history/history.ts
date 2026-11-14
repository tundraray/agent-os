import {
  AgentStatusSchema,
  HistoryEventSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  type HistoryEntryKind,
} from '@agent-os/contracts';
import { z } from 'zod';

/** How a child agent ended, as its parent learns it from `child_finished`. */
const ChildEndSchema = AgentStatusSchema.extract(['completed', 'failed', 'stopped']);

/**
 * The content of a history entry by its kind (design-agents.md, Contract «HistoryEntry»): the `content`
 * of an `agent_messages` row. The tool calls of a `model_answer` live in `agent_tool_calls`, one row per
 * call, linked to the answer by its `seq`.
 */
export const HistoryContentSchemas = {
  /** The task text; the agent's first own entry. */
  task: z.object({ text: z.string() }),
  /** A message of the employee. */
  user_message: z.object({ text: z.string() }),
  /** A message of the parent agent. */
  agent_message: z.object({ text: z.string(), agentId: z.string() }),
  /** A child's report: written when the runtime delivers `child_finished`. */
  child_report: z.object({
    agentId: z.string(),
    description: z.string(),
    status: ChildEndSchema,
    reason: z.string().nullable(),
    /** The report text; none when the child ended without one. */
    text: z.string().nullable(),
    toolCalls: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  /** The text of a model answer; its calls are the `agent_tool_calls` rows with this `seq`. */
  model_answer: z.object({ text: z.string() }),
  /** The result of one tool call. */
  tool_result: z.object({
    callId: z.string(),
    tool: z.string(),
    /** MCP server id; null for built-in and registered tools. */
    server: z.string().nullable(),
    args: z.unknown(),
    outcome: ToolOutcomeSchema,
    refusalReason: ToolRefusalReasonSchema.nullable(),
    text: z.string().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  }),
  /** A message of the package's code to the model, such as a refusal to finish. */
  notice: z.object({ text: z.string() }),
  /** A lifecycle event; `failed` carries its reason. */
  event: z.object({ event: HistoryEventSchema, reason: z.string().nullable() }),
  /** A summary that replaces for the model every entry through `throughSeq` (KD-7). */
  compaction: z.object({ summary: z.string(), throughSeq: z.number().int().nonnegative() }),
} as const satisfies Record<HistoryEntryKind, z.ZodType>;

export type HistoryContent<K extends HistoryEntryKind> = z.infer<(typeof HistoryContentSchemas)[K]>;

/** One entry of an agent's history: append-only, `seq` grows within the session (Invariant 5). */
export type HistoryEntry = {
  readonly [K in HistoryEntryKind]: {
    readonly seq: number;
    readonly kind: K;
    readonly createdAt: Date;
    readonly content: HistoryContent<K>;
  };
}[HistoryEntryKind];

/** One tool call of a model answer, as the provider messages are built from it (an `agent_tool_calls` row). */
export interface ToolCallRecord {
  readonly callId: string;
  /** `seq` of the `model_answer` that requested the call. */
  readonly answerSeq: number;
  /** Position of the call within its answer. */
  readonly position: number;
  readonly tool: string;
  readonly args: unknown;
}
