import type { ResearchLaunchView, ThreadResearchResponse } from '@agent-os/contracts';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred, researchLaunchView, threadResearch } from '@/test/fixtures';
import { RESEARCH_POLL_INTERVAL_MS } from './research-poll';
import { createThreadResearch, useThreadResearch, type ThreadResearch } from './thread-research-store';
import { ThreadsApiError, type ThreadsApiErrorKind } from './threads-api-error';

const THREAD_ID = 't-1';

type Reply = ThreadResearchResponse | Error;

/** The answer read (KD-6) is covered by INT-5; the poll here never needs the thread's messages. */
const noMessages = (): Promise<never> => Promise.reject(new Error('stub: messages are not served'));
/** The stop (U-4) replaces this stub where it is exercised. */
const noStop = (): Promise<never> => Promise.reject(new Error('stub: stop is not served'));

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
  return { api: { getThreadResearch, getThreadMessages: noMessages, stopResearch: noStop }, getThreadResearch };
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
    research = createThreadResearch({ api: { getThreadResearch, getThreadMessages: noMessages, stopResearch: noStop } });

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
    const shown = createThreadResearch({ api: { getThreadResearch, getThreadMessages: noMessages, stopResearch: noStop } });
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
    const shown = createThreadResearch({ api: { getThreadResearch, getThreadMessages: noMessages, stopResearch: noStop } });
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

