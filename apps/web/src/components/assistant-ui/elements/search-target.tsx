'use client';

import { useAuiState, type AssistantState } from '@assistant-ui/react';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { useStore } from 'zustand';

import { useShellServices } from '@/components/shell/shell-actions';
import { useFeedSelector } from '@/lib/feed/feed-context';
import type { FeedSource } from '@/lib/feed/feed-store';
import type { FeedView } from '@/lib/feed/to-feed';
import { logger } from '@/lib/logger';
import { matchKey, type SearchTarget } from '@/lib/search/search-store';

/**
 * The feed element an opened match marks (DD KD-7): a message by `seq`, or a tool-call block by `callId`. A new
 * object per opening: blocks compare it by identity to open once for each opening.
 */
export type SearchMark = { seq: number | null; callId: string | null };

const SearchMarkContext = createContext<SearchMark | null>(null);

/** Hands the feed's mark to its messages and tool-call blocks; null — nothing is marked. */
export const SearchMarkProvider = SearchMarkContext.Provider;

/**
 * The scroll margin keeps the target in the upper third once scrolled to. A message that holds the target does not
 * play its entry slide: a message with `content-visibility: auto` starts it only once it comes into view, that is
 * after the scroll, and the scroll lands on the shifted box, which then slides off its place.
 */
const SEARCH_MARK_ROOT_CLASS =
  'scroll-mt-16 data-search-target:animate-none has-[[data-search-target]]:animate-none';

/**
 * search-result.md «Цель совпадения»: `--muted` across the element and a 2 px `--ring` bar on the left, static
 * (no transition).
 */
export const SEARCH_MARK_CLASS = `${SEARCH_MARK_ROOT_CLASS} data-search-target:bg-muted data-search-target:shadow-[inset_2px_0_0_0_var(--color-ring)]`;

/**
 * A user's message: its bubble is `--muted` already, so a `--muted` band would swallow it. The bubble takes a 2 px
 * `--ring` outline inside its edge instead (inside: the root's paint containment clips anything outside); the root
 * only keeps the scroll margin. Goes on the root (`group/message`) and the bubble.
 */
export const SEARCH_MARK_USER_ROOT_CLASS = SEARCH_MARK_ROOT_CLASS;
export const SEARCH_MARK_USER_BUBBLE_CLASS =
  'group-data-[search-target]/message:ring-2 group-data-[search-target]/message:ring-ring group-data-[search-target]/message:ring-inset';

/** The attributes that mark an element and let it take focus programmatically (search-result.md, «Открытие»). */
const markedProps = (marked: boolean) =>
  marked ? { 'data-search-target': '', tabIndex: -1 } : {};

const SEQ_ID = /^seq-(\d+)$/;

/**
 * The `seq` of the feed entry a message draws (its id `seq-N`, lib/feed/to-feed.ts); null for any other message.
 * `useExternalStoreRuntime` with `convertMessage` converts the feed one message at a time and never joins
 * adjacent answers, so every drawn entry has its own message.
 */
const seqOf = (s: AssistantState): number | null => {
  const match = SEQ_ID.exec(s.message.id);
  return match === null ? null : Number(match[1]);
};

/** The root props of a feed message: `data-seq` the feed finds it by, and the mark when it is the target. */
export function useMessageMarkProps() {
  const seq = useAuiState(seqOf);
  const mark = useContext(SearchMarkContext);
  return {
    ...(seq === null ? {} : { 'data-seq': seq }),
    ...markedProps(seq !== null && mark?.seq === seq),
  };
}

/** The root props of a tool-call block: `data-call-id` the feed finds it by, and the mark when it is the target. */
export function useCallMarkProps(callId: string) {
  const mark = useContext(SearchMarkContext);
  return {
    'data-call-id': callId,
    ...markedProps(mark?.callId === callId),
  };
}

/**
 * A disclosure's open state that a new mark opens when it holds the target. The state changes during render, so the
 * target is already drawn when the feed looks for it; the employee can still close it afterwards.
 */
export function useOpenOnMark(
  holdsTarget: (mark: SearchMark) => boolean,
): [boolean, (open: boolean) => void] {
  const mark = useContext(SearchMarkContext);
  const [open, setOpen] = useState(() => mark !== null && holdsTarget(mark));
  const [seen, setSeen] = useState(mark);
  if (mark !== seen) {
    setSeen(mark);
    if (mark !== null && holdsTarget(mark)) setOpen(true);
  }
  return [open, setOpen];
}

