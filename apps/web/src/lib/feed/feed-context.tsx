"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

import type { FeedState, FeedStore } from "./feed-store";

const FeedContext = createContext<FeedStore | null>(null);

/**
 * Hands the feed store of the screen (a conversation or an agent page) to the thread's parts and
 * composer. `feed` is null where the screen has no store yet (`/` before the first message).
 */
export function FeedProvider({ feed, children }: { feed: FeedStore | null; children: ReactNode }) {
  return <FeedContext.Provider value={feed}>{children}</FeedContext.Provider>;
}

/** The screen's feed store; null outside `FeedProvider` and for a conversation not created yet. */
export function useFeed(): FeedStore | null {
  return useContext(FeedContext);
}

const noSubscription = (): (() => void) => () => {};

/**
 * A slice of the screen's feed state, or `fallback` without a store. The selector must return a value
 * stored in the state (or a primitive): a new object on every call would re-render without end.
 */
export function useFeedSelector<T>(selector: (state: FeedState) => T, fallback: T): T {
  const feed = useFeed();
  const read = (): T => (feed === null ? fallback : selector(feed.getState()));
  return useSyncExternalStore(feed === null ? noSubscription : feed.subscribe, read, read);
}
