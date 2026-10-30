'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuiState } from '@assistant-ui/react';
import { Toaster } from 'sonner';
import { Thread } from '@/components/assistant-ui/elements/thread.aui';
import { Button } from '@/components/ui/button';
import { Sidebar, SidebarProvider, useSidebar } from '@/components/ui/sidebar';
import { parseRouteThreadId, threadPath } from '@/lib/threads/route-thread-id';
import { describeThreadsError } from '@/lib/threads/threads-api-error';
import { ChatRuntimeProvider } from './chat-runtime-provider';
import { useShellActions, useShellStatus } from './shell-actions';

type ChatShellProps = {
  defaultSidebarOpen: boolean;
  children: ReactNode;
};

/**
 * Minimal runtime-spike layout: thread links in the shadcn sidebar (a swipeable drawer below 768 px),
 * history status line, «Новый чат» and the thread.
 * The production layout (sidebar, header, main view, workspace) replaces it.
 */
export function ChatShell({ defaultSidebarOpen, children }: ChatShellProps) {
  return (
    <ChatRuntimeProvider>
      <SidebarProvider defaultOpen={defaultSidebarOpen} className="h-dvh">
        <Sidebar>
          <SpikeThreadList />
        </Sidebar>
        <main className="flex min-w-0 flex-1 flex-col">
          <SpikeStatusLine />
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
          {children}
        </main>
      </SidebarProvider>
      {/* SPIKE: the root layout gets the shared Toaster later; until then notify() renders here. */}
      <Toaster position="bottom-center" />
    </ChatRuntimeProvider>
  );
}

function SpikeThreadList() {
  const { newChat } = useShellActions();
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const isLoading = useAuiState((s) => s.threads.isLoading);

  return (
    <nav aria-label="Беседы" className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <Button onClick={() => newChat('button')}>Новый чат</Button>
      {isLoading && <p className="text-muted-foreground text-sm">Загружаем беседы…</p>}
      <ul className="flex flex-col gap-1 overflow-y-auto">
        {threadItems.map((item) =>
          item.remoteId === undefined ? null : (
            <li key={item.id} className="flex items-center gap-1">
              <Link
                href={threadPath(item.remoteId)}
                aria-current={item.id === mainThreadId ? 'page' : undefined}
                className="min-w-0 flex-1 truncate rounded px-2 py-1 text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-medium"
              >
                {item.title ?? 'Новая беседа'}
                {item.isRunning && ' •'}
              </Link>
            </li>
          ),
        )}
      </ul>
    </nav>
  );
}

function SpikeStatusLine() {
  const { retryHistory, retrySwitch } = useShellActions();
  const { toggleSidebar } = useSidebar();
  const routeThreadId = parseRouteThreadId(usePathname());
  const mainRemoteId = useAuiState(
    (s) => s.threads.threadItems.find((item) => item.id === s.threads.mainThreadId)?.remoteId,
  );
  const historyStatus = useShellStatus((s) =>
    mainRemoteId === undefined ? undefined : s.history[mainRemoteId],
  );
  const switchError = useAuiState((s) => s.threads.switchError);
  const listFailed = useAuiState((s) => s.threads.loadError !== undefined);
  const routeSwitchError =
    switchError !== undefined && switchError.threadId === routeThreadId ? switchError : undefined;

  return (
    <div role="status" className="flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs">
      <Button
        size="sm"
        variant="outline"
        className="md:hidden"
        aria-haspopup="dialog"
        onClick={toggleSidebar}
      >
        Меню
      </Button>
      <span>route: {routeThreadId ?? '/'}</span>
      <span>main: {mainRemoteId ?? '(new)'}</span>
      <span>history: {historyStatus ?? '—'}</span>
      {historyStatus === 'load_failed' && mainRemoteId !== undefined && (
        <Button size="sm" variant="outline" onClick={() => retryHistory(mainRemoteId)}>
          Повторить
        </Button>
      )}
      {routeSwitchError !== undefined && (
        <>
          <span>switchError: {describeThreadsError(routeSwitchError.error).kind}</span>
          <Button size="sm" variant="outline" onClick={() => retrySwitch(routeSwitchError.threadId)}>
            Повторить
          </Button>
        </>
      )}
      {listFailed && <span>list: load error</span>}
    </div>
  );
}
