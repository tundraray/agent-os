import { parseRuntimeConfig, type RuntimeConfig } from './runtime-config.js';

// Runtime settings (design-runtime.md): the composition root hands over a plain object of
// variables; an invalid value stops the start, naming the variable.
const DEFAULTS: RuntimeConfig = {
  workers: true,
  concurrency: 16,
  pollMs: 500,
  notify: true,
  leaseMs: 30_000,
  heartbeatMs: 10_000,
  reaperMs: 5_000,
  maxRecoveries: 3,
  stepMs: 900_000,
  shutdownGraceMs: 5_000,
  deliveryMaxAttempts: 5,
  dbPoolMax: 10,
  inboxPayloadMaxBytes: 1_048_576,
  crashAt: undefined,
  nodeEnv: undefined,
};

describe('parseRuntimeConfig', () => {
  it.each<[string, Record<string, unknown>, RuntimeConfig | RegExp]>([
    ['an empty object gives the defaults of Runtime settings', {}, DEFAULTS],
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
    // The step limit is an integer of at least 1000 ms.
    ['RUNTIME_STEP_MS=999 is rejected', { RUNTIME_STEP_MS: '999' }, /RUNTIME_STEP_MS/],
    [
      'INBOX_PAYLOAD_MAX_BYTES=0 is rejected',
      { INBOX_PAYLOAD_MAX_BYTES: '0' },
      /INBOX_PAYLOAD_MAX_BYTES/,
    ],
    [
      'RUNTIME_STEP_MS=1000 and INBOX_PAYLOAD_MAX_BYTES=1 are the lowest accepted',
      { RUNTIME_STEP_MS: '1000', INBOX_PAYLOAD_MAX_BYTES: '1' },
      { ...DEFAULTS, stepMs: 1000, inboxPayloadMaxBytes: 1 },
    ],
  ])('%s', (_, env, expected) => {
    if (expected instanceof RegExp) {
      expect(() => parseRuntimeConfig(env)).toThrow(expected);
    } else {
      expect(parseRuntimeConfig(env)).toEqual(expected);
    }
  });
});
