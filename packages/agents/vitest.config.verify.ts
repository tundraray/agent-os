import { defineConfig } from 'vitest/config';

/**
 * On-demand timing checks (`pnpm --filter @agent-os/agents test:verify`), kept out of the regular
 * suites so a slow machine never turns them red: UC-N1 (5 MB within 30 s, NFR-01) and UC-N2 (empty
 * script p95 within 2 s, NFR-02) of the code-execution part.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['test/verify/**/*.verify.ts'],
    globalSetup: ['./test/support/migrate.global-setup.ts'],
    // One measurement at a time: parallel files would measure each other's load.
    fileParallelism: false,
    // The test process plays the API process, which starts with `--disable-sigusr1` (as in `vitest.config.e2e.ts`).
    execArgv: ['--disable-sigusr1'],
  },
});
