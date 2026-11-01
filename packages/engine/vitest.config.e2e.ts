import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    // The engine's handler types are fixed, so files cannot be isolated by workflow type: the
    // relay, the recovery sweeper and the engine handlers of one file would touch another's rows.
    fileParallelism: false,
    // Migrations are applied once before the suite, through `applyMigrations` of `@agent-os/db`.
    globalSetup: ['./test/support/migrate.global-setup.ts'],
  },
});
