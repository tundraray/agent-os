import {
  AgentMessageKindSchema,
  CHILD_FINISHED_KIND,
  type ChildFinishedPayload,
  ChildFinishedPayloadSchema,
  ChipRecordSchema,
  DocumentRefSchema,
  ScheduleMarkSchema,
} from '@agent-os/contracts';
import type { StepContext, StepMessage } from '@agent-os/runtime';
import { z } from 'zod';

import { failureTextOf } from '../failure-text';
import { type ResumeMark, ResumeMarkSchema } from '../resume';
import type { NewHistoryEntry } from '../store/history';
import { isQuestion } from '../task-tree';
import type { AgentDeps } from './agent-deps';
import { agentOwner } from './agent-owner';

/** Payloads of the queue messages the package sends (plan Notes 3). */
const MessagePayloadSchemas = {
  user_message: z.object({
    text: z.string(),
    record: ChipRecordSchema.optional(),
    /** The schedule that sent the message (schedules KD-5). */
    schedule: ScheduleMarkSchema.optional(),
    resume: ResumeMarkSchema.optional(),
  }),
  agent_message: z.object({
    text: z.string(),
    fromAgentId: z.string(),
    resume: ResumeMarkSchema.optional(),
  }),
} as const;

/**
 * The `complete` result of an agent: its last answer and, for a deep agent, its report document; `null` for
 * every other agent (self-learning design-notepad.md KD-4).
 */
const AgentResultSchema = z.object({
  report: z.string(),
  document: DocumentRefSchema.nullable(),
});

/** The report of a completed agent task, from its result. */
export function reportOf(result: unknown): string {
  return AgentResultSchema.parse(result).report;
}

const {
  user_message: userMessage,
  agent_message: agentMessage,
  interrupt,
} = AgentMessageKindSchema.enum;

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
  notice: ChildFinishedPayload,
  description: string,
): Promise<NewHistoryEntry> {
  const result =
    notice.status === 'completed'
      ? AgentResultSchema.parse(notice.result)
      : null;
  return {
    kind: 'child_report',
    content: {
      agentId: notice.taskId,
      description,
      status: notice.status,
      reason: notice.failure?.reason ?? null,
      message:
        notice.failure === undefined
          ? null
          : failureTextOf(notice.failure.message),
      text: result?.report ?? null,
      document: result?.document ?? null,
      toolCalls: await deps.messageRows.toolCallCount(notice.taskId),
      durationMs: notice.durationMs,
    },
  };
}

/**
 * The history entries of the messages a step delivers, in queue order, each kind with its source tag
 * (design-agents.md, «Сообщения и события»): `user_message` of the employee, `agent_message` with the
 * parent's `agentId`, and the runtime's `child_finished` as a `child_report` with the child's
 * description, tool call count, duration and the failure's text cut for the model (data-model
 * design-runtime.md, «Отчёты детей»). An `interrupt` writes nothing here: the step writes the
 * `interrupted` event (KD-3); nor does the `child_finished` of a child whose `task` call this step closes
 * (`closedChildren`): the call's result already carries it; nor that of a question (KD-3): the tool step
 * reads the answer, and a stopped question has none. A question has no session, so only a child without
 * one is read from the runtime. Any other kind throws: the queue of an agent holds only these four.
 */
export async function entriesOf(
  deps: Pick<AgentDeps, 'sessions' | 'messageRows' | 'tasks'>,
  ctx: Pick<StepContext, 'taskId' | 'ownerId' | 'messages'>,
  closedChildren: ReadonlySet<string> = new Set(),
): Promise<NewHistoryEntry[]> {
  const { messages } = ctx;
  const notices = new Map<string, ChildFinishedPayload>();
  for (const message of messages) {
    if (message.kind === CHILD_FINISHED_KIND) {
      notices.set(
        message.messageId,
        ChildFinishedPayloadSchema.parse(message.payload),
      );
    }
  }
  const children = await deps.sessions.getMany(
    [...notices.values()].map((notice) => notice.taskId),
  );

  const entries: NewHistoryEntry[] = [];
  for (const message of messages) {
    if (message.kind === userMessage) {
      const { text, record, schedule } =
        MessagePayloadSchemas.user_message.parse(message.payload);
      entries.push({
        kind: 'user_message',
        content: { text, record: record ?? null, schedule: schedule ?? null },
      });
    } else if (message.kind === agentMessage) {
      const { text, fromAgentId } = MessagePayloadSchemas.agent_message.parse(
        message.payload,
      );
      entries.push({
        kind: 'agent_message',
        content: { text, agentId: fromAgentId },
      });
    } else if (message.kind === CHILD_FINISHED_KIND) {
      const notice = notices.get(message.messageId);
      if (notice === undefined)
        throw new Error(`Notice ${message.messageId} was not parsed`);
      if (closedChildren.has(notice.taskId)) continue;
      const child = children.get(notice.taskId);
      if (child === undefined) {
        const task = await deps.tasks.get(notice.taskId, agentOwner(ctx));
        if (isQuestion(task)) continue;
      }
      // An agent child has its session from its creation (KD-8) and a question, which has none, was
      // skipped above; a child without a session would still be reported, without a description.
      entries.push(await childReport(deps, notice, child?.description ?? ''));
    } else if (message.kind !== interrupt) {
      throw new Error(
        `Unknown message kind "${message.kind}" in the queue of an agent`,
      );
    }
  }
  return entries;
}

/**
 * Whether the step's messages hold more than an `interrupt`: a question's `child_finished` is no more than it
 * (the tool step reads the answer), so an interrupt with it still only closes the calls and waits.
 */
export async function hasOtherMessages(
  deps: Pick<AgentDeps, 'tasks'>,
  ctx: Pick<StepContext, 'taskId' | 'ownerId' | 'messages'>,
): Promise<boolean> {
  for (const message of ctx.messages) {
    if (message.kind === interrupt) continue;
    if (message.kind !== CHILD_FINISHED_KIND) return true;
    const { taskId } = ChildFinishedPayloadSchema.parse(message.payload);
    if (!isQuestion(await deps.tasks.get(taskId, agentOwner(ctx)))) return true;
  }
  return false;
}

/**
 * The turn counter of a chat after the step's messages are delivered (DC-1): every message of the employee —
 * a `user_message` — starts a new turn.
 */
export function chatTurns(
  turns: number,
  messages: readonly StepMessage[],
): number {
  return messages.some((message) => message.kind === userMessage) ? 0 : turns;
}
