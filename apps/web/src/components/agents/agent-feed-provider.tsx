'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import { useShellServices } from '@/components/shell/shell-actions';
import { FeedProvider } from '@/lib/feed/feed-context';
import { createFeedStore } from '@/lib/feed/feed-store';
import { logger } from '@/lib/logger';

/**
 * The agent page's feed store (design-web.md, KD-1, KD-2), handed to the header, the screen and the tab
 * title through `FeedProvider`. It reads on mount and follows the live stream: the agent's records, the state,
 * row and deletion of its conversation and `ready` re-read the page (live-feed design-web.md, KD-1); text parts of this agent alone build the draft.
 * The shell keys the provider by `agentId`, so another agent gets a new store.
 */
export function AgentFeedProvider({
  agentId,
  children,
}: {
  agentId: string;
  children: ReactNode;
}) {
  const { apiClient, live, announcer } = useShellServices();
  const feed = useMemo(
    () =>
      createFeedStore({
        source: { kind: 'agent', agentId },
        api: apiClient,
        announcer,
        logger,
      }),
    [agentId, apiClient, announcer],
  );

  useEffect(() => {
    // Before the first read the agent's conversation is unknown; that read shows the change.
    const shownThread = (): string | null => {
      const { view, loadError } = feed.getState();
      return view?.kind === 'agent' && loadError === null
        ? view.agent.threadId
        : null;
    };
    const unsubscribers = [
      live.onChange({ kinds: ['entries'], agentId }, () => {
        if (shownThread() !== null) void feed.load();
      }),
      // The change names the conversation only, which the page knows after its first read.
      live.onChange({ kinds: ['state', 'summary', 'deleted'] }, (change) => {
        if (shownThread() === change.threadId) void feed.load();
      }),
      live.onReady(() => {
        // A missing agent stays missing; a failed first read gets another try with the stream back.
        if (feed.getState().loadError !== 'not_found') void feed.load();
      }),
      live.onDelta((delta) => {
        if (delta.agentId === agentId) feed.applyDelta(delta);
      }),
    ];
    void feed.load();
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      feed.dispose();
    };
  }, [feed, live, agentId]);

  return <FeedProvider feed={feed}>{children}</FeedProvider>;
}
