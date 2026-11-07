import { parseRuntimeConfig, type RuntimeConfig } from './runtime-config.js';

// Runtime Settings (design-runtime.md): the composition root hands over a plain object of
// variables instead of `ConfigService` (KD-7); names and defaults stay as they were.
const DEFAULTS: RuntimeConfig = {
  workers: true,
  concurrency: 4,
  pollMs: 500,
  notify: true,
  leaseMs: 30_000,
  heartbeatMs: 10_000,
  reaperMs: 5_000,
  maxRecoveries: 3,
  deliveryMaxAttempts: 5,
  shutdownGraceMs: 5_000,
  queueWaitMs: 600_000,
  attemptMs: 900_000,
  dbPoolMax: 10,
  crashAt: undefined,
  nodeEnv: undefined,
};

describe('parseRuntimeConfig', () => {
  it.each<[string, Record<string, unknown>, RuntimeConfig | RegExp]>([
    ['an empty object gives the defaults of Runtime Settings', {}, DEFAULTS],
    [
      'an empty string means "not set"',
      {
        RUNTIME_WORKERS: '',
        RUNTIME_CONCURRENCY: '',
        RUNTIME_LEASE_MS: '',
        RUNTIME_CRASH_AT: '',
      },
      DEFAULTS,
    ],
    ['RUNTIME_WORKERS=maybe is rejected', { RUNTIME_WORKERS: 'maybe' }, /RUNTIME_WORKERS/],
    ['RUNTIME_CONCURRENCY=0 is rejected', { RUNTIME_CONCURRENCY: '0' }, /RUNTIME_CONCURRENCY/],
    // design-lifecycle.md, Runtime settings: both task limits are integers of at least 1000 ms.
    ['RUNTIME_QUEUE_WAIT_MS=999 is rejected', { RUNTIME_QUEUE_WAIT_MS: '999' }, /RUNTIME_QUEUE_WAIT_MS/],
    ['RUNTIME_ATTEMPT_MS=999 is rejected', { RUNTIME_ATTEMPT_MS: '999' }, /RUNTIME_ATTEMPT_MS/],
    [
      'RUNTIME_QUEUE_WAIT_MS=1000 and RUNTIME_ATTEMPT_MS=1000 are the lowest accepted',
      { RUNTIME_QUEUE_WAIT_MS: '1000', RUNTIME_ATTEMPT_MS: '1000' },
      { ...DEFAULTS, queueWaitMs: 1000, attemptMs: 1000 },
    ],
  ])('%s', (_, env, expected) => {
    if (expected instanceof RegExp) {
      expect(() => parseRuntimeConfig(env)).toThrow(expected);
    } else {
      expect(parseRuntimeConfig(env)).toEqual(expected);
    }
  });
});
