import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { historyMessages, researchLaunchView, threadList, threadSummary } from '@/test/fixtures';
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
    name: 'getThreadMessages: 400 on :threadId → not_found',
    handler: http.get(`${API}/api/threads/a/messages`, () => HttpResponse.json({}, { status: 400 })),
    call: () => threadsApiClient.getThreadMessages('a'),
    expected: { kind: 'not_found', status: 400 },
  },
  {
    name: 'renameThread: 400 (invalid title) stays http',
    handler: http.patch(`${API}/api/threads/a`, () => HttpResponse.json({}, { status: 400 })),
    call: () => threadsApiClient.renameThread({ threadId: 'a', title: 'Новое' }),
    expected: { kind: 'http', status: 400 },
  },
  {
    name: 'getThreadMessages: 500 → http',
    handler: http.get(`${API}/api/threads/a/messages`, () => HttpResponse.json({}, { status: 500 })),
    call: () => threadsApiClient.getThreadMessages('a'),
    expected: { kind: 'http', status: 500 },
  },
  {
    name: 'listThreads: network failure → network',
    handler: http.get(`${API}/api/threads`, () => HttpResponse.error()),
    call: () => threadsApiClient.listThreads(),
    expected: { kind: 'network', status: undefined },
  },
  {
    name: 'getThreadMessages: a part failing safeValidateUIMessages → invalid_response',
    handler: http.get(`${API}/api/threads/a/messages`, () =>
      HttpResponse.json({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text' }] }] }),
    ),
    call: () => threadsApiClient.getThreadMessages('a'),
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
  it('getThreadMessages returns [] for an empty history without an error', async () => {
    server.use(http.get(`${API}/api/threads/a/messages`, () => HttpResponse.json({ messages: [] })));

    await expect(threadsApiClient.getThreadMessages('a')).resolves.toEqual([]);
  });

  it('getThreadMessages returns the validated messages in server order', async () => {
    server.use(
      http.get(`${API}/api/threads/a/messages`, () => HttpResponse.json({ messages: historyMessages(2) })),
    );

    const messages = await threadsApiClient.getThreadMessages('a');

    expect(messages).toEqual([
      { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Сообщение 1' }] },
      { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Сообщение 2' }] },
    ]);
  });

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

// U-5 (design-web.md KD-4, Contract «threadsApiClient.stopResearch»; DC-10, UC-E5).
describe('threadsApiClient.stopResearch', () => {
  const stopUrl = `${API}/api/threads/t%2F1/research/k%2F1%20x/stop`;
  const stop = (timeoutMs?: number) => threadsApiClient.stopResearch('t/1', 'k/1 x', timeoutMs);
  const neverAnswers = () => new Promise<never>(() => undefined);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends POST without a body to the encoded stop route and returns launch', async () => {
    const seen: { url: string; body: string; credentials: RequestCredentials }[] = [];
    server.use(
      http.post(stopUrl, async ({ request }) => {
        seen.push({ url: request.url, body: await request.text(), credentials: request.credentials });
        return HttpResponse.json({ launch: researchLaunchView({ launchKey: 'k/1 x', state: 'stopped' }) });
      }),
    );

    const launch = await stop();

    expect(seen).toEqual([{ url: stopUrl, body: '', credentials: 'include' }]);
    expect(launch).toMatchObject({ launchKey: 'k/1 x', state: 'stopped' });
  });

  const errorCases: {
    name: string;
    resolver: Parameters<typeof http.post>[1];
    expected: { kind: ThreadsApiError['kind']; status: number | undefined };
  }[] = [
    { name: 'network failure → network', resolver: () => HttpResponse.error(), expected: { kind: 'network', status: undefined } },
    {
      name: '404 THREAD_NOT_FOUND → not_found',
      resolver: () => HttpResponse.json({ code: 'THREAD_NOT_FOUND' }, { status: 404 }),
      expected: { kind: 'not_found', status: 404 },
    },
    {
      name: '404 RESEARCH_LAUNCH_NOT_FOUND → not_found',
      resolver: () => HttpResponse.json({ code: 'RESEARCH_LAUNCH_NOT_FOUND' }, { status: 404 }),
      expected: { kind: 'not_found', status: 404 },
    },
    {
      name: '400 (invalid id) → not_found',
      resolver: () => HttpResponse.json({}, { status: 400 }),
      expected: { kind: 'not_found', status: 400 },
    },
    {
      name: '500 RESEARCH_STOP_FAILED → http',
      resolver: () => HttpResponse.json({ code: 'RESEARCH_STOP_FAILED' }, { status: 500 }),
      expected: { kind: 'http', status: 500 },
    },
    {
      name: '409 → http',
      resolver: () => HttpResponse.json({}, { status: 409 }),
      expected: { kind: 'http', status: 409 },
    },
    {
      name: '200 with a non-JSON body → invalid_response',
      resolver: () => HttpResponse.text('<html>'),
      expected: { kind: 'invalid_response', status: 200 },
    },
    {
      name: '200 with a body outside ResearchStopResponseSchema → invalid_response',
      resolver: () => HttpResponse.json({ launch: { launchKey: 'k/1 x', state: 'halted' } }),
      expected: { kind: 'invalid_response', status: 200 },
    },
  ];

  it.each(errorCases)('$name', async ({ resolver, expected }) => {
    server.use(http.post(stopUrl, resolver));

    const error = await stop().then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(ThreadsApiError);
    expect(error).toMatchObject({ name: 'ThreadsApiError', ...expected });
  });

  /** Headers arrive at once; the body sends its first bytes and then stalls. */
  const stalledBody = () =>
    new HttpResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"launch":'));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it.each([
    { name: 'the default 20 s limit', timeoutMs: undefined, limit: 20_000, resolver: neverAnswers },
    { name: 'an explicit shorter limit', timeoutMs: 500, limit: 500, resolver: neverAnswers },
    { name: 'the default 20 s limit while the body stalls', timeoutMs: undefined, limit: 20_000, resolver: stalledBody },
  ])('aborts an unanswered request after $name → network', async ({ timeoutMs, limit, resolver }) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    server.use(http.post(stopUrl, resolver));
    let outcome: unknown = 'pending';
    void stop(timeoutMs).then(
      () => (outcome = 'resolved'),
      (reason: unknown) => (outcome = reason),
    );

    await vi.advanceTimersByTimeAsync(limit - 1);
    expect(outcome).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(outcome).toBeInstanceOf(ThreadsApiError));

    expect(outcome).toMatchObject({ kind: 'network', status: undefined });
  });
});
