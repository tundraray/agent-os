import {
  AgentMessageKindSchema,
  CHILD_FINISHED_KIND,
  ChipRecordSchema,
  type ToolOutcome,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  ToolCallStateSchema,
} from '@agent-os/contracts';
import type { RuntimeTx, StepMessage } from '@agent-os/runtime';
import { z } from 'zod';

import type { NewHistoryEntry } from '../store/history.repository.js';
import { sessions, type StoreReader } from '../store/sessions.repository.js';
import {
  isRunCodeCall,
  refusalDetailOf,
  type ToolCallRow,
  toolCalls,
} from '../store/tool-calls.repository.js';

/**
 * Marks a message to an agent that the runtime stopped (plan Notes 5): the first step that delivers
 * it writes the stop entries and `continued` (Flow 6, Flow 7). `withParent` — the same command
 * stopped the agent's parent.
 */
export const ResumeMarkSchema = z.object({ stopped: z.literal(true), withParent: z.boolean() });
export type ResumeMark = z.infer<typeof ResumeMarkSchema>;

/** Payloads of the queue messages the package sends (plan Notes 3). */
const MessagePayloadSchemas = {
  user_message: z.object({
    text: z.string(),
    record: ChipRecordSchema.optional(),
    resume: ResumeMarkSchema.optional(),
  }),
  agent_message: z.object({
    text: z.string(),
    fromAgentId: z.string(),
    resume: ResumeMarkSchema.optional(),
  }),
} as const;

/** The runtime's end notice of a child (`notifyParent` in `packages/runtime/src/step-commit.ts`). */
const ChildFinishedPayloadSchema = z.object({
  taskId: z.string(),
  status: z.enum(['completed', 'failed', 'stopped']),
  /** The `complete` result of an agent: `{ report }`. */
  result: z.object({ report: z.string() }).optional(),
  failure: z.object({ reason: z.string(), message: z.string() }).optional(),
  durationMs: z.number().int().nonnegative(),
});
type ChildFinishedPayload = z.infer<typeof ChildFinishedPayloadSchema>;

const { user_message: userMessage, agent_message: agentMessage, interrupt } =
  AgentMessageKindSchema.enum;

/** The `resume` mark of a message, if it carries one; other kinds never do. */
export function resumeMarkOf(message: StepMessage): ResumeMark | undefined {
  if (message.kind === userMessage) {
    return MessagePayloadSchemas.user_message.parse(message.payload).resume;
  }
  if (message.kind === agentMessage) {
    return MessagePayloadSchemas.agent_message.parse(message.payload).resume;
  }
  return undefined;
}

async function childReport(
  reader: StoreReader,
  notice: ChildFinishedPayload,
  description: string,
): Promise<NewHistoryEntry> {
  return {
    kind: 'child_report',
    content: {
      agentId: notice.taskId,
      description,
      status: notice.status,
      reason: notice.failure?.reason ?? null,
      text: notice.result?.report ?? null,
      toolCalls: await toolCalls.countFor(reader, notice.taskId),
      durationMs: notice.durationMs,
    },
  };
}

/**
 * The history entries of the messages a step delivers, in queue order, each kind with its source tag
 * (design-agents.md, «Сообщения и события»): `user_message` of the employee, `agent_message` with the
 * parent's `agentId`, and the runtime's `child_finished` as a `child_report` with the child's
 * description, tool call count and duration (Flow 2). An `interrupt` writes nothing here: the step
 * writes the `interrupted` event (KD-3). Any other kind throws: the queue of an agent holds only
 * these four.
 */
