import { NotFoundException } from '@nestjs/common';
import { ErrorCategory, ErrorDomain, MastraError } from '@mastra/core/error';
import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import { Memory } from '@mastra/memory';
import { ThreadDeletionHooks } from './thread-deletion-hooks.js';
import { ThreadRunRegistry } from './thread-run-registry.js';
import { ThreadWriteLock } from './thread-write-lock.js';
import { threadNotFound } from './threads.errors.js';
import { ThreadsService } from './threads.service.js';

type Role = 'user' | 'assistant';
type StoredSpec = [Role, string] | [Role, string, Record<string, unknown>];

/** Metadata of the hidden user message of a launch card decision (KD-2). */
const decision = { researchDecision: { action: 'confirm', launchKey: 'k-1' } };
/** Metadata of the hidden assistant reply of a decision turn. */
const decisionReply = { researchDecisionReply: { launchKey: 'k-1' } };
/** Metadata of the assistant message carrying a research answer. */
const researchAnswer = { researchAnswer: { launchKey: 'k-1' } };

/** Stored messages in the order the installed Mastra `recall` returns them: oldest first. */
const stored = (...messages: StoredSpec[]): MastraDBMessage[] =>
  messages.map(([role, id, metadata], index) => ({
    id,
    role,
    threadId: 't-1',
    resourceId: 'u-1',
    createdAt: new Date(Date.UTC(2026, 9, 29, 10, 0, index)),
    content: {
      format: 2,
      parts: [{ type: 'text', text: id }],
      ...(metadata ? { metadata } : {}),
    },
  }));

/** A real Memory whose storage calls are replaced: no database is touched. */
const fakeMemory = (messages: MastraDBMessage[]) => {
  const memory = new Memory({ options: { lastMessages: 20 } });
  const recall = vi.spyOn(memory, 'recall').mockResolvedValue({
    messages,
    total: messages.length,
    page: 0,
    perPage: 20,
    hasMore: false,
  });
  const deleteMessages = vi
    .spyOn(memory, 'deleteMessages')
    .mockResolvedValue(undefined);
  const service = new ThreadsService(
    memory,
    new ThreadWriteLock(),
    new ThreadRunRegistry(5_000),
    new ThreadDeletionHooks(),
    5_000,
  );
  return { service, recall, deleteMessages };
};

const ids = (messages: MastraDBMessage[]): string[] =>
  messages.map((message) => message.id);

