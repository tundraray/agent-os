import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

let pool: pg.Pool | undefined;

/**
 * `DATABASE_URL` as the app sees it: the process environment first, otherwise
 * `apps/api/.env` (the file `ConfigModule` reads). Throws when neither defines it.
 */
export function databaseUrl(): string {
  if (!process.env.DATABASE_URL) process.loadEnvFile(ENV_FILE);
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error(`DATABASE_URL is not set (checked env and ${ENV_FILE})`);
  return url;
}

function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: databaseUrl(), max: 2 });
  return pool;
}

/** Number of rows in `mastra_messages` for the thread, read directly from Postgres. */
export async function countMessages(threadId: string): Promise<number> {
  const result = await db().query<{ count: string }>(
    'SELECT count(*) FROM mastra_messages WHERE thread_id = $1',
    [threadId],
  );
  // node-postgres returns bigint `count` as a string.
  return Number(result.rows[0].count);
}

/**
 * Raw `content` of every `mastra_messages` row of the thread, oldest first, as
 * stored (the JSON text column), bypassing Memory and `toAISdkMessages`.
 */
export async function rawMessageContents(threadId: string): Promise<string[]> {
  const result = await db().query<{ content: string }>(
    'SELECT content FROM mastra_messages WHERE thread_id = $1 ORDER BY "createdAt" ASC',
    [threadId],
  );
  return result.rows.map((row) => row.content);
}

/** Closes the shared pool; call from `afterAll` of files that used `countMessages`. */
export async function closeDb(): Promise<void> {
  const current = pool;
  pool = undefined;
  await current?.end();
}
