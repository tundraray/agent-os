import { BadRequestException } from '@nestjs/common';
import type { StorageThreadType } from '@mastra/core/memory';
import {
  decodeThreadCursor,
  encodeThreadCursor,
  selectThreadPage,
  sortThreadsForList,
} from './thread-cursor.js';

const NEWEST = Date.UTC(2026, 9, 29, 12, 0, 0, 0);

/** Thread number n (1-based) → id `t-001` … `t-120`. */
const idOf = (n: number): string => `t-${String(n).padStart(3, '0')}`;

const thread = (id: string, updatedAtMs: number): StorageThreadType => ({
  id,
  resourceId: 'u-1',
  title: '',
  createdAt: new Date(updatedAtMs - 3_600_000),
  updatedAt: new Date(updatedAtMs),
});

/** `t-001` (newest) … `t-<count>`, each next one minute older. */
const threadsByAge = (count: number): StorageThreadType[] =>
  Array.from({ length: count }, (_, index) =>
    thread(idOf(index + 1), NEWEST - index * 60_000),
  );

type Page = { ids: string[]; nextCursor: string | null };

/** One page of `threads` (sorted on every call, as `ThreadsService.list` does). */
const page = (
  threads: StorageThreadType[],
  cursor: string | null,
  size?: number,
): Page => {
  const result = selectThreadPage({
    sorted: sortThreadsForList(threads),
    cursor: cursor === null ? undefined : decodeThreadCursor(cursor),
    size,
  });
  return {
    ids: result.threads.map((t) => t.id),
    nextCursor: result.nextCursor,
  };
};

/** Every page of an unchanged list, following `nextCursor` until `null`. */
const walk = (threads: StorageThreadType[], size?: number): Page[] => {
  const pages = [page(threads, null, size)];
  while (pages[pages.length - 1].nextCursor !== null) {
    pages.push(page(threads, pages[pages.length - 1].nextCursor, size));
  }
  return pages;
};

const range = (from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => idOf(from + i));

describe('encodeThreadCursor / decodeThreadCursor', () => {
  it('encodes base64url(JSON {u: updatedAt ms, i: id}) and decodes it back', () => {
    const cursor = encodeThreadCursor({
      updatedAt: new Date(Date.UTC(2026, 9, 29, 10, 0, 0, 7)),
      id: 'thread-1',
    });

    expect(Buffer.from(cursor, 'base64url').toString('utf8')).toBe(
      '{"u":1793268000007,"i":"thread-1"}',
    );
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeThreadCursor(cursor)).toEqual({
      u: 1793268000007,
      i: 'thread-1',
    });
  });

  const b64 = (text: string) => Buffer.from(text).toString('base64url');

  it.each([
    { name: 'not base64 JSON', cursor: 'not-a-cursor' },
    { name: 'JSON array', cursor: b64('[1,"a"]') },
    { name: 'JSON null', cursor: b64('null') },
    { name: 'u is a string', cursor: b64('{"u":"1","i":"a"}') },
    { name: 'u is fractional', cursor: b64('{"u":1.5,"i":"a"}') },
    { name: 'i is missing', cursor: b64('{"u":1}') },
    { name: 'i is empty', cursor: b64('{"u":1,"i":""}') },
    { name: 'extra field', cursor: b64('{"u":1,"i":"a","x":1}') },
  ])('rejects a cursor that is $name with 400 INVALID_CURSOR', ({ cursor }) => {
    let thrown: unknown;
    try {
      decodeThreadCursor(cursor);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect(thrown).toMatchObject({
      response: {
        statusCode: 400,
        message: 'Invalid cursor',
        errorCode: 'INVALID_CURSOR',
      },
    });
  });
});

describe('selectThreadPage', () => {
  // AC-13.2: 6 pages of 20 without duplicates; the last page is exactly 20 long and has nextCursor null.
  it('AC-13.2: walks 120 threads as 6 pages of 20 with 120 unique ids and nextCursor null on page 6', () => {
    const pages = walk(threadsByAge(120));

    expect(pages).toHaveLength(6);
    expect(pages.map((p) => p.ids.length)).toEqual([20, 20, 20, 20, 20, 20]);
    expect(pages[0].ids).toEqual(range(1, 20));
    expect(pages[5].ids).toEqual(range(101, 120));
    expect(
      pages.slice(0, 5).every((p) => typeof p.nextCursor === 'string'),
    ).toBe(true);
    expect(pages[5].nextCursor).toBeNull();
    const union = pages.flatMap((p) => p.ids);
    expect(new Set(union).size).toBe(120);
    expect(union).toEqual(range(1, 120));
  });

  // Empty input (Failure Mode Checklist).
  it('returns { threads: [], nextCursor: null } for a user without threads', () => {
    expect(selectThreadPage({ sorted: [] })).toEqual({
      threads: [],
      nextCursor: null,
    });
  });

  // AC-13.2a / Element 3 Step 1: a thread raised during the traversal is not returned again; nothing is duplicated.
  it('AC-13.2a: deleting a page-1 thread and raising a page-5 thread between pages 2 and 3 yields 119 unique ids', () => {
    const deletedId = idOf(5);
    const raisedId = idOf(85);
    let threads = threadsByAge(120);
    const page1 = page(threads, null);
    const page2 = page(threads, page1.nextCursor);

    // Between pages 2 and 3: delete t-005, raise t-085 (updatedAt = current maximum + 1 ms).
    threads = threads
      .filter((t) => t.id !== deletedId)
      .map((t) => (t.id === raisedId ? thread(t.id, NEWEST + 1) : t));
    const later: Page[] = [page(threads, page2.nextCursor)];
    while (later[later.length - 1].nextCursor !== null) {
      later.push(page(threads, later[later.length - 1].nextCursor));
    }

    expect(later).toHaveLength(4);
    const laterIds = later.flatMap((p) => p.ids);
    expect(laterIds).not.toContain(raisedId);
    expect(laterIds).not.toContain(deletedId);
    expect(laterIds).toHaveLength(79);
    expect(laterIds).toEqual(range(41, 120).filter((id) => id !== raisedId));
    expect(later[3].ids).toHaveLength(19);
    expect(later[3].nextCursor).toBeNull();
    const union = [...page1.ids, ...page2.ids, ...laterIds];
    expect(union).toHaveLength(119);
    expect(new Set(union).size).toBe(119);
    expect(union).toEqual(range(1, 120).filter((id) => id !== raisedId));
    expect(page1.ids).toContain(deletedId);
  });

  // Same value (Failure Mode Checklist): equal updatedAt → id DESC; a cursor on the tie neither repeats nor skips.
  it('orders equal updatedAt by id DESC and pages across the tie without duplicates or gaps', () => {
    const tie = NEWEST - 60_000;
    const threads = [
      thread('b', tie),
      thread('newest', NEWEST),
      thread('d', tie),
      thread('a', tie),
      thread('c', tie),
      thread('oldest', tie - 1),
    ];

    expect(sortThreadsForList(threads).map((t) => t.id)).toEqual([
      'newest',
      'd',
      'c',
      'b',
      'a',
      'oldest',
    ]);
    const pages = walk(threads, 2);
    expect(pages.map((p) => p.ids)).toEqual([
      ['newest', 'd'],
      ['c', 'b'],
      ['a', 'oldest'],
    ]);
    expect(pages[2].nextCursor).toBeNull();
  });
});