const sourceOf = (view: FeedView): FeedSource =>
  view.kind === 'thread'
    ? { kind: 'thread', threadId: view.threadId }
    : { kind: 'agent', agentId: view.agent.agentId };

const keyOf = (source: FeedSource): string =>
  source.kind === 'thread'
    ? `thread:${source.threadId}`
    : `agent:${source.agentId}`;

/** The element a match points at: the call block of a tool result, else the message of its `seq`. */
const markOf = ({ match }: SearchTarget): SearchMark =>
  match.callId !== null
    ? { seq: null, callId: match.callId }
    : { seq: match.seq, callId: null };

function selectorOf(mark: SearchMark): string | null {
  if (mark.callId !== null)
    return `[data-call-id="${CSS.escape(mark.callId)}"]`;
  if (mark.seq !== null) return `[data-seq="${mark.seq}"]`;
  return null;
}

type Applied = {
  mark: SearchMark;
  target: SearchTarget;
  /** `keyOf` the source whose feed took the target. */
  source: string;
  /** `matchKey` of the opened match. */
  key: string;
};

/**
 * Takes the pending target of the feed's own source from the search store once the whole history is drawn, and
 * returns the mark the feed hands down (DD KD-7, Flow 2). The target is scrolled to the upper third, marked and
 * focused; each opening is logged with its place, position and whether the target was found. Without an element
 * (a call drawn as a card) nothing is marked (DC-4). The mark goes when another match is opened, when the feed shows
 * another source (the screens are not remounted between conversations or agents) and when the feed unmounts.
 */
export function useFeedSearchMark(
  containerRef: RefObject<HTMLElement | null>,
  historyPending: boolean,
): SearchMark | null {
  const { search } = useShellServices();
  const openedKey = useStore(search, (state) => state.openedKey);
  const view = useFeedSelector(
    (state): FeedView | null => (state.loaded ? state.view : null),
    null,
  );
  const drawn = useAuiState(
    (s) => !s.thread.isLoading && s.thread.messages.length > 0,
  );
  const source = view === null ? null : keyOf(sourceOf(view));
  const [applied, setApplied] = useState<Applied | null>(null);

  // Adjusted during render, so the old mark never shows on another source for a frame.
  const [seen, setSeen] = useState({ source, openedKey });
  if (seen.source !== source || seen.openedKey !== openedKey) {
    setSeen({ source, openedKey });
    const replaced =
      applied !== null &&
      (applied.source !== source ||
        (openedKey !== null && openedKey !== applied.key));
    if (replaced) setApplied(null);
  }

  // Once the history is drawn, the feed takes its target now and whenever a new one is opened while it stays.
  useEffect(() => {
    if (view === null || !drawn || historyPending) return;
    const feedSource = sourceOf(view);
    const take = (): void => {
      const taken = search.takeTarget(feedSource);
      if (taken === null) return;
      setApplied({
        mark: markOf(taken),
        target: taken,
        source: keyOf(feedSource),
        key: matchKey(taken.match),
      });
    };
    take();
    return search.subscribe(take);
  }, [search, view, drawn, historyPending]);

  const logged = useRef<Applied | null>(null);
  useEffect(() => {
    if (applied === null) return;
    const selector = selectorOf(applied.mark);
    const element =
      selector === null
        ? null
        : (containerRef.current?.querySelector<HTMLElement>(selector) ?? null);
    if (logged.current !== applied) {
      logged.current = applied;
      logger.info('conversation search match opened', {
        place: applied.target.match.place,
        position: applied.target.position,
        found: element !== null,
      });
    }
    if (element === null) {
      setApplied(null);
      return;
    }
    const feed = containerRef.current;
    if (feed === null) return;
    element.focus({ preventScroll: true });
    // A freshly drawn history settles under the scroll: messages with `content-visibility: auto` trade their
    // placeholder height for the real one as they come near the view, and the viewport scrolls itself to the bottom
    // on growth. So the target is aligned at once and again on every resize of the feed (the first callback comes
    // with observing, after the viewport's own scroll to the bottom in the same frame) until the employee scrolls,
    // clicks or types. Instant: a smooth scroll aims at a position the settling layout moves.
    const align = () =>
      element.scrollIntoView({ block: 'start', behavior: 'instant' });
    align();
    const observer = new ResizeObserver(align);
    observer.observe(feed);
    const gestures = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    const stop = () => {
      observer.disconnect();
      for (const gesture of gestures)
        window.removeEventListener(gesture, stop, true);
    };
    for (const gesture of gestures)
      window.addEventListener(gesture, stop, { capture: true, passive: true });
    return stop;
  }, [applied, containerRef]);

  return applied?.mark ?? null;
}
