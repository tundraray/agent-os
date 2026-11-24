import { defineConfig } from 'vitest/config';
import { e2e, migrated } from '../../vitest.shared.mts';

export default defineConfig(e2e(migrated));
