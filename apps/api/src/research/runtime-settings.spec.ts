import { parseRuntimeConfig, type RuntimeConfig } from '@agent-os/runtime';
import { runtimeSettingsVariables } from './runtime-settings.js';

// Risk: a variable of Runtime Settings that the composition root does not hand over silently
// falls back to its default — `NODE_ENV` above all: without it crash points stay armed in
// production. Each row sets one variable to a non-default value and expects it in the config.
describe('runtimeSettingsVariables', () => {
  it.each<[string, string, keyof RuntimeConfig, unknown]>([
    ['RUNTIME_WORKERS', 'off', 'workers', false],
    ['RUNTIME_CONCURRENCY', '7', 'concurrency', 7],
    ['RUNTIME_POLL_MS', '70', 'pollMs', 70],
    ['RUNTIME_NOTIFY', 'off', 'notify', false],
    ['RUNTIME_LEASE_MS', '7000', 'leaseMs', 7000],
    ['RUNTIME_HEARTBEAT_MS', '700', 'heartbeatMs', 700],
    ['RUNTIME_REAPER_MS', '770', 'reaperMs', 770],
    ['RUNTIME_MAX_RECOVERIES', '7', 'maxRecoveries', 7],
    ['RUNTIME_DELIVERY_MAX_ATTEMPTS', '7', 'deliveryMaxAttempts', 7],
    ['RUNTIME_SHUTDOWN_GRACE_MS', '777', 'shutdownGraceMs', 777],
    ['RUNTIME_QUEUE_WAIT_MS', '7777', 'queueWaitMs', 7777],
    ['RUNTIME_ATTEMPT_MS', '77777', 'attemptMs', 77777],
    [
      'RUNTIME_CRASH_AT',
      'dispatch.after-claim',
      'crashAt',
      'dispatch.after-claim',
    ],
    ['DB_POOL_MAX', '7', 'dbPoolMax', 7],
    ['NODE_ENV', 'production', 'nodeEnv', 'production'],
  ])(
    'passes %s=%s through to RuntimeConfig.%s',
    (name, value, field, expected) => {
      const env: Record<string, string> = { [name]: value };

      const config = parseRuntimeConfig(
        runtimeSettingsVariables((variable) => env[variable]),
      );

      expect(config[field]).toBe(expected);
    },
  );
});
