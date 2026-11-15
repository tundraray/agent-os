import { z } from 'zod';

/** An empty variable (`NAME=` in `.env`) means "not set": the default applies. */
const unsetWhenEmpty = (value: unknown) => (value === '' ? undefined : value);

const onOff = (fallback: 'on' | 'off') =>
  z.preprocess(unsetWhenEmpty, z.enum(['on', 'off']).default(fallback));

const integer = (fallback: number, min: number) =>
  z.preprocess(
    unsetWhenEmpty,
    z.coerce.number().int().min(min).default(fallback),
  );

/** Runtime settings (design-runtime.md): env names and defaults. */
const RuntimeEnvSchema = z.object({
  RUNTIME_WORKERS: onOff('on'),
  RUNTIME_CONCURRENCY: integer(16, 1),
  RUNTIME_POLL_MS: integer(500, 1),
  RUNTIME_NOTIFY: onOff('on'),
  RUNTIME_LEASE_MS: integer(30_000, 1),
  RUNTIME_HEARTBEAT_MS: integer(10_000, 1),
  RUNTIME_REAPER_MS: integer(5_000, 1),
  RUNTIME_MAX_RECOVERIES: integer(3, 0),
  RUNTIME_STEP_MS: integer(900_000, 1_000),
  RUNTIME_SHUTDOWN_GRACE_MS: integer(5_000, 0),
  RUNTIME_DELIVERY_MAX_ATTEMPTS: integer(5, 1),
  DB_POOL_MAX: integer(10, 1),
  INBOX_PAYLOAD_MAX_BYTES: integer(1_048_576, 1),
  // Passed through unparsed: its only parser is crash-points.ts.
  RUNTIME_CRASH_AT: z.preprocess(unsetWhenEmpty, z.string().optional()),
  // Crash points never fire under `production`; the package itself reads no environment.
  NODE_ENV: z.preprocess(unsetWhenEmpty, z.string().optional()),
});

export interface RuntimeConfig {
  /** `RUNTIME_WORKERS`: `off` starts no workers on this instance. */
  workers: boolean;
  /** `RUNTIME_CONCURRENCY`: steps one instance runs at once. */
  concurrency: number;
  pollMs: number;
  /** `RUNTIME_NOTIFY`: `off` — polling only, no NOTIFY wake-ups or interrupt signals. */
  notify: boolean;
  leaseMs: number;
  heartbeatMs: number;
  reaperMs: number;
  /** `RUNTIME_MAX_RECOVERIES`: losses of one step in a row before the task fails. */
  maxRecoveries: number;
  /** `RUNTIME_STEP_MS`: limit of one step's duration. */
  stepMs: number;
  shutdownGraceMs: number;
  deliveryMaxAttempts: number;
  dbPoolMax: number;
  /** `INBOX_PAYLOAD_MAX_BYTES`: max UTF-8 size of a message payload. */
  inboxPayloadMaxBytes: number;
  /** Raw `<point>[:n]`, unset by default. */
  crashAt: string | undefined;
  /** `NODE_ENV` of the process: `production` disables `crashAt`. */
  nodeEnv: string | undefined;
}

/**
 * Parses Runtime settings from the variables the composition root hands over (ADR-0004: only it
 * reads the environment). Unknown keys are ignored; an invalid value throws, naming the variable.
 * `dbPoolMax` is parsed here too, but the composition root passes it to `createDatabase`.
 */
export function parseRuntimeConfig(
  env: Readonly<Record<string, unknown>>,
): RuntimeConfig {
  const result = RuntimeEnvSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid runtime settings — ${problems.join('; ')}`);
  }
  const s = result.data;
  return {
    workers: s.RUNTIME_WORKERS === 'on',
    concurrency: s.RUNTIME_CONCURRENCY,
    pollMs: s.RUNTIME_POLL_MS,
    notify: s.RUNTIME_NOTIFY === 'on',
    leaseMs: s.RUNTIME_LEASE_MS,
    heartbeatMs: s.RUNTIME_HEARTBEAT_MS,
    reaperMs: s.RUNTIME_REAPER_MS,
    maxRecoveries: s.RUNTIME_MAX_RECOVERIES,
    stepMs: s.RUNTIME_STEP_MS,
    shutdownGraceMs: s.RUNTIME_SHUTDOWN_GRACE_MS,
    deliveryMaxAttempts: s.RUNTIME_DELIVERY_MAX_ATTEMPTS,
    dbPoolMax: s.DB_POOL_MAX,
    inboxPayloadMaxBytes: s.INBOX_PAYLOAD_MAX_BYTES,
    crashAt: s.RUNTIME_CRASH_AT,
    nodeEnv: s.NODE_ENV,
  };
}
