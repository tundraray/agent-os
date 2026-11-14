import {
  AgentMessageKindSchema,
  CHILD_FINISHED_KIND,
  type ToolOutcome,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
  ToolCallStateSchema,
} from '@agent-os/contracts';
import type { RuntimeTx, StepMessage } from '@agent-os/runtime';
import { z } from 'zod';

import type { NewHistoryEntry } from '../store/history.repository.js';
import { sessions, type StoreReader } from '../store/sessions.repository.js';
import { type ToolCallRow, toolCalls } from '../store/tool-calls.repository.js';
import { nextTurns } from './turn-rules.js';

/**
 * Marks a message to an agent that the runtime stopped (plan Notes 5): the first step that delivers
 * it writes the stop entries and `continued` (Flow 6, Flow 7). `withParent` — the same command
 * stopped the agent's parent.
 */
export const ResumeMarkSchema = z.object({ stopped: z.literal(true), withParent: z.boolean() });
export type ResumeMark = z.infer<typeof ResumeMarkSchema>;

/** Payloads of the queue messages the package sends (plan Notes 3). */
const MessagePayloadSchemas = {
  user_message: z.object({ text: z.string(), resume: ResumeMarkSchema.optional() }),
  agent_message: z.object({
    text: z.string(),
    fromAgentId: z.string(),
    resume: ResumeMarkSchema.optional(),
  }),
  interrupt: z.object({ text: z.string().optional() }),
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

/** The text of an `interrupt` message; `undefined` when the employee interrupted without text (KD-3). */
export function interruptText(message: StepMessage): string | undefined {
  return MessagePayloadSchemas.interrupt.parse(message.payload).text;
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
 * parent's `agentId`, an `interrupt` with text as a `user_message` (without text it writes nothing:
 * the step writes the `interrupted` event, KD-3), and the runtime's `child_finished` as a
 * `child_report` with the child's description, tool call count and duration (Flow 2). Any other kind
 * throws: the queue of an agent holds only these four.
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
      const { text } = MessagePayloadSchemas.user_message.parse(message.payload);
      entries.push({ kind: 'user_message', content: { text } });
    } else if (message.kind === agentMessage) {
      const { text, fromAgentId } = MessagePayloadSchemas.agent_message.parse(message.payload);
      entries.push({ kind: 'agent_message', content: { text, agentId: fromAgentId } });
    } else if (message.kind === interrupt) {
      const text = interruptText(message);
      if (text !== undefined) entries.push({ kind: 'user_message', content: { text } });
    } else if (message.kind === CHILD_FINISHED_KIND) {
      const notice = notices.get(message.messageId);
      if (notice === undefined) throw new Error(`Notice ${message.messageId} was not parsed`);
      // A child started by `start` outside a step may end before its first step made its session:
      // the report still reaches the parent, without a description.
      const description = children.get(notice.taskId)?.description ?? '';
      entries.push(await childReport(reader, notice, description));
    } else {
      throw new Error(`Unknown message kind "${message.kind}" in the queue of an agent`);
    }
  }
  return entries;
}

/**
 * The turn counter after the step's messages are delivered (DC-1): in a root session every message of
 * the employee — a `user_message` or an `interrupt` with text — starts a new turn.
 */
export function rootTurnReset(input: {
  readonly turns: number;
  readonly isRoot: boolean;
  readonly messages: readonly StepMessage[];
}): number {
  const employeeMessage = input.messages.some(
    (message) =>
      message.kind === userMessage ||
      (message.kind === interrupt && interruptText(message) !== undefined),
  );
  if (!employeeMessage) return input.turns;
  return nextTurns(input.turns, { kind: 'user_message_delivered', isRoot: input.isRoot });
}

/** The outcome an open call gets when it is closed; `undefined` leaves it open. */
export type OutcomeFor = (call: ToolCallRow) => ToolOutcome | undefined;

/**
 * Closing on an interrupt or a stop (KD-3, Flow 7): «interrupted», but a call in `sending` may have
 * reached its server — «unknown».
 */
export const interruptedOutcome: OutcomeFor = (call) =>
  call.state === ToolCallStateSchema.enum.sending
    ? ToolOutcomeSchema.enum.unknown
    : ToolOutcomeSchema.enum.interrupted;

/** The `tool_result` entry of a closed call row. */
export function toolResultEntry(call: ToolCallRow): NewHistoryEntry {
  return {
    kind: 'tool_result',
    content: {
      callId: call.callId,
      tool: call.tool,
      server: call.server,
      args: call.args,
      outcome: ToolOutcomeSchema.parse(call.outcome),
      refusalReason: ToolRefusalReasonSchema.nullable().parse(call.refusalReason),
      text: call.resultText,
      startedAt: call.startedAt?.toISOString() ?? null,
      finishedAt: call.finishedAt?.toISOString() ?? null,
    },
  };
}

/**
 * Closes the agent's open calls in answer and position order with `outcomeFor` (by default
 * {@link interruptedOutcome}) and returns their `tool_result` entries, for the caller to append. The
 * only closing of open calls (overview, Common Processing Points); a call already closed by a racing
 * write is skipped.
 */
export async function closeOpen(
  tx: RuntimeTx,
  taskId: string,
  outcomeFor: OutcomeFor = interruptedOutcome,
): Promise<NewHistoryEntry[]> {
  const entries: NewHistoryEntry[] = [];
  for (const call of await toolCalls.open(tx, taskId)) {
    const outcome = outcomeFor(call);
    if (outcome === undefined) continue;
    const closed = await toolCalls.close(tx, { taskId, callId: call.callId }, { outcome });
    if (closed !== undefined) entries.push(toolResultEntry(closed));
  }
  return entries;
}
