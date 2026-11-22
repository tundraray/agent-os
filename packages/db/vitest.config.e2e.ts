import { defineConfig } from 'vitest/config';
import { e2e } from '../../vitest.shared.mts';

// No migration setup: each row migrates its own scratch database.
export default defineConfig(e2e({}));
