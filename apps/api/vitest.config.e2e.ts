import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    // Runtime instances of parallel files share one database, and the outbox relay and recovery
    // sweeper are not scoped to a workflow type: they would deliver or requeue another file's rows.
    fileParallelism: false,
    include: ['**/*.e2e-spec.ts'],
    // Migrations are applied once before the suite; the app's start only checks them.
    globalSetup: ['./test/support/migrate.global-setup.ts'],
    // Harness default: no runtime workers (chat e2e); a test that needs them turns them on itself.
    env: { RUNTIME_WORKERS: process.env.RUNTIME_WORKERS ?? 'off' },
  },
});
