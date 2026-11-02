'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Suggestions,
  useAui,
  useRemoteThreadListRuntime,
} from '@assistant-ui/react';
import { useChatRuntime } from '@assistant-ui/ai-sdk';
import { shouldResendTurn, toResearchCreateMessage } from '@/lib/threads/research-messages';
import { parseRouteThreadId } from '@/lib/threads/route-thread-id';
import { createShellServices } from '@/lib/threads/shell-services';
import { syncUrlWithThread } from '@/lib/threads/url-sync';
import { WELCOME_SUGGESTIONS } from '@/lib/welcome-suggestions';
import { DocumentTitle } from './document-title';
import { ShellActionsProvider } from './shell-actions';

type ChatRuntimeProviderProps = { children: ReactNode };

/** The only place the assistant-ui runtime is created; the open thread is controlled by the URL. */
export function ChatRuntimeProvider({ children }: ChatRuntimeProviderProps) {
  const router = useRouter();
  const threadId = parseRouteThreadId(usePathname());
  const [services] = useState(createShellServices);
  // TH-03 starter suggestions feed `ThreadPrimitive.Suggestions` through the provider's root scope.
  const config = useMemo(
    () => AuiConfig({ ...services.auiConfig, suggestions: Suggestions(WELCOME_SUGGESTIONS) }),
    [services],
  );

  // Runs inside assistant-ui tap resources: only assistant-ui hooks are allowed here.
  const runtimeHook = useCallback(
    function useShellThreadRuntime() {
      const aui = useAui();
      return useChatRuntime({
        transport: services.transport,
        sendAutomaticallyWhen: shouldResendTurn,
        toCreateMessage: toResearchCreateMessage,
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
    <AssistantRuntimeProvider runtime={runtime} config={config}>
      <ShellActionsProvider services={services}>
        <DocumentTitle />
        {children}
      </ShellActionsProvider>
    </AssistantRuntimeProvider>
  );
}
