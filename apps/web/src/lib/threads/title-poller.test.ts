import { fromThreadMessageLike, type ThreadMessage } from '@assistant-ui/react';
import type { AssistantStream } from 'assistant-stream';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { createShellStatusStore, type ShellStatusStore } from './shell-status-store';
import { threadsApiClient } from './threads-api-client';
import { createTitlePollStream } from './title-poller';

const REMOTE_ID = 't-1';
const THREAD_URL = `http://api.test/api/threads/${REMOTE_ID}`;

const message = (role: 'user' | 'assistant', text: string, id: string): ThreadMessage =>
  fromThreadMessageLike({ role, content: text }, id, { type: 'complete', reason: 'stop' });

const firstExchange = [message('user', 'Привет', 'm1'), message('assistant', 'Здравствуйте', 'm2')];

/** Reads the stream to its end and returns the concatenated text it emitted. */
async function readText(stream: AssistantStream): Promise<string> {
  let text = '';
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    if (value.type === 'text-delta') text += value.textDelta;
  }
}

/** GET /api/threads/t-1: answers with `respond(n)` for the n-th request (1-based) and records request times. */
function serveThread(respond: (requestNumber: number) => Response) {
  const requestTimes: number[] = [];
  server.use(
    http.get(THREAD_URL, () => {
      requestTimes.push(Date.now());
      return respond(requestTimes.length);
    }),
  );
  return requestTimes;
}

/** Every value `titleWaiting[t-1]` takes, in order, starting from the initial one. */
function recordTitleWaiting(status: ShellStatusStore): boolean[] {
  const values = [status.getState().titleWaiting[REMOTE_ID] === true];
  status.subscribe((state) => {
    const waiting = state.titleWaiting[REMOTE_ID] === true;
    if (waiting !== values[values.length - 1]) values.push(waiting);
  });
  return values;
}

describe('lib/threads/title-poller: createTitlePollStream', () => {
  let status: ShellStatusStore;
  let startedAt: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    startedAt = Date.now();
    status = createShellStatusStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const startPoll = (messages: readonly ThreadMessage[]) =>
    readText(createTitlePollStream({ remoteId: REMOTE_ID, messages, deps: { api: threadsApiClient, status } }));

  it('closes at once without requests while the thread has no assistant answer', async () => {
    const requestTimes = serveThread(() => HttpResponse.json(threadSummary({ id: REMOTE_ID, title: null })));
    const waiting = recordTitleWaiting(status);

    const text = startPoll([message('user', 'Привет', 'm1')]);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await text).toBe('');
    expect(requestTimes).toEqual([]);
    expect(waiting).toEqual([false]);
  });

  it('emits the title from the third request, one second apart, and clears titleWaiting', async () => {
    const requestTimes = serveThread((n) =>
      HttpResponse.json(threadSummary({ id: REMOTE_ID, title: n === 3 ? 'План поездки' : null })),
    );
    const waiting = recordTitleWaiting(status);

    const text = startPoll(firstExchange);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await text).toBe('План поездки');
    expect(requestTimes.map((at) => at - startedAt)).toEqual([0, 1_000, 2_000]);
    expect(waiting).toEqual([false, true, false]);
  });

  it('stops after 15 requests in the 15 s window and closes the stream empty', async () => {
    const requestTimes = serveThread(() => HttpResponse.json(threadSummary({ id: REMOTE_ID, title: null })));
    const waiting = recordTitleWaiting(status);

    const text = startPoll(firstExchange);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await text).toBe('');
    expect(requestTimes.map((at) => at - startedAt)).toEqual([
      0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000, 10_000, 11_000, 12_000, 13_000, 14_000,
    ]);
    expect(waiting).toEqual([false, true, false]);
  });

  it('stops on 404 without further requests', async () => {
    const requestTimes = serveThread(() => HttpResponse.json({ error: 'not_found' }, { status: 404 }));
    const waiting = recordTitleWaiting(status);

    const text = startPoll(firstExchange);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await text).toBe('');
    expect(requestTimes).toEqual([startedAt]);
    expect(waiting).toEqual([false, true, false]);
  });
});
