import { defineConfig } from 'vitest/config';
import { apiProcess, e2e, migrated } from '../../vitest.shared.mts';

export default defineConfig(
  e2e({
    ...migrated,
    ...apiProcess,
    // Harness default: no runtime workers (chat e2e); a test that needs them turns them on itself.
    env: { RUNTIME_WORKERS: process.env.RUNTIME_WORKERS ?? 'off' },
  }),
);
