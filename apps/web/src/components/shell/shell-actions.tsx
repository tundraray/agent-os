'use client';

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAui } from '@assistant-ui/react';
import { useStore } from 'zustand';
import { focusAfterNewChat, focusShellTarget, isFinePointer } from '@/lib/focus';
import type { ShellServices } from '@/lib/threads/shell-services';
import type { ShellStatusState, ShellStatusStore } from '@/lib/threads/shell-status-store';

/** Where «Новый чат» was invoked from. */
export type NewChatSource = 'button' | 'shortcut' | 'notice';

export type ShellActions = {
  newChat: (source: NewChatSource) => void;
  /** «Повторить» for a failed history load of the thread body. */
  retryHistory: (remoteId: string) => void;
  /** «Повторить» for a failed switch to a thread opened by URL. */
  retrySwitch: (threadId: string) => void;
};

const ShellActionsContext = createContext<ShellActions | null>(null);
const ShellServicesContext = createContext<ShellServices | null>(null);

type ShellActionsProviderProps = {
  services: ShellServices;
  children: ReactNode;
};

/** Must render inside AssistantRuntimeProvider: retrySwitch drives the runtime's thread list. */
export function ShellActionsProvider({ services, children }: ShellActionsProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const aui = useAui();
  const initialPathname = useRef(pathname);
  // «Новый чат» away from `/` focuses once the route has reached `/` (UXRD 7.4).
  const focusOnRoot = useRef(false);

  // Cold load of `/`: the composer gets focus only with a fine pointer; `/chat/<id>` is left alone.
  useEffect(() => {
    if (initialPathname.current === '/' && isFinePointer()) focusShellTarget('composer');
  }, []);

  useEffect(() => {
    const pending = focusOnRoot.current;
    focusOnRoot.current = false;
    if (pending && pathname === '/') focusAfterNewChat();
  }, [pathname]);

  const actions = useMemo<ShellActions>(
    () => ({
      // No network: the server thread is created by the first send (initialize), never by «Новый чат».
      newChat: () => {
        if (pathname === '/') {
          focusAfterNewChat();
          return;
        }
        focusOnRoot.current = true;
        router.push('/');
      },
      retryHistory: (remoteId) => void services.feeds.forThread(remoteId).load(),
      retrySwitch: (threadId) => aui.threads.switchToThread(threadId),
    }),
    [aui, pathname, router, services],
  );

  return (
    <ShellServicesContext.Provider value={services}>
      <ShellActionsContext.Provider value={actions}>{children}</ShellActionsContext.Provider>
    </ShellServicesContext.Provider>
  );
}

export function useShellActions(): ShellActions {
  const actions = useContext(ShellActionsContext);
  if (actions === null) throw new Error('useShellActions must be used inside ShellActionsProvider');
  return actions;
}

/** Subscribes to a slice of ShellStatus (statuses the runtime does not keep). */
export function useShellStatus<T>(selector: (state: ShellStatusState) => T): T {
  return useStore(useShellStatusStore(), selector);
}

function useShellStatusStore(): ShellStatusStore {
  return useShellServices().status;
}

/** The shell's live stream, announcer, feed stores and API client for the screens' components. */
export function useShellServices(): ShellServices {
  const services = useContext(ShellServicesContext);
  if (services === null) throw new Error('useShellServices must be used inside ShellActionsProvider');
  return services;
}
