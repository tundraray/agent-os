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
    // The page address: relative `/api/...` requests resolve against it, as in the browser.
    environmentOptions: { jsdom: { url: 'http://api.test' } },
    // Node 26 defines a global localStorage that throws without a file and hides jsdom's own.
    execArgv: ['--no-experimental-webstorage'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
