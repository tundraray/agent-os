import type { LogFields, Logger, LogLevel } from '@agent-os/common';
import { screen } from '@testing-library/react';
import type { SetupServer } from 'msw/node';
import { afterEach, expect, onTestFinished, vi, type Mock } from 'vitest';

// Test support of the admin panel's integration tests (design-admin.md, Test Strategy). This module must not import
// `@/lib/logger`: the logger mock below loads it from inside `vi.mock('@/lib/logger', ...)`.

// ---------------------------------------------------------------------------------------------------
// Requests

/** A request as the page sent it; `body` is the parsed JSON (text when not JSON, `null` without a body). */
export type RecordedRequest = {
  method: string;
  path: string;
  /** '' or '?…', as in `URL.search`. */
  search: string;
  /** Filled from a copy of the request as soon as it is read, before the response reaches the page. */
  body: unknown;
};

export type TrackedRequests = {
  /** Every request in the order it started, handled or not. */
  requests: readonly RecordedRequest[];
  /** How many of them went to `/api/admin/*`. */
  adminCount: () => number;
};

const ADMIN_PATH = /^\/api\/admin(\/|$)/;

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === '') return null;
  return request.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
}

/**
 * Records every request the page starts during the current test. It listens to MSW's `request:start`, which also fires
 * for a request without a handler: a screen could swallow the unhandled-request error, the counter still sees it.
 */
export function trackRequests(server: SetupServer): TrackedRequests {
  const requests: RecordedRequest[] = [];
  const listener = ({ request }: { request: Request }): void => {
    const url = new URL(request.url);
    const entry: RecordedRequest = { method: request.method, path: url.pathname, search: url.search, body: null };
    requests.push(entry);
    if (request.body !== null) {
      void readBody(request.clone()).then((body) => {
        entry.body = body;
      });
    }
  };
  server.events.on('request:start', listener);
  onTestFinished(() => {
    server.events.removeListener('request:start', listener);
  });
  return { requests, adminCount: () => requests.filter((request) => ADMIN_PATH.test(request.path)).length };
}

// ---------------------------------------------------------------------------------------------------
// Logger stand-in

export type LogEntry = { level: LogLevel; message: string; fields: LogFields };

const entries: LogEntry[] = [];

/** What the code under test wrote through `logger.*` during the current test. */
export const logRecords: readonly LogEntry[] = entries;

afterEach(() => {
  entries.length = 0;
});

function recordingLogger(bound: LogFields): Logger {
  const at =
    (level: LogLevel) =>
    (message: string, fields?: LogFields): void => {
      entries.push({ level, message, fields: { ...bound, ...fields } });
    };
  return {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (fields) => recordingLogger({ ...bound, ...fields }),
  };
}

/**
 * Replacement of `@/lib/logger`, the web app's only log module (Sentry and console behind it):
 * `vi.mock('@/lib/logger', async () => (await import('@/test/admin-support')).loggerModule)`.
 */
export const loggerModule: typeof import('@/lib/logger') = { logger: recordingLogger({}) };

/** Every string inside a log record, Error messages, stacks and causes included. */
function stringsOf(value: unknown, out: string[], seen: WeakSet<object>): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (value instanceof Error) {
    out.push(value.name, value.message, value.stack ?? '');
    stringsOf(value.cause, out, seen);
  }
  for (const item of Object.values(value)) stringsOf(item, out, seen);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Secrets

type NowhereOptions = {
  /** The label of the one field allowed to still hold the value (a secret field after a refused save keeps what was typed). */
  exceptInput?: string;
  /** Spies whose call arguments are swept too: the router's `push` / `replace` and `location.assign`. */
  spies?: ReadonlyArray<{ mock: { calls: ReadonlyArray<readonly unknown[]> } }>;
};

/**
 * Asserts that `value` appears nowhere the page or its logs keep it: the document's markup (text and every
 * attribute, toasts and the announcer included), the value of every input and textarea, `document.title`, the
 * tab's address, both web storages, the logger stand-in's records and the arguments the `spies` were called with.
 */
export function expectNowhere(value: string, { exceptInput, spies = [] }: NowhereOptions = {}): void {
  expect(value, 'expectNowhere needs a non-empty value').not.toBe('');
  expect(document.title, 'document.title').not.toContain(value);
  expect(window.location.href, 'the address').not.toContain(value);

  const allowed = exceptInput === undefined ? null : screen.getByLabelText(exceptInput);
  // React mirrors a field's value into its `value` attribute, so the allowed field is cut out of the markup.
  const markup = document.documentElement.outerHTML;
  expect(allowed === null ? markup : markup.replace(allowed.outerHTML, ''), 'document markup').not.toContain(value);
  for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')) {
    if (field === allowed) continue;
    const name = field.getAttribute('aria-label') ?? (field.id || field.name);
    expect(field.value, `value of the field «${name}»`).not.toContain(value);
  }

  for (const [name, storage] of [['localStorage', localStorage], ['sessionStorage', sessionStorage]] as const) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) ?? '';
      expect(`${key}=${storage.getItem(key)}`, name).not.toContain(value);
    }
  }

  for (const record of logRecords) {
    for (const text of stringsOf(record, [], new WeakSet())) {
      expect(text, `log record «${record.message}»`).not.toContain(value);
    }
  }

  for (const spy of spies) {
    for (const text of stringsOf(spy.mock.calls, [], new WeakSet())) {
      expect(text, 'arguments of a navigation').not.toContain(value);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Clipboard

/**
 * Puts a spy at `navigator.clipboard.writeText` (jsdom has no clipboard). Call it after `userEvent.setup()`, which
 * installs its own clipboard on `navigator`.
 */
export function stubClipboard(): Mock<Clipboard['writeText']> {
  const writeText = vi.fn<Clipboard['writeText']>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}
