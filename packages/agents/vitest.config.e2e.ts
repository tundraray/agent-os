import { defineConfig } from 'vitest/config';
import { apiProcess, e2e, migrated } from '../../vitest.shared.mts';

export default defineConfig(e2e({ ...migrated, ...apiProcess }));
