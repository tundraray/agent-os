/** URLs the guard compares: `SELF_CHECK_DATABASE_URL` and `DATABASE_URL` as the program's environment holds them. */
export interface DatabaseGuardInput {
  readonly selfCheckDatabaseUrl: string | undefined;
  readonly mainDatabaseUrl: string | undefined;
}

export type DatabaseGuardResult =
  | { readonly ok: true; readonly databaseUrl: string }
  | {
      readonly ok: false;
      readonly code: 'database_not_self_check';
      readonly reason: string;
    };

/** What the name of the self-check database ends with; the start checks it on the URL and on the opened connection. */
export const SELF_CHECK_SUFFIX = '_self_check';

/** The URL schemes of a Postgres database; anything else cannot name one the program may write to. */
const DATABASE_PROTOCOLS: readonly string[] = ['postgres:', 'postgresql:'];

/**
 * The self-check program's own database (design-self-check.md, KD-3, Runtime settings; DC-17):
 * `SELF_CHECK_DATABASE_URL` is required, it is a `postgres:` or `postgresql:` URL, its database name ends with
 * `_self_check` and differs from the `DATABASE_URL` database. The caller runs it before any connection that
 * writes and before migrations; the opened connection is checked again by the name the server reports.
 *
 * Databases are told apart by name, not by host: one server is often reachable under several host names
 * (`localhost`, `127.0.0.1`, a container alias), so a matching name is refused whatever the host, the port
 * or the order of the parameters. The reason names databases only — never credentials.
 */
export function checkSelfCheckDatabase(
  input: DatabaseGuardInput,
): DatabaseGuardResult {
  const { selfCheckDatabaseUrl, mainDatabaseUrl } = input;
  if (selfCheckDatabaseUrl === undefined || selfCheckDatabaseUrl === '') {
    return refused('SELF_CHECK_DATABASE_URL is not set');
  }
  const name = databaseName(selfCheckDatabaseUrl);
  if (name === null) {
    return refused(
      'SELF_CHECK_DATABASE_URL is not a postgres:// URL with a database name',
    );
  }
  if (!name.endsWith(SELF_CHECK_SUFFIX)) {
    return refused(`database "${name}" does not end with ${SELF_CHECK_SUFFIX}`);
  }
  if (mainDatabaseUrl !== undefined && mainDatabaseUrl !== '') {
    const mainName = databaseName(mainDatabaseUrl);
    if (mainName === null) {
      return refused(
        'DATABASE_URL is not a postgres:// URL with a database name, so it cannot be told apart',
      );
    }
    if (mainName === name) {
      return refused(`database "${name}" is the DATABASE_URL database`);
    }
  }
  return { ok: true, databaseUrl: selfCheckDatabaseUrl };
}

function refused(reason: string): DatabaseGuardResult {
  return { ok: false, code: 'database_not_self_check', reason };
}

function databaseName(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (!DATABASE_PROTOCOLS.includes(parsed.protocol)) return null;
  const path = parsed.pathname.replace(/^\//, '');
  if (path === '' || path.includes('/')) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    // A malformed escape cannot name a database: the URL is refused like any other unreadable one.
    return null;
  }
}
