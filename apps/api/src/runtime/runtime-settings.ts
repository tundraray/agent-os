import { parseRuntimeConfig, type RuntimeConfig } from '@agent-os/runtime';

/** The variables of Runtime settings (design-runtime.md) plus `NODE_ENV`, which turns crash points off in production. */
const RUNTIME_VARIABLES = [
  'RUNTIME_WORKERS',
  'RUNTIME_CONCURRENCY',
  'RUNTIME_POLL_MS',
  'RUNTIME_NOTIFY',
  'RUNTIME_LEASE_MS',
  'RUNTIME_HEARTBEAT_MS',
  'RUNTIME_REAPER_MS',
  'RUNTIME_MAX_RECOVERIES',
  'RUNTIME_STEP_MS',
  'RUNTIME_SHUTDOWN_GRACE_MS',
  'RUNTIME_DELIVERY_MAX_ATTEMPTS',
  'RUNTIME_CRASH_AT',
  'DB_POOL_MAX',
  'INBOX_PAYLOAD_MAX_BYTES',
  'NODE_ENV',
] as const;

/**
 * Reads the runtime settings through `read` (the application's environment) and parses them with
 * `parseRuntimeConfig` (ADR-0004: only `apps/api` reads the environment). An unset or empty variable
 * takes its default; an invalid value throws, naming the variable, which stops the start.
 */
export function readRuntimeSettings(
  read: (name: string) => string | undefined,
): RuntimeConfig {
  return parseRuntimeConfig(
    Object.fromEntries(RUNTIME_VARIABLES.map((name) => [name, read(name)])),
  );
}
