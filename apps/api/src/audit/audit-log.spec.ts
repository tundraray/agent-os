import { AuditEventsRepository, type Db } from '@agent-os/db';
import { AuditLog, type AuditEntry } from './audit-log';

/** A `Db` double: `insert(table).values(row)` captures the row. */
const fakeDatabase = () => {
  const rows: unknown[] = [];
  const client = {
    insert: () => ({
      values: (row: unknown) => {
        rows.push(row);
        return Promise.resolve();
      },
    }),
  };
  return { db: { client } as unknown as Db, rows };
};

const entry = (
  before: AuditEntry['before'],
  after: AuditEntry['after'],
): AuditEntry => ({
  kind: 'admin_change',
  actor: 'system',
  objectType: 'provider',
  objectId: 'p-1',
  before,
  after,
  outcome: 'ok',
});

// AC-11.2, NFR-02: a secret or a password never reaches audit_events as plain text.
describe('AuditLog', () => {
  it.each([
    {
      name: 'top-level clientSecret',
      before: { clientSecret: 'old-secret-value' },
      after: { clientSecret: 'new-secret-value' },
      expectedBefore: { clientSecret: 'secret_changed' },
      expectedAfter: { clientSecret: 'secret_changed' },
    },
    {
      name: 'nested options.clientSecret beside an ordinary field',
      before: null,
      after: {
        name: 'Okta',
        options: { clientId: 'id-1', clientSecret: 'nested-secret' },
      },
      expectedBefore: null,
      expectedAfter: {
        name: 'Okta',
        options: { clientId: 'id-1', clientSecret: 'secret_changed' },
      },
    },
    {
      name: 'password and newPassword',
      before: { password: 'old-password' },
      after: { newPassword: 'new-password', login: 'ops' },
      expectedBefore: { password: 'password_changed' },
      expectedAfter: { newPassword: 'password_changed', login: 'ops' },
    },
  ])(
    'replaces secret and password values with secret_changed and password_changed at any depth: $name',
    async ({ before, after, expectedBefore, expectedAfter }) => {
      const { db, rows } = fakeDatabase();

      await new AuditLog(new AuditEventsRepository(db)).record(
        entry(before, after),
      );

      expect(rows).toEqual([
        expect.objectContaining({
          before: expectedBefore,
          after: expectedAfter,
        }),
      ]);
    },
  );
});
