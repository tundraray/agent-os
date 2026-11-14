'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Suggestions,
  useAuiState,
  useRemoteThreadListRuntime,
} from '@assistant-ui/react';
import { useThreadFeedRuntime } from '@/lib/feed/use-feed-runtime';
import type { LiveStore, LiveTarget, OpenEventSource } from '@/lib/live/live-store';
import { parseShellRoute } from '@/lib/shell-route';
import { createShellServices } from '@/lib/threads/shell-services';
import { syncUrlWithThread } from '@/lib/threads/url-sync';
import { WELCOME_SUGGESTIONS } from '@/lib/welcome-suggestions';
import { ShellActionsProvider } from './shell-actions';

type ChatRuntimeProviderProps = {
  /** Opens the live stream; only the test harness passes one (jsdom has no `EventSource`). */
  openEventSource?: OpenEventSource;
  children: ReactNode;
};

/** The only place the assistant-ui runtime and the live stream are created; the open thread is controlled by the URL. */
export function ChatRuntimeProvider({ openEventSource, children }: ChatRuntimeProviderProps) {
  const router = useRouter();
  const route = parseShellRoute(usePathname());
  const threadId = route.kind === 'chat' ? route.threadId : undefined;
  const [services] = useState(() => createShellServices({ openEventSource }));
  // TH-03 starter suggestions feed `ThreadPrimitive.Suggestions` through the provider's root scope.
  const config = useMemo(
    () => AuiConfig({ ...services.auiConfig, suggestions: Suggestions(WELCOME_SUGGESTIONS) }),
    [services],
  );

  // Runs inside assistant-ui tap resources, once per hosted thread.
  const runtimeHook = useCallback(
    function useShellThreadRuntime() {
      return useThreadFeedRuntime(services);
    },
    [services],
  );

  const runtime = useRemoteThreadListRuntime({
    adapter: services.listAdapter,
    threadId,
    runtimeHook,
    // The URL mirrors the thread only on conversation paths: agent pages keep their own path.
    onThreadIdChange: (remoteId) => {
      if (parseShellRoute(window.location.pathname).kind !== 'chat') return;
      syncUrlWithThread({ remoteId, location: window.location, history: window.history, router });
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <ShellActionsProvider services={services}>
        <LiveWatch live={services.live} />
        {children}
      </ShellActionsProvider>
    </AssistantRuntimeProvider>
  );
}

/**
 * The stream follows the screen (design-web.md, KD-2): `thread:<id>` once `/chat/<id>` has its item
 * open, `agent:<id>` on an agent page, no target on `/` and `/agents`. While the URL thread is still
 * opening the current stream stays, except on the first mount, which opens the stream at once.
 * `watch` closes the previous source before opening the next one (Invariant 1).
 */
function useLiveWatch(live: LiveStore): void {
  const route = parseShellRoute(usePathname());
  const mainRemoteId = useAuiState(
    (s) =>
      s.threads.threadItems.find(
        (item) => item.id === s.threads.mainThreadId || item.remoteId === s.threads.mainThreadId,
      )?.remoteId,
  );
  const target = ((): LiveTarget | null | undefined => {
    if (route.kind === 'agent') return `agent:${route.agentId}`;
    if (route.kind === 'agents' || route.threadId === undefined) return null;
    return mainRemoteId === route.threadId ? `thread:${route.threadId}` : undefined;
  })();
  const started = useRef(false);

  // Declared before the watch effect: a remount (StrictMode) closes the stream, then opens it again.
  useEffect(
    () => () => {
      started.current = false;
      live.dispose();
    },
    [live],
  );

  useEffect(() => {
    if (target === undefined && started.current) return;
    started.current = true;
    void live.watch(target ?? null);
  }, [live, target]);
}

function LiveWatch({ live }: { live: LiveStore }) {
  useLiveWatch(live);
  return null;
}