// AC-14.6, AC-22.2 (tail rule), KD-7, KD-8: the stored replies after the newest user message without
// `researchDecision` are discarded only on a resend of that same message; hidden decision pairs and
// research answers go with the tail; `repeated` tells a resend from a new message.
describe('ThreadsService.discardRepliesAfter', () => {
  it.each<{
    name: string;
    messages: MastraDBMessage[];
    userMessageId: string;
    deleted: string[] | null;
    repeated: boolean;
  }>([
    {
      name: 'resend of the newest user message with one reply → reply deleted',
      messages: stored(['user', 'u1'], ['assistant', 'a1']),
      userMessageId: 'u1',
      deleted: ['a1'],
      repeated: true,
    },
    {
      name: 'resend with two replies after it → both deleted',
      messages: stored(
        ['user', 'u1'],
        ['assistant', 'a1'],
        ['assistant', 'a2'],
      ),
      userMessageId: 'u1',
      deleted: ['a1', 'a2'],
      repeated: true,
    },
    {
      name: 'ordinary send (new id) → nothing deleted, not repeated',
      messages: stored(['user', 'u1'], ['assistant', 'a1']),
      userMessageId: 'u-new',
      deleted: null,
      repeated: false,
    },
    {
      name: 'newest user message has no reply → nothing deleted, repeated',
      messages: stored(['user', 'u0'], ['assistant', 'a0'], ['user', 'u1']),
      userMessageId: 'u1',
      deleted: null,
      repeated: true,
    },
    {
      name: 'resend of an older user message → nothing deleted, not repeated',
      messages: stored(
        ['user', 'u0'],
        ['assistant', 'a0'],
        ['user', 'u1'],
        ['assistant', 'a1'],
      ),
      userMessageId: 'u0',
      deleted: null,
      repeated: false,
    },
    {
      name: 'no user message among the newest 20 → nothing deleted, not repeated',
      messages: stored(['assistant', 'a1'], ['assistant', 'a2']),
      userMessageId: 'a1',
      deleted: null,
      repeated: false,
    },
    {
      name: 'tail with a hidden decision pair → reply and the pair deleted',
      messages: stored(
        ['user', 'u1'],
        ['assistant', 'a1'],
        ['user', 'd1', decision],
        ['assistant', 'r1', decisionReply],
      ),
      userMessageId: 'u1',
      deleted: ['a1', 'd1', 'r1'],
      repeated: true,
    },
    {
      name: 'tail with a hidden pair and a research answer → all deleted',
      messages: stored(
        ['user', 'u1'],
        ['assistant', 'a1'],
        ['user', 'd1', decision],
        ['assistant', 'r1', decisionReply],
        ['assistant', 'ans1', researchAnswer],
      ),
      userMessageId: 'u1',
      deleted: ['a1', 'd1', 'r1', 'ans1'],
      repeated: true,
    },
    {
      name: 'decision message without a reply in the tail → deleted with the tail',
      messages: stored(
        ['user', 'u1'],
        ['assistant', 'a1'],
        ['user', 'd1', decision],
      ),
      userMessageId: 'u1',
      deleted: ['a1', 'd1'],
      repeated: true,
    },
    {
      name: 'only a decision message after the newest user message → repeated, decision deleted',
      messages: stored(['user', 'u1'], ['user', 'd1', decision]),
      userMessageId: 'u1',
      deleted: ['d1'],
      repeated: true,
    },
    {
      name: 'new message after a hidden pair → nothing deleted, not repeated',
      messages: stored(
        ['user', 'u1'],
        ['assistant', 'a1'],
        ['user', 'd1', decision],
        ['assistant', 'r1', decisionReply],
      ),
      userMessageId: 'u-new',
      deleted: null,
      repeated: false,
    },
  ])('$name', async ({ messages, userMessageId, deleted, repeated }) => {
    const { service, recall, deleteMessages } = fakeMemory(messages);

    const result = await service.discardRepliesAfter({
      threadId: 't-1',
      userId: 'u-1',
      userMessageId,
    });

    expect(recall).toHaveBeenCalledWith({
      threadId: 't-1',
      resourceId: 'u-1',
      perPage: 20,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'DESC' },
      includeTotal: false,
    });
    expect(result).toEqual({ repeated });
    if (deleted) expect(deleteMessages).toHaveBeenCalledWith(deleted);
    else expect(deleteMessages).not.toHaveBeenCalled();
  });

  // KD-7, KD-8: `beforeDelete` sees the tail before it is deleted, only when it will be deleted,
  // and its exception cancels the delete and propagates.
  it.each<{
    name: string;
    userMessageId: string;
    fails: boolean;
    journal: string[];
  }>([
    {
      name: 'resend → called with the tail oldest first, then the tail is deleted',
      userMessageId: 'u1',
      fails: false,
      journal: ['beforeDelete:a1,d1,r1', 'delete:a1,d1,r1'],
    },
    {
      name: 'its exception → nothing deleted, the exception propagates',
      userMessageId: 'u1',
      fails: true,
      journal: ['beforeDelete:a1,d1,r1'],
    },
    {
      name: 'new message → not called, nothing deleted',
      userMessageId: 'u-new',
      fails: false,
      journal: [],
    },
  ])('beforeDelete: $name', async ({ userMessageId, fails, journal }) => {
    const { service, deleteMessages } = fakeMemory(
      stored(
        ['user', 'u1'],
        ['assistant', 'a1'],
        ['user', 'd1', decision],
        ['assistant', 'r1', decisionReply],
      ),
    );
    const failure = new Error('hook failed');
    const calls: string[] = [];
    deleteMessages.mockImplementation((messageIds) => {
      calls.push(`delete:${(messageIds as string[]).join(',')}`);
      return Promise.resolve();
    });
    const beforeDelete = (tail: MastraDBMessage[]): Promise<void> => {
      calls.push(`beforeDelete:${ids(tail).join(',')}`);
      return fails ? Promise.reject(failure) : Promise.resolve();
    };

    const result = service.discardRepliesAfter({
      threadId: 't-1',
      userId: 'u-1',
      userMessageId,
      beforeDelete,
    });

    if (fails) await expect(result).rejects.toBe(failure);
    else await expect(result).resolves.toBeDefined();
    expect(calls).toEqual(journal);
  });
});

