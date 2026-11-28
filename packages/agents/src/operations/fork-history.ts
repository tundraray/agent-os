import type { Logger } from '@agent-os/common';
import {
  CHAT_TASK_TYPE,
  type ForkRefusalReason,
  HistoryEventSchema,
  TaskStatusSchema,
  THREAD_TITLE_MAX_LENGTH,
  WaitReasonSchema,
} from '@agent-os/contracts';
import type {
  ConversationsRepository,
  ConversationTasksRepository,
  MessagesRepository,
  ToolResultsRepository,
} from '@agent-os/db';
import { isFinished, type Task, type TaskControl } from '@agent-os/runtime';

import { openCalls } from '../history/call-state';
import type { HistoryEntry } from '../history/history';
import { interruptedResults } from '../store/call-records';
import type { History } from '../store/history';
import { isQuestion } from '../task-tree';
import type { ForkBoundary } from './agent-sessions';
import { agentNotFound } from './operation-support';

/** What the model reads after the inherited history (create-and-test design-fork.md, KD-3). */
const FORKED_REASON =
  'The history above was copied from another conversation of the same employee; continue from here.';

/** The title of a fork: «Ветка · {source}», cut to the title's limit, or «Ветка» for an untitled source. */
export function forkTitle(sourceTitle: string): string {
  return (sourceTitle === '' ? 'Ветка' : `Ветка · ${sourceTitle}`).slice(
    0,
    THREAD_TITLE_MAX_LENGTH,
  );
}

/** The seq of the `task` entry the creator writes itself; the copy starts after it. */
const FIRST_COPIED_SEQ = 2;

/**
 * Whether a conversation can be forked now, by its tree with the root first (KD-4): the first reason that
 * holds, in order, or `null`.
 */
function forkRefusal(
  tree: readonly [Task, ...Task[]],
): ForkRefusalReason | null {
  const [root, ...below] = tree;
  if (root.type !== CHAT_TASK_TYPE) return 'not_a_chat';
  const unfinished = below.filter((task) => !isFinished(task.status));
  if (unfinished.some(isQuestion)) return 'awaiting_confirmation';
  const waitsForMessage =
    root.status === TaskStatusSchema.enum.waiting &&
    root.waitReason === WaitReasonSchema.enum.messages;
  if (!isFinished(root.status) && !waitsForMessage) return 'answering';
  if (unfinished.length > 0) return 'tasks_running';
  return null;
}

/** {@link forkRefusal} over one read of the owner's tree; `AGENT_NOT_FOUND` when `sourceId` is no live root of theirs. */
export async function readForkRefusal(
  tasks: Pick<TaskControl, 'listTree'>,
  sourceId: string,
  ownerId: string,
): Promise<ForkRefusalReason | null> {
  const [root, ...below] = await tasks.listTree(sourceId, ownerId);
  if (root === undefined) throw agentNotFound(sourceId);
  return forkRefusal([root, ...below]);
}

/**
 * The last entry a fork inherits (improvements design-server.md, «How the fork boundary works»): a `throughSeq` on a
 * `task`, a `user_message` or a model answer without calls is that entry; an `edit.seq` on a `task` or a `user_message`
 * is the entry before it, 0 for the first message. `entry` is the source root's entry at the boundary's seq; `null`
 * when there is none or it is of another kind, or when an edit names a message a schedule sent: only the employee's
 * own message can be edited (ForkRequest).
 */
export function inheritedThrough(
  entry: HistoryEntry | undefined,
  boundary: ForkBoundary,
): number | null {
  if (entry === undefined) return null;
  const isMessage = entry.kind === 'task' || entry.kind === 'user_message';
  if (boundary.kind === 'edit') {
    return isMessage && entry.content.schedule === null ? entry.seq - 1 : null;
  }
  const isAnswer =
    entry.kind === 'model_answer' && entry.content.toolCalls.length === 0;
  return isMessage || isAnswer ? entry.seq : null;
}

export interface CopyHistoryDeps {
  readonly history: Pick<History, 'append' | 'visible'>;
  readonly messageRows: Pick<MessagesRepository, 'lastSeq' | 'copy'>;
  readonly toolResultRows: Pick<ToolResultsRepository, 'copy'>;
  readonly sessionTaskRows: Pick<ConversationTasksRepository, 'copy'>;
  readonly sessionRows: Pick<ConversationsRepository, 'find' | 'update'>;
  readonly logger: Logger;
}

export interface CopyHistoryRequest {
  readonly sourceId: string;
  readonly targetId: string;
  readonly forkedFromId: string;
  /** The last inherited entry; the last one of the source, read in this transaction, when absent. */
  readonly throughSeq?: number;
  /** Copy the task list and `last_input_tokens` too. */
  readonly withTasks: boolean;
}

/**
 * Copies the source's history into a conversation its creator makes in the open transaction, after the
 * target's `task` entry (KD-2, KD-6): entries 2 … the boundary, the full results of their calls and, with
 * `withTasks`, the task list and `last_input_tokens`; then the inherited open calls closed «interrupted» or
 * «unknown», the `forked` event and the fork's columns. Returns the seq of the event.
 */
export async function copyHistory(
  deps: CopyHistoryDeps,
  request: CopyHistoryRequest,
): Promise<number> {
  const startedAt = Date.now();
  const { sourceId, targetId, forkedFromId, withTasks } = request;
  const throughSeq =
    request.throughSeq ?? (await deps.messageRows.lastSeq(sourceId));
  const entries = await deps.messageRows.copy(
    sourceId,
    targetId,
    FIRST_COPIED_SEQ,
    throughSeq,
  );
  const results = await deps.toolResultRows.copy(
    sourceId,
    targetId,
    throughSeq,
  );
  const tasks = withTasks
    ? await deps.sessionTaskRows.copy(sourceId, targetId)
    : 0;
  const closing = interruptedResults(
    openCalls(await deps.history.visible(targetId)),
    new Date(),
  );
  const appended = await deps.history.append(targetId, [
    ...closing,
    {
      kind: 'event',
      content: { event: HistoryEventSchema.enum.forked, reason: FORKED_REASON },
    },
  ]);
  const lastInputTokens = withTasks
    ? {
        lastInputTokens: (await deps.sessionRows.find(sourceId))
          ?.lastInputTokens,
      }
    : {};
  const eventSeq = appended.at(-1)!.seq;
  // The fork starts read through its last entry (improvements design-server.md, Data Model).
  await deps.sessionRows.update(targetId, {
    forkedFromId,
    forkedThroughSeq: throughSeq,
    seenThroughSeq: eventSeq,
    ...lastInputTokens,
  });
  deps.logger.info('history copied', {
    sourceId,
    targetId,
    throughSeq,
    entries,
    results,
    tasks,
    closedCalls: closing.length,
    eventSeq,
    durationMs: Date.now() - startedAt,
  });
  return eventSeq;
}
