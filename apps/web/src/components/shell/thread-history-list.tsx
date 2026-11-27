'use client';

import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useAui, useAuiState } from '@assistant-ui/react';
import {
  ConversationStateSchema,
  THREAD_PAGE_SIZE,
  type ConversationState,
} from '@agent-os/contracts';
import { useStore } from 'zustand';
import { RotateCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { useNow } from '@/hooks/use-now';
import { focusAfterNewChat } from '@/lib/focus';
import { createCoalescedRunner } from '@/lib/live/coalesced-runner';
import { asideOf } from '@/lib/shell/workspace-store';
import { logger } from '@/lib/logger';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import {
  entryActivityAt,
  groupThreadsByDate,
  type ThreadGroup,
  type ThreadListEntry,
} from '@/lib/threads/group-threads-by-date';
import { DeleteThreadDialog } from './delete-thread-dialog';
import {
  THREAD_ACTIONS_ATTRIBUTE,
  THREAD_LINK_ATTRIBUTE,
  THREAD_ROW_ATTRIBUTE,
  ThreadHistoryItem,
} from './thread-history-item';
import { useShellServices, useShellStatus } from './shell-actions';
import { useOpenBranch } from './use-open-branch';

export type ThreadHistoryListState =
  | { kind: 'loading' }
  | { kind: 'error'; onRetry: () => void }
  | { kind: 'ready'; groups: readonly ThreadGroup[] };

/** What started a next-page load: only a keyboard start moves focus to the first new thread (UXRD 6.8 Loaded). */
export type LoadMoreSource = 'keyboard' | 'pointer' | 'viewport';

/** SB-10: the runtime's `hasMore`/`isLoadingMore`, ShellStatus `loadMoreFailed` and `threads.loadMore()`. */
export type ThreadListPagination = {
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreFailed: boolean;
  onLoadMore: (source: LoadMoreSource) => void;
};

export type ThreadHistoryListViewProps = {
  state: ThreadHistoryListState;
  pagination: ThreadListPagination;
  /** Renders one SB-06 row; the container decides which row is active. `onRequestDelete` opens DLG-01 for the row. */
  renderItem: (
    entry: ThreadListEntry,
    onRequestDelete: () => void,
  ) => ReactNode;
  /** The thread open in the main area: after its deletion focus follows the route change, not the list. */
  openThreadId: string | undefined;
  /** A deletion confirmed in DLG-01. */
  onDelete: (entry: ThreadListEntry) => void;
};

const THREAD_LINK_SELECTOR = `a[${THREAD_LINK_ATTRIBUTE}]`;

/** SB-03 «Новый чат»: the only control inside the sidebar with this shortcut. */
const SIDEBAR_NEW_CHAT_SELECTOR =
  '[data-slot="sidebar"] [aria-keyshortcuts="Control+Shift+O Meta+Shift+O"]';

function rowsOf(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(`[${THREAD_ROW_ATTRIBUTE}]`),
  );
}

const isRowOf = (threadId: string) => (row: HTMLElement) =>
  row.getAttribute(THREAD_ROW_ATTRIBUTE) === threadId;

/**
 * UXRD 7.4, deleting a thread that is not open: the next thread link, else the previous one, else SB-03.
 * Read before the row leaves the list.
 */
function focusTargetAfterRemoval(
  root: HTMLElement,
  threadId: string,
): HTMLElement | null {
  const rows = rowsOf(root);
  const index = rows.findIndex(isRowOf(threadId));
  const neighbours =
    index === -1
      ? []
      : [...rows.slice(index + 1), ...rows.slice(0, index).reverse()];
  for (const row of neighbours) {
    const link = row.querySelector<HTMLElement>(THREAD_LINK_SELECTOR);
    if (link !== null) return link;
  }
  return root.ownerDocument.querySelector<HTMLElement>(
    SIDEBAR_NEW_CHAT_SELECTOR,
  );
}

