'use client';

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAui } from '@assistant-ui/react';
import { useStore } from 'zustand';
import { focusAfterNewChat, focusShellTarget, isFinePointer } from '@/lib/focus';
import type { LeaveGuard } from '@/lib/leave-guard';
import type { ShellServices } from '@/lib/threads/shell-services';
import type { ShellStatusState, ShellStatusStore } from '@/lib/threads/shell-status-store';

export type ShellActions = {
  /** Asks MC-11 first while unsaved changes are held (KD-4); the shortcut calls it too. */
  newChat: () => void;
  /** `router.push(href)` once MC-11 answers «leave»; at once while nothing is held. `ShellLink` leaves through it. */
  leaveTo: (href: string) => void;
  /** «Повторить» for a failed history load of the thread body. */
  retryHistory: (remoteId: string) => void;
  /** «Повторить» for a failed switch to a thread opened by URL. */
  retrySwitch: (threadId: string) => void;
};

/** Exported for `ShellLink`, which also renders outside the shell (a link without a guard there). */
export const ShellActionsContext = createContext<ShellActions | null>(null);
/** Exported for tests that render a bare `Thread`, which announces through the shell's announcer. */
export const ShellServicesContext = createContext<ShellServices | null>(null);

/**
 * KD-4: with nothing held `go()` runs at once, in the same tick — callers and tests expect `router.push`
 * synchronously; otherwise only after MC-11 answers «Уйти без сохранения».
 */
export function leaveThenGo(leaveGuard: LeaveGuard, go: () => void): void {
  if (leaveGuard.getState().held === null) {
    go();
    return;
  }
  void leaveGuard.confirmLeave().then((leave) => {
    if (leave) go();
  });
}

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
      newChat: () =>
        leaveThenGo(services.leaveGuard, () => {
          if (pathname === '/') {
            focusAfterNewChat();
            return;
          }
          focusOnRoot.current = true;
          router.push('/');
        }),
      leaveTo: (href) => leaveThenGo(services.leaveGuard, () => router.push(href)),
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
