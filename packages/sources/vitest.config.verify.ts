import { defineConfig } from 'vitest/config';

/**
 * On-demand timing checks (`pnpm --filter @agent-os/sources test:verify`), kept out of the regular suites so a slow
 * machine never turns them red: UC-N1 (`ToolExecutor` overhead per call) and UC-N2 (fixture page response).
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['test/verify/**/*.verify.ts'],
    // UC-N1 builds a runtime: migrations are applied once before it, as for the E2E suite.
    globalSetup: ['./test/support/migrate.global-setup.ts'],
    // One measurement at a time: parallel files would measure each other's load.
    fileParallelism: false,
    // The measured values are the script's output: print them for passing tests too.
    reporters: ['verbose'],
  },
});
