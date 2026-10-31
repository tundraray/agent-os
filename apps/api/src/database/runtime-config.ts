import type { ConfigService } from '@nestjs/config';
import { z } from 'zod';

/** DI token of the parsed {@link RuntimeConfig}. */
export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');

/** An empty variable (`NAME=` in `.env`) means "not set": the default applies. */
const unsetWhenEmpty = (value: unknown) => (value === '' ? undefined : value);

const onOff = (fallback: 'on' | 'off') =>
  z.preprocess(unsetWhenEmpty, z.enum(['on', 'off']).default(fallback));

const integer = (fallback: number, min: number) =>
  z.preprocess(
    unsetWhenEmpty,
    z.coerce.number().int().min(min).default(fallback),
  );

/** Runtime Settings (design-runtime.md): env names and defaults. */
const RuntimeEnvSchema = z.object({
  RUNTIME_WORKERS: onOff('on'),
  RUNTIME_CONCURRENCY: integer(4, 1),
  RUNTIME_POLL_MS: integer(500, 1),
  RUNTIME_NOTIFY: onOff('on'),
  RUNTIME_LEASE_MS: integer(30_000, 1),
  RUNTIME_HEARTBEAT_MS: integer(10_000, 1),
  RUNTIME_REAPER_MS: integer(5_000, 1),
  RUNTIME_MAX_RECOVERIES: integer(3, 0),
  RUNTIME_DELIVERY_MAX_ATTEMPTS: integer(5, 1),
  RUNTIME_SHUTDOWN_GRACE_MS: integer(5_000, 0),
  DB_POOL_MAX: integer(10, 1),
  // Passed through unparsed: its only parser is research/crash-points.ts.
  RUNTIME_CRASH_AT: z.preprocess(unsetWhenEmpty, z.string().optional()),
});

const RUNTIME_ENV_NAMES = Object.keys(
  RuntimeEnvSchema.shape,
) as (keyof typeof RuntimeEnvSchema.shape)[];

export interface RuntimeConfig {
  /** `RUNTIME_WORKERS`: `off` starts no workers (chat e2e). */
  workers: boolean;
  concurrency: number;
  pollMs: number;
  /** `RUNTIME_NOTIFY`: `off` — polling only. */
  notify: boolean;
  leaseMs: number;
  heartbeatMs: number;
  reaperMs: number;
  maxRecoveries: number;
  deliveryMaxAttempts: number;
  shutdownGraceMs: number;
  dbPoolMax: number;
  /** Raw `<point>[:n]`, unset by default. */
  crashAt: string | undefined;
}

/** Parses Runtime Settings; an invalid value throws, naming the variable. */
function parseRuntimeConfig(
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
    deliveryMaxAttempts: s.RUNTIME_DELIVERY_MAX_ATTEMPTS,
    shutdownGraceMs: s.RUNTIME_SHUTDOWN_GRACE_MS,
    dbPoolMax: s.DB_POOL_MAX,
    crashAt: s.RUNTIME_CRASH_AT,
  };
}

/** Reads Runtime Settings through `ConfigService` (process env first, then `apps/api/.env`). */
export function loadRuntimeConfig(config: ConfigService): RuntimeConfig {
  return parseRuntimeConfig(
    Object.fromEntries(
      RUNTIME_ENV_NAMES.map((name) => [name, config.get<string>(name)]),
    ),
  );
}
