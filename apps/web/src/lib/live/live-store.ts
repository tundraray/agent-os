import { LiveEventSchema, type LiveEvent } from "@agent-os/contracts";
import { createStore, type StoreApi } from "zustand/vanilla";

import { apiBaseUrl } from "@/lib/config";
import type { logger as appLogger } from "@/lib/logger";

import type { AnnouncerStore } from "./announcer-store";

/** What the stream watches: the open conversation or the open agent page. */
export type LiveTarget = `thread:${string}` | `agent:${string}`;

export type LiveConnection = "connecting" | "open" | "lost";

/** The part of `EventSource` the store uses; a test passes its own source. */
export type LiveEventSource = {
  readonly readyState: number;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  close: () => void;
};

/** Opens the stream; jsdom has no `EventSource`, so the function is injected. */
export type OpenEventSource = (url: string) => LiveEventSource;

export type LiveDelta = Extract<LiveEvent, { type: "delta" }>["data"];

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
  onReady: (listener: () => void) => () => void;
  onTree: (listener: (threadId: string) => void) => () => void;
  onDelta: (listener: (delta: LiveDelta) => void) => () => void;
  /** Hands a `tree` note to the subscribers without the server: a deletion in this tab. */
  emitLocalTree: (threadId: string) => void;
};

type LiveLogger = Pick<typeof appLogger, "warn">;

/** `EventSource.CLOSED`, spelled out: the constant is absent where `EventSource` is. */
const READY_STATE_CLOSED = 2;
/** Reopen delay after the source closed itself — the server's `retry` hint. */
const REOPEN_DELAY_MS = 2000;
/** The longest `watch` waits for `ready` (design-web.md, KD-2). */
const READY_WAIT_MS = 1000;

const LIVE_EVENT_TYPES: readonly LiveEvent["type"][] = ["ready", "tree", "delta", "ping"];

/** MC-25. */
const ANNOUNCE_LOST = "Связь с сервером потеряна";
const ANNOUNCE_RESTORED = "Связь с сервером восстановлена";

const defaultOpenEventSource: OpenEventSource = (url) =>
  new EventSource(url, { withCredentials: true });

function eventsUrl(target: LiveTarget | null): string {
  const base = `${apiBaseUrl}/api/events`;
  return target === null ? base : `${base}?watch=${encodeURIComponent(target)}`;
}

function frameData(event: Event): unknown {
  return "data" in event ? event.data : undefined;
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
  const state = createStore<LiveState>()(() => ({ connection: "connecting", target: null }));

  const readyListeners = new Set<() => void>();
  const treeListeners = new Set<(threadId: string) => void>();
  const deltaListeners = new Set<(delta: LiveDelta) => void>();

  let source: LiveEventSource | null = null;
  let reopenTimer: ReturnType<typeof setTimeout> | null = null;
  const readyWaiters = new Set<{ resolve: () => void; timer: ReturnType<typeof setTimeout> }>();

  function closeSource(): void {
    if (reopenTimer !== null) clearTimeout(reopenTimer);
    reopenTimer = null;
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

  function dispatchTree(threadId: string): void {
    for (const listener of treeListeners) listener(threadId);
  }

  function handleReady(): void {
    const wasLost = state.getState().connection === "lost";
    state.setState({ connection: "open" });
    if (wasLost) announcer.getState().announce(ANNOUNCE_RESTORED);
    settleWaiters();
    for (const listener of readyListeners) listener();
  }

  function handleFrame(type: LiveEvent["type"], event: Event): void {
    let data: unknown;
    try {
      const raw = frameData(event);
      data = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      logger.warn("live frame dropped: not JSON", { eventType: type });
      return;
    }
    const parsed = LiveEventSchema.safeParse({ type, data });
    if (!parsed.success) {
      logger.warn("live frame dropped: schema mismatch", { eventType: type });
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case "ready":
        handleReady();
        break;
      case "tree":
        dispatchTree(frame.data.threadId);
        break;
      case "delta":
        for (const listener of deltaListeners) listener(frame.data);
        break;
      case "ping":
        break;
    }
  }

  function handleError(failed: LiveEventSource): void {
    if (state.getState().connection !== "lost") {
      state.setState({ connection: "lost" });
      announcer.getState().announce(ANNOUNCE_LOST);
    }
    // A CONNECTING source retries by itself; a CLOSED one never comes back, so the store reopens it.
    if (failed.readyState === READY_STATE_CLOSED) {
      closeSource();
      reopenTimer = setTimeout(() => {
        reopenTimer = null;
        open();
      }, REOPEN_DELAY_MS);
    }
  }

  function open(): void {
    closeSource();
    // While `lost`, the bar stays until `ready`; otherwise a new stream is just connecting.
    if (state.getState().connection !== "lost") state.setState({ connection: "connecting" });
    const opened = openEventSource(eventsUrl(state.getState().target));
    source = opened;
    // Events of a source closed meanwhile are stale; only the current source speaks.
    for (const type of LIVE_EVENT_TYPES) {
      opened.addEventListener(type, (event) => {
        if (source === opened) handleFrame(type, event);
      });
    }
    opened.addEventListener("error", () => {
      if (source === opened) handleError(opened);
    });
  }

  const isAlive = (): boolean => source !== null || reopenTimer !== null;

  return Object.assign(state, {
    watch: (target: LiveTarget | null): Promise<void> => {
      const current = state.getState();
      if (isAlive() && current.target === target) {
        return current.connection === "open" ? Promise.resolve() : waitForReady();
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
    onTree: (listener: (threadId: string) => void) => subscribe(treeListeners, listener),
    onDelta: (listener: (delta: LiveDelta) => void) => subscribe(deltaListeners, listener),
    emitLocalTree: dispatchTree,
  });
}
