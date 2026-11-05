import { defineConfig } from 'vitest/config';

/**
 * On-demand timing checks (`pnpm --filter @agent-os/runtime test:verify`), kept out of the
 * regular suites so a slow machine never turns them red: UC-N1 (dependent task start) and UC-N2
 * (recovery time).
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['test/verify/**/*.verify.ts'],
    globalSetup: ['./test/support/migrate.global-setup.ts'],
    // One measurement at a time: parallel files would measure each other's load.
    fileParallelism: false,
  },
});
