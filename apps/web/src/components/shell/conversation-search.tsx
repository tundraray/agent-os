'use client';

import {
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type Ref,
  type RefObject,
} from 'react';
import type { ConversationMatch } from '@agent-os/contracts';
import { RotateCwIcon, SearchIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useStore } from 'zustand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSidebar } from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { useNow } from '@/hooks/use-now';
import { focusShellTarget, isFinePointer } from '@/lib/focus';
import {
  isSearchActive,
  matchKey,
  type SearchState,
  type SearchStore,
} from '@/lib/search/search-store';
import { useShellServices } from './shell-actions';
import { SEARCH_RESULT_ATTRIBUTE, SearchResult } from './search-result';

const SEARCH_RESULT_SELECTOR = `a[${SEARCH_RESULT_ATTRIBUTE}]`;

/** Rows of the first-search skeleton (UXRD Screen 5, «Первый запрос идёт»). */
const SKELETON_ROWS = ['a', 'b', 'c'] as const;

const resultLinksOf = (root: HTMLElement | null): HTMLAnchorElement[] =>
  root === null
    ? []
    : Array.from(
        root.querySelectorAll<HTMLAnchorElement>(SEARCH_RESULT_SELECTOR),
      );

export type ConversationSearchProps = {
  /** The field: the strip's search button focuses it once the sidebar is expanded (MC-14). */
  inputRef?: Ref<HTMLInputElement>;
};

/**
 * SR-01 and SR-02: the search field above the conversation list and, while it holds a searchable text, the
 * matches in the list's place. State lives in the shell's search store (KD-7), so the field, the matches and the
 * opened match outlive navigation and the mobile drawer.
 */
export function ConversationSearch({ inputRef }: ConversationSearchProps) {
  const t = useTranslations('shell.search');
  const store = useShellServices().search;
  const query = useStore(store, (state) => state.query);
  const active = useStore(store, isSearchActive);
  const rootRef = useRef<HTMLDivElement>(null);

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && query !== '') {
      // The drawer closes on Esc too: a field with text takes the key for itself.
      event.preventDefault();
      event.stopPropagation();
      store.clear();
      return;
    }
    if (event.key === 'ArrowDown') {
      const first = resultLinksOf(rootRef.current)[0];
      if (first === undefined) return;
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div ref={rootRef} className="flex flex-col">
      <div role="search" className="relative px-2 pt-2">
        <SearchIcon
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-4.5 mt-1 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          ref={inputRef}
          type="search"
          value={query}
          aria-label={t('label')}
          placeholder={t('label')}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => store.setQuery(event.target.value)}
          onKeyDown={onFieldKeyDown}
          className="h-9 bg-sidebar pr-9 pl-8 pointer-coarse:h-11 [&::-webkit-search-cancel-button]:appearance-none"
        />
        {query !== '' && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('clear')}
            className="absolute top-1/2 right-3 mt-1 -translate-y-1/2 pointer-coarse:size-9"
            onClick={() => {
              store.clear();
              rootRef.current?.querySelector('input')?.focus();
            }}
          >
            <XIcon aria-hidden />
          </Button>
        )}
      </div>
      {active && <SearchMatches store={store} rootRef={rootRef} />}
    </div>
  );
}

type SearchMatchesProps = {
  store: SearchStore;
  rootRef: RefObject<HTMLDivElement | null>;
};

/** What the `status` region reads (UXRD Accessibility, «Объявления»). */
function statusKey(
  state: Pick<SearchState, 'status' | 'matches' | 'loadingMore'>,
): 'searching' | 'found' | 'empty' | null {
  if (state.status === 'loading' || state.loadingMore) return 'searching';
  if (state.status !== 'ready') return null;
  return state.matches.length > 0 ? 'found' : 'empty';
}

