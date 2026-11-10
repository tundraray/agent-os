/**
 * Variables of Runtime Settings (design-runtime.md) that `ResearchModule` hands to
 * `parseRuntimeConfig`: the package reads no environment itself (ADR-0004). `NODE_ENV` belongs
 * here too — without it the runtime cannot tell production, and crash points would stay armed.
 */
const RUNTIME_SETTINGS_VARIABLES = [
  'RUNTIME_WORKERS',
  'RUNTIME_CONCURRENCY',
  'RUNTIME_POLL_MS',
  'RUNTIME_NOTIFY',
  'RUNTIME_LEASE_MS',
  'RUNTIME_HEARTBEAT_MS',
  'RUNTIME_REAPER_MS',
  'RUNTIME_MAX_RECOVERIES',
  'RUNTIME_DELIVERY_MAX_ATTEMPTS',
  'RUNTIME_SHUTDOWN_GRACE_MS',
  'RUNTIME_QUEUE_WAIT_MS',
  'RUNTIME_ATTEMPT_MS',
  'RUNTIME_CRASH_AT',
  'DB_POOL_MAX',
  'NODE_ENV',
] as const;

/** The Runtime Settings variables as `read` (the composition root's environment) sees them. */
export function runtimeSettingsVariables(
  read: (name: string) => string | undefined,
): Record<string, string | undefined> {
  return Object.fromEntries(
    RUNTIME_SETTINGS_VARIABLES.map((name) => [name, read(name)]),
  );
}
