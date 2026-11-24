/**
 * Vitest settings shared by the Node workspaces (`apps/web` tests React in jsdom and keeps its own
 * config). No imports: the repository root has no dependencies of its own, so each workspace config
 * passes these plain objects to its own `defineConfig`.
 */

/** Unit tests: next to the source, no services. */
export const unit = { test: { globals: true, include: ['src/**/*.spec.ts'] } };

/**
 * Suites on a real Postgres or real child processes. One file at a time: parallel files share the
 * database and the process table, and would deliver, requeue, count or measure each other's work.
 */
function serial<T extends object>(include: string, extra: T) {
  return {
    test: {
      globals: true,
      include: [include],
      fileParallelism: false,
      ...extra,
    },
  };
}

/** `test:e2e`: the integration suites. */
export const e2e = <T extends object>(extra: T) =>
  serial('test/**/*.e2e-spec.ts', extra);

/** `test:verify`: on-demand measurements, kept out of the regular suites so a slow machine never turns them red. */
export const verify = <T extends object>(extra: T) =>
  serial('test/verify/**/*.verify.ts', extra);

/** Applies the migrations once before the suite, through `applyMigrations` of `@agent-os/db`. */
export const migrated = {
  globalSetup: ['./test/support/migrate.global-setup.ts'],
};

/**
 * The test process plays the API process, which starts with `--disable-sigusr1`: an executor process
 * cannot open its inspector, and the flag protects only the process it is given to
 * (design-code-execution.md, Constraints).
 */
export const apiProcess = { execArgv: ['--disable-sigusr1'] };
