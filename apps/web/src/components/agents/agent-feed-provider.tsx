"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import { useShellServices } from "@/components/shell/shell-actions";
import { FeedProvider } from "@/lib/feed/feed-context";
import { createFeedStore } from "@/lib/feed/feed-store";
import { logger } from "@/lib/logger";

/**
 * The agent page's feed store (design-web.md, KD-1, KD-2), handed to the header, the screen and the tab
 * title through `FeedProvider`. It reads on mount and follows the live stream: a `tree` note of the
 * agent's conversation and `ready` re-read the page; text parts of this agent alone build the draft.
 * The shell keys the provider by `agentId`, so another agent gets a new store.
 */
export function AgentFeedProvider({ agentId, children }: { agentId: string; children: ReactNode }) {
  const { apiClient, live, announcer } = useShellServices();
  const feed = useMemo(
    () => createFeedStore({ source: { kind: "agent", agentId }, api: apiClient, announcer, logger }),
    [agentId, apiClient, announcer],
  );

  useEffect(() => {
    const unsubscribers = [
      live.onTree((threadId) => {
        const { view, loadError } = feed.getState();
        // Before the first read the agent's conversation is unknown; that read shows the note's change.
        if (view === null || loadError !== null) return;
        if (view.kind === "agent" && view.agent.threadId === threadId) void feed.refresh();
      }),
      live.onReady(() => {
        // A missing agent stays missing; a failed first read gets another try with the stream back.
        if (feed.getState().loadError !== "not_found") void feed.refresh();
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
