import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Set before Vitest spawns its workers, which inherit the environment: every test and every CI
// machine sees the same zone, and Europe/Berlin has DST transitions that date grouping must survive.
process.env.TZ = 'Europe/Berlin';

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'jsdom',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    env: { NEXT_PUBLIC_API_URL: 'http://api.test' },
  },
});