/** SR-02 with the states of UXRD Screen 5: first-search skeleton, matches, nothing found, error, next page. */
function SearchMatches({ store, rootRef }: SearchMatchesProps) {
  const t = useTranslations('shell.search');
  const { isMobile, setOpenMobile } = useSidebar();
  const now = useNow();
  const status = useStore(store, (state) => state.status);
  const matches = useStore(store, (state) => state.matches);
  const nextCursor = useStore(store, (state) => state.nextCursor);
  const loadingMore = useStore(store, (state) => state.loadingMore);
  const loadMoreFailed = useStore(store, (state) => state.loadMoreFailed);
  const openedKey = useStore(store, (state) => state.openedKey);
  const announced = statusKey({ status, matches, loadingMore });

  const open = (
    match: ConversationMatch,
    position: number,
    event: MouseEvent<HTMLAnchorElement>,
  ): void => {
    store.open(match, position);
    // A match in a message or a tool result: the feed focuses its target (search-result.md, «Открытие»).
    // A title match opens its conversation as usual, like a conversation link (UXRD 7.4).
    if (isMobile) {
      setOpenMobile(false);
      if (match.place === 'title') focusShellTarget('page-title');
      return;
    }
    if (match.place !== 'title' || event.detail === 0) return;
    focusShellTarget(isFinePointer() ? 'composer' : 'page-title');
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const target = event.target;
    if (!(target instanceof HTMLAnchorElement)) return;
    const links = resultLinksOf(rootRef.current);
    const index = links.indexOf(target);
    if (index === -1) return;
    if (event.key === 'ArrowUp' && index === 0) {
      event.preventDefault();
      rootRef.current?.querySelector('input')?.focus();
      return;
    }
    const last = links.length - 1;
    const nextIndex = {
      ArrowDown: Math.min(index + 1, last),
      ArrowUp: index - 1,
      Home: 0,
      End: last,
    }[event.key];
    if (nextIndex === undefined) return;
    event.preventDefault();
    links[nextIndex]?.focus();
  };

  return (
    <div className="flex flex-col pt-2">
      <p role="status" className="sr-only">
        {announced === null ? '' : t(announced)}
      </p>
      {status === 'failed' && <SearchError onRetry={() => store.retry()} />}
      {status === 'loading' && matches.length === 0 && <MatchSkeleton />}
      {status === 'ready' && matches.length === 0 && (
        <div className="flex flex-col items-center px-4 py-6 text-center text-data">
          <p className="text-foreground">{t('empty')}</p>
          <p className="text-muted-foreground">{t('emptyHint')}</p>
        </div>
      )}
      {status !== 'failed' && matches.length > 0 && (
        <ul
          aria-label={t('results')}
          className="flex flex-col gap-2 px-2"
          onKeyDown={onListKeyDown}
        >
          {matches.map((match, index) => {
            const key = matchKey(match);
            return (
              <SearchResult
                key={key}
                match={match}
                opened={key === openedKey}
                now={now}
                onOpen={(event) => open(match, index + 1, event)}
              />
            );
          })}
        </ul>
      )}
      {status === 'ready' && nextCursor !== null && (
        <div className="px-2 py-2">
          {loadingMore ? (
            <MatchSkeleton />
          ) : loadMoreFailed ? (
            <SearchError onRetry={() => void store.loadMore()} />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={() => void store.loadMore()}
            >
              {t('showMore')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SearchError({ onRetry }: { onRetry: () => void }) {
  const t = useTranslations('shell.search');
  return (
    <div className="flex flex-col items-start gap-2 px-4 py-2 text-data">
      <p role="alert">{t('failed')}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCwIcon aria-hidden />
        {t('retry')}
      </Button>
    </div>
  );
}

/** Three rows the height of a match: title, where, two snippet lines (search-result.md, Loading). */
function MatchSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2 px-4">
      {SKELETON_ROWS.map((row) => (
        <div key={row} className="flex flex-col gap-1 py-1.5">
          <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
          <Skeleton className="h-3 w-2/5 motion-reduce:animate-none" />
          <Skeleton className="h-3.5 w-full motion-reduce:animate-none" />
          <Skeleton className="h-3.5 w-4/5 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  );
}
