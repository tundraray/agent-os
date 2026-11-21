import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setUnauthorizedHandler } from '@/lib/api/api-request';
import { currentUser } from '@/test/fixtures';
import { createTestLiveSource } from '@/test/live-source';
import { server } from '@/test/msw-server';
import { createAnnouncerStore } from './announcer-store';
import { createLiveStore } from './live-store';

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.useRealTimers();
});

// DC-13: a stream shows no status code, so a stream that closed for good asks the session before reopening.
describe('LiveStore — closed stream probes the session (DC-13)', () => {
  it.each([
    { status: 401, handlerCalls: [['AUTH_REQUIRED']], sourcesOpened: 1 },
    { status: 200, handlerCalls: [], sourcesOpened: 2 },
  ])(
    'a closed stream asks GET /api/auth/me; 401 goes to the handler, 200 reopens (status $status)',
    async ({ status, handlerCalls, sourcesOpened }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const probe = vi.fn();
      server.use(
        http.get('/api/auth/me', () => {
          probe();
          return status === 401
            ? HttpResponse.json(
                { statusCode: 401, message: 'Unauthorized', errorCode: 'AUTH_REQUIRED' },
                { status: 401 },
              )
            : HttpResponse.json(currentUser());
        }),
      );
      const unauthorized = vi.fn();
      setUnauthorizedHandler(unauthorized);
      const source = createTestLiveSource();
      const live = createLiveStore({ openEventSource: source.open, announcer: createAnnouncerStore(), logger: { warn: vi.fn() } });

      void live.watch(null);
      source.fail({ closed: true });

      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(unauthorized.mock.calls).toEqual(handlerCalls));
      // The reopen is scheduled only once the probe settles: keep moving the clock until it shows.
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(2000);
        expect(source.opened).toHaveLength(sourcesOpened);
      });
      live.dispose();
    },
  );
});
