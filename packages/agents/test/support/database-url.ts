import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * `.env` of the composition root, the file the developer already keeps for `apps/api`. Resolved
 * from the source location; a compiled child gets `DATABASE_URL` from its harness and never
 * reaches this fallback.
 */
const ENV_FILE = fileURLToPath(
  new URL('../../../../apps/api/.env', import.meta.url),
);

/**
 * `DATABASE_URL` of the package tests: the process environment first, otherwise `apps/api/.env`.
 * The only place in the package that reads it (ADR-0004: settings reach `src` as parameters).
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? readEnvFile().DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  return url;
}

/** Variables of {@link ENV_FILE}; none when the file does not exist (CI sets the environment). */
function readEnvFile(): Record<string, string | undefined> {
  let text: string;
  try {
    text = readFileSync(ENV_FILE, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  return parseEnv(text);
}
