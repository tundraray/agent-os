import { z } from 'zod';

/** Variables of design-mcp-source.md, Settings, as the assembly point read them; other keys are ignored. */
export type SourcesEnv = Readonly<Record<string, string | undefined>>;

export interface FixtureSettings {
  readonly dataset: 'v1' | 'v2';
  readonly faultsPath: string | null;
  readonly callLogPath: string | null;
}

export interface SourcesSettings {
  /** Call and snapshot-read timeout before the deadline caps it. */
  readonly callTimeoutMs: number;
  /** Full jitter: a random delay in [0, min(retryCapMs, retryBaseMs × 2^n)]. */
  readonly retryBaseMs: number;
  readonly retryCapMs: number;
  readonly maxPages: number;
  readonly fixture: FixtureSettings;
}

const milliseconds = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const SourcesEnvSchema = z
  .object({
    SOURCE_CALL_TIMEOUT_MS: milliseconds(30_000),
    SOURCE_RETRY_BASE_MS: milliseconds(200),
    SOURCE_RETRY_CAP_MS: milliseconds(5_000),
    SOURCE_MAX_PAGES: z.coerce.number().int().positive().default(1_000),
    FIXTURE_DATASET: z.enum(['v1', 'v2']).default('v1'),
    FIXTURE_FAULTS: z.string().optional(),
    FIXTURE_CALL_LOG: z.string().optional(),
  })
  .refine((env) => env.FIXTURE_FAULTS === undefined || env.FIXTURE_CALL_LOG !== undefined, {
    message: 'FIXTURE_FAULTS requires FIXTURE_CALL_LOG: fault occurrences are counted by the call log',
    path: ['FIXTURE_CALL_LOG'],
  })
  .transform(
    (env): SourcesSettings => ({
      callTimeoutMs: env.SOURCE_CALL_TIMEOUT_MS,
      retryBaseMs: env.SOURCE_RETRY_BASE_MS,
      retryCapMs: env.SOURCE_RETRY_CAP_MS,
      maxPages: env.SOURCE_MAX_PAGES,
      fixture: {
        dataset: env.FIXTURE_DATASET,
        faultsPath: env.FIXTURE_FAULTS ?? null,
        callLogPath: env.FIXTURE_CALL_LOG ?? null,
      },
    }),
  );

/**
 * Parses the settings from the object the assembly point passes (ADR-0004: only assembly points read the
 * environment). An empty value counts as unset. Invalid values throw.
 */
export function parseSourcesSettings(env: SourcesEnv): SourcesSettings {
  const setValues = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  return SourcesEnvSchema.parse(setValues);
}