/** The SB-07 «⋯» of a row: DLG-01 returns focus there when cancelled. */
function actionsButtonOf(
  root: HTMLElement,
  threadId: string,
): HTMLElement | null {
  return (
    rowsOf(root)
      .find(isRowOf(threadId))
      ?.querySelector<HTMLElement>(`[${THREAD_ACTIONS_ATTRIBUTE}]`) ?? null
  );
}

/** Widths of the seven loading rows (UXRD 6.4 Loading). */
const SKELETON_ROW_WIDTHS = [
  '44%',
  '72%',
  '56%',
  '88%',
  '64%',
  '48%',
  '76%',
] as const;

/** Widths of the three next-page loading rows (UXRD 6.8 Loading). */
const MORE_SKELETON_ROW_WIDTHS = ['68%', '52%', '80%'] as const;

/** SB-10 starts the next page this far before it scrolls into view (UXRD 6.8 Default). */
const AUTO_LOAD_ROOT_MARGIN = '0px 0px 200px 0px';

/** The shortest gap between two re-reads of page 1 by `tree` notes (design-web.md, KD-2). */
const TREE_RELOAD_INTERVAL_MS = 1000;

/** The sidebar's scroll container: the observer's root, so the 200 px margin applies to its edge. */
const SIDEBAR_SCROLL_SELECTOR = '[data-sidebar="content"]';

/** A click with `detail === 0` came from Enter/Space, not a pointer. */
const clickSource = (event: MouseEvent<HTMLElement>): LoadMoreSource =>
  event.detail === 0 ? 'keyboard' : 'pointer';

const entryIdsOf = (state: ThreadHistoryListState): ReadonlySet<string> =>
  new Set(
    state.kind === 'ready'
      ? state.groups.flatMap((group) => group.entries.map((entry) => entry.id))
      : [],
  );

