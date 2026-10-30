'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAui, type AssistantClient } from '@assistant-ui/react';
import { useStore } from 'zustand';
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
  /**
   * Deletes a thread; a run in progress on it (open or background) is cancelled first so its
   * request closes before the thread body is released. Delete failures follow the list adapter
   * contract (notify.deleteFailed + rollback).
   */
  deleteThread: (threadId: string) => Promise<void>;
};

/** Upper bound for a cancelled run to settle before the delete proceeds anyway. */
const CANCEL_SETTLE_TIMEOUT_MS = 2000;

const ShellActionsContext = createContext<ShellActions | null>(null);
const ShellStatusContext = createContext<ShellStatusStore | null>(null);

type ShellActionsProviderProps = {
  services: ShellServices;
  children: ReactNode;
};

/** Must render inside AssistantRuntimeProvider: retrySwitch drives the runtime's thread list. */
export function ShellActionsProvider({ services, children }: ShellActionsProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const aui = useAui();

  const actions = useMemo<ShellActions>(
    () => ({
      // Focus handling after the transition belongs to the focus policy (lib/focus.ts).
      newChat: () => {
        if (pathname !== '/') router.push('/');
      },
      retryHistory: (remoteId) => services.history.retry(remoteId),
      retrySwitch: (threadId) => aui.threads.switchToThread(threadId),
      deleteThread: async (threadId) => {
        await cancelThreadRun(aui, threadId);
        aui.threads.item({ id: threadId }).delete();
      },
    }),
    [aui, pathname, router, services],
  );

  return (
    <ShellStatusContext.Provider value={services.status}>
      <ShellActionsContext.Provider value={actions}>{children}</ShellActionsContext.Provider>
    </ShellStatusContext.Provider>
  );
}

/**
 * Cancels the run of a thread (open or background) and waits until its list item reports not running.
 * The `threads` scope installed by AssistantRuntimeProvider is the runtime-backed ThreadListClient:
 * it has no per-thread body accessor, so the open thread is cancelled through `aui.threads.thread("main")` and a
 * background thread through the AssistantRuntime (`threads.getById`), which resolves the same
 * per-thread runtime whose state feeds the item's `isRunning`.
 */
async function cancelThreadRun(aui: AssistantClient, threadId: string): Promise<void> {
  const item = aui.threads.item({ id: threadId });
  const isRunning = () => item.getState().isRunning;
  if (!isRunning()) return;
  if (aui.threads.getState().mainThreadId === item.getState().id) {
    aui.threads.thread("main").cancelRun();
  } else {
    const runtime = aui.threads.__internal_getAssistantRuntime?.();
    if (runtime === undefined) {
      console.warn('[web-shell] background run has no reachable runtime; deleting without cancel', {
        threadId,
      });
      return;
    }
    runtime.threads.getById(threadId).cancelRun();
  }
  const settled = await waitUntil(aui, () => !isRunning(), CANCEL_SETTLE_TIMEOUT_MS);
  if (!settled) {
    console.warn('[web-shell] run still active after cancel; deleting anyway', { threadId });
  }
}

/** Resolves true once `isDone()` holds, false after `timeoutMs`. */
function waitUntil(aui: AssistantClient, isDone: () => boolean, timeoutMs: number): Promise<boolean> {
  if (isDone()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (result: boolean) => {
      unsubscribe();
      clearTimeout(timer);
      resolve(result);
    };
    const unsubscribe = aui.subscribe(() => {
      if (isDone()) finish(true);
    });
    const timer = setTimeout(() => finish(isDone()), timeoutMs);
  });
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
  const store = useContext(ShellStatusContext);
  if (store === null) throw new Error('useShellStatus must be used inside ShellActionsProvider');
  return store;
}
