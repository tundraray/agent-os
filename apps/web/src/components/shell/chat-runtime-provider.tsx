'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { AssistantRuntimeProvider, useAui, useRemoteThreadListRuntime } from '@assistant-ui/react';
import { useChatRuntime } from '@assistant-ui/ai-sdk';
import { lastAssistantMessageIsCompleteWithToolCalls } from 'ai';
import { parseRouteThreadId } from '@/lib/threads/route-thread-id';
import { createShellServices } from '@/lib/threads/shell-services';
import { syncUrlWithThread } from '@/lib/threads/url-sync';
import { ShellActionsProvider } from './shell-actions';

type ChatRuntimeProviderProps = { children: ReactNode };

/** The only place the assistant-ui runtime is created; the open thread is controlled by the URL. */
export function ChatRuntimeProvider({ children }: ChatRuntimeProviderProps) {
  const router = useRouter();
  const threadId = parseRouteThreadId(usePathname());
  const [services] = useState(createShellServices);

  // Runs inside assistant-ui tap resources: only assistant-ui hooks are allowed here.
  const runtimeHook = useCallback(
    function useShellThreadRuntime() {
      const aui = useAui();
      return useChatRuntime({
        transport: services.transport,
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
        adapters: { history: services.history.adapterFor(aui) },
        onError: (error) => services.handleChatError({ error, aui }),
      });
    },
    [services],
  );

  const runtime = useRemoteThreadListRuntime({
    adapter: services.listAdapter,
    threadId,
    runtimeHook,
    onThreadIdChange: (remoteId) =>
      syncUrlWithThread({ remoteId, location: window.location, history: window.history, router }),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime} config={services.auiConfig}>
      <ShellActionsProvider services={services}>{children}</ShellActionsProvider>
    </AssistantRuntimeProvider>
  );
}
