import { defineConfig } from 'vitest/config';

// The package has no unit specs until its first behaviour lands; an empty run is not a failure.
export default defineConfig({
  test: {
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
