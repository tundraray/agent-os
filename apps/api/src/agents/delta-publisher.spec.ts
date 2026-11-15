import fc from 'fast-check';
import type { Logger } from '@agent-os/common';
import { systemClock } from '@agent-os/runtime';
import { DeltaPublisher } from './delta-publisher.js';

const OWNER_ID = '6f1c1a52-3a43-4a8e-9d0f-2f8f3c1b7a01';
const ROOT_ID = '0b7e4d2c-91a5-4f63-8c1e-5d2a9b3f6e02';
const AGENT_ID = 'c3a9e8f1-7b24-4d0e-a6f5-1e8d2c4b9a03';

interface Published {
  ownerId: string;
  rootId: string;
  agentId: string;
  offset: number;
  text: string;
}

function stubLogger(warn: Logger['warn']): Logger {
  const logger: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

/** A publisher on the fake timers whose `pg_notify` records the raw payloads. */
function setup(notify?: (payload: string) => Promise<void>) {
  const payloads: string[] = [];
  const warn = vi.fn();
  const logger = stubLogger(warn);
  const publisher = new DeltaPublisher({
    notify:
      notify ??
      ((payload) => {
        payloads.push(payload);
        return Promise.resolve();
      }),
    // The real clock: its `setTimeout` is the fake one of vitest.
    clock: systemClock,
    logger,
  });
  const published = (): Published[] =>
    payloads.map((payload) => JSON.parse(payload) as Published);
  return { publisher, payloads, published, warn };
}

function part(offset: number, text: string) {
  return { ownerId: OWNER_ID, rootId: ROOT_ID, agentId: AGENT_ID, offset, text };
}

const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('DeltaPublisher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * KD-3 (design-chat.md): the coalescing rule and the NOTIFY limit.
   * PROPERTY: the published pieces join into the input; each piece's offset is the length of everything
   * published before it; the first part goes out without waiting; each JSON payload is at most 7900
   * UTF-8 bytes and no piece cuts a surrogate pair.
   * FOR ALL: 1–50 parts of one call, 0–3000 units each (ASCII, Cyrillic, emoji, quotes, newlines), with
   * pauses of 0–250 ms between them.
   * SHRINK: fast-check shrinks the array of parts, down to the fewest parts.
   */
  it('DeltaPublisher sends the first part at once and coalesces the rest into chunks below the NOTIFY limit', async () => {
    const unit = fc.oneof(
      fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 1 }),
      fc.constantFrom('а', 'ж', 'я', 'Ё', 'щ'),
      fc.constantFrom('😀', '🧪', '👍🏽', '𝄞'),
      fc.constantFrom('"', '\\', '\n'),
    );
    const step = fc.record({
      pauseMs: fc.integer({ min: 0, max: 250 }),
      text: fc.string({ unit, minLength: 0, maxLength: 3000 }),
    });

    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 50 }),
        async (steps) => {
          const { publisher, payloads, published } = setup();
          let offset = 0;

          for (const [index, { pauseMs, text }] of steps.entries()) {
            if (index > 0) await vi.advanceTimersByTimeAsync(pauseMs);
            publisher.publish(part(offset, text));
            offset += text.length;
            if (index === 0) {
              await vi.advanceTimersByTimeAsync(0);
              expect(published().map((piece) => piece.text).join('')).toBe(
                text,
              );
            }
          }
          await vi.advanceTimersByTimeAsync(1000);
          publisher.onModuleDestroy();

          const input = steps.map(({ text }) => text).join('');
          const pieces = published();
          expect(pieces.map((piece) => piece.text).join('')).toBe(input);
          let publishedLength = 0;
          for (const piece of pieces) {
            expect(piece.offset).toBe(publishedLength);
            expect(piece.text).not.toMatch(LONE_SURROGATE);
            expect([piece.ownerId, piece.rootId, piece.agentId]).toEqual([
              OWNER_ID,
              ROOT_ID,
              AGENT_ID,
            ]);
            publishedLength += piece.text.length;
          }
          for (const payload of payloads) {
            expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(7900);
          }
        },
      ),
    );
  });

  it('drops the unsent parts and starts over when a part with offset 0 arrives within the window (a retry)', async () => {
    const { publisher, published } = setup();

    publisher.publish(part(0, 'Hel'));
    publisher.publish(part(3, 'lo'));
    publisher.publish(part(0, 'Retry'));
    await vi.advanceTimersByTimeAsync(50);
    publisher.publish(part(5, 'ing'));
    await vi.advanceTimersByTimeAsync(500);

    expect(published()).toEqual([
      part(0, 'Hel'),
      part(0, 'Retry'),
      part(5, 'ing'),
    ]);
  });

  it('logs a warn with the agent id and keeps publishing when pg_notify fails', async () => {
    const sent: string[] = [];
    const notify = vi
      .fn<(payload: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockImplementation((payload) => {
        sent.push(payload);
        return Promise.resolve();
      });
    const { publisher, warn } = setup(notify);

    expect(() => publisher.publish(part(0, 'lost'))).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    publisher.publish(part(4, ' kept'));
    await vi.advanceTimersByTimeAsync(500);

    expect(warn).toHaveBeenCalledWith('text delta notify failed', {
      agentId: AGENT_ID,
      error: 'connection lost',
    });
    expect(sent.map((payload) => JSON.parse(payload) as Published)).toEqual([
      part(4, ' kept'),
    ]);
  });
});
