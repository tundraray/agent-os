import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { server } from './msw-server';

/** Media features the matchMedia polyfill answers from; tests change them with `setTestMedia`. */
export type TestMedia = {
  pointer: 'fine' | 'coarse';
  colorScheme: 'light' | 'dark';
  /** Viewport width in CSS px: drives `(min-width)` / `(max-width)` and `window.innerWidth`. */
  width: number;
  /** Exact query strings with a fixed answer; they win over the features above. */
  queries: Readonly<Record<string, boolean>>;
};

const DEFAULT_MEDIA: TestMedia = { pointer: 'fine', colorScheme: 'light', width: 1280, queries: {} };

let media: TestMedia = DEFAULT_MEDIA;

const FEATURE_RULES: ReadonlyArray<{ pattern: RegExp; matches: (value: string) => boolean }> = [
  { pattern: /^\(\s*min-width:\s*(\d+(?:\.\d+)?)px\s*\)$/, matches: (px) => media.width >= Number(px) },
  { pattern: /^\(\s*max-width:\s*(\d+(?:\.\d+)?)px\s*\)$/, matches: (px) => media.width <= Number(px) },
  { pattern: /^\(\s*pointer:\s*(fine|coarse|none)\s*\)$/, matches: (pointer) => media.pointer === pointer },
  { pattern: /^\(\s*any-pointer:\s*(fine|coarse|none)\s*\)$/, matches: (pointer) => media.pointer === pointer },
  { pattern: /^\(\s*hover:\s*(hover|none)\s*\)$/, matches: (hover) => (hover === 'hover') === (media.pointer === 'fine') },
  { pattern: /^\(\s*prefers-color-scheme:\s*(light|dark)\s*\)$/, matches: (scheme) => media.colorScheme === scheme },
];

/** Evaluates a media query list of features joined by `and`; an unknown feature does not match. */
function evaluateQuery(query: string): boolean {
  const fixed = media.queries[query];
  if (fixed !== undefined) return fixed;
  return query.split(/\s+and\s+/).every((feature) => {
    const trimmed = feature.trim();
    for (const rule of FEATURE_RULES) {
      const match = rule.pattern.exec(trimmed);
      if (match !== null) return rule.matches(match[1]);
    }
    return false;
  });
}

type LegacyMediaListener = (this: MediaQueryList, event: MediaQueryListEvent) => unknown;

class TestMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media: string;
  onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => unknown) | null = null;
  private readonly legacyListeners = new Set<LegacyMediaListener>();
  private lastMatches: boolean;

  constructor(query: string) {
    super();
    this.media = query;
    this.lastMatches = evaluateQuery(query);
  }

  get matches(): boolean {
    return evaluateQuery(this.media);
  }

  addListener(listener: LegacyMediaListener | null): void {
    if (listener !== null) this.legacyListeners.add(listener);
  }

  removeListener(listener: LegacyMediaListener | null): void {
    if (listener !== null) this.legacyListeners.delete(listener);
  }

  /** Fires `change` when the answer differs from the last one this list reported. */
  notifyIfChanged(): void {
    const matches = this.matches;
    if (matches === this.lastMatches) return;
    this.lastMatches = matches;
    const event: MediaQueryListEvent = Object.assign(new Event('change'), { matches, media: this.media });
    this.dispatchEvent(event);
    this.onchange?.call(this, event);
    for (const listener of this.legacyListeners) listener.call(this, event);
  }
}

const liveQueryLists = new Set<TestMediaQueryList>();

function applyMedia(next: TestMedia): void {
  const widthChanged = next.width !== media.width;
  media = next;
  window.innerWidth = next.width;
  for (const list of liveQueryLists) list.notifyIfChanged();
  if (widthChanged) window.dispatchEvent(new Event('resize'));
}

/** Changes the emulated media features; live MediaQueryLists fire `change` where the answer flips. */
export function setTestMedia(next: Partial<TestMedia>): void {
  applyMedia({ ...media, ...next });
}

window.matchMedia = (query: string): MediaQueryList => {
  const list = new TestMediaQueryList(query);
  liveQueryLists.add(list);
  return list;
};
window.innerWidth = DEFAULT_MEDIA.width;

class NoopResizeObserver implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
window.ResizeObserver = NoopResizeObserver;

class NoopIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '0px';
  readonly thresholds: ReadonlyArray<number> = [0];
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
window.IntersectionObserver = NoopIntersectionObserver;

// jsdom 29 ships PointerEvent; base-ui and the drawer dispatch it, so a missing class must fail loudly.
if (typeof window.PointerEvent !== 'function') {
  throw new Error('test setup: jsdom must provide PointerEvent (jsdom >= 22)');
}

Element.prototype.scrollIntoView = function scrollIntoView() {};
Element.prototype.hasPointerCapture = function hasPointerCapture() {
  return false;
};
Element.prototype.setPointerCapture = function setPointerCapture() {};
Element.prototype.releasePointerCapture = function releasePointerCapture() {};

configure({ asyncUtilTimeout: 3000 });

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.restoreAllMocks();
  liveQueryLists.clear();
  applyMedia(DEFAULT_MEDIA);
});

afterAll(() => {
  server.close();
});
