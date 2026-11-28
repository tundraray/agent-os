import {
  AGENTS_BRIEF_CONFIRMATION,
  AGENTS_QUESTION_CONFIRMATION,
  type ChipRecord,
  type Confirmation,
  type ConversationView,
  type AgentPageView,
  type DecisionRequest,
  type HistoryEntry,
  type HistoryQuery,
  type InterruptResponse,
  type RestartResponse,
  type SendMessageResponse,
} from '@agent-os/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { createCoalescedRunner } from '@/lib/live/coalesced-runner';
import type { Announcement, AnnouncerStore } from '@/lib/live/announcer-store';
import type { logger as appLogger } from '@/lib/logger';
import type {
  HistoryStatus,
  SendFailure,
  ShellStatusStore,
} from '@/lib/threads/shell-status-store';
import type { ThreadsApiClient } from '@/lib/threads/threads-api-client';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';

import {
  applyDraftPart,
  draftAfterRead,
  drawsPending,
  feedViewOf,
  isBusy,
  lacksTask,
  type DraftPart,
  type FeedView,
  type OptimisticEntry,
} from './to-feed';

/** What the store shows: a conversation or an agent page. */
export type FeedSource =
  { kind: 'thread'; threadId: string } | { kind: 'agent'; agentId: string };

export type FeedState = {
  /**
   * Every entry read so far, with the rest of the latest page; null until the first read succeeds. Its `hasOlder` comes
   * from the first read and from each earlier window (live-feed KD-2).
   */
  view: FeedView | null;
  /** The greatest `seq` read: the next re-read continues after it. */
  lastSeq: number;
  /** The last load of an earlier window failed: the feed shows MC-1 with «Повторить» in place of the button (KD-2). */
  earlierFailed: boolean;
  /** The observed agent's answer assembled from `delta` parts. */
  draft: string | null;
  optimistic: readonly OptimisticEntry[];
  /** The first read succeeded, or the conversation was created in this tab and has nothing to load. */
  loaded: boolean;
  /** The screen's error state: the first read failed, or a read or command found nothing. */
  loadError: 'not_found' | 'failed' | null;
  /**
   * The last message the server did not accept: the composer returns its text with the refusal's notice
   * under the field — MC-16 for a library refusal (an unavailable chip, a refused first message), else MC-27.
   * The chip itself never leaves `composerSeed` until the send is accepted (KD-5).
   */
  sendFailure: SendFailure | null;
};

export type FeedStore = StoreApi<FeedState> & {
  /**
   * The first read takes the last window of the history, and its failure is the screen's load error; a later one
   * reads on from `lastSeq`, and its failure keeps the view (design-web.md, Error handling).
   */
  load: () => Promise<void>;
  /**
   * Reads the window before the first entry and puts it in front (live-feed KD-2); never rejects: a failure sets
   * `earlierFailed`, and the next call asks for the same window.
   */
  loadEarlier: () => Promise<void>;
  /**
   * Replaces the entries with the window that ends at `seq` and the page after it in one change, then reads on to
   * the end (live-feed KD-4); never rejects: a failure is logged and keeps the feed.
   */
  openAt: (seq: number) => Promise<void>;
  applyDelta: (part: DraftPart) => void;
  /**
   * Rejects when the server did not accept the message. `record` — the composer's chip: the message
   * carries its id (KD-5, Invariant 4); an agent page has no chip. `quiet` — a card's button sent it: a refusal
   * stays on the card and never returns the text to the composer (create-and-test KD-4).
   */
  send: (
    text: string,
    record?: ChipRecord,
    options?: { quiet: boolean },
  ) => Promise<void>;
  /** Stops the agent's work; a message is never part of it. Rejects when the server did not take it. */
  interrupt: () => Promise<void>;
  /** `allowInConversation` — «Разрешить в этой беседе» on an MCP tool's card (KD-6). */
  decide: (decisionId: string, decision: DecisionRequest) => Promise<void>;
  /** Stops the agent, or a conversation's root. */
  stop: () => Promise<void>;
  /** Resolves with the new agent the caller opens. */
  restart: () => Promise<RestartResponse>;
  /** Drops a queued read; the screen closed. */
  dispose: () => void;
};

