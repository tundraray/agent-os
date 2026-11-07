import { checkSelfCheckDatabase } from './database-guard.js';

const MAIN =
  'postgres://app:secret@db.local:5432/agent_os?sslmode=disable&application_name=api';

// DC-17, UC-E7: the program never accepts the main database. A refusal comes before any connection that
// writes, so a wrong URL must be caught here, by the URL alone.
describe('checkSelfCheckDatabase', () => {
  it.each<[string, string | undefined, string | undefined]>([
    ['the variable is unset', undefined, MAIN],
    ['the variable is empty', '', MAIN],
    ['the URL does not parse', 'not a url', MAIN],
    ['the URL names no database', 'postgres://app:secret@db.local:5432/', MAIN],
    [
      'the URL is not a postgres URL',
      'mysql://app:secret@db.local:3306/agent_os_self_check',
      MAIN,
    ],
    [
      'the name lacks the suffix',
      'postgres://app:secret@db.local:5432/agent_os_test',
      MAIN,
    ],
    [
      'the suffix is not at the end',
      'postgres://app@db.local/agent_os_self_check_old',
      MAIN,
    ],
    [
      'it is the main database with parameters in another order and the host in upper case',
      'postgres://app:secret@DB.LOCAL:5432/agent_os_self_check?application_name=api&sslmode=disable',
      'postgres://app:secret@db.local:5432/agent_os_self_check?sslmode=disable&application_name=api',
    ],
    [
      'it has the main database name reached through another host',
      'postgres://app@127.0.0.1/agent_os_self_check',
      'postgres://app@localhost/agent_os_self_check',
    ],
    [
      'the main database URL does not parse, so the two cannot be told apart',
      'postgres://app@db.local/agent_os_self_check',
      'not a url',
    ],
  ])(
    'refuses with database_not_self_check when %s',
    (_, selfCheckDatabaseUrl, mainDatabaseUrl) => {
      const result = checkSelfCheckDatabase({
        selfCheckDatabaseUrl,
        mainDatabaseUrl,
      });

      expect(result).toMatchObject({
        ok: false,
        code: 'database_not_self_check',
      });
    },
  );

  it.each<[string, string, string | undefined]>([
    [
      'a separate database with the suffix',
      'postgres://app:secret@db.local:5432/agent_os_self_check?sslmode=disable',
      MAIN,
    ],
    [
      'no main database is configured',
      'postgresql://app@db.local/agent_os_self_check',
      undefined,
    ],
  ])('accepts %s', (_, selfCheckDatabaseUrl, mainDatabaseUrl) => {
    const result = checkSelfCheckDatabase({
      selfCheckDatabaseUrl,
      mainDatabaseUrl,
    });

    expect(result).toEqual({ ok: true, databaseUrl: selfCheckDatabaseUrl });
  });

  it('keeps the credentials out of the refusal message', () => {
    const result = checkSelfCheckDatabase({
      selfCheckDatabaseUrl: 'postgres://app:hunter2@db.local/agent_os',
      mainDatabaseUrl: MAIN,
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });
});
