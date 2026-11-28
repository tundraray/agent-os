import type { RootSession } from '@agent-os/agents';
import type { ThreadSummary } from '@agent-os/contracts';
import { isUuid } from '../common/is-uuid';
import { httpError } from './chat.errors';
import { decodeThreadCursor, type ThreadCursor } from './thread-cursor';

/** A cursor of a previous page; a well-formed cursor must still name a row id (`INVALID_CURSOR`). */
export function decodeRowCursor(cursor: string): ThreadCursor {
  const position = decodeThreadCursor(cursor);
  if (!isUuid(position.i)) throw httpError('INVALID_CURSOR');
  return position;
}

/**
 * A root session as the API shows it: its id is the conversation's, an empty title is `null` («Новая беседа»),
 * and so is the title of a deleted or untitled fork source.
 */
export function toThreadSummary(root: RootSession): ThreadSummary {
  const { forkedFrom } = root;
  return {
    id: root.rootId,
    title: root.title === '' ? null : root.title,
    createdAt: root.createdAt.toISOString(),
    updatedAt: root.updatedAt.toISOString(),
    forkable: root.forkable,
    forkedFrom:
      forkedFrom === null
        ? null
        : { ...forkedFrom, title: forkedFrom.title || null },
    forkCount: root.forkCount,
    notificationLevel: root.notificationLevel,
  };
}
