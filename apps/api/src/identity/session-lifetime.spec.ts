import { isSessionExpired } from './session-lifetime';

const NOW = new Date('2026-11-15T12:00:00.000Z');
const MINUTE_MS = 60_000;

/** The moment `minutes` (plus `extraMs`) before NOW. */
const ago = (minutes: number, extraMs = 0): Date =>
  new Date(NOW.getTime() - minutes * MINUTE_MS - extraMs);

// DC-2, AC-07.5: a session ends after the idle limit or the absolute limit, whichever comes first.
describe('a session expires by idle or absolute limit, whichever comes first', () => {
  it.each([
    // idle, absolute, created (min ago, extra ms), last request (min ago, extra ms), expired
    {
      idle: 480,
      absolute: 1440,
      created: [600, 0],
      lastSeen: [480, 0],
      expired: false,
    },
    {
      idle: 480,
      absolute: 1440,
      created: [600, 0],
      lastSeen: [480, 1],
      expired: true,
    },
    {
      idle: 480,
      absolute: 1440,
      created: [1440, 0],
      lastSeen: [0, 0],
      expired: false,
    },
    {
      idle: 480,
      absolute: 1440,
      created: [1440, 1],
      lastSeen: [0, 0],
      expired: true,
    },
    {
      idle: 30,
      absolute: 61,
      created: [40, 0],
      lastSeen: [30, 0],
      expired: false,
    },
    {
      idle: 30,
      absolute: 61,
      created: [40, 0],
      lastSeen: [30, 1],
      expired: true,
    },
    {
      idle: 30,
      absolute: 61,
      created: [61, 0],
      lastSeen: [1, 0],
      expired: false,
    },
    {
      idle: 30,
      absolute: 61,
      created: [61, 1],
      lastSeen: [1, 0],
      expired: true,
    },
  ])(
    'idle $idle, absolute $absolute, created $created, last request $lastSeen -> expired $expired',
    ({ idle, absolute, created, lastSeen, expired }) => {
      const times = {
        createdAt: ago(created[0]!, created[1]),
        lastSeenAt: ago(lastSeen[0]!, lastSeen[1]),
      };

      expect(
        isSessionExpired(
          times,
          { idleMinutes: idle, absoluteMinutes: absolute },
          NOW,
        ),
      ).toBe(expired);
    },
  );
});
