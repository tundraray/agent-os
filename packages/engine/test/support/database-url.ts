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

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Refuses a database that does not look like the local test database: a fence cancels every active investigation with
 * an engine row, so it runs only against a local host with the test port 5433 (dev) or the test database `agent_os` (CI)
 * or a name containing `test`.
 */
export function assertTestDatabase(url: string): void {
  const { hostname, port, pathname } = new URL(url);
  const name = pathname.slice(1);
  const local = LOCAL_HOSTS.includes(hostname);
  if (local && (port === '5433' || name === 'agent_os' || name.includes('test'))) return;
  throw new Error(
    `Refusing to cancel leftover investigations in ${hostname}:${port || '5432'}/${name}: ` +
      'the engine suites fence only a local test database (port 5433, or database agent_os or *test*)',
  );
}
