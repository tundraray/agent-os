'use client';

import { useEffect, useState } from 'react';

import { describeApiError } from '@/lib/api/api-request';
import { createCoalescedRunner } from '@/lib/live/coalesced-runner';
import { logger } from '@/lib/logger';
import type { ThreadsApiClient } from '@/lib/threads/threads-api-client';

import type { FeedState, FeedStore } from './feed-store';
import type { UnreadRange } from './to-feed';

type Opened = { feed: FeedStore; range: UnreadRange };

/** The stores whose conversation was already opened in this tab. */
const openedFeeds = new WeakSet<FeedStore>();

/**
 * The «seen through» mark of a shown conversation feed (improvements KD-4, Flow 3). When the feed opens, it fixes the
 * unread range from the first read after opening — on a return to a conversation already opened in the tab its store
 * is read again first — from that read's `seenThroughSeq` to its last entry. Then every growth of the last
 * number sends `PUT seen`, one request in flight and one after it; a failure is only logged, and the next growth sends
 * the mark again. One store per conversation, so a new `feed` is a new opening. An agent page's feed marks nothing.
 */
export function useSeenMark(
  feed: FeedStore | null,
  api: Pick<ThreadsApiClient, 'markSeen'>,
): UnreadRange | null {
  const [opened, setOpened] = useState<Opened | null>(null);

  useEffect(() => {
    if (feed === null) return;
    const { view: held } = feed.getState();
    if (held !== null && held.kind !== 'thread') return;
    // A store is created, and read, when its conversation is first opened in the tab; on a return its view is older
    // than the opening.
    const returning = openedFeeds.has(feed);
    openedFeeds.add(feed);

    let disposed = false;
    let fixed = false;
    let sent = 0;
    let requested = 0;
    const marks = createCoalescedRunner(
      async () => {
        const { view, lastSeq } = feed.getState();
        if (
          view?.kind !== 'thread' ||
          lastSeq <= Math.max(sent, view.seenThroughSeq)
        )
          return;
        try {
          await api.markSeen(view.threadId, lastSeq);
          sent = Math.max(sent, lastSeq);
        } catch (error) {
          logger.warn('thread seen mark failed', {
            ...describeApiError(error),
            threadId: view.threadId,
            throughSeq: lastSeq,
          });
        }
      },
      { minIntervalMs: 0 },
    );

    const follow = (state: FeedState): void => {
      if (disposed || state.view?.kind !== 'thread') return;
      if (!fixed) {
        fixed = true;
        setOpened({
          feed,
          range: {
            afterSeq: state.view.seenThroughSeq,
            throughSeq: state.lastSeq,
          },
        });
      }
      if (state.lastSeq > requested) {
        requested = state.lastSeq;
        void marks.request();
      }
    };

    let afterOpening = !returning || held === null;
    const unsubscribe = feed.subscribe((state) => {
      if (afterOpening) follow(state);
    });
    if (afterOpening) follow(feed.getState());
    else
      void feed.load().then(() => {
        afterOpening = true;
        follow(feed.getState());
      });
    return () => {
      disposed = true;
      unsubscribe();
      marks.cancel();
    };
  }, [feed, api]);

  return opened?.feed === feed ? opened.range : null;
}
