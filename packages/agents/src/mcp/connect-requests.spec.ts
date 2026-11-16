// design-mcp-connect.md DC-5, Invariant 5, UC-E2: a connection request is taken once, within
// 10 minutes and only by the employee who began it; any take of a known `state` removes it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectRequests } from './connect-requests.js';

const OPENED_AT = new Date('2026-11-16T10:00:00.000Z');
const TEN_MINUTES_MS = 10 * 60 * 1000;

function at(offsetMs: number): Date {
  return new Date(OPENED_AT.getTime() + offsetMs);
}

const ANNA = 'user-anna';
const BORIS = 'user-boris';

describe('ConnectRequests', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(OPENED_AT);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    {
      name: 'its owner within 10 minutes',
      state: 'own',
      ownerId: ANNA,
      now: at(TEN_MINUTES_MS),
      taken: true,
    },
    {
      name: 'its owner 10 minutes 1 second later',
      state: 'own',
      ownerId: ANNA,
      now: at(TEN_MINUTES_MS + 1000),
      taken: false,
    },
    { name: 'another employee', state: 'own', ownerId: BORIS, now: at(1000), taken: false },
    { name: 'an unknown state', state: 'unknown', ownerId: ANNA, now: at(1000), taken: false },
  ])(
    'a connection request is taken once, within 10 minutes and only by the employee who began it: $name',
    ({ state, ownerId, now, taken }) => {
      const requests = new ConnectRequests();
      const opened = requests.open({
        ownerId: ANNA,
        server: 'sentry',
        target: 'employee',
        codeVerifier: 'verifier',
        redirectUrl: 'https://agent-os.test/api/mcp/oauth/callback',
        issuer: 'https://auth.sentry.test',
      });
      const presented = state === 'own' ? opened.state : 'not-a-state';

      const first = requests.take(presented, ownerId, now);

      if (taken) {
        expect(first).toMatchObject({
          id: opened.id,
          ownerId: ANNA,
          server: 'sentry',
          codeVerifier: 'verifier',
        });
      } else {
        expect(first).toBeUndefined();
      }
      // A replay finds nothing: after a foreign or late attempt even Anna in time gets nothing.
      expect(requests.take(presented, ANNA, at(1000))).toBeUndefined();
    },
  );
});
