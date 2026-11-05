import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    // Test files share one Postgres server; each row migrates its own scratch database, so no
    // global migration setup is needed here.
    fileParallelism: false,
  },
});
