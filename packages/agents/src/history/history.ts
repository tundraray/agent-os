import {
  AgentStatusSchema,
  HistoryEventSchema,
  ToolOutcomeSchema,
  ChipRecordSchema,
  ToolRefusalReasonSchema,
  type HistoryEntryKind,
} from '@agent-os/contracts';
import { z } from 'zod';

/** How a child agent ended, as its parent learns it from `child_finished`. */
const ChildEndSchema = AgentStatusSchema.extract([
  'completed',
  'failed',
  'stopped',
]);

/** One tool call of a model answer: its place in `toolCalls` is its position in the answer. */
const AnswerCallSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  /** MCP server id; null for built-in and registered tools. */
  server: z.string().nullable(),
  args: z.unknown(),
});
export type AnswerCall = z.infer<typeof AnswerCallSchema>;

/**
 * The content of a history entry by its kind (design-agents.md, Contract «HistoryEntry»): the `content`
 * of an `messages` row. A tool call is an item of its `model_answer`; what happened to it are the
 * later call records with its `callId` (`CALL_RECORD_KINDS`), and its state is which of them exist
 * (`foldCalls`). Nothing is updated in place.
 */
export const HistoryContentSchemas = {
  /** The task text; the agent's first own entry. At a conversation's root it keeps its first message's chip. */
  task: z.object({ text: z.string(), record: ChipRecordSchema.nullable() }),
  /** A message of the employee, with the record chip it carries, if any (design-runtime.md KD-4). */
  user_message: z.object({
    text: z.string(),
    record: ChipRecordSchema.nullable(),
  }),
  /** A message of the parent agent. */
  agent_message: z.object({ text: z.string(), agentId: z.string() }),
  /** A child's report: written when the runtime delivers `child_finished`. */
  child_report: z.object({
    agentId: z.string(),
    description: z.string(),
    status: ChildEndSchema,
    reason: z.string().nullable(),
    /** The failure's text, cut to 1 000 characters (KD-6); `null` unless the child failed. */
    message: z.string().nullable(),
    /** The report text; none when the child ended without one. */
    text: z.string().nullable(),
    toolCalls: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
  }),
  /** A model answer: its text and the calls it requested, in order. */
  model_answer: z.object({
    text: z.string(),
    toolCalls: z.array(AnswerCallSchema),
  }),
  /**
   * The call was put before the employee: written in the commit that asks the question (`effects.ask`, KD-3)
   * and ends the step with `wait`; `questionId` — the question's task.
   */
  tool_confirmation: z.object({ callId: z.string(), questionId: z.string() }),
  /** The employee's decision, written by the step that consumed it; `args` — the edited arguments, if any. */
  tool_decision: z.object({
    callId: z.string(),
    approved: z.boolean(),
    args: z.unknown().optional(),
  }),
  /**
   * The intent of a confirmed call, committed before the call goes out (KD-4, Invariant 2): a call with
   * this record and no result may have reached its server and is never sent again. `args` — the
   * arguments sent when the employee edited them; otherwise the answer's went out.
   */
  tool_sent: z.object({
    callId: z.string(),
    startedAt: z.iso.datetime(),
    args: z.unknown().optional(),
    /** The subagent tasks of an accepted `task` call, in its order: awaited children of its step. */
    taskIds: z.array(z.string()).optional(),
    /** The task of the session's list the `task` call names (KD-8). */
    taskId: z.number().int().positive().optional(),
  }),
  /** The start of one attempt of a `run_code` read run (code-execution KD-7). */
  run_attempt: z.object({
    callId: z.string(),
    attempt: z.number().int().positive(),
  }),
  /** The result of one tool call: the record that closes it. */
  tool_result: z.object({
    callId: z.string(),
    tool: z.string(),
    /** MCP server id; null for built-in and registered tools. */
    server: z.string().nullable(),
    args: z.unknown(),
    outcome: ToolOutcomeSchema,
    refusalReason: ToolRefusalReasonSchema.nullable(),
    /** The refused model of a refusal by model, otherwise `null`. */
    refusalDetail: z.object({ model: z.string().min(1) }).nullable(),
    text: z.string().nullable(),
    /** Script output of a `run_code` call: `null` when the run failed, absent for other tools. */
    output: z.string().nullable().optional(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    /**
     * The agent a `start_agent` call started, or the subagent of a single `task` call — the final subagent's
     * answer is read through it (deep-agents/design-task.md KD-6); absent for other calls.
     */
    childTaskId: z.string().optional(),
  }),
  /** A message of the package's code to the model, such as a refusal to finish. */
  notice: z.object({
    text: z.string(),
    /** The numbers of the open tasks the notice names, when they are its reason (design-task-list.md KD-4). */
    openTasks: z.array(z.number().int().positive()).optional(),
    /** The final subagent whose completed report the notice asks for, when its absence is the reason (deep-agents AC-05.1). */
    missingReport: z.string().min(1).optional(),
  }),
  /** A lifecycle event; `failed` carries its reason. */
  event: z.object({ event: HistoryEventSchema, reason: z.string().nullable() }),
  /** A summary that replaces for the model every entry through `throughSeq` (KD-7). */
  compaction: z.object({
    summary: z.string(),
    throughSeq: z.number().int().nonnegative(),
  }),
} as const satisfies Record<HistoryEntryKind, z.ZodType>;

export type HistoryContent<K extends HistoryEntryKind> = z.infer<
  (typeof HistoryContentSchemas)[K]
>;

/** One entry of an agent's history: append-only, `seq` grows within the session (Invariant 5). */
export type HistoryEntry = {
  readonly [K in HistoryEntryKind]: {
    readonly seq: number;
    readonly kind: K;
    readonly createdAt: Date;
    readonly content: HistoryContent<K>;
  };
}[HistoryEntryKind];
