import {
  ChatRequestSchema,
  GENERATED_THREAD_TITLE_MAX_LENGTH,
  RenameThreadRequestSchema,
  THREAD_PAGE_SIZE,
  THREAD_TITLE_MAX_LENGTH,
  ThreadListResponseSchema,
  ThreadSummarySchema,
  ThreadsErrorCodeSchema,
} from '@agent-os/contracts';

const summary = (id: string) => ({
  id,
  title: null,
  createdAt: '2026-10-28T10:00:00.000Z',
  updatedAt: '2026-10-28T10:00:00.000Z',
});

describe('thread constants', () => {
  it('exposes the page size and title limits of the Design Doc', () => {
    expect(THREAD_PAGE_SIZE).toBe(20);
    expect(THREAD_TITLE_MAX_LENGTH).toBe(200);
    expect(GENERATED_THREAD_TITLE_MAX_LENGTH).toBe(80);
  });
});

describe('RenameThreadRequestSchema', () => {
  it('rejects a whitespace-only title', () => {
    expect(RenameThreadRequestSchema.safeParse({ title: '   ' }).success).toBe(
      false,
    );
  });

  it('rejects an empty title', () => {
    expect(RenameThreadRequestSchema.safeParse({ title: '' }).success).toBe(
      false,
    );
  });

  it('rejects a missing title', () => {
    expect(RenameThreadRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a 201-character title', () => {
    expect(
      RenameThreadRequestSchema.safeParse({ title: 'a'.repeat(201) }).success,
    ).toBe(false);
  });

  it('accepts a 200-character title', () => {
    expect(
      RenameThreadRequestSchema.parse({ title: 'a'.repeat(200) }).title,
    ).toHaveLength(200);
  });

  it('trims surrounding whitespace', () => {
    expect(RenameThreadRequestSchema.parse({ title: '  Plans  ' })).toEqual({
      title: 'Plans',
    });
  });

  it('trims before checking the length', () => {
    const parsed = RenameThreadRequestSchema.parse({
      title: '  ' + 'a'.repeat(200) + '  ',
    });
    expect(parsed.title.length).toBe(200);
  });
});

describe('ThreadSummarySchema', () => {
  it('accepts title: null for an untitled thread', () => {
    expect(ThreadSummarySchema.parse(summary('t-1'))).toEqual({
      id: 't-1',
      title: null,
      createdAt: '2026-10-28T10:00:00.000Z',
      updatedAt: '2026-10-28T10:00:00.000Z',
    });
  });

  it('rejects an empty title string', () => {
    expect(
      ThreadSummarySchema.safeParse({ ...summary('t-1'), title: '' }).success,
    ).toBe(false);
  });
});

describe('ThreadListResponseSchema', () => {
  it('accepts a page of 20 threads', () => {
    const threads = Array.from({ length: 20 }, (_, i) => summary(`t-${i}`));
    expect(
      ThreadListResponseSchema.safeParse({ threads, nextCursor: null }).success,
    ).toBe(true);
  });

  it('rejects a page of 21 threads', () => {
    const threads = Array.from({ length: 21 }, (_, i) => summary(`t-${i}`));
    expect(
      ThreadListResponseSchema.safeParse({ threads, nextCursor: null }).success,
    ).toBe(false);
  });
});

describe('ThreadsErrorCodeSchema', () => {
  it('lists exactly the three threads API error codes', () => {
    expect(ThreadsErrorCodeSchema.options).toEqual([
      'THREAD_NOT_FOUND',
      'VALIDATION_FAILED',
      'INVALID_CURSOR',
    ]);
  });
});

describe('ChatRequestSchema (unchanged)', () => {
  it('accepts a body with id and messages', () => {
    expect(ChatRequestSchema.parse({ id: 'c-1', messages: [] })).toEqual({
      id: 'c-1',
      messages: [],
    });
  });

  it('accepts a body with threadId and messages', () => {
    expect(
      ChatRequestSchema.safeParse({ threadId: 't-1', messages: [{}] }).success,
    ).toBe(true);
  });

  it('accepts a body without any id', () => {
    expect(ChatRequestSchema.safeParse({ messages: [] }).success).toBe(true);
  });

  it('rejects a body without messages', () => {
    expect(ChatRequestSchema.safeParse({ id: 'c-1' }).success).toBe(false);
  });

  it('rejects an empty id', () => {
    expect(ChatRequestSchema.safeParse({ id: '', messages: [] }).success).toBe(
      false,
    );
  });

  it('rejects an empty threadId', () => {
    expect(
      ChatRequestSchema.safeParse({ threadId: '', messages: [] }).success,
    ).toBe(false);
  });
});