const thread = (title: string): StorageThreadType => ({
  id: 't-1',
  resourceId: 'u-1',
  title,
  createdAt: new Date('2026-10-29T09:00:00.000Z'),
  updatedAt: new Date('2026-10-29T10:00:00.000Z'),
});

/** What `updateThread` raises for a missing thread (deleted after the ownership check). */
const threadMissingError = (): MastraError =>
  new MastraError({
    id: 'MASTRA_STORAGE_UPDATE_THREAD_FAILED',
    domain: ErrorDomain.STORAGE,
    category: ErrorCategory.USER,
    text: 'Thread t-1 not found',
  });

/** A real Memory whose thread reads and writes are replaced: no database is touched. */
const fakeThreadMemory = () => {
  const memory = new Memory({ options: { lastMessages: 20 } });
  const getThreadById = vi.spyOn(memory, 'getThreadById');
  const updateThread = vi.spyOn(memory, 'updateThread');
  const service = new ThreadsService(
    memory,
    new ThreadWriteLock(),
    new ThreadRunRegistry(5_000),
    new ThreadDeletionHooks(),
    5_000,
  );
  return { service, getThreadById, updateThread };
};

const renameInput = { threadId: 't-1', userId: 'u-1', title: 'Отчёт Q3' };

// AC-14.2 / AC-14.3 / AC-15.3: the single ownership check raises the shared 404 body.
describe('ThreadsService.getOwnedThread', () => {
  it('throws NotFoundException with the threadNotFound() body when the thread is missing or foreign', async () => {
    const { service, getThreadById } = fakeThreadMemory();
    getThreadById.mockResolvedValue(null);

    const result = service.getOwnedThread('t-1', 'u-1');

    await expect(result).rejects.toBeInstanceOf(NotFoundException);
    await expect(result).rejects.toMatchObject({
      response: threadNotFound().getResponse(),
    });
    expect(getThreadById).toHaveBeenCalledWith({
      threadId: 't-1',
      resourceId: 'u-1',
    });
  });
});

// Risk: PostgresStore.listThreads drops the resourceId filter for a falsy value, so an empty
// userId would list every user's threads; both owner-scoped entry points fail before storage is read.
describe('ThreadsService rejects an empty userId in list and getOwnedThread', () => {
  it.each<{
    name: string;
    call: (service: ThreadsService) => Promise<unknown>;
  }>([
    { name: 'list', call: (service) => service.list('') },
    {
      name: 'getOwnedThread',
      call: (service) => service.getOwnedThread('t-1', ''),
    },
  ])(
    '$name with an empty userId throws without reading storage',
    async ({ call }) => {
      const memory = new Memory({ options: { lastMessages: 20 } });
      const foreignThreads = [thread('Чужая')];
      const listThreads = vi.spyOn(memory, 'listThreads').mockResolvedValue({
        threads: foreignThreads,
        total: foreignThreads.length,
        page: 0,
        perPage: false,
        hasMore: false,
      });
      const getThreadById = vi
        .spyOn(memory, 'getThreadById')
        .mockResolvedValue(thread('Чужая'));
      const service = new ThreadsService(
        memory,
        new ThreadWriteLock(),
        new ThreadRunRegistry(5_000),
        new ThreadDeletionHooks(),
        5_000,
      );

      const error: unknown = await call(service).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(NotFoundException);
      expect(listThreads).not.toHaveBeenCalled();
      expect(getThreadById).not.toHaveBeenCalled();
    },
  );
});

