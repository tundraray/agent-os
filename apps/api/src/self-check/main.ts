import { fileURLToPath } from 'node:url';
import { AnthropicTokenCounter } from '@agent-os/engine';
import { systemClock } from '@agent-os/runtime';
import { parseEngineSettings } from '../engine/engine-settings.js';
import { createResolveModel } from '../engine/resolve-model.js';
import { runCli } from './cli.js';

/** The default reports directory, `apps/api/self-check-reports`, whatever the working directory. */
const REPORTS_DIR = fileURLToPath(
  new URL('../../self-check-reports', import.meta.url),
);

/**
 * Entry of `pnpm self-check` (run from `dist`, `apps/api/.env` loaded by `--env-file-if-exists`), the second command
 * entry of `apps/api` next to `migrate-cli`, without a server and without Nest (design-self-check.md, KD-3). It reads
 * the environment and the arguments and hands them to `runCli` with the real model boundary — the same
 * `resolveModel` and `AnthropicTokenCounter` on one base as the server.
 */
async function main(): Promise<number> {
  const engineSettings = parseEngineSettings((name) => process.env[name]);
  return runCli({
    argv: process.argv.slice(2),
    env: process.env,
    reportsDir: REPORTS_DIR,
    clock: systemClock,
    resolveModel: createResolveModel(engineSettings),
    tokenCounter: new AnthropicTokenCounter({
      apiKey: engineSettings.anthropicApiKey,
      baseUrl: engineSettings.anthropicBaseUrl,
    }),
  });
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