type FeedLogger = Pick<typeof appLogger, 'info' | 'warn'>;

export type CreateFeedStoreInput = {
  source: FeedSource;
  api: ThreadsApiClient;
  /** The shell's history statuses: a conversation writes `loading`, `ready`, `not_found`, `load_failed`, `deleted`. */
  status?: ShellStatusStore;
  announcer: AnnouncerStore;
  logger: FeedLogger;
  /** A message was accepted: the conversation rises in the list. */
  onActivity?: () => void;
};

const askedBy = (view: FeedView, decision: Confirmation): 'chat' | 'agent' =>
  view.kind === 'thread' && decision.agentId === view.chat.rootAgentId
    ? 'chat'
    : 'agent';

/**
 * MC-25 for decisions that opened since the previous read; a deep agent's brief — deep-agents MC-22. Each new question
 * card has its own phrase (agent-guidance MC-5), so several at once still say who asks; the rest read as before.
 */
function decisionAnnouncements(
  view: FeedView,
  opened: readonly Confirmation[],
): Announcement[] {
  const questions = opened.filter(
    (d) => d.kind === AGENTS_QUESTION_CONFIRMATION,
  );
  const others = opened.filter((d) => d.kind !== AGENTS_QUESTION_CONFIRMATION);
  const other = decisionAnnouncement(view, others);
  return [
    ...questions.map((question): Announcement => ({
      key: 'announce.questionAsked',
      values: { who: askedBy(view, question), agent: question.description },
    })),
    ...(other === null ? [] : [other]),
  ];
}

function decisionAnnouncement(
  view: FeedView,
  opened: readonly Confirmation[],
): Announcement | null {
  if (opened.length === 0) return null;
  if (opened.length > 1)
    return {
      key: 'announce.decisionsOpened',
      values: { count: opened.length },
    };
  const [decision] = opened;
  if (decision.kind === AGENTS_BRIEF_CONFIRMATION)
    return { key: 'announce.briefReady' };
  return {
    key: 'announce.decisionRequested',
    values: {
      who: askedBy(view, decision),
      agent: decision.description,
      // Only a call without a server is a built-in tool's; an MCP tool reads by its name.
      tool:
        decision.server === null
          ? { builtinTool: decision.tool }
          : decision.tool,
    },
  };
}

