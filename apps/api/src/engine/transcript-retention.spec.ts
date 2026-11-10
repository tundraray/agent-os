import type { TranscriptRetention } from '@agent-os/engine';
import type { Clock } from '@agent-os/runtime';
import {
  parseTranscriptRetention,
  startTranscriptPurge,
} from './transcript-retention.js';

// UC-3, AC-01.4, DC-4. Risk: a deployment without the variable keeps transcripts on a wrong term; an invalid term
// starts the server instead of stopping it, or the error does not name the variable.
describe('parseTranscriptRetention - TRANSCRIPT_RETENTION_DAYS', () => {
  it.each<[string, Record<string, string>, number]>([
    ['unset', {}, 30],
    ['empty', { TRANSCRIPT_RETENTION_DAYS: '' }, 30],
    ['1', { TRANSCRIPT_RETENTION_DAYS: '1' }, 1],
    ['90', { TRANSCRIPT_RETENTION_DAYS: '90' }, 90],
  ])('takes the term when %s', (_, env, days) => {
    expect(parseTranscriptRetention((name) => env[name])).toEqual({ days });
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc'], ['1e2'], [' 7']])(
    'stops the start naming the variable for "%s"',
    (value) => {
      const env: Record<string, string> = { TRANSCRIPT_RETENTION_DAYS: value };

      expect(() => parseTranscriptRetention((name) => env[name])).toThrow(
        /TRANSCRIPT_RETENTION_DAYS/,
      );
    },
  );
});

interface FakeTimer {
  readonly ms: number;
  readonly fire: () => void;
  cancelled: boolean;
}

function fakeClock() {
  const timers: FakeTimer[] = [];
  const clock: Clock = {
    now: () => new Date('2026-11-07T12:00:00Z'),
    random: () => 0,
    setTimer: (ms, callback) => {
      const timer: FakeTimer = { ms, fire: callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return { clock, timers };
}

const HOUR_MS = 3_600_000;

type Purge = (retention: TranscriptRetention) => Promise<number>;

/** Lets a purge pass in flight settle, so the timer it arms afterwards is there. */
const settled = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** Fires the latest armed timer and lets the purge it started settle. */
async function fireLatest(timers: FakeTimer[]): Promise<void> {
  const timer = timers.at(-1);
  if (timer === undefined || timer.cancelled) {
    throw new Error('no armed timer');
  }
  timer.fire();
  await settled();
}

// AC-01.4, DC-4 (half of the hour). Risk: the term is not the configured one; the first pass waits an hour, so frequent
// restarts never purge; a failed purge stops the schedule; the timer keeps firing after the application stops, against
// a closed pool.
describe('startTranscriptPurge', () => {
  it('purges once at the start, without waiting the interval', async () => {
    const { clock, timers } = fakeClock();
    const purge = vi.fn<Purge>().mockResolvedValue(1);
    const retention = { days: 7 };

    const scheduler = startTranscriptPurge({ clock, retention, purge });

    // Before any timer: the pass is in flight already, and the hourly timer is armed only once it has settled.
    expect(purge.mock.calls).toEqual([[retention]]);
    expect(timers).toEqual([]);
    await settled();
    expect(timers.map((timer) => timer.ms)).toEqual([HOUR_MS]);
    await scheduler.stop();
  });

  it('calls the purge at the start and then every hour with the configured term', async () => {
    const { clock, timers } = fakeClock();
    const purge = vi.fn<Purge>().mockResolvedValue(2);
    const retention = { days: 7 };

    const scheduler = startTranscriptPurge({ clock, retention, purge });
    await settled();
    await fireLatest(timers);
    await fireLatest(timers);
    await fireLatest(timers);

    expect(timers.map((timer) => timer.ms)).toEqual([
      HOUR_MS,
      HOUR_MS,
      HOUR_MS,
      HOUR_MS,
    ]);
    expect(purge.mock.calls).toEqual([
      [retention],
      [retention],
      [retention],
      [retention],
    ]);
    await scheduler.stop();
  });

  it('keeps the hourly schedule after a failed purge', async () => {
    const { clock, timers } = fakeClock();
    const purge = vi
      .fn<Purge>()
      .mockResolvedValue(0)
      .mockRejectedValueOnce(new Error('connection lost'));

    const scheduler = startTranscriptPurge({
      clock,
      retention: { days: 30 },
      purge,
    });
    // The start pass fails; the hour after it still runs, and the one after that.
    await settled();
    await fireLatest(timers);
    await fireLatest(timers);

    expect(purge).toHaveBeenCalledTimes(3);
    await scheduler.stop();
  });

  it.each<[string, number]>([
    ['before the first hour', 0],
    ['after two hours', 2],
  ])('makes no call after stop %s', async (_, hoursBeforeStop) => {
    const { clock, timers } = fakeClock();
    const purge = vi.fn<Purge>().mockResolvedValue(0);
    const scheduler = startTranscriptPurge({
      clock,
      retention: { days: 30 },
      purge,
    });
    await settled();
    for (let hour = 0; hour < hoursBeforeStop; hour += 1) {
      await fireLatest(timers);
    }

    await scheduler.stop();

    expect(timers.at(-1)?.cancelled).toBe(true);
    // The start pass, then one per hour fired.
    expect(purge).toHaveBeenCalledTimes(hoursBeforeStop + 1);
  });

  it('waits for the purge in flight before stop resolves', async () => {
    const { clock, timers } = fakeClock();
    let finish: (count: number) => void = () => undefined;
    const purge = vi.fn<Purge>(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    // The start pass is the one in flight.
    const scheduler = startTranscriptPurge({
      clock,
      retention: { days: 30 },
      purge,
    });

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await settled();
    expect(stopped).toBe(false);
    finish(1);
    await stopping;

    expect(stopped).toBe(true);
    // Stopped while the pass ran: no timer is armed after it.
    expect(timers).toEqual([]);
  });
});
