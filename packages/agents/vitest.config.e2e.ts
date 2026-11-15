import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    // Runtimes of parallel files share one database, and the outbox relay and recovery sweeper
    // are not scoped to a workflow type: they would deliver or requeue another file's rows.
    fileParallelism: false,
    // Migrations are applied once before the suite, through `applyMigrations` of `@agent-os/db`.
    globalSetup: ['./test/support/migrate.global-setup.ts'],
    // The test process plays the API process, which starts with `--disable-sigusr1`: a script's executor
    // cannot open its inspector (code-execution spike; the `forks` workers get the flag).
    execArgv: ['--disable-sigusr1'],
  },
});
