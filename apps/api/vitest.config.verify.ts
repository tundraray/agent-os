import { defineConfig } from 'vitest/config';

/**
 * On-demand load check (`pnpm --filter api test:verify`), kept out of the regular suites so a slow
 * machine never turns them red: UC-N3 of the code-execution part (NFR-04, AC-10.5).
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/verify/**/*.verify.ts'],
    // Migrations are applied once before the run; the app's start only checks them.
    globalSetup: ['./test/support/migrate.global-setup.ts'],
    // One measurement at a time: parallel files would measure each other's load.
    fileParallelism: false,
    // The worker is the API process: the flag protects only the process it is given to (as in `vitest.config.e2e.ts`).
    execArgv: ['--disable-sigusr1'],
  },
});
