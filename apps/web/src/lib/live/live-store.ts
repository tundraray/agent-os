import {
  LiveEventSchema,
  type LiveChangeKind,
  type LiveEvent,
} from '@agent-os/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  apiRequest,
  describeApiError,
  isApiRequestError,
} from '@/lib/api/api-request';
import type { logger as appLogger } from '@/lib/logger';

import type { AnnouncerStore } from './announcer-store';

/** What the stream watches: the open conversation or the open agent page. */
export type LiveTarget = `thread:${string}` | `agent:${string}`;

export type LiveConnection = 'connecting' | 'open' | 'lost';

/** The part of `EventSource` the store uses; a test passes its own source. */
export type LiveEventSource = {
  readonly readyState: number;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  close: () => void;
};

/** Opens the stream; jsdom has no `EventSource`, so the function is injected. */
export type OpenEventSource = (url: string) => LiveEventSource;

export type LiveDelta = Extract<LiveEvent, { type: 'delta' }>['data'];
export type LiveChange = Extract<LiveEvent, { type: 'change' }>['data'];
export type LiveAttention = Extract<LiveEvent, { type: 'attention' }>['data'];

/**
 * Which changes reach a subscriber (live-feed design-web.md, KD-1): one of `kinds`, of the conversation
 * `threadId` when given; `agentId` narrows `entries` — the only kind that names an agent — to that agent.
 */
export type LiveChangeFilter = {
  kinds: readonly LiveChangeKind[];
  threadId?: string;
  agentId?: string;
};

export type LiveState = {
  connection: LiveConnection;
  target: LiveTarget | null;
};

export type LiveStore = StoreApi<LiveState> & {
  /**
   * Follows the screen. The same target keeps the stream (resolves at once while `open`); another
   * target closes the stream and opens a new one. Resolves on the first `ready` or after 1 s.
   */
  watch: (target: LiveTarget | null) => Promise<void>;
  /** Closes the stream and all timers; the next `watch` opens the stream again (StrictMode remount). */
  dispose: () => void;
  /** Every subscriber's `ready`: the stream opened, or a `change` came that the web does not understand. */
  onReady: (listener: () => void) => () => void;
  /** The `change` frames that match `filter`. */
  onChange: (
    filter: LiveChangeFilter,
    listener: (change: LiveChange) => void,
  ) => () => void;
  onAttention: (listener: (attention: LiveAttention) => void) => () => void;
  onDelta: (listener: (delta: LiveDelta) => void) => () => void;
};

type LiveLogger = Pick<typeof appLogger, 'warn'>;

/** `EventSource.CLOSED`, spelled out: the constant is absent where `EventSource` is. */
const READY_STATE_CLOSED = 2;
/** Reopen delay after the source closed itself — the server's `retry` hint. */
const REOPEN_DELAY_MS = 2000;
/** The longest `watch` waits for `ready` (design-web.md, KD-2). */
const READY_WAIT_MS = 1000;

const LIVE_EVENT_TYPES: readonly LiveEvent['type'][] = [
  'ready',
  'change',
  'attention',
  'delta',
  'ping',
];

function matches(filter: LiveChangeFilter, change: LiveChange): boolean {
  if (!filter.kinds.includes(change.kind)) return false;
  if (filter.threadId !== undefined && filter.threadId !== change.threadId)
    return false;
  return (
    change.kind !== 'entries' ||
    filter.agentId === undefined ||
    filter.agentId === change.agentId
  );
}

const defaultOpenEventSource: OpenEventSource = (url) =>
  new EventSource(url, { withCredentials: true });

function eventsUrl(target: LiveTarget | null): string {
  const base = '/api/events';
  return target === null ? base : `${base}?watch=${encodeURIComponent(target)}`;
}

/**
 * A closed stream shows no status code, so `GET /api/auth/me` tells whether the session is gone
 * (design-identity.md, C3 web; DC-13). A 401 has already reached the unauthorized handler, which
 * leaves the page; any other answer keeps reconnecting as before.
 */
async function sessionAlive(logger: LiveLogger): Promise<boolean> {
  try {
    await apiRequest({ path: '/api/auth/me' });
    return true;
  } catch (error) {
    if (isApiRequestError(error) && error.status === 401) return false;
    logger.warn(
      'live session probe failed; reopening',
      describeApiError(error),
    );
    return true;
  }
}

function frameData(event: Event): unknown {
  return 'data' in event ? event.data : undefined;
}

function subscribe<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The tab's only live stream (design-web.md, KD-2, Contract «LiveStore», Flow 4). At most one source
 * is open at any moment (Invariant 1): every open closes the previous source first.
 */
