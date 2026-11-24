import { defineConfig } from 'vitest/config';
import { migrated, verify } from '../../vitest.shared.mts';

/** UC-N1 (dependent task start) and UC-N2 (recovery time). */
export default defineConfig(verify(migrated));