export function createFeedStore({
  source,
  api,
  status,
  announcer,
  logger,
  onActivity,
}: CreateFeedStoreInput): FeedStore {
  const ids =
    source.kind === 'thread'
      ? { threadId: source.threadId }
      : { agentId: source.agentId };
  let localSeq = 0;
  // A conversation created in this tab (`initialize()` marked it ready) has nothing to load: its feed is
  // ready at once, so the first read neither shows the skeleton nor blocks sending.
  const createdHere =
    source.kind === 'thread' &&
    status?.getState().history[source.threadId] === 'ready';

  const store = createStore<FeedState>()(() => ({
    view: null,
    lastSeq: 0,
    earlierFailed: false,
    draft: null,
    optimistic: [],
    loaded: createdHere,
    loadError: null,
    sendFailure: null,
  }));
  const { getState: get, setState: set } = store;

  const setHistory = (value: HistoryStatus): void => {
    if (source.kind === 'thread')
      status?.getState().setHistory(source.threadId, value);
  };

  const readPage = (
    query: HistoryQuery,
  ): Promise<ConversationView | AgentPageView> =>
    source.kind === 'thread'
      ? api.getConversation(source.threadId, query)
      : api.getAgentPage(source.agentId, query);

  // Every read of the store waits in this one queue, so the answers of a re-read, an earlier window and a jump to an
  // entry never interleave (live-feed §C3). A job's rejection still reaches its caller through `next`.
  let tail: Promise<void> = Promise.resolve();
  function inQueue(job: () => Promise<void>): Promise<void> {
    const next = tail.then(job);
    tail = next.catch(() => undefined);
    return next;
  }

  function announce(
    previous: FeedView,
    next: FeedView,
    added: readonly HistoryEntry[],
  ): void {
    const known = new Set(previous.decisions.map((d) => d.decisionId));
    const opened = next.decisions.filter(
      (d) => d.status === 'open' && !known.has(d.decisionId),
    );
    for (const decision of decisionAnnouncements(next, opened))
      announcer.getState().announce(decision.key, decision.values);
    for (const entry of added) {
      if (entry.kind === 'child_report') {
        announcer.getState().announce('announce.reportArrived', {
          description: entry.content.description,
        });
      }
    }
  }

  /** Optimistic entries a successful read retires (KD-4); `eligible` existed when the read started. */
  function remaining(
    optimistic: readonly OptimisticEntry[],
    eligible: ReadonlySet<string>,
    view: FeedView,
  ): readonly OptimisticEntry[] {
    return optimistic.filter((entry) => {
      if (entry.first) return lacksTask(view);
      if (!eligible.has(entry.localId)) return true;
      if (entry.place === 'tray') return false;
      return view.pending.some((pending) => drawsPending(entry, pending));
    });
  }

  /**
   * Pages from `fromSeq` until `nextAfterSeq` is null: the last page and the entries after `fromSeq`. Without
   * `fromSeq` the first page is the last window of the history.
   */
  async function readToEnd(fromSeq: number | null): Promise<{
    page: ConversationView | AgentPageView;
    added: HistoryEntry[];
    lastSeq: number;
  }> {
    const added: HistoryEntry[] = [];
    let lastSeq = fromSeq ?? 0;
    let page = await readPage(fromSeq === null ? {} : { afterSeq: fromSeq });
    for (;;) {
      for (const entry of page.entries) {
        // Invariant 2: an entry already read is never added again.
        if (entry.seq > lastSeq) {
          added.push(entry);
          lastSeq = entry.seq;
        }
      }
      if (page.nextAfterSeq === null) return { page, added, lastSeq };
      page = await readPage({ afterSeq: page.nextAfterSeq });
    }
  }

  /** One read: the last window until the first success, then from `lastSeq`; never rejects. */
  async function read(): Promise<void> {
    const before = get();
    const refreshing = before.loaded;
    const eligible = new Set(before.optimistic.map((entry) => entry.localId));
    if (!refreshing) setHistory('loading');

    let result: Awaited<ReturnType<typeof readToEnd>>;
    try {
      result = await readToEnd(refreshing ? before.lastSeq : null);
    } catch (error) {
      const description = describeApiError(error);
      if (description.kind === 'not_found') {
        logger.warn('feed view not found', { ...description, ...ids });
        setHistory('not_found');
        set({ loadError: 'not_found' });
      } else if (refreshing) {
        logger.warn('feed refresh failed', { ...description, ...ids });
      } else {
        logger.warn('feed load failed', { ...description, ...ids });
        setHistory('load_failed');
        set({ loadError: 'failed' });
      }
      return;
    }

    const { page, added, lastSeq } = result;
    const current = get();
    const pageView = feedViewOf(page);
    // A re-read page says nothing of the entries before the feed: `hasOlder` stays the feed's own.
    const view: FeedView =
      refreshing && current.view !== null
        ? {
            ...pageView,
            hasOlder: current.view.hasOlder,
            entries: [...current.view.entries, ...added],
          }
        : { ...pageView, entries: added };
    set({
      view,
      lastSeq,
      draft: draftAfterRead({
        draftAtStart: before.draft,
        draft: current.draft,
        added: added.length,
        view,
      }),
      optimistic: remaining(current.optimistic, eligible, view),
      loaded: true,
      loadError: null,
    });
    setHistory('ready');
    // MC-25 only from a re-read: the first load announces nothing.
    if (refreshing && before.view !== null) announce(before.view, view, added);
  }

  const reads = createCoalescedRunner(() => inQueue(read), {
    minIntervalMs: 0,
  });

  /** The window before the first entry goes in front; the conversation's facts stay those of the newer read (KD-2). */
  async function readEarlier(): Promise<void> {
    const before = get().view;
    const first = before?.entries[0];
    if (before?.hasOlder !== true || first === undefined) return;
    set({ earlierFailed: false });
    let page: ConversationView | AgentPageView;
    try {
      page = await readPage({ beforeSeq: first.seq });
    } catch (error) {
      logger.warn('feed earlier load failed', {
        ...describeApiError(error),
        ...ids,
        beforeSeq: first.seq,
      });
      set({ earlierFailed: true });
      return;
    }
    const { view } = get();
    if (view === null) return;
    set({
      view: {
        ...view,
        hasOlder: page.hasOlder,
        entries: [...page.entries, ...view.entries],
      },
    });
  }

  /** The window that ends at `seq` and the page after it replace the entries in one change (KD-4). */
  async function readAround(seq: number): Promise<void> {
    let older: ConversationView | AgentPageView;
    let newer: ConversationView | AgentPageView;
    try {
      older = await readPage({ beforeSeq: seq + 1 });
      newer = await readPage({ afterSeq: seq });
    } catch (error) {
      logger.warn('feed open at entry failed', {
        ...describeApiError(error),
        ...ids,
        seq,
      });
      return;
    }
    const entries = [...older.entries, ...newer.entries];
    set({
      view: { ...feedViewOf(newer), hasOlder: older.hasOlder, entries },
      lastSeq: Math.max(seq, entries.at(-1)?.seq ?? seq),
      earlierFailed: false,
    });
    // The rest of the history comes with the ordinary re-read, below the match; not awaited — it queues after this job.
    if (newer.nextAfterSeq !== null) void reads.request();
  }

  function addOptimistic(
    entry: Omit<OptimisticEntry, 'localId' | 'createdAt'>,
  ): void {
    localSeq += 1;
    const localId = `${localSeq}`;
    set((state) => ({
      optimistic: [
        ...state.optimistic,
        { ...entry, localId, createdAt: new Date().toISOString() },
      ],
    }));
  }

  /** Logs a failed command once, applies what a 404 means for the screen, and rethrows. */
  async function command<T>(
    name: string,
    run: () => Promise<T>,
    extra: Record<string, string> = {},
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const description = describeApiError(error);
      logger.warn(`feed command ${name} failed`, {
        ...description,
        ...ids,
        ...extra,
      });
      if (isApiRequestError(error) && error.kind === 'not_found') {
        if (error.code === 'THREAD_NOT_FOUND') setHistory('deleted');
        if (error.code === 'AGENT_NOT_FOUND') set({ loadError: 'not_found' });
        // The decision is gone with its conversation: the re-read shows «не найдено» (Flow 2).
        if (error.code === 'DECISION_NOT_FOUND') await reads.request();
      }
      throw error;
    }
  }

  type Accepted = Pick<OptimisticEntry, 'messageId' | 'first'>;

  /** The conversation has no task yet: this message would start its root (409 `START_REFUSED`, Flow 2). */
  function firstMessage(): boolean {
    if (source.kind !== 'thread') return false;
    const { view, optimistic } = get();
    const noTask = view === null || lacksTask(view);
    return noTask && !optimistic.some((entry) => entry.first);
  }

  /**
   * Sends text; once the server accepted it, puts the optimistic entry where KD-4 says and re-reads.
   * A refused or lost request leaves no entry and keeps the text and its send key for the composer: the
   * composer's next send repeats that key (runtime-fixes design-send.md, KD-3). A quiet send takes a new key
   * and leaves the composer's failure alone.
   */
  async function deliver(
    text: string,
    call: (sendKey: string) => Promise<Accepted>,
    place: OptimisticEntry['place'],
    record: ChipRecord | null,
    quiet: boolean,
  ): Promise<void> {
    const where = firstMessage() ? 'first_message' : 'message';
    const sendKey =
      (quiet ? undefined : get().sendFailure?.sendKey) ?? crypto.randomUUID();
    if (!quiet) set({ sendFailure: null });
    let accepted: Accepted;
    try {
      accepted = await call(sendKey);
    } catch (error) {
      // A test run's refusal names the agent being trained (MC-17).
      const name = get().view?.training?.run?.agent?.name;
      if (!quiet)
        set({
          sendFailure: {
            text,
            sendKey,
            cause: error,
            context: {
              where,
              ...(record !== null && { kind: record.kind }),
              ...(name !== undefined && { name }),
            },
          },
        });
      throw error;
    }
    addOptimistic({ text, place, record, ...accepted });
    onActivity?.();
    await reads.request();
  }

  const sendCall = (
    text: string,
    sendKey: string,
    record: ChipRecord | null,
  ): Promise<SendMessageResponse> =>
    source.kind === 'thread'
      ? api.sendThreadMessage(source.threadId, text, sendKey, record?.id)
      : api.sendAgentMessage(source.agentId, text, sendKey);

  const interruptCall = (): Promise<InterruptResponse> =>
    source.kind === 'thread'
      ? api.interruptThread(source.threadId)
      : api.interruptAgent(source.agentId);

  function agentOnly(name: string): string {
    if (source.kind !== 'agent')
      throw new Error(`${name} is an agent page command`);
    return source.agentId;
  }

  return Object.assign(store, {
    load: () => reads.request(),
    loadEarlier: () => inQueue(readEarlier),
    openAt: (seq: number) => inQueue(() => readAround(seq)),
    applyDelta: (part: DraftPart) => {
      const draft = applyDraftPart(get().draft, part);
      if (draft !== get().draft) set({ draft });
    },
    send: (text: string, record?: ChipRecord, options?: { quiet: boolean }) => {
      // Only a conversation's message carries a chip (KD-5).
      const chip = source.kind === 'thread' ? (record ?? null) : null;
      return deliver(
        text,
        async (sendKey) => {
          // A refusal of a message with a chip is logged by `command` with `recordId` and its code.
          const extra: Record<string, string> =
            chip === null ? {} : { recordId: chip.id };
          const { messageId } = await command(
            'send',
            () => sendCall(text, sendKey, chip),
            extra,
          );
          if (chip !== null)
            logger.info('feed command send done', {
              ...ids,
              recordId: chip.id,
              outcome: 'accepted',
            });
          // A null `messageId` is the conversation's first message: it becomes the task.
          return { messageId, first: messageId === null };
        },
        isBusy(get().view) ? 'tray' : 'feed',
        chip,
        options?.quiet ?? false,
      );
    },
    interrupt: async () => {
      await command('interrupt', interruptCall);
      await reads.request();
    },
    decide: async (decisionId: string, decision: DecisionRequest) => {
      await command('decide', () => api.decide(decisionId, decision), {
        decisionId,
      });
      await reads.request();
    },
    stop: async () => {
      // A conversation stops its root, whose id is the conversation's (a training's «Стоп», self-learning KD-3).
      const agentId =
        source.kind === 'thread' ? source.threadId : source.agentId;
      await command('stop', () => api.stopAgent(agentId));
      await reads.request();
    },
    restart: async () => {
      const agentId = agentOnly('restart');
      // A refusal (409 `START_REFUSED` included) is logged by `command` with `agentId` and its code.
      const response = await command('restart', () =>
        api.restartAgent(agentId),
      );
      logger.info('feed command restart done', {
        agentId,
        outcome: 'started',
        newAgentId: response.agentId,
      });
      await reads.request();
      return response;
    },
    dispose: () => reads.cancel(),
  });
}
