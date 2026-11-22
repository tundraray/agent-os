import type { Executor } from '@agent-os/db';
import {
  AgentMessageKindSchema,
  CHILD_FINISHED_KIND,
  ChipRecordSchema,
  TASKS_FINISHED_KIND,
} from '@agent-os/contracts';
import type { StepMessage } from '@agent-os/runtime';
import { z } from 'zod';

import { type ResumeMark, ResumeMarkSchema } from '../resume';
import type { NewHistoryEntry } from '../store/history';
import type { AgentDeps } from './agent-deps';

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

/** The runtime's end notice of a child (`notifyParent` in `packages/runtime/src/tasks/task-end.ts`). */
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
  deps: Pick<AgentDeps, 'messageRows'>,
  reader: Executor,
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
      toolCalls: await deps.messageRows.toolCallCount(reader, notice.taskId),
      durationMs: notice.durationMs,
    },
  };
}

/**
 * The history entries of the messages a step delivers, in queue order, each kind with its source tag
 * (design-agents.md, «Сообщения и события»): `user_message` of the employee, `agent_message` with the
 * parent's `agentId`, and the runtime's `child_finished` as a `child_report` with the child's
 * description, tool call count and duration (Flow 2). An `interrupt` writes nothing here: the step
 * writes the `interrupted` event (KD-3); nor does the runtime's `tasks_finished`: the tool step closes the
 * `task` calls with its tracker's outcomes (deep-agents/design-task.md KD-4). Any other kind throws: the
 * queue of an agent holds only these five.
 */
export async function entriesOf(
  deps: Pick<AgentDeps, 'sessions' | 'messageRows'>,
  reader: Executor,
  messages: readonly StepMessage[],
): Promise<NewHistoryEntry[]> {
  const notices = new Map<string, ChildFinishedPayload>();
  for (const message of messages) {
    if (message.kind === CHILD_FINISHED_KIND) {
      notices.set(message.messageId, ChildFinishedPayloadSchema.parse(message.payload));
    }
  }
  const children = await deps.sessions.getMany(
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
      entries.push(await childReport(deps, reader, notice, description));
    } else if (message.kind !== interrupt && message.kind !== TASKS_FINISHED_KIND) {
      throw new Error(`Unknown message kind "${message.kind}" in the queue of an agent`);
    }
  }
  return entries;
}

/**
 * The turn counter of a chat after the step's messages are delivered (DC-1): every message of the employee —
 * a `user_message` — starts a new turn.
 */
export function chatTurns(turns: number, messages: readonly StepMessage[]): number {
  return messages.some((message) => message.kind === userMessage) ? 0 : turns;
}
