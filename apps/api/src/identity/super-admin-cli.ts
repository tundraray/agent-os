import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { createDatabase } from '@agent-os/db';
import { AuditLog } from '../audit/audit-log';
import { createAppLogger } from '../logging/app-logger';
import { seedSuperAdmin } from './super-admin';

const logger = createAppLogger(process.env);

/** `--login`, `--name`, `--email`; the password never comes from the arguments, only from stdin. */
function readArguments(): { login: string; name: string; email: string } {
  const { values, positionals } = parseArgs({
    options: {
      login: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
    },
    // Collected rather than rejected by parseArgs: its error message would echo a password typed here.
    allowPositionals: true,
  });
  if (positionals.length > 0) {
    throw new Error(
      'Positional arguments are not accepted; the password is read from standard input',
    );
  }
  const { login, name, email } = values;
  if (!login || !name || !email)
    throw new Error('--login, --name and --email are required');
  return { login, name, email };
}

/** All of standard input without its trailing line break. */
async function readPassword(): Promise<string> {
  return (await text(process.stdin)).replace(/\r?\n$/, '');
}

/**
 * Entry of `pnpm --filter api identity:super-admin` (KD-6, FR-32; run from `dist`, `apps/api/.env`
 * loaded by `--env-file-if-exists`): creates the super-administrator or repairs it by login.
 */
async function main(): Promise<void> {
  const startedAt = Date.now();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');
  const { login, name, email } = readArguments();
  const password = await readPassword();
  const connection = createDatabase({
    connectionString: databaseUrl,
    poolMax: 1,
  });
  try {
    const { userId, created } = await seedSuperAdmin(
      connection.db,
      new AuditLog(connection.db),
      {
        login,
        name,
        email,
        password,
      },
    );
    logger.info(
      created ? 'Super-administrator created' : 'Super-administrator repaired',
      {
        login,
        userId,
        created,
        durationMs: Date.now() - startedAt,
      },
    );
  } finally {
    await connection.close();
  }
}

try {
  await main();
} catch (error) {
  // The whole error: a connection failure is an AggregateError with an empty message. A failed query's
  // parameters (the password hash) are dropped by the logger (`withoutQueryParams`).
  logger.error('Super-administrator command failed', { error });
  process.exitCode = 1;
}