// AC-15.1 / AC-15.3 and Failure Mode "unavailable boundary": rename maps only a vanished thread to 404.
describe('ThreadsService.rename', () => {
  it('renaming to the same title again answers the same title (same-value)', async () => {
    const { service, getThreadById, updateThread } = fakeThreadMemory();
    getThreadById.mockResolvedValue(thread('Отчёт Q3'));
    updateThread.mockResolvedValue(thread('Отчёт Q3'));

    const first = await service.rename(renameInput);
    const second = await service.rename(renameInput);

    expect(first.title).toBe('Отчёт Q3');
    expect(second.title).toBe('Отчёт Q3');
  });

  it.each<{
    name: string;
    updateError: Error;
    reRead: StorageThreadType | null | Error;
    expected: 'not-found' | 'update-error';
  }>([
    {
      name: 'MastraError of category USER → 404',
      updateError: threadMissingError(),
      reRead: thread(''),
      expected: 'not-found',
    },
    {
      name: 'other error while the thread still exists → the same error',
      updateError: new Error('db down'),
      reRead: thread(''),
      expected: 'update-error',
    },
    {
      name: 'other error and the re-read returns null → 404',
      updateError: new Error('db down'),
      reRead: null,
      expected: 'not-found',
    },
    {
      name: 'other error and the re-read rejects → the original updateThread error',
      updateError: new Error('db down'),
      reRead: new Error('re-read failed'),
      expected: 'update-error',
    },
  ])('$name', async ({ updateError, reRead, expected }) => {
    const { service, getThreadById, updateThread } = fakeThreadMemory();
    getThreadById.mockResolvedValueOnce(thread(''));
    if (reRead instanceof Error) getThreadById.mockRejectedValueOnce(reRead);
    else getThreadById.mockResolvedValueOnce(reRead);
    updateThread.mockRejectedValue(updateError);

    const error: unknown = await service.rename(renameInput).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    if (expected === 'update-error') {
      expect(error).toBe(updateError);
    } else {
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error).toMatchObject({
        response: threadNotFound().getResponse(),
      });
    }
  });
});

// AC-16.2 and KD-6: delete checks the owner before touching runs, then deletes inside cancelRunsThen under the lock.
describe('ThreadsService.delete', () => {
  const setup = () => {
    const memory = new Memory({ options: { lastMessages: 20 } });
    const lock = new ThreadWriteLock();
    const runs = new ThreadRunRegistry(5_000);
    const journal: string[] = [];
    const getThreadById = vi.spyOn(memory, 'getThreadById');
    const deleteThread = vi
      .spyOn(memory, 'deleteThread')
      .mockImplementation((threadId: string) => {
        journal.push(
          `deleteThread ${threadId} locked=${lock.isHeld(threadId)}`,
        );
        return Promise.resolve();
      });
    const cancelRunsThen = vi
      .spyOn(runs, 'cancelRunsThen')
      .mockImplementation(async (threadId, action) => {
        journal.push(`cancelRunsThen ${threadId} start`);
        await action();
        journal.push(`cancelRunsThen ${threadId} end`);
      });
    const service = new ThreadsService(
      memory,
      lock,
      runs,
      new ThreadDeletionHooks(),
      5_000,
    );
    return { service, journal, getThreadById, deleteThread, cancelRunsThen };
  };

  it('a missing or foreign thread → NotFoundException; runs are not cancelled and nothing is deleted', async () => {
    const { service, getThreadById, deleteThread, cancelRunsThen } = setup();
    getThreadById.mockResolvedValue(null);

    const result = service.delete('t-1', 'u-2');

    await expect(result).rejects.toBeInstanceOf(NotFoundException);
    expect(getThreadById).toHaveBeenCalledWith({
      threadId: 't-1',
      resourceId: 'u-2',
    });
    expect(cancelRunsThen).not.toHaveBeenCalled();
    expect(deleteThread).not.toHaveBeenCalled();
  });

  it('an own thread is deleted only inside the cancelRunsThen action and under the thread lock', async () => {
    const { service, journal, getThreadById } = setup();
    getThreadById.mockResolvedValue(thread('Отчёт Q3'));

    await service.delete('t-1', 'u-1');

    expect(journal).toEqual([
      'cancelRunsThen t-1 start',
      'deleteThread t-1 locked=true',
      'cancelRunsThen t-1 end',
    ]);
  });
});
