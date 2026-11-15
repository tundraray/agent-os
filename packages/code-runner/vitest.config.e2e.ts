import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    // Files hold OS listeners and count live executor processes; parallel files would see each other's.
    fileParallelism: false,
    // The test process plays the API process, which starts with `--disable-sigusr1` (spike: the `forks` workers get it).
    execArgv: ['--disable-sigusr1'],
    // Each row spawns a real executor process; a hung one is killed one second after its limit.
    testTimeout: 30_000,
  },
});
