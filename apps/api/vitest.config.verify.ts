import { defineConfig } from 'vitest/config';
import { apiProcess, migrated, verify } from '../../vitest.shared.mts';

export default defineConfig(verify({ ...migrated, ...apiProcess }));