// U-4 (design-web.md KD-3, KD-4, Contract «ThreadResearch.stop», invariants 4 and 5; DC-8, DC-10, DC-11, UC-E6, UC-E8, UC-E9).
// UC-E11 — a state changed by a read alone is announced once — is proven by the announcement table above
// («running to stopped») and «announces an event once even when the next read repeats the state».
describe('ThreadResearch.stop(launchKey) outcomes', () => {
  const kinds = () => research?.store.getState().announcements.map(({ kind }) => kind);

  /** The store with the thread open and its first read settled; `stopResearch` answers with what `stop` returns. */
  async function openWithStop(stop: () => Promise<ResearchLaunchView>, ...reads: Reply[]) {
    const { api, getThreadResearch } = stubApi(...reads);
    const stopResearch = vi.fn((threadId: string, launchKey: string): Promise<ResearchLaunchView> => {
      void threadId;
      void launchKey;
      return stop();
    });
    research = createThreadResearch({ api: { ...api, stopResearch } });
    research.open(THREAD_ID);
    await settle();
    return { shown: research, getThreadResearch, stopResearch };
  }

  // UC-E6 and DC-8: the answer's view stands whatever the launch's fate; only completed, failed and stopped are events,
  // and the next read with the same state adds none (invariant 5).
  it.each<{ name: string; view: Partial<ResearchLaunchView>; events: string[] }>([
    { name: 'stopped', view: { state: 'stopped' }, events: ['stopped'] },
    {
      name: 'completed with its answer',
      view: { state: 'completed', answerMessageId: 'research-answer-inv-1' },
      events: ['completed'],
    },
    { name: 'completed with answerPending', view: { state: 'completed', answerPending: true }, events: [] },
    { name: 'failed', view: { state: 'failed' }, events: ['failed'] },
    { name: 'proposed', view: { state: 'proposed' }, events: [] },
    { name: 'not_launched', view: { state: 'not_launched', notLaunchedReason: 'declined' }, events: [] },
    { name: 'running', view: { state: 'running' }, events: [] },
  ])('a 200 with a $name launch is applied and announces $events once', async ({ view, events }) => {
    const answered = launch(view);
    const other = launch({ launchKey: 'call-2', state: 'running' });
    const { shown, getThreadResearch, stopResearch } = await openWithStop(
      () => Promise.resolve(answered),
      threadResearch([launch({ state: 'running' }), other]),
      threadResearch([answered, other]),
    );

    const outcome = await shown.stop('call-1');

    expect(stopResearch).toHaveBeenCalledWith(THREAD_ID, 'call-1');
    expect(outcome).toEqual({ outcome: 'applied', launch: answered });
    expect(shown.store.getState().launches).toEqual([answered, other]);
    expect(kinds()).toEqual(events);
    const announced = shown.store.getState().announcements;

    await nextPeriod();

    expect(getThreadResearch).toHaveBeenCalledTimes(2);
    expect(shown.store.getState().launches).toEqual([answered, other]);
    expect(shown.store.getState().announcements).toBe(announced);
  });

  // KD-4, DC-10: every client failure is a refusal, warned once without bodies, followed by exactly one state read,
  // which shows a stop the server applied before the failure.
  it.each<{ name: string; kind: ThreadsApiErrorKind; status?: number }>([
    { name: 'no connection or no answer in time', kind: 'network' },
    { name: '404', kind: 'not_found', status: 404 },
    { name: '400', kind: 'not_found', status: 400 },
    { name: '500', kind: 'http', status: 500 },
    { name: 'a body outside the schema', kind: 'invalid_response' },
  ])('$name is refused and followed by exactly one read', async ({ kind, status }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { shown, getThreadResearch } = await openWithStop(
      () => Promise.reject(new ThreadsApiError(kind, status)),
      threadResearch([launch({ state: 'running' })]),
      threadResearch([launch({ state: 'stopped' })]),
    );

    const outcome = await shown.stop('call-1');
    await settle();

    expect(outcome).toEqual({ outcome: 'refused' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[deep-research] research stop request failed', {
      threadId: THREAD_ID,
      kind,
      status,
    });
    expect(getThreadResearch).toHaveBeenCalledTimes(2);
    expect(shown.store.getState().launches).toEqual([launch({ state: 'stopped' })]);
    expect(kinds()).toEqual(['stopped']);
    await nextPeriod();
    await nextPeriod();
    expect(getThreadResearch).toHaveBeenCalledTimes(2);
  });

  it('is stale at once and sends nothing when no thread is open', async () => {
    const stopResearch = vi.fn(noStop);
    research = createThreadResearch({ api: { ...stubApi().api, stopResearch } });

    await expect(research.stop('call-1')).resolves.toEqual({ outcome: 'stale' });
    expect(stopResearch).not.toHaveBeenCalled();
  });

  // UC-E9 (store half): an answer for a thread no longer shown applies nothing, announces nothing and reads nothing.
  it.each<{
    name: string;
    leave: (shown: ThreadResearch) => void;
    answer: 'view' | 'failure';
    launches: ResearchLaunchView[];
  }>([
    { name: 'the store closed, answer 200', leave: (shown) => shown.close(), answer: 'view', launches: [] },
    { name: 'the store closed, answer failed', leave: (shown) => shown.close(), answer: 'failure', launches: [] },
    {
      name: 'another thread opened, answer 200',
      leave: (shown) => shown.open('t-2'),
      answer: 'view',
      launches: [launch({ state: 'running' })],
    },
    {
      name: 'another thread opened, answer failed',
      leave: (shown) => shown.open('t-2'),
      answer: 'failure',
      launches: [launch({ state: 'running' })],
    },
  ])('is stale when $name before it', async ({ leave, answer, launches }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const held = deferred<ResearchLaunchView>();
    const { shown, getThreadResearch } = await openWithStop(() => held.promise, threadResearch([launch({ state: 'running' })]));
    const pending = shown.stop('call-1');
    leave(shown);
    await settle();
    const readsBefore = getThreadResearch.mock.calls.length;

    if (answer === 'view') held.resolve(launch({ state: 'stopped' }));
    else held.reject(new ThreadsApiError('http', 500));

    await expect(pending).resolves.toEqual({ outcome: 'stale' });
    await settle();
    expect(shown.store.getState().launches).toEqual(launches);
    expect(shown.store.getState().announcements).toEqual([]);
    expect(getThreadResearch).toHaveBeenCalledTimes(readsBefore);
    expect(warn).not.toHaveBeenCalled();
  });

  // UC-E8, invariant 4: a read begun before the answer and returned after it would bring back `running` and «Ресерч
  // запущен»; it is dropped and the thread read again.
  it('drops a read that began before the answer and reads again, so the launch stays stopped and is announced once', async () => {
    const heldRead = deferred<ThreadResearchResponse>();
    const getThreadResearch = vi
      .fn<(threadId: string) => Promise<ThreadResearchResponse>>()
      .mockResolvedValueOnce(threadResearch([launch({ state: 'running' })]))
      .mockImplementationOnce(() => heldRead.promise)
      .mockResolvedValue(threadResearch([launch({ state: 'stopped' })]));
    const heldStop = deferred<ResearchLaunchView>();
    const shown = createThreadResearch({
      api: { getThreadResearch, getThreadMessages: noMessages, stopResearch: () => heldStop.promise },
    });
    research = shown;
    const announced: string[] = [];
    shown.store.subscribe((state, previous) => {
      if (state.announcements !== previous.announcements) announced.push(...state.announcements.map(({ kind }) => kind));
    });
    shown.open(THREAD_ID);
    await settle();
    shown.refresh();
    const pending = shown.stop('call-1');

    heldStop.resolve(launch({ state: 'stopped' }));
    await expect(pending).resolves.toEqual({ outcome: 'applied', launch: launch({ state: 'stopped' }) });
    heldRead.resolve(threadResearch([launch({ state: 'running' })]));
    await settle();

    expect(getThreadResearch).toHaveBeenCalledTimes(3);
    expect(shown.store.getState().launches).toEqual([launch({ state: 'stopped' })]);
    expect(announced).toEqual(['stopped']);
  });

  // KD-3, invariant 5: a stop answer applied before the thread's first read settles still announces MC-19; the read
  // that follows takes the baseline — the stopped launch is not announced again, the other launch's state is no event.
  it('announces a stop answered before the first read once, and the first read adds no event', async () => {
    const heldRead = deferred<ThreadResearchResponse>();
    const other = launch({ launchKey: 'call-2', state: 'running' });
    const getThreadResearch = vi
      .fn<(threadId: string) => Promise<ThreadResearchResponse>>()
      .mockImplementationOnce(() => heldRead.promise)
      .mockResolvedValue(threadResearch([launch({ state: 'stopped' }), other]));
    const shown = createThreadResearch({
      api: { getThreadResearch, getThreadMessages: noMessages, stopResearch: () => Promise.resolve(launch({ state: 'stopped' })) },
    });
    research = shown;
    const announced: string[] = [];
    shown.store.subscribe((state, previous) => {
      if (state.announcements !== previous.announcements) announced.push(...state.announcements.map(({ kind }) => kind));
    });
    shown.open(THREAD_ID);

    await expect(shown.stop('call-1')).resolves.toEqual({ outcome: 'applied', launch: launch({ state: 'stopped' }) });
    expect(announced).toEqual(['stopped']);
    heldRead.resolve(threadResearch([launch({ state: 'running' }), other]));
    await settle();
    await nextPeriod();

    expect(shown.store.getState().launches).toEqual([launch({ state: 'stopped' }), other]);
    expect(announced).toEqual(['stopped']);
  });
});
