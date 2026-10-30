import { act, render, type RenderResult } from '@testing-library/react';
import type { AppRouterInstance } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { vi, type Mock } from 'vitest';
import { ChatShell } from '@/components/shell/chat-shell';
import { Toaster } from '@/components/ui/sonner';
import { setTestMedia, type TestMedia } from './setup';

type RouterMethod = 'back' | 'forward' | 'refresh' | 'push' | 'replace' | 'prefetch';

/** `useRouter()` stand-in: every navigation method is a spy; nothing navigates. */
export type RouterSpy = { [Method in RouterMethod]: Mock<AppRouterInstance[Method]> } & Pick<AppRouterInstance, 'bfcacheId'>;

const createRouterSpy = (): RouterSpy => ({
  back: vi.fn<AppRouterInstance['back']>(),
  forward: vi.fn<AppRouterInstance['forward']>(),
  refresh: vi.fn<AppRouterInstance['refresh']>(),
  push: vi.fn<AppRouterInstance['push']>(),
  replace: vi.fn<AppRouterInstance['replace']>(),
  prefetch: vi.fn<AppRouterInstance['prefetch']>(),
  bfcacheId: 'test',
});

/** The emulated Next router: the pathname is set by the test, router calls are only recorded. */
const navigation = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state: { pathname: string; router: RouterSpy | undefined } = { pathname: '/', router: undefined };
  return {
    state,
    getPathname: (): string => state.pathname,
    setPathname: (pathname: string): void => {
      state.pathname = pathname;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
});

vi.mock('next/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/navigation')>();
  const { useSyncExternalStore } = await import('react');
  return {
    ...actual,
    usePathname: (): string =>
      useSyncExternalStore(navigation.subscribe, navigation.getPathname, navigation.getPathname),
    useRouter: (): AppRouterInstance => {
      if (navigation.state.router === undefined) {
        throw new Error('next/navigation is mocked for renderWithRuntime: call renderWithRuntime() first');
      }
      return navigation.state.router;
    },
  };
});

export type RenderWithRuntimeOptions = {
  /** Initial `usePathname()` value, e.g. '/' or '/chat/a'. */
  pathname: string;
  /** Answer of `(pointer: fine)` / `(pointer: coarse)`; default 'fine'. */
  pointer?: TestMedia['pointer'];
  /** Viewport width in CSS px; default 1280 (desktop). */
  width?: number;
  colorScheme?: TestMedia['colorScheme'];
  /** Exact media queries with a fixed answer, e.g. `{ '(min-width: 1024px)': true }`. */
  media?: TestMedia['queries'];
  /** Sidebar state the layout would read from the `sidebar_state` cookie; default true. */
  defaultSidebarOpen?: boolean;
};

export type RenderWithRuntimeResult = RenderResult & {
  /** Spy standing in for `useRouter()`: assert `router.push` / `router.replace` calls. */
  router: RouterSpy;
  /** Emulates the navigation Next would perform: `usePathname()` returns the new value. */
  setPathname: (pathname: string) => void;
};

/**
 * Mounts the shell as the `(chat)` layout does — ChatShell with its ChatRuntimeProvider — plus the app-wide
 * `<Toaster />`, against the MSW server. Only the network (MSW) and `next/navigation` are emulated.
 */
export function renderWithRuntime({
  pathname,
  pointer = 'fine',
  width = 1280,
  colorScheme = 'light',
  media = {},
  defaultSidebarOpen = true,
}: RenderWithRuntimeOptions): RenderWithRuntimeResult {
  setTestMedia({ pointer, width, colorScheme, queries: media });
  const router = createRouterSpy();
  navigation.state.router = router;
  navigation.setPathname(pathname);

  const result = render(
    <>
      <ChatShell defaultSidebarOpen={defaultSidebarOpen}>{null}</ChatShell>
      <Toaster />
    </>,
  );

  return {
    ...result,
    router,
    setPathname: (next) => {
      act(() => {
        navigation.setPathname(next);
      });
    },
  };
}
