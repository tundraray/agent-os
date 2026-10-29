import type { MastraDBMessage } from '@mastra/core/memory';
import { Memory } from '@mastra/memory';
import { ThreadsService } from './threads.service.js';

type Role = 'user' | 'assistant';

/** Stored messages in the order the installed Mastra `recall` returns them: oldest first. */
const stored = (...messages: [Role, string][]): MastraDBMessage[] =>
  messages.map(([role, id], index) => ({
    id,
    role,
    threadId: 't-1',
    resourceId: 'u-1',
    createdAt: new Date(Date.UTC(2026, 9, 29, 10, 0, index)),
    content: { format: 2, parts: [{ type: 'text', text: id }] },
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
  return { memory, recall, deleteMessages };
};

// AC-14.6: the stored reply after the newest user message is discarded only on a resend of that same message.
describe('ThreadsService.discardRepliesAfter', () => {
  it.each<{
    name: string;
    messages: MastraDBMessage[];
    userMessageId: string;
    deleted: string[] | null;
  }>([
    {
      name: 'resend of the newest user message with one reply → reply deleted',
      messages: stored(['user', 'u1'], ['assistant', 'a1']),
      userMessageId: 'u1',
      deleted: ['a1'],
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
    },
    {
      name: 'ordinary send (new id) → nothing deleted',
      messages: stored(['user', 'u1'], ['assistant', 'a1']),
      userMessageId: 'u-new',
      deleted: null,
    },
    {
      name: 'newest user message has no reply → nothing deleted',
      messages: stored(['user', 'u0'], ['assistant', 'a0'], ['user', 'u1']),
      userMessageId: 'u1',
      deleted: null,
    },
    {
      name: 'resend of an older user message → nothing deleted',
      messages: stored(
        ['user', 'u0'],
        ['assistant', 'a0'],
        ['user', 'u1'],
        ['assistant', 'a1'],
      ),
      userMessageId: 'u0',
      deleted: null,
    },
    {
      name: 'no user message among the newest 20 → nothing deleted',
      messages: stored(['assistant', 'a1'], ['assistant', 'a2']),
      userMessageId: 'a1',
      deleted: null,
    },
  ])('$name', async ({ messages, userMessageId, deleted }) => {
    const { memory, recall, deleteMessages } = fakeMemory(messages);

    await new ThreadsService(memory).discardRepliesAfter({
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
    if (deleted) expect(deleteMessages).toHaveBeenCalledWith(deleted);
    else expect(deleteMessages).not.toHaveBeenCalled();
  });
});
