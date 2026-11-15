import { agentMessages } from '@agent-os/db';
import type { Task } from '@agent-os/runtime';
import { eq, max } from 'drizzle-orm';

import type { HistoryEntry } from '../history/history.js';
import type { StoreReader } from '../store/sessions.repository.js';
import { toolCalls } from '../store/tool-calls.repository.js';
import { stoppedTogether, stopRecords } from '../step/continuation.js';
import { closedView } from '../step/deliver.js';

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
 * stopped its parent (`stoppedTogether`). The records are the ones the first step after a continuation
 * writes for real (`stopRecords`), with the numbers after the last stored one and the time of the stop.
 */
export async function stopEntries(
  reader: StoreReader,
  input: StopEntriesInput,
): Promise<StopEntry[]> {
  const { task, parent } = input;
  const stoppedAt = task.finishedAt ?? task.updatedAt;

  const [last] = await reader
    .select({ seq: max(agentMessages.seq) })
    .from(agentMessages)
    .where(eq(agentMessages.taskId, task.taskId));
  const lastSeq = last?.seq ?? 0;

  const open = await toolCalls.open(reader, task.taskId);
  const records = stopRecords(
    open.map((call) => closedView(call, stoppedAt)),
    stoppedTogether(task, parent),
  );
  // Each record keeps its own kind and content; TypeScript cannot correlate them across the spread.
  return records.map(
    (record, index) =>
      ({ seq: lastSeq + index + 1, kind: record.kind, createdAt: stoppedAt, content: record.content }) as StopEntry,
  );
}
