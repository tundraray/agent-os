import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { describeApiError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';

export type ResourceStatus = 'loading' | 'ready' | 'error';

export type Resource<T> = {
  status: ResourceStatus;
  data: T | undefined;
  /** The read's original error (an `ApiRequestError` from `adminApi`), so a screen can tell `not_found` apart. */
  error: unknown;
  /** Reads again; rows already on screen stay until the new read replaces them. */
  reload: () => void;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

export type PagedResource<T> = {
  status: ResourceStatus;
  items: T[];
  nextCursor: string | null;
  error: unknown;
  reload: () => void;
  /** Reads the page after `nextCursor`; a failure keeps the loaded rows and sets `loadMoreError`. */
  loadMore: () => void;
  loadingMore: boolean;
  loadMoreError: unknown;
};

type Outcome<R> = { ok: true; value: R } | { ok: false; error: unknown };

/** The latest `value` for callbacks that must not restart effects when the caller passes a new closure. */
function useLatest<V>(value: V) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Runs reads so that only the newest one reaches the screen, and only while it is mounted. `apiRequest`
 * takes no signal, so a superseded request still completes; its answer is dropped here. Every failed
 * read is logged once, here.
 */
function useLatestRead() {
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  return useCallback(<R,>(read: () => Promise<R>, apply: (outcome: Outcome<R>) => void): void => {
    generation.current += 1;
    const mine = generation.current;
    read().then(
      (value) => {
        if (mine === generation.current) apply({ ok: true, value });
      },
      (error: unknown) => {
        logger.error('admin: read failed', describeApiError(error));
        if (mine === generation.current) apply({ ok: false, error });
      },
    );
  }, []);
}

type Snapshot<S> = S & { key: string; status: ResourceStatus; error: unknown };

/** design-admin.md, KD-4: a screen's data read on open and on `key` change, read again after a change. */
export function useResource<T>(load: () => Promise<T>, key: string): Resource<T> {
  const loadRef = useLatest(load);
  const run = useLatestRead();
  const [snapshot, setSnapshot] = useState<Snapshot<{ data: T | undefined }>>({
    key,
    status: 'loading',
    data: undefined,
    error: undefined,
  });

  const read = useCallback(
    (readKey: string) =>
      run(
        () => loadRef.current(),
        (outcome) =>
          setSnapshot(
            outcome.ok
              ? { key: readKey, status: 'ready', data: outcome.value, error: undefined }
              : { key: readKey, status: 'error', data: undefined, error: outcome.error },
          ),
      ),
    [run, loadRef],
  );

  useEffect(() => read(key), [key, read]);

  const reload = useCallback(() => {
    setSnapshot((previous) =>
      previous.key === key && previous.status === 'ready'
        ? previous
        : { key, status: 'loading', data: undefined, error: undefined },
    );
    read(key);
  }, [key, read]);

  // A snapshot of the previous key is never shown: the new key is loading until its own answer arrives.
  const current = snapshot.key === key ? snapshot : { status: 'loading' as const, data: undefined, error: undefined };
  return { status: current.status, data: current.data, error: current.error, reload };
}

type PageState<T> = {
  items: T[];
  nextCursor: string | null;
  loadingMore: boolean;
  loadMoreError: unknown;
  /** A `reload` is running: «Показать ещё» waits, its page would be appended to rows about to be replaced. */
  reloading: boolean;
};

const emptyPages = { items: [], nextCursor: null, loadingMore: false, loadMoreError: undefined, reloading: false };

/** `useResource` for a cursor list: the first page on open and on `key` change, later pages by `loadMore`. */
export function usePagedResource<T>(
  loadPage: (cursor: string | null) => Promise<Page<T>>,
  key: string,
): PagedResource<T> {
  const loadPageRef = useLatest(loadPage);
  const run = useLatestRead();
  const [snapshot, setSnapshot] = useState<Snapshot<PageState<T>>>({
    key,
    status: 'loading',
    error: undefined,
    ...emptyPages,
  });

  const readFirst = useCallback(
    (readKey: string) =>
      run(
        () => loadPageRef.current(null),
        (outcome) =>
          setSnapshot(
            outcome.ok
              ? { key: readKey, status: 'ready', error: undefined, ...emptyPages, ...outcome.value }
              : { key: readKey, status: 'error', error: outcome.error, ...emptyPages },
          ),
      ),
    [run, loadPageRef],
  );

  useEffect(() => readFirst(key), [key, readFirst]);

  const reload = useCallback(() => {
    setSnapshot((previous) =>
      previous.key === key && previous.status === 'ready'
        ? { ...previous, reloading: true }
        : { key, status: 'loading', error: undefined, ...emptyPages },
    );
    readFirst(key);
  }, [key, readFirst]);

  const current = snapshot.key === key ? snapshot : { status: 'loading' as const, error: undefined, ...emptyPages };

  const { nextCursor, loadingMore, reloading } = current;
  const canLoadMore = current.status === 'ready' && nextCursor !== null && !loadingMore && !reloading;
  const loadMore = useCallback(() => {
    if (!canLoadMore || nextCursor === null) return;
    setSnapshot((previous) => ({ ...previous, loadingMore: true, loadMoreError: undefined }));
    run(
      () => loadPageRef.current(nextCursor),
      (outcome) =>
        setSnapshot((previous) =>
          outcome.ok
            ? {
                ...previous,
                items: [...previous.items, ...outcome.value.items],
                nextCursor: outcome.value.nextCursor,
                loadingMore: false,
              }
            : { ...previous, loadingMore: false, loadMoreError: outcome.error },
        ),
    );
  }, [canLoadMore, nextCursor, run, loadPageRef]);

  return {
    status: current.status,
    items: current.items,
    nextCursor,
    error: current.error,
    reload,
    loadMore,
    loadingMore,
    loadMoreError: current.loadMoreError,
  };
}
