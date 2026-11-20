import type { Task } from '@agent-os/runtime';

import { openCalls } from '../history/call-state.js';
import type { HistoryEntry } from '../history/history.js';
import { stopEvent, stoppedTogether } from '../step/continuation.js';
import { interruptedResults } from '../store/call-records.repository.js';
import { history } from '../store/history.repository.js';
import type { StoreReader } from '../store/sessions.repository.js';

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
 * writes for real, with the numbers after the last stored one and the time of the stop.
 */
export async function stopEntries(
  reader: StoreReader,
  input: StopEntriesInput,
): Promise<StopEntry[]> {
  const { task, parent } = input;
  const stoppedAt = task.finishedAt ?? task.updatedAt;

  // An open call never stands before the last compaction, so the entries a step works on hold them all.
  const visible = await history.visible(reader, task.taskId);
  const lastSeq = await history.lastSeq(reader, task.taskId);
  const records = [
    ...interruptedResults(openCalls(visible), stoppedAt),
    stopEvent(stoppedTogether(task, parent)),
  ];
  // Each record keeps its own kind and content; TypeScript cannot correlate them across the spread.
  return records.map(
    (record, index) =>
      ({ seq: lastSeq + index + 1, kind: record.kind, createdAt: stoppedAt, content: record.content }) as StopEntry,
  );
}