export function createLiveStore({
  openEventSource = defaultOpenEventSource,
  announcer,
  logger,
}: {
  openEventSource?: OpenEventSource;
  announcer: AnnouncerStore;
  logger: LiveLogger;
}): LiveStore {
  const state = createStore<LiveState>()(() => ({
    connection: 'connecting',
    target: null,
  }));

  const readyListeners = new Set<() => void>();
  const changeListeners = new Set<{
    filter: LiveChangeFilter;
    listener: (change: LiveChange) => void;
  }>();
  const attentionListeners = new Set<(attention: LiveAttention) => void>();
  const deltaListeners = new Set<(delta: LiveDelta) => void>();

  let source: LiveEventSource | null = null;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  /** The session probe in flight after the source closed; a newer open or `dispose` drops its answer. */
  let probe: object | null = null;
  const readyWaiters = new Set<{
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  function closeSource(): void {
    if (reopenTimer !== null) clearTimeout(reopenTimer);
    reopenTimer = null;
    probe = null;
    source?.close();
    source = null;
  }

  function settleWaiters(): void {
    for (const waiter of readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    readyWaiters.clear();
  }

  function waitForReady(): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          readyWaiters.delete(waiter);
          resolve();
        }, READY_WAIT_MS),
      };
      readyWaiters.add(waiter);
    });
  }

  function dispatchReady(): void {
    for (const listener of readyListeners) listener();
  }

  function handleReady(): void {
    const wasLost = state.getState().connection === 'lost';
    state.setState({ connection: 'open' });
    if (wasLost) announcer.getState().announce('announce.connectionRestored');
    settleWaiters();
    dispatchReady();
  }

  /**
   * A `change` the web does not understand — a kind it does not know, or a body it cannot read — goes to everyone
   * as `ready`: every screen part already rereads itself on `ready` (live-feed design-web.md, KD-1, AC-06.3).
   */
  function dropFrame(type: LiveEvent['type'], reason: string): void {
    if (type !== 'change') {
      logger.warn(`live frame dropped: ${reason}`, { eventType: type });
      return;
    }
    logger.warn(`live change not understood (${reason}): rereading as ready`, {
      eventType: type,
    });
    dispatchReady();
  }

  function handleFrame(type: LiveEvent['type'], event: Event): void {
    let data: unknown;
    try {
      const raw = frameData(event);
      data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      dropFrame(type, 'not JSON');
      return;
    }
    const parsed = LiveEventSchema.safeParse({ type, data });
    if (!parsed.success) {
      dropFrame(type, 'schema mismatch');
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case 'ready':
        handleReady();
        break;
      case 'change':
        for (const { filter, listener } of changeListeners)
          if (matches(filter, frame.data)) listener(frame.data);
        break;
      case 'attention':
        for (const listener of attentionListeners) listener(frame.data);
        break;
      case 'delta':
        for (const listener of deltaListeners) listener(frame.data);
        break;
      case 'ping':
        break;
    }
  }

  function handleError(failed: LiveEventSource): void {
    if (state.getState().connection !== 'lost') {
      state.setState({ connection: 'lost' });
      announcer.getState().announce('announce.connectionLost');
    }
    // A CONNECTING source retries by itself; a CLOSED one never comes back, so the store reopens it
    // once the session is known to be alive.
    if (failed.readyState === READY_STATE_CLOSED) {
      closeSource();
      const current = {};
      probe = current;
      void sessionAlive(logger).then((alive) => {
        if (probe !== current) return;
        probe = null;
        if (alive) scheduleReopen();
      });
    }
  }

  function scheduleReopen(): void {
    reopenTimer = setTimeout(() => {
      reopenTimer = null;
      open();
    }, REOPEN_DELAY_MS);
  }

  function open(): void {
    closeSource();
    // While `lost`, the bar stays until `ready`; otherwise a new stream is just connecting.
    if (state.getState().connection !== 'lost')
      state.setState({ connection: 'connecting' });
    const opened = openEventSource(eventsUrl(state.getState().target));
    source = opened;
    // Events of a source closed meanwhile are stale; only the current source speaks.
    for (const type of LIVE_EVENT_TYPES) {
      opened.addEventListener(type, (event) => {
        if (source === opened) handleFrame(type, event);
      });
    }
    opened.addEventListener('error', () => {
      if (source === opened) handleError(opened);
    });
  }

  const isAlive = (): boolean =>
    source !== null || reopenTimer !== null || probe !== null;

  return Object.assign(state, {
    watch: (target: LiveTarget | null): Promise<void> => {
      const current = state.getState();
      if (isAlive() && current.target === target) {
        return current.connection === 'open'
          ? Promise.resolve()
          : waitForReady();
      }
      state.setState({ target });
      const ready = waitForReady();
      open();
      return ready;
    },
    dispose: (): void => {
      closeSource();
      settleWaiters();
    },
    onReady: (listener: () => void) => subscribe(readyListeners, listener),
    onChange: (
      filter: LiveChangeFilter,
      listener: (change: LiveChange) => void,
    ) => subscribe(changeListeners, { filter, listener }),
    onAttention: (listener: (attention: LiveAttention) => void) =>
      subscribe(attentionListeners, listener),
    onDelta: (listener: (delta: LiveDelta) => void) =>
      subscribe(deltaListeners, listener),
  });
}
