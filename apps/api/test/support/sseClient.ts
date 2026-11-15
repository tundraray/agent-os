import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';

/**
 * A small SSE client for `GET /api/events` (EventSource is a browser API): a raw HTTP request with
 * `x-user-id`, the `event:` / `data:` / `retry:` lines parsed into events, every event recorded with its
 * arrival time, and waits for "the next event of type X" with a bound. The test closes it.
 */

/** Bound of a wait for an event when the test names none. */
const DEFAULT_WAIT_MS = 30_000;

/** One received event: `type` is the SSE event name, `data` its JSON body. */
export interface SseEvent {
  readonly type: string;
  readonly data: unknown;
  /** The `retry:` hint sent with the event; null when none. */
  readonly retry: number | null;
  /** `Date.now()` when the event was parsed. */
  readonly receivedAt: number;
}

export interface SseStream {
  /** Every event received so far, in order. */
  readonly events: readonly SseEvent[];
  /**
   * The next event of `type` not yet returned by `next` for that type (it may have arrived already);
   * fails after `timeoutMs`.
   */
  next(type: string, timeoutMs?: number): Promise<SseEvent>;
  /** Resolves once `done` holds for the received events; fails after `timeoutMs`. */
  until(done: (events: readonly SseEvent[]) => boolean, what: string, timeoutMs?: number): Promise<void>;
  /** Closes the connection from the client side. */
  close(): void;
}

/** One SSE block (the lines between blank lines); null for a block with only comments. */
function parseBlock(block: string, receivedAt: number): SseEvent | null {
  let type: string | undefined;
  let retry: number | null = null;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') type = value;
    else if (field === 'data') dataLines.push(value);
    else if (field === 'retry') retry = Number(value);
  }
  if (type === undefined && dataLines.length === 0) return null;
  const raw = dataLines.join('\n');
  let data: unknown = raw;
  try {
    data = dataLines.length === 0 ? null : JSON.parse(raw);
  } catch {
    // Not JSON: kept as the raw text.
  }
  return { type: type ?? 'message', data, retry, receivedAt };
}

/** The port the app listens on; the test makes it listen (`app.listen(0, '127.0.0.1')`) before streams open. */
function portOf(app: INestApplication<App>): number {
  const address = (app.getHttpServer() as Server).address();
  if (address === null || typeof address === 'string') {
    throw new Error('The app does not listen on a TCP port: call app.listen(0, "127.0.0.1") first');
  }
  return (address as AddressInfo).port;
}

/**
 * Opens `GET /api/events` as `ownerId` (with `watch` when given) and resolves once the response
 * headers arrived with status 200.
 */
export function openStream(
  app: INestApplication<App>,
  ownerId: string,
  watch?: string,
): Promise<SseStream> {
  const events: SseEvent[] = [];
  const listeners = new Set<() => void>();
  const cursors = new Map<string, number>();
  let ended = false;

  const notify = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  function waitUntil<T>(check: () => T | undefined, what: string, timeoutMs: number): Promise<T> {
    const found = check();
    if (found !== undefined) return Promise.resolve(found);
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(listener);
      };
      const listener = () => {
        const value = check();
        if (value === undefined) return;
        cleanup();
        resolve(value);
      };
      const timer = setTimeout(() => {
        cleanup();
        const received = events.map((event) => event.type).join(', ');
        reject(
          new Error(
            `Timed out after ${timeoutMs} ms waiting for ${what}; stream ${ended ? 'ended' : 'open'}, received: [${received}]`,
          ),
        );
      }, timeoutMs);
      listeners.add(listener);
    });
  }

  const path = watch === undefined ? '/api/events' : `/api/events?watch=${encodeURIComponent(watch)}`;
  return new Promise<SseStream>((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: portOf(app),
        path,
        method: 'GET',
        headers: { 'x-user-id': ownerId, accept: 'text/event-stream' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`GET ${path} answered ${response.statusCode}`));
          return;
        }
        let buffer = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          buffer += chunk;
          buffer = buffer.replace(/\r\n/g, '\n');
          let end = buffer.indexOf('\n\n');
          while (end !== -1) {
            const event = parseBlock(buffer.slice(0, end), Date.now());
            buffer = buffer.slice(end + 2);
            if (event !== null) events.push(event);
            end = buffer.indexOf('\n\n');
          }
          notify();
        });
        response.on('end', () => {
          ended = true;
          notify();
        });
        response.on('error', () => {
          ended = true;
          notify();
        });
        resolve({
          events,
          next(type, timeoutMs = DEFAULT_WAIT_MS) {
            return waitUntil(
              () => {
                for (let index = cursors.get(type) ?? 0; index < events.length; index += 1) {
                  const event = events[index];
                  if (event?.type === type) {
                    cursors.set(type, index + 1);
                    return event;
                  }
                }
                return undefined;
              },
              `the next "${type}" event`,
              timeoutMs,
            );
          },
          until(done, what, timeoutMs = DEFAULT_WAIT_MS) {
            return waitUntil(() => (done(events) ? true : undefined), what, timeoutMs).then(() => undefined);
          },
          close() {
            req.destroy();
          },
        });
      },
    );
    // A client-side close also ends the request with an error; only a failure before the response counts.
    req.on('error', (error) => {
      ended = true;
      notify();
      reject(error);
    });
    req.end();
  });
}
