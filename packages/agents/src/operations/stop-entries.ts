import { HistoryEventSchema, TaskStatusSchema } from '@agent-os/contracts';
import { agentMessages } from '@agent-os/db';
import type { Task } from '@agent-os/runtime';
import { eq, max } from 'drizzle-orm';

import type { HistoryEntry } from '../history/history.js';
import type { StoreReader } from '../store/sessions.repository.js';
import { toolCalls } from '../store/tool-calls.repository.js';
import { interruptedOutcome, toolResultEntry } from '../step/deliver.js';
import { messagePayload } from '../step/continuation.js';

const { stopped } = TaskStatusSchema.enum;

/** A derived stop record: a closed call or the stop event. */
export type StopEntry = Extract<HistoryEntry, { kind: 'tool_result' | 'event' }>;

export interface StopEntriesInput {
  /** The stopped agent, read by the caller with the owner check. */
  readonly task: Task;
  /** Its parent; `null` for a root session. */
  readonly parent: Task | null;
}

/**
 * The stop records of a stopped agent that `history` shows derived (Flow 7): the runtime stops an
 * agent without a write of `agents`, so its open calls are shown closed — «interrupted», a call in
 * `sending` «unknown» — followed by the `stopped` event, or `stopped_with_parent` when the same command
 * stopped its parent. `tasks.stop` ends the whole subtree in one transaction with one `finished_at`
 * (`now()` of that transaction), so «the same command» is «the parent is `stopped` with the same
 * `finishedAt`» — the rule a message to a stopped agent carries (`messagePayload`). The records get the
 * numbers after the last stored one, in the order the first step after a continuation writes them for
 * real (`continuationEntries`), and the time of the stop. `[]` for an agent that is not `stopped`.
 */
export async function stopEntries(
  reader: StoreReader,
  input: StopEntriesInput,
): Promise<StopEntry[]> {
  const { task, parent } = input;
  if (task.status !== stopped) return [];
  const stoppedAt = task.finishedAt ?? task.updatedAt;

  const [last] = await reader
    .select({ seq: max(agentMessages.seq) })
    .from(agentMessages)
    .where(eq(agentMessages.taskId, task.taskId));
  let seq = last?.seq ?? 0;
  const next = () => {
    seq += 1;
    return seq;
  };

  const entries: StopEntry[] = [];
  for (const call of await toolCalls.open(reader, task.taskId)) {
    const closed = toolResultEntry({
      ...call,
      outcome: interruptedOutcome(call) ?? null,
      finishedAt: stoppedAt,
    });
    if (closed.kind !== 'tool_result') continue;
    entries.push({ seq: next(), kind: 'tool_result', createdAt: stoppedAt, content: closed.content });
  }

  const withParent = messagePayload('', task, parent).resume?.withParent === true;
  entries.push({
    seq: next(),
    kind: 'event',
    createdAt: stoppedAt,
    content: {
      event: withParent ? HistoryEventSchema.enum.stopped_with_parent : HistoryEventSchema.enum.stopped,
      reason: null,
    },
  });
  return entries;
}
