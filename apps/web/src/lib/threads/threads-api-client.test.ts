import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { threadsApiClient } from './threads-api-client';
import { ThreadsApiError } from './threads-api-error';

const API = 'http://api.test';

type Case = {
  name: string;
  handler: Parameters<typeof server.use>[0];
  call: () => Promise<unknown>;
  expected: { kind: ThreadsApiError['kind']; status: number | undefined };
};

const cases: Case[] = [
  {
    name: 'getThread: 200 with a body outside ThreadSummarySchema → invalid_response',
    handler: http.get(`${API}/api/threads/a`, () => HttpResponse.json({ id: 'a', title: 42 })),
    call: () => threadsApiClient.getThread('a'),
    expected: { kind: 'invalid_response', status: 200 },
  },
  {
    name: 'listThreads: 200 with a non-JSON body → invalid_response',
    handler: http.get(`${API}/api/threads`, () => HttpResponse.text('<html>')),
    call: () => threadsApiClient.listThreads(),
    expected: { kind: 'invalid_response', status: 200 },
  },
  {
    name: 'getThread: 404 → not_found',
    handler: http.get(`${API}/api/threads/a`, () => HttpResponse.json({}, { status: 404 })),
    call: () => threadsApiClient.getThread('a'),
    expected: { kind: 'not_found', status: 404 },
  },
  {
    name: 'getThread: 400 on :threadId → not_found',
    handler: http.get(`${API}/api/threads/a`, () => HttpResponse.json({}, { status: 400 })),
    call: () => threadsApiClient.getThread('a'),
    expected: { kind: 'not_found', status: 400 },
  },
  {
    name: 'getConversation: 404 THREAD_NOT_FOUND → not_found',
    handler: http.get(`${API}/api/threads/a/history`, () =>
      HttpResponse.json(
        { statusCode: 404, message: 'Not found', errorCode: 'THREAD_NOT_FOUND' },
        { status: 404 },
      ),
    ),
    call: () => threadsApiClient.getConversation('a', 0),
    expected: { kind: 'not_found', status: 404 },
  },
  {
    name: 'renameThread: 400 (invalid title) stays http',
    handler: http.patch(`${API}/api/threads/a`, () => HttpResponse.json({}, { status: 400 })),
    call: () => threadsApiClient.renameThread({ threadId: 'a', title: 'Новое' }),
    expected: { kind: 'http', status: 400 },
  },
  {
    name: 'getConversation: 500 → http',
    handler: http.get(`${API}/api/threads/a/history`, () => HttpResponse.json({}, { status: 500 })),
    call: () => threadsApiClient.getConversation('a', 0),
    expected: { kind: 'http', status: 500 },
  },
  {
    name: 'listThreads: network failure → network',
    handler: http.get(`${API}/api/threads`, () => HttpResponse.error()),
    call: () => threadsApiClient.listThreads(),
    expected: { kind: 'network', status: undefined },
  },
  {
    name: 'getConversation: 200 with a body outside ConversationViewSchema → invalid_response',
    handler: http.get(`${API}/api/threads/a/history`, () => HttpResponse.json({ entries: 'none' })),
    call: () => threadsApiClient.getConversation('a', 0),
    expected: { kind: 'invalid_response', status: 200 },
  },
];

describe('threadsApiClient: error classification', () => {
  it.each(cases)('$name', async ({ handler, call, expected }) => {
    server.use(handler);

    const error = await call().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error).toMatchObject({ name: 'ThreadsApiError', ...expected });
  });
});

describe('threadsApiClient: successful responses', () => {
  it('listThreads sends the cursor as ?cursor= and returns the page', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`${API}/api/threads`, ({ request }) => {
        seen.push(new URL(request.url).search);
        return HttpResponse.json(threadList([threadSummary({ id: 'b' })], null));
      }),
    );

    const page = await threadsApiClient.listThreads('c/1');

    expect(seen).toEqual(['?cursor=c%2F1']);
    expect(page).toEqual({
      threads: [
        {
          id: 'b',
          title: 'Беседа',
          createdAt: '2026-10-28T10:00:00.000Z',
          updatedAt: '2026-10-28T10:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  it('deleteThread resolves on 204', async () => {
    server.use(http.delete(`${API}/api/threads/a`, () => new HttpResponse(null, { status: 204 })));

    await expect(threadsApiClient.deleteThread('a')).resolves.toBeUndefined();
  });
});
