import { BadRequestException } from '@nestjs/common';
import type { StorageThreadType } from '@mastra/core/memory';
import { THREAD_PAGE_SIZE } from '@agent-os/contracts';
import { z } from 'zod';

/** Position of the last thread of a page: `updatedAt` in ms and `id`. */
export type ThreadCursor = { u: number; i: string };

const ThreadCursorSchema = z.strictObject({
  u: z.number().int(),
  i: z.string().min(1),
});

/** One page of the canonically ordered thread list. */
export type ThreadPage = {
  threads: StorageThreadType[];
  nextCursor: string | null;
};

type SelectThreadPageInput = {
  /** The user's threads in the order of `sortThreadsForList`. */
  sorted: StorageThreadType[];
  /** Decoded `nextCursor` of the previous page; absent for the first page. */
  cursor?: ThreadCursor;
  size?: number;
};

const toPosition = (thread: StorageThreadType): ThreadCursor => ({
  u: thread.updatedAt.getTime(),
  i: thread.id,
});

/** Code-unit comparison, the same one `isAfter` uses (not locale-aware). */
const compareIds = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** True when position `t` comes strictly after cursor `c` in the order (updatedAt ms DESC, id DESC). */
const isAfter = (t: ThreadCursor, c: ThreadCursor): boolean =>
  t.u < c.u || (t.u === c.u && t.i < c.i);

const invalidCursor = (): BadRequestException =>
  new BadRequestException('Invalid cursor', { errorCode: 'INVALID_CURSOR' });

/** Opaque cursor: base64url(`JSON.stringify({ u: updatedAt ms, i: id })`). */
export const encodeThreadCursor = (thread: {
  updatedAt: Date;
  id: string;
}): string =>
  Buffer.from(
    JSON.stringify({ u: thread.updatedAt.getTime(), i: thread.id }),
  ).toString('base64url');

/** Parses a cursor of `encodeThreadCursor`; anything else → 400 `INVALID_CURSOR`. */
export const decodeThreadCursor = (cursor: string): ThreadCursor => {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const parsed = ThreadCursorSchema.safeParse(json);
  if (!parsed.success) throw invalidCursor();
  return parsed.data;
};

/** A copy of `threads` in the canonical list order: `updatedAt` (ms) DESC, then `id` DESC. */
export const sortThreadsForList = (
  threads: StorageThreadType[],
): StorageThreadType[] =>
  threads.toSorted(
    (a, b) =>
      b.updatedAt.getTime() - a.updatedAt.getTime() || compareIds(b.id, a.id),
  );

/**
 * Keyset page: the first `size` threads strictly after `cursor` (from the
 * start without it). A thread whose `updatedAt` moved above the cursor during
 * a traversal lands before it and is not returned again (AC-13.2a).
 * `nextCursor` is `null` when no thread follows the page.
 */
export const selectThreadPage = ({
  sorted,
  cursor,
  size = THREAD_PAGE_SIZE,
}: SelectThreadPageInput): ThreadPage => {
  const start =
    cursor === undefined
      ? 0
      : sorted.findIndex((thread) => isAfter(toPosition(thread), cursor));
  if (start === -1) return { threads: [], nextCursor: null };
  const threads = sorted.slice(start, start + size);
  const hasMore = start + size < sorted.length;
  const last = threads.at(-1);
  return {
    threads,
    nextCursor: hasMore && last ? encodeThreadCursor(last) : null,
  };
};