export async function entriesOf(
  reader: StoreReader,
  messages: readonly StepMessage[],
): Promise<NewHistoryEntry[]> {
  const notices = new Map<string, ChildFinishedPayload>();
  for (const message of messages) {
    if (message.kind === CHILD_FINISHED_KIND) {
      notices.set(message.messageId, ChildFinishedPayloadSchema.parse(message.payload));
    }
  }
  const children = await sessions.getMany(
    reader,
    [...notices.values()].map((notice) => notice.taskId),
  );

  const entries: NewHistoryEntry[] = [];
  for (const message of messages) {
    if (message.kind === userMessage) {
      const { text, record } = MessagePayloadSchemas.user_message.parse(message.payload);
      entries.push({ kind: 'user_message', content: { text, record: record ?? null } });
    } else if (message.kind === agentMessage) {
      const { text, fromAgentId } = MessagePayloadSchemas.agent_message.parse(message.payload);
      entries.push({ kind: 'agent_message', content: { text, agentId: fromAgentId } });
    } else if (message.kind === CHILD_FINISHED_KIND) {
      const notice = notices.get(message.messageId);
      if (notice === undefined) throw new Error(`Notice ${message.messageId} was not parsed`);
      // A child started by `start` outside a step may end before its first step made its session:
      // the report still reaches the parent, without a description.
      const description = children.get(notice.taskId)?.description ?? '';
      entries.push(await childReport(reader, notice, description));
    } else if (message.kind !== interrupt) {
      throw new Error(`Unknown message kind "${message.kind}" in the queue of an agent`);
    }
  }
  return entries;
}

/**
 * The turn counter after the step's messages are delivered (DC-1): in a root session every message of
 * the employee — a `user_message` — starts a new turn.
 */
export function rootTurnReset(input: {
  readonly turns: number;
  readonly isRoot: boolean;
  readonly messages: readonly StepMessage[];
}): number {
  const employeeMessage = input.messages.some((message) => message.kind === userMessage);
  return employeeMessage && input.isRoot ? 0 : input.turns;
}

/**
 * Closing on an interrupt or a stop (KD-3, Flow 7): «interrupted», but a call in `sending` may have
 * reached its server — «unknown».
 */
function interruptedOutcome(call: ToolCallRow): ToolOutcome {
  return call.state === ToolCallStateSchema.enum.sending
    ? ToolOutcomeSchema.enum.unknown
    : ToolOutcomeSchema.enum.interrupted;
}

/** An open call as an interrupt or a stop closes it at `finishedAt`, before the write or without one. */
export function closedView(call: ToolCallRow, finishedAt: Date): ToolCallRow {
  return {
    ...call,
    state: ToolCallStateSchema.enum.done,
    outcome: interruptedOutcome(call),
    finishedAt,
  };
}

/**
 * The `tool_result` entry of a closed call row; a `run_code` row also carries its script output (DC-14),
 * other tools have no `output` field.
 */
export function toolResultEntry(call: ToolCallRow): Extract<NewHistoryEntry, { kind: 'tool_result' }> {
  return {
    kind: 'tool_result',
    content: {
      callId: call.callId,
      tool: call.tool,
      server: call.server,
      args: call.args,
      outcome: ToolOutcomeSchema.parse(call.outcome),
      refusalReason: ToolRefusalReasonSchema.nullable().parse(call.refusalReason),
      refusalDetail: refusalDetailOf(call),
      text: call.resultText,
      ...(isRunCodeCall(call) ? { output: call.output } : {}),
      startedAt: call.startedAt?.toISOString() ?? null,
      finishedAt: call.finishedAt?.toISOString() ?? null,
    },
  };
}

/**
 * Closes the agent's open calls in answer and position order as an interrupt or a stop does and
 * returns the closed rows. The only closing of open calls (overview, Common Processing Points); a
 * call already closed by a racing write is skipped. `toolCalls.close` also closes the open calls from
 * code of a closed `run_code` row (code-execution Invariant 4).
 */
export async function closeOpen(tx: RuntimeTx, taskId: string): Promise<ToolCallRow[]> {
  const closed: ToolCallRow[] = [];
  for (const call of await toolCalls.open(tx, taskId)) {
    const row = await toolCalls.close(
      tx,
      { taskId, callId: call.callId },
      { outcome: interruptedOutcome(call) },
    );
    if (row !== undefined) closed.push(row);
  }
  return closed;
}
