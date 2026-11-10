import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts'],
    // Scenario generation builds full synthetic datasets; CI runners need more than the 5 s default.
    testTimeout: 30_000,
  },
});
