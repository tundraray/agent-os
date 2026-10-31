import { defineConfig } from 'vitest/config';

// The integration file runs against the fixture process without Postgres, so it belongs to the default run (CI `check`).
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts', 'test/**/*.int.spec.ts'],
  },
});
