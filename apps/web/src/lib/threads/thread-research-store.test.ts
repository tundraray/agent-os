import type { ResearchLaunchView, ThreadResearchResponse } from '@agent-os/contracts';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { researchLaunchView, threadResearch } from '@/test/fixtures';
import { RESEARCH_POLL_INTERVAL_MS } from './research-poll';
import { createThreadResearch, useThreadResearch, type ThreadResearch } from './thread-research-store';
import { ThreadsApiError } from './threads-api-error';

const THREAD_ID = 't-1';

type Reply = ThreadResearchResponse | Error;

/** The answer read (KD-6) is covered by INT-5; the poll here never needs the thread's messages. */
const noMessages = (): Promise<never> => Promise.reject(new Error('stub: messages are not served'));

/**
 * Stub of `getThreadResearch` (the external boundary): answers each request with the next queued reply, the last
 * reply repeating once the queue is down to it, and records the thread of every request.
 */
function stubApi(...replies: Reply[]) {
  const queue = [...replies];
  const getThreadResearch = vi.fn((threadId: string): Promise<ThreadResearchResponse> => {
    void threadId;
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) return Promise.reject(new Error('stub: no reply queued'));
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  return { api: { getThreadResearch, getThreadMessages: noMessages }, getThreadResearch };
}

const launch = (overrides: Partial<ResearchLaunchView>): ResearchLaunchView =>
  researchLaunchView({ launchKey: 'call-1', ...overrides });

/** Lets the pending stub promise and the store's continuation settle without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const nextPeriod = () => vi.advanceTimersByTimeAsync(RESEARCH_POLL_INTERVAL_MS);

let research: ThreadResearch | null = null;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  research?.close();
  research = null;
  vi.useRealTimers();
});

describe('useThreadResearch — polling (design-chat-entry.md KD-6)', () => {
  // KD-6: the poll lives while a launch is `running` or `completed` with `answerPending`; any other state ends it.
  it.each<{ name: string; view: Partial<ResearchLaunchView>; polls: boolean }>([
    { name: 'running', view: { state: 'running' }, polls: true },
    { name: 'completed with answerPending', view: { state: 'completed', answerPending: true }, polls: true },
    {
      name: 'completed with its answer stored',
      view: { state: 'completed', answerPending: false, answerMessageId: 'research-answer-inv-1' },
      polls: false,
    },
    { name: 'proposed', view: { state: 'proposed' }, polls: false },
    { name: 'not_launched', view: { state: 'not_launched', notLaunchedReason: 'declined' }, polls: false },
    { name: 'failed', view: { state: 'failed' }, polls: false },
    { name: 'stopped', view: { state: 'stopped' }, polls: false },
  ])('a launch $name keeps the poll alive: $polls', async ({ view, polls }) => {
    const { api, getThreadResearch } = stubApi(threadResearch([launch(view)]));
    research = createThreadResearch({ api });

    research.open(THREAD_ID);
    await settle();
    await nextPeriod();
    await nextPeriod();

    expect(getThreadResearch).toHaveBeenCalledTimes(polls ? 3 : 1);
    expect(research.store.getState().launches).toEqual([launch(view)]);
  });

  it('stops polling once the running launch completes with its answer stored', async () => {
    const { api, getThreadResearch } = stubApi(
      threadResearch([launch({ state: 'running' })]),
      threadResearch([launch({ state: 'completed', answerMessageId: 'research-answer-inv-1' })]),
    );
    research = createThreadResearch({ api });

    research.open(THREAD_ID);
    await settle();
    await nextPeriod();
    await nextPeriod();
    await nextPeriod();

    expect(getThreadResearch).toHaveBeenCalledTimes(2);
    expect(research.store.getState().launches[0]?.state).toBe('completed');
  });

  it('stops polling and drops the launches when the thread answers 404', async () => {
    const { api, getThreadResearch } = stubApi(
      threadResearch([launch({ state: 'running' })]),
      new ThreadsApiError('not_found', 404),
      threadResearch([launch({ state: 'running' })]),
    );
    research = createThreadResearch({ api });

    research.open(THREAD_ID);
    await settle();
    await nextPeriod();
    await nextPeriod();
    await nextPeriod();

    expect(getThreadResearch).toHaveBeenCalledTimes(2);
    expect(research.store.getState().launches).toEqual([]);
  });

  it('keeps polling through a failed request while the last known launch is running', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api, getThreadResearch } = stubApi(
      threadResearch([launch({ state: 'running' })]),
      new ThreadsApiError('network'),
      threadResearch([launch({ state: 'running' })]),
    );
    research = createThreadResearch({ api });

    research.open(THREAD_ID);
    await settle();
    await nextPeriod();
    await nextPeriod();

    expect(getThreadResearch).toHaveBeenCalledTimes(3);
    expect(research.store.getState().launches).toEqual([launch({ state: 'running' })]);
  });

  it('reads once after a turn even when nothing keeps the poll alive, and polls on if the read finds a running launch', async () => {
    const { api, getThreadResearch } = stubApi(
      threadResearch([launch({ state: 'proposed' })]),
      threadResearch([launch({ state: 'running' })]),
    );
    research = createThreadResearch({ api });
    research.open(THREAD_ID);
    await settle();
    await nextPeriod();
    expect(getThreadResearch).toHaveBeenCalledTimes(1);

    research.refresh();
    await settle();
    expect(research.store.getState().launches).toEqual([launch({ state: 'running' })]);
    await nextPeriod();

    expect(getThreadResearch).toHaveBeenCalledTimes(3);
  });

  it('reads again after an in-flight request when a turn ends while it is pending', async () => {
    let releaseFirst: (body: ThreadResearchResponse) => void = () => {};
    const getThreadResearch = vi
      .fn<(threadId: string) => Promise<ThreadResearchResponse>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          }),
      )
      .mockResolvedValue(threadResearch([launch({ state: 'stopped' })]));
    research = createThreadResearch({ api: { getThreadResearch, getThreadMessages: noMessages } });

    research.open(THREAD_ID);
    research.refresh();
    releaseFirst(threadResearch([launch({ state: 'running' })]));
    await settle();

    expect(getThreadResearch).toHaveBeenCalledTimes(2);
    expect(research.store.getState().launches).toEqual([launch({ state: 'stopped' })]);
  });

  it('stops polling and ignores a pending reply after unmount', async () => {
    let releaseSecond: (body: ThreadResearchResponse) => void = () => {};
    const getThreadResearch = vi
      .fn<(threadId: string) => Promise<ThreadResearchResponse>>()
      .mockResolvedValueOnce(threadResearch([launch({ state: 'running' })]))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = resolve;
          }),
      )
      .mockResolvedValue(threadResearch([launch({ state: 'running' })]));
    const shown = createThreadResearch({ api: { getThreadResearch, getThreadMessages: noMessages } });
    research = shown;
    const hook = renderHook(({ threadId }) => useThreadResearch(shown, threadId), {
      initialProps: { threadId: THREAD_ID },
    });
    await act(settle);
    await act(nextPeriod);
    expect(getThreadResearch).toHaveBeenCalledTimes(2);

    hook.unmount();
    releaseSecond(threadResearch([launch({ state: 'failed' })]));
    await settle();
    await nextPeriod();
    await nextPeriod();

    expect(getThreadResearch).toHaveBeenCalledTimes(2);
    expect(shown.store.getState().launches).toEqual([]);
  });

  it('clears the launches and reads the new thread when the open thread changes', async () => {
    const getThreadResearch = vi.fn((threadId: string) =>
      Promise.resolve(
        threadId === THREAD_ID
          ? threadResearch([launch({ state: 'running' })])
          : threadResearch([launch({ launchKey: 'call-2', state: 'proposed' })]),
      ),
    );
    const shown = createThreadResearch({ api: { getThreadResearch, getThreadMessages: noMessages } });
    research = shown;
    const hook = renderHook(({ threadId }) => useThreadResearch(shown, threadId), {
      initialProps: { threadId: THREAD_ID as string | null },
    });
    await act(settle);
    expect(hook.result.current.launches).toEqual([launch({ state: 'running' })]);

    hook.rerender({ threadId: 't-2' });
    expect(hook.result.current.launches).toEqual([]);
    await act(settle);
    await act(nextPeriod);
    await act(nextPeriod);

    expect(hook.result.current.launches).toEqual([launch({ launchKey: 'call-2', state: 'proposed' })]);
    expect(getThreadResearch.mock.calls.map(([threadId]) => threadId)).toEqual([THREAD_ID, 't-2']);
  });
});

describe('useThreadResearch — announcements (UXRD Accessibility, MC-17…MC-20)', () => {
  // One announcement per event; the states the thread already had when it opened are not events.
  it.each<{ name: string; before: Partial<ResearchLaunchView> | null; after: Partial<ResearchLaunchView>; kind: string | null }>([
    { name: 'a new running launch', before: null, after: { state: 'running' }, kind: 'launched' },
    { name: 'proposal confirmed', before: { state: 'proposed' }, after: { state: 'running' }, kind: 'launched' },
    {
      name: 'running to completed with the answer stored',
      before: { state: 'running' },
      after: { state: 'completed', answerMessageId: 'research-answer-inv-1' },
      kind: 'completed',
    },
    {
      name: 'a removed answer appended again',
      before: { state: 'completed', answerPending: true },
      after: { state: 'completed', answerMessageId: 'research-answer-inv-1' },
      kind: 'completed',
    },
    { name: 'running to completed, answer still pending', before: { state: 'running' }, after: { state: 'completed', answerPending: true }, kind: null },
    { name: 'running to stopped', before: { state: 'running' }, after: { state: 'stopped' }, kind: 'stopped' },
    { name: 'running to failed', before: { state: 'running' }, after: { state: 'failed' }, kind: 'failed' },
    { name: 'proposal declined', before: { state: 'proposed' }, after: { state: 'not_launched', notLaunchedReason: 'declined' }, kind: null },
    { name: 'still running', before: { state: 'running' }, after: { state: 'running' }, kind: null },
  ])('$name announces $kind', async ({ before, after, kind }) => {
    const { api } = stubApi(
      threadResearch(before === null ? [] : [launch(before)]),
      threadResearch([launch({ ...after, sourceMode: 'model_knowledge' })]),
    );
    research = createThreadResearch({ api });
    research.open(THREAD_ID);
    await settle();
    expect(research.store.getState().announcements).toEqual([]);

    research.refresh();
    await settle();

    expect(research.store.getState().announcements.map(({ kind: k, launchKey, sourceMode }) => ({ k, launchKey, sourceMode }))).toEqual(
      kind === null ? [] : [{ k: kind, launchKey: 'call-1', sourceMode: 'model_knowledge' }],
    );
  });

  it('announces an event once even when the next read repeats the state', async () => {
    const { api } = stubApi(threadResearch([]), threadResearch([launch({ state: 'running' })]));
    research = createThreadResearch({ api });
    research.open(THREAD_ID);
    await settle();
    research.refresh();
    await settle();
    const [first] = research.store.getState().announcements;

    await nextPeriod();

    expect(research.store.getState().announcements).toEqual([first]);
  });
});