/** `custom` is the library's untyped bag: a value that is not a known state shows no mark. */
function conversationStateOf(value: unknown): ConversationState | null {
  const parsed = ConversationStateSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The mark a row shows (improvements KD-5): a conversation on screen — the open one or the side chat's branch —
 * never lights «новый ответ» or «сбой», since the employee sees that answer as it comes.
 */
function shownState(
  state: ConversationState | null,
  { onScreen }: { onScreen: boolean },
): ConversationState | null {
  if (onScreen && (state === 'new_answer' || state === 'failed')) return null;
  return state;
}

/** ↑/↓ — previous/next thread link across group boundaries, Home/End — first/last; other keys are left alone. */
function moveFocusBetweenLinks(event: KeyboardEvent<HTMLElement>): void {
  const target = event.target;
  if (
    !(target instanceof HTMLAnchorElement) ||
    !target.matches(THREAD_LINK_SELECTOR)
  )
    return;
  const links = Array.from(
    event.currentTarget.querySelectorAll<HTMLAnchorElement>(
      THREAD_LINK_SELECTOR,
    ),
  );
  const index = links.indexOf(target);
  const last = links.length - 1;
  const nextIndex = {
    ArrowDown: Math.min(index + 1, last),
    ArrowUp: Math.max(index - 1, 0),
    Home: 0,
    End: last,
  }[event.key];
  if (nextIndex === undefined) return;
  event.preventDefault();
  links[nextIndex]?.focus();
}

/** SB-04/05/09/10: the thread list by date groups, its loading skeleton, empty text, load error and next page; DLG-01 for its rows. */
export function ThreadHistoryListView({
  state,
  pagination,
  renderItem,
  openThreadId,
  onDelete,
}: ThreadHistoryListViewProps) {
  const t = useTranslations('shell');
  const rootRef = useRef<HTMLDivElement>(null);
  // The entry outlives `deleteOpen` so the dialog keeps its text through the exit animation.
  const [pendingDelete, setPendingDelete] = useState<ThreadListEntry | null>(
    null,
  );
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteFinalFocus = useRef<HTMLElement | null>(null);
  // «Повторить» unmounts while the list reloads: focus follows to the result (UXRD 6.4 Error).
  const retryHadFocus = useRef(false);
  // Threads on screen when a keyboard-started next-page load began; null for pointer and viewport starts.
  const idsBeforeKeyboardLoad = useRef<ReadonlySet<string> | null>(null);
  const { isLoadingMore, loadMoreFailed } = pagination;

  useEffect(() => {
    if (!retryHadFocus.current || state.kind === 'loading') return;
    retryHadFocus.current = false;
    const selector =
      state.kind === 'ready' ? THREAD_LINK_SELECTOR : '[data-list-retry]';
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
  }, [state.kind]);

  // UXRD 6.8 Loaded: a keyboard-started load focuses the first new thread; a failed one, SB-10 «Повторить».
  useEffect(() => {
    const idsBefore = idsBeforeKeyboardLoad.current;
    const root = rootRef.current;
    if (idsBefore === null || isLoadingMore || root === null) return;
    idsBeforeKeyboardLoad.current = null;
    const target = loadMoreFailed
      ? root.querySelector<HTMLElement>('[data-load-more-retry]')
      : rowsOf(root)
          .find(
            (row) =>
              !idsBefore.has(row.getAttribute(THREAD_ROW_ATTRIBUTE) ?? ''),
          )
          ?.querySelector<HTMLElement>(THREAD_LINK_SELECTOR);
    target?.focus();
  }, [isLoadingMore, loadMoreFailed]);

  const loadMore = (source: LoadMoreSource): void => {
    idsBeforeKeyboardLoad.current =
      source === 'keyboard' ? entryIdsOf(state) : null;
    pagination.onLoadMore(source);
  };

  const requestDelete = (entry: ThreadListEntry): void => {
    const root = rootRef.current;
    deleteFinalFocus.current =
      root === null ? null : actionsButtonOf(root, entry.id);
    setPendingDelete(entry);
    setDeleteOpen(true);
  };

  const confirmDelete = (): void => {
    if (pendingDelete === null) return;
    const root = rootRef.current;
    // The open thread hands focus to the route change; any other moves it to a neighbour picked before its row leaves.
    deleteFinalFocus.current =
      pendingDelete.id === openThreadId || root === null
        ? null
        : focusTargetAfterRemoval(root, pendingDelete.id);
    onDelete(pendingDelete);
  };

  // A reply may start or finish while the dialog is open: the A-4 paragraph follows the live entry.
  const liveDeleteEntry =
    pendingDelete !== null && state.kind === 'ready'
      ? (state.groups
          .flatMap((group) => group.entries)
          .find((entry) => entry.id === pendingDelete.id) ?? pendingDelete)
      : pendingDelete;
  const renderRow = (entry: ThreadListEntry): ReactNode =>
    renderItem(entry, () => requestDelete(entry));

  return (
    <div
      ref={rootRef}
      className="flex flex-col"
      onKeyDown={moveFocusBetweenLinks}
    >
      {state.kind === 'loading' && <ListSkeleton />}
      {state.kind === 'error' && (
        <div className="flex flex-col items-start gap-2 px-4 py-2 text-[13px]">
          <p role="alert">{t('list.loadFailed')}</p>
          <Button
            data-list-retry=""
            variant="outline"
            size="sm"
            onClick={(event) => {
              retryHadFocus.current =
                document.activeElement === event.currentTarget;
              state.onRetry();
            }}
          >
            <RotateCwIcon aria-hidden />
            {t('list.retry')}
          </Button>
        </div>
      )}
      {state.kind === 'ready' && state.groups.length === 0 && (
        <div className="px-4 py-2 text-[13px]">
          <p className="text-sidebar-foreground">{t('list.empty')}</p>
          <p className="text-muted-foreground">{t('list.emptyHint')}</p>
        </div>
      )}
      {state.kind === 'ready' &&
        state.groups.map((group) => (
          <ThreadGroupSection
            key={group.key}
            group={group}
            renderItem={renderRow}
          />
        ))}
      {state.kind === 'ready' && pagination.hasMore && (
        <NextPage
          isLoadingMore={isLoadingMore}
          loadMoreFailed={loadMoreFailed}
          onLoadMore={loadMore}
        />
      )}
      {liveDeleteEntry !== null && (
        <DeleteThreadDialog
          open={deleteOpen}
          threadId={liveDeleteEntry.remoteId}
          threadTitle={liveDeleteEntry.title ?? t('thread.untitled')}
          onConfirm={confirmDelete}
          onOpenChange={setDeleteOpen}
          finalFocus={deleteFinalFocus}
        />
      )}
    </div>
  );
}

function ThreadGroupSection({
  group,
  renderItem,
}: {
  group: ThreadGroup;
  renderItem: (entry: ThreadListEntry) => ReactNode;
}) {
  const t = useTranslations('shell.dateGroup');
  const headingId = useId();
  return (
    <SidebarGroup className="py-0 pt-4 first:pt-2">
      <SidebarGroupLabel
        id={headingId}
        render={<h2 />}
        className="text-muted-foreground h-6 text-xs"
      >
        {t(group.key)}
      </SidebarGroupLabel>
      <SidebarMenu aria-labelledby={headingId}>
        {group.entries.map(renderItem)}
      </SidebarMenu>
    </SidebarGroup>
  );
}

/** SB-10: «Показать ещё», its loading rows or its error, under the last group (UXRD 6.8). */
function NextPage({
  isLoadingMore,
  loadMoreFailed,
  onLoadMore,
}: Omit<ThreadListPagination, 'hasMore'>) {
  const t = useTranslations('shell.list');
  if (isLoadingMore) {
    return (
      <div
        role="status"
        aria-label={t('loadingMore')}
        className="flex flex-col px-2"
      >
        <span className="sr-only">{t('loadingMore')}</span>
        {MORE_SKELETON_ROW_WIDTHS.map((width) => (
          <div key={width} aria-hidden className="flex h-9 items-center px-2">
            <Skeleton
              className="h-4 motion-reduce:animate-none"
              style={{ width }}
            />
          </div>
        ))}
      </div>
    );
  }
  if (loadMoreFailed) {
    return (
      <div className="flex flex-col items-start gap-2 px-4 py-2 text-[13px]">
        <p role="alert">{t('loadMoreFailed')}</p>
        <Button
          data-load-more-retry=""
          variant="outline"
          size="sm"
          onClick={(event) => onLoadMore(clickSource(event))}
        >
          <RotateCwIcon aria-hidden />
          {t('retry')}
        </Button>
      </div>
    );
  }
  return <ShowMoreButton onLoadMore={onLoadMore} />;
}

/** «Показать ещё»: a click, or the button nearing the sidebar's visible edge, loads the next page. */
function ShowMoreButton({
  onLoadMore,
}: Pick<ThreadListPagination, 'onLoadMore'>) {
  const t = useTranslations('shell.list');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const loadOnView = useEffectEvent(() => onLoadMore('viewport'));

  useEffect(() => {
    const button = buttonRef.current;
    if (button === null) return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) loadOnView();
      },
      {
        root: button.closest(SIDEBAR_SCROLL_SELECTOR),
        rootMargin: AUTO_LOAD_ROOT_MARGIN,
      },
    );
    observer.observe(button);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="px-2 py-2">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="sm"
        className="w-full"
        onClick={(event) => onLoadMore(clickSource(event))}
      >
        {t.rich('showMore', {
          hidden: (chunks) => <span className="sr-only">{chunks}</span>,
        })}
      </Button>
    </div>
  );
}

