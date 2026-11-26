import type { ConversationMatch } from '@agent-os/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { describeApiError } from '@/lib/api/api-request';
import type { FeedSource } from '@/lib/feed/feed-store';
import type { logger as appLogger } from '@/lib/logger';
import type { ThreadsApiClient } from '@/lib/threads/threads-api-client';
import { startTimer } from '@/lib/timer';

/** Pause after the last keystroke before a search starts (UXRD SR-01). */
const SEARCH_DEBOUNCE_MS = 300;

/** The field searches from this many characters after trimming (UXRD SR-01, `ConversationSearchQuery.q`). */
const SEARCH_MIN_LENGTH = 2;

/** `idle` while the field holds fewer than SEARCH_MIN_LENGTH characters; `failed` — the last search failed. */
export type SearchStatus = 'idle' | 'loading' | 'ready' | 'failed';

/** The feed target of an opened match (KD-7): the feed of its source takes it (`takeTarget`). */
export type SearchTarget = {
  match: ConversationMatch;
  /** 1-based position of the match in the list, for the open log. */
  position: number;
};

export type SearchState = {
  /** The field's text as typed. */
  query: string;
  status: SearchStatus;
  /** Matches of the last applied answer, newest first; they stay while a new search runs (UXRD Screen 5). */
  matches: readonly ConversationMatch[];
  nextCursor: string | null;
  loadingMore: boolean;
  loadMoreFailed: boolean;
  /** `matchKey` of the last opened match («Открыто», search-result.md); lives until the field is cleared. */
  openedKey: string | null;
  /** The match the feed still has to scroll to and mark; null for a title match, which has no target. */
  target: SearchTarget | null;
};

export type SearchStore = StoreApi<SearchState> & {
  /** The field changed: searches after the pause, or resets the matches below SEARCH_MIN_LENGTH characters. */
  setQuery: (query: string) => void;
  /** Esc and «✕»: the field is empty and the conversation list is back. */
  clear: () => void;
  /** «Повторить»: searches the current text at once. */
  retry: () => void;
  /** «Показать ещё»: reads the page after `nextCursor`. Never rejects. */
  loadMore: () => Promise<void>;
  /** A match was opened from the list at `position` (1-based). */
  open: (match: ConversationMatch, position: number) => void;
  /**
   * The feed of `source` takes its target: returns it and clears it, or returns null and leaves a target of another
   * source in place (the feed being left must not take the one meant for the feed being opened).
   */
  takeTarget: (source: FeedSource) => SearchTarget | null;
};

type SearchLogger = Pick<typeof appLogger, 'info' | 'warn'>;

export type CreateSearchStoreInput = {
  api: Pick<ThreadsApiClient, 'searchConversations'>;
  logger: SearchLogger;
};

/** Identifies a found place: one place is one match (DD KD-5). */
export function matchKey(match: ConversationMatch): string {
  return [
    match.place,
    match.threadId,
    match.agent?.agentId ?? '',
    match.seq ?? match.callId ?? '',
  ].join(':');
}

const trimmed = (query: string): string => query.trim();

/** The field holds a searchable text: matches stand in place of the conversation list (UXRD SR-01). */
export const isSearchActive = (state: SearchState): boolean =>
  trimmed(state.query).length >= SEARCH_MIN_LENGTH;

/** Shell store of the conversation search (DD KD-7): field text, matches and the opened match. */
export function createSearchStore({
  api,
  logger,
}: CreateSearchStoreInput): SearchStore {
  const store = createStore<SearchState>()(() => ({
    query: '',
    status: 'idle',
    matches: [],
    nextCursor: null,
    loadingMore: false,
    loadMoreFailed: false,
    openedKey: null,
    target: null,
  }));
  const { getState: get, setState: set } = store;

  /** Bumped by every search and every reset: an answer to an older number is dropped. */
  let requestNo = 0;
  /** The trimmed text of the last started search. */
  let searched = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  async function search(): Promise<void> {
    cancelTimer();
    const q = trimmed(get().query);
    if (q.length < SEARCH_MIN_LENGTH) return;
    requestNo += 1;
    const number = requestNo;
    searched = q;
    set({ status: 'loading', loadingMore: false, loadMoreFailed: false });
    const durationMs = startTimer();
    try {
      const page = await api.searchConversations(q);
      if (number !== requestNo) return;
      set({
        status: 'ready',
        matches: page.matches,
        nextCursor: page.nextCursor,
      });
    } catch (error) {
      if (number !== requestNo) return;
      // The query text is the employee's own words: never logged (DD §Security).
      logger.warn('conversation search failed', {
        durationMs: durationMs(),
        ...describeApiError(error),
      });
      set({ status: 'failed' });
    }
  }

  function reset(): void {
    cancelTimer();
    requestNo += 1;
    searched = '';
    set({
      status: 'idle',
      matches: [],
      nextCursor: null,
      loadingMore: false,
      loadMoreFailed: false,
      openedKey: null,
    });
  }

  function setQuery(query: string): void {
    set({ query });
    const q = trimmed(query);
    if (q.length < SEARCH_MIN_LENGTH) {
      reset();
      return;
    }
    // A space added or removed at the edge searches nothing new.
    if (q === searched && get().status !== 'failed') {
      cancelTimer();
      return;
    }
    cancelTimer();
    timer = setTimeout(() => void search(), SEARCH_DEBOUNCE_MS);
  }

  async function loadMore(): Promise<void> {
    const { status, nextCursor, loadingMore } = get();
    if (status !== 'ready' || nextCursor === null || loadingMore) return;
    const number = requestNo;
    set({ loadingMore: true, loadMoreFailed: false });
    const durationMs = startTimer();
    try {
      const page = await api.searchConversations(searched, nextCursor);
      if (number !== requestNo) return;
      set((state) => ({
        matches: [...state.matches, ...page.matches],
        nextCursor: page.nextCursor,
        loadingMore: false,
      }));
    } catch (error) {
      if (number !== requestNo) return;
      logger.warn('conversation search load more failed', {
        durationMs: durationMs(),
        ...describeApiError(error),
      });
      set({ loadingMore: false, loadMoreFailed: true });
    }
  }

  function open(match: ConversationMatch, position: number): void {
    if (match.place === 'title') {
      // A title match opens its conversation as usual: no feed target, so the open is logged here (DD §Security).
      logger.info('conversation search match opened', {
        place: match.place,
        position,
        found: true,
      });
      set({ openedKey: matchKey(match), target: null });
      return;
    }
    set({ openedKey: matchKey(match), target: { match, position } });
  }

  function takeTarget(source: FeedSource): SearchTarget | null {
    const { target } = get();
    if (target === null) return null;
    const { threadId, agent } = target.match;
    // A match in the employee's conversation has no agent; a sub-agent's opens that agent's screen (AC-13.2).
    const ours =
      source.kind === 'thread'
        ? agent === null && threadId === source.threadId
        : agent?.agentId === source.agentId;
    if (!ours) return null;
    set({ target: null });
    return target;
  }

  return Object.assign(store, {
    setQuery,
    clear: () => setQuery(''),
    retry: () => void search(),
    loadMore,
    open,
    takeTarget,
  });
}
