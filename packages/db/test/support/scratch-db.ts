import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** The api's env file: the database the developer runs locally (`infra/docker-compose.yml`). */
const ENV_FILE = fileURLToPath(
  new URL('../../../../apps/api/.env', import.meta.url),
);

/** `DATABASE_URL` from the process environment, otherwise from `apps/api/.env`. */
function sharedDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) process.loadEnvFile(ENV_FILE);
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  return url;
}

/** Runs `use` on a dedicated connection to `url`, closed afterwards. */
export async function withDatabase<T>(
  url: string,
  use: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

/**
 * Scratch databases on the shared server: a test row migrates its own empty database, never the
 * shared one, and drops it afterwards.
 */
export class ScratchDatabases {
  private readonly names: string[] = [];

  /** A new empty database; returns its URL. */
  async create(): Promise<string> {
    const name = `e2e_db_${randomBytes(6).toString('hex')}`;
    await withDatabase(sharedDatabaseUrl(), (client) =>
      client.query(`CREATE DATABASE "${name}"`),
    );
    this.names.push(name);
    const url = new URL(sharedDatabaseUrl());
    url.pathname = `/${name}`;
    return url.toString();
  }

  /** Drops every database this instance created. */
  async dropAll(): Promise<void> {
    const names = this.names.splice(0);
    await withDatabase(sharedDatabaseUrl(), async (client) => {
      for (const name of names) {
        // FORCE: a connection of a failed row may still be closing.
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      }
    });
  }
}
