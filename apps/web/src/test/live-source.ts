import type { LiveEvent } from '@agent-os/contracts';
import { act } from '@testing-library/react';
import type { LiveEventSource, OpenEventSource } from '@/lib/live/live-store';

/** `EventSource.readyState` values; jsdom has no `EventSource` to read them from. */
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

/** One source the store opened: its URL and whether the store has closed it since. */
export type OpenedLiveSource = { readonly url: string; readonly closed: boolean };

export type TestLiveSource = {
  /** Passed to `ChatShell` in place of `new EventSource(url)`. */
  open: OpenEventSource;
  /** Every source opened so far, oldest first. */
  opened: readonly OpenedLiveSource[];
  /** The source that is open now (the last one, unless the store closed it). */
  current: () => OpenedLiveSource | undefined;
  /**
   * The most sources left unclosed at once so far (Invariant 1: at most one). Counted at every open,
   * the only moment the number can grow.
   */
  mostOpenAtOnce: () => number;
  /** Delivers one `/api/events` frame to the current source, as the server sends it (`data` is JSON). */
  emit: <T extends LiveEvent['type']>(type: T, data: Extract<LiveEvent, { type: T }>['data']) => void;
  /** Fires `error` on the current source; `closed: true` leaves it CLOSED (it never comes back by itself). */
  fail: (options?: { closed?: boolean }) => void;
};

class TestEventSource extends EventTarget implements LiveEventSource {
  readyState = CONNECTING;
  closed = false;

  constructor(readonly url: string) {
    super();
  }

  close(): void {
    this.closed = true;
    this.readyState = CLOSED;
  }
}

/**
 * The event source injected into `LiveStore` (jsdom has no `EventSource`): it records what the store
 * opens and lets the test push the frames the server would send. Frames go through `act`, because
 * the stores they reach re-render the shell.
 */
export function createTestLiveSource(): TestLiveSource {
  const sources: TestEventSource[] = [];
  let mostOpen = 0;

  const current = (): TestEventSource | undefined => {
    const last = sources.at(-1);
    return last === undefined || last.closed ? undefined : last;
  };

  const requireCurrent = (action: string): TestEventSource => {
    const source = current();
    if (source === undefined) throw new Error(`test live source: no open source to ${action}`);
    return source;
  };

  return {
    open: (url) => {
      const source = new TestEventSource(url);
      sources.push(source);
      mostOpen = Math.max(mostOpen, sources.filter((opened) => !opened.closed).length);
      return source;
    },
    mostOpenAtOnce: () => mostOpen,
    get opened() {
      return sources.map(({ url, closed }) => ({ url, closed }));
    },
    current: () => {
      const source = current();
      return source === undefined ? undefined : { url: source.url, closed: source.closed };
    },
    emit: (type, data) => {
      const source = requireCurrent(`emit «${type}»`);
      act(() => {
        source.readyState = OPEN;
        source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
      });
    },
    fail: ({ closed = false } = {}) => {
      const source = requireCurrent('fail');
      act(() => {
        source.readyState = closed ? CLOSED : CONNECTING;
        source.dispatchEvent(new Event('error'));
      });
    },
  };
}