function ListSkeleton() {
  const t = useTranslations('shell.list');
  return (
    <div
      role="status"
      aria-label={t('loading')}
      className="flex flex-col gap-0 px-2 pt-2"
    >
      <span className="sr-only">{t('loading')}</span>
      <div aria-hidden className="flex h-12 items-center px-2">
        <Skeleton className="h-3 w-20 motion-reduce:animate-none" />
      </div>
      {SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} aria-hidden className="flex h-9 items-center px-2">
          <Skeleton
            className="h-4 motion-reduce:animate-none"
            style={{ width }}
          />
        </div>
      ))}
    </div>
  );
}

/** Reads the runtime's thread list and ShellStatus, groups the threads by date and renders ThreadHistoryListView. */
export function ThreadHistoryList() {
  const aui = useAui();
  const services = useShellServices();
  const pathname = usePathname();
  // Deleting the open thread: the runtime leaves it, url-sync replaces the route with `/`, then focus follows
  // the «Новый чат» pointer rule (UXRD 7.4).
  const focusOnRoot = useRef(false);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const isLoading = useAuiState((s) => s.threads.isLoading);
  const loadError = useAuiState((s) => s.threads.loadError);
  const mainThreadId = useAuiState((s) => s.threads.mainThreadId);
  const hasMore = useAuiState((s) => s.threads.hasMore);
  const isLoadingMore = useAuiState((s) => s.threads.isLoadingMore);
  const loadMoreFailed = useShellStatus((s) => s.loadMoreFailed);
  const activityAt = useShellStatus((s) => s.activityAt);
  const titleWaiting = useShellStatus((s) => s.titleWaiting);
  const asideBranchId = useStore(services.workspace, (s) => s.aside?.branchId);
  const now = useNow();

  const entries = useMemo(
    () =>
      threadItems
        .filter((item) => item.status === 'regular')
        .map((item): ThreadListEntry => {
          // `toRemoteMetadata` puts both flags in `custom`; a thread made in this tab has them from its create.
          const custom =
            item.custom ??
            (item.remoteId === undefined
              ? undefined
              : services.listAdapter.createdCustom(item.remoteId));
          return {
            id: item.id,
            remoteId: item.remoteId,
            title: item.title,
            activityAt: entryActivityAt(
              {
                lastMessageAt: item.lastMessageAt,
                activityAt: activityAt[item.id],
              },
              now,
            ),
            forkable: custom?.forkable === true,
            forked: custom?.forked === true,
            state: conversationStateOf(custom?.state),
          };
        }),
    [threadItems, activityAt, now, services],
  );
  const groups = useMemo(
    () => groupThreadsByDate(entries, now),
    [entries, now],
  );
  // The branch on «В стороне» counts as on screen only beside its own conversation: the tab is there only then (KD-5).
  const mainRemoteId =
    entries.find((entry) => entry.id === mainThreadId)?.remoteId ?? null;
  const shownBranchId = useStore(
    services.workspace,
    (s) => asideOf(s, mainRemoteId)?.branchId ?? null,
  );

  // The skeleton covers the first load and a retry after an error; a later reload keeps the list on screen.
  const hasError = loadError !== undefined && loadError !== null;
  const [listShown, setListShown] = useState(false);
  if (!isLoading && !hasError && !listShown) setListShown(true);
  if (hasError && listShown) setListShown(false);

  // Coming back to the tab re-reads page 1 only while one page is loaded: reload() drops pages 2+ (DD Open Questions 2).
  const onePageLoaded = entries.length <= THREAD_PAGE_SIZE;
  useEffect(() => {
    if (!onePageLoaded) return;
    const onVisibilityChange = () => {
      if (
        document.visibilityState === 'visible' &&
        !aui.threads.getState().isLoading
      )
        void aui.threads.reload();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [aui, onePageLoaded]);

  // Page 1 carries each row's state (improvements KD-5): any `tree` note re-reads it — a new conversation, a reply
  // started or finished, a question asked — on the same terms as coming back to the tab.
  const reads = useMemo(
    () =>
      createCoalescedRunner(() => aui.threads.reload(), {
        minIntervalMs: TREE_RELOAD_INTERVAL_MS,
      }),
    [aui],
  );
  useEffect(() => () => reads.cancel(), [reads]);
  useEffect(() => {
    if (!onePageLoaded) return;
    return services.live.onTree(() => void reads.request());
  }, [services, reads, onePageLoaded]);
  const requestRead = useEffectEvent(() => {
    if (onePageLoaded) void reads.request();
  });
  // Leaving a conversation takes its «новый ответ» off the row only once page 1 is read again (KD-5).
  const previousMainThread = useRef(mainThreadId);
  useEffect(() => {
    if (previousMainThread.current === mainThreadId) return;
    previousMainThread.current = mainThreadId;
    requestRead();
  }, [mainThreadId]);
  // A side chat's branch has no message yet, so no `tree` note announces it (KD-5). The list may be off screen
  // while the panel folds the sidebar, so the check also runs when it mounts again.
  const isUnlisted = useEffectEvent(
    (threadId: string) => !entries.some((entry) => entry.remoteId === threadId),
  );
  useEffect(() => {
    if (asideBranchId !== undefined && isUnlisted(asideBranchId)) requestRead();
  }, [asideBranchId]);

  useEffect(() => {
    if (!focusOnRoot.current || pathname !== '/') return;
    focusOnRoot.current = false;
    focusAfterNewChat();
  }, [pathname]);

  // Flow 3: the fork opens like any conversation by its address, and its row joins the list there (KD-8).
  const openBranch = useOpenBranch();
  const fork = (entry: ThreadListEntry): void => {
    if (entry.remoteId !== undefined) void openBranch(entry.remoteId);
  };

  const state: ThreadHistoryListState =
    isLoading && !listShown
      ? { kind: 'loading' }
      : hasError
        ? { kind: 'error', onRetry: () => void aui.threads.reload() }
        : { kind: 'ready', groups };

  return (
    <ThreadHistoryListView
      state={state}
      pagination={{
        hasMore,
        isLoadingMore,
        loadMoreFailed,
        // A failed page: the runtime logs it, the list adapter sets loadMoreFailed for SB-10 Error.
        onLoadMore: () => void aui.threads.loadMore(),
      }}
      openThreadId={mainThreadId}
      onDelete={(entry) => {
        if (entry.id === mainThreadId) focusOnRoot.current = true;
        // The store-level `delete()` returns nothing; the item runtime's promise tells a finished deletion.
        const item = aui.threads
          .item({ id: entry.id })
          .__internal_getRuntime?.();
        if (item === undefined) {
          logger.error(
            '[web-shell] thread delete unavailable: no item runtime',
            { threadId: entry.id },
          );
          return;
        }
        item.delete().then(
          // design-web.md, Risks: the tree, the counter and an open agent page of this thread re-read.
          () => {
            if (entry.remoteId !== undefined)
              services.live.emitLocalTree(entry.remoteId);
          },
          (error: unknown) => {
            // A failed DELETE is already reported by the list adapter (toast, rollback, log).
            if (!isApiRequestError(error)) {
              logger.error('[web-shell] thread delete failed', {
                threadId: entry.id,
                ...describeApiError(error),
              });
            }
          },
        );
      }}
      renderItem={(entry, onRequestDelete) => (
        <ThreadHistoryItem
          key={entry.id}
          entry={entry}
          state={shownState(entry.state, {
            onScreen:
              entry.id === mainThreadId ||
              (entry.remoteId !== undefined &&
                entry.remoteId === shownBranchId),
          })}
          isActive={entry.id === mainThreadId}
          titlePending={
            entry.remoteId !== undefined &&
            titleWaiting[entry.remoteId] === true
          }
          // A failed PATCH: the list adapter shows the toast, the runtime rolls the title back and logs the rejection.
          onRename={(title) => aui.threads.item({ id: entry.id }).rename(title)}
          onRequestDelete={onRequestDelete}
          onFork={() => fork(entry)}
        />
      )}
    />
  );
}
