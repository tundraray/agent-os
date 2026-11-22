import { defineConfig } from 'vitest/config';
import { apiProcess, migrated, verify } from '../../vitest.shared.mts';

/** UC-N1 (5 MB within 30 s, NFR-01) and UC-N2 (empty script p95 within 2 s, NFR-02) of the code-execution part. */
export default defineConfig(verify({ ...migrated, ...apiProcess }));
