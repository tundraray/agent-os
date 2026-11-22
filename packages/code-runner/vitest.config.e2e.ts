import { defineConfig } from 'vitest/config';
import { apiProcess, e2e } from '../../vitest.shared.mts';

export default defineConfig(
  e2e({
    ...apiProcess,
    // Each row spawns a real executor process; a hung one is killed one second after its limit.
    testTimeout: 30_000,
  }),
);
